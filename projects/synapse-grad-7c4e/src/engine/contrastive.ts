// Self-supervised contrastive learning (SimCLR) — from scratch on the tensor autograd engine.
//
// The idea: with no labels at all, learn an image encoder by *instance discrimination*. Take a
// glyph, make two random augmentations of it (a "positive pair"), push their embeddings together
// and push every other image in the batch apart. The objective is the normalized
// temperature-scaled cross-entropy (NT-Xent / InfoNCE) of Chen et al. 2020. The only genuinely
// new hand-derived gradient is the row-wise L2 normalization that turns embeddings into points on
// the unit hypersphere; everything else (the similarity matrix, the masked log-softmax, the
// positive gather) is assembled from ops the engine already owns and gradchecks.
//
// What makes it striking: train with the labels hidden, then *afterwards* fit a one-layer linear
// probe (or a kNN vote) on the frozen representations — and watch the accuracy climb far above a
// raw-pixel baseline. The clusters were there all along; the contrastive loss found them without
// ever being told what a "3" is.

import { Tensor } from './tensor';
import { Linear, mulberry32 } from './nn';
import { conv2d, convOut, type ConvMeta } from './conv';
import { gatherCols } from './ops';
import { softmaxCrossEntropy } from './losses';
import { Optimizer, defaultOptimizer } from './optim';
import { makeImageDataset, datasetMeta, type VisionDatasetKind } from './images';

// Standard-normal sample via Box–Muller (the engine keeps its randn private; we need our own).
function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// A deterministic Fisher–Yates permutation of [0,n) — used to shuffle before the probe's
// train/test split so both halves see every class (the datasets label cyclically).
function shuffledOrder(n: number, seed: number): Int32Array {
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const rng = mulberry32(seed >>> 0);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  return order;
}

// ---- the one new autograd op -------------------------------------------------------------
//
// Row-wise L2 normalization:  y_i = x_i / ‖x_i‖,  with ‖x_i‖ = sqrt(Σ_k x_ik² + eps).
// This is the projection onto the unit sphere that makes the dot product a cosine similarity.
// The core engine's `div` only broadcasts a [1,C] row, not a per-row [R,1] scalar, so this needs
// its own closure. Derivative (per row i, with n = ‖x_i‖ and dot_i = Σ_j g_ij x_ij):
//   dy_ij/dx_il = δ_jl / n − x_ij x_il / n³   ⇒   ga_il = (g_il − x_il · dot_i / n²) / n.
export function l2NormalizeRows(x: Tensor, eps = 1e-8): Tensor {
  const R = x.rows;
  const C = x.cols;
  const out = Tensor.zeros(R, C);
  const a = x.data;
  const o = out.data;
  const norm = new Float64Array(R);
  for (let i = 0; i < R; i++) {
    const base = i * C;
    let ss = 0;
    for (let j = 0; j < C; j++) ss += a[base + j] * a[base + j];
    const n = Math.sqrt(ss + eps);
    norm[i] = n;
    for (let j = 0; j < C; j++) o[base + j] = a[base + j] / n;
  }
  out.op = 'l2normRows';
  out.prev = [x];
  out.backwardFn = () => {
    const g = out.grad;
    const ga = x.grad;
    for (let i = 0; i < R; i++) {
      const base = i * C;
      const n = norm[i];
      const n2 = n * n;
      let dot = 0;
      for (let j = 0; j < C; j++) dot += g[base + j] * a[base + j];
      const k = dot / n2;
      for (let j = 0; j < C; j++) ga[base + j] += (g[base + j] - a[base + j] * k) / n;
    }
  };
  return out;
}

// ---- NT-Xent (InfoNCE) loss --------------------------------------------------------------
//
// `z` is the batch of 2N projection vectors [2N, D]; row i and row posIdx[i] are a positive pair
// (two augmentations of the same image). We normalize, form the full cosine-similarity matrix
// scaled by 1/τ, blank out the self-similarities (the −∞ diagonal mask), take a row-wise
// log-softmax, and read off the positive's log-probability for every anchor. The loss is the mean
// negative — exactly a (2N−1)-way classification where the correct class is the matching view.
//
// `maskTensor` is a frozen [2N,2N] additive mask (0 off-diagonal, a large negative on the
// diagonal) passed in so the caller can reuse it; it carries no gradient.
export function ntXentLoss(z: Tensor, posIdx: Int32Array, maskTensor: Tensor, temperature: number): Tensor {
  const zn = l2NormalizeRows(z);
  const sim = zn.matmul(zn.transpose()).scale(1 / temperature); // [2N,2N] cosine / τ
  const masked = sim.add(maskTensor); // kill the diagonal before the softmax
  const logp = masked.logSoftmax();
  const pos = gatherCols(logp, posIdx); // [2N,1] log-prob of each anchor's true match
  return pos.meanAll().neg();
}

