"""
Terminal status check for ComfyUI. The Desktop UI is desktop/plugin.js.

Reads GET /system_stats, /queue, and /history. It does not generate a mesh
and it does not render. Preview PNGs come from trellis_render_preview.

Env:
  TRELLIS_API_URL  ComfyUI base URL (default http://127.0.0.1:8188)
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

# ----------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------
API_URL = os.environ.get("TRELLIS_API_URL", "http://127.0.0.1:8188").rstrip("/")


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


if __name__ == "__main__":
    # Standalone smoke: print what the desktop UI would show.
    print("== Trellis desktop integration (standalone smoke) ==")
    print("API:", API_URL)
    s = service_state()
    print("status bar payload:", s)
    g = gallery(10)
    print("gallery items:", len(g))
