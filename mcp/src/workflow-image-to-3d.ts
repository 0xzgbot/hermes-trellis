/**
 * workflow-image-to-3d.ts — the proven Trellis.2 image→3D ComfyUI graph.
 *
 * This is the proven pipeline (reconstructed here as a ComfyUI node graph) that
 * runs the local Trellis.2 (4B) model on the
 * DGX Spark INSIDE standard ComfyUI (the Trellis-2 node classes: Trellis2*,
 * VaeDecode*Trellis, EmptyTrellis2LatentStructure, VoxelToMesh). It turns one
 * conditioning image into a fully-textured 3D asset:
 *
 *   load image → remove background → crop to mask
 *   → Trellis2 conditioning (DINOv3 CLIP-vision, pos/neg)
 *   → SPARSE STRUCTURE: KSampler → VaeDecodeStructureTrellis2 (32³ voxels)
 *       → VoxelToMesh (coarse mesh)
 *   → SHAPE (SLAT): Trellis2ShapeStage → KSampler → VaeDecodeShapeTrellis (256)
 *   → HIGH-RES UP-SAMPLE: Trellis2UpsampleStage (512/1024/1536) → KSampler
 *       → VaeDecodeShapeTrellis (final high-res mesh)
 *   → PBR TEXTURE: Trellis2TextureStage (image-conditioned) → KSampler
 *       → VaeDecodeTextureTrellis (textured mesh: base color + roughness)
 *   → CAPTURE: SaveGLB (raw geometry) + SaveGLB (final textured, PBR)
 *       + RenderMesh → SaveImage (preview PNG).
 *
 * Placeholders (substituted by `fillImageTo3DWorkflow` at submit time):
 *   {{CONDITIONING_IMAGE}}  -> the server-side filename of the uploaded
 *                                    conditioning image (from ComfyUI /upload/image).
 *   {{RESOLUTION}}           -> the target 3D resolution bucket (512/1024/1536).
 *   {{SEED:n}}                   -> seed + n (each diffusion stage is given a
 *                                    distinct, deterministic seed for reproducibility).
 *
 * `CAPTURE_NODES` is the `output` list sent to `POST /api/prompt`: the node ids whose
 * products we want ComfyUI to retain (and later fetch via /history + /view).
 */

export type WorkflowInputs = Record<string, unknown>;
export interface WorkflowNode {
  class_type: string;
  inputs: WorkflowInputs;
}
/** A ComfyUI workflow graph: node-id -> node (class_type + wired inputs). */
export type ComfyWorkflow = Record<string, WorkflowNode>;

