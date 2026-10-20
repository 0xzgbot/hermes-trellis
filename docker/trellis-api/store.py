"""
store.py — light persistence for the gallery + usage.

Keeps the in-memory Task book as the source of truth (fast) and mirrors
a small, append-only JSONL "history" of completed models (with label,
timestamp, model id, and output size) so the gallery survives a restart
and can grow monotonically. Deliberately minimal (no DB): one JSON line per
completed model; readers tolerate partial writes by ignoring incomplete
lines.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

_LOCK = threading.Lock()


def _store_path() -> Path:
    root = Path(os.environ.get("TRELLIS_BRIDGE_OUT", "/tmp/trellis-bridge-out"))
    root.mkdir(parents=True, exist_ok=True)
    return root / "gallery.jsonl"


def record_completed(model_id: str, label: Optional[str], ts: str,
                       num_formats: int, total_bytes: int) -> Dict[str, Any]:
    entry = {
        "model_id": model_id,
        "label": label,
        "ts": ts,
        "num_formats": num_formats,
        "total_bytes": total_bytes,
    }
    path = _store_path()
    with _LOCK:
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry


def read_history(limit: int = 100) -> List[Dict[str, Any]]:
    path = _store_path()
    if not path.exists():
        return []
    lines = path.read_text(encoding="utf-8").splitlines()
    out: List[Dict[str, Any]] = []
    for ln in reversed(lines):
        if not ln.strip():
            continue
        try:
            out.append(json.loads(ln))
        except Exception:
            continue  # tolerate a partial write
        if len(out) >= limit:
            break
    return out


def summarize(history: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    total_bytes = 0
    n = 0
    last_ts: Optional[str] = None
    for e in history:
        n += 1
        total_bytes += int(e.get("total_bytes", 0) or 0)
        ts = e.get("ts")
        if ts and (last_ts is None or ts > last_ts):
            last_ts = ts
    return {"count": n, "total_bytes": total_bytes, "last_ts": last_ts}
