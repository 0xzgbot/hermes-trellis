/**
 * bridge.ts — typed HTTP client for the Trellis 3D service on the DGX Spark.
 *
 * The "bridge" is the actual Trellis runtime living on the DGX Spark. There are
 * two equivalent ways to expose that runtime to the MCP server, and this client
 * can drive EITHER one (selected by `TRELLIS_BACKEND`, default `comfyui`):
 *
 *  1. `comfyui` (default) — the runtime runs INSIDE **standard ComfyUI** (0.42) on the
 *     DGX at `:8188`, with the Trellis-2 node classes built in. This client speaks
 *     ComfyUI's STANDARD endpoints:
 *         POST /api/prompt        { client_id, prompt: <workflow graph>, output, extra_data }
 *         GET  /history/{prompt_id}   (returns the WRAPPER  {prompt_id: entry} — we unwrap it)
 *         GET  /history                       (full list → gallery + usage)
 *         GET  /view?filename&subfolder&type  (binary output: GLB / PNG / STL …)
 *         POST /upload/image        (multipart — ship the conditioning image to the DGX)
 *         GET  /system_stats        (liveness / "is the service up")
 *     The Trellis.2 image→3D workflow (structure → shape → upsample → texture →
 *     SaveGLB + render) is the shipped template (see `workflow-image-to-3d.ts`); the
 *     flat tool params (image / resolution / seed) are folded into that graph.
 *
 *  2. `bridge` (legacy) — the runtime is wrapped by a thin bespoke **REST front**
 *     (the `docker/trellis-api` FastAPI app on `:7861`) exposing `/health`, `/start`,
 *     `/generate`, `/tasks/{id}`, `/tasks/{id}/download`, … . Kept so existing
 *     docker-bridge deployments keep working unchanged.
 *
 * Point it at your box:
 *   TRELLIS_BACKEND     "comfyui" (default) | "bridge"
 *   TRELLIS_API_URL       base URL of the service — ComfyUI (`http://<DGX>:8188`) by
 *                              default; set it to your DGX's ComfyUI address.
 *   TRELLIS_BRIDGE_URL    (bridge backend only) the FastAPI bridge base
 *                              (`http://<DGX>:7861`).
 *
 * Everything degrades gracefully when the service is NOT running (the normal
 * state, to free the GPU for TensorFold / other LLM work): `health` reports
 * down/unreachable rather than throwing, and the caller decides whether to
 * `start` it (which grabs the GPU).
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { convertMesh, type PrintMeshResult } from "./print-mesh.js";
import {
  fillImageTo3DWorkflow,
  CAPTURE_NODES,
  type ComfyWorkflow,
  type FillImageTo3DParams,
} from "./workflow-image-to-3d.js";
import { buildSolidViewWorkflow, RENDER_MODES, type RenderMode } from "./workflow-render.js";

// ---------------------------------------------------------------------------
// Public types (kept stable — tools.ts / index.ts / the skill rely on them)
// ---------------------------------------------------------------------------

export type TaskStatus =
  | "pending"
  | "queued"
  | "loading_model"
  | "running"
  | "postprocessing"
  | "completed"
  | "succeeded"
  | "failed"
  | "error"
  | "cancelled"
  | "unknown";

export interface HealthInfo {
  /** Is the service (ComfyUI / bridge) answering? */
  up: boolean;
  /** Has the 3D pipeline / model been loaded into GPU memory? (best-effort) */
  model_loaded: boolean;
  /** Is a generation currently in flight? */
  busy: boolean;
  /** Free unified-memory on the DGX, in GB (best-effort). */
  gpu_free_gb?: number | null;
  /** The underlying 3D model id, e.g. "microsoft/TRELLIS.2-4B". */
  model_id?: string;
  /** Which app / transport is serving (comfyui vs bridge / app script). */
  app_script?: string;
  /** The service base URL. */
  url?: string;
  /** Human note, e.g. "stopped to free GPU for TensorFold". */
  note?: string;
  [k: string]: unknown;
}

export interface SamplerParams {
  steps?: number;
  guidance_strength?: number;
  guidance_rescale?: number;
  rescale_t?: number;
  [k: string]: unknown;
}

export interface GenerateRequest {
  image: string;
  resolution?: 512 | 1024 | 1536 | "512" | "1024" | "1536";
  seed?: number;
  randomize_seed?: boolean;
  sparse_structure_sampler_params?: SamplerParams;
  shape_slat_sampler_params?: SamplerParams;
  tex_slat_sampler_params?: SamplerParams;
  label?: string;
  [k: string]: unknown;
}

export interface TaskRecord {
  id: string;
  status: TaskStatus;
  progress?: number | null;
  stage?: string;
  created_at?: string;
  updated_at?: string;
  finished_at?: string;
  error?: string | null;
  model_id?: string;
  formats?: string[];
  sizes?: Record<string, number>;
  label?: string;
  preview?: string | null;
  [k: string]: unknown;
}

export interface GalleryItem {
  id: string;
  label?: string;
  created_at?: string;
  model_id?: string;
  formats?: string[];
  thumbnail?: string | null;
  input_image?: string | null;
  [k: string]: unknown;
}

export interface UsageInfo {
  total_generated: number;
  gpu_seconds_estimate?: number;
  last_task_id?: string | null;
  last_task_at?: string | null;
  credits_used?: number;
  [k: string]: unknown;
}

export interface BridgeClientOptions {
  baseUrl?: string;
  backend?: "comfyui" | "bridge";
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  log?: (msg: string) => void;
}

