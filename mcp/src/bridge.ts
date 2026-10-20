/**
 * bridge.ts — typed HTTP client for the Trellis service.
 *
 * The "bridge" is the actual Trellis runtime living on the DGX
 * Spark (the dr-vij/Trellis2-DGX-Spark-Docker stack, Gradio app on
 * :7860). Rather than scraping Gradio, this client talks to a thin
 * REST front that wraps the SAME pipeline, and — importantly — it
 * degrades gracefully when Trellis is NOT running (which is the
 * normal state, to free the GPU for TensorFold).
 *
 * Point it at your box:
 *   TRELLIS_API_URL  base URL of the Trellis REST front
 *                       (default http://127.0.0.1:7861)
 *   TRELLIS_GRADIO_URL  (optional) Gradio UI base, default derived
 */

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
  /** Is the REST front / container answering? */
  up: boolean;
  /** Has the Trellis2 pipeline been loaded into GPU memory? */
  model_loaded: boolean;
  /** Is a generation currently in flight? */
  busy: boolean;
  /** Free unified-memory on the DGX, in GB (best-effort). */
  gpu_free_gb?: number | null;
  /** The underlying 3D model id, e.g. "microsoft/TRELLIS.2-4B". */
  model_id?: string;
  /** Which app script is serving (app.py vs app_texturing.py). */
  app_script?: string;
  /** Gradio/REST URL. */
  url?: string;
  /** Human note, e.g. "stopped to free GPU for TensorFold". */
  note?: string;
  [k: string]: unknown;
}

export interface SamplerParams {
  /** Sampling steps. */
  steps?: number;
  /** Guidance strength. */
  guidance_strength?: number;
  /** Guidance rescale. */
  guidance_rescale?: number;
  /** Rescale t. */
  rescale_t?: number;
  [k: string]: unknown;
}

export interface GenerateRequest {
  /**
   * The conditioning image. Accepts, in priority order:
   *  - a local path (absolute or relative) on the HOST running the MCP
   *    (it is base64-embedded and shipped to the DGX)
   *  - an http(s) URL (the DGX fetches it)
   *  - a data: URL
   */
  image: string;
  /** Target resolution bucket: 512 | 1024 | 1536. */
  resolution?: 512 | 1024 | 1536 | "512" | "1024" | "1536";
  /** Random seed (fixed for reproducibility). */
  seed?: number;
  /** Randomize the seed. */
  randomize_seed?: boolean;
  /** Sparse-structure sampler params. */
  sparse_structure_sampler_params?: SamplerParams;
  /** Shape SLAT sampler params. */
  shape_slat_sampler_params?: SamplerParams;
  /** Texture SLAT sampler params. */
  tex_slat_sampler_params?: SamplerParams;
  /** Optional tag for the gallery. */
  label?: string;
  [k: string]: unknown;
}

export interface TaskRecord {
  id: string;
  status: TaskStatus;
  /** 0..1 progress if known. */
  progress?: number | null;
  /** Human stage label. */
  stage?: string;
  created_at?: string;
  updated_at?: string;
  finished_at?: string;
  error?: string | null;
  /** Resolved model id. */
  model_id?: string;
  /** Output formats available. */
  formats?: string[];
  /** Byte size per format. */
  sizes?: Record<string, number>;
  /** Input label/prompt. */
  label?: string;
  /** Preview PNG data-url (optional, cheap). */
  preview?: string | null;
  [k: string]: unknown;
}

export interface GalleryItem {
  id: string;
  label?: string;
  created_at?: string;
  model_id?: string;
  formats?: string[];
  /** Small preview thumbnail (data-url or url). */
  thumbnail?: string | null;
  /** The conditioning image (data-url or url), if retained. */
  input_image?: string | null;
  [k: string]: unknown;
}

export interface UsageInfo {
  /** Total models generated since tracking began. */
  total_generated: number;
  /** Estimated GPU-seconds consumed. */
  gpu_seconds_estimate?: number;
  /** Last task id + time. */
  last_task_id?: string | null;
  last_task_at?: string | null;
  /** Local "credit" framing (1 credit ~= 1 model). */
  credits_used?: number;
  [k: string]: unknown;
}

export interface BridgeClientOptions {
  baseUrl?: string;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /** Injectable fetch (for tests). */
  fetchFn?: typeof fetch;
  /** Injectable logger. */
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

const TERMINAL_OK: TaskStatus[] = ["completed", "succeeded"];
const TERMINAL_BAD: TaskStatus[] = ["failed", "error", "cancelled"];

export class TrellisBridgeClient {
  private baseUrl: string;
  private timeoutMs: number;
  private fetchFn: typeof fetch;
  private log: (msg: string) => void;

  constructor(opts: BridgeClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.TRELLIS_API_URL ?? "http://127.0.0.1:7861").replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 20000;
    this.fetchFn = opts.fetchFn ?? fetch.bind(globalThis);
    this.log = opts.log ?? (() => undefined);
  }

