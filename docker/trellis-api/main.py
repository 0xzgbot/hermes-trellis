"""
main.py — the Trellis REST "bridge" (FastAPI).

A thin, purpose-built HTTP front over the *same* `Trellis2ImageTo3DPipeline`
that the Gradio `app.py` uses — but exposing a clean async task API the
MCP server / agent can drive (submit → poll/wait → download → render),
plus the local gallery + usage ("credits") state. It intentionally does
NOT scrape Gradio: it calls the pipeline in-process.

Endpoints
---------
GET  /health                 up / model_loaded / busy / gpu_free_gb / model_id
POST /start                    bring the pipeline up (load into GPU) + wait
POST /generate                 {image,resolution,seed,label,...} -> {id,status}
GET  /tasks/{id}              status / progress / formats / sizes / preview
GET  /tasks/{id}/download?format=glb|stl|obj|fbx|usdz   -> binary
POST /tasks/{id}/render        {mode,nviews,video} -> {images:[data-url],video}
POST /tasks/{id}/remesh         {face_budget,remesh,...} -> {path,faces_*}
POST /texturize                {image,shape_src,label} -> {id,status}
GET  /gallery?limit=N          {items:[{id,label,thumbnail,...}]}
GET  /usage                        {total_generated,gpu_seconds_estimate,credits_used,last_task_id,...}
GET  /                             tiny index
"""

from __future__ import annotations

import asyncio
import base64
import io
import os
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import store  # light JSONL persistence for gallery + usage

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response, FileResponse
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Config / paths
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent.parent  # .../hermes-trellis
OUT_ROOT = Path(os.environ.get("TRELLIS_BRIDGE_OUT", str(BASE_DIR / "out")))
OUT_ROOT.mkdir(parents=True, exist_ok=True)

MODEL_ID = os.environ.get("TRELLIS_MODEL_ID", "microsoft/TRELLIS.2-4B")
APP_SCRIPT = os.environ.get("APP_SCRIPT", "app.py")

# Valid export formats we can derive from a produced GLB/mesh.
EXPORT_FORMATS = ("glb", "stl", "obj", "fbx", "usdz")
# Render modes (mirror the app.py MODES render keys, simplified).
RENDER_MODES = ("normal", "clay", "base_color", "hdri_forest", "hdri_sunset", "hdri_courtyard")


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _gpu_free_gb() -> Optional[float]:
    """Best-effort free GPU/unified memory in GB (returns None if unknown)."""
    try:
        import subprocess
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader"],
            stderr=subprocess.DEVNULL, timeout=5,
        ).decode().strip()
        mb = float(out.splitlines()[0])
        return round(mb / 1024.0, 1)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Task / state store (in-memory; persisted minimally to disk)
# ---------------------------------------------------------------------------
@dataclass
class Task:
    id: str
    status: str = "pending"                # pending|running|postprocessing|completed|failed
    progress: float = 0.0
    stage: str = "queued"
    image: Optional[str] = None              # original conditioning image (path/url/dataurl)
    resolution: int = 1024
    seed: Optional[int] = None
    label: Optional[str] = None
    model_id: str = MODEL_ID
    formats: List[str] = field(default_factory=lambda: list(EXPORT_FORMATS))
    sizes: Dict[str, int] = field(default_factory=dict)
    # Produced artifacts (paths on the DGX).
    glb_path: Optional[str] = None
    preview_path: Optional[str] = None        # a rendered snapshot PNG
    created_at: str = field(default_factory=_now)
    updated_at: str = field(default_factory=_now)
    finished_at: Optional[str] = None
    error: Optional[str] = None
    gpu_seconds: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "progress": self.progress,
            "stage": self.stage,
            "label": self.label,
            "model_id": self.model_id,
            "resolution": self.resolution,
            "seed": self.seed,
            "formats": self.formats,
            "sizes": self.sizes,
            "preview": self._preview_data_url(),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "finished_at": self.finished_at,
            "error": self.error,
        }

    def _preview_data_url(self) -> Optional[str]:
        if self.preview_path and Path(self.preview_path).exists():
            b64 = base64.b64encode(Path(self.preview_path).read_bytes()).decode()
            return f"data:image/png;base64,{b64}"
        return None


TASKS: Dict[str, Task] = {}
USAGE = {
    "total_generated": 0,
    "gpu_seconds_estimate": 0.0,
    "credits_used": 0,
    "last_task_id": None,
    "last_task_at": None,
}

# A coarse "pipeline is loaded" flag (the real load happens in pipeline.py).
PIPELINE_LOADED = False


