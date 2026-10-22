/**
 * tools.ts — the Trellis tool surface, registered on the MCP server.
 *
 * Local print pipeline on Trellis.2:
 *   - image-to-3D (one photo, no text-to-3D)
 *   - GLB from the server; STL/OBJ via local trimesh
 *   - decimate / hole-fill for slicing
 *   - solid turntable renders for a print check
 *   - gallery and real GPU-seconds
 *
 * Every handler returns { content: [ { type:"text", text } ] } and sets
 * isError when the underlying operation failed.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  TrellisBridgeClient,
  BridgeError,
  type TaskRecord,
} from "./bridge.js";
import { remember } from "./provenance.js";
import { reportProgress, type ToolExtra } from "./progress.js";

export type { ToolExtra };

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export interface ToolContext {
  client: TrellisBridgeClient;
  /** Working dir where downloads land when the caller omits a path. */
  defaultOutDir: string;
}

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

function ok(data: unknown, note?: string): ToolResult {
  const text = note ? `${note}\n\n${JSON.stringify(data, null, 2)}` : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }], structuredContent: (data as Record<string, unknown>) ?? {} };
}
function err(msg: string, status?: number): ToolResult {
  return { content: [{ type: "text", text: msg }], isError: true, structuredContent: { error: msg, status } };
}
function isTerminalOk(rec: TaskRecord): boolean {
  return ["completed", "succeeded"].includes((rec.status || "").toLowerCase());
}
function isTerminalBad(rec: TaskRecord): boolean {
  return ["failed", "error", "cancelled"].includes((rec.status || "").toLowerCase());
}

// ---------------------------------------------------------------------------
// health / start
// ---------------------------------------------------------------------------
export function makeHealthTool(ctx: ToolContext) {
  const { client } = ctx;
  return {
    name: "trellis_health",
    desc: "Report whether ComfyUI is answering and whether its queue has a running job. model_loaded stays false: ComfyUI does not report Trellis weights as a resident flag. Call this first.",
    schema: z.object({}),
    async handler(_a: Record<string, unknown>): Promise<ToolResult> {
      try {
        const h = await client.health();
        return ok(h);
      } catch (e) {
        if (e instanceof BridgeError) {
          return ok(
            { up: false, model_loaded: false, busy: false, note: `Trellis not reachable (${e.causeHint ?? e.message}). Probably stopped to free the GPU for TensorFold. Use trellis_start to bring it up.` },
            "Trellis appears to be DOWN:",
          );
        }
        return err(`trellis_health failed: ${(e as Error).message}`);
      }
    },
  };
}

