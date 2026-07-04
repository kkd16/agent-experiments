// From-scratch spiking neural networks — leaky integrate-and-fire (LIF) neurons trained by
// surrogate-gradient back-propagation-through-time, built on the same hand-rolled reverse-mode
// autograd as the rest of Synapse. No neuromorphic library, no snnTorch: every neuron's
// membrane recurrence and every gradient is assembled from the primitive ops in `tensor.ts`.
//
// The pedagogical heart of this lab is the **surrogate gradient**. A biological spike is a
// threshold event — the neuron fires the instant its membrane potential U crosses θ — so the
// spike function is a Heaviside step, whose derivative is zero everywhere (and undefined at the
// threshold). Back-prop through a wall of zeros learns nothing. Surrogate-gradient learning
// (Neftci, Mostafa & Zenke, 2019) keeps the hard step on the *forward* pass but substitutes a
// smooth, non-zero derivative on the *backward* pass — pretending, only for the gradient, that
// the neuron responds gently to sub-threshold current.
//
// We make that story honest and machine-checkable. Each surrogate is a matched pair:
//   • a smooth relaxation  f(u)  (a soft, differentiable spike, f(0)=½, monotone, f'≥0), and
//   • its *exact* analytic derivative  f'(u),
// so that `softSpike` (forward = f, backward = f') gradchecks against finite differences to
// machine precision, while `spike` (forward = Heaviside, backward = f') reuses the *identical*
// backward — the surrogate is literally "the soft spike's gradient bolted onto the hard spike's
// forward." The self-test proves both facts.

import { Tensor } from './tensor';
import { mulberry32 } from './nn';
import { softmaxCrossEntropy, type CEResult } from './losses';

// ---- surrogate gradients ---------------------------------------------------------------------

export type SurrogateKind = 'fast-sigmoid' | 'arctan' | 'sigmoid' | 'triangular';

export const SURROGATES: { id: SurrogateKind; label: string; note: string }[] = [
  { id: 'fast-sigmoid', label: 'Fast sigmoid', note: "SuperSpike — Zenke & Ganguli '18: ½k/(1+k|u|)²" },
  { id: 'arctan', label: 'ArcTan', note: "Fang et al. '21: (1/π)·k/(1+(ku)²)" },
  { id: 'sigmoid', label: 'Sigmoid', note: 'logistic step: k·σ(ku)(1−σ(ku))' },
  { id: 'triangular', label: 'Triangular', note: 'boxcar / straight-through: k on |ku|<½' },
];

// The smooth relaxation f(u): a differentiable stand-in for the Heaviside step. f(0)=½, f→1 as
// u→+∞, f→0 as u→−∞. `u` is the membrane potential *already shifted by the threshold* (u = U−θ).
export function surrogateForward(u: number, kind: SurrogateKind, k: number): number {
  const x = k * u;
  switch (kind) {
    case 'fast-sigmoid':
      return 0.5 + 0.5 * (x / (1 + Math.abs(x)));
    case 'arctan':
      return 0.5 + Math.atan(x) / Math.PI;
    case 'sigmoid':
      return 1 / (1 + Math.exp(-x));
    case 'triangular':
      return Math.max(0, Math.min(1, 0.5 + 0.5 * x));
  }
}

// The surrogate derivative f'(u) — the gradient used on the backward pass of BOTH the hard spike
// and the soft spike. This is exactly d/du of `surrogateForward`, so `softSpike` gradchecks.
export function surrogateDeriv(u: number, kind: SurrogateKind, k: number): number {
  const x = k * u;
  switch (kind) {
    case 'fast-sigmoid': {
      const d = 1 + Math.abs(x);
      return (0.5 * k) / (d * d);
    }
    case 'arctan':
      return k / (Math.PI * (1 + x * x));
    case 'sigmoid': {
      const s = 1 / (1 + Math.exp(-x));
      return k * s * (1 - s);
    }
    case 'triangular':
      return Math.abs(x) < 1 ? 0.5 * k : 0;
  }
}

// ---- the two spike ops -----------------------------------------------------------------------