// The diagonal −∞ mask used by `ntXentLoss`, as a frozen leaf tensor of size [m,m].
export function diagonalMask(m: number, negInf = -1e9): Tensor {
  const t = Tensor.zeros(m, m, false);
  for (let i = 0; i < m; i++) t.data[i * m + i] = negInf;
  return t;
}

// Numeric (non-autograd) cosine-similarity matrix of a row set already in embedding space — used
// by the visualizations and the contrastive-accuracy readout. Returns the [m,m] matrix flattened.
export function cosineSimMatrix(z: Float64Array, m: number, D: number, eps = 1e-8): Float64Array {
  const zn = new Float64Array(m * D);
  for (let i = 0; i < m; i++) {
    let ss = 0;
    for (let j = 0; j < D; j++) ss += z[i * D + j] * z[i * D + j];
    const n = Math.sqrt(ss + eps);
    for (let j = 0; j < D; j++) zn[i * D + j] = z[i * D + j] / n;
  }
  const s = new Float64Array(m * m);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) {
      let d = 0;
      for (let k = 0; k < D; k++) d += zn[i * D + k] * zn[j * D + k];
      s[i * m + j] = d;
    }
  }
  return s;
}

// Fraction of anchors whose nearest *other* embedding (max similarity, self excluded) is its true
// positive — the batch's contrastive top-1 retrieval accuracy.
export function contrastiveAccuracy(z: Float64Array, posIdx: Int32Array, m: number, D: number): number {
  const s = cosineSimMatrix(z, m, D);
  let correct = 0;
  for (let i = 0; i < m; i++) {
    let best = -Infinity;
    let arg = -1;
    for (let j = 0; j < m; j++) {
      if (j === i) continue;
      const v = s[i * m + j];
      if (v > best) {
        best = v;
        arg = j;
      }
    }
    if (arg === posIdx[i]) correct++;
  }
  return correct / m;
}

// ---- the encoder -------------------------------------------------------------------------
//
// A small but genuine CNN: two stride-2 convolutions (downsample without pooling) → a fully
// connected backbone producing the *representation* h, then a two-layer projection head producing
// the *projection* z. SimCLR's key trick is to run the contrastive loss on z but keep h for
// downstream use — the head throws away nuisance information the loss would otherwise bake into the
// representation. `represent` stops at h; `project` goes all the way to z.

export interface EncoderConfig {
  size: number; // image side (single channel)
  ch1: number; // first conv output channels
  ch2: number; // second conv output channels
  repDim: number; // representation (backbone output) width — the linear-probe input
  projDim: number; // projection (contrastive) width
}

export class Encoder {
  cfg: EncoderConfig;
  w1: Tensor;
  b1: Tensor;
  w2: Tensor;
  b2: Tensor;
  back: Linear;
  proj1: Linear;
  proj2: Linear;
  readonly H1: number;
  readonly H2: number;
  readonly flat: number;

  constructor(cfg: EncoderConfig, rng: () => number) {
    this.cfg = cfg;
    const { size, ch1, ch2, repDim, projDim } = cfg;
    this.H1 = convOut(size, 3, 2, 1);
    this.H2 = convOut(this.H1, 3, 2, 1);
    this.flat = ch2 * this.H2 * this.H2;

    this.w1 = heConv(ch1, 1, 3, rng).named('conv1.W');
    this.b1 = Tensor.zeros(1, ch1, true).named('conv1.b');
    this.w2 = heConv(ch2, ch1, 3, rng).named('conv2.W');
    this.b2 = Tensor.zeros(1, ch2, true).named('conv2.b');
    this.back = new Linear(this.flat, repDim, 'relu', rng);
    this.proj1 = new Linear(repDim, repDim, 'relu', rng);
    this.proj2 = new Linear(repDim, projDim, 'linear', rng);
  }