export class BridgeError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly causeHint?: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const TERMINAL_OK: TaskStatus[] = ["completed", "succeeded"];
const TERMINAL_BAD: TaskStatus[] = ["failed", "error", "cancelled"];

export function mimeForFmt(fmt: string): string {
  switch (fmt) {
    case "glb":
    case "gltf":
      return "model/gltf-binary";
    case "stl":
      return "model/stl";
    case "obj":
      return "model/obj";
    case "fbx":
      return "model/fbx";
    case "usdz":
      return "model/usdz";
    case "png":
      return "image/png";
    default:
      return "application/octet-stream";
  }
}

/** A reference to a saved file inside a ComfyUI history entry's outputs. */
export interface OutputRef {
  filename: string;
  subfolder: string;
  type: string;
}

/** A (node-id, saved-file) pair flattened out of a ComfyUI history entry. */
export interface NodeOutput {
  nodeId: string;
  ref: OutputRef;
}

/**
 * Flatten a ComfyUI history entry's `outputs` map into a flat list of
 * (nodeId, saved-file) references. This is the ONE place the "walk the
 * outputs → fields → arrays → if it has a filename" traversal lives, so
 * every consumer (render / gallery / pick-output / derive-formats) shares
 * the same flat, brace-balanced helper.
 */
export function flattenOutputs(entry: any): NodeOutput[] {
  const out: NodeOutput[] = [];
  const outputs = (entry && entry.outputs) || {};
  if (typeof outputs !== "object") return out;
  for (const nodeId of Object.keys(outputs)) {
    const nodeOut = outputs[nodeId];
    if (!nodeOut || typeof nodeOut !== "object") continue;
    for (const val of Object.values(nodeOut)) {
      const arr = Array.isArray(val) ? val : [val];
      for (const it of arr) {
        if (!it || typeof it !== "object") continue;
        if (typeof (it as any).filename !== "string") continue;
        out.push({
          nodeId,
          ref: {
            filename: (it as any).filename,
            subfolder: (it as any).subfolder ?? "",
            type: (it as any).type ?? "output",
          },
        });
      }
    }
  }
  return out;
}

/** Extract a file extension (lowercased, no dot) from a filename. */
function extOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

const IMAGE_EXTS = ["png", "jpg", "jpeg"];

export interface MeshPrep {
  faceBudget?: number;
  heightMm?: number;
  repair?: boolean;
}

export type WaitOpts = {
  timeoutMs?: number;
  intervalMs?: number;
  onProgress?: (progress: number, total: number, message: string) => void;
};

function promptParts(entry: any): { graph: any; extra: Record<string, unknown> } {
  const prompt = entry?.prompt;
  if (Array.isArray(prompt)) {
    const extra = prompt[3] && typeof prompt[3] === "object" ? (prompt[3] as Record<string, unknown>) : {};
    return { graph: prompt[2], extra };
  }
  return { graph: null, extra: {} };
}

export function isTrellisGraph(graph: any): boolean {
  if (!graph || typeof graph !== "object") return false;
  return Object.values(graph).some(
    (n: any) => n && (n.class_type === "Trellis2ShapeStage" || n.class_type === "Trellis2UpsampleStage"),
  );
}

export function createTimeMs(entry: any): number | null {
  const { extra } = promptParts(entry);
  const raw = extra.create_time ?? entry?.created_at;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  const msgs = entry?.status?.messages;
  if (Array.isArray(msgs)) {
    for (const m of msgs) {
      if (Array.isArray(m) && m[0] === "execution_start" && typeof m[1]?.timestamp === "number") return m[1].timestamp;
    }
  }
  return null;
}

function gpuSecondsOf(entry: any): number {
  const msgs = entry?.status?.messages;
  if (!Array.isArray(msgs)) return 0;
  let t0: number | null = null;
  let t1: number | null = null;
  for (const m of msgs) {
    if (!Array.isArray(m)) continue;
    if (m[0] === "execution_start" && typeof m[1]?.timestamp === "number") t0 = m[1].timestamp;
    if (m[0] === "execution_success" && typeof m[1]?.timestamp === "number") t1 = m[1].timestamp;
  }
  if (t0 != null && t1 != null && t1 >= t0) return (t1 - t0) / 1000;
  return 0;
}

function isoFromMs(ms: number | null): string | undefined {
  if (ms == null) return undefined;
  return new Date(ms).toISOString();
}

/** Does a filename look like a raster image (png/jpg/jpeg)? */
function isImageFile(filename: string): boolean {
  return IMAGE_EXTS.includes(extOf(filename));
}

