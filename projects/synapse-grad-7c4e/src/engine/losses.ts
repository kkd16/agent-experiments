import { Tensor } from './tensor';

// Fused, numerically-stable softmax + cross-entropy.
//
// `logits` is [N, C]; `targets` are integer class indices in [0, C). Returns a scalar
// Tensor whose backward sets logits.grad = (softmax(logits) - onehot(targets)) / N — the
// classic clean gradient you only get when softmax and the log-loss are differentiated
// together. We stash the per-row softmax probabilities on the result for the UI to reuse.
export interface CEResult {
  loss: Tensor;
  probs: Float64Array; // [N*C] softmax probabilities
}

export function softmaxCrossEntropy(logits: Tensor, targets: Int32Array): CEResult {
  const N = logits.rows;
  const C = logits.cols;
  const probs = new Float64Array(N * C);
  let total = 0;
  for (let i = 0; i < N; i++) {
    const base = i * C;
    let max = -Infinity;
    for (let j = 0; j < C; j++) max = Math.max(max, logits.data[base + j]);
    let sum = 0;
    for (let j = 0; j < C; j++) {
      const e = Math.exp(logits.data[base + j] - max);
      probs[base + j] = e;
      sum += e;
    }
    for (let j = 0; j < C; j++) probs[base + j] /= sum;
    const t = targets[i];
    total += -Math.log(Math.max(probs[base + t], 1e-12));
  }
  const out = Tensor.zeros(1, 1);
  out.data[0] = total / N;
  out.op = 'softmaxCE';
  out.prev = [logits];
  out.backwardFn = () => {
    const seed = out.grad[0];
    const g = logits.grad;
    for (let i = 0; i < N; i++) {
      const base = i * C;
      const t = targets[i];
      for (let j = 0; j < C; j++) {
        g[base + j] += (seed * (probs[base + j] - (j === t ? 1 : 0))) / N;
      }
    }
  };
  return { loss: out, probs };
}

// Masked softmax + cross-entropy. Like `softmaxCrossEntropy`, but a per-row `keep` mask
// (1 = count this position, 0 = ignore) selects which rows contribute to the loss — the loss
// and its gradient are averaged over the kept rows only. This is what lets the Transformer
// train on just the *answer* tokens of an algorithmic sequence (copy/sort/add) while still
// running a single forward pass over the whole context.
export function maskedCrossEntropy(logits: Tensor, targets: Int32Array, keep: Uint8Array): CEResult {
  const N = logits.rows;
  const C = logits.cols;
  const probs = new Float64Array(N * C);
  let total = 0;
  let kept = 0;
  for (let i = 0; i < N; i++) {
    const base = i * C;
    let max = -Infinity;
    for (let j = 0; j < C; j++) max = Math.max(max, logits.data[base + j]);
    let sum = 0;
    for (let j = 0; j < C; j++) {
      const e = Math.exp(logits.data[base + j] - max);
      probs[base + j] = e;
      sum += e;
    }
    for (let j = 0; j < C; j++) probs[base + j] /= sum;
    if (keep[i]) {
      total += -Math.log(Math.max(probs[base + targets[i]], 1e-12));
      kept++;
    }
  }
  const M = Math.max(kept, 1);
  const out = Tensor.zeros(1, 1);
  out.data[0] = total / M;
  out.op = 'maskedCE';
  out.prev = [logits];
  out.backwardFn = () => {
    const seed = out.grad[0];
    const g = logits.grad;
    for (let i = 0; i < N; i++) {
      if (!keep[i]) continue;
      const base = i * C;
      const t = targets[i];
      for (let j = 0; j < C; j++) {
        g[base + j] += (seed * (probs[base + j] - (j === t ? 1 : 0))) / M;
      }
    }
  };
  return { loss: out, probs };
}

// Mean squared error over all elements. `pred` and `target` share a shape.
export function mse(pred: Tensor, target: Tensor): Tensor {
  if (pred.rows !== target.rows || pred.cols !== target.cols) {
    throw new Error('mse shape mismatch');
  }
  const n = pred.size;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const d = pred.data[i] - target.data[i];
    total += d * d;
  }
  const out = Tensor.zeros(1, 1);
  out.data[0] = total / n;
  out.op = 'mse';
  out.prev = [pred];
  out.backwardFn = () => {
    const seed = out.grad[0];
    const g = pred.grad;
    for (let i = 0; i < n; i++) g[i] += (seed * 2 * (pred.data[i] - target.data[i])) / n;
  };
  return out;
}

