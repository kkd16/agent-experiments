// Neural Cellular Automata — the "Morphogenesis" lab.
//
// A Neural Cellular Automaton (Mordvintsev et al., *Growing Neural Cellular Automata*,
// Distill 2020) is a single update rule, shared by every cell of a grid, applied over and
// over. Each cell carries a C-vector of state (channels 0–3 are visible RGBA, the rest are
// hidden "chemical" signals). One step is:
//
//   perception  p   = [identity, Sobel_x, Sobel_y] ⊛ state          (fixed depthwise filters)
//   update      ds  = W2 · relu(W1 · p + b1) + b2                    (a per-cell MLP, 1×1 convs)
//   stochastic  ds  = ds ⊙ Bernoulli(fireRate)                      (cells fire asynchronously)
//   state       x   = x + ds
//   alive mask  x   = x ⊙ (maxpool₃(α)>0.1, pre AND post)           (dead cells stay dead)
//
// The whole thing is differentiable: we run T steps from a seed, put an MSE loss on the final
// frame's RGBA against a target image, and back-propagate **through time** to train the rule.
// Everything below is built on the engine's own tape — the only new hand-derived op is
// `perceive` (forward + vector-Jacobian backward), gradchecked in `selftest.ts`; the update is
// plain matmul/add/relu so its backward is automatic, and a whole rollout is gradchecked
// end-to-end. A separate, allocation-light **raw** path (no tape) drives the live demo so it
// stays smooth even while the heavy BPTT training runs.
//
// Layout: state is stored **cell-major** as a Tensor [N·H·W, C] — row = (sample·H·W + i·W + j),
// column = channel — so the per-cell MLP is a single dense matmul over all cells at once.

import { Tensor } from './tensor';

export interface GridMeta {
  N: number; // batch size (number of independent grids stacked in the rows)
  H: number;
  W: number;
  C: number; // channels per cell
}

// 3×3 Sobel / identity taps as {dy, dx, wx, wy}. The identity filter is handled separately
// (it's just the centre value); these are the two gradient filters, normalised by 1/8.
interface Tap {
  dy: number;
  dx: number;
  wx: number;
  wy: number;
}
function sobelTaps(): Tap[] {
  // Sobel_x = [[-1,0,1],[-2,0,2],[-1,0,1]]/8 ; Sobel_y = its transpose.
  const sx = [
    [-1, 0, 1],
    [-2, 0, 2],
    [-1, 0, 1],
  ];
  const sy = [
    [-1, -2, -1],
    [0, 0, 0],
    [1, 2, 1],
  ];
  const taps: Tap[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const wx = sx[dy + 1][dx + 1] / 8;
      const wy = sy[dy + 1][dx + 1] / 8;
      if (wx !== 0 || wy !== 0) taps.push({ dy, dx, wx, wy });
    }
  }
  return taps;
}
const TAPS = sobelTaps();

