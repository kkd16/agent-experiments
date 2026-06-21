// Procedural image datasets — a self-contained, dependency-free stand-in for MNIST.
//
// Each class is defined by a set of strokes (polylines in the unit square). To make a
// sample we rasterize those strokes onto a small grid through a random affine transform
// (rotation, scale, translation) with a random stroke thickness and per-pixel noise, so
// every draw is a fresh "handwritten" variation. Everything is deterministic given a seed,
// and the whole pipeline is pure math — no canvas, no network, no bundled data files.

import { mulberry32 } from './nn';

export type VisionDatasetKind = 'shapes' | 'digits';

export interface ImageDataset {
  X: Float64Array; // [n * (H*W)] pixel intensities, background ≈ -0.5, ink ≈ +0.5
  y: Int32Array; // [n] class index
  n: number;
  classes: number;
  labels: string[];
  size: number; // H = W
}

type Pt = [number, number];
type Stroke = Pt[];

function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Polyline approximation of a circular arc, center (cx,cy), radii (rx,ry), angles a0..a1.
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, segs = 16): Stroke {
  const pts: Stroke = [];
  for (let i = 0; i <= segs; i++) {
    const t = a0 + (a1 - a0) * (i / segs);
    pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return pts;
}

const TAU = Math.PI * 2;

// ---- glyph definitions (unit square, y grows downward) ------------------------------

const DIGITS: Stroke[][] = [
  /* 0 */ [arc(0.5, 0.5, 0.23, 0.35, 0, TAU, 28)],
  /* 1 */ [[[0.37, 0.28], [0.5, 0.16]], [[0.5, 0.16], [0.5, 0.85]], [[0.36, 0.85], [0.64, 0.85]]],
  /* 2 */ [[[0.28, 0.32], [0.34, 0.2], [0.5, 0.15], [0.66, 0.2], [0.72, 0.34], [0.62, 0.5], [0.42, 0.62], [0.3, 0.74], [0.28, 0.85]], [[0.28, 0.85], [0.74, 0.85]]],
  /* 3 */ [[[0.3, 0.21], [0.5, 0.15], [0.68, 0.24], [0.6, 0.42], [0.46, 0.5]], [[0.46, 0.5], [0.64, 0.57], [0.7, 0.72], [0.5, 0.85], [0.3, 0.79]]],
  /* 4 */ [[[0.62, 0.15], [0.26, 0.62], [0.76, 0.62]], [[0.62, 0.15], [0.62, 0.85]]],
  /* 5 */ [[[0.7, 0.16], [0.32, 0.16], [0.3, 0.46], [0.5, 0.42], [0.66, 0.5], [0.68, 0.68], [0.5, 0.85], [0.3, 0.8]]],
  /* 6 */ [[[0.66, 0.2], [0.46, 0.15], [0.32, 0.34], [0.28, 0.6], [0.3, 0.78], [0.5, 0.86], [0.68, 0.76], [0.7, 0.58], [0.52, 0.5], [0.34, 0.56]]],
  /* 7 */ [[[0.28, 0.16], [0.72, 0.16], [0.46, 0.85]]],
  /* 8 */ [arc(0.5, 0.32, 0.18, 0.18, 0, TAU, 22), arc(0.5, 0.66, 0.22, 0.2, 0, TAU, 24)],
  /* 9 */ [[[0.66, 0.44], [0.48, 0.5], [0.3, 0.42], [0.32, 0.24], [0.5, 0.14], [0.7, 0.22], [0.72, 0.4], [0.68, 0.66], [0.54, 0.84], [0.34, 0.8]]],
];

const SHAPES: Stroke[][] = [
  /* circle   */ [arc(0.5, 0.5, 0.32, 0.32, 0, TAU, 36)],
  /* square   */ [[[0.22, 0.22], [0.78, 0.22], [0.78, 0.78], [0.22, 0.78], [0.22, 0.22]]],
  /* triangle */ [[[0.5, 0.15], [0.83, 0.82], [0.17, 0.82], [0.5, 0.15]]],
  /* cross    */ [[[0.22, 0.22], [0.78, 0.78]], [[0.78, 0.22], [0.22, 0.78]]],
];

const SHAPE_LABELS = ['circle', 'square', 'triangle', 'cross'];
const DIGIT_LABELS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

// Squared distance from point p to segment a–b.
function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return Math.sqrt(ex * ex + ey * ey);
}

