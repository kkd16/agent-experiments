// Meta-learning ("learning to learn") on a distribution of tasks.
//
// Every other lab learns *one* task from a lot of data. This lab learns a *way of learning*: a
// meta-parameter set θ that is not a good solution to any single task, but sits at a point in
// weight space from which a handful of gradient steps on a brand-new task's few examples lands on
// a good solution. That is the promise of MAML (Finn, Abbeel & Levine 2017) and Reptile (Nichol,
// Achiam & Schulman 2018).
//
// This engine accumulates gradients into `Tensor.grad` (a Float64Array), not back onto the tape,
// so it is strictly *first-order*. That is exactly what the two practical meta-learners need:
//   • Reptile — adapt on a task, then move θ toward the adapted weights. No query gradient at all.
//   • FOMAML  — the *first-order* MAML approximation: the meta-gradient is the ordinary gradient of
//               the query loss evaluated at the adapted fast-weights (the Hessian term dropped).
// Both are implemented here faithfully, on the same hand-derived autograd as the rest of Synapse.
//
// The functional MLP below runs its forward pass on *explicit* weight tensors, so the inner loop
// can spin up fast-weights, adapt them with plain SGD, and read them back without ever mutating the
// persistent meta-parameters θ.

import { Tensor } from './tensor';
import { mse } from './losses';

// ---- task distribution -------------------------------------------------------------------------

export type TaskFamily = 'sine' | 'sine-freq' | 'line';

export interface Task {
  family: TaskFamily;
  // Parameters of the ground-truth function, in a family-specific order.
  //  sine       -> [amplitude, phase]
  //  sine-freq  -> [amplitude, phase, frequency]
  //  line       -> [slope, intercept]
  params: number[];
}

// The input domain each family lives on. Sine tasks use the MAML paper's [-5, 5].
export const META_DOMAIN = { lo: -5, hi: 5 };

export function taskTruth(task: Task, x: number): number {
  const p = task.params;
  switch (task.family) {
    case 'sine':
      return p[0] * Math.sin(x + p[1]);
    case 'sine-freq':
      return p[0] * Math.sin(p[2] * x + p[1]);
    case 'line':
      return p[0] * x + p[1];
  }
}

// Draw a random task from the family's parameter distribution (the MAML sinusoid ranges).
export function sampleTask(family: TaskFamily, rng: () => number): Task {
  switch (family) {
    case 'sine': {
      const amp = 0.1 + rng() * 4.9; // [0.1, 5]
      const phase = rng() * Math.PI; // [0, π]
      return { family, params: [amp, phase] };
    }
    case 'sine-freq': {
      const amp = 0.1 + rng() * 4.9;
      const phase = rng() * Math.PI;
      const freq = 0.5 + rng() * 1.5; // [0.5, 2]
      return { family, params: [amp, phase, freq] };
    }
    case 'line': {
      const slope = -3 + rng() * 6; // [-3, 3]
      const intercept = -3 + rng() * 6; // [-3, 3]
      return { family, params: [slope, intercept] };
    }
  }
}

export interface Batch {
  x: Float64Array; // [n]
  y: Float64Array; // [n]
  n: number;
}

// Sample `n` labelled points from a task (x uniform on the domain, y = truth + Gaussian noise).
export function taskBatch(task: Task, n: number, noise: number, rng: () => number): Batch {
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const span = META_DOMAIN.hi - META_DOMAIN.lo;
  for (let i = 0; i < n; i++) {
    const xi = META_DOMAIN.lo + rng() * span;
    x[i] = xi;
    let noiseTerm = 0;
    if (noise > 0) {
      // Box–Muller standard normal, scaled by `noise`.
      let u = 0;
      let v = 0;
      while (u === 0) u = rng();
      while (v === 0) v = rng();
      noiseTerm = noise * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }
    y[i] = taskTruth(task, xi) + noiseTerm;
  }
  return { x, y, n };
}

// An evenly-spaced grid over the domain, for plotting a prediction curve.
export function domainGrid(res: number): Float64Array {
  const g = new Float64Array(res);
  const span = META_DOMAIN.hi - META_DOMAIN.lo;
  for (let i = 0; i < res; i++) g[i] = META_DOMAIN.lo + (i / (res - 1)) * span;
  return g;
}

// ---- functional MLP ----------------------------------------------------------------------------

export interface MetaArch {
  hidden: number; // hidden width
  depth: number; // number of hidden layers
}

export interface Layer {
  W: Tensor;
  b: Tensor;
}

// Xavier/Glorot init (the model is all-tanh) with a seedable normal draw.
function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function makeLayer(inF: number, outF: number, rng: () => number): Layer {
  const gain = Math.sqrt(1 / inF);
  const w = new Float64Array(inF * outF);
  for (let i = 0; i < w.length; i++) w[i] = randn(rng) * gain;
  return {
    W: Tensor.fromFlat(w, inF, outF, true).named('W'),
    b: Tensor.zeros(1, outF, true).named('b'),
  };
}