// ---- perception (the one new autograd op) -----------------------------------------------
//
// state [N·H·W, C]  ->  perception [N·H·W, 3C], columns laid out as
//   [ identity(0..C-1) | Sobel_x(C..2C-1) | Sobel_y(2C..3C-1) ].
// Zero padding at the grid border. Backward scatters each output's gradient back to the input
// cells (and their neighbours) it read.
export function perceive(state: Tensor, meta: GridMeta): Tensor {
  const { N, H, W, C } = meta;
  const cells = H * W;
  if (state.rows !== N * cells || state.cols !== C) {
    throw new Error(`perceive shape mismatch [${state.rows},${state.cols}] vs N·H·W=${N * cells} C=${C}`);
  }
  const P = 3 * C;
  const out = Tensor.zeros(N * cells, P);
  const xd = state.data;
  const od = out.data;

  for (let n = 0; n < N; n++) {
    const gBase = n * cells;
    for (let i = 0; i < H; i++) {
      for (let j = 0; j < W; j++) {
        const cell = gBase + i * W + j;
        const xRow = cell * C;
        const oRow = cell * P;
        // identity block
        for (let c = 0; c < C; c++) od[oRow + c] = xd[xRow + c];
        // sobel blocks
        for (let t = 0; t < TAPS.length; t++) {
          const { dy, dx, wx, wy } = TAPS[t];
          const ni = i + dy;
          const nj = j + dx;
          if (ni < 0 || ni >= H || nj < 0 || nj >= W) continue;
          const nRow = (gBase + ni * W + nj) * C;
          for (let c = 0; c < C; c++) {
            const v = xd[nRow + c];
            od[oRow + C + c] += wx * v;
            od[oRow + 2 * C + c] += wy * v;
          }
        }
      }
    }
  }

  out.op = 'perceive';
  out.prev = [state];
  const needX = state.requiresGrad || state.op !== 'leaf';
  out.backwardFn = () => {
    if (!needX) return;
    const go = out.grad;
    const gx = state.grad;
    for (let n = 0; n < N; n++) {
      const gBase = n * cells;
      for (let i = 0; i < H; i++) {
        for (let j = 0; j < W; j++) {
          const cell = gBase + i * W + j;
          const xRow = cell * C;
          const oRow = cell * P;
          for (let c = 0; c < C; c++) gx[xRow + c] += go[oRow + c]; // identity
          for (let t = 0; t < TAPS.length; t++) {
            const { dy, dx, wx, wy } = TAPS[t];
            const ni = i + dy;
            const nj = j + dx;
            if (ni < 0 || ni >= H || nj < 0 || nj >= W) continue;
            const nRow = (gBase + ni * W + nj) * C;
            for (let c = 0; c < C; c++) {
              gx[nRow + c] += wx * go[oRow + C + c] + wy * go[oRow + 2 * C + c];
            }
          }
        }
      }
    }
  };
  return out;
}

// ---- visible-channel loss --------------------------------------------------------------
//
// MSE between the rollout's final RGBA (channels 0..3) and the per-cell target, averaged over
// the 4 visible channels and all cells of all N grids. `target` is [cells, 4] (premultiplied
// RGBA), broadcast across the batch. Backward seeds only the four visible columns of `state`.
export function ncaVisibleLoss(state: Tensor, target: Float64Array, meta: GridMeta): Tensor {
  const { N, H, W, C } = meta;
  const cells = H * W;
  const n = N * cells * 4;
  const sd = state.data;
  let total = 0;
  for (let g = 0; g < N; g++) {
    const gBase = g * cells;
    for (let p = 0; p < cells; p++) {
      const sRow = (gBase + p) * C;
      const tRow = p * 4;
      for (let c = 0; c < 4; c++) {
        const d = sd[sRow + c] - target[tRow + c];
        total += d * d;
      }
    }
  }
  const out = Tensor.zeros(1, 1);
  out.data[0] = total / n;
  out.op = 'ncaLoss';
  out.prev = [state];
  out.backwardFn = () => {
    const seed = out.grad[0];
    const gx = state.grad;
    for (let g = 0; g < N; g++) {
      const gBase = g * cells;
      for (let p = 0; p < cells; p++) {
        const sRow = (gBase + p) * C;
        const tRow = p * 4;
        for (let c = 0; c < 4; c++) {
          gx[sRow + c] += (seed * 2 * (sd[sRow + c] - target[tRow + c])) / n;
        }
      }
    }
  };
  return out;
}

// ---- seed / damage / rendering ---------------------------------------------------------

// One seed grid (cells·C): a single living cell at the centre with α and every hidden channel
// set to 1, RGB = 0. Everything else is zero (dead).
export function makeSeed(meta: GridMeta): Float64Array {
  const { H, W, C } = meta;
  const s = new Float64Array(H * W * C);
  const ci = Math.floor(H / 2);
  const cj = Math.floor(W / 2);
  const base = (ci * W + cj) * C;
  for (let c = 3; c < C; c++) s[base + c] = 1; // α (channel 3) + hidden channels
  return s;
}

