# Example — image → STL (print / cast)

The maker case: a conditioning image in, a **watertight STL** on disk for the
slicer or the foundry.

## What you say to the agent

> "Make a printable STL of this bison photo at 1024, about 20k faces, 10 cm
> tall, and show me four solid views."

## What the agent does (the pipeline)

```
1. trellis_health
2. trellis_image_to_3d            # image, resolution=1024, seed, label
3. trellis_wait_task
4. trellis_download format=glb
5. trellis_render_preview mode=solid nviews=4
6. trellis_download format=stl dest=~/Desktop/bison.stl face_budget=20000 height_mm=100 repair=true
7. MEDIA: the four solid frames
```

The STL step checks `size == 84 + 50 * faces`. Report watertight before and after repair.

## What you get

- The STL path you named. Face count, byte size, extents, and watertight before and after repair.
- Four solid PNGs, each with its own sha256. Show them with `MEDIA:`.
- A gallery row with the label and time. Usage counts one more Trellis run and its GPU seconds.

## Good to know

- **STL is geometry-only** — no PBR. If you want the textured asset too,
  download `format="glb"` as well (it's the native, full-fidelity output).
- The solid views show shape. The watertight flag is the manifold report. Open the STL in the slicer either way.
- The **face budget** is a print-size knob: tighter = smaller file + faster
  slice, looser = more detail. Start ~20k and adjust.