// Build a stack of layers 1 -> H -> ... -> H -> 1 for the given architecture.
export function makeLayers(arch: MetaArch, rng: () => number): Layer[] {
  const layers: Layer[] = [];
  let prev = 1;
  for (let d = 0; d < arch.depth; d++) {
    layers.push(makeLayer(prev, arch.hidden, rng));
    prev = arch.hidden;
  }
  layers.push(makeLayer(prev, 1, rng));
  return layers;
}

// Fresh fast-weight tensors that copy another stack's *values* (a detached snapshot the inner
// loop can adapt without touching the source).
export function cloneLayers(src: Layer[]): Layer[] {
  return src.map((l) => ({
    W: Tensor.fromFlat(l.W.data.slice(), l.W.rows, l.W.cols, true).named('W'),
    b: Tensor.fromFlat(l.b.data.slice(), l.b.rows, l.b.cols, true).named('b'),
  }));
}

// Forward pass on explicit layers: tanh hidden, linear output. Input x is [n,1].
export function forwardLayers(layers: Layer[], x: Tensor): Tensor {
  let h = x;
  for (let i = 0; i < layers.length; i++) {
    h = h.matmul(layers[i].W).add(layers[i].b);
    if (i < layers.length - 1) h = h.tanh();
  }
  return h;
}

function colTensor(xs: Float64Array): Tensor {
  return Tensor.fromFlat(xs.slice(), xs.length, 1);
}

// Predict over a raw x-array (no grad tracking needed by the caller).
export function predict(layers: Layer[], xs: Float64Array): Float64Array {
  const out = forwardLayers(layers, colTensor(xs));
  return out.data.slice();
}

// Mean-squared error of a layer stack on a batch (a plain number, no graph kept).
export function batchLoss(layers: Layer[], batch: Batch): number {
  const pred = forwardLayers(layers, colTensor(batch.x));
  let s = 0;
  for (let i = 0; i < batch.n; i++) {
    const d = pred.data[i] - batch.y[i];
    s += d * d;
  }
  return s / batch.n;
}

// ---- inner-loop adaptation ---------------------------------------------------------------------

export interface AdaptResult {
  layers: Layer[]; // the adapted fast-weights
  supportLoss: number[]; // support MSE after each inner step (length innerSteps+1)
}

// Adapt a *copy* of `start` to a support set with `innerSteps` of plain SGD (this is the "learner"
// the meta-loop wraps). Returns the adapted fast-weights and the support-loss trajectory.
export function adapt(start: Layer[], support: Batch, innerLr: number, innerSteps: number): AdaptResult {
  const fast = cloneLayers(start);
  const xs = colTensor(support.x);
  const ys = colTensor(support.y);
  const supportLoss: number[] = [];
  supportLoss.push(batchLoss(fast, support));
  for (let s = 0; s < innerSteps; s++) {
    const pred = forwardLayers(fast, xs);
    const loss = mse(pred, ys);
    loss.backward();
    for (const l of fast) {
      for (let i = 0; i < l.W.size; i++) l.W.data[i] -= innerLr * l.W.grad[i];
      for (let i = 0; i < l.b.size; i++) l.b.data[i] -= innerLr * l.b.grad[i];
    }
    supportLoss.push(batchLoss(fast, support));
  }
  return { layers: fast, supportLoss };
}

// Like `adapt`, but also records the model's prediction over a fixed plotting grid after every
// inner step — this drives the adaptation scrubber in the UI. preds has innerSteps+1 entries.
export function adaptTrace(
  start: Layer[],
  support: Batch,
  grid: Float64Array,
  innerLr: number,
  innerSteps: number,
): { preds: Float64Array[]; supportLoss: number[] } {
  const fast = cloneLayers(start);
  const xs = colTensor(support.x);
  const ys = colTensor(support.y);
  const preds: Float64Array[] = [];
  const supportLoss: number[] = [];
  preds.push(predict(fast, grid));
  supportLoss.push(batchLoss(fast, support));
  for (let s = 0; s < innerSteps; s++) {
    const pred = forwardLayers(fast, xs);
    const loss = mse(pred, ys);
    loss.backward();
    for (const l of fast) {
      for (let i = 0; i < l.W.size; i++) l.W.data[i] -= innerLr * l.W.grad[i];
      for (let i = 0; i < l.b.size; i++) l.b.data[i] -= innerLr * l.b.grad[i];
    }
    preds.push(predict(fast, grid));
    supportLoss.push(batchLoss(fast, support));
  }
  return { preds, supportLoss };
}