export function makeStartTool(ctx: ToolContext) {
  const { client } = ctx;
  return {
    name: "trellis_start",
    desc: "Check that ComfyUI is answering. This does not boot ComfyUI or load weights. If health is down, the user has to start ComfyUI on the GPU machine. wait_seconds is ignored.",
    schema: z
      .object({
        wait_seconds: z.number().int().min(1).max(900).optional().describe("How long (s) to wait for the runtime to be ready / models to load."),
        app_script: z.string().optional().describe("(legacy-bridge only) which app to serve: 'app.py' (image->3D) or 'app_texturing.py' (PBR). Ignored by the comfyui backend."),
      })
      .strict(),
    async handler(a: Record<string, unknown>): Promise<ToolResult> {
      try {
        const r = await client.start({ wait_seconds: a.wait_seconds as number | undefined, app_script: a.app_script as string | undefined });
        return ok(r, r.up ? "Trellis is now UP:" : "Trellis did not come up in time:");
      } catch (e) {
        return err(`trellis_start failed: ${(e as Error).message}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// image -> 3D  (THE core)
// ---------------------------------------------------------------------------
export function makeImageTo3DTool(ctx: ToolContext) {
  const { client, defaultOutDir } = ctx;
  return {
    name: "trellis_image_to_3d",
    desc: "Turn a single conditioning IMAGE into a fully-textured 3D model using the local Trellis.2 model on the DGX. The one and only way to make a model here (no text-to-3D). Returns a task id; poll with trellis_task_status / wait with trellis_wait_task, then download an export.",
    schema: z
      .object({
        image: z.string().min(1).describe("Conditioning image: local path, http(s) URL, or data: URL."),
        resolution: z.union([z.enum(["512", "1024", "1536"]), z.number().int().positive()]).optional().describe("Voxel resolution. Default 1536, the model maximum. 1024 and 512 are faster and less detailed."),
        seed: z.number().int().min(0).optional().describe("Fixed RNG seed for reproducibility."),
        randomize_seed: z.boolean().optional().describe("Randomize the seed instead of using a fixed one."),
        label: z.string().optional().describe("Optional tag/prompt stored in the gallery for this model."),
      })
      .strict(),
    async handler(a: Record<string, unknown>): Promise<ToolResult> {
      const body = {
        image: a.image,
        resolution: a.resolution,
        seed: a.seed,
        randomize_seed: a.randomize_seed,
        label: a.label,
      };
      try {
        const { id, status } = await client.generate(body as never);
        const image = String(a.image);
        remember(defaultOutDir, {
          task_id: id,
          at: new Date().toISOString(),
          label: a.label as string | undefined,
          seed: typeof a.seed === "number" ? a.seed : undefined,
          resolution: a.resolution as number | string | undefined,
          image: image.startsWith("data:") ? "data-url" : image,
        });
        return ok(
          { task_id: id, status, next: `poll trellis_task_status(${id}) or wait with trellis_wait_task(${id})` },
          `Submitted image->3D job to Trellis.`,
        );
      } catch (e) {
        if (e instanceof BridgeError && (e.causeHint ?? "").toUpperCase().includes("ECONN")) {
          return err(`Trellis is not running (bridge unreachable). Call trellis_start first, then retry. Original: ${e.message}`);
        }
        return err(`trellis_image_to_3d failed: ${(e as Error).message}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// task status / wait
// ---------------------------------------------------------------------------
export function makeTaskStatusTool(ctx: ToolContext) {
  const { client } = ctx;
  return {
    name: "trellis_task_status",
    desc: "Get the current status of a Trellis generation task (pending/running/postprocessing/completed/failed) plus its progress, available output formats, and a small preview if available.",
    schema: z.object({ task_id: z.string().min(1) }).strict(),
    async handler(a: Record<string, unknown>): Promise<ToolResult> {
      try {
        const rec = await client.task(a.task_id as string);
        return ok(rec);
      } catch (e) {
        return err(`trellis_task_status failed: ${(e as Error).message}`);
      }
    },
  };
}

export function makeWaitTool(ctx: ToolContext) {
  const { client } = ctx;
  return {
    name: "trellis_wait_task",
    desc: "Block (poll) until a Trellis generation task reaches a terminal state (completed/failed) or times out. Prefer this over repeated trellis_task_status calls. Returns the final task record.",
    schema: z
      .object({
        task_id: z.string().min(1),
        timeout_seconds: z.number().int().positive().max(3600).optional().describe("Give up after this many seconds (default 1800)."),
      })
      .strict(),
    async handler(a: Record<string, unknown>, extra?: ToolExtra): Promise<ToolResult> {
      try {
        const seconds = (a.timeout_seconds as number | undefined) ?? 1800;
        const rec = await client.waitForTask(a.task_id as string, {
          timeoutMs: seconds * 1000,
          onProgress: (progress, total, message) => reportProgress(extra, progress, total, message),
        });
        return isTerminalOk(rec)
          ? ok(rec, "Trellis generation COMPLETED:")
          : err(`Trellis task ${a.task_id} ${rec.status}: ${rec.error || rec.stage || ""}`);
      } catch (e) {
        return err(`trellis_wait_task failed: ${(e as Error).message}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// download / export
// ---------------------------------------------------------------------------
export function makeDownloadTool(ctx: ToolContext) {
  const { client, defaultOutDir } = ctx;
  return {
    name: "trellis_download",
    desc: "Download a completed Trellis model. GLB is the server file. STL and OBJ are converted locally with trimesh (binary STL is checked: size == 84 + 50*faces). FBX and USDZ are refused. For a print, pass format stl, face_budget, height_mm, and repair.",
    schema: z
      .object({
        task_id: z.string().min(1),
        format: z.enum(["glb", "stl", "obj", "fbx", "usdz"]).optional().describe("glb is native. stl and obj are local conversions. fbx and usdz error."),
        dest: z.string().optional().describe("Local path to write. A leading ~ is expanded."),
        face_budget: z.number().int().positive().optional().describe("Optional extra decimation. Omit it for the dense mesh (about 1,000,000 faces from the Spark)."),
        height_mm: z.number().positive().optional().describe("Scale the longest axis to this many millimeters."),
        repair: z.boolean().optional().describe("Fill holes when the mesh is not watertight. Default true for stl."),
      })
      .strict(),
    async handler(a: Record<string, unknown>): Promise<ToolResult> {
      const format = (a.format as string | undefined) ?? "glb";
      const taskId = a.task_id as string;
      let dest = a.dest as string | undefined;
      if (!dest) dest = `${defaultOutDir}/${taskId}.${format}`;
      dest = expandHome(dest);
      const repair = a.repair !== undefined ? Boolean(a.repair) : format === "stl";
      try {
        const saved = await client.downloadBinary(taskId, format, dest, {
          faceBudget: a.face_budget as number | undefined,
          heightMm: a.height_mm as number | undefined,
          repair,
        });
        const prep = saved.prep;
        remember(defaultOutDir, {
          task_id: taskId,
          at: new Date().toISOString(),
          ...(format === "glb" ? { glb: saved.path } : {}),
          ...(format === "stl" ? { stl: saved.path } : {}),
          faces_after: prep?.faces_after,
          watertight_after: prep?.watertight_after,
          extents: prep?.extents,
          height_mm: prep?.height_mm,
        });
        return ok(
          {
            path: saved.path,
            bytes: saved.bytes,
            format,
            faces_before: prep?.faces_before,
            faces_after: prep?.faces_after,
            watertight_before: prep?.watertight_before,
            watertight_after: prep?.watertight_after,
            extents: prep?.extents,
            height_mm: prep?.height_mm,
            stl_bytes_ok: prep?.stl_bytes_ok,
            card: format === "glb" ? `::trellis-model{glb="${saved.path}"}` : format === "stl" ? `::trellis-model{stl="${saved.path}"}` : undefined,
          },
          `Saved ${format.toUpperCase()} (${(saved.bytes / 1024).toFixed(1)} KB). If the desktop plugin is on, put the card line in its own paragraph.`,
        );
      } catch (e) {
        return err(`trellis_download failed: ${(e as Error).message}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// render preview
// ---------------------------------------------------------------------------
export function makeRenderTool(ctx: ToolContext) {
  const { client, defaultOutDir } = ctx;
  return {
    name: "trellis_render_preview",
    desc: "Render the GLB from a completed task as solid turntable PNGs on ComfyUI (RotateMesh + RenderMesh). Default is 4 views at 0/90/180/270 in solid mode, for checking a print. Modes: auto, texture, vertex colors, solid, normal, depth. Does not encode video.",
    schema: z
      .object({
        task_id: z.string().min(1),
        mode: z.enum(["auto", "texture", "vertex colors", "solid", "normal", "depth"]).optional().describe("RenderMesh mode. Default solid."),
        nviews: z.number().int().positive().max(8).optional().describe("Yaw steps around the model. Default 4."),
        video: z.boolean().optional().describe("Ignored. No mp4 is produced."),
      })
      .strict(),
    async handler(a: Record<string, unknown>, extra?: ToolExtra): Promise<ToolResult> {
      try {
        const mode = (a.mode as string | undefined) ?? "solid";
        const { images, note } = await client.render(a.task_id as string, {
          mode,
          nviews: a.nviews as number | undefined,
          video: a.video as boolean | undefined,
          onProgress: (progress, total, message) => reportProgress(extra, progress, total, `rendering ${message}`),
        });
        fs.mkdirSync(defaultOutDir, { recursive: true });
        const frames: Array<{ path: string; sha256: string; bytes: number }> = [];
        for (let i = 0; i < images.length; i++) {
          const src = images[i];
          if (!src?.startsWith("data:")) continue;
          const buf = Buffer.from(src.slice(src.indexOf(",") + 1), "base64");
          const p = path.join(defaultOutDir, `${a.task_id}_${mode.replace(/\s+/g, "_")}_${String(i).padStart(2, "0")}.png`);
          fs.writeFileSync(p, buf);
          frames.push({ path: p, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length });
        }
        const unique = new Set(frames.map((f) => f.sha256)).size;
        return ok(
          { frames: frames.map((f) => f.path), hashes: frames, unique_views: unique, mode, note: note ?? "Show a frame with MEDIA:<path>." },
          `Rendered ${frames.length} ${mode} view(s):`,
        );
      } catch (e) {
        return err(`trellis_render_preview failed: ${(e as Error).message}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// PBR texturing
// ---------------------------------------------------------------------------
export function makeTexturizeTool(ctx: ToolContext) {
  const { client } = ctx;
  return {
    name: "trellis_texturize",
    desc: "There is no texture-only pass. Texture is baked during trellis_image_to_3d. This tool re-runs that full job from an image and ignores any request to retexture an existing mesh (shape_src).",
    schema: z
      .object({
        image: z.string().min(1).describe("Reference/target image the textures should resemble."),
        shape_src: z.string().optional().describe("Optional base shape (glb path/URL/id) to condition on; omitted = generate from image."),
        label: z.string().optional().describe("Optional tag for the gallery."),
      })
      .strict(),
    async handler(a: Record<string, unknown>): Promise<ToolResult> {
      if (a.shape_src) {
        return err("trellis_texturize cannot retexture an existing mesh. Texture is baked by trellis_image_to_3d. Omit shape_src only if you intend to run a full generation from the image.");
      }
      try {
        const { id, status } = await client.generate({
          image: a.image as string,
          label: a.label as string | undefined,
          resolution: "1536",
        });
        return ok({ task_id: id, status, next: `wait with trellis_wait_task(${id}), then trellis_download` }, "Submitted PBR texturing job:");
      } catch (e) {
        return err(`trellis_texturize failed: ${(e as Error).message}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// decimation / remesh
// ---------------------------------------------------------------------------
export function makeRemeshTool(ctx: ToolContext) {
  const { client, defaultOutDir } = ctx;
  return {
    name: "trellis_remesh_decimate",
    desc: "Optionally decimate the task's GLB locally. Omit face_budget to keep the dense mesh. remesh true fills holes. remesh_band and remesh_project are ignored. Returns faces, watertight, and the new GLB path.",
    schema: z
      .object({
        task_id: z.string().min(1),
        face_budget: z.number().int().positive().optional().describe("Only set this to throw away faces. Omit it for maximum detail."),
        remesh: z.boolean().optional().describe("Fill holes when the mesh is open."),
        remesh_band: z.number().optional().describe("Ignored. Kept so older callers still validate."),
        remesh_project: z.number().optional().describe("Ignored. Kept so older callers still validate."),
        dest: z.string().optional().describe("Output GLB path. A leading ~ is expanded."),
        height_mm: z.number().positive().optional().describe("Scale the longest axis to this many millimeters."),
      })
      .strict(),
    async handler(a: Record<string, unknown>): Promise<ToolResult> {
      let dest = (a.dest as string | undefined) ?? `${defaultOutDir}/${a.task_id}_remesh.glb`;
      dest = expandHome(dest);
      try {
        const saved = await client.downloadBinary(a.task_id as string, "glb", dest, {
          faceBudget: a.face_budget as number | undefined,
          heightMm: a.height_mm as number | undefined,
          repair: Boolean(a.remesh),
        });
        return ok(
          {
            path: saved.path,
            bytes: saved.bytes,
            faces_before: saved.prep?.faces_before,
            faces_after: saved.prep?.faces_after,
            watertight_before: saved.prep?.watertight_before,
            watertight_after: saved.prep?.watertight_after,
            extents: saved.prep?.extents,
            ignored: a.remesh_band !== undefined || a.remesh_project !== undefined ? ["remesh_band", "remesh_project"] : [],
          },
          "Decimated the Trellis mesh locally:",
        );
      } catch (e) {
        return err(`trellis_remesh_decimate failed: ${(e as Error).message}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// gallery / usage
// ---------------------------------------------------------------------------
export function makeGalleryTool(ctx: ToolContext) {
  const { client } = ctx;
  return {
    name: "trellis_gallery",
    desc: "List Trellis image-to-3D runs, newest first, with label and timestamp. Thumbnails are not inlined. Use trellis_render_preview for pictures.",
    schema: z.object({ limit: z.number().int().positive().max(200).optional() }).strict(),
    async handler(a: Record<string, unknown>): Promise<ToolResult> {
      try {
        const g = await client.gallery((a.limit as number | undefined) ?? 24);
        return ok({ count: g.items.length, items: g.items }, "Your Trellis model gallery:");
      } catch (e) {
        return err(`trellis_gallery failed: ${(e as Error).message}`);
      }
    },
  };
}

const SLICERS = ["OrcaSlicer", "PrusaSlicer", "BambuStudio", "Creality Print"];

export function makeSlicerTool(ctx: ToolContext) {
  void ctx;
  return {
    name: "trellis_open_slicer",
    desc: "Open a local STL in OrcaSlicer, PrusaSlicer, or BambuStudio if one is installed. Otherwise open it with the system default. Printing only — this does not rig or animate.",
    schema: z.object({ path: z.string().min(1).describe("Absolute path to the STL. A leading ~ is expanded.") }).strict(),
    async handler(a: Record<string, unknown>): Promise<ToolResult> {
      const file = expandHome(String(a.path));
      if (!file.toLowerCase().endsWith(".stl")) return err("trellis_open_slicer only opens .stl files.");
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return err(`No STL at ${file}`);
      try {
        const opened = await openInSlicer(file);
        return ok(opened, opened.app ? `Opened in ${opened.app}:` : "Opened with the default app:");
      } catch (e) {
        return err(`trellis_open_slicer failed: ${(e as Error).message}`);
      }
    },
  };
}

function openInSlicer(file: string): Promise<{ path: string; app: string | null }> {
  const apps = SLICERS.filter((name) => fs.existsSync(`/Applications/${name}.app`));
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "darwin"
    ? (apps[0] ? ["-a", apps[0], file] : [file])
    : process.platform === "win32"
      ? ["/c", "start", "", file]
      : [file];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code && code !== 0) reject(new Error(`${cmd} exited ${code}`));
      else resolve({ path: file, app: apps[0] ?? null });
    });
  });
}

export function makeUsageTool(ctx: ToolContext) {
  const { client } = ctx;
  return {
    name: "trellis_usage",
    desc: "Count completed Trellis image-to-3D runs, sum their real GPU seconds, and name the newest task. This is not a credit balance.",
    schema: z.object({}).strict(),
    async handler(_a: Record<string, unknown>): Promise<ToolResult> {
      try {
        const u = await client.usage();
        return ok(u, "Trellis usage:");
      } catch (e) {
        return err(`trellis_usage failed: ${(e as Error).message}`);
      }
    },
  };
}