// Erase a disc (set every channel to 0 → dead) — used to damage an organism so it must regrow.
export function damage(state: Float64Array, meta: GridMeta, cx: number, cy: number, radius: number): void {
  const { H, W, C } = meta;
  const r2 = radius * radius;
  for (let i = 0; i < H; i++) {
    for (let j = 0; j < W; j++) {
      const dx = j - cx;
      const dy = i - cy;
      if (dx * dx + dy * dy <= r2) {
        const base = (i * W + j) * C;
        for (let c = 0; c < C; c++) state[base + c] = 0;
      }
    }
  }
}

// Premultiplied-RGBA cell state -> an RGBA byte buffer for the canvas, composited over the
// given background (default near-black). `offCells` lets you point at one grid in a batch.
export function renderRGBA(
  state: Float64Array,
  meta: GridMeta,
  bg: [number, number, number] = [0.04, 0.05, 0.08],
  offCells = 0,
): Uint8ClampedArray {
  const { H, W, C } = meta;
  const cells = H * W;
  const out = new Uint8ClampedArray(cells * 4);
  const base = offCells * C;
  for (let p = 0; p < cells; p++) {
    const s = base + p * C;
    const a = Math.min(1, Math.max(0, state[s + 3]));
    // premultiplied rgb (clamped) composited over bg: out = rgb + (1-a)*bg
    const r = Math.min(1, Math.max(0, state[s])) + (1 - a) * bg[0];
    const g = Math.min(1, Math.max(0, state[s + 1])) + (1 - a) * bg[1];
    const b = Math.min(1, Math.max(0, state[s + 2])) + (1 - a) * bg[2];
    out[p * 4] = r * 255;
    out[p * 4 + 1] = g * 255;
    out[p * 4 + 2] = b * 255;
    out[p * 4 + 3] = 255;
  }
  return out;
}

// A single hidden channel (or alpha) of one grid -> a grayscale/diverging RGBA buffer, for the
// channel inspector. Values are roughly in [-1,1]; we map to a blue↔white↔amber ramp.
export function renderChannel(state: Float64Array, meta: GridMeta, channel: number, offCells = 0): Uint8ClampedArray {
  const { H, W, C } = meta;
  const cells = H * W;
  const out = new Uint8ClampedArray(cells * 4);
  const base = offCells * C;
  for (let p = 0; p < cells; p++) {
    const v = state[base + p * C + channel];
    const t = Math.max(-1, Math.min(1, v));
    let r: number;
    let g: number;
    let b: number;
    if (t >= 0) {
      r = 0.1 + 0.9 * t;
      g = 0.1 + 0.55 * t;
      b = 0.12 * (1 - t);
    } else {
      r = 0.12 * (1 + t);
      g = 0.25 * (1 + t);
      b = 0.1 - 0.9 * t;
    }
    out[p * 4] = r * 255;
    out[p * 4 + 1] = g * 255;
    out[p * 4 + 2] = b * 255;
    out[p * 4 + 3] = 255;
  }
  return out;
}

// ---- procedural targets ----------------------------------------------------------------
//
// SDF-rendered emoji-like glyphs at the grid resolution. No bundled assets — every target is
// drawn from signed-distance fields and returned as a premultiplied-RGBA buffer [cells·4].
export interface TargetSpec {
  id: string;
  label: string;
}
export const NCA_TARGETS: TargetSpec[] = [
  { id: 'heart', label: '❤ Heart' },
  { id: 'star', label: '★ Star' },
  { id: 'smiley', label: '☺ Smiley' },
  { id: 'flower', label: '✿ Flower' },
  { id: 'droplet', label: '💧 Droplet' },
  { id: 'ring', label: '◎ Ring' },
  { id: 'spiral', label: '🌀 Spiral' },
  { id: 'nabla', label: '∇ Nabla' },
];

// smooth coverage from a signed distance (negative = inside): 1 inside, 0 outside, a ~1px AA band.
function cover(sd: number, aa: number): number {
  return Math.min(1, Math.max(0, 0.5 - sd / aa));
}

