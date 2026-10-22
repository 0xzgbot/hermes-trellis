#!/usr/bin/env node
/**
 * smoke.mjs — end-to-end test of the Trellis MCP tool surface against a mock
 * of the DGX **ComfyUI** backend (default `TRELLIS_BACKEND=comfyui`, Trellis.2
 * running inside standard ComfyUI 0.42 on the DGX at :8188).
 *
 * Spins up an in-process mock of the ComfyUI endpoints:
 *   GET  /system_stats           → liveness
 *   POST /upload/image           → multipart image upload
 *   POST /api/prompt             → { client_id, prompt, output, extra_data } → { prompt_id }
 *   GET  /history/{id}           → WRAPPER { [id]: entry } (we unwrap it)
 *   GET  /history                → flat map { [id]: entry }
 *   GET  /view?filename&subfolder&type → binary output
 * and drives every MCP tool the way a Hermes agent would:
 *   health → start → image_to_3d(submit) → task_status → wait_task →
 *   download → render_preview → gallery → usage
 *
 * The mock is STATEFUL: each /history/{id} poll advances the task's progress
 * and flips it to "completed" after a few polls, so the wait loop observes a
 * real pending → running → completed transition with no timers/flake. This
 * proves the full MCP ↔ ComfyUI contract on the Mac without a GPU.
 *
 * NOTE on result shape: every tool returns
 *   { content: [{type:"text", text}], structuredContent: {...} }
 * where `text` may carry a human note line ahead of the JSON, and
 * `structuredContent` is the clean machine-readable object. Tests read
 * `structuredContent` via dataOf(r), never re-parse the human text.
 *
 * Run:  node tests/smoke.mjs        (from the repo root)
 * Repo: https://github.com/0xzgbot/hermes-trellis
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Import the BUILT modules (so we test exactly what ships).
const { TrellisBridgeClient } = await import("../mcp/dist/bridge.js");
const { fillImageTo3DWorkflow } = await import("../mcp/dist/workflow-image-to-3d.js");
const { buildSolidViewWorkflow } = await import("../mcp/dist/workflow-render.js");
const T = await import("../mcp/dist/tools.js");

// A tiny valid 1x1 PNG (base64) — used for render frames + gallery thumbs.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const TINY_PNG_DATAURL = `data:image/png;base64,${TINY_PNG_B64}`;
const TINY_PNG_BYTES = Buffer.from(TINY_PNG_B64, "base64");

/** Read the clean machine object from a tool result (never re-parse human text). */
function dataOf(r) {
  if (r && r.structuredContent && typeof r.structuredContent === "object") return r.structuredContent;
  const t = (r && r.content && r.content[0] && r.content[0].text) || "";
  const i = t.indexOf("{");
  if (i >= 0) {
    try {
      return JSON.parse(t.slice(i));
    } catch {}
  }
  try {
    return JSON.parse(t);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Mock ComfyUI backend (the DGX :8188 path — Trellis.2 node classes are
// loaded in-process by ComfyUI; the mock only provides the API).
// ---------------------------------------------------------------------------
function startMockComfyUI() {
  const tasks = new Map(); // id -> task state
  const gallerySeed = [
    {
      id: "g-seed-1",
      label: "a bronze bison",
      created_at: "2026-10-18T12:00:00Z",
      model_id: "microsoft/TRELLIS.2-4B",
      formats: ["glb", "png"],
      thumbnail: TINY_PNG_DATAURL,
      input_image: TINY_PNG_DATAURL,
    },
    {
      id: "g-seed-2",
      label: "terrain record weight",
      created_at: "2026-10-19T09:30:00Z",
      model_id: "microsoft/TRELLIS.2-4B",
      formats: ["glb", "png"],
      thumbnail: TINY_PNG_DATAURL,
      input_image: TINY_PNG_DATAURL,
    },
  ];
  const usage = {
    total_generated: 2,
    gpu_seconds_estimate: 58,
    credits_used: 2,
    last_task_id: "g-seed-2",
    last_task_at: "2026-10-19T09:30:00Z",
  };

  // One task record, carrying the ComfyUI-flavoured outputs the pipeline's
  // SaveGLB / SaveImage nodes leave behind.
  function makeTask(id, statusStr = "pending", progress = 0, label) {
    return {
      id,
      status_str: statusStr,
      status: statusStr,
      progress,
      queries: 0,
      label: label || undefined,
      image: null,
      resolution: 1024,
      formats: ["glb", "png"],
      sizes: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      finished_at: null,
      error: null,
      model_id: "microsoft/TRELLIS.2-4B",
      preview: TINY_PNG_DATAURL,
      outputs: {
        "24": {
          images: [
            { filename: "stage1_raw.glb", subfolder: "3d", type: "output" },
            { filename: "final_model.glb", subfolder: "3d", type: "output" },
          ],
        },
        "55": {
          images: [{ filename: "preview.png", subfolder: "", type: "output" }],
        },
      },
    };
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://mock");
    const p = u.pathname;
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(obj == null ? null : JSON.stringify(obj));
    };
    const readBody = () =>
      new Promise((resolve) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => resolve(b));
      });

    try {
      // 1) liveness — ComfyUI says it is up via /system_stats
      if (req.method === "GET" && p === "/system_stats") {
        return send(200, {
          system: { os: "linux" },
          devices: ["cuda"],
          comfyui_version: "0.42.0",
        });
      }

      // 2) image upload (multipart form, field "image") → server-side name
      if (req.method === "POST" && p === "/upload/image") {
        const size = await new Promise((resolve) => {
          let n = 0;
          req.on("data", (c) => (n += c.length));
          req.on("end", () => resolve(n));
        });
        const name = `cond_${Date.now() % 100000}.png`;
        return send(200, { name, subfolder: "", type: "output" });
      }

      // 3) queue the filled workflow graph.
      //    Contract under test: POST /api/prompt { client_id, prompt, output, extra_data }
      //    The mock records the graph; a subsequent /history/{id} poll promotes
      //    this task from pending → running → completed.
      if (req.method === "POST" && p === "/api/prompt") {
        const raw = await readBody();
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return send(400, { error: "bad json" });
        }
        if (!body || typeof body !== "object" || !body.prompt || !Array.isArray(body.output)) {
          return send(400, { error: "missing prompt/output" });
        }
        const pid = `pid_${tasks.size + 1}_${Date.now().toString(36)}`;
        const task = makeTask(pid, "executing", 0.05, body.extra_data?.label);
        task.graph = body.prompt;
        task.image = body.extra_data?.seed;
        tasks.set(pid, task);
        usage.total_generated += 1;
        usage.credits_used += 1;
        usage.last_task_id = pid;
        usage.last_task_at = new Date().toISOString();
        return send(200, { prompt_id: pid, number: tasks.size });
      }

      if (req.method === "GET" && p === "/history/stuck") {
        return send(200, { stuck: { status: { status_str: "executing", messages: [] }, outputs: {}, prompt: [1, "stuck", {}, {}, []] } });
      }

      // 4) single-task history: WRAPPED as { [id]: entry }
      let m = req.method === "GET" ? p.match(/^\/history\/([^/]+)$/) : null;
      if (m) {
        const id = decodeURIComponent(m[1]);
        const t = tasks.get(id);
        if (!t) return send(404, { detail: `no such task ${id}` });
        t.queries += 1;
        t.updated_at = new Date().toISOString();
        // Stateful advance, mirroring ComfyUI: freshly queued task becomes
        // "executing" (queries>=1); after enough polls it reaches "success".
        if (t.status_str === "pending" && t.queries >= 1) {
          t.status_str = "executing";
          t.progress = 0.2;
        }
        if (t.status_str === "executing" && t.queries >= 2) {
          t.status_str = "success";
          t.progress = 1;
          t.finished_at = new Date().toISOString();
          t.sizes = { glb: 1048576, png: 64 };
        }
        const entry = {
          prompt: [
            1,
            id,
            t.graph || {},
            { label: t.label, create_time: Date.parse(t.created_at) },
            ["24"],
          ],
          status: { status_str: t.status_str, messages: [["execution_start", { timestamp: Date.parse(t.created_at) }], ["execution_success", { timestamp: Date.parse(t.created_at) + 1000 }]] },
          outputs: t.outputs,
        };
        // ComfyUI contract: key the wrapper by the prompt id.
        return send(200, { [id]: entry });
      }

      // 5) full history: FLAT map { [id]: entry } — gallery + usage consume this.
      if (req.method === "GET" && p === "/history") {
        const out = {};
        for (const [id, t] of tasks) {
          if (t.status_str !== "success") continue; // not finished yet
          out[id] = {
            prompt: [
              1,
              id,
              t.graph || {},
              { label: t.label, create_time: Date.parse(t.created_at) },
              ["24"],
            ],
            status: { status_str: t.status_str, messages: [["execution_success", { timestamp: Date.parse(t.created_at) + 1000 }]] },
            outputs: t.outputs,
          };
        }
        // Seeded gallery entries (pre-existing models).
        for (const s of gallerySeed) {
          out[s.id] = {
            prompt: [
              1,
              s.id,
              { "91": { class_type: "Trellis2ShapeStage", inputs: {} } },
              { label: s.label, create_time: Date.parse(s.created_at) },
              ["61"],
            ],
            status: { status_str: "success", messages: [["execution_success", { timestamp: Date.parse(s.created_at) + 5000 }]] },
            outputs: { "61": { images: [{ filename: "model.glb", subfolder: "3d", type: "output" }] } },
          };
        }
        return send(200, out);
      }

      // 6) binary output: /view?filename&subfolder&type
      if (req.method === "GET" && p === "/view") {
        const fn = u.searchParams.get("filename") || "";
        const isGlb = /\.glb$/i.test(fn);
        const bytes = isGlb
          ? Buffer.concat([Buffer.from("glTF"), Buffer.alloc(64, 0x42)]) // tiny valid-ish GLB
          : TINY_PNG_BYTES;
        res.writeHead(200, {
          "content-type": isGlb ? "model/gltf-binary" : "image/png",
          "content-length": bytes.length,
        });
        return res.end(bytes);
      }

      return send(404, { detail: `no mock route for ${req.method} ${p}` });
    } catch (e) {
      return send(500, { detail: "mock comfyui error: " + e.message });
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve({ url: `http://127.0.0.1:${a.port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// ---------------------------------------------------------------------------
// Assertions + harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed += 1;
    console.log(`  \u2713 ${name}${extra ? "  " + extra : ""}`);
  } else {
    failed += 1;
    console.log(`  \u2717 ${name}${extra ? "  " + extra : ""}`);
  }
}

async function main() {
  console.log("\n=== Trellis MCP smoke test (mock ComfyUI backend) ===\n");
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-smoke-"));
  console.log(`mock out dir: ${outDir}\n`);
  const mock = await startMockComfyUI();
  console.log(`mock ComfyUI up at ${mock.url}\n`);
  const client = new TrellisBridgeClient({ baseUrl: mock.url, fetchFn: globalThis.fetch });
  const ctx = { client, defaultOutDir: outDir };

  // 1) trellis_health
  console.log("1) trellis_health:");
  let r = await T.makeHealthTool(ctx).handler({});
  check("returns a text result", typeof r.content[0].text === "string");
  const h = dataOf(r);
  check("reports up=true", h.up === true, JSON.stringify({ up: h.up, model_loaded: h.model_loaded }));
  check(
    "app_script is comfyui",
    h.app_script === "comfyui",
    JSON.stringify({ app_script: h.app_script }),
  );
  check("exposes the model id", /TRELLIS/i.test(h.model_id || ""), h.model_id);

  // 2) trellis_start
  console.log("\n2) trellis_start:");
  r = await T.makeStartTool(ctx).handler({ wait_seconds: 30 });
  const st = dataOf(r);
  check("brings the service up", st.ok === true && st.up === true, JSON.stringify(st));

  // 3) trellis_image_to_3d (submit)
  console.log("\n3) trellis_image_to_3d (submit):");
  r = await T.makeImageTo3DTool(ctx).handler({
    image: TINY_PNG_DATAURL,
    resolution: 512,
    seed: 7,
    label: "a tiny test cube",
  });
  check("submit is not an error", !r.isError, r.isError ? r.content[0].text : "");
  const sub = dataOf(r);
  const taskId = sub.task_id;
  check("returns a task_id", typeof taskId === "string" && taskId.length > 0, "task_id=" + taskId);
  check("initial status is queued", (sub.status || "").toLowerCase() === "queued", "status=" + sub.status);

  // 4) trellis_task_status (poll x3 to advance)
  console.log("\n4) trellis_task_status (poll x3):");
  const statTool = T.makeTaskStatusTool(ctx);
  const transitions = [];
  for (let i = 1; i <= 3; i++) {
    r = await statTool.handler({ task_id: taskId });
    const rec = dataOf(r);
    transitions.push({ poll: i, status: rec.status, progress: rec.progress });
  }
  check(
    "progress advances across polls",
    (transitions[0].progress ?? 0) <= (transitions[transitions.length - 1].progress ?? 0),
    "states=" + transitions.map((t) => t.status).join(">"),
  );
  const finalRec = transitions[transitions.length - 1];
  check(
    "reaches a terminal ok state",
    ["completed", "succeeded"].includes((finalRec.status || "").toLowerCase()),
    "final=" + finalRec.status,
  );

  // 5) trellis_wait_task
  console.log("\n5) trellis_wait_task (resolves since done):");
  r = await T.makeWaitTool(ctx).handler({ task_id: taskId, timeout_seconds: 5 });
  check("wait resolves ok", !r.isError, r.isError ? r.content[0].text : "completed");

  // 6) trellis_download (GLB first-class; STL fallback path)
  console.log("\n6) trellis_download (GLB to disk):");
  const destGlb = path.join(outDir, taskId + ".glb");
  r = await T.makeDownloadTool(ctx).handler({ task_id: taskId, format: "glb", dest: destGlb });
  check("download is not an error", !r.isError, r.isError ? r.content[0].text : "");
  check(
    "the file was written",
    fs.existsSync(destGlb),
    "bytes=" + (fs.existsSync(destGlb) ? fs.statSync(destGlb).size : "n/a"),
  );
  if (fs.existsSync(destGlb)) {
    const head = fs.readFileSync(destGlb).subarray(0, 8).toString("latin1");
    check("payload is glTF-shaped (magic ok)", head.startsWith("glTF"), "head=" + JSON.stringify(head));
  }

  // 6b) the mock GLB is not a mesh, so STL conversion must fail instead of
  //     writing glTF bytes under an .stl name.
  console.log("\n6b) trellis_download (format stl refuses a non-mesh):");
  const destStl = path.join(outDir, taskId + ".stl");
  r = await T.makeDownloadTool(ctx).handler({ task_id: taskId, format: "stl", dest: destStl });
  check("fake glb is not reported as an STL", r.isError === true, r.isError ? "" : r.content[0].text.slice(0, 180));
  check("no stl file was left behind", !fs.existsSync(destStl));

  // 7) trellis_render_preview (clay, 4 frames)
  console.log("\n7) trellis_render_preview (solid, 4 frames):");
  r = await T.makeRenderTool(ctx).handler({ task_id: taskId, mode: "solid", nviews: 4 });
  check("render is not an error", !r.isError, r.isError ? r.content[0].text : "");
  const rend = dataOf(r);
  const frames = rend.frames ?? [];
  check("produced at least one frame", frames.length >= 1, "frames=" + frames.length);
  check("frame count is bounded by nviews", frames.length <= 4, "frames=" + frames.length);

  // 8) trellis_gallery
  console.log("\n8) trellis_gallery:");
  r = await T.makeGalleryTool(ctx).handler({ limit: 12 });
  const gal = dataOf(r);
  check("lists items", Array.isArray(gal.items) && gal.items.length > 0, "count=" + gal.items.length);
  check(
    "the just-made model is present",
    gal.items.some((i) => i.id === taskId),
    "contains_ours=" + gal.items.some((i) => i.id === taskId),
  );
  check(
    "items carry a label instead of an inlined thumbnail",
    gal.items.every((i) => i.thumbnail == null) && gal.items.some((i) => i.label === "a tiny test cube"),
    JSON.stringify(gal.items.map((i) => i.label)),
  );

  // 9) trellis_usage
  console.log("\n9) trellis_usage:");
  r = await T.makeUsageTool(ctx).handler({});
  const usage = dataOf(r);
  check(
    "reports a generated count",
    Number.isFinite(usage.total_generated) && usage.total_generated >= 1,
    "total_generated=" + usage.total_generated,
  );
  check(
    "last task is the one we made",
    usage.last_task_id === taskId,
    "last=" + usage.last_task_id,
  );

  console.log("\n9b) trellis_wait_task timeout_seconds is seconds:");
  const tWait = Date.now();
  r = await T.makeWaitTool(ctx).handler({ task_id: "stuck", timeout_seconds: 2 });
  const waited = Date.now() - tWait;
  check("explicit timeout is not treated as milliseconds", r.isError === true && /2s/.test(r.content[0].text) && waited >= 1500, r.content[0].text);

  console.log("\n9c) seed 0 is preserved; resolution only hits the upsample target:");
  const filled = fillImageTo3DWorkflow({ image: "x.png", resolution: 1536, seed: 0 });
  check("seed 0 stays 0 on the shared samplers", filled["18"].inputs.seed === 0 && filled["23"].inputs.seed === 0, JSON.stringify({ a: filled["18"].inputs.seed, b: filled["23"].inputs.seed }));
  check("1536 is the upsample target", filled["94"].inputs.target_resolution === 1536);
  check("crop stays 1024", filled["312"].inputs.width === 1024 && filled["312"].inputs.height === 1024);

  const views = buildSolidViewWorkflow({ modelFile: "m.glb", mode: "solid", nviews: 4, prefix: "3d/t" });
  const yaws = ["r0", "r1", "r2", "r3"].map((id) => views.workflow[id].inputs["mode.angle_y"]);
  check("four solid yaws are 0 90 180 270", JSON.stringify(yaws) === JSON.stringify([0, 90, 180, 270]), JSON.stringify(yaws));

  console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
  console.log("Artifacts written under: " + outDir);
  for (const f of fs.readdirSync(outDir).slice(0, 12)) console.log("   - " + f);
  mock.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke test crashed:", e);
  process.exit(2);
});
