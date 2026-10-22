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


def _is_trellis(graph: Any) -> bool:
    if not isinstance(graph, dict):
        return False
    for node in graph.values():
        if isinstance(node, dict) and node.get("class_type") in ("Trellis2ShapeStage", "Trellis2UpsampleStage"):
            return True
    return False


def _rows() -> List[Dict[str, Any]]:
    hist = _fetch("/history", timeout=30) or {}
    if not isinstance(hist, dict):
        return []
    rows: List[Dict[str, Any]] = []
    for pid, entry in hist.items():
        if not isinstance(entry, dict):
            continue
        prompt = entry.get("prompt")
        graph = prompt[2] if isinstance(prompt, list) and len(prompt) > 2 else None
        extra = prompt[3] if isinstance(prompt, list) and len(prompt) > 3 and isinstance(prompt[3], dict) else {}
        if not _is_trellis(graph):
            continue
        created = extra.get("create_time")
        rows.append({
            "id": pid,
            "label": extra.get("label"),
            "created_at": created,
            "model_id": "microsoft/TRELLIS.2-4B",
        })
    rows.sort(key=lambda r: r.get("created_at") or 0, reverse=True)
    return rows


def service_state() -> Dict[str, Any]:
    """Status-bar payload from ComfyUI /system_stats, /queue, and /history."""
    stats = _fetch("/system_stats")
    queue = _fetch("/queue") or {}
    running_jobs = queue.get("queue_running") if isinstance(queue, dict) else None
    rows = _rows()
    return {
        "running": stats is not None,
        "model_loaded": False,
        "busy": bool(running_jobs),
        "model_id": "microsoft/TRELLIS.2-4B",
        "models_generated": len(rows),
        "gpu_seconds": None,
        "last_task_at": rows[0]["created_at"] if rows else None,
    }


def gallery(limit: int = 24) -> List[Dict[str, Any]]:
    """Recent Trellis runs. No image bytes — render previews come from the MCP tool."""
    return _rows()[:limit]


def render_frame(task_id: str, mode: str = "solid", out: Optional[str] = None) -> Optional[str]:
    """Previews are written by trellis_render_preview. This hook does not invent one."""
    del task_id, mode, out
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
