# Setup

The GPU host runs ComfyUI and Trellis.2. The Hermes machine runs the MCP
server, the skill, and trimesh. The agent does not SSH to the GPU host.

## On the GPU host

ComfyUI 0.42 at `http://<DGX>:8188` with:

`Trellis2Conditioning`, `Trellis2ShapeStage`, `Trellis2TextureStage`,
`Trellis2UpsampleStage`, `VaeDecodeStructureTrellis2`, `VaeDecodeShapeTrellis`,
`VaeDecodeTextureTrellis`, `EmptyTrellis2LatentStructure`, `VoxelToMesh`,
`SaveGLB`, `Load3DAdvanced`, `RotateMesh`, `RenderMesh`, `SaveImage`.

Weights, loaded by filename, no token for this path:

`trellis_2_int8_convrot.safetensors`, `trellis_2_shape_vae_bf16.safetensors`,
`trellis_2_texture_vae_bf16.safetensors`, `dino_v3_L_naf_fp32.safetensors`,
`birefnet.safetensors`.

The plugin does not install or start ComfyUI. A Gradio app on `:7860` is not
the API. The optional FastAPI bridge on `:7861` is unused by the default
`TRELLIS_BACKEND=comfyui`.

## On the Hermes machine

Node ≥ 18, a built `mcp/dist/index.js`, and a Python that imports `trimesh`.
Face budgets also need `fast-simplification` in that same interpreter.

`trellis_health` reports whether ComfyUI answers and whether `/queue` has a
running job. `model_loaded` stays false. `trellis_start` repeats the health
check. It does not boot the GPU service.

## Env

| Var | Meaning | Default |
|---|---|---|
| `TRELLIS_API_URL` | ComfyUI base URL | `http://127.0.0.1:8188` |
| `TRELLIS_BACKEND` | `comfyui` or legacy `bridge` | `comfyui` |
| `TRELLIS_BRIDGE_URL` | Legacy bridge, only when backend is `bridge` | `http://127.0.0.1:7861` |
| `TRELLIS_PYTHON` | Python with trimesh | `python3` |
| `TRELLIS_OUT_DIR` | Default download and render directory | `<cwd>/trellis-out` |

## Registering in Hermes

The MCP entry goes in `~/.hermes/config.yaml`, the main profile. An entry
that exists only under `~/.hermes/profiles/<name>/config.yaml` never loads.
Use `hermes config set mcp_servers.trellis.<field> <value> --force`.

Restart the gateway agent after the change. Installing the skill:

```bash
hermes skills install /absolute/path/to/skills/trellis-3d-generation
```

Then `trellis_health`. Up means ComfyUI answered. A generation is the test
that the weights load.
