# INSTALL — Trellis plugin for Hermes Agent

Full, end-to-end install: **DGX Spark** (ComfyUI + Trellis.2), **Mac**
(MCP server + skill), **Hermes** (wire-up). Each step is independently
runnable and verified.

---

## 0. Prerequisites

| Where | Needed | Check |
|---|---|---|
| DGX Spark | ComfyUI **0.42** with the **Trellis-2 node classes** installed | `curl -s localhost:8188/system_stats` shows comfyui_version 0.42.0 |
| DGX Spark | **Local safetensors** for the Trellis-2 pipeline (`trellis_2_int8_convrot`, `trellis_2_shape_vae_bf16`, `trellis_2_texture_vae_bf16`, `dino_v3_L_naf_fp32`, `birefnet`) | `GET /object_info` lists the node classes; the graph loads weights by filename (no HF token) |
| Mac | Node **≥ 18** (Hermes wants 22; we need 18+) | `node -v` |
| Mac | Reachability to the DGX over the tailnet | `ping <DGX-TAILNET-IP>` |

> You already run ComfyUI on the Spark (Gradio `:7860`, separate from the
> runtime we need). The plugin talks to standard ComfyUI API at `:8188` —
> it does **not** run or manage ComfyUI itself.

---

## 1. On the DGX — have the ComfyUI runtime ready

ComfyUI 0.42 is the plugin's runtime; the plugin only calls its API.

```bash
# 1a. ComfyUI 0.42.0 + the Trellis-2 node classes
#     (Trellis2Conditioning · Trellis2ShapeStage · Trellis2TextureStage · ... ,
#      plus VaeDecode*Trellis, EmptyTrellis2LatentStructure, VoxelToMesh,
#      UNETLoader, VAELoader, KSampler, RenderMesh, SaveGLB/SaveImage).
#     Weights are local safetensors loaded by filename (no HF token needed):
#       trellis_2_int8_convrot.safetensors (UNet)
#       trellis_2_shape_vae_bf16.safetensors / trellis_2_texture_vae_bf16.safetensors
#       dino_v3_L_naf_fp32.safetensors (CLIP-vision) / birefnet.safetensors (bg removal)
#     A `nodes.json` export listing the installed-template versions is the
#     check: GET /object_info (or /api/object_info).

# 1b. (Optional, for the legacy bridge) docker/trellis-api on :7861:
#     cd docker && docker compose up -d trellis_bridge
#     This is a **second runtime**; the plugin defaults to the ComfyUI one.
```

Verify:
```bash
curl -s localhost:8188/system_stats | head -c 300   # comfyui_version: "0.42.0", devices: ["cuda"]
curl -s localhost:8188/api/models/diffusion_models # trellis_2_int8_convrot.safetensors
```

---

## 2. On the Mac — build the MCP server

```bash
cd hermes-trellis/mcp
npm install          # @modelcontextprotocol/sdk, zod, typescript
npm run build        # tsc → dist/  (strict, ES2022, Node16)
npm run typecheck    # optional: tsc --noEmit
```

### Smoke-run it (stdio)
```bash
node dist/index.js
# [trellis-mcp] connected. bridge=http://<DGX-TAILNET-IP>:8188 out=...
# (waits on stdin for JSON-RPC; Ctrl-C to quit)
```

### End-to-end test (mock ComfyUI, no GPU)
```bash
cd hermes-trellis
node tests/smoke.mjs
# ... 24 passed, 0 failed ...
```
The mock implements the ComfyUI API (`/system_stats`, `/upload/image`,
`/api/prompt`, `/history/{id}` wrapper, `/history`, `/view`) and drives every
tool the way the agent does — health → start → image_to_3d → task_status →
wait_task → download → render → gallery → usage.

---

## 3. In Hermes — wire up the MCP server + skill

### 3a. MCP server (`~/.hermes/config.yaml`)
```yaml
mcp_servers:
  trellis:
    command: node
    args: ["/absolute/path/to/hermes-trellis/mcp/dist/index.js"]
    env:
      TRELLIS_API_URL: "http://<DGX-TAILNET-IP>:8188"   # ComfyUI (default :8188)
      TRELLIS_BACKEND: "comfyui"                          # or "bridge" (:7861 legacy)
      TRELLIS_OUT_DIR: "/absolute/path/to/hermes-trellis/trellis-out"
```
Reload/restart Hermes so `mcp_servers.trellis` is discovered. Its tools
(`trellis_health`, `trellis_image_to_3d`, …) appear alongside built-ins.

### 3b. Skill
```bash
hermes skills install /absolute/path/to/hermes-trellis/skills/trellis-3d-generation
```
The agent now reads SKILL.md — service-state-first, the ComfyUI
image→3D pipeline, delivery, and troubleshooting.

### 3c. Verify in Hermes
```text
hermes skills list                 # trellis-3d-generation present
hermes tools list                  # trellis_* tools registered
```
Then a first chat turn: *"Check Trellis health."* → the agent calls
`trellis_health` and reports up/model_loaded. If down: *"Start it."*
`trellis_start` (GPU now in use).

---

## 4. Desktop integration (optional)

Copy `desktop/plugin.py` into your Hermes desktop plugin path and register it.
It surfaces the status bar, the in-chat preview (`MEDIA:`), and the gallery.
Hook names may need a one-line match to your desktop SDK version (see
`desktop/README.md`).

---

## 5. Verify the whole thing

```bash
# (DGX) ComfyUI runtime healthy
curl -s <DGX-TAILNET-IP>:8188/system_stats | head -c 200

# (Mac) MCP server + contract
cd hermes-trellis && node tests/smoke.mjs        # 24/24

# (Hermes) a real round trip
#   "Trellis: make a 3D model of [image] at 1024, STL to ~/Desktop/x.stl,
#    show me a clay render."
#   -> task completes, x.stl written, clay frame shown in chat.
```

When all three are green you have a working, local, image→STL/3D pipeline for
Hermes — the Meshy feature set, on your own model.