  // x: [N, size*size] single-channel images → representation h: [N, repDim] (post-ReLU).
  represent(x: Tensor): Tensor {
    const N = x.rows;
    const { size, ch1, ch2 } = this.cfg;
    const m1: ConvMeta = { N, Cin: 1, H: size, W: size, Cout: ch1, kh: 3, kw: 3, stride: 2, pad: 1 };
    const c1 = conv2d(x, this.w1, this.b1, m1).relu();
    const m2: ConvMeta = { N, Cin: ch1, H: this.H1, W: this.H1, Cout: ch2, kh: 3, kw: 3, stride: 2, pad: 1 };
    const c2 = conv2d(c1, this.w2, this.b2, m2).relu();
    return this.back.forward(c2).relu();
  }

  // Apply the projection head to a representation h → z: [N, projDim]. Split out so the lab can
  // probe the *representation* and the *projection* separately (SimCLR's headline ablation).
  head(h: Tensor): Tensor {
    return this.proj2.forward(this.proj1.forward(h).relu());
  }

  // Full path to the contrastive projection z: [N, projDim].
  project(x: Tensor): Tensor {
    return this.head(this.represent(x));
  }

  parameters(): Tensor[] {
    return [this.w1, this.b1, this.w2, this.b2, ...this.back.parameters(), ...this.proj1.parameters(), ...this.proj2.parameters()];
  }

  paramCount(): number {
    let n = 0;
    for (const p of this.parameters()) n += p.size;
    return n;
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
}

// He-initialized conv kernel stack [Cout, Cin*k*k].
function heConv(Cout: number, Cin: number, k: number, rng: () => number): Tensor {
  const fanIn = Cin * k * k;
  const gain = Math.sqrt(2 / fanIn);
  const d = new Float64Array(Cout * fanIn);
  for (let i = 0; i < d.length; i++) d[i] = randn(rng) * gain;
  return Tensor.fromFlat(d, Cout, fanIn, true);
}

export interface EncoderPreset {
  id: string;
  label: string;
  ch1: number;
  ch2: number;
  repDim: number;
  projDim: number;
}

export const ENCODER_PRESETS: EncoderPreset[] = [
  { id: 'small', label: 'small · 8→16, rep 48', ch1: 8, ch2: 16, repDim: 48, projDim: 24 },
  { id: 'standard', label: 'standard · 12→24, rep 64', ch1: 12, ch2: 24, repDim: 64, projDim: 32 },
  { id: 'wide', label: 'wide · 16→32, rep 96', ch1: 16, ch2: 32, repDim: 96, projDim: 48 },
];

// ---- image-space augmentations -----------------------------------------------------------
//
// SimCLR lives or dies by its augmentations: the *only* thing telling the network two crops are
// "the same" is that they came from one source image. We compose a random affine warp (rotation,
// isotropic scale, translation, bilinearly resampled), a random intensity gain, additive Gaussian
// noise, and an optional random-erasing cutout. Backgrounds are the dataset's −0.5 ink floor.

export interface AugConfig {
  rot: number; // max |rotation| (radians)
  scale: number; // max |Δscale| (multiplier offset, e.g. 0.2 ⇒ [0.8,1.2])
  shift: number; // max |translation| as a fraction of the image side
  noise: number; // additive Gaussian std
  intensity: number; // max |Δgain| on the ink amplitude
  cutout: number; // probability of erasing a random patch
}

const BG = -0.5;

export function augment(src: Float64Array, size: number, rng: () => number, cfg: AugConfig): Float64Array {
  const out = new Float64Array(size * size);
  const theta = (rng() * 2 - 1) * cfg.rot;
  const s = 1 + (rng() * 2 - 1) * cfg.scale;
  const tx = (rng() * 2 - 1) * cfg.shift * size;
  const ty = (rng() * 2 - 1) * cfg.shift * size;
  const gain = 1 + (rng() * 2 - 1) * cfg.intensity;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const c = (size - 1) / 2;
  const invS = 1 / Math.max(0.2, s);
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      // inverse map output pixel → source location (un-translate, un-rotate, un-scale about center)
      const dx = ox - c - tx;
      const dy = oy - c - ty;
      const sxc = (cos * dx + sin * dy) * invS;
      const syc = (-sin * dx + cos * dy) * invS;
      const sx = sxc + c;
      const sy = syc + c;
      let val = BG;
      if (sx >= 0 && sx <= size - 1 && sy >= 0 && sy <= size - 1) {
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const x1 = Math.min(size - 1, x0 + 1);
        const y1 = Math.min(size - 1, y0 + 1);
        const fx = sx - x0;
        const fy = sy - y0;
        const v00 = src[y0 * size + x0];
        const v01 = src[y0 * size + x1];
        const v10 = src[y1 * size + x0];
        const v11 = src[y1 * size + x1];
        const top = v00 + (v01 - v00) * fx;
        const bot = v10 + (v11 - v10) * fx;
        val = top + (bot - top) * fy;
      }
      val = BG + (val - BG) * gain;
      if (cfg.noise > 0) val += randn(rng) * cfg.noise;
      out[oy * size + ox] = val;
    }
  }
  // random erasing
  if (cfg.cutout > 0 && rng() < cfg.cutout) {
    const cw = Math.max(2, Math.round(size * (0.2 + rng() * 0.25)));
    const ch = Math.max(2, Math.round(size * (0.2 + rng() * 0.25)));
    const cx = Math.floor(rng() * (size - cw + 1));
    const cy = Math.floor(rng() * (size - ch + 1));
    for (let y = cy; y < cy + ch; y++) for (let x = cx; x < cx + cw; x++) out[y * size + x] = BG;
  }
  return out;
}

