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

// Embedding lookup: gather rows of a table [V, D] by integer ids -> [T, D]. The forward is a
// plain copy; the backward scatter-adds each output row's gradient back into the row of the
// table it came from (a row used by several positions accumulates all of their gradients).
// This is exactly equivalent to a one-hot @ table matmul, but O(T·D) instead of O(T·V·D).
export function embedding(table: Tensor, ids: Int32Array): Tensor {
  const V = table.rows;
  const D = table.cols;
  const T = ids.length;
  const out = Tensor.zeros(T, D);
  const o = out.data;
  const e = table.data;
  for (let t = 0; t < T; t++) {
    const id = ids[t];
    if (id < 0 || id >= V) throw new Error(`embedding id ${id} out of range [0,${V})`);
    const src = id * D;
    const dst = t * D;
    for (let j = 0; j < D; j++) o[dst + j] = e[src + j];
  }
  out.op = 'embedding';
  out.prev = [table];
  out.backwardFn = () => {
    const g = out.grad;
    const gt = table.grad;
    for (let t = 0; t < T; t++) {
      const src = ids[t] * D;
      const dst = t * D;
      for (let j = 0; j < D; j++) gt[src + j] += g[dst + j];
    }
  };
  return out;
}

// Concatenate several tensors along the feature (column) axis. All must share the row count;
// the result is [R, Σ cols]. Backward slices the output gradient back to each part. Used to
// merge the per-head outputs of multi-head attention before the output projection.
export function concatCols(parts: Tensor[]): Tensor {
  if (parts.length === 0) throw new Error('concatCols needs at least one tensor');
  const R = parts[0].rows;
  let total = 0;
  for (const p of parts) {
    if (p.rows !== R) throw new Error('concatCols row mismatch');
    total += p.cols;
  }
  const out = Tensor.zeros(R, total);
  const o = out.data;
  let colOff = 0;
  for (const p of parts) {
    const a = p.data;
    for (let i = 0; i < R; i++) {
      const dst = i * total + colOff;
      const src = i * p.cols;
      for (let j = 0; j < p.cols; j++) o[dst + j] = a[src + j];
    }
    colOff += p.cols;
  }
  out.op = 'concatCols';
  out.prev = parts.slice();
  out.backwardFn = () => {
    const g = out.grad;
    let off = 0;
    for (const p of parts) {
      const gp = p.grad;
      for (let i = 0; i < R; i++) {
        const src = i * total + off;
        const dst = i * p.cols;
        for (let j = 0; j < p.cols; j++) gp[dst + j] += g[src + j];
      }
      off += p.cols;
    }
  };
  return out;
}

// Stack several equal-width tensors along the row axis: [r0,C] , [r1,C] , … -> [Σr, C].
// The dual of `concatCols`. A recurrent net emits one logit row [1,V] per timestep, and this
// glues the whole unrolled sequence back into the [T,V] matrix the shared masked-cross-entropy
// loss (and the accuracy readout) expects — so the RNN trains through exactly the same loss the
// Transformer does. Backward slices the output gradient back to each part, contiguously.
export function stackRows(parts: Tensor[]): Tensor {
  if (parts.length === 0) throw new Error('stackRows needs at least one tensor');
  const C = parts[0].cols;
  let total = 0;
  for (const p of parts) {
    if (p.cols !== C) throw new Error('stackRows column mismatch');
    total += p.rows;
  }
  const out = Tensor.zeros(total, C);
  let off = 0;
  for (const p of parts) {
    out.data.set(p.data, off * C);
    off += p.rows;
  }
  out.op = 'stackRows';
  out.prev = parts.slice();
  out.backwardFn = () => {
    const g = out.grad;
    let roff = 0;
    for (const p of parts) {
      const gp = p.grad;
      const base = roff * C;
      for (let k = 0; k < p.size; k++) gp[k] += g[base + k];
      roff += p.rows;
    }
  };
  return out;
}

// Per-row column gather: pick one entry from each row by an integer index, giving a [R, 1]
// column. out[i] = x[i, idx[i]]. The backward scatters each output gradient straight back to
// the single entry it came from. This is what reads off the log-probability of the *chosen*
// action from a row of per-action log-probabilities — the heart of the policy-gradient loss —
// and it's exactly the multiclass analogue of the one-hot · x picking used by cross-entropy,
// but O(R) instead of O(R·C).
export function gatherCols(x: Tensor, idx: Int32Array): Tensor {
  const R = x.rows;
  const C = x.cols;
  if (idx.length !== R) throw new Error(`gatherCols index length ${idx.length} != rows ${R}`);
  const out = Tensor.zeros(R, 1);
  const o = out.data;
  const a = x.data;
  for (let i = 0; i < R; i++) {
    const j = idx[i];
    if (j < 0 || j >= C) throw new Error(`gatherCols index ${j} out of range [0,${C})`);
    o[i] = a[i * C + j];
  }
  out.op = 'gatherCols';
  out.prev = [x];
  out.backwardFn = () => {
    const g = out.grad;
    const gx = x.grad;
    for (let i = 0; i < R; i++) gx[i * C + idx[i]] += g[i];
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
