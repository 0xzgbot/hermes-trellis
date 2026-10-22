# Delivery

How to turn a produced model into something the user can see and
collect: rendered previews in chat, the gallery of everything made,
and usage/"credits" (surfaced, e.g., on a status bar).

## Render a preview (for chat)

`trellis_render_preview` renders the produced mesh to PNG frame(s)
under an HDRI environment. Modes (mirror the app's display modes):

| Mode | Look |
|---|---|
| `normal` | PBR shading, neutral studio |
| `clay` | untextured matte "clay" (shows pure geometry) |
| `base_color` | albedo only (no lighting) |
| `hdri_forest` / `hdri_sunset` / `hdri_courtyard` | photographic environmental lighting |

Call with `task_id`, `mode`, optional `nviews` (frames) and `video`
(assemble a turntable). It writes the frame(s) to the output dir and
returns their paths.

**Show it in chat:** once you have a frame path, surface it to the user
with a `MEDIA:<absolute path to a .png>` line (the desktop app renders
images inline). A missing preview does not block delivery — it just means
there is nothing to show.

> A rendered image shows *appearance*, not *topology quality*. For a
> print/cast decision, tell the user the STL should be opened in their
> slicer/CAD to confirm it is watertight/manifold.

## The gallery (all models you've made)

`trellis_gallery` lists generated models, most recent first, each with a
small preview thumbnail, its label, timestamp, and available formats.
Use it to answer "show me everything you've made," or to **find a previous
model** (by label/time) instead of regenerating. It reads from the local
store, so it survives restarts and grows monotonically.

On request, you can build a **montage** (a grid image of the last N thumbnails)
to show many at once — but a simple list-with-thumbnails is usually
enough.

## Usage / "credits" (status bar)

`trellis_usage` reports local activity/cost — since it is a *local* model
(there is no cloud invoice), "credits" are framed as: **how many models have
been generated**, an **estimate of GPU-seconds consumed**, and the **last
task** (id + time). The desktop integration can surface a one-liner on a
status bar, e.g.:

```
Trellis ● running   ·  7 models   ·  ~412 s GPU   ·  last: t-8f3a2c (2m ago)
```

Keep the service-running state (`● running` / `○ stopped`) and the GPU
contention note (Trellis vs LLM serving) visible, so the user knows what
is occupying the GPU.

## File naming / sizes

- Downloads land in the output dir (configurable). When the user gives a
  path, write there; otherwise name it `<task_id>.<format>`.
- **`trellis_download` returns GLB** (the server's only export). GLB carries the
  full PBR and is the largest artifact; a **STL** is produced by converting that
  GLB **locally** (see Pipelines → "GLB → printable binary STL"), so it is
  geometry-only and typically a fraction of the GLB. Report the file size with
  the path.
- Very large renders/frames are written to disk (not inlined) to keep chat
  light; reference them by path / `MEDIA:`.