// Rasterize one glyph (list of strokes) into a size×size intensity grid in [0,1], applying
// the affine (rotation θ, scale s, translation tx,ty) about the unit-square center, with the
// given stroke half-thickness and a soft anti-aliased edge of width `aa`.
function rasterize(
  strokes: Stroke[][],
  cls: number,
  size: number,
  theta: number,
  s: number,
  tx: number,
  ty: number,
  thickness: number,
  out: Float64Array,
): void {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const aa = 1.1 / size;
  const segs = strokes[cls];
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      // pixel center in unit coords, then inverse-transform into glyph space
      let px = (ox + 0.5) / size - 0.5 - tx;
      let py = (oy + 0.5) / size - 0.5 - ty;
      const rx = (px * cos + py * sin) / s + 0.5;
      const ry = (-px * sin + py * cos) / s + 0.5;
      px = rx;
      py = ry;
      let best = Infinity;
      for (const poly of segs) {
        for (let i = 0; i + 1 < poly.length; i++) {
          const d = distToSeg(px, py, poly[i][0], poly[i][1], poly[i + 1][0], poly[i + 1][1]);
          if (d < best) best = d;
          if (best <= 0) break;
        }
      }
      let ink: number;
      if (best <= thickness) ink = 1;
      else if (best <= thickness + aa) ink = 1 - (best - thickness) / aa;
      else ink = 0;
      out[oy * size + ox] = ink;
    }
  }
}

export function datasetMeta(kind: VisionDatasetKind): { classes: number; labels: string[] } {
  return kind === 'digits'
    ? { classes: 10, labels: DIGIT_LABELS }
    : { classes: SHAPE_LABELS.length, labels: SHAPE_LABELS };
}

export function makeImageDataset(
  kind: VisionDatasetKind,
  n: number,
  noise: number,
  jitter: number,
  size: number,
  seed: number,
): ImageDataset {
  const rng = mulberry32(seed);
  const strokes = kind === 'digits' ? DIGITS : SHAPES;
  const { classes, labels } = datasetMeta(kind);
  const X = new Float64Array(n * size * size);
  const y = new Int32Array(n);
  const tmp = new Float64Array(size * size);
  const maxRot = (kind === 'digits' ? 0.32 : 0.5) * jitter; // radians
  const maxShift = 0.12 * jitter;

  for (let i = 0; i < n; i++) {
    const cls = i % classes;
    const theta = (rng() * 2 - 1) * maxRot;
    const s = 1 + (rng() * 2 - 1) * 0.18 * jitter;
    const tx = (rng() * 2 - 1) * maxShift;
    const ty = (rng() * 2 - 1) * maxShift;
    const thickness = 0.055 + rng() * 0.04;
    rasterize(strokes, cls, size, theta, s, tx, ty, thickness, tmp);
    const base = i * size * size;
    for (let p = 0; p < tmp.length; p++) {
      X[base + p] = tmp[p] - 0.5 + gaussian(rng) * noise;
    }
    y[i] = cls;
  }
  return { X, y, n, classes, labels, size };
}

// Center-of-mass crop + rescale of a free-hand drawing so it matches the placement the
// network trained on (glyphs roughly centered and filling the box). Input/out are intensity
// grids in [0,1] (ink high); returns a fresh grid in the model's value range (ink ≈ +0.5).
export function normalizeDrawing(grid: Float64Array, size: number): Float64Array {
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;
  let mass = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (grid[y * size + x] > 0.15) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        mass++;
      }
    }
  }
  const out = new Float64Array(size * size).fill(-0.5);
  if (mass === 0) return out;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const target = size * 0.72;
  const scale = target / Math.max(bw, bh);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      // map output pixel back to the source grid through the inverse of crop+scale+center
      const sx = (ox - size / 2) / scale + cx;
      const sy = (oy - size / 2) / scale + cy;
      const ix = Math.round(sx);
      const iy = Math.round(sy);
      let ink = 0;
      if (ix >= 0 && ix < size && iy >= 0 && iy < size) ink = grid[iy * size + ix];
      out[oy * size + ox] = Math.min(1, ink) - 0.5;
    }
  }
  return out;
}

export const VISION_DATASETS: { id: VisionDatasetKind; label: string }[] = [
  { id: 'shapes', label: 'Shapes (4)' },
  { id: 'digits', label: 'Digits (0–9)' },
];
