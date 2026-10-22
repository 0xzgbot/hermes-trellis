#!/usr/bin/env python3
"""Local print prep for a Trellis GLB. No network.

  python print_mesh.py convert --src in.glb --dest out.stl --format stl \
      --face-budget 200000 --height-mm 100 --repair

Prints one JSON object on stdout. Exit 0 on success.
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import tempfile
from pathlib import Path


def _load(path: str):
    import trimesh

    loaded = trimesh.load(path, force="mesh")
    if isinstance(loaded, trimesh.Scene):
        meshes = [g for g in loaded.geometry.values() if hasattr(g, "faces")]
        if not meshes:
            raise RuntimeError(f"no mesh in {path}")
        loaded = trimesh.util.concatenate(meshes)
    if not hasattr(loaded, "faces"):
        raise RuntimeError(f"not a mesh: {path}")
    return loaded


def _extents(mesh) -> list[float]:
    ext = getattr(mesh, "extents", None)
    if ext is None:
        return []
    return [float(x) for x in ext]


def convert(src: str, dest: str, fmt: str, face_budget: int | None, height_mm: float | None, repair: bool) -> dict:
    mesh = _load(src)
    faces_before = int(len(mesh.faces))
    watertight_before = bool(mesh.is_watertight)
    extents_before = _extents(mesh)

    if face_budget is not None and faces_before > face_budget:
        try:
            mesh = mesh.simplify_quadric_decimation(face_count=int(face_budget))
        except ModuleNotFoundError as e:
            raise RuntimeError(
                "decimation needs the fast-simplification package in TRELLIS_PYTHON "
                f"({e}). The STL can still be written without --face-budget."
            ) from e

    if height_mm is not None:
        ext = _extents(mesh)
        longest = max(ext) if ext else 0.0
        if longest <= 0:
            raise RuntimeError("mesh has zero extent; cannot scale")
        mesh.apply_scale(float(height_mm) / longest)

    if repair and not bool(mesh.is_watertight):
        import trimesh.repair as repair_mod

        try:
            repair_mod.fill_holes(mesh)
        except Exception:
            pass
        try:
            repair_mod.fix_normals(mesh)
        except Exception:
            pass
        try:
            repair_mod.fix_winding(mesh)
        except Exception:
            pass

    out = Path(dest)
    out.parent.mkdir(parents=True, exist_ok=True)
    fmt = fmt.lower().lstrip(".")
    mesh.export(out, file_type=fmt)
    data = out.read_bytes()
    faces_after = int(len(mesh.faces))
    result = {
        "ok": True,
        "path": str(out.resolve()),
        "format": fmt,
        "bytes": len(data),
        "faces_before": faces_before,
        "faces_after": faces_after,
        "watertight_before": watertight_before,
        "watertight_after": bool(mesh.is_watertight),
        "extents_before": extents_before,
        "extents": _extents(mesh),
        "height_mm": height_mm,
        "repaired": bool(repair and not watertight_before),
    }
    if fmt == "stl":
        if len(data) < 84:
            raise RuntimeError(f"STL is {len(data)} bytes, shorter than the 84-byte header")
        count = struct.unpack("<I", data[80:84])[0]
        expect = 84 + 50 * count
        if len(data) != expect:
            raise RuntimeError(f"STL byte math failed: size {len(data)} != 84 + 50*{count}")
        result["stl_face_count"] = count
        result["stl_bytes_ok"] = True
    return result


def self_test() -> dict:
    import trimesh

    box = trimesh.creation.box(extents=(10, 20, 30))
    with tempfile.TemporaryDirectory() as td:
        src = str(Path(td) / "box.glb")
        dst = str(Path(td) / "box.stl")
        box.export(src)
        raw = convert(src, dst, "stl", face_budget=None, height_mm=100, repair=True)
        assert raw["stl_bytes_ok"] is True
        assert abs(max(raw["extents"]) - 100) < 1e-3
        assert raw["watertight_after"] is True
        return {"ok": True, "self_test": raw}


def main() -> int:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("convert")
    c.add_argument("--src", required=True)
    c.add_argument("--dest", required=True)
    c.add_argument("--format", required=True, choices=("stl", "obj", "glb"))
    c.add_argument("--face-budget", type=int, default=None)
    c.add_argument("--height-mm", type=float, default=None)
    c.add_argument("--repair", action="store_true")
    sub.add_parser("self-test")
    args = p.parse_args()
    try:
        if args.cmd == "self-test":
            result = self_test()
        else:
            result = convert(args.src, args.dest, args.format, args.face_budget, args.height_mm, args.repair)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