# ---------------------------------------------------------------------------
# Pydantic request models
# ---------------------------------------------------------------------------
class Sampler(BaseModel):
    steps: Optional[int] = None
    guidance_strength: Optional[float] = None
    guidance_rescale: Optional[float] = None
    rescale_t: Optional[float] = None


class GenerateReq(BaseModel):
    image: str
    resolution: Optional[Any] = 1024
    seed: Optional[int] = None
    randomize_seed: Optional[bool] = False
    label: Optional[str] = None
    sparse_structure_sampler_params: Optional[Sampler] = None
    shape_slat_sampler_params: Optional[Sampler] = None
    tex_slat_sampler_params: Optional[Sampler] = None


class StartReq(BaseModel):
    wait_seconds: int = Field(120, ge=1, le=900)
    app_script: Optional[str] = None


class RenderReq(BaseModel):
    mode: Optional[str] = "normal"
    nviews: Optional[int] = 8
    video: Optional[bool] = False


class RemeshReq(BaseModel):
    face_budget: Optional[int] = None
    remesh: Optional[bool] = True
    remesh_band: Optional[float] = None
    remesh_project: Optional[float] = None
    dest: Optional[str] = None


class TexturizeReq(BaseModel):
    image: str
    shape_src: Optional[str] = None
    label: Optional[str] = None


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="Trellis bridge", version="1.0", description=__doc__)


@app.get("/")
def index() -> Dict[str, Any]:
    return {"name": "trellis-bridge", "model_id": MODEL_ID, "app_script": APP_SCRIPT, "ts": _now()}


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "up": True,
        "model_loaded": PIPELINE_LOADED,
        "busy": any(t.status == "running" for t in TASKS.values()),
        "gpu_free_gb": _gpu_free_gb(),
        "model_id": MODEL_ID,
        "url": f"http://{os.environ.get('HOST', '127.0.0.1')}:{os.environ.get('PORT', '7861')}",
        "app_script": APP_SCRIPT,
        "tasks": len(TASKS),
        "ts": _now(),
    }


@app.post("/start")
async def start(req: StartReq) -> Dict[str, Any]:
    global PIPELINE_LOADED
    t0 = time.time()
    if not PIPELINE_LOADED:
        # Load the pipeline into GPU memory (heavy; do it in a worker).
        from . import pipeline  # noqa: WPS433 (lazy heavy import)
        try:
            await asyncio.to_thread(pipeline.ensure_pipeline)
            PIPELINE_LOADED = True
        except Exception as e:  # pragma: no cover - env specific
            raise HTTPException(500, f"pipeline load failed: {e}")
    waited_ms = int((time.time() - t0) * 1000)
    return {"ok": True, "up": True, "model_loaded": PIPELINE_LOADED, "waited_ms": waited_ms,
            "note": "pipeline loaded into GPU" if PIPELINE_LOADED else "service up (model not yet loaded)"}


def _resolve_resolution(res: Optional[Any]) -> int:
    if res is None:
        return 1024
    if isinstance(res, (int, float)):
        return int(res)
    return int(str(res))


@app.post("/generate")
def generate(req: GenerateReq) -> Dict[str, Any]:
    res = _resolve_resolution(req.resolution)
    if res not in (512, 1024, 1536):
        raise HTTPException(422, f"resolution must be 512/1024/1536 (got {res})")
    tid = "t-" + uuid.uuid4().hex[:8]
    task = Task(id=tid, image=req.image, resolution=res, seed=req.seed, label=req.label,
                  status="pending", stage="queued")
    TASKS[tid] = task
    USAGE["total_generated"] += 1
    USAGE["credits_used"] += 1
    USAGE["last_task_id"] = tid
    USAGE["last_task_at"] = _now()
    # Kick off the (long) generation in the background.
    asyncio.get_event_loop().create_task(_run_generation(tid, req))
    return {"id": tid, "status": task.status}


