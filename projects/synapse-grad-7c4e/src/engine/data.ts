import { mulberry32 } from './nn';

// Toy 2-D datasets. Inputs live in roughly [-1, 1]^2; classification sets carry an
// integer label, regression sets carry a continuous target. Everything is deterministic
// given a seed so the lab is reproducible.

export type ClassDatasetKind =
  | 'spiral'
  | 'circles'
  | 'moons'
  | 'xor'
  | 'gaussians'
  | 'ring'
  | 'checkerboard'
  | 'two-spirals';
export type RegressionKind = 'sine' | 'step' | 'gauss-bump' | 'sawtooth' | 'abs' | 'poly';

export interface ClassDataset {
  X: Float64Array; // [N*2]
  y: Int32Array; // [N]
  n: number;
  classes: number;
}

export interface RegressionDataset {
  X: Float64Array; // [N*1]
  y: Float64Array; // [N*1]
  n: number;
}

function gaussian(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function makeClassDataset(
  kind: ClassDatasetKind,
  n: number,
  noise: number,
  seed: number,
): ClassDataset {
  const rng = mulberry32(seed);
  const X = new Float64Array(n * 2);
  const y = new Int32Array(n);
  const jitter = () => gaussian(rng) * noise;
  let classes = 2;

  switch (kind) {
    case 'spiral': {
      classes = 3;
      const perClass = Math.floor(n / classes);
      let idx = 0;
      for (let c = 0; c < classes; c++) {
        for (let i = 0; i < perClass; i++) {
          const r = i / perClass;
          const t = c * ((2 * Math.PI) / classes) + r * 5 + jitter() * 0.6;
          X[idx * 2] = r * Math.cos(t);
          X[idx * 2 + 1] = r * Math.sin(t);
          y[idx] = c;
          idx++;
        }
      }
      for (; idx < n; idx++) {
        X[idx * 2] = jitter();
        X[idx * 2 + 1] = jitter();
        y[idx] = 0;
      }
      break;
    }
    case 'circles': {
      for (let i = 0; i < n; i++) {
        const inner = i % 2 === 0;
        const r = (inner ? 0.35 : 0.85) + jitter() * 0.4;
        const t = rng() * 2 * Math.PI;
        X[i * 2] = r * Math.cos(t);
        X[i * 2 + 1] = r * Math.sin(t);
        y[i] = inner ? 0 : 1;
      }
      break;
    }
    case 'moons': {
      for (let i = 0; i < n; i++) {
        const top = i % 2 === 0;
        const t = rng() * Math.PI;
        if (top) {
          X[i * 2] = Math.cos(t) - 0.5 + jitter();
          X[i * 2 + 1] = Math.sin(t) - 0.25 + jitter();
          y[i] = 0;
        } else {
          X[i * 2] = 0.5 - Math.cos(t) + jitter();
          X[i * 2 + 1] = 0.25 - Math.sin(t) + jitter();
          y[i] = 1;
        }
      }
      break;
    }
    case 'xor': {
      for (let i = 0; i < n; i++) {
        const x = rng() * 2 - 1;
        const z = rng() * 2 - 1;
        X[i * 2] = x + jitter() * 0.3;
        X[i * 2 + 1] = z + jitter() * 0.3;
        y[i] = x * z > 0 ? 0 : 1;
      }
      break;
    }
    case 'gaussians': {
      classes = 4;
      const centers = [
        [-0.5, -0.5],
        [0.5, -0.5],
        [-0.5, 0.5],
        [0.5, 0.5],
      ];
      for (let i = 0; i < n; i++) {
        const c = i % classes;
        X[i * 2] = centers[c][0] + gaussian(rng) * (0.12 + noise * 0.5);
        X[i * 2 + 1] = centers[c][1] + gaussian(rng) * (0.12 + noise * 0.5);
        y[i] = c;
      }
      break;
    }
    case 'ring': {
      for (let i = 0; i < n; i++) {
        const t = rng() * 2 * Math.PI;
        const blob = rng() < 0.5;
        if (blob) {
          X[i * 2] = gaussian(rng) * (0.18 + noise * 0.4);
          X[i * 2 + 1] = gaussian(rng) * (0.18 + noise * 0.4);
          y[i] = 0;
        } else {
          const r = 0.8 + jitter() * 0.4;
          X[i * 2] = r * Math.cos(t);
          X[i * 2 + 1] = r * Math.sin(t);
          y[i] = 1;
        }
      }
      break;
    }
    case 'checkerboard': {
      // 2-class XOR-of-cells parity over a 4×4 grid — needs a genuinely nonlinear boundary.
      const freq = 2;
      for (let i = 0; i < n; i++) {
        const x = rng() * 2 - 1;
        const z = rng() * 2 - 1;
        X[i * 2] = x + jitter() * 0.2;
        X[i * 2 + 1] = z + jitter() * 0.2;
        const cx = Math.floor((x + 1) * freq);
        const cz = Math.floor((z + 1) * freq);
        y[i] = (cx + cz) % 2;
      }
      break;
    }
    case 'two-spirals': {
      // The classic intertwined double spiral — a hard 2-class benchmark.
      const half = Math.floor(n / 2);
      let idx = 0;
      for (let c = 0; c < 2; c++) {
        for (let i = 0; i < half; i++) {
          const r = (i / half) * 0.95 + 0.05;
          const t = r * 5 + c * Math.PI + jitter() * 0.5;
          X[idx * 2] = r * Math.cos(t);
          X[idx * 2 + 1] = r * Math.sin(t);
          y[idx] = c;
          idx++;
        }
      }
      for (; idx < n; idx++) {
        X[idx * 2] = jitter();
        X[idx * 2 + 1] = jitter();
        y[idx] = 0;
      }
      break;
    }
  }
  return { X, y, n, classes };
}

export function makeRegressionDataset(
  kind: RegressionKind,
  n: number,
  noise: number,
  seed: number,
): RegressionDataset {
  const rng = mulberry32(seed);
  const X = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = rng() * 2 - 1;
    let t: number;
    if (kind === 'sine') t = Math.sin(x * Math.PI * 1.5);
    else if (kind === 'step') t = x < 0 ? -0.6 : 0.6;
    else if (kind === 'gauss-bump') t = Math.exp(-((x * 3) ** 2)) * 1.4 - 0.5;
    else if (kind === 'sawtooth') t = 2 * (x * 1.5 - Math.floor(x * 1.5 + 0.5)) * 0.7;
    else if (kind === 'abs') t = Math.abs(x) * 1.2 - 0.6;
    else t = (4 * x ** 3 - 3 * x) * 0.7; // poly: scaled Chebyshev T3
    X[i] = x;
    y[i] = t + gaussian(rng) * noise;
  }
  return { X, y, n };
}

