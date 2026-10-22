"""
plugin.py — Hermes desktop integration for the Trellis plugin.

Wires the local Trellis 3D work into the Hermes **desktop app** — the
same integration the Meshy plugin ships (rendered models in chat, a
status bar, a gallery). It is the "desktop" counterpart of the MCP
server + skill: the agent generates a model via the `trellis_*` tools,
and this plugin makes the *result visible* in the app.

Architecture
------------
ComfyUI 0.42 is the runtime on the DGX (:8188); this plugin talks to
its standard endpoints:
  GET  /system_stats   → health (up / model_loaded / busy / model_id)
  GET  /history       → the flat list the gallery + usage read from
  GET  /view?filename&... → binary outputs (preview PNG, exported files)

The MCP server (`mcp/dist/index.js`) and the skill (`trellis-3d-generation`)
do the generation; the desktop plugin only *surfaces* it. Render previews
used in chat come from the agent's `trellis_render_preview` tool
(`MEDIA:<frame>`), not from this plugin.

Env:
  TRELLIS_API_URL  ComfyUI base URL (default http://127.0.0.1:8188)
  TRELLIS_OUT_DIR  where previews/exports land
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------
API_URL = os.environ.get("TRELLIS_API_URL", "http://127.0.0.1:8188").rstrip("/")
OUT_DIR = Path(os.environ.get("TRELLIS_OUT_DIR",
                                    Path(__file__).resolve().parent / "out"))
OUT_DIR.mkdir(parents=True, exist_ok=True)
SKILL_DIR = Path(__file__).resolve().parent.parent / "skills" / "trellis-3d-generation"


# ----------------------------------------------------------------------------
# Small bridge client (status / gallery / render) for the desktop UI.
# The agent does the generation via MCP; the desktop UI reads state.
# ----------------------------------------------------------------------------
def _fetch(path: str, timeout: float = 8.0) -> Optional[Dict[str, Any]]:
    import urllib.request
    try:
        with urllib.request.urlopen(API_URL + path, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception:
        return None


def service_state() -> Dict[str, Any]:
    """Status-bar payload: is Trellis up, is a job running, usage."""
    h = _fetch("/health") or {}
    u = _fetch("/usage") or {}
    return {
        "running": bool(h.get("up")),
        "model_loaded": bool(h.get("model_loaded")),
        "busy": bool(h.get("busy")),
        "model_id": h.get("model_id", "microsoft/TRELLIS.2-4B"),
        "models_generated": int(u.get("total_generated", 0) or 0),
        "gpu_seconds": float(u.get("gpu_seconds_estimate", 0) or 0),
        "last_task_at": u.get("last_task_at"),
    }


def gallery(limit: int = 24) -> List[Dict[str, Any]]:
    """Gallery panel payload: recent generated models + thumbnails."""
    g = _fetch("/gallery?limit=%d" % limit) or {}
    return g.get("items", [])


def render_frame(task_id: str, mode: str = "normal", out: Optional[str] = None) -> Optional[str]:
    """
    Fetch a rendered preview frame for a completed task and write it to
    disk (so the desktop app can display it via MEDIA:). Returns the
    absolute path, or None.
    """
    import base64
    r = _fetch("/tasks/%s/render" % task_id, timeout=30) if False else None
    # POST render:
    import urllib.request
    try:
        req = urllib.request.Request(
            API_URL + "/tasks/%s/render" % task_id,
            data=json.dumps({"mode": mode, "nviews": 1}).encode(),
            headers={"content-type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read().decode())
        imgs = body.get("images") or []
        if not imgs:
            return None
        # First image is a data:URL.
        data = imgs[0]
        b64 = data.split(",", 1)[1] if data.startswith("data:") else data
        png = base64.b64decode(b64)
        dest = Path(out) if out else OUT_DIR / ("%s_%s.png" % (task_id, mode))
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(png)
        return str(dest.resolve())
    except Exception:
        return None


# ----------------------------------------------------------------------------
# Plugin entrypoint / registration.
#
# `context` is the Hermes desktop plugin context (SDK-provided). The
# documented surface includes `context.register_skill(name, skill_md_path)`.
# Additional hook registrations (status bar, chat renderer, gallery
# panel) are wired below; adjust names to your desktop SDK.
# ----------------------------------------------------------------------------
def register(context: Any) -> None:
    # 1) Bundled skill -> agent knows the Trellis pipeline.
    skill_md = SKILL_DIR / "SKILL.md"
    if skill_md.exists():
        context.register_skill("trellis-3d-generation", str(skill_md))

    # 2) Status bar: periodic refresh of service state + usage.
    _register_status_bar(context)

    # 3) Chat renderer: on generation completion, show a preview frame.
    _register_chat_renderer(context)

    # 4) Gallery: a panel / on-demand montage of generated models.
    _register_gallery(context)


def _safe(fn: Callable, *a, **k):
    """Call an SDK hook if present (tolerate absence/version differences)."""
    try:
        return fn(*a, **k)
    except Exception:
        return None


def _register_status_bar(context: Any) -> None:
    def refresh() -> Optional[str]:
        s = service_state()
        dot = "\u25cf" if s.get("running") else "\u25cb"
        busy = " \u00b7 gen\u2026" if s.get("busy") else ""
        return ("Trellis %s %s%s   \u00b7  %s models   \u00b7  ~%.0f s GPU"
                % (dot, "running" if s.get("running") else "stopped", busy,
                   s.get("models_generated", 0), s.get("gpu_seconds", 0)))
    # Different SDKs expose the status bar differently; try common hooks.
    _safe(getattr(context, "register_status_bar", None), refresh)
    _safe(getattr(context, "register_statusbar", None), refresh)
    _safe(getattr(context, "set_status", None), refresh)


def _register_chat_renderer(context: Any) -> None:
    """
    When the agent finishes a Trellis generation, emit a rendered
    preview inline in chat (a MEDIA: image). Hooked to the generation
    completion (task -> completed).
    """
    def on_completed(task_id: str, mode: str = "normal") -> Optional[str]:
        path = render_frame(task_id, mode=mode)
        if not path:
            return None
        # The desktop app renders `MEDIA:<abs path>` inline as an image.
        return "MEDIA:%s" % path

    _safe(getattr(context, "register_chat_hook", None), on_completed)
    _safe(getattr(context, "register_tool", None),
           "trellis_show_preview",
           lambda task_id, mode="normal": on_completed(task_id, mode))


def _register_gallery(context: Any) -> None:
    """A gallery of all generated models (panel + on-demand montage)."""
    def panel(limit: int = 24) -> List[Dict[str, Any]]:
        return gallery(limit)

    _safe(getattr(context, "register_panel", None), "Trellis Gallery", panel)
    _safe(getattr(context, "register_tool", None),
           "trellis_gallery", panel)


if __name__ == "__main__":
    # Standalone smoke: print what the desktop UI would show.
    print("== Trellis desktop integration (standalone smoke) ==")
    print("API:", API_URL)
    s = service_state()
    print("status bar payload:", s)
    g = gallery(10)
    print("gallery items:", len(g))