export function renderTarget(id: string, meta: GridMeta): Float64Array {
  const { H, W } = meta;
  const out = new Float64Array(H * W * 4);
  const aa = 2 / Math.min(H, W); // AA band ≈ 1px in normalised units
  for (let i = 0; i < H; i++) {
    for (let j = 0; j < W; j++) {
      // normalised coords in [-1,1], y up
      const x = ((j + 0.5) / W) * 2 - 1;
      const y = 1 - ((i + 0.5) / H) * 2;
      const { a, r, g, b } = sampleGlyph(id, x, y, aa);
      const p = (i * W + j) * 4;
      // store premultiplied
      out[p] = r * a;
      out[p + 1] = g * a;
      out[p + 2] = b * a;
      out[p + 3] = a;
    }
  }
  return out;
}

interface RGBAf {
  a: number;
  r: number;
  g: number;
  b: number;
}

function sampleGlyph(id: string, x: number, y: number, aa: number): RGBAf {
  const S = 0.78; // scale: glyphs fill ~78% of the grid
  const px = x / S;
  const py = y / S;
  switch (id) {
    case 'heart': {
      // classic heart implicit curve (x² + y² - 1)³ - x²y³ < 0
      const X = px * 1.15;
      const Y = py * 1.15 - 0.15;
      const v = Math.pow(X * X + Y * Y - 1, 3) - X * X * Y * Y * Y;
      const a = cover(v * 0.5, aa * 1.5);
      return { a, r: 0.95, g: 0.18, b: 0.32 };
    }
    case 'star': {
      const a = coverStar(px, py, 5, 0.95, 0.42, aa);
      return { a, r: 1.0, g: 0.82, b: 0.16 };
    }
    case 'smiley': {
      const face = cover(Math.hypot(px, py) - 0.92, aa);
      // cut eyes + a smile out of the face
      const eyeL = cover(Math.hypot(px + 0.34, py - 0.28) - 0.16, aa);
      const eyeR = cover(Math.hypot(px - 0.34, py - 0.28) - 0.16, aa);
      // mouth = an annulus arc (lower half)
      const rr = Math.hypot(px, py + 0.08);
      const mouthRing = cover(Math.abs(rr - 0.55) - 0.1, aa);
      const mouth = py + 0.08 < 0 ? mouthRing : 0;
      const cut = Math.max(eyeL, eyeR, mouth);
      const a = Math.max(0, face - cut);
      return { a, r: 1.0, g: 0.78, b: 0.12 };
    }
    case 'flower': {
      // 6 petals: r threshold modulated by cos(6θ)
      const r = Math.hypot(px, py);
      const th = Math.atan2(py, px);
      const petal = 0.55 + 0.4 * Math.abs(Math.cos(3 * th));
      const a = cover(r - petal, aa);
      const center = cover(r - 0.22, aa);
      // petals pink, centre yellow
      if (center > 0.5) return { a: Math.max(a, center), r: 1.0, g: 0.85, b: 0.2 };
      return { a, r: 0.96, g: 0.45, b: 0.78 };
    }
    case 'droplet': {
      // a teardrop: circle below, point above
      const X = px;
      const Y = py;
      let sd: number;
      if (Y <= 0) sd = Math.hypot(X, Y) - 0.7;
      else {
        // two lines meeting at the top (0,1.05) tangent-ish
        const tip = 1.05;
        const k = 0.7 / tip;
        const dline = (Math.abs(X) - k * (tip - Y)) / Math.hypot(1, k);
        const dtop = Y - tip;
        sd = Math.max(dline, dtop, -(Y - 0)); // clip to upper region
        // blend with circle near the seam
        sd = Math.min(sd, Math.hypot(X, Y) - 0.7);
      }
      const a = cover(sd, aa);
      return { a, r: 0.25, g: 0.62, b: 1.0 };
    }
    case 'ring': {
      const r = Math.hypot(px, py);
      const a = cover(Math.abs(r - 0.62) - 0.22, aa);
      return { a, r: 0.4, g: 0.85, b: 0.95 };
    }
    case 'spiral': {
      const r = Math.hypot(px, py);
      const th = Math.atan2(py, px);
      // Archimedean spiral: distance to nearest arm
      const arms = 1;
      const turns = 2.4;
      const phase = (th / (2 * Math.PI)) * arms;
      const k = turns; // radius grows k per full turn
      const t = r * (1 / 0.95); // normalise
      const nearest = Math.round(t * k - phase) + phase;
      const rArm = nearest / k;
      const sd = Math.abs(r * (1 / 0.95) - rArm * 0.95 * (1 / 0.95)) * 0.95 - 0.13;
      const within = cover(r - 0.98, aa);
      const a = Math.min(within, cover(sd, aa));
      return { a, r: 0.55, g: 0.5, b: 0.98 };
    }
    case 'nabla': {
      // a downward triangle (the ∇ logo): inside an equilateral triangle pointing down
      const a = coverTriangleDown(px, py, 0.95, aa);
      return { a, r: 0.55, g: 0.95, b: 0.85 };
    }
    default: {
      const a = cover(Math.hypot(px, py) - 0.8, aa);
      return { a, r: 0.8, g: 0.8, b: 0.85 };
    }
  }
}

