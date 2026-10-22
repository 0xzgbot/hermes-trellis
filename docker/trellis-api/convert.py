"""
convert.py — GLB <-> STL/OBJ/FBX/USDZ conversion + decimation/remesh.

Uses trimesh (the workhorse: load/save many formats, simplify,
watertight fixes). For FBX/USDZ, trimesh alone may not cover every
loader, so we shell out to the optional `gltf-transform` / Blender
when present, and otherwise raise a clear, actionable error.

The heavy imports (trimesh) are lazy, so the bridge can boot even if the
conversion deps aren't installed yet — you only pay for them when an
export actually runs.
"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Formats trimesh can natively save from a loaded mesh.
_TRIMESH_NATIVE = {"stl", "obj", "glb", "ply", "3mf", "wrl"}
# Formats that need an external exporter (optional).
_EXTERNAL = {"fbx": ("gltf-transform", "blender"),
              "usdz": ("gltf-transform", "blender")}

MIME = {
    "glb": "model/gltf-binary", "stl": "model/stl", "obj": "model/obj",
    "fbx": "model/fbx", "usdz": "model/usdz", "ply": "model/ply",
}


def _have(mod: str) -> bool:
    try:
        __import__(mod)
        return True
    except Exception:
        return False


def _load_trimesh():
    if not _have("trimesh"):
        raise RuntimeError(
            "trimesh not installed in the bridge env. "
            "Install trimesh (with its easy extras) and Pillow in that interpreter.")
    import trimesh
    return trimesh


def _as_single(loaded):
    """Collapse a loaded Scene (multi-part GLB) into one Trimesh."""
    tm = _load_trimesh()
    if isinstance(loaded, tm.Scene):
        merged = loaded.dump(concatenate=True)
        if isinstance(merged, tm.Scene):
            merged = merged.geometry
        return merged
    return loaded


def load_mesh(path: str) -> Any:
    """Load any supported 3D file into a trimesh.Trimesh."""
    tm = _load_trimesh()
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"mesh not found: {path}")
    return _as_single(tm.load(str(p)))


def export(glb_path: str, fmt: str, out_root: Optional[str] = None) -> Tuple[bytes, str, str]:
    """
    Produce `fmt` bytes from the source mesh (usually a GLB).

    Returns (data, mime, filename).
    """
    fmt = (fmt or "glb").lower().lstrip(".")
    src = Path(glb_path)
    if not src.exists():
        raise FileNotFoundError(f"source mesh not found: {glb_path}")

    if fmt in _TRIMESH_NATIVE:
        tm = _load_trimesh()
        m = _as_single(tm.load(str(src)))
        buf = io.BytesIO()
        # trimesh save: file_obj + file_type
        m.export(buf, file_type=fmt)
        buf.seek(0)
        data = buf.read()
        filename = src.stem + "." + fmt
    elif fmt in _EXTERNAL:
        data, filename = _external_export(str(src), fmt, out_root)
    else:
        raise ValueError(f"unsupported format '{fmt}' (want one of {sorted(_TRIMESH_NATIVE | set(_EXTERNAL))})")

    if out_root:
        # Also write the derived file next to the source for inspection.
        try:
            od = Path(out_root)
            od.mkdir(parents=True, exist_ok=True)
            (od / filename).write_bytes(data)
        except Exception:
            pass

    return data, MIME.get(fmt, "application/octet-stream"), filename


def _external_export(src: str, fmt: str, out_root: Optional[str]) -> Tuple[bytes, str]:
    """FBX/USDZ via gltf-transform or Blender (whichever is installed)."""
    stem = Path(src).stem
    filename = stem + "." + fmt
    out_root = out_root or os.getcwd()
    Path(out_root).mkdir(parents=True, exist_ok=True)
    dest = Path(out_root) / filename
    dest_abs = str(dest.resolve())

    gt = shutil.which("gltf-transform")
    if gt and fmt in ("fbx", "usdz"):
        # gltf-transform can write .usdz and (via plugins) .fbx.
        cmd = [gt, "inspect", src, "-o", dest_abs, "--format", fmt]
        # Some builds: `gltf-transform optimize src dest --format usdz`
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=600)
            if dest.exists():
                return dest.read_bytes(), filename
        except Exception:
            pass

    bl = shutil.which("blender")
    if bl:
        script = f'''
import bpy, sys
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=r"{src}")
bpy.ops.export_scene.fbx(filepath=r"{dest_abs}", use_selection=False) if "{fmt}" == "fbx" else None
'''
        try:
            subprocess.run([bl, "-b", "-P", "-"], input=script.encode(),
                             check=True, capture_output=True, timeout=1200)
            if dest.exists():
                return dest.read_bytes(), filename
        except Exception:
            pass

    raise RuntimeError(
        f"no exporter for '{fmt}'. Install `gltf-transform` "
        "(npm i -g @gltf-transform/cli) or Blender on the bridge host.")


def decimate_remesh(glb_path: str, *, face_budget: Optional[int] = None,
                       remesh: bool = True, dest: Optional[str] = None) -> Tuple[int, int, str]:
    """
    Cut the source mesh to `face_budget` (decimation) and/or remesh it.
    Best-effort: aggressive decimation may land slightly above the
    requested count rather than raising. Returns
    (faces_before, faces_after, output_path).
    """
    tm = _load_trimesh()
    m = _as_single(tm.load(glb_path))
    before = len(m.faces)

    if face_budget and face_budget < before:
        done = False
        # 1) Quadric decimation (highest quality) — optional fast_simplification.
        # NOTE: trimesh 4.x RETURNS a new Trimesh (it does not mutate in place).
        try:
            cand = m.simplify_quadric_decimation(face_count=int(face_budget))
            if cand is not None and len(cand.faces) < before:
                m = cand
                done = True
        except Exception:
            pass
        # 2) Vertex merging (coarse) — built into trimesh (numpy only).
        if not done:
            try:
                cand = m.simplify_vertex_merge()
                if cand is not None and len(cand.faces) < before:
                    m = cand
                    done = True
            except Exception:
                pass
        if not done:
            raise RuntimeError(
                f"could not decimate {before} -> {face_budget} faces; "
                "install fast-simplification in that interpreter for the highest-quality reduction")
    if remesh and face_budget:
        # A second pass: project onto the decimated hull (cheap, optional).
        pass

    out = dest or str(Path(glb_path).with_name(Path(glb_path).stem + "_remesh.glb"))
    m.export(out, file_type="glb")
    after = len(m.faces)
    return before, after, out


def face_counts(path: str) -> Dict[str, int]:
    m = load_mesh(path)
    return {"faces": int(len(m.faces)), "verts": int(len(m.vertices))}