// ---- data --------------------------------------------------------------------------------

export interface ContrastiveData {
  X: Float64Array; // [n*px] base images (ink ≈ +0.5, bg ≈ -0.5)
  y: Int32Array; // [n] hidden class label (used only by the evaluators, never by training)
  n: number;
  classes: number;
  labels: string[];
  size: number;
}

export function makeContrastiveData(kind: VisionDatasetKind, n: number, size: number, seed: number): ContrastiveData {
  // Substantial base jitter + noise on purpose: the raw pixels of these distorted glyphs are NOT
  // linearly separable (that's the raw-pixel baseline the probe reports), but an encoder trained to
  // be *invariant* to exactly this kind of nuisance variation recovers the class structure. That
  // gap — pixels can't, the learned representation can — is the whole point of the lab.
  const ds = makeImageDataset(kind, n, 0.1, 1.0, size, seed);
  const meta = datasetMeta(kind);
  return { X: ds.X, y: ds.y, n: ds.n, classes: meta.classes, labels: meta.labels, size };
}

// ---- downstream evaluation (the "did it actually learn anything?" probes) -----------------

export interface ProbeResult {
  testAcc: number;
  trainAcc: number;
}

// Fit a one-layer softmax classifier on the frozen features (a linear probe — the standard SSL
// evaluation). Even split into probe-train / probe-test by index parity so the reported accuracy
// is genuine generalization, not memorization. The encoder is *not* touched.
export function linearProbe(
  feats: Float64Array,
  labels: Int32Array,
  n: number,
  D: number,
  numClasses: number,
  rng: () => number,
  iters = 160,
): ProbeResult {
  // Shuffle before the half-split so both halves see every class — the datasets assign labels
  // cyclically (cls = i mod classes), which a naive contiguous/parity split would tear apart.
  const order = shuffledOrder(n, 0x51c1 ^ n);
  const trIdx: number[] = [];
  const teIdx: number[] = [];
  for (let i = 0; i < n; i++) (i % 2 === 0 ? trIdx : teIdx).push(order[i]);
  if (trIdx.length === 0 || teIdx.length === 0) return { testAcc: NaN, trainAcc: NaN };

  const pack = (idx: number[]): { X: Tensor; y: Int32Array } => {
    const X = new Float64Array(idx.length * D);
    const y = new Int32Array(idx.length);
    for (let i = 0; i < idx.length; i++) {
      X.set(feats.subarray(idx[i] * D, idx[i] * D + D), i * D);
      y[i] = labels[idx[i]];
    }
    return { X: Tensor.fromFlat(X, idx.length, D, false), y };
  };
  const tr = pack(trIdx);
  const te = pack(teIdx);

  const clf = new Linear(D, numClasses, 'linear', rng);
  const opt = new Optimizer(clf.parameters(), { ...defaultOptimizer('adam', 0.05), weightDecay: 1e-3 });
  for (let it = 0; it < iters; it++) {
    const logits = clf.forward(tr.X);
    const { loss } = softmaxCrossEntropy(logits, tr.y);
    opt.zeroGrad();
    loss.backward();
    opt.step();
  }
  const acc = (X: Tensor, y: Int32Array): number => {
    const logits = clf.forward(X);
    const C = logits.cols;
    let correct = 0;
    for (let i = 0; i < y.length; i++) {
      let best = -Infinity;
      let arg = 0;
      for (let j = 0; j < C; j++) {
        const v = logits.data[i * C + j];
        if (v > best) {
          best = v;
          arg = j;
        }
      }
      if (arg === y[i]) correct++;
    }
    return correct / y.length;
  };
  return { testAcc: acc(te.X, te.y), trainAcc: acc(tr.X, tr.y) };
}

