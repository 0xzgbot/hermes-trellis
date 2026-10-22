# Setup

What must exist on the **DGX Spark** so the `trellis_*` tools work, and how to
turn the service on/off and configure it. The Mac only needs Node (for
the MCP server) and reachability to the DGX.

## Components

1. **ComfyUI 0.42 runtime on the DGX** — the standard ComfyUI at
   `http://<DGX>:8188` with the **Trellis-2 node classes** installed:
   `Trellis2Conditioning · Trellis2ShapeStage · Trellis2TextureStage ·
   Trellis2UpsampleStage · VaeDecodeStructureTrellis2 · VaeDecodeShapeTrellis ·
   VaeDecodeTextureTrellis · EmptyTrellis2LatentStructure · VoxelToMesh ·
   UNETLoader · VAELoader · KSampler · RenderMesh · SaveGLB · SaveImage`.
   The weights are **local safetensors** the graph loads by filename —
   `trellis_2_int8_convrot.safetensors` (UNet), `trellis_2_shape_vae_bf16.safetensors`,
   `trellis_2_texture_vae_bf16.safetensors`, `dino_v3_L_naf_fp32.safetensors`
   (CLIP-vision), `birefnet.safetensors` (background removal). This is the **only
   DGX component the plugin needs** — it speaks ComfyUI's standard API and
   manages nothing itself.

2. **(Optional) the legacy REST bridge on the DGX** — a FastAPI app
   (`docker/trellis-api`, port **7861**) wrapping the same pipeline with
   `/health`, `/start`, `/generate`, `/tasks/{id}`, …
   `TRELLIS_BACKEND=bridge` selects it; the default is
   `TRELLIS_BACKEND=comfyui` (standard ComfyUI :8188).

3. **(Optional) the Gradio web app** on **:7860** (`app.py`, or
   `app_texturing.py` for PBR) — a human UI; not required by the tools.

4. **MCP server + skill on the Mac** (this repo) and the Hermes config entry.

## DGX prerequisites

- **ComfyUI 0.42** with the Trellis-2 node classes (see Components §1).
- **The weights present** as local safetensors in the ComfyUI model dirs (see
  Components §1) — the graph loads them by filename, so no HF token or download
  step is needed for this runtime.
- **A `.env`** with:
  - `UID` / `GID` — your host user/group (for sane file ownership).
  - (Only if you run the legacy bridge / Gradio app) `HF_TOKEN` for any
    HF-downloaded weights — the ComfyUI path above does not need it.

## Starting / stopping the service

The Trellis runtime is **started on demand** (it is not usually resident, to
free the GPU for LLM serving). The convenience tools handle both backends:

- **`trellis_health`** — reports whether the runtime is up and whether the
  model is loaded (ComfyUI: `model_loaded` flips on the first workflow).
- **`trellis_start`** — brings the runtime up and waits until healthy; the
  first model load takes a while, so surface the result (`up`, `model_loaded`)
  to the user. On ComfyUI, this just confirms the API is answering — the
  pipeline loads per-workflow on the first `/api/prompt`.
- **GPU contention:** loading/run Trellis occupies the GPU. If you run LLM
  serving (e.g. TensorFold) on the same box, coordinate — surface to the user
  that starting Trellis may slow or preempt other work, and that a stopped
  Trellis frees that memory.

## Configuration (env vars)

On the **Mac** (for the MCP server):

| Var | Meaning | Default |
|---|---|---|
| `TRELLIS_API_URL` | Runtime base URL (ComfyUI default). | `http://127.0.0.1:8188` |
| `TRELLIS_BACKEND` | `comfyui` (default, standard ComfyUI) or `bridge` (legacy FastAPI :7861). | `comfyui` |
| `TRELLIS_BRIDGE_URL` | Legacy bridge base (`http://<DGX>:7861`); only when backend=bridge. | `http://127.0.0.1:7861` |
| `TRELLIS_OUT_DIR` | Where downloads/renders land when no path is given. | `<repo>/mcp/trellis-out` |

On the **DGX** (for ComfyUI): the upstream ComfyUI/Trellis setup
(CUDA version, `HF_TOKEN`, weights, node classes) — see the ComfyUI
documentation; the plugin does not install or manage ComfyUI itself.

## Registering in Hermes

Once the MCP server is built (`mcp/dist/index.js`) and the skill is in place:

- Add an MCP server entry to **`~/.hermes/config.yaml`** (the *main* profile
  config) pointing at the built server (command = `node`, args = the built
  `index.js`), with the env above.

  > **Put it in the MAIN profile config, not a per-profile one.** The agent and
  > the desktop app load `~/.hermes/config.yaml`; an entry written only under
  > `~/.hermes/profiles/<name>/config.yaml` is invisible to them, so the
  > `trellis_*` tools silently never register (the failure mode this repo hit).
  > Prefer `hermes config set mcp_servers.trellis.<field> <value> --force` —
  > direct writes to `config.yaml` are refused by the guard.
- **Restart the agent** after editing the config: MCP servers are connected at
  startup, so a running agent keeps its old tool set. Kill the gateway agent
  (the desktop app respawns it) rather than only reloading the UI.
- Install/load the skill (`trellis-3d-generation`) so the agent knows the
  pipeline and the "service state first" rule.

Verify with `trellis_health` (should report up; `model_loaded` becomes true on
the first workflow), then a tiny `trellis_image_to_3d` + `trellis_download`
as a round-trip.