  get base(): string {
    return this.baseUrl;
  }

  async req<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { accept: "application/json" };
    const controller = new AbortController();
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);
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
        throw new BridgeError(`Trellis bridge ${method} ${path} -> HTTP ${res.status}: ${String(detail).slice(0, 300)}`, res.status, String(detail));
      }
      return json as T;
    } catch (e: any) {
      if (e instanceof BridgeError) throw e;
      if (e?.name === "AbortError") {
        throw new BridgeError(`Timed out after ${effectiveTimeout}ms contacting Trellis bridge at ${url}`, 408, "timeout");
      }
      // Connection-level failure => Trellis likely not running.
      throw new BridgeError(`Could not reach Trellis bridge at ${url}: ${e?.cause?.code ?? e?.message ?? "network error"}`, undefined, e?.cause?.code ?? "ECONNREFUSED/ECONNRESET/ENOTFOUND/DNS");
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /health */
  health(): Promise<HealthInfo> {
    return this.req<HealthInfo>("GET", "/health");
  }

  /** POST /start — bring Trellis up (docker compose / python app) and wait until healthy. */
  start(opts: { wait_seconds?: number; app_script?: string } = {}): Promise<{ ok: boolean; up: boolean; model_loaded?: boolean; waited_ms?: number; note?: string }> {
    return this.req("POST", "/start", opts);
  }

  /** POST /generate — submit an image->3D job, returns the task id. */
  generate(p: GenerateRequest): Promise<{ id: string; status: TaskStatus }> {
    return this.req("POST", "/generate", p);
  }

  /** GET /tasks/:id */
  task(id: string): Promise<TaskRecord> {
    return this.req("GET", `/tasks/${encodeURIComponent(id)}`);
  }

  /**
   * Poll a task until it reaches a terminal state or the timeout elapses.
   * Returns the final TaskRecord (throws if terminal-bad, or on timeout).
   */
  async waitForTask(id: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<TaskRecord> {
    const timeoutMs = opts.timeoutMs ?? 30 * 60 * 1000;
    const intervalMs = Math.max(500, opts.intervalMs ?? 1500);
    const startedAt = Date.now();
    let last: TaskRecord | undefined;
    for (;;) {
      const rec = await this.task(id);
      last = rec;
      const st = (rec.status || "").toLowerCase() as TaskStatus;
      if (TERMINAL_OK.includes(st)) return rec;
      if (TERMINAL_BAD.includes(st)) {
        throw new BridgeError(`Trellis task ${id} ${st}: ${rec.error || rec.stage || "no detail"}`, 500, rec.error ?? st);
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new BridgeError(`Timed out waiting ${Math.round(timeoutMs / 1000)}s for Trellis task ${id} (last state: ${rec.status}${rec.stage ? `, ${rec.stage}` : ""})`, 408, "timeout");
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /** GET /tasks/:id/download?format=glb|stl|obj|fbx|usdz — binary. */
  async downloadBinary(id: string, format: string, destPath?: string): Promise<{ path: string; bytes: number; mime: string }> {
    const fmt = format.toLowerCase().replace(/^\./, "");
    const url = `${this.baseUrl}/tasks/${encodeURIComponent(id)}/download?format=${encodeURIComponent(fmt)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await this.fetchFn(url, { signal: controller.signal });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new BridgeError(`Download of Trellis task ${id} (${fmt}) -> HTTP ${res.status}: ${t.slice(0, 200)}`, res.status);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const mime = this.mimeFor(fmt);
      let out = destPath;
      if (!out) {
        // Caller decides; leave undefined signal. Here we assume caller gave dest.
        throw new BridgeError("downloadBinary requires a destPath");
      }
      const fs = await import("node:fs");
      const pathMod = await import("node:path");
      fs.mkdirSync(pathMod.dirname(out), { recursive: true });
      fs.writeFileSync(out, buf);
      return { path: out, bytes: buf.length, mime };
    } catch (e: any) {
      if (e instanceof BridgeError) throw e;
      throw new BridgeError(`Failed downloading Trellis task ${id} (${fmt}): ${e?.message ?? e}`, undefined, e?.cause?.code);
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST /render — render the produced mesh to PNG frames under an HDRI. */
  render(taskId: string, opts: { mode?: string; nviews?: number; resolution?: number; video?: boolean } = {}): Promise<{ images: string[]; video?: string[]; note?: string }> {
    return this.req("POST", `/tasks/${encodeURIComponent(taskId)}/render`, opts);
  }

  /** GET /gallery?limit=N */
  gallery(limit = 24): Promise<{ items: GalleryItem[] }> {
    return this.req("GET", `/gallery?limit=${encodeURIComponent(String(limit))}`);
  }

  /** GET /usage */
  usage(): Promise<UsageInfo> {
    return this.req("GET", "/usage");
  }

  private mimeFor(fmt: string): string {
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
      default:
        return "application/octet-stream";
    }
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