// Hard spike: forward is the Heaviside threshold event S = 1[U ≥ θ] (the real, binary spike);
// backward substitutes the surrogate derivative f'(U−θ). This is what runs at inference and in
// the raster — genuine 0/1 spikes — yet still passes a usable gradient to `U`.
export function spike(U: Tensor, threshold: number, kind: SurrogateKind, k: number): Tensor {
  const out = Tensor.zeros(U.rows, U.cols);
  const o = out.data;
  const a = U.data;
  for (let i = 0; i < a.length; i++) o[i] = a[i] >= threshold ? 1 : 0;
  out.op = 'spike';
  out.prev = [U];
  out.backwardFn = () => {
    const g = out.grad;
    const ga = U.grad;
    for (let i = 0; i < g.length; i++) ga[i] += surrogateDeriv(a[i] - threshold, kind, k) * g[i];
  };
  return out;
}

// Soft spike: the fully differentiable twin. Forward IS the smooth relaxation f(U−θ), backward is
// its true derivative f'(U−θ) — the SAME closure as `spike`. Used to gradcheck the surrogate
// end-to-end (finite differences of a smooth forward), and as the "relaxed" training mode.
export function softSpike(U: Tensor, threshold: number, kind: SurrogateKind, k: number): Tensor {
  const out = Tensor.zeros(U.rows, U.cols);
  const o = out.data;
  const a = U.data;
  for (let i = 0; i < a.length; i++) o[i] = surrogateForward(a[i] - threshold, kind, k);
  out.op = 'softSpike';
  out.prev = [U];
  out.backwardFn = () => {
    const g = out.grad;
    const ga = U.grad;
    for (let i = 0; i < g.length; i++) ga[i] += surrogateDeriv(a[i] - threshold, kind, k) * g[i];
  };
  return out;
}

// ---- input encoding --------------------------------------------------------------------------

export type EncodingKind = 'current' | 'poisson' | 'latency';

export const ENCODINGS: { id: EncodingKind; label: string; note: string }[] = [
  { id: 'current', label: 'Constant current', note: 'analog pixel injected as current every step (direct coding)' },
  { id: 'poisson', label: 'Poisson rate', note: 'Bernoulli spikes with rate ∝ pixel brightness' },
  { id: 'latency', label: 'Latency (TTFS)', note: 'brighter pixel ⇒ earlier single spike' },
];

// Map a raw glyph intensity (background ≈ −0.5, ink ≈ +0.5) into [0,1] brightness.
function brightness(v: number): number {
  return Math.max(0, Math.min(1, v + 0.5));
}

// Build the per-timestep input tensors for one batch of images. Returns T tensors of shape
// [B, inDim]. For 'current' the same analog frame is injected every step; for 'poisson'/'latency'
// the frames are binary spike trains. Deterministic given `rng` (pass a seeded generator; for the
// self-test/gradcheck use 'current', which is rng-free and smooth).
export function encodeInput(
  X: Float64Array, // [B * inDim] intensities
  B: number,
  inDim: number,
  T: number,
  kind: EncodingKind,
  scale: number,
  rng: () => number,
): Tensor[] {
  const frames: Tensor[] = [];
  if (kind === 'current') {
    for (let t = 0; t < T; t++) {
      const d = new Float64Array(B * inDim);
      for (let i = 0; i < d.length; i++) d[i] = brightness(X[i]) * scale;
      frames.push(Tensor.fromFlat(d, B, inDim, false));
    }
  } else if (kind === 'poisson') {
    for (let t = 0; t < T; t++) {
      const d = new Float64Array(B * inDim);
      for (let i = 0; i < d.length; i++) d[i] = rng() < brightness(X[i]) ? scale : 0;
      frames.push(Tensor.fromFlat(d, B, inDim, false));
    }
  } else {
    // latency: one spike per pixel at t = round((1−brightness)·(T−1)); dark pixels never fire.
    const fire = new Int32Array(B * inDim).fill(-1);
    for (let i = 0; i < B * inDim; i++) {
      const b = brightness(X[i]);
      if (b > 0.05) fire[i] = Math.round((1 - b) * (T - 1));
    }
    for (let t = 0; t < T; t++) {
      const d = new Float64Array(B * inDim);
      for (let i = 0; i < d.length; i++) if (fire[i] === t) d[i] = scale;
      frames.push(Tensor.fromFlat(d, B, inDim, false));
    }
  }
  return frames;
}

// ---- the spiking network ---------------------------------------------------------------------

