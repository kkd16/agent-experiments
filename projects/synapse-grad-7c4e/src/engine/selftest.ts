// Automated engine self-test. For every op in the engine we build a small randomized
// computation graph, reduce it to a scalar with a fixed random weighting, take the analytic
// gradient via the tape, and compare it entry-by-entry against a central finite-difference
// estimate. The maximum relative disagreement for each op should be ~1e-6 — that is the
// machine-checked proof that the hand-derived backward passes are correct, surfaced in the UI.

import { Tensor } from './tensor';
import { dropout, layerNorm, batchNorm, makeBatchNormState, embedding, concatCols } from './ops';
import { conv2d, maxPool2d, avgPool2d } from './conv';
import { maskedCrossEntropy } from './losses';
import { GPT } from './transformer';

export interface OpCheck {
  name: string;
  maxRelError: number;
  meanRelError: number;
  checked: number;
}

export interface SelfTestReport {
  ops: OpCheck[];
  maxRelError: number;
  passed: boolean;
}

function rngFrom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// A leaf tensor of the given shape filled with values in [-1,1], nudged away from 0 so
// activation kinks (ReLU/LeakyReLU/ELU at 0) don't sit under the finite-difference window.
function leaf(rng: () => number, rows: number, cols: number, positive = false): Tensor {
  const d = new Float64Array(rows * cols);
  for (let i = 0; i < d.length; i++) {
    let v = rng() * 2 - 1;
    if (positive) v = Math.abs(v) + 0.5;
    else if (Math.abs(v) < 0.15) v += v >= 0 ? 0.15 : -0.15;
    d[i] = v;
  }
  return Tensor.fromFlat(d, rows, cols, true);
}

// Gradient-check one op. `forward` must be a pure function of the supplied input tensors'
// data (it may allocate fresh intermediates each call). We weight the output by a fixed
// random vector to form a scalar loss with non-trivial gradients everywhere.
function checkOp(
  name: string,
  inputs: Tensor[],
  forward: () => Tensor,
  rng: () => number,
  eps = 1e-5,
): OpCheck {
  const out = forward();
  const W = new Float64Array(out.size);
  for (let i = 0; i < W.length; i++) W[i] = rng() * 2 - 1;

  const scalarLoss = (o: Tensor): number => {
    let s = 0;
    for (let i = 0; i < o.size; i++) s += o.data[i] * W[i];
    return s;
  };

  // Analytic gradients: build loss = sum(out * W) through the engine and back-propagate.
  const Wt = Tensor.fromFlat(W.slice(), out.rows, out.cols, false);
  out.mul(Wt).sumAll().backward();
  const analytic = inputs.map((t) => t.grad.slice());

  let maxRel = 0;
  let sumRel = 0;
  let count = 0;
  for (let pi = 0; pi < inputs.length; pi++) {
    const p = inputs[pi];
    for (let idx = 0; idx < p.size; idx++) {
      const orig = p.data[idx];
      p.data[idx] = orig + eps;
      const lp = scalarLoss(forward());
      p.data[idx] = orig - eps;
      const lm = scalarLoss(forward());
      p.data[idx] = orig;
      const numeric = (lp - lm) / (2 * eps);
      const a = analytic[pi][idx];
      const denom = Math.max(Math.abs(a) + Math.abs(numeric), 1e-8);
      const rel = Math.abs(a - numeric) / denom;
      maxRel = Math.max(maxRel, rel);
      sumRel += rel;
      count++;
    }
  }
  return { name, maxRelError: maxRel, meanRelError: count ? sumRel / count : 0, checked: count };
}

