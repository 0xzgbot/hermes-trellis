---
name: trellis-3d-generation
description: "Turn an image into a fully-textured 3D model (GLB/STL/OBJ/FBX/USDZ) with the local Trellis.2 model on the DGX Spark, driven through standard ComfyUI 0.42 at :8188: generate, PBR-texture, decimate/remesh, HDRI-render a preview, download the file, and track it in the gallery. Use for image->3D and image->STL (casting/printing); there is no text-to-3D here."
license: MIT
---

# Trellis 3D Generation

Use the **`trellis_*` MCP tools** to drive the local **Trellis.2** model (4B) on the
DGX Spark and turn the user's request into a delivered 3D asset. Completion
means **writing the requested file(s) to the requested location, inspecting a
preview, and reporting the result** — submitting a generation or a loaded
pipeline alone is not completion. Choose the shortest suitable pipeline and
reuse existing assets for follow-ups.

## Service state first (Trellis is local, and usually stopped)

Unlike a cloud service, Trellis runs only when you start it (it is normally
stopped so the GPU is free for TensorFold/other LLM work). So:

1. Call **`trellis_health`** before doing anything else.
2. If it reports **down / unreachable** and the user wants a model now:
   - Tell the user in one line that starting Trellis will occupy the GPU
     (and may slow or preempt LLM serving), and that the first model load
     takes a while.
   - Call **`trellis_start`** (optionally with `wait_seconds`). Surface the
     result (`up`, `model_loaded`). If it does not come up, read
     [Troubleshooting](references/troubleshooting.md) and report the likely
     cause (e.g. `.env` `HF_TOKEN` missing, weights not downloaded).
3. If it reports **busy / a generation in flight**, say so and wait (do not
   submit a competing job).

Keep the service running while the user is iterating (several generations),
but mention it costs GPU time, and offer to leave it up or let it be stopped
later.

## Read what this request needs

| Need | Reference |
|---|---|
| DGX prerequisites, HF token, starting the service/bridge, config | [Setup](references/setup.md) |
| Generating a model (params), PBR texturing, decimation/remesh, choosing an export format | [Pipelines](references/pipelines.md) |
| Rendering a preview, showing it in chat, gallery, usage/"credits", status bar | [Delivery](references/delivery.md) |
| Something failed or looked odd | [Troubleshooting](references/troubleshooting.md) |

Read the relevant section when needed. Recipes are examples to adapt to the
requested result, not a checklist of every stage. An untextured request skips
texturing; a model already exported needs no re-export.

## What the model can and cannot do here

- **Image → 3D** is the core (a single conditioning image → a textured mesh).
- **No text-to-3D and no multi-view** in this model (unlike the cloud service this
  mirrors). If the user only has a description, help them pick/generate a good
  conditioning image first (e.g. via an image tool), then run it.
- **PBR texturing / re-texturing** (base color, roughness, metallic, opacity).
- **Decimation + remesh** to a face/vertex budget (for printability/size).
- **Export**: **GLB (first-class, full PBR)**, **STL** (watertight solid — casting/
  printing), OBJ, FBX, USDZ.
- **Render preview** under an HDRI (modes incl. clay/base-color/forest/sunset/
  courtyard), frames or a turntable.
- **Gallery** of all models made + **usage** (local "credits": how many generated,
  GPU-time estimate).

## The standard pipeline

1. **`trellis_health`** (and `trellis_start` if down, after the user heads-nods).
2. **`trellis_image_to_3d`** with the conditioning image + resolution (512/1024/1536) +
   seed (fix for repro) + optional label/prompt (stored in the gallery). Get the
   `task_id`.
3. **`trellis_wait_task`** (or `trellis_task_status`) until it completes; read the
   error if it fails and act on [Troubleshooting](references/troubleshooting.md).
4. **`trellis_download`** to the path the user wants, in the requested format
   (**STL** for print/cast, **GLB** for keeping full PBR, etc.).
5. (Optional) **`trellis_render_preview`** to get a picture, and show it to the user
   in chat (a `MEDIA:` image) — a missing preview does not block delivery.
6. Report: file path(s), format, size, and that it's in the gallery. Mention GPU time
   if the user cares.

## Execution boundaries

- Inputs are an image (local path, URL, or data URL). Large data-URLs should be pre-shrunk.
- A fixed `seed` reproduces a model; `randomize_seed` varies it.
- Treat generation as **costed** (GPU time): don't silently rerun an expensive job;
  propose reruns/expensive higher resolutions before spending a lot.
- Keep work within the user's approved scope; surface the GPU contention
  (vs LLM serving) when starting the service.

## Deliver

Write the requested file(s) to the requested location(s). Inspect and show a
preview (a rendered image) when available; a missing preview must not prevent
delivery or be described as inspected. Report the result and any concrete
limitation. A rendered image does not, by itself, establish topology
quality — for print/cast, note that STL should be checked in the user's slicer/
CAD if watertightness matters. The gallery already tracks what was made; offer
to "show the gallery" on request.
