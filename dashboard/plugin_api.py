"""Backend for the Trellis desktop card. Reads local files and ComfyUI status. No cloud calls."""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.request import urlopen

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

router = APIRouter()

_ALLOWED = {".glb", ".gltf", ".stl", ".png"}


def _roots() -> list[Path]:
    roots = [Path.home().resolve()]
    out = os.environ.get("TRELLIS_OUT_DIR", "").strip()
    if out:
        roots.append(Path(out).expanduser().resolve())
    return roots


def _allowed(path: Path) -> bool:
    for root in _roots():
        if path == root or root in path.parents:
            return True
    return False


def _model(raw: str) -> Path:
    path = Path(raw).expanduser().resolve()
    if path.suffix.lower() not in _ALLOWED:
        raise HTTPException(400, "path must be a glb, gltf, stl, or png")
    if not _allowed(path):
        raise HTTPException(403, "path is outside the home directory and TRELLIS_OUT_DIR")
    if not path.is_file():
        raise HTTPException(404, "file not found")
    return path


@router.get("/status")
def status() -> dict:
    base = os.environ.get("TRELLIS_API_URL", "http://127.0.0.1:8188").rstrip("/")
    up = False
    busy = False
    try:
        with urlopen(base + "/system_stats", timeout=4) as resp:
            up = resp.status == 200
        with urlopen(base + "/queue", timeout=4) as resp:
            queue = json.loads(resp.read().decode())
        busy = bool(queue.get("queue_running"))
    except Exception:
        up = False
    rows = _provenance()
    last = rows[0] if rows else {}
    return {
        "up": up,
        "busy": busy,
        "models": len(rows),
        "last_label": last.get("label"),
        "last_at": last.get("at"),
        "comfy_url": base,
    }


@router.get("/provenance")
def provenance() -> dict:
    return {"items": _provenance()}


def _provenance() -> list:
    out = os.environ.get("TRELLIS_OUT_DIR", "").strip()
    candidates = []
    if out:
        candidates.append(Path(out).expanduser() / "provenance.json")
    candidates.append(Path.cwd() / "trellis-out" / "provenance.json")
    for file in candidates:
        try:
            data = json.loads(file.read_text())
        except Exception:
            continue
        if isinstance(data, list):
            return data
    return []


@router.get("/model")
def model(path: str) -> FileResponse:
    file = _model(path)
    media = "model/gltf-binary" if file.suffix.lower() in {".glb", ".gltf"} else "application/octet-stream"
    return FileResponse(file, media_type=media, filename=file.name)