function coverStar(x: number, y: number, points: number, rOuter: number, rInner: number, aa: number): number {
  // polar test against a star radius profile
  const r = Math.hypot(x, y);
  let th = Math.atan2(y, x) - Math.PI / 2; // point up
  const seg = (2 * Math.PI) / points;
  th = ((th % seg) + seg) % seg;
  const tt = Math.abs(th - seg / 2) / (seg / 2); // 0 at spike centre, 1 at valley
  const rEdge = rInner + (rOuter - rInner) * (1 - tt);
  return cover(r - rEdge, aa);
}

function coverTriangleDown(x: number, y: number, s: number, aa: number): number {
  // A down-pointing triangle (the ∇ logo): the max of three half-plane distances, each
  // oriented (against the centroid) so the interior is negative.
  const B: [number, number] = [0, -0.85 * s]; // bottom point
  const L: [number, number] = [-0.95 * s, 0.6 * s]; // top-left
  const R: [number, number] = [0.95 * s, 0.6 * s]; // top-right
  const G: [number, number] = [(B[0] + L[0] + R[0]) / 3, (B[1] + L[1] + R[1]) / 3];
  const edge = (a: [number, number], b: [number, number]) => {
    const sg = Math.sign(lineSide(G[0], G[1], a[0], a[1], b[0], b[1])) || 1;
    return -sg * lineSide(x, y, a[0], a[1], b[0], b[1]); // negative on the centroid's side
  };
  return cover(Math.max(edge(B, L), edge(L, R), edge(R, B)), aa);
}

// signed "side" distance of point p to the directed line a→b (positive = outside, to the left).
function lineSide(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const ex = bx - ax;
  const ey = by - ay;
  const nx = ey;
  const ny = -ex;
  const len = Math.hypot(nx, ny) || 1;
  return ((px - ax) * nx + (py - ay) * ny) / len;
}

// ---- the model -------------------------------------------------------------------------

export interface NCAConfig {
  channels: number; // C (>=4)
  hidden: number; // update MLP hidden width
  fireRate: number; // stochastic update probability per cell
}

function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Per-step frozen masks captured during a taped rollout, so a gradcheck can replay the exact
// same stochastic + alive masks while perturbing parameters (the masks are stop-gradient).
export interface StepMasks {
  stoch: Tensor;
  alive: Tensor;
}

export class NCA {
  cfg: NCAConfig;
  W1: Tensor; // [3C, hidden]
  b1: Tensor; // [1, hidden]
  W2: Tensor; // [hidden, C]  (zero-init: the CA starts as the identity)
  b2: Tensor; // [1, C]       (zero-init)

  constructor(cfg: NCAConfig, rng: () => number) {
    this.cfg = cfg;
    const C = cfg.channels;
    const P = 3 * C;
    const gain = Math.sqrt(2 / P);
    const w1 = new Float64Array(P * cfg.hidden);
    for (let i = 0; i < w1.length; i++) w1[i] = randn(rng) * gain;
    this.W1 = Tensor.fromFlat(w1, P, cfg.hidden, true).named('W1');
    this.b1 = Tensor.zeros(1, cfg.hidden, true).named('b1');
    this.W2 = Tensor.zeros(cfg.hidden, C, true).named('W2'); // zero update at init
    this.b2 = Tensor.zeros(1, C, true).named('b2');
  }

