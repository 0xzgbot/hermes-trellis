# hermes-trellis — Trellis 3D for Hermes Agent

A **Hermes Agent plugin** that drives the local **Trellis.2** model (4B) on a
**DGX Spark** to turn an **image into a fully-textured 3D model** — and
export it as **GLB / STL / OBJ / FBX / USDZ**. It is the faithful analogue of the
**Meshy** plugin (MCP + Skill + desktop integration: rendered models in
chat, status bar, gallery) — but it uses **Trellis** (an open, local image→3D
model) instead of Meshy's proprietary cloud.

> **Why "another image→STL model":** Meshy is a cloud 3D service (you pay credits,
> it runs their model). Here the model runs **on your GPU** (Trellis.2), you
> own the whole pipeline, and the headline output for makers is an
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

```
Hermes agent (Mac)                          DGX Spark
┌────────────────────────────┐        ┌─────────────────────────────────────────┐
│ MCP server  (mcp/, Node/TS)  │  HTTP   │ REST bridge (docker/trellis-api, FastAPI)│
│   trellis_*  → TrellisBridge│  ──────▶│   /health /start /generate          │
│ Client  (bridge.ts)        │ :7861  │   /tasks/{id}[/download|render|remesh]   │
└───────────────┬──────────────┘        │   /texturize /gallery /usage        │
                  │                           │   wraps Trellis2ImageTo3DPipeline │
┌────────────────────────────┐        │   + o_voxel(GLB) + trimesh(STL/OBJ/..) │
│ Skill (skills/trellis-3d-   │        └─────────────────────────────────────────┘
│   generation) — how to use  │
└────────────────────────────┘
```

- **MCP server** (`mcp/`): Node/TS, stdio. A typed client to the bridge; registers the `trellis_*` tools. Runs **on the Mac** (next to Hermes).
- **Skill** (`skills/trellis-3d-generation/`): SKILL.md + references (setup, pipelines, delivery, troubleshooting). What the agent reads.
- **REST bridge** (`docker/trellis-api/`): FastAPI on the **DGX**, wrapping the *same* `Trellis2ImageTo3DPipeline` the Gradio app uses, plus task bookkeeping, GLB (o_voxel) + STL/OBJ/FBX/USDZ (trimesh) conversion, HDRI render, gallery, usage. Port **7861** (separate from Gradio **7860**).
- **Desktop plugin** (`desktop/plugin.py`): status bar, chat preview, gallery.

## Repo layout

```
hermes-trellis/
├── README.md                  # this file
├── INSTALL.md                   # full install (DGX + Mac + Hermes)
├── docker/
│   ├── Dockerfile               # build the bridge (over the Trellis base image)
│   ├── docker-compose.yml        # run bridge (:7861) [+ Gradio (:7860)]
│   └── trellis-api/             # the bridge (Python package)
│       ├── main.py              # FastAPI app + task bookkeeping + gallery/usage
│       ├── pipeline.py            # wraps Trellis2ImageTo3DPipeline (the model)
│       ├── convert.py              # GLB↔STL/OBJ/FBX/USDZ + decimation/remesh (trimesh)
│       ├── render.py               # HDRI render (frames / turntable)
│       └── store.py                # JSONL persistence (gallery + usage)
├── mcp/                           # MCP server (Node/TS)
│   ├── package.json / tsconfig.json
│   └── src/
│       ├── bridge.ts              # typed client to the DGX bridge
│       ├── tools.ts                 # the trellis_* tools (zod schemas + handlers)
│       └── index.ts               # stdio server, registers the tools
├── skills/trellis-3d-generation/
│   ├── SKILL.md                    # the skill (frontmatter + pipeline)
│   └── references/  setup.md · pipelines.md · delivery.md · troubleshooting.md
├── desktop/
│   ├── plugin.py                    # status bar, chat preview, gallery
│   └── README.md
├── examples/
│   ├── image_to_stl.md              # image → STL (print/cast)
│   └── image_to_glb.md              # image → GLB (keep PBR)
└── tests/
    └── smoke.mjs                     # end-to-end (mock bridge) — 22 checks
```

## Quick start

Full details in [`INSTALL.md`](INSTALL.md). Short version:

**1. On the DGX — bring up the bridge** (over your existing Trellis):
```bash
cd hermes-trellis/docker
docker compose up -d trellis_bridge          # builds + runs the bridge on :7861
curl -s localhost:7861/health                          # {"up":true,"model_loaded":false,...}
```

**2. On the Mac — build the MCP server:**
```bash
cd hermes-trellis/mcp && npm install && npm run build
node dist/index.js        # stdio MCP (talks to your DGX bridge - set TRELLIS_API_URL in config)
```

**3. Wire it into Hermes** — register the MCP server and load the skill:
```yaml
# ~/.hermes/config.yaml
mcp_servers:
  trellis:
    command: node
    args: ["~/code/hermes-trellis/mcp/dist/index.js"]
    env:
      TRELLIS_API_URL: "http://<DGX-TAILNET-IP>:7861"   # your DGX address
      TRELLIS_OUT_DIR: "~/code/hermes-trellis/trellis-out"
```
```bash
hermes skills install ~/code/hermes-trellis/skills/trellis-3d-generation   # load the skill
```

**4. Use it.** In chat:
> "Make a 3D model of this [image] at 1024, save the STL to ~/Desktop/bison.stl, and show me a clay render."

The agent: `trellis_health` → (start if down) → `trellis_image_to_3d` → `trellis_wait_task` → `trellis_remesh_decimate` → `trellis_download(stl)` → `trellis_render_preview(clay)` → shows `MEDIA:…clay_00.png` and the `.stl` path.

## Testing

Two tiers of real, executed checks:

- **MCP ↔ bridge contract (on the Mac, no GPU):** `tests/smoke.mjs` spins up an in-process mock of the DGX bridge and drives every tool end-to-end (health → start → submit → poll/wait → download → render → gallery → usage). **22/22 pass**, writing a real 256 B STL and 4 PNG frames to disk.
```bash
node tests/smoke.mjs
```
- **Conversion half (real files):** `docker/trellis-api/convert.py` exercised with real trimesh — a 128-face GLB → byte-exact binary STL (84 + 50×128 B), quadric decimate 128 → 16 faces (fast-simplification), OBJ export. `store.py` (JSONL persistence) and `render.py` (fallback frames) behavior-tested. The FastAPI app imports cleanly with all 15 routes registered.

The **model half** (Trellis.2 actually generating the mesh) runs only on the DGX GPU; the plumbing + conversion around it are what's proven here.

## Configuration (env)

| Var | Where | Meaning | Default |
|---|---|---|---|
| `TRELLIS_API_URL` | Mac | Bridge base URL | `http://127.0.0.1:7861` (set to your DGX URL) |
| `TRELLIS_OUT_DIR` | Mac | Where downloads/renders land | `<cwd>/trellis-out` |
| `TRELLIS_MODEL_ID` | DGX | The 3D model id ("other models" knob) | `microsoft/TRELLIS.2-4B` |
| `HF_TOKEN` | DGX | Gated-model access (DINOv3, RMBG-2.0) | — |
| `TRELLIS_BRIDGE_OUT` | DGX | Bridge output root | `<pkg>/out` |

## License

MIT.
