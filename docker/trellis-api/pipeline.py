"""
pipeline.py — wraps the Trellis.2 image->3D (and PBR texturing) pipelines.

This is the ONLY module that imports the heavy ML stack
(torch, trellis2, o_voxel, nvdiffrast, ...). main.py lazy-imports it so the
lightweight parts of the bridge (health, task bookkeeping) work even
before the model is loaded.

The heavy objects are module-level singletons, loaded on first use and
cached.
"""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

log = logging.getLogger(__name__)

MODEL_ID = os.environ.get("TRELLIS_MODEL_ID", "microsoft/TRELLIS.2-4B")
OUT_DIR = Path(os.environ.get("TRELLIS_PIPELINE_OUT", "/tmp/trellis-pipeline-out"))
OUT_DIR.mkdir(parents=True, exist_ok=True)

_lock = threading.Lock()
_pipe: Optional[Any] = None          # Trellis2ImageTo3DPipeline (cuda)
_envmaps: Dict[str, Any] = {}        # cached EnvMap per HDRI name
_tex_pipe: Optional[Any] = None      # texturing pipeline (if distinct)


def _ensure_lock(fn: Callable[..., Any]):
    """Decorator: serialize the model load across threads."""
    def wrapped(*a, **k):
        with _lock:
            return fn(*a, **k)
    return wrapped


@_ensure_lock
def _load_pipeline() -> Any:
    """Load the Trellis.2 image->3D pipeline onto the GPU (once)."""
    global _pipe, _envmaps
    if _pipe is not None:
        return _pipe
    log.info("loading Trellis.2 pipeline %s ...", MODEL_ID)

    # The upstream README example.py is the source of truth for the
    # exact import names and the GLB export call. Reproduce it here.
    import os as _os
    _os.environ.setdefault("OPENCV_IO_ENABLE_OPENEXR", "1")
    _os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
    import cv2
    import torch
    from trellis2.pipelines import Trellis2ImageTo3DPipeline
    from trellis2.renderers import EnvMap

    p = Trellis2ImageTo3DPipeline.from_pretrained(MODEL_ID)
    p.cuda()
    _pipe = p
    log.info("Trellis.2 pipeline %s loaded (cuda).", MODEL_ID)

    # Warm up env maps used by the renderer (cheap, cache them).
    hdri_dir = _find_hdri_dir()
    if hdri_dir:
        for name in ("forest", "sunset", "courtyard"):
            f = hdri_dir / f"{name}.exr"
            if f.exists():
                try:
                    exr = cv2.cvtColor(cv2.imread(str(f), cv2.IMREAD_UNCHANGED), cv2.COLOR_BGR2RGB)
                    _envmaps[name] = EnvMap(torch.tensor(exr, dtype=torch.float32, device="cuda"))
                except Exception as e:
                    log.warning("could not load envmap %s: %s", name, e)
    return p


def _find_hdri_dir() -> Optional[Path]:
    """Locate the HDRI .exr assets (forest/sunset/courtyard) on disk."""
    here = Path(__file__).resolve()
    for cand in (
        here.parent.parent.parent.parent / "TRELLIS.2" / "assets" / "hdri",
        here.parent / "assets" / "hdri",
        Path(os.environ.get("TRELLIS_HDRI_DIR", "")),
    ):
        try:
            if cand and Path(cand).is_dir() and any(Path(cand).glob("*.exr")):
                return Path(cand)
        except Exception:
            pass
    return None


def ensure_pipeline() -> Any:
    """Public: make sure the pipeline is loaded; return it."""
    return _load_pipeline()


def _to_pil(image: Any):
    """Accept a path / http(s) URL / data: URL / PIL image; return a PIL RGB image."""
    from PIL import Image

    if isinstance(image, Image.Image):
        return image.convert("RGB") if image.mode != "RGB" else image

    if not isinstance(image, str):
        image = str(image)

    if image.startswith("data:"):
        import base64
        import io
        b64 = image.split(",", 1)[1]
        return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")

    if image.startswith(("http://", "https://")):
        import urllib.request
        import io
        with urllib.request.urlopen(image, timeout=60) as resp:
            return Image.open(io.BytesIO(resp.read())).convert("RGB")

    p = Path(image)
    if not p.is_absolute():
        # Try relative to the bridge out dir, then cwd.
        for base in (OUT_DIR, Path.cwd()):
            cand = base / p
            if cand.exists():
                p = cand
                break
    if not p.exists():
        raise FileNotFoundError(f"conditioning image not found: {image}")
    return Image.open(p).convert("RGB")