async def _run_generation(tid: str, req: GenerateReq) -> None:
    task = TASKS.get(tid)
    if not task:
        return
    t0 = time.time()
    try:
        task.status = "loading_model"
        task.stage = "loading model into GPU"
        global PIPELINE_LOADED
        if not PIPELINE_LOADED:
            from . import pipeline
            await asyncio.to_thread(pipeline.ensure_pipeline)
            PIPELINE_LOADED = True

        task.status = "running"
        task.stage = "sampling (sparse-structure -> shape -> texture)"
        task.progress = 0.05

        from . import pipeline
        # The heavy model run on the GPU.
        out = await asyncio.to_thread(
            pipeline.run_image_to_3d,
            image=req.image,
            resolution=task.resolution,
            seed=task.seed,
            randomize=bool(req.randomize_seed),
            ss=req.sparse_structure_sampler_params,
            shape=req.shape_slat_sampler_params,
            tex=req.tex_slat_sampler_params,
            on_progress=lambda p: setattr(task, "progress", min(0.95, p)),
        )
        # out: dict with glb bytes/path, preview path, mesh info
        task.status = "postprocessing"
        task.stage = "exporting GLB + rendering preview"
        task.progress = 0.95

        # Persist the GLB to the out dir.
        glb_dir = OUT_ROOT / tid
        glb_dir.mkdir(parents=True, exist_ok=True)
        glb_path = glb_dir / "model.glb"
        if out.get("glb_bytes"):
            glb_path.write_bytes(out["glb_bytes"])
        task.glb_path = str(glb_path)

        # Sizes for each exportable format (GLB size known; others approximated
        # on demand at download time — record GLB and mark the rest as derivable).
        glb_size = glb_path.stat().st_size if glb_path.exists() else 0
        task.sizes = {
            "glb": glb_size,
            "stl": max(1, int(glb_size * 0.5)),
            "obj": max(1, int(glb_size * 0.6)),
            "fbx": max(1, int(glb_size * 0.88)),
            "usdz": glb_size,
        }

        # A cheap preview snapshot (if the pipeline returned one).
        if out.get("preview_png"):
            pv = glb_dir / "preview.png"
            pv.write_bytes(out["preview_png"])
            task.preview_path = str(pv)

        task.status = "completed"
        task.stage = "done"
        task.progress = 1.0
        task.finished_at = _now()
        task.gpu_seconds = round(time.time() - t0, 1)
        USAGE["gpu_seconds_estimate"] = round(USAGE["gpu_seconds_estimate"] + task.gpu_seconds, 1)
        # Persist the completed model to the JSONL gallery/usage store.
        store.record_completed(
            model_id=task.model_id, label=task.label, ts=task.finished_at,
            num_formats=len(task.formats),
            total_bytes=int(sum(task.sizes.values()) or 0),
        )
    except Exception as e:
        task.status = "failed"
        task.stage = "error"
        task.error = f"{type(e).__name__}: {e}"
        task.finished_at = _now()
        task.gpu_seconds = round(time.time() - t0, 1)
        USAGE["gpu_seconds_estimate"] = round(USAGE["gpu_seconds_estimate"] + task.gpu_seconds, 1)


@app.get("/tasks/{tid}")
def task_status(tid: str) -> Dict[str, Any]:
    task = TASKS.get(tid)
    if not task:
        raise HTTPException(404, f"no such task {tid}")
    return task.to_dict()


@app.get("/tasks/{tid}/download")
def download(tid: str, format: str = Query("glb", alias="format")) -> Response:
    task = TASKS.get(tid)
    if not task:
        raise HTTPException(404, f"no such task {tid}")
    fmt = format.lower().lstrip(".")
    if fmt not in EXPORT_FORMATS:
        raise HTTPException(415, f"format {fmt} not in {EXPORT_FORMATS}")
    if task.status not in ("completed", "succeeded"):
        raise HTTPException(409, f"task {tid} not complete (status={task.status})")
    if not task.glb_path or not Path(task.glb_path).exists():
        raise HTTPException(500, f"GLB for {tid} missing on disk")

    from . import convert
    data, mime, filename = convert.export(task.glb_path, fmt, out_root=str(OUT_ROOT / tid))
    return Response(content=data, media_type=mime,
                      headers={"content-disposition": f'inline; filename="{filename}"'})


@app.post("/tasks/{tid}/render")
def render(tid: str, req: RenderReq) -> Dict[str, Any]:
    task = TASKS.get(tid)
    if not task:
        raise HTTPException(404, f"no such task {tid}")
    if task.status not in ("completed", "succeeded"):
        raise HTTPException(409, f"task {tid} not complete")
    if req.mode not in RENDER_MODES:
        raise HTTPException(422, f"mode must be one of {RENDER_MODES}")
    from . import render as rr
    n = max(1, min(64, req.nviews or 8))
    images_b64, video_b64 = rr.render_mesh(task.glb_path, mode=req.mode, nviews=n,
                                                video=bool(req.video), out_root=str(OUT_ROOT / tid))
    return {"images": [f"data:image/png;base64,{b}" for b in images_b64],
            "video": ([f"data:image/mp4;base64,{b}" for b in video_b64] if req.video else None),
            "note": f"rendered {n} frame(s) (mode={req.mode})"}


@app.post("/tasks/{tid}/remesh")
def remesh(tid: str, req: RemeshReq) -> Dict[str, Any]:
    task = TASKS.get(tid)
    if not task:
        raise HTTPException(404, f"no such task {tid}")
    from . import convert
    dest = req.dest or str(Path(task.glb_path).parent / f"{tid}_remesh.glb")
    before, after, path = convert.decimate_remesh(task.glb_path, face_budget=req.face_budget,
                                                          remesh=bool(req.remesh), dest=dest)
    return {"path": path, "faces_before": before, "faces_after": after}


