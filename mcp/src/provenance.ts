/**
 * One JSON file of print jobs next to the downloads. No images are stored,
 * only paths and the numbers the slicer cares about.
 */

import fs from "node:fs";
import path from "node:path";

export interface ProvenanceRecord {
  task_id: string;
  at: string;
  label?: string;
  seed?: number;
  resolution?: number | string;
  image?: string;
  glb?: string;
  stl?: string;
  faces_after?: number;
  watertight_after?: boolean;
  extents?: number[];
  height_mm?: number | null;
}

function fileFor(dir: string): string {
  return path.join(dir, "provenance.json");
}

export function remember(dir: string, patch: ProvenanceRecord): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = fileFor(dir);
  let rows: ProvenanceRecord[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) rows = parsed;
  } catch {
    rows = [];
  }
  const idx = rows.findIndex((r) => r.task_id === patch.task_id);
  if (idx >= 0) rows[idx] = { ...rows[idx], ...patch, at: rows[idx].at || patch.at };
  else rows.unshift(patch);
  fs.writeFileSync(file, JSON.stringify(rows.slice(0, 500), null, 2));
}

export function readProvenance(dir: string): ProvenanceRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(fileFor(dir), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
