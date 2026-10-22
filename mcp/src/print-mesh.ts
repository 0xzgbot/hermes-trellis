/**
 * Spawn mcp/print_mesh.py. TRELLIS_PYTHON selects the interpreter (must have trimesh).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface PrintMeshResult {
  ok: true;
  path: string;
  format: string;
  bytes: number;
  faces_before: number;
  faces_after: number;
  watertight_before: boolean;
  watertight_after: boolean;
  extents_before: number[];
  extents: number[];
  height_mm: number | null;
  repaired: boolean;
  stl_face_count?: number;
  stl_bytes_ok?: boolean;
}

function scriptPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "print_mesh.py");
}

export function pythonBin(): string {
  return process.env.TRELLIS_PYTHON || "python3";
}

export async function convertMesh(opts: {
  src: string;
  dest: string;
  format: "stl" | "obj" | "glb";
  faceBudget?: number;
  heightMm?: number;
  repair?: boolean;
}): Promise<PrintMeshResult> {
  const args = [
    scriptPath(),
    "convert",
    "--src",
    opts.src,
    "--dest",
    opts.dest,
    "--format",
    opts.format,
  ];
  if (opts.faceBudget !== undefined) args.push("--face-budget", String(opts.faceBudget));
  if (opts.heightMm !== undefined) args.push("--height-mm", String(opts.heightMm));
  if (opts.repair) args.push("--repair");

  const py = pythonBin();
  const { code, stdout, stderr } = await run(py, args, 180_000);
  let parsed: { ok?: boolean; error?: string } & Partial<PrintMeshResult> = {};
  try {
    parsed = JSON.parse(stdout.trim().split("\n").pop() || "{}");
  } catch {
    parsed = {};
  }
  if (code !== 0 || !parsed.ok) {
    const detail = parsed.error || stderr.trim() || stdout.trim() || `exit ${code}`;
    throw new Error(`Local mesh conversion failed (${py}). Set TRELLIS_PYTHON to a Python with trimesh. ${detail}`);
  }
  return parsed as PrintMeshResult;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Mesh conversion timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(`Could not run ${cmd}. Set TRELLIS_PYTHON to a Python with trimesh. ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
