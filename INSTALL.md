# INSTALL — Trellis print plugin for Hermes Agent

One photo in, a binary STL out. The GPU work runs on a machine that already
has ComfyUI and Trellis.2. Hermes, the MCP server, and the STL file run on
the computer you chat from (the Mac, in this setup).

No cloud API and no subscription. The plugin does not start or stop ComfyUI.

## Where each step runs

| Step | Machine | Why |
|---|---|---|
| Trellis.2 image → textured GLB | GPU host, ComfyUI `:8188` | The Mac has no GPU. The weights and the 63-node graph live there. |
| Four solid views (`RotateMesh`, `RenderMesh`) | Same GPU host | A few seconds on the GPU. The plugin uploads the GLB and reads the PNGs back. |
| STL, OBJ, decimate, scale, hole fill | The Hermes machine | ComfyUI has no STL node. The GLB is already on this machine, and the path you asked for (`~/Desktop/part.stl`) is here too. Sending the mesh back to the GPU to run trimesh would upload it again and download it again. |
| The agent | The Hermes machine | It calls the `trellis_*` tools. It does not SSH to the GPU host. |

`trellis_start` does not boot ComfyUI. If health is down, start ComfyUI yourself on the GPU host.

## 0. Prerequisites

| Where | Needed | Check |
|---|---|---|
| GPU host | ComfyUI **0.42** and the Trellis.2 nodes | `curl -s localhost:8188/system_stats` shows `comfyui_version` `0.42.0` |
| GPU host | Local weights: `trellis_2_int8_convrot.safetensors`, `trellis_2_shape_vae_bf16.safetensors`, `trellis_2_texture_vae_bf16.safetensors`, `dino_v3_L_naf_fp32.safetensors`, `birefnet.safetensors` | `GET /object_info` lists `Trellis2ShapeStage`, `SaveGLB`, `RenderMesh`, `RotateMesh` |
| Hermes machine | Node **≥ 18** | `node -v` |
| Hermes machine | Python with `trimesh`. Face budgets also need `fast-simplification` | `python -c "import trimesh"` |
| Hermes machine | Reachability to the GPU host | `curl -s http://<DGX-TAILNET-IP>:8188/system_stats` |

The Gradio app on `:7860` is a separate UI. This plugin talks to ComfyUI on `:8188`.

## 1. GPU host — ComfyUI already running

The plugin only calls the API. It does not install weights or manage the process.

Nodes the print path uses:

- Generation: `Trellis2Conditioning`, `Trellis2ShapeStage`, `Trellis2UpsampleStage`, `Trellis2TextureStage`, `VaeDecodeStructureTrellis2`, `VaeDecodeShapeTrellis`, `VaeDecodeTextureTrellis`, `EmptyTrellis2LatentStructure`, `VoxelToMesh`, `SaveGLB`
- Preview: `Load3DAdvanced`, `Get3DComponents`, `RotateMesh`, `RenderMesh`, `SaveImage`

Confirm from the GPU host:

```bash
curl -s localhost:8188/system_stats | head -c 300
```

`model_loaded` in `trellis_health` stays false. ComfyUI loads Trellis weights on the first `/api/prompt` and does not report a resident-model flag.

## 2. Hermes machine — MCP server and mesh tools

```bash
cd hermes-trellis/mcp
npm install
npm run build          # writes dist/  (dist/ is gitignored)
npm run typecheck      # optional
```

Python for STL and decimation. Use whatever interpreter has trimesh, and point the server at it:

```bash
python3 -m pip install 'trimesh' 'fast-simplification'
# confirm
python3 -c "import trimesh, fast_simplification; print(trimesh.__version__)"
python3 print_mesh.py self-test
```

`self-test` builds a box, scales its longest axis to 100 mm, and checks `size == 84 + 50 * faces`.

Without `fast-simplification`, a download with `face_budget` fails and names that package. The STL is still written if you omit the budget.

Mock test, no GPU:

```bash
cd hermes-trellis
node tests/smoke.mjs
# 29 passed, 0 failed
```

The mock refuses to save a non-mesh as `.stl`. It does not prove a Spark generation.

