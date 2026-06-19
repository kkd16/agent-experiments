// A from-scratch software voxel rasteriser — no WebGL, no Three.js. It turns a {@link VoxField}
// into pixels on a 2D canvas with three ideas, all classic and all hand-rolled:
//
//   1. SURFACE EXTRACTION + INTERIOR CULLING. A voxel face is only drawn when the neighbour on
//      that side is empty, so the dense interior of a solid is never touched — the cost tracks
//      the visible surface area, not the volume.
//   2. BACK-FACE CULLING. A face is skipped unless its normal turns toward the camera, halving
//      the surviving faces before we ever sort.
//   3. THE PAINTER'S ALGORITHM. Every surviving face is projected, depth-keyed by its centroid in
//      camera space, sorted far-to-near and filled — convex axis-aligned cubes sort exactly
//      enough by centroid that overlaps resolve correctly.
//
// Shading is Lambert against a fixed *world* light (so the lighting stays glued to the scene as
// you orbit) plus a little ambient, with a hair-line edge of the same shaded colour so abutting
// faces read crisply — the voxel-art look, computed per face.

import { Camera } from './camera';
import { VoxField } from './field';
import { unpack } from './voxel';

// Six faces: outward normal + the four corner offsets (unit-cube local), wound so the quad is a
// simple polygon. Order within a face doesn't matter to a fill; only the set of corners does.
type Face = { n: [number, number, number]; c: [number, number, number][] };
const FACES: Face[] = [
  { n: [1, 0, 0], c: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] }, // +X
  { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] }, // -X
  { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] }, // +Z
  { n: [0, 0, -1], c: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] }, // -Z
  { n: [0, 1, 0], c: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] }, // +Y (top)
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] }, // -Y (bottom)
];

// Fixed scene light (from upper-left-front), normalised; tops catch the most light.
const LX = -0.35;
const LY = 0.86;
const LZ = 0.37;
const AMBIENT = 0.42;

export type RasterStats = { faces: number };

/**
 * Render `field` through `camera` into `ctx` (already sized to `w`×`h`). Returns how many faces
 * were drawn (telemetry). `edge` toggles the hair-line face outline.
 */
export function renderField(
  ctx: CanvasRenderingContext2D,
  field: VoxField,
  camera: Camera,
  w: number,
  h: number,
  edge = true,
): RasterStats {
  camera.center(field.fx / 2, field.fy / 2, field.fz / 2);

  // Collect surviving faces as parallel arrays (avoids a per-face object allocation in the hot
  // loop). Each face stores its four projected screen points, a depth key, and a packed colour.
  const xs: number[] = [];
  const ys: number[] = [];
  const depth: number[] = [];
  const fill: string[] = [];
  let count = 0;

  const { fx, fy, fz, data } = field;
  for (let z = 0; z < fz; z++) {
    for (let y = 0; y < fy; y++) {
      const rowBase = fx * (y + fy * z);
      for (let x = 0; x < fx; x++) {
        const v = data[x + rowBase];
        if (v === 0) continue;
        for (let fi = 0; fi < 6; fi++) {
          const f = FACES[fi];
          // surface test — skip a face buried against another voxel
          if (field.at(x + f.n[0], y + f.n[1], z + f.n[2]) !== 0) continue;
          // back-face cull
          if (camera.facing(f.n[0], f.n[1], f.n[2]) <= 0) continue;
          // project the four corners
          const p0 = camera.project(x + f.c[0][0], y + f.c[0][1], z + f.c[0][2]);
          const p1 = camera.project(x + f.c[1][0], y + f.c[1][1], z + f.c[1][2]);
          const p2 = camera.project(x + f.c[2][0], y + f.c[2][1], z + f.c[2][2]);
          const p3 = camera.project(x + f.c[3][0], y + f.c[3][1], z + f.c[3][2]);
          const dz = (p0.depth + p1.depth + p2.depth + p3.depth) * 0.25;
          const base = count * 4;
          xs[base] = p0.sx;
          ys[base] = p0.sy;
          xs[base + 1] = p1.sx;
          ys[base + 1] = p1.sy;
          xs[base + 2] = p2.sx;
          ys[base + 2] = p2.sy;
          xs[base + 3] = p3.sx;
          ys[base + 3] = p3.sy;
          depth[count] = dz;
          // shade: ambient + Lambert against the fixed world light
          const lambert = Math.max(0, f.n[0] * LX + f.n[1] * LY + f.n[2] * LZ);
          const s = Math.min(1, AMBIENT + (1 - AMBIENT) * lambert);
          const [r, g, b] = unpack(v);
          fill[count] = `rgb(${Math.round(r * s)},${Math.round(g * s)},${Math.round(b * s)})`;
          count++;
        }
      }
    }
  }

  // sort indices far-to-near (smaller camera-z is farther; camera sits on +z)
  const order = new Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  order.sort((a, b) => depth[a] - depth[b]);

  ctx.clearRect(0, 0, w, h);
  ctx.lineJoin = 'round';
  for (let oi = 0; oi < count; oi++) {
    const i = order[oi];
    const base = i * 4;
    ctx.beginPath();
    ctx.moveTo(xs[base], ys[base]);
    ctx.lineTo(xs[base + 1], ys[base + 1]);
    ctx.lineTo(xs[base + 2], ys[base + 2]);
    ctx.lineTo(xs[base + 3], ys[base + 3]);
    ctx.closePath();
    ctx.fillStyle = fill[i];
    ctx.fill();
    if (edge) {
      ctx.strokeStyle = fill[i];
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }
  }

  return { faces: count };
}
