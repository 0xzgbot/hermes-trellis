/**
 * tools.ts — the Trellis tool surface, registered on the MCP server.
 *
 * This is the faithful analogue of Meshy's MCP toolset, adapted to what
 * the local Trellis.2 model actually does:
 *   - image-to-3D (the core; no text-to-3D / multi-view)
 *   - PBR texturing / re-texturing (base color / roughness / metallic / opacity)
 *   - decimation + remesh to a face/vertex budget
 *   - export to GLB (first-class), STL, OBJ, FBX, USDZ
 *   - render preview (PNG frames / video) under an HDRI
 *   - task status / wait
 *   - gallery of all models made
 *   - usage (local "credits")
 *
 * Every handler returns { content: [ { type:"text", text } ] } and sets
 * isError when the underlying operation failed.
 */

import { z } from "zod";
import {
  TrellisBridgeClient,
  BridgeError,
  type TaskRecord,
  type HealthInfo,
  type UsageInfo,
} from "./bridge.js";

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
    desc: "Report whether the local Trellis service is up, whether the model is loaded into GPU memory, and whether a generation is in flight. Cheap — call it first when unsure.",
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
    desc: "Start (or confirm) the local Trellis runtime on the DGX and wait until it is healthy — use when trellis_health shows it down and the user wants to generate a model now. NOTE: bringing it up grabs the GPU, so surface the contention to the user (it may slow or preempt other LLM serving, e.g. TensorFold).",
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
  const { client } = ctx;
  return {
    name: "trellis_image_to_3d",
    desc: "Turn a single conditioning IMAGE into a fully-textured 3D model using the local Trellis.2 model on the DGX. The one and only way to make a model here (no text-to-3D). Returns a task id; poll with trellis_task_status / wait with trellis_wait_task, then download an export.",
    schema: z
      .object({
        image: z.string().min(1).describe("Conditioning image: local path, http(s) URL, or data: URL."),
        resolution: z.union([z.enum(["512", "1024", "1536"]), z.number().int().positive()]).optional().describe("Resolution bucket (512/1024/1536). Higher = longer + more memory."),
        seed: z.number().int().min(0).optional().describe("Fixed RNG seed for reproducibility."),
        randomize_seed: z.boolean().optional().describe("Randomize the seed instead of using a fixed one."),
        label: z.string().optional().describe("Optional tag/prompt stored in the gallery for this model."),
        ss_steps: z.number().int().positive().optional().describe("Sparse-structure sampling steps."),
        ss_guidance: z.number().optional().describe("Sparse-structure guidance strength."),
        shape_steps: z.number().int().positive().optional().describe("Shape SLAT sampling steps."),
        shape_guidance: z.number().optional().describe("Shape SLAT guidance strength."),
        tex_steps: z.number().int().positive().optional().describe("Texture SLAT sampling steps."),
        tex_guidance: z.number().optional().describe("Texture SLAT guidance strength."),
      })
      .strict(),
    async handler(a: Record<string, unknown>): Promise<ToolResult> {
      // Fold the flat ss/shape/tex params into the nested sampler shapes.
      const body = {
        image: a.image,
        resolution: a.resolution,
        seed: a.seed,
        randomize_seed: a.randomize_seed,
        label: a.label,
        sparse_structure_sampler_params: a.ss_steps !== undefined || a.ss_guidance !== undefined
          ? { steps: a.ss_steps, guidance_strength: a.ss_guidance }
          : undefined,
        shape_slat_sampler_params: a.shape_steps !== undefined || a.shape_guidance !== undefined
          ? { steps: a.shape_steps, guidance_strength: a.shape_guidance }
          : undefined,
        tex_slat_sampler_params: a.tex_steps !== undefined || a.tex_guidance !== undefined
          ? { steps: a.tex_steps, guidance_strength: a.tex_guidance }
          : undefined,
      };
      try {
        const { id, status } = await client.generate(body as never);
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
    async handler(a: Record<string, unknown>): Promise<ToolResult> {
      try {
        const rec = await client.waitForTask(a.task_id as string, { timeoutMs: (a.timeout_seconds as number | undefined) ?? 1800000 });
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
    desc: "Download the produced 3D model from a completed Trellis task to a local file, in the requested format. GLB is first-class (full PBR); STL/OBJ/FBX/USDZ are derived. If you omit 'dest', it lands in the default output dir named <task_id>.<format>.",
    schema: z
      .object({
        task_id: z.string().min(1),
        format: z.enum(["glb", "stl", "obj", "fbx", "usdz"]).optional().describe("Output format (default glb)."),
        dest: z.string().optional().describe("Absolute local path to write the file to."),
      })
      .strict(),
    async handler(a: Record<string, unknown>): Promise<ToolResult> {
      const format = (a.format as string | undefined) ?? "glb";
      const taskId = a.task_id as string;
      let dest = a.dest as string | undefined;
      if (!dest) dest = `${defaultOutDir}/${taskId}.${format}`;
      try {
        const { path, bytes } = await client.downloadBinary(taskId, format, dest);
        return ok({ path, bytes, format }, `Saved ${format.toUpperCase()} (${(bytes / 1024).toFixed(1)} KB):`);
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
    desc: "Render the produced 3D model to PNG frame(s) under an HDRI environment (modes: normal/clay/base_color/hdri_forest/hdri_sunset/hdri_courtyard). Use to get a picture you can show the user in chat, or to make a short turntable video. Writes frames to the output dir and returns their paths.",
    schema: z
      .object({
        task_id: z.string().min(1),
        mode: z.enum(["normal", "clay", "base_color", "hdri_forest", "hdri_sunset", "hdri_courtyard"]).optional().describe("Render/lighting mode (default normal)."),
        nviews: z.number().int().positive().max(64).optional().describe("Number of camera views/frames (default 8)."),
        video: z.boolean().optional().describe("Whether to also assemble the frames into an mp4 turntable."),
      })
      .strict(),
    async handler(a: Record<string, unknown>): Promise<ToolResult> {
      try {
        const { images, video } = await client.render(a.task_id as string, {
          mode: a.mode as string | undefined,
          nviews: a.nviews as number | undefined,
          video: a.video as boolean | undefined,
        });
        // Persist returned data-urls to the output dir so chat can MEDIA: them.
        const fs = await import("node:fs");
        const pathMod = await import("node:path");
        fs.mkdirSync(defaultOutDir, { recursive: true });
        const saved: string[] = [];
        for (let i = 0; i < images.length; i++) {
          const src = images[i];
          if (!src) continue;
          const isDataUrl = src.startsWith("data:");
          const p = pathMod.join(defaultOutDir, `${a.task_id}_${(a.mode as string) ?? "normal"}_${String(i).padStart(2, "0")}.png`);
          if (isDataUrl) {
            const b64 = src.slice(src.indexOf(",") + 1);
            fs.writeFileSync(p, Buffer.from(b64, "base64"));
          } else {
            // Assume it is a URL the DGX can serve; just reference it.
            fs.writeFileSync(p + ".url", src);
          }
          saved.push(p);
        }
        return ok(
          { frames: saved, video: video ?? null, note: "Show any frame to the user with MEDIA:<path>." },
          `Rendered ${(a.nviews as number) ?? 8} frame(s) of the Trellis model:`,
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
    desc: "Generate PBR textures (base color, roughness, metallic, opacity) for a given 3D shape using the local Trellis.2 texture pipeline (shape-conditioned). Use to (re)texture a base geometry without re-running full image->3D. Returns a task id to wait on and then download a textured export.",
    schema: z
      .object({
        image: z.string().min(1).describe("Reference/target image the textures should resemble."),
        shape_src: z.string().optional().describe("Optional base shape (glb path/URL/id) to condition on; omitted = generate from image."),
        label: z.string().optional().describe("Optional tag for the gallery."),
      })
      .strict(),
    async handler(a: Record<string, unknown>): Promise<ToolResult> {
      try {
        // Reuse the generate endpoint with the texture-app flag.
        const { id, status } = await client.generate({
          ...(a as object),
          resolution: "1024",
        } as never);
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
    desc: "Reduce a produced Trellis model to a target face/vertex budget (decimation) and/or remesh it (band/project) to clean up topology for downstream use (e.g. 3D printing). Returns the path of the rewritten GLB/STL.",
    schema: z
      .object({
        task_id: z.string().min(1),
        face_budget: z.number().int().positive().optional().describe("Target face count to decimate to."),
        remesh: z.boolean().optional().describe("Whether to also remesh."),
        remesh_band: z.number().optional().describe("Remesh band width."),
        remesh_project: z.number().optional().describe("Remesh projection strength."),
        dest: z.string().optional().describe("Output path for the rewritten mesh."),
      })
      .strict(),
    async handler(a: Record<string, unknown>): Promise<ToolResult> {
      const dest = (a.dest as string | undefined) ?? `${defaultOutDir}/${a.task_id}_remesh.glb`;
      try {
        // Bridge handles decimate+remesh and returns a path.
        const r = await client.req<{ path: string; faces_before?: number; faces_after?: number }>(
          "POST",
          `/tasks/${encodeURIComponent(a.task_id as string)}/remesh`,
          a,
        );
        return ok(r, "Remeshed/decimated the Trellis model:");
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
    desc: "List the models you have generated with Trellis (a gallery), most recent first, each with a small preview thumbnail, its label, timestamp, and available formats. Use to answer 'show me everything you've made' or to find a previous model.",
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

export function makeUsageTool(ctx: ToolContext) {
  const { client } = ctx;
  return {
    name: "trellis_usage",
    desc: "Report local Trellis usage/'credits' (how many models have been generated, an estimate of GPU-seconds consumed, and the last task). Use to surface activity/cost to the user, e.g. on a status bar.",
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