def _sampler_params(spec: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not spec:
        return {}
    d: Dict[str, Any] = {}
    if spec.get("steps") is not None:
        d["steps"] = int(spec["steps"])
    if spec.get("guidance_strength") is not None:
        d["guidance_strength"] = float(spec["guidance_strength"])
    if spec.get("guidance_rescale") is not None:
        d["guidance_rescale"] = float(spec["guidance_rescale"])
    if spec.get("rescale_t") is not None:
        d["rescale_t"] = float(spec["rescale_t"])
    return d


# Mapping of resolution bucket -> pipeline_type (from the Gradio app).
_RES_TYPE = {512: "512", 1024: "1024_cascade", 1536: "1536_cascade"}


def _to_glb_bytes(mesh: Any, texture_size: int = 4096, decimation_target: int = 1_000_000) -> bytes:
    """Export a produced o_voxel mesh to GLB bytes (mirrors the README example)."""
    import io
    import o_voxel

    glb = o_voxel.postprocess.to_glb(
        vertices=mesh.vertices,
        faces=mesh.faces,
        attr_volume=mesh.attrs,
        coords=mesh.coords,
        attr_layout=mesh.layout,
        voxel_size=mesh.voxel_size,
        aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
        decimation_target=decimation_target,
        texture_size=texture_size,
        remesh=True,
        remesh_band=1,
        remesh_project=0,
        verbose=False,
    )
    buf = io.BytesIO()
    glb.export(buf, extension_webp=True)
    return buf.getvalue()


def _render_snapshot_png(mesh: Any, envmap_name: str = "forest") -> Optional[bytes]:
    """Render one snapshot PNG of the produced mesh (for the preview)."""
    try:
        from trellis2.utils import render_utils
        import torch
        pm = _load_pipeline()
        em = _envmaps.get(envmap_name)
        if em is None:
            # fall back to the first loaded envmap, or skip preview
            em = next(iter(_envmaps.values()), None)
        img = render_utils.render_snapshot(mesh, resolution=512, r=1, fov=36, nviews=1,
                                                  envmap=em)
        # img is a PIL image or ndarray -> save to PNG bytes
        import io
        import numpy as np
        if hasattr(img, "save"):
            out = io.BytesIO()
            img.save(out, format="PNG")
            return out.getvalue()
        arr = np.asarray(img)
        from PIL import Image
        out = io.BytesIO()
        Image.fromarray(arr).save(out, format="PNG")
        return out.getvalue()
    except Exception as e:
        log.warning("snapshot render failed (preview skipped): %s", e)
        return None


# ---------------------------------------------------------------------------
# Public entrypoints used by main.py (called in a worker thread)
# ---------------------------------------------------------------------------
def run_image_to_3d(
    *,
    image: Any,
    resolution: int = 1024,
    seed: Optional[int] = None,
    randomize: bool = False,
    ss: Optional[Dict[str, Any]] = None,
    shape: Optional[Dict[str, Any]] = None,
    tex: Optional[Dict[str, Any]] = None,
    on_progress: Optional[Callable[[float], None]] = None,
    decimation_target: int = 1_000_000,
    texture_size: int = 4096,
) -> Dict[str, Any]:
    """
    Run the Trellis.2 image->3D pipeline end to end.

    Returns a dict with:
      glb_bytes : bytes     the produced PBR GLB
      mesh_faces  : int      face count of the produced mesh
      preview_png : bytes|None   a single rendered snapshot (best-effort)
    """
    pm = _load_pipeline()
    pil = _to_pil(image)

    if randomize and seed is None:
        import random
        seed = random.randrange(0, 2**31 - 1)

    res = int(resolution)
    ptype = _RES_TYPE.get(res, "1024_cascade")

    def prog(p: float):
        if on_progress:
            try:
                on_progress(max(0.0, min(0.95, float(p))))
            except Exception:
                pass

    prog(0.05)
    outputs, latents = pm.run(
        pil,
        seed=seed,
        preprocess_image=False,
        sparse_structure_sampler_params=_sampler_params(ss),
        shape_slat_sampler_params=_sampler_params(shape),
        tex_slat_sampler_params=_sampler_params(tex),
        pipeline_type=ptype,
        return_latent=True,
    )
    prog(0.8)
    mesh = outputs[0]
    try:
        mesh.simplify(16_777_216)  # nvdiffrast limit (as in the Gradio app)
    except Exception:
        pass

    glb = _to_glb_bytes(mesh, texture_size=texture_size, decimation_target=decimation_target)
    prog(0.95)
    preview = _render_snapshot_png(mesh)

    return {
        "glb_bytes": glb,
        "mesh_faces": int(getattr(mesh, "num_faces", len(mesh.faces))) if hasattr(mesh, "faces") else None,
        "preview_png": preview,
        "pipeline_type": ptype,
    }


def run_texturize(*, image: Any, shape_src: Optional[str] = None) -> Dict[str, Any]:
    """
    PBR (re)texturing. The upstream example_texturing.py is the source of
    truth for the exact API; we reproduce it here, exporting a textured GLB.
    """
    pm = _load_pipeline()
    pil = _to_pil(image)

    # The exact call depends on the version of the trellis2 texturing API.
    # We attempt the documented call and, on mismatch, raise a clear error
    # the agent can surface (rather than a cryptic traceback).
    try:
        if shape_src:
            from .convert import load_mesh
            base = load_mesh(shape_src)
            outputs = pm.run_texture(pil, base_mesh=base, return_glb_bytes=True)
        else:
            outputs = pm.run_texture(pil, return_glb_bytes=True)
    except AttributeError as e:
        raise RuntimeError(
            "Trellis texturing API mismatch: "
            f"{e}. Check the upstream example_texturing.py for this build."
        ) from e

    glb = outputs["glb_bytes"] if isinstance(outputs, dict) else outputs
    return {"glb_bytes": glb}


def gpu_free_gb() -> Optional[float]:
    try:
        import subprocess
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader"],
            stderr=subprocess.DEVNULL, timeout=5)
        return round(float(out.decode().splitlines()[0]) / 1024.0, 1)
    except Exception:
        return None
