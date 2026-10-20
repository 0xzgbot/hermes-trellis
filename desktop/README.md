# Desktop integration

Hermes **desktop app** integration for the Trellis plugin — the same
integration the Meshy plugin ships: **rendered models in chat**, a
**status bar**, and a **gallery** of everything you've made.

`plugin.py` is the desktop counterpart of the MCP server + skill: the
agent generates a model through the `trellis_*` MCP tools, and this plugin
makes the **result visible** in the desktop app.

## What it does

| Piece | How |
|---|---|
| **Rendered models in chat** | When a generation completes, `render_frame()` fetches a preview frame (the bridge's `/render`, under an HDRI) and writes it to the output dir. The desktop app then shows it inline via a `MEDIA:<path>.png` line — exactly like an image. |
| **Status bar** | `service_state()` hits the bridge's `/health` + `/usage` and formats a one-liner: service running/stopped, whether a job is in flight, models generated, ~GPU-seconds, last task time. Refreshed periodically. |
| **Gallery** | `gallery()` reads the bridge's `/gallery` (the persisted list of generated models with thumbnails + labels + timestamps). Shown as a panel or on demand; you can build a montage of the last N. |

## Relationship to the rest of the plugin

```
                 ┌───────────────────────────────┐
   Hermes agent  │  trellis_* MCP tools (mcp/)        │  image→3D, texturize,
        │         │  -> TrellisBridgeClient          │  decimate, export,
        ▼         │                                     │  render, wait, gallery,
  skill   ───────▶│  (skills/trellis-3d-generation)    │  usage
  (how to use)   └──────────────┬──────────────────┘
                                    │  HTTP
                                    ▼
                        ┌───────────────────────────────┐
                        │  Trellis REST bridge (on DGX)      │  /health /start
                        │  docker/trellis-api  (FastAPI)      │  /generate /tasks/..
                        │  wraps Trellis2ImageTo3DPipeline + │  /render /gallery /usage
                        │  o_voxel (GLB) + trimesh (STL/OBJ/..)      │
                        └──────────────────────────────────┘
                                    │  same bridge (state + render)
                                    ▼
                        ┌───────────────────────────────┐
                        │  desktop/plugin.py                │  status bar, chat
                        │  service_state() render_frame()   │  preview (MEDIA:),
                        │  gallery()      register(context) │  gallery panel
                        └──────────────────────────────────┘
```

- **Generation is via the MCP tools** (the agent calls `trellis_image_to_3d`,
  `trellis_wait_task`, `trellis_download`, ...).
- **Visibility is via the desktop plugin** (it reads the same bridge for
  status/gallery and renders previews into chat).

So the desktop plugin is *not* a second way to generate — it is the layer
that surfaces what the agent generated.

## Registration & SDK notes

`register(context)` is the entrypoint the desktop app calls. It:

1. `context.register_skill("trellis-3d-generation", SKILL.md)` — namespaced as
   `plugin:trellis-3d-generation`, loadable via `skill_view`.
2. Registers a **status-bar** refresh (service state + usage).
3. Registers a **chat hook** / tool (`trellis_show_preview`) that, on completion,
   writes a rendered frame and returns `MEDIA:<path>` for inline display.
4. Registers a **gallery** panel/tool.

The exact hook names (`register_status_bar`, `register_chat_hook`,
`register_panel`, `register_tool`, ...) vary across Hermes desktop SDK
versions. `plugin.py` calls them defensively (via `_safe`), so it degrades
gracefully: the parts whose hooks your SDK exposes work; the rest are
no-ops. If a piece isn't appearing, map that capability to the hook your
desktop SDK provides and adjust the one matching line.

## Environment

- `TRELLIS_API_URL` — the bridge base URL (default `http://127.0.0.1:7861`).
- `TRELLIS_OUT_DIR` — where preview frames are written (default
  `<plugin>/out`).

## Standalone smoke

Run to see what the desktop UI would show (hits the live bridge):

```
python desktop/plugin.py
```
