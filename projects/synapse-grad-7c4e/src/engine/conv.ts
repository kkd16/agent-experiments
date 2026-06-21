// Convolution and pooling ops for the autograd engine.
//
// The base `Tensor` is a 2-D matrix [rows, cols]; to do 2-D convolution we treat each row
// as one flattened image laid out channel-major (NCHW): for sample n, channel c, pixel
// (i, j) the value lives at  x.data[n*(C*H*W) + c*(H*W) + i*W + j].  Every op below records
// a hand-derived vector-Jacobian-product closure on the tape exactly like the core ops, so
// `backward()` flows through a CNN end-to-end and `selftest.ts` gradchecks each one against
// finite differences. The forward/backward loops are written directly (no im2col) — slower
// per FLOP than a blocked GEMM, but transparent and easy to prove correct, and plenty fast
// for the small images this lab trains on.

import { Tensor } from './tensor';

export interface ConvMeta {
  N: number; // batch size  (== x.rows)
  Cin: number;
  H: number;
  W: number;
  Cout: number;
  kh: number;
  kw: number;
  stride: number;
  pad: number;
}

export interface PoolMeta {
  N: number;
  C: number;
  H: number;
  W: number;
  k: number; // square pooling window
  stride: number;
}

export function convOut(size: number, k: number, stride: number, pad: number): number {
  return Math.floor((size + 2 * pad - k) / stride) + 1;
}

export function poolOut(size: number, k: number, stride: number): number {
  return Math.floor((size - k) / stride) + 1;
}

// Does this tensor need a gradient? Leaves with requiresGrad, or any non-leaf (intermediate
// result), participate in backprop; a plain input leaf (e.g. the raw image batch) does not,
// and we skip computing its gradient to save work.
function needsGrad(t: Tensor): boolean {
  return t.requiresGrad || t.op !== 'leaf';
}

// 2-D cross-correlation (the "convolution" of deep learning — no kernel flip).
//   x      [N, Cin*H*W]            input feature maps (NCHW, flattened per row)
//   weight [Cout, Cin*kh*kw]       one flattened kernel stack per output channel
//   bias   [1, Cout]               per-output-channel bias
//   -> out [N, Cout*Hout*Wout]
export function conv2d(x: Tensor, weight: Tensor, bias: Tensor, meta: ConvMeta): Tensor {
  const { N, Cin, H, W, Cout, kh, kw, stride, pad } = meta;
  const Hout = convOut(H, kh, stride, pad);
  const Wout = convOut(W, kw, stride, pad);
  if (x.rows !== N || x.cols !== Cin * H * W) {
    throw new Error(`conv2d input shape mismatch: [${x.rows},${x.cols}] vs N=${N} Cin*H*W=${Cin * H * W}`);
  }
  if (weight.rows !== Cout || weight.cols !== Cin * kh * kw) {
    throw new Error(`conv2d weight shape mismatch: [${weight.rows},${weight.cols}]`);
  }

  const out = Tensor.zeros(N, Cout * Hout * Wout);
  const xd = x.data;
  const wd = weight.data;
  const bd = bias.data;
  const od = out.data;

  const inImg = Cin * H * W;
  const inCh = H * W;
  const wCh = Cin * kh * kw;
  const wPerCh = kh * kw;
  const outImg = Cout * Hout * Wout;
  const outCh = Hout * Wout;

  for (let n = 0; n < N; n++) {
    const xBase = n * inImg;
    const oBase = n * outImg;
    for (let co = 0; co < Cout; co++) {
      const wBase = co * wCh;
      const ocBase = oBase + co * outCh;
      const b = bd[co];
      for (let oi = 0; oi < Hout; oi++) {
        const i0 = oi * stride - pad;
        for (let oj = 0; oj < Wout; oj++) {
          const j0 = oj * stride - pad;
          let acc = b;
          for (let ci = 0; ci < Cin; ci++) {
            const xcBase = xBase + ci * inCh;
            const wcBase = wBase + ci * wPerCh;
            for (let ki = 0; ki < kh; ki++) {
              const ii = i0 + ki;
              if (ii < 0 || ii >= H) continue;
              const xRow = xcBase + ii * W;
              const wRow = wcBase + ki * kw;
              for (let kj = 0; kj < kw; kj++) {
                const jj = j0 + kj;
                if (jj < 0 || jj >= W) continue;
                acc += wd[wRow + kj] * xd[xRow + jj];
              }
            }
          }
          od[ocBase + oi * Wout + oj] = acc;
        }
      }
    }
  }

  out.op = 'conv2d';
  out.prev = [x, weight, bias];
  const needX = needsGrad(x);
  out.backwardFn = () => {
    const go = out.grad;
    const gx = x.grad;
    const gw = weight.grad;
    const gb = bias.grad;
    for (let n = 0; n < N; n++) {
      const xBase = n * inImg;
      const oBase = n * outImg;
      for (let co = 0; co < Cout; co++) {
        const wBase = co * wCh;
        const ocBase = oBase + co * outCh;
        for (let oi = 0; oi < Hout; oi++) {
          const i0 = oi * stride - pad;
          for (let oj = 0; oj < Wout; oj++) {
            const g = go[ocBase + oi * Wout + oj];
            if (g === 0) continue;
            gb[co] += g;
            const j0 = oj * stride - pad;
            for (let ci = 0; ci < Cin; ci++) {
              const xcBase = xBase + ci * inCh;
              const wcBase = wBase + ci * wPerCh;
              for (let ki = 0; ki < kh; ki++) {
                const ii = i0 + ki;
                if (ii < 0 || ii >= H) continue;
                const xRow = xcBase + ii * W;
                const wRow = wcBase + ki * kw;
                for (let kj = 0; kj < kw; kj++) {
                  const jj = j0 + kj;
                  if (jj < 0 || jj >= W) continue;
                  gw[wRow + kj] += g * xd[xRow + jj];
                  if (needX) gx[xRow + jj] += g * wd[wRow + kj];
                }
              }
            }
          }
        }
      }
    }
  };
  return out;
}

