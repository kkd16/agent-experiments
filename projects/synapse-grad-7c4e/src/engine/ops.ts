// Higher-level autograd ops that don't fit as fluent Tensor methods because they carry
// state (a dropout mask, batch-norm running statistics) or differentiate several inputs at
// once (the learnable gamma/beta of a normalization layer). Like everything in the engine,
// the backward passes here are hand-derived and proven by `selftest.ts`.

import { Tensor } from './tensor';

// Inverted dropout. In training, each unit is kept with probability (1-p) and surviving
// units are scaled by 1/(1-p) so the expected activation is unchanged; in eval it is a
// pass-through. The mask is sampled once at forward time from the supplied rng and reused
// by the backward pass, so the op is a well-defined (piecewise-linear) function.
export function dropout(x: Tensor, p: number, training: boolean, rng: () => number): Tensor {
  if (!training || p <= 0) {
    // Pass-through that still participates in the graph (identity backward).
    const out = x.clone();
    out.requiresGrad = false;
    out.grad = new Float64Array(x.size);
    out.op = 'dropout(eval)';
    out.prev = [x];
    out.backwardFn = () => {
      const g = out.grad;
      const gx = x.grad;
      for (let i = 0; i < g.length; i++) gx[i] += g[i];
    };
    return out;
  }
  const scale = 1 / (1 - p);
  const mask = new Float64Array(x.size);
  const out = Tensor.zeros(x.rows, x.cols);
  const o = out.data;
  const a = x.data;
  for (let i = 0; i < a.length; i++) {
    mask[i] = rng() < p ? 0 : scale;
    o[i] = a[i] * mask[i];
  }
  out.op = 'dropout';
  out.prev = [x];
  out.backwardFn = () => {
    const g = out.grad;
    const gx = x.grad;
    for (let i = 0; i < g.length; i++) gx[i] += g[i] * mask[i];
  };
  return out;
}

// Layer normalization over the feature axis (each row normalized independently), with
// learnable per-feature scale (gamma) and shift (beta), both [1, C].
//   mu_i = mean_j x_ij,  var_i = mean_j (x_ij - mu_i)^2,  xhat_ij = (x_ij - mu_i)/sqrt(var_i+eps)
//   y_ij = gamma_j * xhat_ij + beta_j
export function layerNorm(x: Tensor, gamma: Tensor, beta: Tensor, eps = 1e-5): Tensor {
  const R = x.rows;
  const C = x.cols;
  const out = Tensor.zeros(R, C);
  const o = out.data;
  const a = x.data;
  const g = gamma.data;
  const b = beta.data;
  const xhat = new Float64Array(R * C);
  const invStd = new Float64Array(R);
  for (let i = 0; i < R; i++) {
    const base = i * C;
    let mean = 0;
    for (let j = 0; j < C; j++) mean += a[base + j];
    mean /= C;
    let varr = 0;
    for (let j = 0; j < C; j++) {
      const d = a[base + j] - mean;
      varr += d * d;
    }
    varr /= C;
    const is = 1 / Math.sqrt(varr + eps);
    invStd[i] = is;
    for (let j = 0; j < C; j++) {
      const h = (a[base + j] - mean) * is;
      xhat[base + j] = h;
      o[base + j] = g[j] * h + b[j];
    }
  }
  out.op = 'layerNorm';
  out.prev = [x, gamma, beta];
  out.backwardFn = () => {
    const go = out.grad;
    const gx = x.grad;
    const gg = gamma.grad;
    const gb = beta.grad;
    for (let i = 0; i < R; i++) {
      const base = i * C;
      // dxhat = go * gamma; reduce sums needed for the input gradient.
      let sumDxhat = 0;
      let sumDxhatXhat = 0;
      for (let j = 0; j < C; j++) {
        const dxh = go[base + j] * g[j];
        sumDxhat += dxh;
        sumDxhatXhat += dxh * xhat[base + j];
        gg[j] += go[base + j] * xhat[base + j];
        gb[j] += go[base + j];
      }
      const is = invStd[i];
      for (let j = 0; j < C; j++) {
        const dxh = go[base + j] * g[j];
        gx[base + j] += (is / C) * (C * dxh - sumDxhat - xhat[base + j] * sumDxhatXhat);
      }
    }
  };
  return out;
}