  parameters(): Tensor[] {
    return [this.W1, this.b1, this.W2, this.b2];
  }

  paramCount(): number {
    return this.W1.size + this.b1.size + this.W2.size + this.b2.size;
  }

  exportWeights(): number[] {
    const out: number[] = [];
    for (const p of this.parameters()) for (let i = 0; i < p.size; i++) out.push(p.data[i]);
    return out;
  }

  importWeights(flat: number[]): boolean {
    const ps = this.parameters();
    let total = 0;
    for (const p of ps) total += p.size;
    if (flat.length !== total) return false;
    let k = 0;
    for (const p of ps) for (let i = 0; i < p.size; i++) p.data[i] = flat[k++];
    return true;
  }

  // ---- taped rollout (training) --------------------------------------------------------
  //
  // From a seed tensor [N·cells, C], run `steps` CA steps on the tape and return the final
  // state plus the per-step masks actually used (so a caller can replay them for gradcheck).
  // If `frozen` is supplied, those masks are used verbatim instead of being generated.
  rollout(
    seed: Tensor,
    steps: number,
    meta: GridMeta,
    rng: () => number,
    frozen?: StepMasks[],
  ): { state: Tensor; masks: StepMasks[] } {
    const { N, H, W, C } = meta;
    let s = seed;
    const masks: StepMasks[] = [];
    for (let t = 0; t < steps; t++) {
      const p = perceive(s, meta);
      const h = p.matmul(this.W1).add(this.b1).relu();
      let ds = h.matmul(this.W2).add(this.b2);

      // stochastic fire mask (per cell, broadcast across channels)
      const stoch = frozen ? frozen[t].stoch : buildStochMask(meta, this.cfg.fireRate, rng);
      ds = ds.mul(stoch);

      const preAdd = s.add(ds); // x + dx (data now available)

      // alive mask = pre-alive(s) AND post-alive(preAdd), as a frozen stop-gradient tensor
      const alive = frozen ? frozen[t].alive : buildAliveMask(s.data, preAdd.data, N, H, W, C);
      s = preAdd.mul(alive);

      masks.push({ stoch, alive });
    }
    return { state: s, masks };
  }

  // ---- raw rollout (inference / live demo, no tape) ------------------------------------
  //
  // One CA step on a single grid (cells·C), in place into `out`. Fast, allocation-light.
  rawStep(state: Float64Array, out: Float64Array, meta: GridMeta, rng: () => number, scratch: RawScratch): void {
    const { H, W, C } = meta;
    const cells = H * W;
    const P = 3 * C;
    const hid = this.cfg.hidden;
    const w1 = this.W1.data;
    const b1 = this.b1.data;
    const w2 = this.W2.data;
    const b2 = this.b2.data;
    const perc = scratch.perc;
    const hbuf = scratch.hid;

    // perception
    for (let i = 0; i < H; i++) {
      for (let j = 0; j < W; j++) {
        const cell = i * W + j;
        const xRow = cell * C;
        const oRow = cell * P;
        for (let c = 0; c < C; c++) perc[oRow + c] = state[xRow + c];
        for (let c = 0; c < C; c++) {
          perc[oRow + C + c] = 0;
          perc[oRow + 2 * C + c] = 0;
        }
        for (let t = 0; t < TAPS.length; t++) {
          const { dy, dx, wx, wy } = TAPS[t];
          const ni = i + dy;
          const nj = j + dx;
          if (ni < 0 || ni >= H || nj < 0 || nj >= W) continue;
          const nRow = (ni * W + nj) * C;
          for (let c = 0; c < C; c++) {
            const v = state[nRow + c];
            perc[oRow + C + c] += wx * v;
            perc[oRow + 2 * C + c] += wy * v;
          }
        }
      }
    }

    // pre-alive from current alpha
    const preAlive = scratch.preAlive;
    livingMaskInto(state, H, W, C, preAlive);

    // update MLP per cell, then x + ds·fire, into `out`
    for (let p = 0; p < cells; p++) {
      const percRow = p * P;
      // h = relu(perc·W1 + b1)
      for (let k = 0; k < hid; k++) hbuf[k] = b1[k];
      for (let q = 0; q < P; q++) {
        const pv = perc[percRow + q];
        if (pv === 0) continue;
        const wRow = q * hid;
        for (let k = 0; k < hid; k++) hbuf[k] += pv * w1[wRow + k];
      }
      for (let k = 0; k < hid; k++) if (hbuf[k] < 0) hbuf[k] = 0;
      // ds = h·W2 + b2 ; apply fire + add
      const fire = rng() < this.cfg.fireRate ? 1 : 0;
      const xRow = p * C;
      for (let c = 0; c < C; c++) {
        let acc = b2[c];
        for (let k = 0; k < hid; k++) acc += hbuf[k] * w2[k * C + c];
        out[xRow + c] = state[xRow + c] + fire * acc;
      }
    }

    // post-alive from updated alpha, then mask = pre & post
    const postAlive = scratch.postAlive;
    livingMaskInto(out, H, W, C, postAlive);
    for (let p = 0; p < cells; p++) {
      const live = preAlive[p] && postAlive[p] ? 1 : 0;
      if (live) continue;
      const xRow = p * C;
      for (let c = 0; c < C; c++) out[xRow + c] = 0;
    }
  }
}

