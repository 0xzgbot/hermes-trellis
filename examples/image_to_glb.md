# Example — image → GLB (keep the full PBR)

The "I want the asset, not just a printable" case: conditioning image
in, a fully-textured **GLB** out (base color + roughness + metallic + opacity),
ready for a viewer, a game engine, or USD.

## What you say to the agent

> "Turn this mask photo into a textured GLB at 1024 and show me four texture views."

## What the agent does

```
1. trellis_health                 # up / busy. model_loaded stays false.
2. If down, the user starts ComfyUI. trellis_start does not.
3. trellis_image_to_3d                # image, resolution=1024, seed,
                                              #   label="carved wooden mask" -> task_id
4. trellis_wait_task(task_id)         # until completed
5. trellis_download(format="glb",
                        dest="~/Desktop/mask.glb")
   # GLB is the native output — full PBR, no conversion needed.
6. trellis_render_preview(mode="texture", nviews=4)
7. MEDIA: the four frames
```

## What you get

- `~/Desktop/mask.glb` — a single, self-contained GLB with the full PBR
  texture set baked in (webp). Opens in any glTF viewer / Blender / game engine.
- Four `texture` views from `RenderMesh`. This server has no HDRI sunset mode.
- Logged in the **gallery** + counted in **usage**.

## Good to know

- GLB is the ComfyUI file. STL and OBJ are local conversions of it. FBX and USDZ are refused.
- **Transparency is stored but inactive** — the alpha channel is preserved
  in the texture, but the material is exported opaque by default. To enable
  it, import the GLB into your 3D app and wire the texture's alpha to the
  material's opacity/alpha input.
- Texture is already in the GLB. `trellis_texturize` starts another full generation. It does not recolor an existing file.