export interface SNNConfig {
  inDim: number;
  hidden: number[]; // LIF hidden layer widths
  classes: number;
  T: number; // simulation timesteps
  beta: number; // hidden membrane decay (exp(−dt/τ_mem)), 0<β<1
  kappa: number; // readout leaky-integrator decay
  threshold: number; // firing threshold θ
  surrogate: SurrogateKind;
  slope: number; // surrogate steepness k
  recurrent: boolean; // add a recurrent spike→spike weight within each hidden layer
  seed: number;
}

// Per-timestep activations captured from a forward pass, for the visualizers. Spikes are the
// binary raster; membrane holds a few example potentials; rates are the mean firing rate per
// neuron across time.
export interface SNNTrace {
  T: number;
  layers: { name: string; H: number; spikes: Float64Array[]; membrane: Float64Array[] }[]; // [T] frames each
  input: Float64Array[]; // [T] frames of [inDim]
  inDim: number;
  outMembrane: Float64Array[]; // [T] frames of [classes] — the readout potential over time
  logits: Float64Array; // [classes] time-summed readout
  pred: number;
}

function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function randTensor(rows: number, cols: number, std: number, rng: () => number, label: string): Tensor {
  const d = new Float64Array(rows * cols);
  for (let i = 0; i < d.length; i++) d[i] = randn(rng) * std;
  return Tensor.fromFlat(d, rows, cols, true).named(label);
}

interface LIFLayer {
  W: Tensor; // [inPrev, H]  feed-forward weight
  b: Tensor; // [1, H]       bias current
  R: Tensor | null; // [H, H] recurrent spike→spike weight (optional)
  inDim: number;
  H: number;
}

export class SNN {
  cfg: SNNConfig;
  layers: LIFLayer[] = [];
  Wout: Tensor; // [lastH, classes]
  bout: Tensor; // [1, classes]

  constructor(cfg: SNNConfig) {
    this.cfg = cfg;
    const rng = mulberry32(cfg.seed ^ 0x5b1c);
    let prev = cfg.inDim;
    for (let l = 0; l < cfg.hidden.length; l++) {
      const H = cfg.hidden[l];
      // Kaiming-ish init scaled down: spiking nets are sensitive to the input drive.
      const std = Math.sqrt(1 / prev);
      const layer: LIFLayer = {
        W: randTensor(prev, H, std, rng, `snn.W${l}`),
        b: Tensor.zeros(1, H, true).named(`snn.b${l}`),
        R: cfg.recurrent ? randTensor(H, H, Math.sqrt(1 / H) * 0.5, rng, `snn.R${l}`) : null,
        inDim: prev,
        H,
      };
      this.layers.push(layer);
      prev = H;
    }
    this.Wout = randTensor(prev, cfg.classes, Math.sqrt(1 / prev), rng, 'snn.Wout');
    this.bout = Tensor.zeros(1, cfg.classes, true).named('snn.bout');
  }

  parameters(): Tensor[] {
    const ps: Tensor[] = [];
    for (const l of this.layers) {
      ps.push(l.W, l.b);
      if (l.R) ps.push(l.R);
    }
    ps.push(this.Wout, this.bout);
    return ps;
  }

