# Example — image → STL (print / cast)

The maker case: a conditioning image in, a **watertight STL** on disk for the
slicer or the foundry.

## What you say to the agent

> "Make a 3D model of this photo of a bison at 1024, reduce it to about
> 20k faces, and save the STL to ~/Desktop/bison.stl. Then show me a clay
> render so I can check the shape."

## What the agent does (the pipeline)

```
1. trellis_health            # up? model_loaded? busy?
2. trellis_start               # (only if down; GPU now in use)
3. trellis_image_to_3d          # submit: image, resolution=1024, seed,
                                        #   label="a bison" -> task_id
4. trellis_wait_task(task_id)   # block until completed
5. trellis_remesh_decimate        # face_budget=20000 (print-sized)
6. trellis_download(format="stl",
                         dest="~/Desktop/bison.stl")
7. trellis_render_preview(mode="clay", nviews=8)
8. MEDIA: .../clay_00.png        # shown inline in chat
```

## What you get

- `~/Desktop/bison.stl` — a binary STL (~20k faces), slice-ready.
- An inline **clay render** in chat (pure geometry, no texture) so you can
  eyeball the silhouette before committing.
- The model is logged in the **gallery** (label "a bison", timestamp, formats).
- `trellis_usage` now shows one more model + a few more GPU-seconds.

## Good to know

- **STL is geometry-only** — no PBR. If you want the textured asset too,
  download `format="glb"` as well (it's the native, full-fidelity output).
- **Check watertightness** in your slicer/CAD if the model is for casting —
  the render shows shape, not manifold status.
- The **face budget** is a print-size knob: tighter = smaller file + faster
  slice, looser = more detail. Start ~20k and adjust.