export const CLASS_DATASETS: { id: ClassDatasetKind; label: string }[] = [
  { id: 'spiral', label: 'Spiral (3)' },
  { id: 'two-spirals', label: 'Two spirals' },
  { id: 'circles', label: 'Circles' },
  { id: 'moons', label: 'Moons' },
  { id: 'xor', label: 'XOR' },
  { id: 'checkerboard', label: 'Checkerboard' },
  { id: 'gaussians', label: 'Gaussians (4)' },
  { id: 'ring', label: 'Ring' },
];

export const REGRESSION_DATASETS: { id: RegressionKind; label: string }[] = [
  { id: 'sine', label: 'Sine wave' },
  { id: 'sawtooth', label: 'Sawtooth' },
  { id: 'step', label: 'Step' },
  { id: 'abs', label: 'Absolute value' },
  { id: 'gauss-bump', label: 'Gaussian bump' },
  { id: 'poly', label: 'Cubic' },
];

// Deterministic shuffle-and-split into train / validation index sets.
export function splitIndices(
  n: number,
  valFraction: number,
  seed: number,
): { train: Int32Array; val: Int32Array } {
  const rng = mulberry32(seed ^ 0x5bd1e995);
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = idx[i];
    idx[i] = idx[j];
    idx[j] = t;
  }
  const valN = Math.max(0, Math.min(n - 1, Math.round(n * valFraction)));
  return { val: idx.slice(0, valN), train: idx.slice(valN) };
}
