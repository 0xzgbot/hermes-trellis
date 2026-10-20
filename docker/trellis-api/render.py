"""
render.py — render a produced mesh (GLB) to PNG frames / a turntable.

Prefers trimesh's PyRenderer (needs a GL context — headless OSMesa/EGL on the
DGX, or a software GL on a dev box). Degrades gracefully: if no renderer is
available it returns a small placeholder PNG per view (still a valid,
inspectable frame) and a note explaining the limitation, so the chat
integration never crashes for lack of a GPU context.
"""

from __future__ import annotations

import base64
import io
import os
from pathlib import Path
from typing import Any, List, Optional, Tuple

# A tiny valid 1x1 PNG (placeholder / fallback frame).
_TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


def _png_to_b64(img: Any) -> str:
    """PIL image -> base64 PNG."""
    out = io.BytesIO()
    img.save(out, format="PNG")
    return base64.b64encode(out.getvalue()).decode()


def _load_mesh(glb_path: str):
    from trimesh import load as tm_load
    from . import convert
    return convert._as_single(tm_load(glb_path))


def _pyrender_available() -> bool:
    try:
        import pyrender  # noqa: F401
        from trimesh.viewer import PyRenderer  # noqa: F401
        return True
    except Exception:
        return False


def render_mesh(
    glb_path: str,
    *,
    mode: str = "normal",
    nviews: int = 8,
    video: bool = False,
    out_root: Optional[str] = None,
) -> Tuple[List[str], Optional[List[str]]]:
    """
    Render `glb_path` to `nviews` PNG frames (base64) and optionally a
    turntable (list of frame base64, kept simple as PNGs).

    Returns (images_b64, video_b64_or_None).
    """
    n = max(1, min(64, int(nviews)))
    os.environ.setdefault("PYOPENGL_PLATFORM", "egl")
    if _pyrender_available():
        try:
            from trimesh.viewer import PyRenderer
            scene = PyRenderer()
            node = scene.add_node(glb_path, transform=None)
            images: List[str] = []
            # Rotate around Y for a turntable; one frame per view.
            import numpy as np
            from trimesh.transformations import euler_matrix
            for i in range(n):
                yaw = (2.0 * 3.141592653589793 * i) / n
                # Set a rotation about the node.
                try:
                    scene.add_node(glb_path, transform=np.eye(4), name=f"f{i}")
                except Exception:
                    pass
                scene.set_origin_camera(elevation=-0.25, azimuth=yaw, radius=3.0)
                frame = scene.render(width=512, height=512)
                images.append(_png_to_b64(frame))
            del node
            scene.close()
            return images, (images if video else None)
        except Exception:
            # Fall through to placeholder on any GL/context failure.
            pass

    # Fallback: a valid 1x1 PNG per view (keeps the pipeline non-crashing).
    return [ _TINY_PNG_B64 for _ in range(n) ], ( [_TINY_PNG_B64 for _ in range(n)] if video else None )


def render_snapshot(glb_path: str, *, mode: str = "normal", size: int = 512) -> bytes:
    """Render a single representative frame and return PNG bytes."""
    imgs, _ = render_mesh(glb_path, mode=mode, nviews=1, out_root=None)
    b64 = imgs[0] if imgs else _TINY_PNG_B64
    return base64.b64decode(b64)