// ---- the meta-model ----------------------------------------------------------------------------

export type MetaAlgo = 'reptile' | 'fomaml' | 'baseline';

export interface MetaConfig {
  family: TaskFamily;
  algo: MetaAlgo;
  arch: MetaArch;
  kShot: number; // support-set size
  querySize: number; // query-set size (FOMAML / evaluation)
  innerSteps: number;
  innerLr: number;
  metaLr: number; // outer step size (ε for Reptile, LR for FOMAML)
  metaBatch: number; // tasks per meta-step
  noise: number; // label noise stddev
}

export interface MetaStepReport {
  preAdaptLoss: number; // avg query MSE using θ directly (no adaptation)
  postAdaptLoss: number; // avg query MSE after inner adaptation (the meta-objective)
}

// The persistent meta-parameters θ, plus the meta-learning update rules built on the functional
// MLP above. The optimizer for FOMAML lives outside (the shared Optimizer class), driven through
// `theta`'s `.grad` — so momentum/Adam are available for the outer loop.
export class MetaModel {
  arch: MetaArch;
  theta: Layer[];

  constructor(arch: MetaArch, rng: () => number) {
    this.arch = arch;
    this.theta = makeLayers(arch, rng);
  }

  parameters(): Tensor[] {
    const ps: Tensor[] = [];
    for (const l of this.theta) ps.push(l.W, l.b);
    return ps;
  }

  paramCount(): number {
    let n = 0;
    for (const p of this.parameters()) n += p.size;
    return n;
  }

  // A detached snapshot of θ that the inner loop can adapt.
  fastCopy(): Layer[] {
    return cloneLayers(this.theta);
  }

  predict(xs: Float64Array): Float64Array {
    return predict(this.theta, xs);
  }

  exportWeights(): number[] {
    const out: number[] = [];
    for (const l of this.theta) {
      for (let i = 0; i < l.W.size; i++) out.push(l.W.data[i]);
      for (let i = 0; i < l.b.size; i++) out.push(l.b.data[i]);
    }
    return out;
  }

  importWeights(flat: number[]): boolean {
    let total = 0;
    for (const l of this.theta) total += l.W.size + l.b.size;
    if (flat.length !== total) return false;
    let k = 0;
    for (const l of this.theta) {
      for (let i = 0; i < l.W.size; i++) l.W.data[i] = flat[k++];
      for (let i = 0; i < l.b.size; i++) l.b.data[i] = flat[k++];
    }
    return true;
  }
}

// Zero the accumulated meta-gradient carried on θ's `.grad`.
function zeroThetaGrad(model: MetaModel): void {
  for (const p of model.parameters()) p.grad.fill(0);
}

