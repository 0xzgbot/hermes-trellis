# Setup

What must exist on the **DGX Spark** so the `trellis_*` tools work, and how to
turn the service on/off and configure it. The Mac only needs Node (for
the MCP server) and reachability to the DGX.

## Components

1. **Trellis runtime on the DGX** — the `Trellis2ImageTo3DPipeline`
   (`microsoft/TRELLIS.2-4B`) on the GPU, plus `o_voxel` (GLB export), `render_utils`
   (HDRI previews), and `trimesh` (STL/OBJ/FBX/USDZ conversion). Typically the
   `dr-vij/Trellis2-DGX-Spark-Docker` stack (Docker, GPU=all) or an `raziel2001au/dgx-trellis2`
   conda env.
2. **The REST "bridge" on the DGX** — a small FastAPI app (port, e.g. **7861**) that wraps
   the same pipeline and exposes `/health`, `/start`, `/generate`,
   `/tasks/{id}`, `/tasks/{id}/download?format=`, `/tasks/{id}/render`,
   `/gallery`, `/usage`. This is what the MCP client (on the Mac) talks to.
3. **(Optional) the Gradio web app** on **:7860** (`app.py`, or
   `app_texturing.py` for PBR) — for a human UI; not required by the tools.
4. **MCP server + skill on the Mac** (this repo) and the Hermes config entry.

## DGX prerequisites

- **Docker** (Engine + Compose v2 + NVIDIA Container Toolkit) if using the
  Docker stack; or a **conda** env if using `dgx-trellis2`.
- **A `.env`** with:
  - `HF_TOKEN` — a Hugging Face token that has **access granted** to the gated
    models the pipeline needs (`facebook/dinov3` and `briaai/RMBG-2.0`); request access
    on those model pages (approval can take a while).
  - `UID` / `GID` — your host user/group (for sane file ownership).
  - optionally `APP_SCRIPT` (`app.py` or `app_texturing.py`), `GRADIO_SERVER_PORT`.
- **The model weights cached** — `microsoft/TRELLIS.2-4B` in the HF cache
  (`HF_HOME`). First run downloads; ensure enough free disk (tens of GB).
- **Python deps for the bridge** — `fastapi`, `uvicorn`, `trimesh` (and its loaders),
  plus whatever the pipeline needs (`torch`, `o_voxel`, `flash-attn`, `nvdiffrast`,
  `cumesh`, `o_voxel`, `flexgemm` — per the upstream README).

## Starting / stopping the service

The Trellis runtime is **started on demand** (it is not usually resident, to
free the GPU for LLM serving). Two ways:

- **Automatically (recommended):** the first call that needs it — or an
  explicit **`trellis_start`** — brings it up (docker compose / python app) and
  waits until healthy. The `trellis_health` tool tells you whether it's up and
  whether the model is loaded before you commit to a job.
- **Manually (on the DGX):** `docker compose up -d` (Trellis) and start the bridge
  (e.g. `uvicorn ...:app --host 0.0.0.0 --port 7861`). Stop with `docker compose down`.

> **GPU contention:** loading/run Trellis occupies the GPU. If you run LLM
> serving (e.g. TensorFold) on the same box, coordinate — surface to the user
> that starting Trellis may slow or preempt other work, and that a stopped
> Trellis frees that memory.

## Configuration (env vars)

On the **Mac** (for the MCP server):

| Var | Meaning | Default |
|---|---|---|
| `TRELLIS_API_URL` | Base URL of the DGX bridge REST front | `http://127.0.0.1:7861` (set to your DGX URL) |
| `TRELLIS_OUT_DIR` | Where downloads/renders land when no path is given | `<cwd>/trellis-out` |
| `TRELLIS_TIMEOUT_MS` | Per-request timeout to the bridge | `20000` |
| `TRELLIS_MODEL_ID` | The 3D model id (for "other models") | `microsoft/TRELLIS.2-4B` |

On the **DGX** (for the bridge/Trellis): see the upstream README (CUDA version,
`HF_TOKEN`, `ATTN_BACKEND`, cache dirs, Gradio port).

## Registering in Hermes

Once the MCP server is built (`mcp/dist/index.js`) and the skill is in place:

- Add an MCP server entry to `~/.hermes/config.yaml` pointing at the built server
  (command = `node`, args = the built `index.js`), with the env above.
- Install/load the skill (`trellis-3d-generation`) so the agent knows the pipeline
  and the "service state first" rule.

Verify with `trellis_health` (should report up/model_loaded), then a tiny
`trellis_image_to_3d` + `trellis_download` as a round-trip.