/** Poll a task function until it reports a terminal status, or time out. */
async function pollUntilTerminal(
  taskFn: (id: string) => Promise<TaskRecord>,
  id: string,
  opts: WaitOpts = {},
): Promise<TaskRecord> {
  const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
  const intervalMs = Math.max(500, opts.intervalMs ?? 1500);
  const startedAt = Date.now();
  for (;;) {
    const rec = await taskFn(id);
    opts.onProgress?.(typeof rec.progress === "number" ? rec.progress : 0, 1, rec.stage || rec.status || "running");
    const st = (rec.status || "").toLowerCase() as TaskStatus;
    if (TERMINAL_OK.includes(st)) return rec;
    if (TERMINAL_BAD.includes(st)) {
      throw new BridgeError(
        `Trellis task ${id} ${st}: ${rec.error || rec.stage || "no detail"}`,
        500,
        rec.error ?? st,
      );
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new BridgeError(
        `Timed out waiting ${Math.round(timeoutMs / 1000)}s for Trellis task ${id} (last state: ${rec.status}${rec.stage ? `, ${rec.stage}` : ""})`,
        408,
        "timeout",
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Interpret a ComfyUI history entry (the INNER entry, after unwrapping the
 * `{ prompt_id: entry }` wrapper) into a normalized `TaskRecord`. Terminal
 * success = a success status OR non-empty outputs; terminal failure = an
 * error/failed/cancelled status.
 */
export function entryToTaskRecord(id: string, raw: any): TaskRecord {
  let entry: any = raw;
  if (entry && typeof entry === "object" && !Array.isArray(entry) && id in entry) {
    const inner = (entry as any)[id];
    if (inner && typeof inner === "object") entry = inner;
  }

  const rec: TaskRecord = { id, status: "running", progress: 0, stage: "running" };
  if (!entry || typeof entry !== "object") {
    rec.status = "running";
    rec.stage = "queued/running";
    rec.progress = 0;
    return rec;
  }

  const statusObj: any = entry.status || {};
  // ComfyUI stores the status string at status.status_str (a plain
  // status.status is a legacy-bridge shape). Prefer status_str and
  // fall back to status so both transports parse correctly.
  const rawStatus: string = String(statusObj.status_str ?? statusObj.status ?? "").toLowerCase();
  const hasOutputs = !!(entry.outputs && typeof entry.outputs === "object" && Object.keys(entry.outputs).length > 0);

  if (rawStatus === "success" || rawStatus === "succeeded" || (hasOutputs && !rawStatus)) {
    rec.status = "completed";
    rec.stage = "completed";
    rec.progress = 1;
  } else if (rawStatus === "error" || rawStatus === "failed" || rawStatus === "cancelled") {
    rec.status = rawStatus === "cancelled" ? "cancelled" : rawStatus === "failed" ? "failed" : "error";
    rec.stage = `failed: ${rawStatus}`;
    rec.progress = 1;
    const msgs: any[] = Array.isArray(statusObj.messages) ? statusObj.messages : [];
    const lastMsg = msgs.length ? msgs[msgs.length - 1] : null;
    rec.error =
      (typeof statusObj.message === "string" && statusObj.message) ||
      (lastMsg && (typeof lastMsg === "string" ? lastMsg : (lastMsg.message ?? JSON.stringify(lastMsg)))) ||
      rawStatus;
  } else {
    rec.status = (rawStatus as TaskStatus) || "running";
    rec.stage = rawStatus || "running";
    rec.progress = 0;
  }
  rec.formats = deriveFormatList(entry);
  return rec;
}

/** A flat list of the file-extension formats an entry's outputs imply. */
function deriveFormatList(entry: any): string[] {
  const fmts = new Set<string>();
  for (const { ref } of flattenOutputs(entry)) {
    const ext = extOf(ref.filename);
    if (ext) fmts.add(ext);
  }
  return Array.from(fmts);
}

// ---------------------------------------------------------------------------
// Transport interface + shared base client
// ---------------------------------------------------------------------------

export interface TrellisTransport {
  health(): Promise<HealthInfo>;
  start(opts: { wait_seconds?: number; app_script?: string }): Promise<{ ok: boolean; up: boolean; model_loaded?: boolean; waited_ms?: number; note?: string }>;
  generate(p: GenerateRequest): Promise<{ id: string; status: TaskStatus }>;
  task(id: string): Promise<TaskRecord>;
  waitForTask(id: string, opts?: WaitOpts): Promise<TaskRecord>;
  downloadBinary(id: string, format: string, destPath?: string, prep?: MeshPrep): Promise<{ path: string; bytes: number; mime: string; prep?: PrintMeshResult }>;
  render(taskId: string, opts: { mode?: string; nviews?: number; video?: boolean; onProgress?: WaitOpts["onProgress"] }): Promise<{ images: string[]; video?: string[]; note?: string }>;
  gallery(limit: number): Promise<{ items: GalleryItem[] }>;
  usage(): Promise<UsageInfo>;
  /** Generic JSON request (an escape hatch for ad-hoc endpoints, e.g. the bridge's remesh). */
  req<T>(method: string, pathName: string, body?: unknown, timeoutMs?: number): Promise<T>;
}

/**
 * Common per-transport state (base URL, timeout, fetch, logger) plus the
 * generic JSON/binary HTTP primitives every transport builds on.
 */
export class BaseTrellisClient {
  protected readonly baseUrl: string;
  protected readonly timeoutMs: number;
  protected readonly fetchFn: typeof fetch;
  protected readonly log: (msg: string) => void;

  constructor(opts: { baseUrl: string; timeoutMs: number; fetchFn: typeof fetch; log: (msg: string) => void }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs;
    this.fetchFn = opts.fetchFn;
    this.log = opts.log;
  }

  get base(): string {
    return this.baseUrl;
  }

  /**
   * Public generic JSON request — a thin wrapper over the protected
   * `reqJson`. Exposed so callers (e.g. the MCP tools) can issue ad-hoc
   * endpoints (like the bridge backend's `/tasks/:id/remesh`) without
   * reaching into transport internals.
   */
  async req<T>(method: string, pathName: string, body?: unknown, timeoutMs?: number): Promise<T> {
    return this.reqJson<T>(method, pathName, body, timeoutMs);
  }

  protected async reqJson<T>(method: string, pathName: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const url = `${this.baseUrl}${pathName}`;
    const headers: Record<string, string> = { accept: "application/json" };
    const controller = new AbortController();
    const eff = timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), eff);
    try {
      const res = await this.fetchFn(url, {
        method,
        headers: body ? { ...headers, "content-type": "application/json" } : headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text };
      }
      if (!res.ok) {
        const detail = (json as any)?.detail ?? (json as any)?.error ?? text.slice(0, 300);
        throw new BridgeError(`Trellis ${method} ${pathName} -> HTTP ${res.status}: ${String(detail).slice(0, 300)}`, res.status, String(detail));
      }
      return json as T;
    } catch (e: any) {
      if (e instanceof BridgeError) throw e;
      if (e?.name === "AbortError") {
        throw new BridgeError(`Timed out after ${eff}ms contacting Trellis at ${url}`, 408, "timeout");
      }
      throw new BridgeError(
        `Could not reach Trellis at ${url}: ${e?.cause?.code ?? e?.message ?? "network error"}`,
        undefined,
        e?.cause?.code ?? "ECONNREFUSED/ECONNRESET/ENOTFOUND/DNS",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  protected async getBinary(pathName: string, timeoutMs?: number): Promise<{ bytes: Buffer; status: number }> {
    const url = `${this.baseUrl}${pathName}`;
    const controller = new AbortController();
    const eff = timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), eff);
    try {
      const res = await this.fetchFn(url, { signal: controller.signal });
      const bytes = Buffer.from(await res.arrayBuffer());
      return { bytes, status: res.status };
    } catch (e: any) {
      if (e?.name === "AbortError") throw new BridgeError(`Timed out after ${eff}ms (${pathName})`, 408, "timeout");
      throw new BridgeError(`Could not reach Trellis at ${url}: ${e?.cause?.code ?? e?.message ?? "network"}`, undefined, e?.cause?.code);
    } finally {
      clearTimeout(timer);
    }
  }

  protected async uploadImage(bytes: Uint8Array, hintName: string, contentType: string): Promise<string> {
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: contentType }), hintName);
    const url = `${this.baseUrl}/upload/image`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(url, { method: "POST", body: form, signal: controller.signal });
      const text = await res.text();
      if (!res.ok) throw new BridgeError(`Trellis POST /upload/image -> HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
      let j: any = null;
      try {
        j = text ? JSON.parse(text) : null;
      } catch {
        j = null;
      }
      if (j && typeof j === "object" && typeof (j as any).name === "string") return (j as any).name;
      if (typeof j === "string") return j;
      if (j && typeof j === "object") {
        for (const k of Object.keys(j)) {
          if (typeof (j as any)[k] === "string" && (j as any)[k].includes(".")) return (j as any)[k];
        }
      }
      throw new BridgeError(`Trellis POST /upload/image: unexpected response: ${text.slice(0, 120)}`, 200);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// 1) ComfyUI transport (DEFAULT) — speaks standard ComfyUI at :8188
// ---------------------------------------------------------------------------

export class ComfyUITransport extends BaseTrellisClient implements TrellisTransport {
  readonly modelId: string;

  constructor(opts: ConstructorParameters<typeof BaseTrellisClient>[0] & { modelId?: string }) {
    super(opts);
    this.modelId = (opts as { modelId?: string }).modelId ?? "microsoft/TRELLIS.2-4B";
  }

  async health(): Promise<HealthInfo> {
    try {
      const stats = await this.reqJson<any>("GET", "/system_stats", undefined, 8000);
      let busy = false;
      let queued = 0;
      try {
        const q = await this.reqJson<any>("GET", "/queue", undefined, 8000);
        const running = Array.isArray(q?.queue_running) ? q.queue_running.length : 0;
        queued = Array.isArray(q?.queue_pending) ? q.queue_pending.length : 0;
        busy = running > 0;
      } catch {
        busy = false;
      }
      const dev = Array.isArray(stats?.devices) ? stats.devices[0] : undefined;
      const free = typeof dev?.vram_free === "number" ? dev.vram_free / 1024 ** 3 : null;
      return {
        up: true,
        model_loaded: false,
        busy,
        gpu_free_gb: free,
        model_id: this.modelId,
        app_script: "comfyui",
        url: this.baseUrl,
        note: busy
          ? `ComfyUI is up and a job is running (${queued} queued). Trellis weights load per workflow; model_loaded is not reported by ComfyUI.`
          : "ComfyUI is up. Trellis weights load per workflow; model_loaded is not reported by ComfyUI.",
        queue_pending: queued,
      };
    } catch (e) {
      const hint = e instanceof BridgeError ? e.causeHint ?? e.message : (e as Error).message;
      throw new BridgeError(`Trellis (ComfyUI) not reachable at ${this.baseUrl}: ${hint}`, undefined, hint);
    }
  }

  async start(opts: { wait_seconds?: number; app_script?: string } = {}): Promise<{ ok: boolean; up: boolean; model_loaded?: boolean; waited_ms?: number; note?: string }> {
    const waitedStart = Date.now();
    try {
      await this.reqJson("GET", "/system_stats", undefined, 8000);
      const waited = Date.now() - waitedStart;
      return { ok: true, up: true, model_loaded: false, waited_ms: waited, note: "ComfyUI is running — the Trellis.2 workflow loads the model into the GPU on the first /api/prompt." };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new BridgeError(`Trellis (ComfyUI) is not running at ${this.baseUrl}. Start it on the DGX (e.g. \`docker compose up -d\`), then retry. (${msg})`, undefined, msg);
    }
  }

  async generate(p: GenerateRequest): Promise<{ id: string; status: TaskStatus }> {
    const imgBytes = await this.resolveImageBytes(p.image);
    const hintName = this.guessFilename(p.image);
    const contentType = this.guessContentType(hintName);
    const serverName = await this.uploadImage(imgBytes, hintName, contentType);

    const resolution = Number(p.resolution ?? 1536) || 1536;
    const seed = p.randomize_seed ? Math.floor(Math.random() * 100000) : Number(p.seed ?? 42);
    const fillParams: FillImageTo3DParams = { image: serverName, resolution, seed };
    const workflow: ComfyWorkflow = fillImageTo3DWorkflow(fillParams);

    const clientId = randomUUID();
    const extraData: Record<string, unknown> = { seed, resolution };
    if (p.label) extraData.label = p.label;
    const res = await this.reqJson<{ prompt_id: string; number?: number }>(
      "POST",
      "/api/prompt",
      { client_id: clientId, prompt: workflow, output: CAPTURE_NODES, extra_data: extraData },
      60000,
    );
    if (!res || !res.prompt_id) {
      throw new BridgeError("Trellis (ComfyUI) POST /api/prompt returned no prompt_id", 200);
    }
    this.log(`[comfyui] queued image->3D ${res.prompt_id} (seed=${seed}, res=${resolution}, img=${serverName})`);
    return { id: res.prompt_id, status: "queued" };
  }

  async task(id: string): Promise<TaskRecord> {
    const raw = await this.reqJson<any>("GET", `/history/${encodeURIComponent(id)}`, undefined, 20000);
    return entryToTaskRecord(id, raw);
  }

  async waitForTask(id: string, opts: WaitOpts = {}): Promise<TaskRecord> {
    const stop = this.watchComfyProgress(id, opts.onProgress);
    try {
      return await pollUntilTerminal(this.task.bind(this), id, opts);
    } finally {
      stop();
    }
  }

  async downloadBinary(
    id: string,
    format: string,
    destPath?: string,
    prep?: MeshPrep,
  ): Promise<{ path: string; bytes: number; mime: string; prep?: PrintMeshResult }> {
    const fmt = (format || "glb").toLowerCase().replace(/^\./, "");
    if (fmt === "fbx" || fmt === "usdz") {
      throw new BridgeError(
        `This install does not export ${fmt.toUpperCase()}. Download GLB, or STL/OBJ which are converted locally with trimesh.`,
        415,
        fmt,
      );
    }
    if (!destPath) throw new BridgeError("downloadBinary requires a destPath (caller decides location).", 400);
    const glb = await this.saveGlb(id, fmt === "glb" && !prep?.faceBudget && prep?.heightMm === undefined ? destPath : undefined);
    if (fmt === "glb" && !prep?.faceBudget && prep?.heightMm === undefined && !prep?.repair) {
      return { path: glb.path, bytes: glb.bytes, mime: mimeForFmt("glb") };
    }
    const outFmt = fmt === "obj" || fmt === "stl" || fmt === "glb" ? fmt : "glb";
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const converted = await convertMesh({
      src: glb.path,
      dest: destPath,
      format: outFmt,
      faceBudget: prep?.faceBudget,
      heightMm: prep?.heightMm,
      repair: prep?.repair,
    });
    if (fmt !== "glb" && glb.path !== destPath) {
      try {
        fs.unlinkSync(glb.path);
      } catch {
        /* temp glb */
      }
    }
    return { path: converted.path, bytes: converted.bytes, mime: mimeForFmt(outFmt), prep: converted };
  }

  async render(taskId: string, opts: { mode?: string; nviews?: number; video?: boolean; onProgress?: WaitOpts["onProgress"] } = {}): Promise<{ images: string[]; video?: string[]; note?: string }> {
    const mode = (opts.mode ?? "solid") as RenderMode;
    if (!RENDER_MODES.includes(mode)) {
      throw new BridgeError(
        `mode "${opts.mode}" is not a RenderMesh mode. Use one of: ${RENDER_MODES.join(", ")}.`,
        422,
        String(opts.mode),
      );
    }
    const nviews = Math.max(1, Math.min(8, opts.nviews ?? 4));
    const entry = await this.fetchHistoryEntry(taskId);
    const glbRef = this.pickGlb(flattenOutputs(entry));
    if (!glbRef) throw new BridgeError(`No GLB in task ${taskId} to render.`, 404);
    const urlPath = this.viewPath(glbRef.ref);
    const bin = await this.getBinary(urlPath, 180000);
    if (bin.status !== 200 && bin.status !== 206) {
      throw new BridgeError(`ComfyUI GET ${urlPath} -> HTTP ${bin.status}`, bin.status);
    }
    const uploaded = await this.uploadModel(bin.bytes, glbRef.ref.filename.endsWith(".glb") ? path.basename(glbRef.ref.filename) : `${taskId}.glb`);
    const prefix = `3d/trellis_print_${Date.now().toString(36)}`;
    const { workflow, capture } = buildSolidViewWorkflow({ modelFile: uploaded, mode, nviews, prefix });
    const clientId = randomUUID();
    const queued = await this.reqJson<{ prompt_id: string }>(
      "POST",
      "/api/prompt",
      { client_id: clientId, prompt: workflow, output: capture, extra_data: { source_task: taskId, mode, nviews } },
      60000,
    );
    if (!queued?.prompt_id) throw new BridgeError("Render POST /api/prompt returned no prompt_id", 200);
    await this.waitForTask(queued.prompt_id, { timeoutMs: 180000, intervalMs: 1000, onProgress: opts.onProgress });
    const done = await this.fetchHistoryEntry(queued.prompt_id);
    const images: string[] = [];
    const frames = flattenOutputs(done)
      .filter((fo) => isImageFile(fo.ref.filename))
      .sort((a, b) => a.ref.filename.localeCompare(b.ref.filename));
    for (const fo of frames) {
      const view = this.viewPath(fo.ref);
      const res = await this.getBinary(view, 60000);
      if (res.status === 200) images.push(`data:image/png;base64,${res.bytes.toString("base64")}`);
    }
    if (images.length === 0) throw new BridgeError(`Render ${queued.prompt_id} finished with no PNG output.`, 500);
    const videoNote = opts.video ? " No mp4 is encoded; the frames are the turntable." : "";
    return {
      images,
      video: undefined,
      note: `Rendered ${images.length} ${mode} view(s) via RenderMesh.${videoNote}`,
    };
  }

  async gallery(limit: number): Promise<{ items: GalleryItem[] }> {
    const entries = (await this.reqJson<Record<string, any>>("GET", "/history", undefined, 30000)) || {};
    const rows = Object.keys(entries)
      .map((pid) => ({ pid, entry: entries[pid], t: createTimeMs(entries[pid]) }))
      .filter((row) => isTrellisGraph(promptParts(row.entry).graph))
      .sort((a, b) => (b.t ?? 0) - (a.t ?? 0))
      .slice(0, limit);
    const items: GalleryItem[] = [];
    for (const row of rows) {
      const { extra } = promptParts(row.entry);
      const flat = flattenOutputs(row.entry);
      const preview = await this.smallestImage(flat);
      items.push({
        id: row.pid,
        label: typeof extra.label === "string" ? extra.label : undefined,
        created_at: isoFromMs(row.t),
        model_id: this.modelId,
        formats: deriveFormatList(row.entry),
        thumbnail: null,
        preview_filename: preview?.ref.filename,
        preview_subfolder: preview?.ref.subfolder,
        preview_type: preview?.ref.type,
        input_image: null,
      });
    }
    return { items };
  }

  async usage(): Promise<UsageInfo> {
    const entries = (await this.reqJson<Record<string, any>>("GET", "/history", undefined, 30000)) || {};
    const rows = Object.keys(entries)
      .map((pid) => ({ pid, entry: entries[pid], t: createTimeMs(entries[pid]) }))
      .filter((row) => isTrellisGraph(promptParts(row.entry).graph))
      .sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
    const gpu = rows.reduce((sum, row) => sum + gpuSecondsOf(row.entry), 0);
    const last = rows[0];
    return {
      total_generated: rows.length,
      gpu_seconds_estimate: Math.round(gpu * 10) / 10,
      last_task_id: last?.pid ?? null,
      last_task_at: last ? isoFromMs(last.t) ?? null : null,
      credits_used: rows.length,
    };
  }

  /**
   * Fetch the INNER ComfyUI history entry for a prompt id. `GET
   * /history/{id}` returns the single entry WRAPPED as `{ [id]: entry }`
   * — we unwrap it here so every consumer (download / render) sees the
   * plain `{ status, outputs, ... }` shape, not the wrapper. (entryToTaskRecord
   * performs the identical unwrap on the raw response it is handed.)
   */
  private async fetchHistoryEntry(id: string): Promise<any> {
    const raw = await this.reqJson<any>("GET", `/history/${encodeURIComponent(id)}`, undefined, 20000);
    if (raw && typeof raw === "object" && !Array.isArray(raw) && id in raw) {
      const inner = (raw as any)[id];
      if (inner && typeof inner === "object") return inner;
    }
    return raw;
  }

  private async resolveImageBytes(image: string): Promise<Uint8Array> {
    if (image.startsWith("data:")) {
      const commaIdx = image.indexOf(",");
      if (commaIdx >= 0) {
        return new Uint8Array(Buffer.from(image.slice(commaIdx + 1), "base64"));
      }
      throw new BridgeError(`Malformed data: URL (no comma): ${image.slice(0, 40)}`, 400);
    }
    if (image.startsWith("http://") || image.startsWith("https://")) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      try {
        const res = await this.fetchFn(image, { signal: controller.signal });
        if (!res.ok) {
          throw new BridgeError(`Fetching image from ${image} → HTTP ${res.status}`, res.status);
        }
        return new Uint8Array(Buffer.from(await res.arrayBuffer()));
      } finally {
        clearTimeout(timer);
      }
    }
    if (fs.existsSync(image) && fs.statSync(image).isFile()) {
      return new Uint8Array(fs.readFileSync(image));
    }
    throw new BridgeError(`Cannot resolve the conditioning image "${image}" (not a local file, URL, or data: URL).`, 400);
  }

  private guessFilename(image: string): string {
    if (image.startsWith("data:") || image.startsWith("http://") || image.startsWith("https://")) {
      return "conditioning_image";
    }
    return path.basename(image) || "conditioning_image";
  }

  private guessContentType(hintName: string): string {
    const ext = extOf(hintName);
    const map: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      bmp: "image/bmp",
    };
    return map[ext] ?? "image/jpeg";
  }

  private pickGlb(flat: NodeOutput[]): NodeOutput | undefined {
    const glbs = flat.filter((fo) => fo.ref.filename.toLowerCase().endsWith(".glb"));
    return (
      glbs.find((fo) => /final|textured/i.test(fo.nodeId) || /final|textured/i.test(fo.ref.filename)) ??
      glbs[glbs.length - 1]
    );
  }

  private viewPath(ref: OutputRef): string {
    return `/view?filename=${encodeURIComponent(ref.filename)}&subfolder=${encodeURIComponent(ref.subfolder)}&type=${encodeURIComponent(ref.type)}`;
  }

  /** Download the textured GLB. Pass destPath to keep that file; otherwise a temp file is used. */
  private async saveGlb(id: string, destPath?: string): Promise<{ path: string; bytes: number }> {
    const entry = await this.fetchHistoryEntry(id);
    const pick = this.pickGlb(flattenOutputs(entry));
    if (!pick) throw new BridgeError(`No GLB in ComfyUI history for task ${id}.`, 404);
    const urlPath = this.viewPath(pick.ref);
    const res = await this.getBinary(urlPath, 180000);
    if (res.status !== 200 && res.status !== 206) {
      throw new BridgeError(`ComfyUI GET ${urlPath} -> HTTP ${res.status}`, res.status);
    }
    const dest = destPath ?? path.join(os.tmpdir(), `trellis-${id}.glb`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, res.bytes);
    return { path: dest, bytes: res.bytes.length };
  }

  private async uploadModel(bytes: Buffer, filename: string): Promise<string> {
    const form = new FormData();
    form.append("image", new Blob([bytes], { type: "model/gltf-binary" }), filename);
    form.append("subfolder", "3d");
    const url = `${this.baseUrl}/upload/image`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    try {
      const res = await this.fetchFn(url, { method: "POST", body: form, signal: controller.signal });
      const text = await res.text();
      if (!res.ok) throw new BridgeError(`Trellis POST /upload/image -> HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
      const j = text ? JSON.parse(text) : null;
      const name = j && typeof j.name === "string" ? j.name : filename;
      const sub = j && typeof j.subfolder === "string" ? j.subfolder : "";
      return sub ? `${sub}/${name}` : name;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Smallest PNG at or under 300KB, probed with a 1-byte range so a 4096 texture is not inlined. */
  private async smallestImage(flat: NodeOutput[]): Promise<NodeOutput | null> {
    const imgs = flat.filter((fo) => isImageFile(fo.ref.filename)).slice(0, 8);
    let best: { fo: NodeOutput; size: number } | null = null;
    for (const fo of imgs) {
      const size = await this.contentLength(fo.ref);
      if (size == null || size > 300_000) continue;
      if (!best || size < best.size) best = { fo, size };
    }
    return best?.fo ?? null;
  }

  /** ComfyUI /ws progress events for one prompt. No-op when WebSocket is missing. */
  private watchComfyProgress(promptId: string, onProgress?: WaitOpts["onProgress"]): () => void {
    if (!onProgress || typeof WebSocket === "undefined") return () => undefined;
    let ws: WebSocket;
    try {
      const wsUrl = `${this.baseUrl.replace(/^http/, "ws")}/ws?clientId=${randomUUID()}`;
      ws = new WebSocket(wsUrl);
    } catch {
      return () => undefined;
    }
    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        const data = msg?.data;
        if (!data || data.prompt_id !== promptId) return;
        if (msg.type === "progress" && typeof data.value === "number" && typeof data.max === "number" && data.max > 0) {
          onProgress(data.value, data.max, data.node ? `node ${data.node}` : "sampling");
        } else if (msg.type === "executing") {
          onProgress(0, 1, data.node ? `running ${data.node}` : "running");
        }
      } catch {
        /* ignore malformed socket frames */
      }
    });
    return () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    };
  }

  private async contentLength(ref: OutputRef): Promise<number | null> {
    const url = `${this.baseUrl}${this.viewPath(ref)}`;
    try {
      const res = await this.fetchFn(url, { headers: { range: "bytes=0-0" } });
      const cr = res.headers.get("content-range");
      await res.arrayBuffer();
      if (cr && cr.includes("/")) {
        const total = Number(cr.split("/").pop());
        if (Number.isFinite(total)) return total;
      }
      const len = Number(res.headers.get("content-length"));
      return Number.isFinite(len) ? len : null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// 2) Legacy bridge transport — the bespoke REST front (docker/trellis-api on :7861)
// ---------------------------------------------------------------------------

/**
 * The LEGACY bespoke **REST bridge** transport (kept behind
 * `TRELLIS_BACKEND=bridge` so existing docker-bridge deployments keep
 * working). A small FastAPI app on the DGX at `:7861` wraps the same Trellis pipeline and
 * exposes a task-oriented API:
 *
 *   GET  /health                       → { up, model_loaded, busy, … }
 *   POST /start                            → bring the service up + wait until healthy
 *   POST /generate                            → submit an image→3D job → { id, status }
 *   GET  /tasks/:id                            → poll the task (pending/running/postprocessing/completed/failed)
 *   GET  /tasks/:id/download?format=…  → download the produced file (GLB/STL/OBJ/…)
 *   POST /tasks/:id/render                   → render preview frames (HDRI)
 *   POST /tasks/:id/remesh                    → decimate / remesh the produced mesh
 *   GET  /gallery                               → the gallery of all models made
 *   GET  /usage                                 → usage / "credits"
 */
export class BridgeTransport extends BaseTrellisClient implements TrellisTransport {
  constructor(opts: ConstructorParameters<typeof BaseTrellisClient>[0]) {
    super(opts);
  }

  async health(): Promise<HealthInfo> {
    return this.reqJson<HealthInfo>("GET", "/health");
  }

  async start(opts: { wait_seconds?: number; app_script?: string } = {}): Promise<{ ok: boolean; up: boolean; model_loaded?: boolean; waited_ms?: number; note?: string }> {
    return this.reqJson("POST", "/start", opts);
  }

  async generate(p: GenerateRequest): Promise<{ id: string; status: TaskStatus }> {
    return this.reqJson<{ id: string; status: TaskStatus }>("POST", "/generate", p);
  }

  async task(id: string): Promise<TaskRecord> {
    return this.reqJson<TaskRecord>("GET", `/tasks/${encodeURIComponent(id)}`);
  }

  async waitForTask(id: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<TaskRecord> {
    return pollUntilTerminal(this.task.bind(this), id, opts);
  }

  async downloadBinary(id: string, format: string, destPath?: string, _prep?: MeshPrep): Promise<{ path: string; bytes: number; mime: string }> {
    const fmt = (format || "glb").toLowerCase().replace(/^\./, "");
    const url = `/tasks/${encodeURIComponent(id)}/download?format=${encodeURIComponent(fmt)}`;
    const res = await this.getBinary(url, 120000);
    if (res.status !== 200) {
      throw new BridgeError(`Bridge GET ${url} -> HTTP ${res.status}`, res.status);
    }
    if (!destPath) throw new BridgeError("downloadBinary requires a destPath", 400);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, res.bytes);
    return { path: destPath, bytes: res.bytes.length, mime: mimeForFmt(fmt) };
  }

  async render(taskId: string, opts: { mode?: string; nviews?: number; video?: boolean } = {}): Promise<{ images: string[]; video?: string[]; note?: string }> {
    return this.reqJson("POST", `/tasks/${encodeURIComponent(taskId)}/render`, opts);
  }

  async gallery(limit: number): Promise<{ items: GalleryItem[] }> {
    return this.reqJson<{ items: GalleryItem[] }>("GET", `/gallery?limit=${encodeURIComponent(String(limit))}`);
  }

  async usage(): Promise<UsageInfo> {
    return this.reqJson<UsageInfo>("GET", "/usage");
  }
}

// ---------------------------------------------------------------------------
// 3) The public façade — TrellisBridgeClient (selects the transport)
// ---------------------------------------------------------------------------

export interface TrellisBridgeClientConfig {
  baseUrl?: string;
  backend?: "comfyui" | "bridge";
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  log?: (msg: string) => void;
  modelId?: string;
}

/**
 * The PUBLIC façade of the Trellis service client. Construct one (or use the
 * shared singleton below) and call the stable methods — `health`, `start`,
 * `generate`, `task`, `waitForTask`, `downloadBinary`, `render`, `gallery`,
 * `usage`. The façade selects a transport based on `TRELLIS_BACKEND`
 * (default `comfyui`) and delegates every call to it, so the 11 MCP tools
 * (and the skill) are transport-agnostic.
 */
export class TrellisBridgeClient implements TrellisTransport {
  private readonly transport: TrellisTransport;

  constructor(opts: TrellisBridgeClientConfig = {}) {
    const backend =
      opts.backend ?? (process.env.TRELLIS_BACKEND as "comfyui" | "bridge" | undefined) ?? "comfyui";

    let baseUrl: string;
    if (opts.baseUrl) {
      baseUrl = opts.baseUrl;
    } else if (backend === "bridge") {
      baseUrl = process.env.TRELLIS_BRIDGE_URL ?? "http://127.0.0.1:7861";
    } else {
      baseUrl = process.env.TRELLIS_API_URL || "http://127.0.0.1:8188";
    }

    const base: ConstructorParameters<typeof BaseTrellisClient>[0] = {
      baseUrl,
      timeoutMs: opts.timeoutMs ?? 20000,
      fetchFn: opts.fetchFn ?? fetch.bind(globalThis),
      log: opts.log ?? (() => undefined),
    };

    if (backend === "bridge") {
      this.transport = new BridgeTransport(base);
    } else {
      this.transport = new ComfyUITransport({ ...base, modelId: opts.modelId });
    }
  }

  get base(): string {
    return (this.transport as unknown as BaseTrellisClient).base;
  }

  health(): Promise<HealthInfo> {
    return this.transport.health();
  }

  start(opts: { wait_seconds?: number; app_script?: string } = {}): Promise<{ ok: boolean; up: boolean; model_loaded?: boolean; waited_ms?: number; note?: string }> {
    return this.transport.start(opts);
  }

  generate(p: GenerateRequest): Promise<{ id: string; status: TaskStatus }> {
    return this.transport.generate(p);
  }

  task(id: string): Promise<TaskRecord> {
    return this.transport.task(id);
  }

  async waitForTask(id: string, opts: WaitOpts = {}): Promise<TaskRecord> {
    return this.transport.waitForTask(id, opts);
  }

  downloadBinary(id: string, format: string, destPath?: string, prep?: MeshPrep): Promise<{ path: string; bytes: number; mime: string; prep?: PrintMeshResult }> {
    return this.transport.downloadBinary(id, format, destPath, prep);
  }

  render(taskId: string, opts: { mode?: string; nviews?: number; video?: boolean; onProgress?: WaitOpts["onProgress"] } = {}): Promise<{ images: string[]; video?: string[]; note?: string }> {
    return this.transport.render(taskId, opts);
  }

  gallery(limit: number): Promise<{ items: GalleryItem[] }> {
    return this.transport.gallery(limit);
  }

  usage(): Promise<UsageInfo> {
    return this.transport.usage();
  }

  /** Generic JSON request (delegated to the selected transport). */
  req<T>(method: string, pathName: string, body?: unknown, timeoutMs?: number): Promise<T> {
    return this.transport.req<T>(method, pathName, body, timeoutMs);
  }
}

/** Shared, lazily-initialized client singleton. */
let _client: TrellisBridgeClient | undefined;
export function getClient(): TrellisBridgeClient {
  if (!_client) _client = new TrellisBridgeClient({});
  return _client;
}
export function resetClient(): void {
  _client = undefined;
}
