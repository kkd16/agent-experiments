// Toy 2-D *densities* for the normalizing-flow lab. Unlike the playground's classification
// sets these carry no labels — the flow's whole job is to learn the unlabelled probability
// density that the points are drawn from. Each generator returns a point cloud, which is then
// standardised to zero-mean / unit-variance so the base N(0, I) prior is a sensible target and
// training is well-conditioned regardless of the raw shape's scale. Everything is deterministic
// given a seed.

import { mulberry32 } from './nn';

export type FlowDatasetKind =
  | 'moons'
  | 'circles'
  | 'pinwheel'
  | 'spirals'
  | 'grid'
  | 'checkerboard'
  | 'gaussian';

export interface FlowDataset {
  X: Float64Array; // [n*2], standardised
  n: number;
  kind: FlowDatasetKind;
}

function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Standardise in place: subtract the mean and divide by the std of each axis.
function standardize(X: Float64Array, n: number): void {
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += X[i * 2];
    my += X[i * 2 + 1];
  }
  mx /= n;
  my /= n;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < n; i++) {
    vx += (X[i * 2] - mx) ** 2;
    vy += (X[i * 2 + 1] - my) ** 2;
  }
  const sx = Math.sqrt(vx / n) || 1;
  const sy = Math.sqrt(vy / n) || 1;
  for (let i = 0; i < n; i++) {
    X[i * 2] = (X[i * 2] - mx) / sx;
    X[i * 2 + 1] = (X[i * 2 + 1] - my) / sy;
  }
}

export function makeFlowDataset(kind: FlowDatasetKind, n: number, noise: number, seed: number): FlowDataset {
  const rng = mulberry32(seed);
  const X = new Float64Array(n * 2);
  const jit = () => randn(rng) * noise;

  switch (kind) {
    case 'moons': {
      for (let i = 0; i < n; i++) {
        const top = i % 2 === 0;
        const t = rng() * Math.PI;
        if (top) {
          X[i * 2] = Math.cos(t) - 0.5 + jit();
          X[i * 2 + 1] = Math.sin(t) - 0.25 + jit();
        } else {
          X[i * 2] = 0.5 - Math.cos(t) + jit();
          X[i * 2 + 1] = 0.25 - Math.sin(t) + jit();
        }
      }
      break;
    }
    case 'circles': {
      for (let i = 0; i < n; i++) {
        const r = (i % 2 === 0 ? 0.45 : 1.0) + jit() * 0.6;
        const t = rng() * 2 * Math.PI;
        X[i * 2] = r * Math.cos(t);
        X[i * 2 + 1] = r * Math.sin(t);
      }
      break;
    }
    case 'pinwheel': {
      // Five swirling arms — radius grows along each arm while the angle winds with it.
      const arms = 5;
      const swirl = 1.7;
      for (let i = 0; i < n; i++) {
        const arm = i % arms;
        const r = Math.sqrt(rng()) * 1.6 + 0.05;
        const base = (arm / arms) * 2 * Math.PI;
        const ang = base + r * swirl + randn(rng) * (0.12 + noise);
        X[i * 2] = r * Math.cos(ang);
        X[i * 2 + 1] = r * Math.sin(ang);
      }
      break;
    }
    case 'spirals': {
      // Two intertwined Archimedean spirals.
      for (let i = 0; i < n; i++) {
        const branch = i % 2 === 0 ? 0 : Math.PI;
        const r = (i / n) * 1.6 + 0.1;
        const t = r * 4 + branch + jit() * 0.6;
        X[i * 2] = r * Math.cos(t) + jit() * 0.3;
        X[i * 2 + 1] = r * Math.sin(t) + jit() * 0.3;
      }
      break;
    }
    case 'grid': {
      // A 3×3 lattice of Gaussian blobs.
      for (let i = 0; i < n; i++) {
        const gx = i % 3;
        const gy = Math.floor(i / 3) % 3;
        X[i * 2] = (gx - 1) * 1.2 + randn(rng) * (0.1 + noise * 0.6);
        X[i * 2 + 1] = (gy - 1) * 1.2 + randn(rng) * (0.1 + noise * 0.6);
      }
      break;
    }
    case 'checkerboard': {
      // Rejection-sample the 2-colour parity pattern over a [-2,2]² board.
      let i = 0;
      let guard = 0;
      while (i < n && guard < n * 200) {
        guard++;
        const x = rng() * 4 - 2;
        const y = rng() * 4 - 2;
        const cx = Math.floor(x + 2);
        const cy = Math.floor(y + 2);
        if ((cx + cy) % 2 === 0) {
          X[i * 2] = x + jit() * 0.5;
          X[i * 2 + 1] = y + jit() * 0.5;
          i++;
        }
      }
      for (; i < n; i++) {
        X[i * 2] = rng() * 4 - 2;
        X[i * 2 + 1] = rng() * 4 - 2;
      }
      break;
    }
    case 'gaussian': {
      // A single anisotropic, rotated Gaussian — the easy sanity check.
      const c = Math.cos(0.6);
      const s = Math.sin(0.6);
      for (let i = 0; i < n; i++) {
        const a = randn(rng) * 1.4;
        const b = randn(rng) * 0.5;
        X[i * 2] = c * a - s * b;
        X[i * 2 + 1] = s * a + c * b;
      }
      break;
    }
  }

  standardize(X, n);
  return { X, n, kind };
}

export const FLOW_DATASETS: { id: FlowDatasetKind; label: string }[] = [
  { id: 'moons', label: 'Two moons' },
  { id: 'pinwheel', label: 'Pinwheel' },
  { id: 'spirals', label: 'Two spirals' },
  { id: 'circles', label: 'Concentric circles' },
  { id: 'grid', label: '3×3 Gaussian grid' },
  { id: 'checkerboard', label: 'Checkerboard' },
  { id: 'gaussian', label: 'Rotated Gaussian' },
];