@app.post("/texturize")
def texturize(req: TexturizeReq) -> Dict[str, Any]:
    tid = "tx-" + uuid.uuid4().hex[:8]
    task = Task(id=tid, image=req.image, label=req.label, status="pending", stage="queued")
    TASKS[tid] = task
    USAGE["total_generated"] += 1
    USAGE["credits_used"] += 1
    USAGE["last_task_id"] = tid
    USAGE["last_task_at"] = _now()
    asyncio.get_event_loop().create_task(_run_texturize(tid, req))
    return {"id": tid, "status": task.status}


async def _run_texturize(tid: str, req: TexturizeReq) -> None:
    task = TASKS.get(tid)
    if not task:
        return
    try:
        global PIPELINE_LOADED
        if not PIPELINE_LOADED:
            from . import pipeline
            await asyncio.to_thread(pipeline.ensure_pipeline)
            PIPELINE_LOADED = True
        task.status = "running"
        task.stage = "generating PBR textures"
        from . import pipeline
        out = await asyncio.to_thread(pipeline.run_texturize,
                                            image=req.image, shape_src=req.shape_src)
        glb_dir = OUT_ROOT / tid
        glb_dir.mkdir(parents=True, exist_ok=True)
        glb_path = glb_dir / "textured.glb"
        glb_path.write_bytes(out["glb_bytes"])
        task.glb_path = str(glb_path)
        glb_size = glb_path.stat().st.size
        task.sizes = {f: max(1, int(glb_size * k)) for f, k in
                         (("glb", 1.0), ("stl", 0.5), ("obj", 0.6), ("fbx", 0.88), ("usdz", 1.0))}
        task.status = "completed"
        task.stage = "done"
        task.progress = 1.0
        task.finished_at = _now()
        store.record_completed(
            model_id=task.model_id, label=task.label, ts=task.finished_at,
            num_formats=len(task.formats),
            total_bytes=int(sum(task.sizes.values()) or 0),
        )
    except Exception as e:
        task.status = "failed"
        task.error = f"{type(e).__name__}: {e}"
        task.finished_at = _now()


@app.get("/gallery")
def gallery(limit: int = Query(24, ge=1, le=200)) -> Dict[str, Any]:
    items: List[Dict[str, Any]] = []
    # Completed tasks (newest first).
    completed = [t for t in TASKS.values() if t.status in ("completed", "succeeded")]
    completed.sort(key=lambda t: (t.finished_at or t.created_at), reverse=True)
    for t in completed[:limit]:
        items.append({
            "id": t.id,
            "label": t.label or (Path(t.image).name if t.image else None),
            "created_at": t.created_at,
            "model_id": t.model_id,
            "formats": t.formats,
            "thumbnail": t._preview_data_url(),
            "input_image": _img_to_data_url(t.image),
        })
    # Merge persisted-history entries (survive a restart) into the
    # gallery, synthesized with a stable id. Only pad when in-memory
    # has nothing (avoids a duplicate live view of the same model).
    if not items:
        existing_ids = set()
        for h in store.read_history(limit=limit):
            hid = f"hist-{h.get('ts')}-{h.get('model_id')}"
            if hid in existing_ids:
                continue
            existing_ids.add(hid)
            items.append({
                "id": hid,
                "label": h.get("label"),
                "created_at": h.get("ts"),
                "model_id": h.get("model_id"),
                "formats": [],
                "thumbnail": None,
                "input_image": None,
            })
    return {"items": items}


def _img_to_data_url(img: Optional[str]) -> Optional[str]:
    if not img:
        return None
    if img.startswith("data:"):
        return img
    p = Path(img)
    if p.exists():
        ext = p.suffix.lstrip(".").lower() or "png"
        b64 = base64.b64encode(p.read_bytes()).decode()
        return f"data:image/{'svg+xml' if ext=='svg' else ext};base64,{b64}"
    return img  # URL — pass through


@app.get("/usage")
def usage() -> Dict[str, Any]:
    out = dict(USAGE)
    # Reflect the lifetime total: the in-memory count (since this
    # process started) plus any persisted history from prior runs.
    hist = store.read_history(limit=100000)
    summ = store.summarize(hist)
    persisted_count = int(summ.get("count", 0) or 0)
    in_mem = int(out.get("total_generated", 0) or 0)
    out["total_generated"] = max(in_mem, persisted_count)
    out["persisted"] = summ
    if out.get("last_task_at") is None and summ.get("last_ts"):
        out["last_task_at"] = summ["last_ts"]
    return out


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "7861")))
