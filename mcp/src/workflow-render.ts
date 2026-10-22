/**
 * Solid turntable for a GLB already on the ComfyUI input folder.
 * Same wiring as a successful RotateMesh → RenderMesh → SaveImage history run.
 * Four yaw angles by default: 0, 90, 180, 270.
 */

import type { ComfyWorkflow } from "./workflow-image-to-3d.js";

export const RENDER_MODES = ["auto", "texture", "vertex colors", "solid", "normal", "depth"] as const;
export type RenderMode = (typeof RENDER_MODES)[number];

export interface SolidViewParams {
  /** Value for Load3DAdvanced.model_file (filename or subfolder/filename). */
  modelFile: string;
  mode: RenderMode;
  nviews: number;
  /** SaveImage prefix without the view index. Views are `${prefix}_view00` … */
  prefix: string;
  width?: number;
  height?: number;
}

export function buildSolidViewWorkflow(params: SolidViewParams): { workflow: ComfyWorkflow; capture: string[] } {
  const n = Math.max(1, Math.min(8, Math.floor(params.nviews)));
  const w = params.width ?? 768;
  const h = params.height ?? 768;
  const wf: ComfyWorkflow = {
    "1": {
      class_type: "Load3DAdvanced",
      inputs: { model_file: params.modelFile, viewport_state: null, width: w, height: h },
    },
    "2": {
      class_type: "Get3DComponents",
      inputs: { model_3d: ["1", 0] },
    },
  };
  const capture: string[] = [];
  for (let i = 0; i < n; i++) {
    const yaw = (360 * i) / n;
    const rid = `r${i}`;
    const mid = `m${i}`;
    const sid = `s${i}`;
    wf[rid] = {
      class_type: "RotateMesh",
      inputs: {
        mesh: ["2", 0],
        mode: "euler_xyz",
        "mode.angle_x": 0,
        "mode.angle_y": yaw,
        "mode.angle_z": 0,
      },
    };
    wf[mid] = {
      class_type: "RenderMesh",
      inputs: {
        mesh: [rid, 0],
        mode: params.mode,
        width: w,
        height: h,
        background: "#000000",
      },
    };
    wf[sid] = {
      class_type: "SaveImage",
      inputs: {
        images: [mid, 0],
        filename_prefix: `${params.prefix}_view${String(i).padStart(2, "0")}`,
      },
    };
    capture.push(sid);
  }
  return { workflow: wf, capture };
}
