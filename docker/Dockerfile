# ---------------------------------------------------------------------------
# Dockerfile — the Trellis REST "bridge" (FastAPI), layered ON TOP of your
# existing Trellis runtime.
#
# Your DGX already runs the Trellis stack (dr-vij/Trellis2-DGX-Spark-Docker,
# Gradio on :7860). That image already has everything the pipeline
# needs (CUDA, the conda `trellis2` env, torch, trellis2, o_voxel, nvdiffrast,
# flash-attn, flexgemm, ...). We just add the thin HTTP front
# (fastapi/uvicorn/trimesh/scipy) + our `trellis_api` package on top, and
# expose it on a SEPARATE port (:7861) so it never collides with the
# Gradio UI (:7860).
#
# BUILD (on the DGX, from this repo root):
#   docker build -t hermes-trellis-bridge \
#     --build-arg BASE_IMAGE=<your-trellis-image> -f docker/Dockerfile docker/
#
#   <your-trellis-image> = the image the Gradio app runs in
#   (e.g. the one built by dr-vij/Trellis2-DGX-Spark-Docker). If your bridge
#   and the Gradio app share the SAME Trellis runtime, use the same
#   base image for both.
# ---------------------------------------------------------------------------

ARG BASE_IMAGE=nvcr.io/nvidia/dgx/trellis2:latest
FROM ${BASE_IMAGE}

# Run as the bridge (non-root is ideal; keep root for simplicity —
# tighten for production). The conda `trellis2` env is inherited from the
# base image.
ENV PATH="/opt/conda/envs/trellis2/bin:${PATH}"
ENV PYTHONUNBUFFERED=1
ENV PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
ENV OPENCV_IO_ENABLE_OPENEXR=1

# The bridge speaks the HTTP API on a port separate from Gradio.
ENV HOST=0.0.0.0
ENV PORT=7861

# Add the web/API + conversion deps to the existing trellis env.
# (fastapi + uvicorn serve the API; trimesh + numpy + shapery + pillow do
#  the mesh work; scipy powers the built-in decimation; and
#  fast-simplification (optional) gives the highest-quality quadric
#  decimation.)
RUN pip install --no-cache-dir \
      fastapi "uvicorn[standard]" \
      "trimesh[easy]" pillow numpy shapely scipy \
    && pip install --no-cache-dir fast-simplification \
    || pip install --no-cache-dir fast-simplification==0.1.9

WORKDIR /workspace/TRELLIS.2

# Copy the bridge in as an importable package `trellis_api` (underscore,
# so `uvicorn trellis_api.main:app` resolves). The source dir is
# `docker/trellis-api` (hyphen) — its contents become the package.
COPY trellis-api/ /workspace/TRELLIS.2/trellis_api/

# Where the bridge writes produced assets (mounted so the host can
# collect them).
ENV TRELLIS_BRIDGE_OUT=/workspace/out
VOLUME ["/workspace/out"]

EXPOSE 7861

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=4 \
  CMD python -c "import urllib.request,sys; \
      urllib.request.urlopen('http://127.0.0.1:7861/health', timeout=8); \
      sys.exit(0)" || exit 1

# Launch the bridge.
CMD ["python", "-m", "uvicorn", "trellis_api.main:app", "--host", "0.0.0.0", "--port", "7861", "--workers", "1"]