/** The proven Trellis.2 image→3D pipeline as a ComfyUI node graph (see the file header for the flow). */
export const IMAGE_TO_3D_WORKFLOW: ComfyWorkflow = {
  // --- Load the conditioning image + prepare it (background removed, cropped) ---
  load_img: { class_type: "LoadImage", inputs: { image: "{{CONDITIONING_IMAGE}}" } },
  bg_model: { class_type: "LoadBackgroundRemovalModel", inputs: { bg_removal_name: "RMBG-2.0" } },
  remove_bg: { class_type: "RemoveBackground", inputs: { model: ["bg_model", 0], image: ["load_img", 0] } },
  crop: { class_type: "ImageCropToMask", inputs: { width: "{{RESOLUTION}}", height: "{{RESOLUTION}}", pad: 0.1, image: ["remove_bg", 0] } },

  // --- Trellis2 conditioning: encode the (cropped) image with a DINOv3 CLIP-vision model ---
  clip_vision: { class_type: "CLIPVisionLoader", inputs: { clip_name: "dinov3_vitl" } },
  trellis_cond: { class_type: "Trellis2Conditioning", inputs: { clip: ["clip_vision", 0], image: ["crop", 0] } },

  // --- Model / VAE loaders (the Trellis.2 UNet + the structure / shape / texture VAEs) ---
  unet: { class_type: "UNETLoader", inputs: { unet_name: "trellis2_4B.safetensors" } },
  struct_vae: { class_type: "VAELoader", inputs: { vae_name: "trellis2_structure_vae.safetensors" } },
  shape_vae: { class_type: "VAELoader", inputs: { vae_name: "trellis2_shape_vae.safetensors" } },
  texture_vae: { class_type: "VAELoader", inputs: { vae_name: "trellis2_texture_vae.safetensors" } },

  // --- STAGE 1: SPARSE STRUCTURE — sample a 32³ voxel occupancy field from noise ---
  struct_latent: { class_type: "EmptyTrellis2LatentStructure", inputs: { resolution: 32, batch: 1 } },
  struct_sample: { class_type: "KSampler", inputs: { model: ["unet", 0], seed: "{{SEED:0}}", steps: 20, cfg: 2.5, sampler: "euler", scheduler: "normal", positive: ["trellis_cond", 0], negative: ["trellis_cond", 1], latent: ["struct_latent", 0], denoise: 1.0 } },
  struct_decode: { class_type: "VaeDecodeStructureTrellis2", inputs: { vae: ["struct_vae", 0], samples: ["struct_sample", 0], resolution: 32 } },
  voxel_mesh: { class_type: "VoxelToMesh", inputs: { voxel: ["struct_decode", 0], resolution: 32 } },

  // --- STAGE 2: SHAPE (SLAT) — refine the coarse mesh to a 256³ structured-latent shape ---
  shape_stage: { class_type: "Trellis2ShapeStage", inputs: { mesh: ["voxel_mesh", 0], resolution: 256 } },
  shape_sample: { class_type: "KSampler", inputs: { model: ["unet", 0], seed: "{{SEED:1}}", steps: 30, cfg: 2.5, sampler: "euler", scheduler: "normal", positive: ["trellis_cond", 0], negative: ["trellis_cond", 1], latent: ["shape_stage", 0], denoise: 1.0 } },
  shape_decode: { class_type: "VaeDecodeShapeTrellis", inputs: { vae: ["shape_vae", 0], samples: ["shape_sample", 0], resolution: 256 } },

  // --- STAGE 3: HIGH-RES UP-SAMPLE — raise the mesh to the target 512/1024/1536 resolution ---
  upsample: { class_type: "Trellis2UpsampleStage", inputs: { mesh: ["shape_decode", 0], resolution: "{{RESOLUTION}}" } },
  upsample_sample: { class_type: "KSampler", inputs: { model: ["unet", 0], seed: "{{SEED:2}}", steps: 30, cfg: 2.0, sampler: "euler", scheduler: "normal", positive: ["trellis_cond", 0], negative: ["trellis_cond", 1], latent: ["upsample", 0], denoise: 0.6 } },
  upsample_decode: { class_type: "VaeDecodeShapeTrellis", inputs: { vae: ["shape_vae", 0], samples: ["upsample_sample", 0], resolution: "{{RESOLUTION}}" } },

  // --- STAGE 4: PBR TEXTURE — paint base color / roughness from the reference image ---
  texture_stage: { class_type: "Trellis2TextureStage", inputs: { mesh: ["upsample_decode", 0], image: ["crop", 0], resolution: "{{RESOLUTION}}" } },
  texture_sample: { class_type: "KSampler", inputs: { model: ["unet", 0], seed: "{{SEED:3}}", steps: 25, cfg: 2.0, sampler: "euler", scheduler: "normal", positive: ["trellis_cond", 0], negative: ["trellis_cond", 1], latent: ["texture_stage", 0], denoise: 0.5 } },
  texture_decode: { class_type: "VaeDecodeTextureTrellis", inputs: { vae: ["texture_vae", 0], samples: ["texture_sample", 0], resolution: "{{RESOLUTION}}" } },

  // --- CAPTURE: save the raw (geometry-only) + the final (textured, PBR) GLBs + a preview render ---
  save_raw_glb: { class_type: "SaveGLB", inputs: { mesh: ["shape_decode", 0], filename: "trellis_raw" } },
  save_final_glb: { class_type: "SaveGLB", inputs: { mesh: ["texture_decode", 0], texture: true, filename: "trellis_final" } },
  render_mesh: { class_type: "RenderMesh", inputs: { mesh: ["texture_decode", 0], resolution: 512, views: 1 } },
  save_render: { class_type: "SaveImage", inputs: { image: ["render_mesh", 0], filename: "trellis_render" } },
};

/** The node ids whose products we want ComfyUI to retain + serve (the `output` list). */
export const CAPTURE_NODES = ["save_raw_glb", "save_final_glb", "save_render"];

/** What `fillImageTo3DWorkflow` substitutes into the template. */
export interface FillImageTo3DParams {
  /** The (server-side) filename of the uploaded conditioning image. */
  image: string;
  /** Target 3D resolution bucket: 512 | 1024 | 1536. */
  resolution: 512 | 1024 | 1536 | number;
  /** Base RNG seed; each diffusion stage derives seed + n deterministically. */
  seed: number;
}

/** Deep-copy a workflow (so filling one does not mutate the shared template). */
function cloneWorkflow(wf: ComfyWorkflow): ComfyWorkflow {
  const out: ComfyWorkflow = {};
  for (const [id, node] of Object.entries(wf)) {
    out[id] = { class_type: node.class_type, inputs: JSON.parse(JSON.stringify(node.inputs)) };
  }
  return out;
}

/**
 * Return a deep copy of `IMAGE_TO_3D_WORKFLOW` with the conditioning image, the
 * resolution bucket, and the per-stage seeds substituted in. Pure: the shared
 * template constant is never mutated by filling.
 */
export function fillImageTo3DWorkflow(params: FillImageTo3DParams): ComfyWorkflow {
  const wf = cloneWorkflow(IMAGE_TO_3D_WORKFLOW);
  const res = Number(params.resolution) || 1024;
  const baseSeed = Number(params.seed) || 42;
  for (const node of Object.values(wf)) {
    const inputs = node.inputs;
    for (const [key, rawVal] of Object.entries(inputs)) {
      if (typeof rawVal !== "string") continue;
      const val = rawVal;
      if (val === "{{CONDITIONING_IMAGE}}") {
        inputs[key] = params.image;
      } else if (val === "{{RESOLUTION}}") {
        inputs[key] = res;
      } else if (val.startsWith("{{SEED:")) {
        const offStr = val.slice("{{SEED:".length);
        const close = offStr.indexOf("}}");
        let off = 0;
        if (close >= 0) {
          const token = offStr.slice(0, close).trim();
          if (token.length > 0 && Number.isInteger(Number(token))) off = Number(token);
        }
        inputs[key] = baseSeed + off;
      }
    }
  }
  return wf;
}
