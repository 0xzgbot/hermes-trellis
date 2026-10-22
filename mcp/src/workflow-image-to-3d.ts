/**
 * workflow-image-to-3d.ts — the PROVEN Trellis.2 image→3D ComfyUI graph.
 *
 * This graph is the exact node wiring that the live ComfyUI 0.42 + Trellis-2 node
 * pack on the DGX Spark accepts (captured from a successful /history run). It was
 * regenerated from the server itself rather than hand-assumed, because the node
 * input names and model filenames differ from the naive guesses:
 *
 *   - KSampler uses `sampler_name` + `latent_image` (not `sampler`/`latent`)
 *   - SaveGLB / SaveImage use `filename_prefix` (not `filename`)
 *   - Trellis2Conditioning uses `clip_vision_model` (not `clip`)
 *   - RemoveBackground uses `bg_removal_model` (not `model`)
 *   - EmptyTrellis2LatentStructure uses `batch_size` (not `batch`)
 *   - ImageCropToMask uses `images`/`masks`/`pad_factor` (not `image`/`pad`)
 *   - model files: trellis_2_int8_convrot / trellis_2_shape_vae_bf16 /
 *     trellis_2_texture_vae_bf16 / dino_v3_L_naf_fp32 / birefnet
 *
 * Flow: load image -> background removal (BiRefNet) -> crop to mask
 *   -> Trellis2 conditioning (DINOv3 CLIP-vision, pos/neg)
 *   -> SPARSE STRUCTURE (KSampler -> VaeDecodeStructureTrellis2 -> VoxelToMesh)
 *   -> SHAPE (Trellis2ShapeStage -> KSampler -> VaeDecodeShapeTrellis)
 *   -> HIGH-RES UPSAMPLE (Trellis2UpsampleStage -> KSampler -> VaeDecodeShapeTrellis)
 *   -> PBR TEXTURE (Trellis2TextureStage -> KSampler -> VaeDecodeTextureTrellis
 *        -> BakeTextureFromVoxel -> ApplyTextureToMesh)
 *   -> CAPTURE: SaveGLB (raw) + SaveGLB (final textured) + SaveGLB (painted)
 *
 * Placeholders (substituted by `fillImageTo3DWorkflow` at submit time):
 *   {{CONDITIONING_IMAGE}} -> the server-side filename of the uploaded image
 *   {{RESOLUTION}}         -> Trellis2UpsampleStage.target_resolution only (512/1024/1536).
 *                            Crop and UV atlas stay at 1024, matching a live 1536 run.
 *   {{SEED:n}}             -> seed + n (0 is a valid seed; it is not replaced)
 *
 * `CAPTURE_NODES` is the `output` list sent to `POST /api/prompt`: the node ids
 * whose products ComfyUI retains (and we later fetch via /history + /view).
 */

export type WorkflowInputs = Record<string, unknown>;
export interface WorkflowNode {
  class_type: string;
  inputs: WorkflowInputs;
}
/** A ComfyUI workflow graph: node-id -> node (class_type + wired inputs). */
export type ComfyWorkflow = Record<string, WorkflowNode>;

