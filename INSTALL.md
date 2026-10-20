# INSTALL — Trellis plugin for Hermes Agent

Full, end-to-end install: **DGX Spark** (Trellis + bridge), **Mac** (MCP server + skill),
**Hermes** (wire-up). Each step is independently runnable and verified.

---

## 0. Prerequisites

| Where | Needed | Check |
|---|---|---|
| DGX Spark | Docker (Engine + Compose v2 + NVIDIA Container Toolkit) | `docker compose version` |
| DGX Spark | A **Trellis base image** with the `trellis2` conda env (torch, trellis2, o_voxel, nvdiffrast, flash-attn, flexgemm, ...) | the image your Gradio app (`dr-vij/Trellis2-DGX-Spark-Docker`) runs in |
| DGX Spark | Hugging Face **token** with access to gated models (DINOv3, RMBG-2.0) + `microsoft/TRELLIS.2-4B` in the HF cache | `.env` `HF_TOKEN`; `HF_HOME` |
| Mac | Node **≥ 18** (Meshy wants 22; we need 18+) | `node -v` |
| Mac | Reachability to the DGX over the tailnet | `ping <DGX-TAILNET-IP>` |

> You already run Trellis on the Spark (Gradio `:7860`). The bridge is **layered on top of
> that same runtime** — it does not duplicate the heavy env. If you don't have
> the Trellis base image yet, build it first (dr-vij's Dockerfile).

---

## 1. On the DGX — bring up the bridge

Clone/check out this repo, then build + run the bridge from `docker/`:

```bash
cd hermes-trellis/docker

# (a) Build the bridge image. Point BASE_IMAGE at YOUR Trellis image
#     (the one serving :7860). This layers fastapi/uvicorn/trimesh/scipy
#     + the trellis_api package on top of it.
docker compose build trellis_bridge

# (b) Run the bridge (API on :7861, separate from Gradio :7860).
docker compose up -d trellis_bridge

# (c) Watch it come up (first start loads the env; the model loads on
#     first use / start).
docker compose logs -f trellis_bridge
```

### Verify

```bash
curl -s localhost:7861/health
# { "up": true, "model_loaded": false, "busy": false,
#   "model_id": "microsoft/TRELLIS.2-4B", "url": "http://<DGX-TAILNET-IP>:7861", ... }
```

`model_loaded` is `false` until the first job (or an explicit start) loads the
pipeline into GPU. That is expected and cheap to check.

### .env (in `docker/`)

```
TRELLIS_BASE_IMAGE=nvcr.io/nvidia/dgx/trellis2:latest   # <-- your Trellis image
TRELLIS_MODEL_ID=microsoft/TRELLIS.2-4B
BRIDGE_PORT=7861
# HF_TOKEN=hf_...        # if the base image doesn't already carry it
```

### Stop

```bash
docker compose down
```

---

## 2. On the Mac — build the MCP server

```bash
cd hermes-trellis/mcp
npm install          # @modelcontextprotocol/sdk, zod, typescript
npm run build        # tsc -> dist/
npm run typecheck    # optional: tsc --noEmit
```

### Smoke-run it (stdio)

```bash
node dist/index.js
# [trellis-mcp] connected. bridge=http://<DGX-TAILNET-IP>:7861 out=...
# (waits on stdin for JSON-RPC; Ctrl-C to quit)
```

### Run the end-to-end test (mock bridge, no GPU)

```bash
cd hermes-trellis
node tests/smoke.mjs
# ... 22 passed, 0 failed ...
```

---

## 3. In Hermes — wire up the MCP server + skill

### 3a. MCP server (config.yaml)

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  trellis:
    command: node
    args:
      - "/absolute/path/to/hermes-trellis/mcp/dist/index.js"   # absolute
    env:
      TRELLIS_API_URL: "http://<DGX-TAILNET-IP>:7861"
      TRELLIS_OUT_DIR: "/absolute/path/to/hermes-trellis/trellis-out"
```

Reload / restart Hermes so `mcp_servers.trellis` is discovered. Its tools
(`trellis_health`, `trellis_image_to_3d`, ...) appear alongside built-ins.

### 3b. Skill

```bash
hermes skills install /absolute/path/to/hermes-trellis/skills/trellis-3d-generation
```

(or drop the `trellis-3d-generation/` dir into your skills path.) The agent
now reads SKILL.md — service-state-first, the image→3D pipeline, delivery,
and troubleshooting.

### 3c. Verify in Hermes

```
hermes skills list                 # trellis-3d-generation present
```
Then a first chat turn: *"Check Trellis health."* → the agent calls
`trellis_health` and reports up/down/model_loaded. If down: *"Start it."* →
`trellis_start` (GPU now in use).

---

## 4. Desktop integration (optional)

Copy `desktop/plugin.py` into your Hermes desktop plugin path and
register it. It surfaces the status bar, the in-chat preview
(`MEDIA:`), and the gallery. Hook names may need a one-line match to
your desktop SDK version (see `desktop/README.md`).

---

## 5. Verify the whole thing

```bash
# (DGX) bridge healthy
curl -s <DGX-TAILNET-IP>:7861/health

# (Mac) MCP + contract
cd hermes-trellis && node tests/smoke.mjs

# (Hermes) a real round trip
#   "Trellis: make a 3D model of [image] at 1024, STL to ~/Desktop/x.stl,
#    show me a clay render."
#   -> task completes, x.stl written, clay frame shown in chat.
```

When all three are green, you have a working, local, image→STL/3D
pipeline for Hermes — the Meshy feature set, on your own model.

---

## Troubleshooting index

- **`ECONNREFUSED` / health down** → bridge not up → `docker compose up -d trellis_bridge` or `trellis_start`.
- **`HF 401` / gated model** → token/access on the DGX (DINOv3, RMBG-2.0) + weights in cache.
- **OOM at 1536** → drop to 1024/512, or free GPU (stop LLM serving).
- **`trimesh not installed`** → `pip install trimesh[easy]` in the bridge env.
- **Decimation no-op** → install `fast-simplification` (matching Python) / check trimesh API.
- **Wrong port** → bridge is `:7861` (Gradio is `:7860`); set `TRELLIS_API_URL`.
