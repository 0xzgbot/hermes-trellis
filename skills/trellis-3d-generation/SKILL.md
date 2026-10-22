---
name: trellis-3d-generation
description: "Turn one photo into a printable binary STL with local Trellis.2 on ComfyUI. No cloud API, no subscription, no rigging, no animation. Use when the user wants a 3D print from an image."
license: MIT
---

# Trellis print pipeline

Use the `trellis_*` tools to turn one photo into a binary STL on the user's GPU. Completion means the STL is on disk, four solid views have been looked at, and the report states path, bytes, face count, extents, and watertight before and after repair.

This is a print tool. Refuse rigging, animation, and any request to send the mesh to a paid 3D API. There is no text-to-3D: if the user has only a description, ask for a photo.

## Service

1. Call `trellis_health`.
2. If it is down, tell the user ComfyUI has to be started on the GPU machine. `trellis_start` only checks that the API answers. It does not boot the service.
3. If `busy` is true, wait. Do not submit a second generation.

## Make the print

1. `trellis_image_to_3d` with the photo. Leave resolution unset, or pass `1536`. That is the maximum. The graph samples 50 steps per stage, remeshes at 1536, and keeps about 1,000,000 faces. Seed `0` is valid. Do not pass `512` or `1024` unless the user explicitly wants a draft.
2. `trellis_wait_task` until it completes. Pass `timeout_seconds` in seconds.
3. `trellis_download` the GLB. That file is the source mesh, not the slicer file.
4. `trellis_render_preview` with `mode: "solid"` and `nviews: 4`. Show the frames with `MEDIA:<path>`. Four identical hashes mean the turntable failed. Look at the shape. Do not call a broken silhouette ready to print.
5. `trellis_download` with `format: "stl"`, the path the user asked for, and `height_mm` when they named a size. Do not pass `face_budget` unless they asked for a smaller file. Omitting it keeps the dense mesh. Use `repair: true` only after the solid views look right. The tool checks `size == 84 + 50 * faces`. A file that starts with `glTF` is not an STL.
6. Report path, bytes, face count, extents, watertight before and after repair, and the four view paths.
7. On its own paragraph, emit the card the download tool returns, for example `::trellis-model{glb="/absolute/model.glb" stl="/absolute/model.stl"}`. The desktop plugin orbits the GLB when that plugin is enabled.
8. If the user wants the slicer, call `trellis_open_slicer` with the STL path. It opens OrcaSlicer, PrusaSlicer, or BambuStudio when one of those apps is installed.

`trellis_remesh_decimate` is the same local decimate when the user wants a new GLB instead of an STL. `remesh_band` and `remesh_project` do nothing.

`trellis_texturize` is not a texture pass. Texture is already in the image-to-3D job. Calling it starts another full generation. Do not use it to recolor an existing mesh.

## Formats

| Ask | Do |
|---|---|
| GLB | `trellis_download` format `glb` |
| STL for a printer | GLB, then format `stl` with face budget, height, and repair |
| OBJ | format `obj`, local trimesh |
| FBX, USDZ, rig, animation | Say those are not in this plugin |

Set `TRELLIS_PYTHON` to a Python that has `trimesh`. Face budgets also need `fast-simplification` in that environment. Without it, the STL is still written at the mesh's full face count.

Gallery lists Trellis runs, newest first, with label and time. It does not inline textures. Usage is a count of those runs and their real GPU seconds, not a credit balance.
