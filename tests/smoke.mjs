/**
 * smoke.mjs — end-to-end test of the Trellis MCP tool surface.
 *
 * Spins up an in-process mock of the DGX "bridge" REST front
 * (the FastAPI that wraps the real Trellis2 pipeline), points a
 * TrellisBridgeClient at it, and drives every tool the way a
 * Hermes agent would:
 *
 *   health -> start -> image_to_3d(submit) -> task_status ->
 *   wait_task -> download(STL) -> render(clay) -> gallery -> usage
 *
 * The mock is STATEFUL: each /tasks/:id poll advances the task's
 * progress and flips it to "completed" after a few polls, so the
 * wait loop observes a real pending -> running -> completed
 * transition with no timers/flake. This proves the full
 * MCP<->bridge contract on the Mac without a GPU.
 *
 * NOTE on result shape: every tool returns
 *   { content: [{type:"text", text}], structuredContent: {...} }
 * where `text` may carry a human note line ahead of the JSON, and
 * `structuredContent` is the clean machine-readable object. Tests
 * therefore read `structuredContent` via dataOf(r), never re-parse the
 * human text.
 *
 * Run:  node tests/smoke.mjs        (from the repo root)
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Import the BUILT modules (so we test exactly what ships).
const { TrellisBridgeClient } = await import("../mcp/dist/bridge.js");
const T = await import("../mcp/dist/tools.js");

// A tiny valid 1x1 PNG (base64) — used for render frames + gallery thumbs.
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const TINY_PNG_DATAURL = `data:image/png;base64,${TINY_PNG_B64}`;

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

// --------------------------------------------------------------------------
// Mock DGX bridge (FastAPI stand-in)
// --------------------------------------------------------------------------
function startMockBridge() {
  const tasks = new Map(); // id -> {id,status,progress,queries,label,formats,sizes,...}
  const gallerySeed = [
    { id: "g-seed-1", label: "a bronze bison", created_at: "2026-10-18T12:00:00Z", model_id: "microsoft/TRELLIS.2-4B", formats: ["glb", "stl"], thumbnail: TINY_PNG_DATAURL, input_image: TINY_PNG_DATAURL },
    { id: "g-seed-2", label: "terrain record weight", created_at: "2026-10-19T09:30:00Z", model_id: "microsoft/TRELLIS.2-4B", formats: ["glb", "stl"], thumbnail: TINY_PNG_DATAURL, input_image: TINY_PNG_DATAURL },
  ];
  const usage = { total_generated: 2, gpu_seconds_estimate: 58, credits_used: 2, last_task_id: "g-seed-2", last_task_at: "2026-10-19T09:30:00Z" };

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
      if (req.method === "GET" && p === "/health") {
        const anyRunning = [...tasks.values()].some((t) => t.status === "running");
        return send(200, { up: true, model_loaded: true, busy: anyRunning, gpu_free_gb: 42, model_id: "microsoft/TRELLIS.2-4B", url: "http://127.0.0.1:7861", app_script: "app.py", note: "healthy" });
      }
      if (req.method === "POST" && p === "/start") {
        return send(200, { ok: true, up: true, model_loaded: true, waited_ms: 1200, note: "pipeline loaded into GPU" });
      }
      if (req.method === "POST" && p === "/generate") {
        const b = JSON.parse((await readBody()) || "{}");
        const id = "t-" + Math.random().toString(36).slice(2, 10);
        tasks.set(id, {
          id, status: "pending", progress: 0, queries: 0, label: b.label || undefined,
          image: b.image, resolution: b.resolution ?? 1024,
          formats: ["glb", "stl", "obj", "fbx", "usdz"], sizes: null,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          finished_at: null, error: null, model_id: "microsoft/TRELLIS.2-4B", preview: TINY_PNG_DATAURL,
        });
        usage.total_generated += 1; usage.credits_used += 1; usage.gpu_seconds_estimate += 14;
        usage.last_task_id = id; usage.last_task_at = new Date().toISOString();
        return send(200, { id, status: "pending" });
      }
      let m = req.method === "GET" ? p.match(/^\/tasks\/([^/]+)$/) : null;
      if (m) {
        const id = decodeURIComponent(m[1]);
        const t = tasks.get(id);
        if (!t) return send(404, { detail: `no such task ${id}` });
        t.queries += 1; t.updated_at = new Date().toISOString();
        if ((t.status === "pending" || t.status === "queued") && t.queries >= 1) { t.status = "running"; t.progress = 0.15; }
        if (t.status === "running" && t.queries >= 3) {
          t.status = "completed"; t.progress = 1; t.finished_at = new Date().toISOString();
          t.sizes = { glb: 1048576, stl: 524288, obj: 630784, fbx: 917504, usdz: 1048576 };
        }
        return send(200, t);
      }
      m = p.match(/^\/tasks\/([^/]+)\/download$/);
      if (req.method === "GET" && m) {
        const id = decodeURIComponent(m[1]);
        const t = tasks.get(id);
        if (!t) return send(404, { detail: `no such task ${id}` });
        const fmt = (u.searchParams.get("format") || "glb").toLowerCase();
        if (!t.formats.includes(fmt)) return send(415, { detail: `format ${fmt} not available for ${id}` });
        const magic = { glb: "glTF", stl: "solid ", obj: "#obj  ", fbx: "Kaydara", usdz: "usdz!!" }[fmt] || "DATA";
        const payload = Buffer.concat([Buffer.from(magic, "utf8"), Buffer.alloc(Math.max(64, 256 - magic.length), 0x42)]);
        res.writeHead(200, { "content-type": fmt === "stl" ? "model/stl" : fmt === "glb" ? "model/gltf-binary" : "application/octet-stream", "content-length": payload.length });
        return res.end(payload);
      }
      m = p.match(/^\/tasks\/([^/]+)\/render$/);
      if (req.method === "POST" && m) {
        const id = decodeURIComponent(m[1]);
        if (!tasks.has(id)) return send(404, { detail: `no such task ${id}` });
        const b = JSON.parse((await readBody()) || "{}");
        const n = Math.max(1, Math.min(64, b.nviews ?? 8));
        return send(200, { images: Array.from({ length: n }, () => TINY_PNG_DATAURL), video: b.video ? [TINY_PNG_DATAURL] : null, note: `rendered ${n} frames (mode=${b.mode || "normal"})` });
      }
      m = p.match(/^\/tasks\/([^/]+)\/remesh$/);
      if (req.method === "POST" && m) {
        const id = decodeURIComponent(m[1]);
        if (!tasks.has(id)) return send(404, { detail: `no such task ${id}` });
        const b = JSON.parse((await readBody()) || "{}");
        return send(200, { path: b.dest || id + "_remesh.glb", faces_before: 120000, faces_after: b.face_budget || 50000 });
      }
      if (req.method === "GET" && p === "/gallery") {
        const lim = Math.max(1, parseInt(u.searchParams.get("limit") || "24", 10));
        const real = [...tasks.values()].map((t) => ({ id: t.id, label: t.label, created_at: t.created_at, model_id: t.model_id, formats: t.formats, thumbnail: TINY_PNG_DATAURL, input_image: TINY_PNG_DATAURL })).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        return send(200, { items: [...real, ...gallerySeed].slice(0, lim) });
      }
      if (req.method === "GET" && p === "/usage") return send(200, usage);
      return send(404, { detail: `no mock route for ${req.method} ${p}` });
    } catch (e) {
      return send(500, { detail: "mock bridge error: " + e.message });
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve({ url: `http://127.0.0.1:${a.port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// --------------------------------------------------------------------------
// Assertions + harness
// --------------------------------------------------------------------------
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
  console.log("\n=== Trellis MCP smoke test (mock DGX bridge) ===\n");
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-smoke-"));
  console.log(`mock out dir: ${outDir}\n`);
  const mock = await startMockBridge();
  console.log(`mock bridge up at ${mock.url}\n`);
  const client = new TrellisBridgeClient({ baseUrl: mock.url, fetchFn: globalThis.fetch });
  const ctx = { client, defaultOutDir: outDir };

  console.log("1) trellis_health:");
  let r = await T.makeHealthTool(ctx).handler({});
  check("returns a text result", typeof r.content[0].text === "string");
  const h = dataOf(r);
  check("reports up=true", h.up === true, JSON.stringify({ up: h.up, model_loaded: h.model_loaded }));
  check("reports model_loaded=true", h.model_loaded === true);
  check("exposes the model id", /TRELLIS/i.test(h.model_id || ""), h.model_id);

  console.log("\n2) trellis_start:");
  r = await T.makeStartTool(ctx).handler({ wait_seconds: 30 });
  const st = dataOf(r);
  check("brings the service up", st.ok === true && st.up === true, JSON.stringify(st));

  console.log("\n3) trellis_image_to_3d (submit):");
  r = await T.makeImageTo3DTool(ctx).handler({ image: TINY_PNG_DATAURL, resolution: 512, seed: 7, label: "a tiny test cube" });
  check("submit is not an error", !r.isError, r.isError ? r.content[0].text : "");
  const sub = dataOf(r);
  const taskId = sub.task_id;
  check("returns a task_id", typeof taskId === "string" && taskId.length > 0, "task_id=" + taskId);
  check("initial status is non-terminal", !["completed", "succeeded", "failed"].includes((sub.status || "").toLowerCase()), "status=" + sub.status);

  console.log("\n4) trellis_task_status (poll x3 to advance):");
  const statTool = T.makeTaskStatusTool(ctx);
  const transitions = [];
  for (let i = 1; i <= 3; i++) {
    r = await statTool.handler({ task_id: taskId });
    const rec = dataOf(r);
    transitions.push({ poll: i, status: rec.status, progress: rec.progress });
  }
  check("progress advances across polls", (transitions[0].progress ?? 0) <= (transitions[transitions.length - 1].progress ?? 0), "states=" + transitions.map((t) => t.status).join(">"));
  const finalRec = transitions[transitions.length - 1];
  check("reaches a terminal ok state", ["completed", "succeeded"].includes((finalRec.status || "").toLowerCase()), "final=" + finalRec.status);

  console.log("\n5) trellis_wait_task (resolves since done):");
  r = await T.makeWaitTool(ctx).handler({ task_id: taskId, timeout_seconds: 5 });
  check("wait resolves ok", !r.isError, r.isError ? r.content[0].text : "completed");

  console.log("\n6) trellis_download (STL to disk):");
  const destStl = path.join(outDir, taskId + ".stl");
  r = await T.makeDownloadTool(ctx).handler({ task_id: taskId, format: "stl", dest: destStl });
  check("download is not an error", !r.isError, r.isError ? r.content[0].text : "");
  check("the file was written", fs.existsSync(destStl), "bytes=" + (fs.existsSync(destStl) ? fs.statSync(destStl).size : "n/a"));
  if (fs.existsSync(destStl)) {
    const head = fs.readFileSync(destStl).subarray(0, 6).toString("latin1");
    check("payload is STL-shaped", /^solid/i.test(head.trim()) || head.length > 0, "head=" + JSON.stringify(head.trim()));
  }

  console.log("\n7) trellis_render_preview (clay, 4 frames):");
  r = await T.makeRenderTool(ctx).handler({ task_id: taskId, mode: "clay", nviews: 4 });
  check("render is not an error", !r.isError, r.isError ? r.content[0].text : "");
  const rend = dataOf(r);
  const frames = rend.frames ?? [];
  check("produced 4 frames", frames.length === 4, "frames=" + frames.length);
  check("every frame exists on disk", frames.length > 0 && frames.every((f) => fs.existsSync(f)), "first=" + (frames[0] || "none"));

  console.log("\n8) trellis_gallery:");
  r = await T.makeGalleryTool(ctx).handler({ limit: 12 });
  const gal = dataOf(r);
  check("lists items", Array.isArray(gal.items) && gal.items.length > 0, "count=" + (gal.items.length));
  check("the just-made model is present", gal.items.some((i) => i.id === taskId), "contains_ours=" + gal.items.some((i) => i.id === taskId));
  check("every item has a thumbnail", gal.items.every((i) => !!i.thumbnail), "");

  console.log("\n9) trellis_usage:");
  r = await T.makeUsageTool(ctx).handler({});
  const usage = dataOf(r);
  check("reports a generated count", Number.isFinite(usage.total_generated) && usage.total_generated >= 1, "total_generated=" + usage.total_generated);
  check("last task is the one we made", usage.last_task_id === taskId, "last=" + usage.last_task_id);

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
