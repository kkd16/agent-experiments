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