export interface RawScratch {
  perc: Float64Array;
  hid: Float64Array;
  preAlive: Uint8Array;
  postAlive: Uint8Array;
}
export function makeRawScratch(meta: GridMeta, hidden: number): RawScratch {
  const cells = meta.H * meta.W;
  return {
    perc: new Float64Array(cells * 3 * meta.C),
    hid: new Float64Array(hidden),
    preAlive: new Uint8Array(cells),
    postAlive: new Uint8Array(cells),
  };
}

// ---- mask helpers ----------------------------------------------------------------------

// Per-cell living mask: alive iff the 3×3 max of the alpha channel exceeds 0.1.
function livingMaskInto(state: Float64Array, H: number, W: number, C: number, out: Uint8Array): void {
  for (let i = 0; i < H; i++) {
    for (let j = 0; j < W; j++) {
      let mx = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ni = i + dy;
        if (ni < 0 || ni >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nj = j + dx;
          if (nj < 0 || nj >= W) continue;
          const a = state[(ni * W + nj) * C + 3];
          if (a > mx) mx = a;
        }
      }
      out[i * W + j] = mx > 0.1 ? 1 : 0;
    }
  }
}

// Build a frozen [N·cells, C] stochastic-fire mask: one Bernoulli(fireRate) bit per cell,
// replicated across all C channels (so a cell either updates all its channels or none).
function buildStochMask(meta: GridMeta, fireRate: number, rng: () => number): Tensor {
  const { N, H, W, C } = meta;
  const cells = H * W;
  const m = new Float64Array(N * cells * C);
  for (let r = 0; r < N * cells; r++) {
    const bit = rng() < fireRate ? 1 : 0;
    if (bit) {
      const base = r * C;
      for (let c = 0; c < C; c++) m[base + c] = 1;
    }
  }
  return Tensor.fromFlat(m, N * cells, C, false);
}

// Build a frozen [N·cells, C] alive mask = (pre-alive AND post-alive), replicated across
// channels. `pre` is the state at the start of the step, `post` the state after x + dx.
function buildAliveMask(pre: Float64Array, post: Float64Array, N: number, H: number, W: number, C: number): Tensor {
  const cells = H * W;
  const m = new Float64Array(N * cells * C);
  const preMask = new Uint8Array(cells);
  const postMask = new Uint8Array(cells);
  for (let g = 0; g < N; g++) {
    const off = g * cells * C;
    livingMaskInto(pre.subarray(off, off + cells * C), H, W, C, preMask);
    livingMaskInto(post.subarray(off, off + cells * C), H, W, C, postMask);
    for (let p = 0; p < cells; p++) {
      if (preMask[p] && postMask[p]) {
        const base = off + p * C;
        for (let c = 0; c < C; c++) m[base + c] = 1;
      }
    }
  }
  return Tensor.fromFlat(m, N * cells, C, false);
}