// Mean absolute error (L1). Robust to outliers; the gradient is sign(pred - target)/n.
export function mae(pred: Tensor, target: Tensor): Tensor {
  if (pred.rows !== target.rows || pred.cols !== target.cols) {
    throw new Error('mae shape mismatch');
  }
  const n = pred.size;
  let total = 0;
  for (let i = 0; i < n; i++) total += Math.abs(pred.data[i] - target.data[i]);
  const out = Tensor.zeros(1, 1);
  out.data[0] = total / n;
  out.op = 'mae';
  out.prev = [pred];
  out.backwardFn = () => {
    const seed = out.grad[0];
    const g = pred.grad;
    for (let i = 0; i < n; i++) {
      const d = pred.data[i] - target.data[i];
      g[i] += (seed * Math.sign(d)) / n;
    }
  };
  return out;
}

// Huber loss: quadratic for small residuals (|r| <= delta), linear beyond — a smooth blend
// of MSE and MAE. Gradient is r/n inside the quadratic region, delta*sign(r)/n outside.
export function huber(pred: Tensor, target: Tensor, delta = 1): Tensor {
  if (pred.rows !== target.rows || pred.cols !== target.cols) {
    throw new Error('huber shape mismatch');
  }
  const n = pred.size;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const r = pred.data[i] - target.data[i];
    total += Math.abs(r) <= delta ? 0.5 * r * r : delta * (Math.abs(r) - 0.5 * delta);
  }
  const out = Tensor.zeros(1, 1);
  out.data[0] = total / n;
  out.op = 'huber';
  out.prev = [pred];
  out.backwardFn = () => {
    const seed = out.grad[0];
    const g = pred.grad;
    for (let i = 0; i < n; i++) {
      const r = pred.data[i] - target.data[i];
      const dr = Math.abs(r) <= delta ? r : delta * Math.sign(r);
      g[i] += (seed * dr) / n;
    }
  };
  return out;
}

// Fused, numerically-stable binary cross-entropy *with logits*. `logits` is raw pre-sigmoid
// output [N, P]; `target` is the same shape with values in [0, 1]. We use the stable form
//   bce(z, t) = max(z, 0) − z·t + log(1 + e^−|z|)
// which never overflows, and sum it over the feature axis while averaging over the batch (the
// N = rows divisor), so the per-sample reconstruction term is a *sum over pixels* — the right
// scale to trade off against the per-sample KL in the VAE's ELBO. The fused backward gives the
// clean gradient `(σ(z) − t)/N` that you only get when the sigmoid and the log-loss are
// differentiated together (the same trick `softmaxCrossEntropy` uses for the multiclass case).
export function bceWithLogits(logits: Tensor, target: Tensor): Tensor {
  if (logits.rows !== target.rows || logits.cols !== target.cols) {
    throw new Error('bceWithLogits shape mismatch');
  }
  const N = logits.rows;
  const n = logits.size;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const z = logits.data[i];
    const t = target.data[i];
    total += Math.max(z, 0) - z * t + Math.log1p(Math.exp(-Math.abs(z)));
  }
  const out = Tensor.zeros(1, 1);
  out.data[0] = total / N;
  out.op = 'bceWithLogits';
  out.prev = [logits];
  out.backwardFn = () => {
    const seed = out.grad[0];
    const g = logits.grad;
    for (let i = 0; i < n; i++) {
      const s = 1 / (1 + Math.exp(-logits.data[i]));
      g[i] += (seed * (s - target.data[i])) / N;
    }
  };
  return out;
}

export type RegLoss = 'mse' | 'mae' | 'huber';

export function regressionLoss(kind: RegLoss, pred: Tensor, target: Tensor): Tensor {
  if (kind === 'mae') return mae(pred, target);
  if (kind === 'huber') return huber(pred, target, 0.5);
  return mse(pred, target);
}