## 3. Hermes — register the server and the skill

Put this in the **main** config, `~/.hermes/config.yaml`. An entry that exists only under `~/.hermes/profiles/<name>/config.yaml` never registers. Prefer `hermes config set … --force`. Direct writes are refused by the guard.

```yaml
mcp_servers:
  trellis:
    command: sh
    args: ["/absolute/path/to/hermes-trellis/mcp/run.sh"]
    env:
      TRELLIS_API_URL: "http://<DGX-TAILNET-IP>:8188"
      TRELLIS_BACKEND: "comfyui"
      TRELLIS_PYTHON: "/absolute/path/to/python"   # the interpreter from step 2
      TRELLIS_OUT_DIR: "/absolute/path/to/trellis-out"
```

`TRELLIS_PYTHON` defaults to `python3` on the MCP server's `PATH`. `TRELLIS_OUT_DIR` defaults to `<cwd>/trellis-out`.

```bash
hermes skills install /absolute/path/to/hermes-trellis/skills/trellis-3d-generation
```

Restart the gateway agent after the config change. MCP servers connect at startup. Reloading the UI is not enough.

```text
hermes skills list     # trellis-3d-generation
hermes tools list      # trellis_health, trellis_image_to_3d, …
```

A first chat turn: "Check Trellis health." Up means ComfyUI answered. `busy: true` means `/queue` has a running job. Down means ComfyUI is not running. Start it on the GPU host. Do not expect `trellis_start` to do that.

## 3b. Install as a Hermes plugin package

The repo is also an Agent Plugin (`plugin.json`, `mcp.json`) plus a desktop half (`desktop/plugin.js`) and a file API (`dashboard/plugin_api.py`).

```bash
# from a checkout, so Desktop reloads when desktop/plugin.js changes
ln -s /absolute/path/to/hermes-trellis ~/.hermes/plugins/trellis
hermes plugins enable trellis
```

Then in Desktop: Capabilities → Plugins → enable the Trellis desktop half, and Rescan if the orbit card does not appear. Settings → Plugins → Trellis holds the ComfyUI URL, the Python path, and the output folder.

`mcp.json` starts `mcp/run.sh`. If `dist/index.js` is missing, that script runs `npm install` and `npm run build` once. Node and npm must be on `PATH`.

With the desktop half on, the agent puts this in its own paragraph after a download:

```text
::trellis-model{glb="/absolute/model.glb" stl="/absolute/model.stl"}
```

That card orbits the GLB. The status chip reads ComfyUI through `/api/plugins/trellis/status`. `trellis_wait_task` and `trellis_render_preview` emit MCP progress notifications while the Spark job runs. `provenance.json` in the output folder records the photo path, seed, resolution, STL path, face count, and watertight flag.

## 4. Desktop status script (no UI)

`desktop/plugin.py` reads `/system_stats`, `/queue`, and `/history`. It does not generate and it does not render. Preview PNGs come from `trellis_render_preview` and are shown with `MEDIA:<path>`.

```bash
TRELLIS_API_URL=http://<DGX-TAILNET-IP>:8188 python desktop/plugin.py
```

A live ComfyUI prints `running: True` and a count of Trellis history rows. Hook names for the desktop SDK are in `desktop/README.md`.

## 5. A real print

On the GPU host, ComfyUI is up. On the Hermes machine:

> "Make a printable STL of this photo, as much detail as possible, 10 cm tall, and show me four solid views."

The agent should:

1. `trellis_health`
2. `trellis_image_to_3d` (resolution changes the upsample target only; crop and UV stay at 1024)
3. `trellis_wait_task` (`timeout_seconds` is seconds)
4. `trellis_download` format `glb`
5. `trellis_render_preview` mode `solid`, `nviews` 4 — four PNGs, four different sha256 values
6. `trellis_download` format `stl` with `face_budget`, `height_mm`, and `repair`

The STL report includes face count, extents, and watertight before and after repair. Open it in the slicer. The solid views show shape, not manifold status.

There is no text-to-3D on this ComfyUI (no text checkpoint). A request with no photo gets a request for a photo. Rigging and animation are out of scope.
