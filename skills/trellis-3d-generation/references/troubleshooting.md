# Troubleshooting

Symptom → likely cause → fix. Read when something failed or looked
odd. Most failures are environmental (service down, GPU busy, missing
dep/token), not the model.

## Service / reachability

| Symptom | Cause | Fix |
|---|---|---|
| `trellis_health` says **down / unreachable** (bridge ECONNREFUSED/timeout) | Trellis bridge not running (common — stopped to free GPU) | Call `trellis_start` (brings it up + waits). If it does not come up, see below. Tell the user it needs the GPU. |
| Bridge reachable but `model_loaded=false`, generation stalls | Model not yet loaded into GPU memory (first use) | `trellis_start` with `wait_seconds`; the first load is slow (downloads/loads weights). Subsequent jobs reuse it. |
| `HTTP 404` / wrong port | Talking to the wrong port (Gradio :7860 vs bridge :7861) or host | Set `TRELLIS_API_URL` to the **bridge** URL (`:7861`), not the Gradio UI. Confirm the container exposes it (0.0.0.0). |

## Startup failures (`trellis_start` does not come up)

| Symptom | Cause | Fix |
|---|---|---|
| Load fails / "pipeline load failed" | Missing **HF token** or no **access granted** to gated models (DINOv3, RMBG-2.0); weights not downloaded | On the DGX: put a valid `HF_TOKEN` in `.env` and request access on `facebook/dinov3` + `briaai/RMBG-2.0` model pages. Ensure `microsoft/TRELLIS.2-4B` is in the HF cache (`HF_HOME`). Restart. |
| Load fails: CUDA/flash-attn/nvdiffrast errors | Wrong CUDA toolkit / missing compiled dep in the env | Use the env the upstream setup built (`setup.sh --flash-attn --nvdiffrast --cumesh --o-voxel --flexgemm`). Match the CUDA version (e.g. 12.9). Rebuild the env. |

## GPU / resource

| Symptom | Cause | Fix |
|---|---|---|
| Job OOM / "out of memory" at high resolution | Not enough unified memory at `1536³` (esp. with LLM serving also resident) | Drop to `1024` or `512` (faster + less memory). If you must go `1536`, reduce concurrent work (stop LLM serving). Use `expandable_segments:True`. |
| Slow generation / contends with LLM | Trellis and LLM serving (e.g. TensorFold) fighting for the GPU | Coordinate: generate when LLM load is low, or accept longer waits. Mention the contention to the user. Consider generating in batches. |

## Conversion / export

| Symptom | Cause | Fix |
|---|---|---|
| `415 format ... not available` | Requested a format the task can't produce | Use one of `glb/stl/obj/fbx/usdz`. GLB is always available (the native output). |
| Download fails / task `409 not complete` | Tried to download before the task finished | Wait (`trellis_wait_task`) until `completed`, then download. |
| `trimesh not installed` (conversion) | Missing conversion dep in the bridge env | `pip install trimesh[easy]` (and Pillow) in the bridge env. |
| Decimation error / no change | Missing `fast-simplification`, or the trimesh version's API differs | `pip install fast-simplification` (a version matching the Python). The built-in decimation is lower quality. Verify the mesh face count actually dropped. |

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
