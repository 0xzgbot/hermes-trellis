# Troubleshooting

Read the tool error first. It names the HTTP status or the Python exception.

## Reachability

| Symptom | Cause | Fix |
|---|---|---|
| `trellis_health` is down | ComfyUI is not answering at `TRELLIS_API_URL` | Start ComfyUI on the GPU host. `trellis_start` only repeats the check. |
| `busy: true` | `/queue` has a running prompt | Wait. Do not submit another generation. |
| `model_loaded: false` while a job is running or has finished | ComfyUI does not report a resident-model flag | Ignore the flag. Weights load on the first `/api/prompt`. |
| `404` on `/api/prompt` or `/upload/image` | `TRELLIS_API_URL` is the Gradio UI or the legacy bridge | Point it at ComfyUI `:8188`. |

## Generation

| Symptom | Cause | Fix |
|---|---|---|
| `prompt_outputs_failed_validation` | A node input or weight filename does not match this ComfyUI | Use the shipped graph in `mcp/src/workflow-image-to-3d.ts`. Do not hand-write slot names. |
| Tools never appear | MCP entry is in a per-profile config, or the agent was not restarted | Main `~/.hermes/config.yaml`, then restart the gateway. |
| CUDA / flash-attn / nvdiffrast error on the GPU host | The ComfyUI environment is missing a compiled dependency | Fix that environment. The plugin does not rebuild it. |
| OOM at 1536 | The upsample target is 1536 while other work shares the GPU | Use 1024 or 512. Crop and UV stay at 1024 either way. |

## STL and decimate

| Symptom | Cause | Fix |
|---|---|---|
| `Set TRELLIS_PYTHON` / `No module named trimesh` | The MCP process's Python has no trimesh | Install trimesh in that interpreter, or set `TRELLIS_PYTHON` to one that has it. |
| `fast-simplification` | `face_budget` was set and that package is missing | `pip install fast-simplification` in `TRELLIS_PYTHON`, or omit `face_budget`. |
| FBX or USDZ refused | Those formats are not implemented | Download GLB or STL. |
| Watertight is false after `repair: true` | Hole fill did not close the mesh | Say so. The slicer may still accept it. Do not claim it is manifold. |
| Four view hashes are identical | The turntable did not change the yaw | Treat the preview as failed. Do not describe it as four angles. |

## Images

| Symptom | Cause | Fix |
|---|---|---|
| Conditioning image not found | The path is not on the Hermes machine | Pass an absolute path, an `http(s)` URL, or a `data:` URL. The MCP server uploads the bytes to ComfyUI. |
| Huge data URL | The photo was inlined at full size | Shrink it to about 1024 px before the tool call. |