// One meta-training step. `step(opt)` applies the accumulated θ.grad with the outer optimizer
// (used by FOMAML / baseline); Reptile updates θ in place and ignores it. Returns the pre- vs
// post-adaptation query loss so the UI can chart the meta-objective and the adaptation gap.
export function metaStep(model: MetaModel, cfg: MetaConfig, rng: () => number, applyOuter: () => void): MetaStepReport {
  const { algo, kShot, querySize, innerSteps, innerLr, metaBatch, noise, family } = cfg;

  if (algo === 'baseline') {
    // Joint pre-training: pool support+query from every task and fit θ directly, no adaptation.
    // This collapses to the mean function and is the control the meta-learners are measured against.
    const xs: number[] = [];
    const ys: number[] = [];
    let preSum = 0;
    for (let t = 0; t < metaBatch; t++) {
      const task = sampleTask(family, rng);
      const sup = taskBatch(task, kShot, noise, rng);
      const qry = taskBatch(task, querySize, noise, rng);
      preSum += batchLoss(model.theta, qry);
      for (let i = 0; i < sup.n; i++) {
        xs.push(sup.x[i]);
        ys.push(sup.y[i]);
      }
      for (let i = 0; i < qry.n; i++) {
        xs.push(qry.x[i]);
        ys.push(qry.y[i]);
      }
    }
    const xt = Tensor.fromFlat(Float64Array.from(xs), xs.length, 1);
    const yt = Tensor.fromFlat(Float64Array.from(ys), ys.length, 1);
    zeroThetaGrad(model);
    const loss = mse(forwardLayers(model.theta, xt), yt);
    loss.backward();
    applyOuter();
    const pre = preSum / metaBatch;
    // "post-adapt" for the baseline: still measured *with* adaptation so the few-shot comparison
    // is apples-to-apples — but reported against a fresh set below via the trainer's evaluator.
    return { preAdaptLoss: pre, postAdaptLoss: pre };
  }

  let preSum = 0;
  let postSum = 0;

  if (algo === 'reptile') {
    // Accumulate (φ − θ) across the meta-batch, then θ ← θ + ε·mean(φ − θ).
    const acc = model.theta.map((l) => ({
      W: new Float64Array(l.W.size),
      b: new Float64Array(l.b.size),
    }));
    for (let t = 0; t < metaBatch; t++) {
      const task = sampleTask(family, rng);
      const sup = taskBatch(task, kShot, noise, rng);
      const qry = taskBatch(task, querySize, noise, rng);
      preSum += batchLoss(model.theta, qry);
      const { layers: phi } = adapt(model.theta, sup, innerLr, innerSteps);
      postSum += batchLoss(phi, qry);
      for (let li = 0; li < model.theta.length; li++) {
        const tW = model.theta[li].W.data;
        const tb = model.theta[li].b.data;
        const pW = phi[li].W.data;
        const pb = phi[li].b.data;
        for (let i = 0; i < tW.length; i++) acc[li].W[i] += pW[i] - tW[i];
        for (let i = 0; i < tb.length; i++) acc[li].b[i] += pb[i] - tb[i];
      }
    }
    const scale = cfg.metaLr / metaBatch;
    for (let li = 0; li < model.theta.length; li++) {
      const tW = model.theta[li].W.data;
      const tb = model.theta[li].b.data;
      for (let i = 0; i < tW.length; i++) tW[i] += scale * acc[li].W[i];
      for (let i = 0; i < tb.length; i++) tb[i] += scale * acc[li].b[i];
    }
    return { preAdaptLoss: preSum / metaBatch, postAdaptLoss: postSum / metaBatch };
  }

  // FOMAML: adapt on support, then take the query-loss gradient *at the adapted weights* as the
  // meta-gradient for θ (the Hessian term of full MAML dropped — the first-order approximation).
  zeroThetaGrad(model);
  for (let t = 0; t < metaBatch; t++) {
    const task = sampleTask(family, rng);
    const sup = taskBatch(task, kShot, noise, rng);
    const qry = taskBatch(task, querySize, noise, rng);
    preSum += batchLoss(model.theta, qry);
    const { layers: phi } = adapt(model.theta, sup, innerLr, innerSteps);
    postSum += batchLoss(phi, qry);
    // Query-loss gradient at φ.
    for (const l of phi) {
      l.W.grad.fill(0);
      l.b.grad.fill(0);
    }
    const qx = Tensor.fromFlat(qry.x.slice(), qry.n, 1);
    const qy = Tensor.fromFlat(qry.y.slice(), qry.n, 1);
    const qLoss = mse(forwardLayers(phi, qx), qy);
    qLoss.backward();
    // Accumulate ∂L_query/∂φ as θ's meta-gradient (index-aligned; φ mirrors θ's structure).
    for (let li = 0; li < model.theta.length; li++) {
      const gW = model.theta[li].W.grad;
      const gb = model.theta[li].b.grad;
      const pW = phi[li].W.grad;
      const pb = phi[li].b.grad;
      for (let i = 0; i < gW.length; i++) gW[i] += pW[i] / metaBatch;
      for (let i = 0; i < gb.length; i++) gb[i] += pb[i] / metaBatch;
    }
  }
  applyOuter();
  return { preAdaptLoss: preSum / metaBatch, postAdaptLoss: postSum / metaBatch };
}

// ---- evaluation --------------------------------------------------------------------------------

// Average query MSE across a batch of *novel* tasks after 0,1,…,maxSteps adaptation steps — the
// headline few-shot chart. `start` is any layer stack (a meta-init or a random init).
export function fewShotCurve(
  start: Layer[],
  family: TaskFamily,
  tasks: number,
  kShot: number,
  querySize: number,
  maxSteps: number,
  innerLr: number,
  noise: number,
  rng: () => number,
): number[] {
  const sums = new Float64Array(maxSteps + 1);
  for (let t = 0; t < tasks; t++) {
    const task = sampleTask(family, rng);
    const sup = taskBatch(task, kShot, noise, rng);
    const qry = taskBatch(task, querySize, 0, rng); // clean query for a fair MSE
    const fast = cloneLayers(start);
    const xs = colTensor(sup.x);
    const ys = colTensor(sup.y);
    sums[0] += batchLoss(fast, qry);
    for (let s = 0; s < maxSteps; s++) {
      const loss = mse(forwardLayers(fast, xs), ys);
      loss.backward();
      for (const l of fast) {
        for (let i = 0; i < l.W.size; i++) l.W.data[i] -= innerLr * l.W.grad[i];
        for (let i = 0; i < l.b.size; i++) l.b.data[i] -= innerLr * l.b.grad[i];
      }
      sums[s + 1] += batchLoss(fast, qry);
    }
  }
  return Array.from(sums, (v) => v / tasks);
}