export function runSelfTest(seed = 7): SelfTestReport {
  const rng = rngFrom(seed);
  const ops: OpCheck[] = [];

  // Binary / broadcasting ops.
  {
    const a = leaf(rng, 4, 3);
    const b = leaf(rng, 3, 2);
    ops.push(checkOp('matmul', [a, b], () => a.matmul(b), rng));
  }
  {
    const x = leaf(rng, 4, 3);
    const b = leaf(rng, 1, 3);
    ops.push(checkOp('add (bias broadcast)', [x, b], () => x.add(b), rng));
  }
  {
    const x = leaf(rng, 4, 3);
    const y = leaf(rng, 4, 3);
    ops.push(checkOp('mul', [x, y], () => x.mul(y), rng));
  }
  {
    const x = leaf(rng, 4, 3);
    const y = leaf(rng, 1, 3);
    ops.push(checkOp('mul (broadcast)', [x, y], () => x.mul(y), rng));
  }
  {
    const x = leaf(rng, 4, 3);
    const y = leaf(rng, 4, 3);
    ops.push(checkOp('sub', [x, y], () => x.sub(y), rng));
  }
  {
    const x = leaf(rng, 4, 3);
    const y = leaf(rng, 4, 3, true);
    ops.push(checkOp('div', [x, y], () => x.div(y), rng));
  }

  // Unary ops.
  const unary: [string, (t: Tensor) => Tensor, boolean][] = [
    ['scale', (t) => t.scale(1.7), false],
    ['neg', (t) => t.neg(), false],
    ['exp', (t) => t.exp(), false],
    ['log', (t) => t.log(), true],
    ['pow(2.5)', (t) => t.pow(2.5), true],
    ['sumAll', (t) => t.sumAll(), false],
    ['meanAll', (t) => t.meanAll(), false],
    ['transpose', (t) => t.transpose(), false],
    ['softmax', (t) => t.softmax(), false],
    ['relu', (t) => t.relu(), false],
    ['tanh', (t) => t.tanh(), false],
    ['sigmoid', (t) => t.sigmoid(), false],
    ['leakyRelu', (t) => t.leakyRelu(), false],
    ['elu', (t) => t.elu(), false],
    ['gelu', (t) => t.gelu(), false],
    ['silu', (t) => t.silu(), false],
    ['softplus', (t) => t.softplus(), false],
  ];
  for (const [name, fn, positive] of unary) {
    const x = leaf(rng, 4, 3, positive);
    ops.push(checkOp(name, [x], () => fn(x), rng));
  }

  // Dropout — fixed seed so the mask is identical across forward calls.
  {
    const x = leaf(rng, 5, 4);
    ops.push(checkOp('dropout', [x], () => dropout(x, 0.5, true, rngFrom(99)), rng));
  }

  // Normalization layers (learnable gamma/beta also gradchecked).
  {
    const x = leaf(rng, 5, 4);
    const g = leaf(rng, 1, 4, true);
    const b = leaf(rng, 1, 4);
    ops.push(checkOp('layerNorm', [x, g, b], () => layerNorm(x, g, b), rng));
  }
  {
    const x = leaf(rng, 6, 4);
    const g = leaf(rng, 1, 4, true);
    const b = leaf(rng, 1, 4);
    ops.push(
      checkOp('batchNorm', [x, g, b], () => batchNorm(x, g, b, makeBatchNormState(4), true), rng),
    );
  }

  // Convolution + pooling (the vision ops). Input is gradchecked too (it is a non-trivial
  // im2col-free backward), alongside the kernel weights and bias.
  {
    const N = 2;
    const Cin = 2;
    const H = 4;
    const W = 4;
    const Cout = 3;
    const k = 3;
    const x = leaf(rng, N, Cin * H * W);
    const w = leaf(rng, Cout, Cin * k * k);
    const b = leaf(rng, 1, Cout);
    ops.push(
      checkOp(
        'conv2d',
        [x, w, b],
        () => conv2d(x, w, b, { N, Cin, H, W, Cout, kh: k, kw: k, stride: 1, pad: 1 }),
        rng,
      ),
    );
  }
  {
    const N = 2;
    const C = 2;
    const H = 4;
    const W = 4;
    // Nudge values apart so the max in each window is unambiguous (ties break finite diff).
    const x = leaf(rng, N, C * H * W);
    for (let i = 0; i < x.size; i++) x.data[i] += i * 1e-3;
    ops.push(checkOp('maxPool2d', [x], () => maxPool2d(x, { N, C, H, W, k: 2, stride: 2 }), rng));
  }
  {
    const N = 2;
    const C = 2;
    const H = 4;
    const W = 4;
    const x = leaf(rng, N, C * H * W);
    ops.push(checkOp('avgPool2d', [x], () => avgPool2d(x, { N, C, H, W, k: 2, stride: 2 }), rng));
  }

  // Transformer ops: the row-gather embedding and the multi-head concat.
  {
    const table = leaf(rng, 5, 4);
    const ids = Int32Array.from([0, 3, 1, 3, 4]); // a repeated id exercises gradient accumulation
    ops.push(checkOp('embedding', [table], () => embedding(table, ids), rng));
  }
  {
    const a = leaf(rng, 4, 2);
    const b = leaf(rng, 4, 3);
    const c = leaf(rng, 4, 2);
    ops.push(checkOp('concatCols', [a, b, c], () => concatCols([a, b, c]), rng));
  }
  {
    const logits = leaf(rng, 5, 4);
    const targets = Int32Array.from([1, 3, 0, 2, 1]);
    const keep = Uint8Array.from([0, 1, 1, 0, 1]); // only the masked rows count
    ops.push(checkOp('maskedCE', [logits], () => maskedCrossEntropy(logits, targets, keep).loss, rng));
  }

  // End-to-end: a whole tiny GPT — every parameter (embeddings, all heads' Q/K/V, the output
  // projection, both LayerNorms, the GELU feed-forward) gradchecked through the masked loss.
  {
    const gpt = new GPT({ vocab: 5, dModel: 4, nHeads: 2, nLayers: 1, dFF: 6, maxLen: 6, seed: 3 });
    const ids = Int32Array.from([2, 0, 4, 1, 3]);
    const targets = Int32Array.from([0, 4, 1, 3, 2]);
    const keep = Uint8Array.from([0, 0, 1, 1, 1]);
    ops.push(
      checkOp(
        'transformer (e2e)',
        gpt.parameters(),
        () => maskedCrossEntropy(gpt.forward(ids), targets, keep).loss,
        rng,
      ),
    );
  }

  const maxRelError = ops.reduce((m, o) => Math.max(m, o.maxRelError), 0);
  return { ops, maxRelError, passed: maxRelError < 1e-3 };
}