  // Run the network over T timesteps on a batch of encoded input frames. `hard` selects the
  // binary spike (inference / raster) vs the smooth relaxation (used only for the e2e gradcheck).
  // Returns the time-summed readout logits [B, classes], the summed firing counts per hidden
  // layer (for the rate-regularizer), and — if `capture` — a full per-timestep trace of ONE
  // example (row `capture.row`).
  forward(
    frames: Tensor[],
    hard: boolean,
    capture?: { row: number },
  ): { logits: Tensor; spikeCount: Tensor[]; trace: SNNTrace | null } {
    const cfg = this.cfg;
    const T = frames.length;
    const act = (U: Tensor) => (hard ? spike(U, cfg.threshold, cfg.surrogate, cfg.slope) : softSpike(U, cfg.threshold, cfg.surrogate, cfg.slope));

    // Per-layer running membrane U_l and previous spikes S_l (start at zero).
    const U: (Tensor | null)[] = this.layers.map(() => null);
    const S: (Tensor | null)[] = this.layers.map(() => null);
    const spikeCount: Tensor[] = this.layers.map(() => null as unknown as Tensor);

    let Vout: Tensor | null = null; // readout leaky-integrator membrane
    let logitSum: Tensor | null = null;

    const trace: SNNTrace | null = capture
      ? {
          T,
          inDim: cfg.inDim,
          layers: this.layers.map((l, i) => ({ name: `LIF ${i + 1}`, H: l.H, spikes: [], membrane: [] })),
          input: [],
          outMembrane: [],
          logits: new Float64Array(cfg.classes),
          pred: 0,
        }
      : null;
    const row = capture ? capture.row : 0;

    for (let t = 0; t < T; t++) {
      let layerInput = frames[t]; // [B, inDim] for the first layer
      for (let l = 0; l < this.layers.length; l++) {
        const layer = this.layers[l];
        // Feed-forward drive + bias, plus the optional recurrent drive from this layer's own
        // previous-step spikes.
        let I = layerInput.matmul(layer.W).add(layer.b);
        if (layer.R && S[l]) I = I.add(S[l]!.matmul(layer.R));
        // Leaky integration of the previous membrane, then the new input current.
        const Uprev = U[l];
        const Ucur = Uprev ? Uprev.scale(cfg.beta).add(I) : I;
        const Sl = act(Ucur);
        // Subtractive ("reset-by-subtraction") reset: spiking neurons shed exactly θ of potential.
        U[l] = Ucur.sub(Sl.scale(cfg.threshold));
        S[l] = Sl;
        spikeCount[l] = spikeCount[l] ? spikeCount[l].add(Sl) : Sl;
        layerInput = Sl;

        if (trace) {
          const sp = new Float64Array(layer.H);
          const mem = new Float64Array(layer.H);
          for (let j = 0; j < layer.H; j++) {
            sp[j] = Sl.data[row * layer.H + j];
            mem[j] = U[l]!.data[row * layer.H + j];
          }
          trace.layers[l].spikes.push(sp);
          trace.layers[l].membrane.push(mem);
        }
      }
      // Non-spiking readout: a leaky integrator whose membrane is summed over time into the logits.
      const Iout = S[this.layers.length - 1]!.matmul(this.Wout).add(this.bout);
      Vout = Vout ? Vout.scale(cfg.kappa).add(Iout) : Iout;
      logitSum = logitSum ? logitSum.add(Vout) : Vout;

      if (trace) {
        const inFrame = new Float64Array(cfg.inDim);
        for (let j = 0; j < cfg.inDim; j++) inFrame[j] = frames[t].data[row * cfg.inDim + j];
        trace.input.push(inFrame);
        const om = new Float64Array(cfg.classes);
        for (let j = 0; j < cfg.classes; j++) om[j] = Vout!.data[row * cfg.classes + j];
        trace.outMembrane.push(om);
      }
    }

    const logits = logitSum!;
    if (trace) {
      let best = 0;
      for (let j = 0; j < cfg.classes; j++) {
        trace.logits[j] = logits.data[row * cfg.classes + j];
        if (trace.logits[j] > trace.logits[best]) best = j;
      }
      trace.pred = best;
    }
    return { logits, spikeCount, trace };
  }

  exportWeights(): number[] {
    const out: number[] = [];
    for (const p of this.parameters()) for (let i = 0; i < p.size; i++) out.push(p.data[i]);
    return out;
  }

  importWeights(w: number[]): void {
    let k = 0;
    for (const p of this.parameters()) for (let i = 0; i < p.size; i++) p.data[i] = w[k++];
  }
}

// The training objective: softmax cross-entropy on the time-summed readout logits, plus an
// optional spike-rate regularizer (mean squared firing rate) that pushes the network toward
// sparse, energy-frugal codes — the "activity cost" that makes neuromorphic hardware efficient.
export function snnLoss(
  logits: Tensor,
  targets: Int32Array,
  spikeCount: Tensor[],
  T: number,
  rateReg: number,
): { loss: Tensor; ce: CEResult } {
  const ce = softmaxCrossEntropy(logits, targets);
  let loss = ce.loss;
  if (rateReg > 0 && spikeCount.length > 0) {
    // mean over neurons & batch of (spikeCount/T)² — a differentiable proxy for firing rate.
    for (const sc of spikeCount) {
      const rate = sc.scale(1 / T);
      const reg = rate.mul(rate).meanAll().scale(rateReg / spikeCount.length);
      loss = loss.add(reg);
    }
  }
  return { loss, ce };
}
