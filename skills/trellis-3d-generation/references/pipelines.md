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

## PBR texturing / re-texturing

`trellis_texturize` — generate/refresh PBR textures (base color, roughness,
metallic, opacity) for a shape, from a reference image (optionally conditioned
on a base shape). Use to re-skin without re-running full image→3D. Returns a task to
wait on, then `trellis_download` a textured export.

## Decimation + remesh

`trellis_remesh_decimate` — cut a produced model to a **face budget**
(decimation) and/or **remesh** it (band / project) to clean up topology —
typical when preparing for 3D printing or to reduce file size. Pass a
`face_budget` (target face count), optional `remesh` + `remesh_band` /
`remesh_project`, and a `dest`. It returns the rewritten file path and
before/after face counts. Pair with `format: stl` for print-ready output.

## Choosing an export format

`trellis_download` with `format` (one task can produce several):

| Format | When to use it |
|---|---|
| **GLB** (first-class) | Keep full PBR (all maps, metallic/roughness/opacity). Default for viewing/animation/USD pipelines. |
| **STL** | 3D printing / casting / CNC — a plain watertight solid (geometry, no PBR). The "image→STL" path. |
| **OBJ** | Broad interchange (plus a material file where relevant). |
| **FBX** | Game-engine / DCC pipelines that expect FBX. |
| **USDZ** | AR / Apple-ecosystem handoff. |

If the user said "an STL for my printer/cast," download `format: stl` (and, if
they care about quality, decimate to a sensible face budget first via
`trellis_remesh_decimate`). If they want to keep it textured/interactive, GLB.
When in doubt about quality, note that a rendered preview shows appearance,
while STL/watertightness should be checked in their slicer/CAD for print.
