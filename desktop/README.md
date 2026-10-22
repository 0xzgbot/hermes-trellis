# Desktop integration

Status and a list of Trellis runs. Generation and the solid views are the
MCP tools, not this file.

## What it does

| Piece | How |
|---|---|
| Status | `GET /system_stats` for up/down, `GET /queue` for busy, `GET /history` for the Trellis run count and the newest `create_time`. `model_loaded` is always false. GPU seconds are left to `trellis_usage`. |
| Gallery | Trellis image-to-3D rows only: id, label, time. No PNG bytes. |
| Chat images | The agent calls `trellis_render_preview` and emits `MEDIA:<path>`. `render_frame()` returns nothing so this plugin does not invent a picture. |

## Registration

`register(context)` tries `register_skill`, a status-bar hook, a chat hook,
and a gallery panel. Hook names differ across Hermes desktop builds. Missing
hooks are ignored.

## Environment

- `TRELLIS_API_URL` — ComfyUI base, default `http://127.0.0.1:8188`.
- `TRELLIS_OUT_DIR` — unused by the status reader. Preview PNGs are written by the MCP server.

```bash
TRELLIS_API_URL=http://<DGX-TAILNET-IP>:8188 python desktop/plugin.py
```

`running: True` means ComfyUI answered. The model count is Trellis history
rows, not every prompt on that ComfyUI.
