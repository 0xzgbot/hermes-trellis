# Pipelines

Concrete recipes for the things Trellis actually does. Pick the shortest one
that gets the requested result; these are examples to adapt, not a mandatory
sequence.

## Image → 3D (the core)

`trellis_image_to_3d` — submit a single conditioning image and get a task id.

| Param | What it does | Good defaults |
|---|---|---|
| `image` | Conditioning image (path / URL / data-URL). | A clear, well-lit single subject. Pre-shrink huge data-URLs. |
| `resolution` | Voxel resolution of the upsample stage. `1536` is the maximum. | Leave unset. The server defaults to `1536`. |
| `seed` / `randomize_seed` | Fixed seed reproduces a model; randomize varies it. | Fix a seed to iterate deterministically; randomize to explore. |
| `label` | Tag/prompt stored in the gallery for this model. | Short human description (used by the gallery). |
| `label` | Stored on the ComfyUI prompt and returned by the gallery. | Short name of the print. |

Flow: submit → `trellis_wait_task` (or `trellis_task_status`) until done → `trellis_download`.

### The graph the server expects (do not guess node names)

The shipped template (`mcp/src/workflow-image-to-3d.ts`) is **regenerated from a
proven `/history` run**, because the live ComfyUI 0.42 + Trellis-2 node pack uses
different input names and model filenames than the naive assumptions:

| Naive guess | What the server wants |
|---|---|
| `sampler` / `latent` | `sampler_name` / `latent_image` (KSampler) |
| `filename` | `filename_prefix` (SaveGLB / SaveImage) |
| `clip` | `clip_vision_model` (Trellis2Conditioning) |
| `model` | `bg_removal_model` (RemoveBackground) |
| `batch` | `batch_size` (EmptyTrellis2LatentStructure) |
| `image` / `pad` | `images` / `masks` / `pad_factor` (ImageCropToMask) |

Model files (loaded by filename from the DGX ComfyUI dirs, **no HF token**):
`trellis_2_int8_convrot.safetensors` (UNet), `trellis_2_shape_vae_bf16.safetensors`,
`trellis_2_texture_vae_bf16.safetensors`, `dino_v3_L_naf_fp32.safetensors` (CLIP-vision),
`birefnet.safetensors` (background removal), plus `moge_2_vitl_normal_fp16` and
`pixal3d_int8_convrot` for the conditioning paths.

**If you ever hand-build a graph, pull each class's exact inputs from
`GET /object_info`** rather than assuming — a wrong input name yields
`400 {"error":{"type":"prompt_outputs_failed_validation"}}`, which looks like a
body bug but is a schema mismatch.

## Texturing

Texture is baked inside `trellis_image_to_3d`. `trellis_texturize` re-runs that whole job. It cannot recolor a GLB you already have. Do not pass `shape_src`.

## Decimation

`trellis_remesh_decimate` keeps every face unless `face_budget` is set. `remesh: true` fills holes. `remesh_band` and `remesh_project` are ignored.

## Choosing an export format

ComfyUI writes a GLB (`SaveGLB`). STL and OBJ are produced on the Hermes
machine by `mcp/print_mesh.py`. FBX and USDZ return an error. A requested STL
is never a GLB with a new extension.

| Format | Call |
|---|---|
| GLB | `trellis_download(format="glb")` |
| STL | `trellis_download(format="stl", height_mm=100)` with no `face_budget` |
| OBJ | `trellis_download(format="obj")` |

`height_mm` scales the longest axis to that many millimeters. `repair: true`
fills holes when the mesh is open, then reports watertight again. `face_budget`
needs `fast-simplification` in `TRELLIS_PYTHON`. The tool checks
`size == 84 + 50 * faces` before it returns an STL.

Do not hand-roll the trimesh script for a normal print. The tool already does it.
A manual check, if you are debugging the helper:

```bash
python mcp/print_mesh.py self-test
python mcp/print_mesh.py convert --src model.glb --dest model.stl --format stl --height-mm 100 --repair
```
