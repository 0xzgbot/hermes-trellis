# hermes-trellis — Trellis 3D for Hermes Agent

A **Hermes Agent plugin** that drives the local **Trellis.2** model (4B) on a
**DGX Spark** to turn an **image into a fully-textured 3D model** — and
export it as **GLB / STL / OBJ / FBX / USDZ**. It is the faithful analogue of the
**Meshy** plugin (MCP + Skill + desktop integration: rendered models in
chat, status bar, gallery) — but it runs **Trellis** (an open, local image→3D
model) instead of Meshy's proprietary cloud.

> **Why "another image→STL model":** Meshy is a cloud 3D service (you pay
> credits, it runs their model). Here the model runs **on your GPU** (Trellis.2),
> you own the whole pipeline, and the headline output for makers is an
> **STL** (print/cast). Swap the model by pointing `TRELLIS_MODEL_ID` at a
> different image→3D checkpoint that speaks the same pipeline.

## What it gives you

| Feature | Detail |
|---|---|
| **Image → 3D** | One conditioning image → a textured 3D asset. The core (Trellis has no text-to-3D / multi-view). |
| **PBR texturing** | Generate / re-generate base color, roughness, metallic, opacity for a shape. |
| **Decimation + remesh** | Cut to a face/vertex budget, clean topology (print-ready). |
| **Export** | **GLB** (full PBR, first-class), **STL** (solid), OBJ, FBX, USDZ. |
| **HDRI render preview** | Frames / turntable under neutral, clay, base-color, or forest/sunset/courtyard lighting. |
| **Task mgmt** | Submit (async) → poll / wait → download. Long GPU jobs without blocking chat. |
| **Gallery** | Every model you've made (thumbnails, labels, timestamps), survives restarts. |
| **Usage / "credits"** | How many models, ~GPU-seconds, last task — local "cost" framing. |
| **MCP tools** | 11 `trellis_*` tools (health, start, image_to_3d, task_status, wait, download, render, texturize, remesh, gallery, usage). |
| **Skill** | `trellis-3d-generation` teaches the agent the pipeline, service-state-first rule, and delivery. |
| **Desktop integration** | Rendered preview in chat (`MEDIA:`), status bar, gallery panel. |

## Architecture

The **runtime is standard ComfyUI 0.42** on the DGX (`:8188`); the Trellis.2
node classes are installed inside it, and this plugin drives it through
**ComfyUI's standard endpoints** — no bespoke bridge to maintain.

```text
Hermes agent (Mac)                          DGX Spark
┌────────────────────────────┐        ┌─────────────────────────────────────────┐
│ MCP server  (mcp/, Node/TS)  │  HTTP   │ ComfyUI 0.42 @ :8188                     │
│   trellis_*  → TrellisBridge│  ──────▶│  Trellis.2 nodes (image→3D pipeline):    │
│ Client  (bridge.ts)        │        │  Trellis2Conditioning · ShapeStage ·       │
│   fill image→3D workflow   │        │  UpsampleStage · VaeDecode*Trellis ·       │
│   (upload + POST /api/     │        │  UpsampleStage · VoxelToMesh · SaveGLB/    │
│    prompt)                 │        │  SaveImage + RenderMesh).                   │
│   /history/{id} (unwrap)   │        │                                          │
│   /view · /upload/image    │        │  one job = upload image → fill graph →       │
└───────────────┬──────────────┘        │  POST /api/prompt → wait → /view files     │
                │                        │  (GLB + preview PNG) → export/download     │
                ▼                        └─────────────────────────────────────────┘
        skills/trellis-3d-generation   ← how the agent uses the tools

Optional legacy front (kept for existing docker-bridge deployments):
  docker/trellis-api  FastAPI on :7861, selected with TRELLIS_BACKEND=bridge
```

- **MCP server** (`mcp/`): Node/TS, stdio. A typed client to the runtime;
  registers the `trellis_*` tools. Runs **on the Mac** (next to Hermes).
- **Skill** (`skills/trellis-3d-generation/`): SKILL.md + references (setup,
  pipelines, delivery, troubleshooting). What the agent reads.
- **ComfyUI runtime** (`:8188`): the *only* DGX component this plugin needs.
  `Trellis.2` must be installed there (see `INSTALL.md` § DGX).
- **Desktop plugin** (`desktop/plugin.py` + `desktop/README.md`):
  status bar, in-chat preview, gallery — mirrors the Meshy desktop integration.

## Repo layout

```
hermes-trellis/
├── README.md                  # this file
├── INSTALL.md                   # full install (DGX + Mac + Hermes)
├── docker/                          # (optional legacy bridge — kept, not required)
├── mcp/                           # MCP server (Node/TS)
│   ├── package.json / tsconfig.json
│   └── src/
│       ├── bridge.ts              # typed client → ComfyUI (default)  / legacy bridge
│       ├── workflow-image-to-3d.ts  # the image→3D ComfyUI graph template
│       ├── tools.ts                 # the trellis_* tools
│       └── index.ts               # stdio server, registers the tools
├── skills/trellis-3d-generation/
│   ├── SKILL.md                    # the skill (frontmatter + pipeline)
│   └── references/  setup.md · pipelines.md · delivery.md · troubleshooting.md
├── desktop/
│   ├── plugin.py                    # status bar, chat preview, gallery
│   └── README.md
├── tests/
│   └── smoke.mjs                     # 24/24 end-to-end mock suite (no GPU)
```