// k-nearest-neighbour accuracy on the (cosine) representation space — a parameter-free probe.
// Same parity split: classify each probe-test point by majority vote of its k nearest
// probe-train neighbours.
export function knnAccuracy(feats: Float64Array, labels: Int32Array, n: number, D: number, numClasses: number, k = 5): number {
  const norm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let ss = 0;
    for (let j = 0; j < D; j++) ss += feats[i * D + j] * feats[i * D + j];
    norm[i] = Math.sqrt(ss) + 1e-8;
  }
  const order = shuffledOrder(n, 0x7717 ^ n);
  const tr: number[] = [];
  const te: number[] = [];
  for (let i = 0; i < n; i++) (i % 2 === 0 ? tr : te).push(order[i]);
  if (!tr.length || !te.length) return NaN;
  let correct = 0;
  const kk = Math.min(k, tr.length);
  for (const i of te) {
    // find kk nearest train points by cosine similarity
    const best: { sim: number; cls: number }[] = [];
    for (const j of tr) {
      let d = 0;
      for (let c = 0; c < D; c++) d += feats[i * D + c] * feats[j * D + c];
      const sim = d / (norm[i] * norm[j]);
      if (best.length < kk) {
        best.push({ sim, cls: labels[j] });
        best.sort((a, b) => a.sim - b.sim);
      } else if (sim > best[0].sim) {
        best[0] = { sim, cls: labels[j] };
        best.sort((a, b) => a.sim - b.sim);
      }
    }
    const votes = new Float64Array(numClasses);
    for (const b of best) votes[b.cls] += 1;
    let arg = 0;
    let bv = -1;
    for (let c = 0; c < numClasses; c++) if (votes[c] > bv) {
      bv = votes[c];
      arg = c;
    }
    if (arg === labels[i]) correct++;
  }
  return correct / te.length;
}

// Alignment & uniformity (Wang & Isola 2020) — the two forces NT-Xent balances, measured on the
// unit sphere. Alignment = E‖z_i − z_j‖² over positive pairs (want small: positives close).
// Uniformity = log E exp(−2‖z_i − z_j‖²) over all pairs (want very negative: embeddings spread
// out, preserving information). `z` holds 2N rows; row 2k and 2k+1 (interleaved) are positives.
export interface AlignUniform {
  alignment: number;
  uniformity: number;
}

export function alignUniform(z: Float64Array, m: number, D: number): AlignUniform {
  const zn = new Float64Array(m * D);
  for (let i = 0; i < m; i++) {
    let ss = 0;
    for (let j = 0; j < D; j++) ss += z[i * D + j] * z[i * D + j];
    const n = Math.sqrt(ss) + 1e-8;
    for (let j = 0; j < D; j++) zn[i * D + j] = z[i * D + j] / n;
  }
  const sqDist = (i: number, j: number): number => {
    let s = 0;
    for (let c = 0; c < D; c++) {
      const d = zn[i * D + c] - zn[j * D + c];
      s += d * d;
    }
    return s;
  };
  // positives are interleaved pairs (2k, 2k+1)
  let align = 0;
  const pairs = Math.floor(m / 2);
  for (let k = 0; k < pairs; k++) align += sqDist(2 * k, 2 * k + 1);
  align /= Math.max(1, pairs);
  let usum = 0;
  let ucount = 0;
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      usum += Math.exp(-2 * sqDist(i, j));
      ucount++;
    }
  }
  const uniformity = ucount > 0 ? Math.log(usum / ucount) : NaN;
  return { alignment: align, uniformity };
}

// A tiny self-contained helper for the trainer/tests: pull a balanced batch of base-image indices.
export function sampleBatchIndices(n: number, batch: number, rng: () => number): Int32Array {
  const out = new Int32Array(batch);
  for (let i = 0; i < batch; i++) out[i] = Math.floor(rng() * n);
  return out;
}

export { mulberry32 };