/** The proven Trellis.2 image→3D pipeline as a ComfyUI node graph (regenerated from the live server). */
export const IMAGE_TO_3D_WORKFLOW: ComfyWorkflow = {
  "91": { class_type: "Trellis2ShapeStage", inputs: { "positive": ["314", 0], "negative": ["315", 0], "voxel": ["119", 0] } },
  "207": { class_type: "PreviewImage", inputs: { "images": ["147", 1] } },
  "208": { class_type: "PreviewImage", inputs: { "images": ["147", 2] } },
  "164": { class_type: "PreviewImage", inputs: { "images": ["147", 0] } },
  "118": { class_type: "VAELoader", inputs: { "vae_name": "trellis_2_texture_vae_bf16.safetensors" } },
  "93": { class_type: "VaeDecodeTextureTrellis", inputs: { "samples": ["12", 0], "vae": ["118", 0], "shape_subdivides": ["92", 1] } },
  "15": { class_type: "CLIPVisionLoader", inputs: { "clip_name": "dino_v3_L_naf_fp32.safetensors" } },
  "202": { class_type: "GetMeshInfo", inputs: { "mesh": ["92", 0] } },
  "261": { class_type: "RenderUVAtlas", inputs: { "mesh": ["196", 0], "resolution": 1024 } },
  "262": { class_type: "PreviewImage", inputs: { "images": ["261", 0] } },
  "12": { class_type: "KSampler", inputs: { "model": ["318", 0], "seed": "{{SEED:1}}", "steps": 50, "cfg": 1.0, "sampler_name": "euler", "scheduler": "normal", "positive": ["98", 0], "negative": ["98", 1], "latent_image": ["98", 2], "denoise": 1.0 } },
  "210": { class_type: "ApplyTextureToMesh", inputs: { "mesh": ["196", 0], "base_color": ["164", 0], "metallic": ["207", 0], "roughness": ["208", 0], "occlusion": ["235", 0], "normal_map": ["226", 0] } },
  "147": { class_type: "BakeTextureFromVoxel", inputs: { "mesh": ["196", 0], "voxel_colors": ["93", 0], "texture_size": ["288", 0], "reference_mesh": ["92", 0] } },
  "288": { class_type: "PrimitiveInt", inputs: { "value": 4096 } },
  "238": { class_type: "MeshSmoothNormals", inputs: { "mesh": ["186", 0], "crease_angle": 180.0 } },
  "18": { class_type: "KSampler", inputs: { "model": ["126", 0], "seed": "{{SEED:0}}", "steps": 50, "cfg": 7.5, "sampler_name": "euler", "scheduler": "normal", "positive": ["91", 0], "negative": ["91", 1], "latent_image": ["91", 2], "denoise": 1.0 } },
  "252": { class_type: "PaintMesh", inputs: { "mesh": ["238", 0], "voxel_colors": ["93", 0] } },
  "279": { class_type: "CFGOverride", inputs: { "model": ["318", 0], "cfg": 1.0, "start_percent": 0.769, "end_percent": 1.0 } },
  "126": { class_type: "RescaleCFG", inputs: { "model": ["279", 0], "multiplier": 0.5 } },
  "192": { class_type: "RemoveBackground", inputs: { "bg_removal_model": ["193", 0], "image": ["122", 0] } },
  "248": { class_type: "ComfySwitchNode", inputs: { "switch": true, "on_false": ["122", 1], "on_true": ["192", 0] } },
  "303": { class_type: "MaskPreview", inputs: { "mask": ["248", 0] } },
  "302": { class_type: "PreviewImage", inputs: { "images": ["312", 0] } },
  "119": { class_type: "VaeDecodeStructureTrellis2", inputs: { "samples": ["3", 0], "vae": ["117", 0], "resolution": "32" } },
  "4": { class_type: "VoxelToMesh", inputs: { "voxel": ["119", 0], "algorithm": "basic", "threshold": 0.6 } },
  "247": { class_type: "MeshToFile3D", inputs: { "mesh": ["4", 0] } },
  "3": { class_type: "KSampler", inputs: { "model": ["108", 0], "seed": "{{SEED:14}}", "steps": 50, "cfg": 7.5, "sampler_name": "euler", "scheduler": "normal", "positive": ["314", 0], "negative": ["315", 0], "latent_image": ["87", 0], "denoise": 1.0 } },
  "125": { class_type: "RescaleCFG", inputs: { "model": ["199", 0], "multiplier": 0.7 } },
  "199": { class_type: "CFGOverride", inputs: { "model": ["318", 0], "cfg": 1.0, "start_percent": 0.667, "end_percent": 1.0 } },
  "108": { class_type: "ModelSamplingSD3", inputs: { "model": ["125", 0], "shift": 5.0 } },
  "94": { class_type: "Trellis2UpsampleStage", inputs: { "positive": ["91", 0], "negative": ["91", 1], "shape_latent": ["18", 0], "vae": ["117", 0], "target_resolution": "{{RESOLUTION}}" } },
  "233": { class_type: "BakeAmbientOcclusion", inputs: { "low_poly": ["196", 0], "high_poly": ["241", 0], "resolution": 1024, "samples": 64, "max_distance": 0.71, "strength": 1.0, "bias": 0.01 } },
  "224": { class_type: "BakeNormalMapFromMesh", inputs: { "low_poly": ["196", 0], "high_poly": ["241", 0], "resolution": 2048, "cage_distance": 0.05, "ignore_backfaces": true } },
  "226": { class_type: "PreviewImage", inputs: { "images": ["224", 0] } },
  "235": { class_type: "PreviewImage", inputs: { "images": ["233", 0] } },
  "241": { class_type: "RemeshMesh", inputs: { "mesh": ["202", 0], "resolution": 1536, "sign_mode": "solid", "sign_mode.fill": 20.0, "sign_mode.qef": false, "band": 1.0, "project_back": 0.0, "fix_poles": false, "smooth_iters": 20, "drop_small_components": 0.01, "precluster_max_verts": 20000000 } },
  "186": { class_type: "DecimateMesh", inputs: { "mesh": ["241", 0], "target_face_count": 1000000, "placement_mode": "midpoint" } },
  "196": { class_type: "UnwrapMesh", inputs: { "mesh": ["238", 0], "segmenter": "pec", "resolution": ["288", 0], "padding": 1, "weld_distance": 0.0002 } },
  "117": { class_type: "VAELoader", inputs: { "vae_name": "trellis_2_shape_vae_bf16.safetensors" } },
  "55": { class_type: "LoadMoGeModel", inputs: { "model_name": "moge_2_vitl_normal_fp16.safetensors" } },
  "193": { class_type: "LoadBackgroundRemovalModel", inputs: { "bg_removal_name": "birefnet.safetensors" } },
  "56": { class_type: "MoGeInference", inputs: { "moge_model": ["55", 0], "image": ["302", 0], "resolution_level": 9, "fov_x_degrees": 0.0, "batch_size": 4, "force_projection": true, "apply_mask": true, "refine_steps": 3 } },
  "242": { class_type: "MoGeGeometryToFOV", inputs: { "moge_geometry": ["56", 0], "axis": "horizontal", "unit": "degrees" } },
  "299": { class_type: "Trellis2Conditioning", inputs: { "clip_vision_model": ["15", 0], "image": ["302", 0] } },
  "298": { class_type: "Pixal3DConditioning", inputs: { "clip_vision_model": ["15", 0], "image": ["302", 0], "camera_angle_x": ["242", 0] } },
  "92": { class_type: "VaeDecodeShapeTrellis", inputs: { "samples": ["23", 0], "vae": ["117", 0] } },
  "40": { class_type: "UNETLoader", inputs: { "unet_name": "trellis_2_int8_convrot.safetensors", "weight_dtype": "default" } },
  "98": { class_type: "Trellis2TextureStage", inputs: { "positive": ["94", 0], "negative": ["94", 1], "shape_latent": ["23", 0] } },
  "282": { class_type: "MeshToFile3D", inputs: { "mesh": ["252", 0] } },
  "260": { class_type: "MeshSmoothNormals", inputs: { "mesh": ["210", 0], "crease_angle": 180.0 } },
  "285": { class_type: "MeshToFile3D", inputs: { "mesh": ["260", 0] } },
  "87": { class_type: "EmptyTrellis2LatentStructure", inputs: { "batch_size": 1 } },
  "23": { class_type: "KSampler", inputs: { "model": ["126", 0], "seed": "{{SEED:0}}", "steps": 50, "cfg": 7.5, "sampler_name": "euler", "scheduler": "simple", "positive": ["94", 0], "negative": ["94", 1], "latent_image": ["94", 2], "denoise": 1.0 } },
  "122": { class_type: "LoadImage", inputs: { "image": "{{CONDITIONING_IMAGE}}" } },
  "312": { class_type: "ImageCropToMask", inputs: { "images": ["122", 0], "masks": ["303", 0], "width": 1024, "height": 1024, "pad_factor": 1.1, "grow_mask": 0, "background": "#000000" } },
  "314": { class_type: "ComfySwitchNode", inputs: { "switch": ["316", 0], "on_false": ["298", 0], "on_true": ["299", 0] } },
  "315": { class_type: "ComfySwitchNode", inputs: { "switch": ["316", 0], "on_false": ["298", 1], "on_true": ["299", 1] } },
  "316": { class_type: "PrimitiveBoolean", inputs: { "value": true } },
  "318": { class_type: "ComfySwitchNode", inputs: { "switch": ["316", 0], "on_false": ["319", 0], "on_true": ["40", 0] } },
  "319": { class_type: "UNETLoader", inputs: { "unet_name": "pixal3d_int8_convrot.safetensors", "weight_dtype": "default" } },
  "save_raw_glb": { class_type: "SaveGLB", inputs: { "mesh": ["247", 0], "filename_prefix": "3d/trellis2_raw_structure" } },
  "save_final_glb": { class_type: "SaveGLB", inputs: { "mesh": ["285", 0], "filename_prefix": "3d/trellis2_textured" } },
  "save_painted_glb": { class_type: "SaveGLB", inputs: { "mesh": ["282", 0], "filename_prefix": "3d/trellis2_painted" } },
};

/** The node ids whose products we want ComfyUI to retain + serve (the `output` list). */
export const CAPTURE_NODES = ["save_raw_glb", "save_final_glb", "save_painted_glb"];

export interface FillImageTo3DParams {
  /** The (server-side) filename of the uploaded conditioning image. */
  image: string;
  /** Target 3D resolution bucket: 512 | 1024 | 1536. */
  resolution: number;
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
  const resNum = Number(params.resolution);
  const res = Number.isFinite(resNum) && resNum > 0 ? resNum : 1536;
  const baseSeed = Number.isFinite(Number(params.seed)) ? Number(params.seed) : 42;
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