## Quick start

Full details in [`INSTALL.md`](INSTALL.md). Short version:

**1. On the DGX — have ComfyUI 0.42 with Trellis.2 ready** (`~40 GB` weights):
```bash
# ComfyUI 0.42.0 with the Trellis-2 node classes (the plugin speaks the standard
# endpoints below; it does not run or manage ComfyUI itself).
# Weights: microsoft/TRELLIS.2-4B (+ dinov3_vitl for background removal).
# Optional: keep docker/trellis-api as a second runtime on :7861, enabled via
#           TRELLIS_BACKEND=bridge (legacy; the plugin defaults to comfyui).
```
The plugin expects the ComfyUI API at `http://<DGX-TAILNET-IP>:8188` (see
`Configuration` below).

**2. On the Mac — build the MCP server:**
```bash
cd hermes-trellis/mcp
npm install && npm run build     # tsc → dist/
npm run typecheck                # optional: strict re-check
```

**3. Wire it into Hermes** — register the MCP server and load the skill:
```yaml
# ~/.hermes/config.yaml
mcp_servers:
  trellis:
    command: node
    args: ["/absolute/path/to/hermes-trellis/mcp/dist/index.js"]
    env:
      TRELLIS_API_URL: "http://<DGX-TAILNET-IP>:8188"   # ComfyUI (default :8188)
      TRELLIS_OUT_DIR: "/absolute/path/to/hermes-trellis/trellis-out"
```
```bash
hermes skills install /absolute/path/to/hermes-trellis/skills/trellis-3d-generation
```

**4. Use it.** In chat:
> *"Make a 3D model of this [image] at 1024, save the STL to
> ~/Desktop/bison.stl, and show me a clay render."*

The agent: `trellis_health` → `trellis_start` if down → `trellis_image_to_3d`
→ `trellis_wait_task` → `trellis_download(stl)` → `trellis_render_preview(clay)`
→ shows `MEDIA:` preview and the `.stl` path.

## Testing

Two tiers of real, executed checks:

- **MCP ↔ ComfyUI contract (on the Mac, no GPU):** `tests/smoke.mjs` spins up
  an in-process mock of the ComfyUI API (`/system_stats`, `/upload/image`,
  `/api/prompt`, `/history/{id}` wrapper, `/history`, `/view`) and drives every
  tool end-to-end. **24/24 pass**, writing real glTF/PNG bytes to disk.
  ```bash
  cd hermes-trellis && node tests/smoke.mjs
  ```
- **Conversion half (real files, on the DGX or a local venv):** `docker/trellis-api/convert.py`
  is exercised with real trimesh — a 128-face GLB → byte-exact binary STL
  (84 + 50×128 B), quadric decimate, OBJ export. `store.py`/render behavior
  tested there.

The **model half** (Trellis.2 actually generating the mesh) runs only on the
DGX GPU; the plumbing around it is what's proven here.

## Configuration (env)

| Var | Where | Meaning | Default |
|---|---|---|---|
| `TRELLIS_API_URL` | Mac | Runtime base URL (ComfyUI default). | `http://127.0.0.1:8188` |
| `TRELLIS_BACKEND` | Mac | Front the MCP client drives: `comfyui` (default, standard ComfyUI :8188) or `bridge` (legacy FastAPI :7861). | `comfyui` |
| `TRELLIS_BRIDGE_URL` | Mac | Legacy bridge base (`http://<DGX>:7861`); only used when backend=bridge. | `http://127.0.0.1:7861` |
| `TRELLIS_OUT_DIR` | Mac | Where downloads/renders land when the caller omits a path. | `<repo>/mcp/trellis-out` |

> Dual-backend note: the ComfyUI transport is the default and the only one the
> plugin ships with in `dist/`. The legacy FastAPI bridge keeps working behind
> `TRELLIS_BACKEND=bridge` for existing docker deployments.

## Troubleshooting index

- **`health` down / ECONNREFUSED** → the runtime isn't answering at the
  configured URL; point `TRELLIS_API_URL` at the right host/port. ComfyUI
  `:8188`, legacy bridge `:7861` — don't mix them up.
- **404 on `/api/prompt` or `/upload/image`** → not pointing at ComfyUI
  (backend=comfyui); the runtime may have been restarted with different ports.
- **Model not loaded** → `model_loaded` flips to true on the first
  `/api/prompt` (each workflow loads the Trellis.2 UNet/VAEs). Give the first
  model a quiet window to load.
- **OOM at 1536** → drop to 1024/512, or free GPU (stop LLM serving).
- **Decimation no-op** → install `fast-simplification` / match trimesh API.
- **STL export is only geometry** → STL is derived from the final GLB; for
  print/cast, open the STL in a slicer/CAD to check watertightness.

## Relationship to the Meshy plugin

`hermes-trellis` is the **local, model-owning counterpart** of the official
Meshy plugin (`@meshy-ai/meshy-mcp-server@0.6.4` in
`NousResearch/hermes-official-plugins`): same Hermes MCP + Skill + Desktop
shape, same catalog plugin entry shape, but the runtime is yours (Trellis.2 on
your DGX) and credit-free. Obvious deltas, stated when asked: Meshy ships
text→3D, multi-view, rig/animations and a print pipeline; Trellis.2 here is
**image-conditioned** and **3D-only** — the agent will generate a conditioning
image first if given a description. Both coexist in the same Hermes install.

## License

MIT.
