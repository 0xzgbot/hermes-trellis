# Troubleshooting

Symptom → likely cause → fix. Read when something failed or looked
odd. Most failures are environmental (service down, GPU busy, missing
dep/token), not the model.

## Service / reachability

| Symptom | Cause | Fix |
|---|---|---|
|| `trellis_health` says **down / unreachable** (ECONNREFUSED/timeout) | The ComfyUI runtime isn't answering at `TRELLIS_API_URL` — commonly stopped to free the GPU | Call `trellis_start` (confirms the runtime then waits until healthy). Tell the user it needs the GPU. |
|| Runtime reachable but `model_loaded=false`, job stalls | Model not yet loaded for this workflow — on ComfyUI the Trellis.2 UNet/VAEs are loaded per `/api/prompt` | `trellis_start` with `wait_seconds`; the first workflow of a session is the slow one (weights + DINOv3), later workflows reuse it. |
|| `404` on `/api/prompt` | Talking to the wrong endpoint (e.g. the ComfyUI *dashboard* or the legacy bridge at :7861) | Set `TRELLIS_API_URL` to the **ComfyUI base** (`:8188`, default) — not the Gradio UI, not the legacy bridge. |
|| `404` on `/upload/image` | `TRELLIS_BACKEND=bridge` was intended but the DGX never ran the legacy FastAPI | Switch `TRELLIS_BACKEND` to `bridge` (and `TRELLIS_BRIDGE_URL` if not :7861) or rebuild the runtime with the ComfyUI frontend installed. |

## Startup failures (`trellis_start` does not come up)

| Symptom | Cause | Fix |
|---|---|---|
| Load fails / "pipeline load failed" | The graph references a model file the DGX does not have (e.g. the naive `trellis2_4B.safetensors` / `dinov3_vitl` / `RMBG-2.0`), or a node input name is wrong | Confirm the exact filenames + inputs from `GET /object_info` (see Pipelines → "The graph the server expects"); the proven template is `mcp/src/workflow-image-to-3d.ts`. |
| `trellis_*` tools not callable at all | The MCP entry is in a **per-profile** config the agent doesn't load, or the agent wasn't restarted after the config change | Put the entry in `~/.hermes/config.yaml` (main profile) and restart the gateway agent (see Setup → "Registering in Hermes"). |
| Load fails: CUDA/flash-attn/nvdiffrast errors | Wrong CUDA toolkit / missing compiled dep in the env | Use the env the upstream setup built (`setup.sh --flash-attn --nvdiffrast --cumesh --o-voxel --flexgemm`). Match the CUDA version (e.g. 12.9). Rebuild the env. |

## GPU / resource

| Symptom | Cause | Fix |
|---|---|---|
| Job OOM / "out of memory" at high resolution | Not enough unified memory at `1536³` (esp. with LLM serving also resident) | Drop to `1024` or `512` (faster + less memory). If you must go `1536`, reduce concurrent work (stop LLM serving). Use `expandable_segments:True`. |
| Slow generation / contends with LLM | Trellis and LLM serving (e.g. TensorFold) fighting for the GPU | Coordinate: generate when LLM load is low, or accept longer waits. Mention the contention to the user. Consider generating in batches. |

## Conversion / export

| Symptom | Cause | Fix |
|---|---|---|
| `415 format ... not available` | Requested a format the task can't produce | This server exports **GLB only** — download `format="glb"`, then convert to STL locally (Pipelines → "GLB → printable binary STL"). |
| Download fails / task `409 not complete` | Tried to download before the task finished | Wait (`trellis_wait_task`) until `completed`, then download. |
| `trellis_remesh_decimate` 404s | That tool targets the **legacy bridge** backend, not the default `comfyui` one | Decimate locally with trimesh (Pipelines → "GLB → printable binary STL"). |
| `trimesh not installed` (STL conversion) | Missing conversion dep on the **Mac** (not the bridge env) | `pip install trimesh[easy]` in the Mac venv used for the conversion (e.g. `/tmp/trev`). |

## Inputs / images

| Symptom | Cause | Fix |
|---|---|---|
| `conditioning image not found` | Local path wrong, or a URL the DGX couldn't fetch | Use an absolute path (on the host), a reachable `http(s)` URL, or a `data:` URL. For local files, they are base64-shipped to the DGX. |
| Oversized `data:` URL | Huge base64 image | Pre-shrink the image (e.g. ≤1024px, JPEG) before sending. |

## General

- **Read the tool's error text first** — it usually names the cause (HTTP code, exception, path).
- **Re-run `trellis_health`** after any fix to confirm the state changed before retrying the job.
- **GPU is the scarce resource** — treat generation as costed, and prefer stopping Trellis when not in use.
- If two different fixes both seem to work, keep the **simplest** one and note the assumption.
