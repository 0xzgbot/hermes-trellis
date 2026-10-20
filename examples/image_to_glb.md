# Example — image → GLB (keep the full PBR)

The "I want the asset, not just a printable" case: conditioning image
in, a fully-textured **GLB** out (base color + roughness + metallic + opacity),
ready for a viewer, a game engine, or USD.

## What you say to the agent

> "Turn this image of a carved wooden mask into a 3D model at 1024. Keep the
> full PBR — I want the textures, not a clay blob. Save the GLB to
> ~/Desktop/mask.glb and show me an HDRI-sunset render of it."

## What the agent does

```
1. trellis_health                 # up / model_loaded / busy
2. trellis_start                     # (if down)
3. trellis_image_to_3d                # image, resolution=1024, seed,
                                              #   label="carved wooden mask" -> task_id
4. trellis_wait_task(task_id)         # until completed
5. trellis_download(format="glb",
                        dest="~/Desktop/mask.glb")
   # GLB is the native output — full PBR, no conversion needed.
6. trellis_render_preview(mode="hdri_sunset", nviews=8, video=false)
7. MEDIA: .../hdri_sunset_00.png       # inline in chat
```

## What you get

- `~/Desktop/mask.glb` — a single, self-contained GLB with the full PBR
  texture set baked in (webp). Opens in any glTF viewer / Blender / game engine.
- An **HDRI-sunset render** in chat — the asset under warm environmental
  lighting, so you see it the way it would look in a scene (not on a gray stage).
- Logged in the **gallery** + counted in **usage**.

## Good to know

- **GLB is first-class here** — Trellis produces it natively (via `o_voxel`), so a
  `format="glb"` download is *the* output, not a derivative. STL/OBJ/FBX/USDZ are
  what you derive from it when a particular pipeline needs them.
- **Transparency is stored but inactive** — the alpha channel is preserved
  in the texture, but the material is exported opaque by default. To enable
  it, import the GLB into your 3D app and wire the texture's alpha to the
  material's opacity/alpha input.
- **Want to re-texture without re-rolling the shape?** `trellis_texturize`
  generates new PBR from a reference image (optionally conditioned on an
  existing base shape), then you re-download.
