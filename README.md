# hermes-trellis — Trellis 3D for Hermes Agent

A **Hermes Agent plugin** that drives the local **Trellis.2** model (4B) on a
**DGX Spark** to turn an **image into a fully-textured 3D model** — and
**export it as GLB** (the server's native output), with **STL for print/cast**
produced by a local GLB→STL conversion. It is the faithful analogue of the
**Meshy** plugin (MCP + Skill + desktop integration: rendered models in
chat, status bar, gallery) — but it runs **Trellis** (an open, local image→3D
model) instead of Meshy's proprietary cloud.

The GPU host runs Trellis.2 and the four solid views. The Hermes machine
runs the agent, the MCP server, and trimesh. ComfyUI writes a GLB. `trellis_download`
with `format: "stl"` converts that GLB on the Hermes machine and checks
`size == 84 + 50 * faces`. There is no `TRELLIS_MODEL_ID` switch. The graph
loads `trellis_2_int8_convrot.safetensors` by name.

## What it gives you

| Feature | Detail |
|---|---|
| **Image → 3D** | One conditioning image → a textured 3D asset. The core (Trellis has no text-to-3D / multi-view). |
| **PBR texturing** | Baked into image→3D. `trellis_texturize` re-runs that job. It does not recolor an existing GLB. |
| **Decimation** | Local trimesh (`trellis_remesh_decimate`). Default 200k faces. Hole fill when `remesh` is true. |
| **Export** | **GLB** from ComfyUI. **STL** and **OBJ** via local trimesh. The STL byte size is checked. FBX and USDZ are refused. |
| **Print preview** | Four solid `RenderMesh` views (0/90/180/270). Modes: auto, texture, vertex colors, solid, normal, depth. |
| **Task mgmt** | Submit (async) → poll / wait → download. Long GPU jobs without blocking chat. |
| **Gallery** | Trellis runs only, newest first, with label and time. No inlined textures. Pictures come from `trellis_render_preview`. |
| **Usage** | Count of those runs, real GPU seconds from ComfyUI timestamps, newest task. Not a credit balance. |
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
│   /view · /upload/image    │        │  image → /api/prompt → /view GLB            │
│   print_mesh.py (trimesh)  │        │  then Load3D + RenderMesh for 4 solid views │
└───────────────┬──────────────┘        └─────────────────────────────────────────┘
                │ GLB bytes come back; STL is written here
                ▼
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
├── mcp/
│   ├── print_mesh.py                # trimesh STL, decimate, scale, repair
│   ├── package.json / tsconfig.json
│   └── src/
│       ├── bridge.ts                # ComfyUI client
│       ├── workflow-image-to-3d.ts  # image→3D graph
│       ├── workflow-render.ts       # four solid views
│       ├── print-mesh.ts            # spawns print_mesh.py
│       ├── tools.ts
│       └── index.ts
├── skills/trellis-3d-generation/
│   ├── SKILL.md                    # the skill (frontmatter + pipeline)
│   └── references/  setup.md · pipelines.md · delivery.md · troubleshooting.md
├── desktop/
│   ├── plugin.py                    # status bar, chat preview, gallery
│   └── README.md
├── tests/
│   └── smoke.mjs                     # mock ComfyUI suite (no GPU)
```

## Quick start

Full details in [`INSTALL.md`](INSTALL.md). Short version:

**1. On the DGX — have ComfyUI 0.42 with Trellis.2 ready** (`~40 GB` weights):
```bash
# ComfyUI 0.42.0 with the Trellis-2 node classes (the plugin speaks the standard
# endpoints below; it does not run or manage ComfyUI itself).
# Weights (local safetensors the graph loads by filename, no HF token):
#   trellis_2_int8_convrot.safetensors (UNet)
#   trellis_2_shape_vae_bf16.safetensors / trellis_2_texture_vae_bf16.safetensors
#   dino_v3_L_naf_fp32.safetensors (CLIP-vision) / birefnet.safetensors (bg removal)
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
      TRELLIS_API_URL: "http://<DGX-TAILNET-IP>:8188"
      TRELLIS_PYTHON: "/absolute/path/to/python"   # trimesh [+ fast-simplification]
      TRELLIS_OUT_DIR: "/absolute/path/to/trellis-out"
```
```bash
hermes skills install /absolute/path/to/hermes-trellis/skills/trellis-3d-generation
```

**4. Use it.** In chat:
> *"Make a printable STL of this photo at 1024, 10 cm tall, about 20k faces, and show me four solid views."*

The agent: `trellis_health` → `trellis_image_to_3d` on the GPU host →
`trellis_wait_task` → download the GLB → `trellis_render_preview` (four solid
views, also on the GPU host) → `trellis_download` format `stl` on this machine.

## Testing

Two tiers of real, executed checks:

- **MCP ↔ ComfyUI contract (on the Mac, no GPU):** `tests/smoke.mjs` spins up
  an in-process mock of the ComfyUI API and drives the print tools. A fake GLB must not be saved as an STL. `mcp/print_mesh.py self-test` checks a real box mesh.
  ```bash
  cd hermes-trellis && node tests/smoke.mjs
  ```
- **STL byte check:** `TRELLIS_PYTHON=/path/to/python mcp/print_mesh.py self-test` builds a box, scales its longest axis to 100 mm, and checks `size == 84 + 50 * faces`.

The **model half** (Trellis.2 actually generating the mesh) runs only on the
DGX GPU; the plumbing around it is what's proven here.

## Configuration (env)

| Var | Where | Meaning | Default |
|---|---|---|---|
| `TRELLIS_API_URL` | Mac | Runtime base URL (ComfyUI default). | `http://127.0.0.1:8188` |
| `TRELLIS_BACKEND` | Mac | Front the MCP client drives: `comfyui` (default, standard ComfyUI :8188) or `bridge` (legacy FastAPI :7861). | `comfyui` |
| `TRELLIS_BRIDGE_URL` | Mac | Legacy bridge base (`http://<DGX>:7861`); only used when backend=bridge. | `http://127.0.0.1:7861` |
| `TRELLIS_PYTHON` | Mac | Python used for STL/OBJ. It must import trimesh. | `python3` |
| `TRELLIS_OUT_DIR` | Mac | Where downloads/renders land when the caller omits a path. | `<cwd>/trellis-out` |

> Dual-backend note: the ComfyUI transport is the default and the only one the
> plugin ships with in `dist/`. The legacy FastAPI bridge keeps working behind
> `TRELLIS_BACKEND=bridge` for existing docker deployments.

## Troubleshooting index

- **`health` down / ECONNREFUSED** → the runtime isn't answering at the
  configured URL; point `TRELLIS_API_URL` at the right host/port. ComfyUI
  `:8188`, legacy bridge `:7861` — don't mix them up.
- **404 on `/api/prompt` or `/upload/image`** → not pointing at ComfyUI
  (backend=comfyui); the runtime may have been restarted with different ports.
- **`model_loaded` is false while jobs succeed** → expected. ComfyUI does not
  report a resident Trellis flag. `busy` comes from `/queue`.
- **`trellis_start` did not boot ComfyUI** → it only checks `/system_stats`.
  Start ComfyUI on the GPU host.
- **OOM at 1536** → drop to 1024 or 512, or free the GPU.
- **`fast-simplification` missing** → `face_budget` fails. Install it in
  `TRELLIS_PYTHON`, or omit the budget and slice the full mesh.
- **STL is geometry only** → open it in the slicer. The tool reports watertight.

## Relationship to the Meshy plugin

`hermes-trellis` is a local print pipeline. The official Meshy plugin
(`@meshy-ai/meshy-mcp-server@0.6.5`) is a cloud service with text-to-3D,
rigging, and animation. This plugin does none of those. It needs a photo.
There is no text checkpoint on the ComfyUI install this was built against,
so the agent asks for an image instead of inventing one.

## License

MIT.
