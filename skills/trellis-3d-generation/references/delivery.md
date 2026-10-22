# Delivery

How to turn a produced model into something the user can see and
collect: rendered previews in chat, the gallery of everything made,
and usage (how many Trellis runs, and how long they held the GPU).

## Render a preview (for chat)

`trellis_render_preview` submits RotateMesh and RenderMesh on the GPU machine. Default is four solid views at 0, 90, 180, and 270 degrees. Modes are `auto`, `texture`, `vertex colors`, `solid`, `normal`, and `depth`. There is no mp4. Four identical sha256 values mean the angles did not change.

**Show it in chat:** once you have a frame path, surface it to the user
with a `MEDIA:<absolute path to a .png>` line (the desktop app renders
images inline). A missing preview does not block delivery — it just means
there is nothing to show.

> A rendered image shows *appearance*, not *topology quality*. For a
> print/cast decision, tell the user the STL should be opened in their
> slicer/CAD to confirm it is watertight/manifold.

## The gallery (all models you've made)

`trellis_gallery` lists Trellis image-to-3D runs, newest first, with the
label and `create_time` stored on the ComfyUI prompt. It does not inline
PNGs. Render-only history rows are omitted. Ask for `trellis_render_preview`
when the user wants pictures.

## Usage (status bar)

`trellis_usage` counts completed Trellis image-to-3D runs and sums
`execution_success - execution_start` from ComfyUI. It is not a credit
balance and it does not multiply the history length by 20. The desktop
status line can show:

```
Trellis ● running   ·  7 models   ·  ~412 s GPU   ·  last: t-8f3a2c (2m ago)
```

Keep the service-running state (`● running` / `○ stopped`) and the GPU
contention note (Trellis vs LLM serving) visible, so the user knows what
is occupying the GPU.

## File naming / sizes

- Downloads land in the output dir (configurable). When the user gives a
  path, write there; otherwise name it `<task_id>.<format>`.
- **GLB** is the ComfyUI file. **STL** is the print file, written on the Hermes
  machine from that GLB. Report path, bytes, face count, extents, and watertight.
- Very large renders/frames are written to disk (not inlined) to keep chat
  light; reference them by path / `MEDIA:`.