// Max pooling over non-overlapping (or strided) square windows, per channel.
//   x   [N, C*H*W]  ->  out [N, C*Hout*Wout]
// The backward routes each output's gradient to the single input that won its window
// (an argmax sub-gradient); ties have measure zero under the engine's continuous inputs.
export function maxPool2d(x: Tensor, meta: PoolMeta): Tensor {
  const { N, C, H, W, k, stride } = meta;
  const Hout = poolOut(H, k, stride);
  const Wout = poolOut(W, k, stride);
  const out = Tensor.zeros(N, C * Hout * Wout);
  const xd = x.data;
  const od = out.data;
  const argmax = new Int32Array(N * C * Hout * Wout); // flat index into x.data of the winner

  const inImg = C * H * W;
  const inCh = H * W;
  const outImg = C * Hout * Wout;
  const outCh = Hout * Wout;

  for (let n = 0; n < N; n++) {
    const xBase = n * inImg;
    const oBase = n * outImg;
    for (let c = 0; c < C; c++) {
      const xcBase = xBase + c * inCh;
      const ocBase = oBase + c * outCh;
      for (let oi = 0; oi < Hout; oi++) {
        for (let oj = 0; oj < Wout; oj++) {
          let best = -Infinity;
          let bestIdx = -1;
          for (let ki = 0; ki < k; ki++) {
            const ii = oi * stride + ki;
            if (ii >= H) continue;
            const xRow = xcBase + ii * W;
            for (let kj = 0; kj < k; kj++) {
              const jj = oj * stride + kj;
              if (jj >= W) continue;
              const v = xd[xRow + jj];
              if (v > best) {
                best = v;
                bestIdx = xRow + jj;
              }
            }
          }
          const oIdx = ocBase + oi * Wout + oj;
          od[oIdx] = best;
          argmax[oIdx] = bestIdx;
        }
      }
    }
  }

  out.op = 'maxPool2d';
  out.prev = [x];
  const needX = needsGrad(x);
  out.backwardFn = () => {
    if (!needX) return;
    const go = out.grad;
    const gx = x.grad;
    for (let i = 0; i < go.length; i++) {
      const src = argmax[i];
      if (src >= 0) gx[src] += go[i];
    }
  };
  return out;
}

// Average pooling over square windows, per channel. backward distributes each output's
// gradient equally across the input cells that contributed to its window average.
export function avgPool2d(x: Tensor, meta: PoolMeta): Tensor {
  const { N, C, H, W, k, stride } = meta;
  const Hout = poolOut(H, k, stride);
  const Wout = poolOut(W, k, stride);
  const out = Tensor.zeros(N, C * Hout * Wout);
  const xd = x.data;
  const od = out.data;
  const counts = new Int32Array(N * C * Hout * Wout);

  const inImg = C * H * W;
  const inCh = H * W;
  const outImg = C * Hout * Wout;
  const outCh = Hout * Wout;

  for (let n = 0; n < N; n++) {
    const xBase = n * inImg;
    const oBase = n * outImg;
    for (let c = 0; c < C; c++) {
      const xcBase = xBase + c * inCh;
      const ocBase = oBase + c * outCh;
      for (let oi = 0; oi < Hout; oi++) {
        for (let oj = 0; oj < Wout; oj++) {
          let sum = 0;
          let cnt = 0;
          for (let ki = 0; ki < k; ki++) {
            const ii = oi * stride + ki;
            if (ii >= H) continue;
            const xRow = xcBase + ii * W;
            for (let kj = 0; kj < k; kj++) {
              const jj = oj * stride + kj;
              if (jj >= W) continue;
              sum += xd[xRow + jj];
              cnt++;
            }
          }
          const oIdx = ocBase + oi * Wout + oj;
          od[oIdx] = cnt > 0 ? sum / cnt : 0;
          counts[oIdx] = cnt;
        }
      }
    }
  }

  out.op = 'avgPool2d';
  out.prev = [x];
  const needX = needsGrad(x);
  out.backwardFn = () => {
    if (!needX) return;
    const go = out.grad;
    const gx = x.grad;
    for (let n = 0; n < N; n++) {
      const xBase = n * inImg;
      const oBase = n * outImg;
      for (let c = 0; c < C; c++) {
        const xcBase = xBase + c * inCh;
        const ocBase = oBase + c * outCh;
        for (let oi = 0; oi < Hout; oi++) {
          for (let oj = 0; oj < Wout; oj++) {
            const oIdx = ocBase + oi * Wout + oj;
            const share = go[oIdx] / counts[oIdx];
            for (let ki = 0; ki < k; ki++) {
              const ii = oi * stride + ki;
              if (ii >= H) continue;
              const xRow = xcBase + ii * W;
              for (let kj = 0; kj < k; kj++) {
                const jj = oj * stride + kj;
                if (jj >= W) continue;
                gx[xRow + jj] += share;
              }
            }
          }
        }
      }
    }
  };
  return out;
}
