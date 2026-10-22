# Pipelines

Concrete recipes for the things Trellis actually does. Pick the shortest one
that gets the requested result; these are examples to adapt, not a mandatory
sequence.

## Image → 3D (the core)

`trellis_image_to_3d` — submit a single conditioning image and get a task id.

| Param | What it does | Good defaults |
|---|---|---|
| `image` | Conditioning image (path / URL / data-URL). | A clear, well-lit single subject. Pre-shrink huge data-URLs. |
| `resolution` | Target 3D resolution bucket: `512` / `1024` / `1536`. Higher = sharper but slower + more GPU. | `1024` (balanced). `512` for quick/draft; `1536` when you have time + memory. |
| `seed` / `randomize_seed` | Fixed seed reproduces a model; randomize varies it. | Fix a seed to iterate deterministically; randomize to explore. |
| `label` | Tag/prompt stored in the gallery for this model. | Short human description (used by the gallery). |
| `ss_*` / `shape_*` / `tex_*` | Tuning the sparse-structure / shape / texture samplers (steps, guidance strength/rescale). | Leave at the model's defaults unless you need finer control (more steps + guidance ≈ sharper; fewer/looser ≈ softer/faster). |

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

## PBR texturing / re-texturing

`trellis_texturize` — generate/refresh PBR textures (base color, roughness,
metallic, opacity) for a shape, from a reference image (optionally conditioned
on a base shape). Use to re-skin without re-running full image→3D. Returns a task to
wait on, then `trellis_download` a textured export.

## Decimation + remesh

`trellis_remesh_decimate` targets the **legacy bridge** backend only
(`POST /tasks/:id/remesh`) — on the default **`comfyui`** backend there is no such
endpoint, so the call fails. To prepare a model for printing/size, decimate
**locally** (see "GLB → printable binary STL" below).

## Choosing an export format

**The server emits GLB only** (`SaveGLB`, full PBR — the native output). This
ComfyUI has **no STL/OBJ/FBX/USDZ nodes**: `trellis_download(format=...)` can only
return GLB here, and any other `format` falls back to the GLB. So:

| Format | How to get it |
|---|---|
| **GLB** (first-class) | `trellis_download(format="glb")` — full PBR, native output. |
| **STL** | Download the GLB, then convert **locally** (recipe below). |
| OBJ / FBX / USDZ | **Not available** on this runtime — convert the GLB in a DCC/exchange tool if needed. |

If the user said "an STL for my printer/cast," download the GLB and convert it
locally. If they want to keep it textured/interactive, deliver the GLB as-is.
When in doubt about quality, note that a rendered preview shows appearance,
while STL/watertightness should be checked in their slicer/CAD for print.

## GLB → printable binary STL (local trimesh conversion — no GPU)

The generation run emits a **GLB**; a printer wants a **binary STL** (pure
geometry). Do the conversion **on the Mac**, offline — no Spark round-trip.

Recipe (a venv with `trimesh`, e.g. `/tmp/trev/bin/python`):

```python
import trimesh, struct
src, dst = "/path/to/hermes_model.glb", "/path/to/hermes_model.stl"
m = trimesh.load(src, force="mesh")          # a Scene? concatenate its meshes
print("faces", len(m.faces), "watertight", m.is_watertight)
if len(m.faces) > 200_000:                   # optional: decimate to print-friendly
    m = m.simplify_quadric_decimation(face_count=200_000)
m.export(dst, file_type="stl")               # trimesh STL writer is BINARY by default
b = open(dst, "rb").read()
fc = struct.unpack("<I", b[80:84])[0]        # VERIFY the binary-STL byte math
assert len(b) == 84 + 50*fc, (len(b), fc)
print("OK faces", fc, "bytes", len(b), "watertight", m.is_watertight)
```

Caveats:
- **Binary-STL layout**: 80-byte header + LE u32 face count + 50 bytes/face ⇒
  `filesize == 84 + 50·face_count`. trimesh's `stl` writer is binary by default.
- **`force="mesh"`** collapses a single-mesh `Scene`; for a multi-part asset,
  iterate `scene.geometry.values()` and `trimesh.util.concatenate`.
- **Watertight is often `False`** on fresh Trellis output — usually slices fine,
  but state the flag explicitly rather than calling the mesh clean.
- **Units/scale**: the mesh lives in ComfyUI's normalized space (observed extent
  ≈ 0.4–0.5 per axis). The STL inherits those units; the user sets the real size
  in the slicer (e.g. scale to 10–15 cm). Offer to pre-scale to exact mm.