export interface BatchNormState {
  runningMean: Float64Array;
  runningVar: Float64Array;
}

export function makeBatchNormState(features: number): BatchNormState {
  return { runningMean: new Float64Array(features), runningVar: new Float64Array(features).fill(1) };
}

// Batch normalization over the batch axis (each feature normalized across the rows of the
// minibatch), with learnable gamma/beta [1, C]. In training it normalizes with the batch
// statistics and updates the running estimates; in eval it uses the running statistics
// (so the op becomes a plain affine map of x, whose backward is the simple scale path).
export function batchNorm(
  x: Tensor,
  gamma: Tensor,
  beta: Tensor,
  state: BatchNormState,
  training: boolean,
  momentum = 0.1,
  eps = 1e-5,
): Tensor {
  const R = x.rows;
  const C = x.cols;
  const out = Tensor.zeros(R, C);
  const o = out.data;
  const a = x.data;
  const g = gamma.data;
  const b = beta.data;

  if (!training || R < 2) {
    // Eval path: affine transform with frozen running stats.
    const invStd = new Float64Array(C);
    for (let j = 0; j < C; j++) invStd[j] = 1 / Math.sqrt(state.runningVar[j] + eps);
    for (let i = 0; i < R; i++) {
      const base = i * C;
      for (let j = 0; j < C; j++) {
        o[base + j] = g[j] * (a[base + j] - state.runningMean[j]) * invStd[j] + b[j];
      }
    }
    out.op = 'batchNorm(eval)';
    out.prev = [x, gamma, beta];
    out.backwardFn = () => {
      const go = out.grad;
      const gx = x.grad;
      const gg = gamma.grad;
      const gb = beta.grad;
      for (let i = 0; i < R; i++) {
        const base = i * C;
        for (let j = 0; j < C; j++) {
          const xhat = (a[base + j] - state.runningMean[j]) * invStd[j];
          gx[base + j] += go[base + j] * g[j] * invStd[j];
          gg[j] += go[base + j] * xhat;
          gb[j] += go[base + j];
        }
      }
    };
    return out;
  }

  // Training path.
  const mean = new Float64Array(C);
  const varr = new Float64Array(C);
  const invStd = new Float64Array(C);
  const xhat = new Float64Array(R * C);
  for (let j = 0; j < C; j++) {
    let m = 0;
    for (let i = 0; i < R; i++) m += a[i * C + j];
    m /= R;
    mean[j] = m;
    let v = 0;
    for (let i = 0; i < R; i++) {
      const d = a[i * C + j] - m;
      v += d * d;
    }
    v /= R;
    varr[j] = v;
    invStd[j] = 1 / Math.sqrt(v + eps);
    state.runningMean[j] = (1 - momentum) * state.runningMean[j] + momentum * m;
    state.runningVar[j] = (1 - momentum) * state.runningVar[j] + momentum * v;
  }
  for (let i = 0; i < R; i++) {
    const base = i * C;
    for (let j = 0; j < C; j++) {
      const h = (a[base + j] - mean[j]) * invStd[j];
      xhat[base + j] = h;
      o[base + j] = g[j] * h + b[j];
    }
  }
  out.op = 'batchNorm';
  out.prev = [x, gamma, beta];
  out.backwardFn = () => {
    const go = out.grad;
    const gx = x.grad;
    const gg = gamma.grad;
    const gb = beta.grad;
    // Per-feature reductions across the batch.
    for (let j = 0; j < C; j++) {
      let sumDxhat = 0;
      let sumDxhatXhat = 0;
      for (let i = 0; i < R; i++) {
        const dxh = go[i * C + j] * g[j];
        sumDxhat += dxh;
        sumDxhatXhat += dxh * xhat[i * C + j];
        gg[j] += go[i * C + j] * xhat[i * C + j];
        gb[j] += go[i * C + j];
      }
      const is = invStd[j];
      for (let i = 0; i < R; i++) {
        const dxh = go[i * C + j] * g[j];
        gx[i * C + j] += (is / R) * (R * dxh - sumDxhat - xhat[i * C + j] * sumDxhatXhat);
      }
    }
  };
  return out;
}
