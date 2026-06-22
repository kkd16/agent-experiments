// A from-scratch Graph Neural Network, built on the same reverse-mode tensor autograd as
// every other lab. No graph libraries — the message passing is a handful of dense matmuls
// against a precomputed propagation matrix, so the whole network differentiates through the
// engine's existing ops (matmul/add/transpose/softmax/leakyRelu) and every gradient is the
// hand-derived backward proven in `selftest.ts`.
//
// Three convolutions share one model:
//   • GCN   — Kipf & Welling's spectral rule  H' = Â·H·W,  Â = D̃^(-1/2)(A+I)D̃^(-1/2).
//   • SAGE  — GraphSAGE's mean aggregator       H' = H·W_self + mean_{j∈N(i)}(H_j)·W_neigh.
//   • GAT   — graph attention (Veličković)      H' = softmax_j(LeakyReLU(aᵀ[Wh_i‖Wh_j]))·Wh,
//             multi-head, with the attention restricted to real edges by an additive mask.
//
// The graphs are tiny (tens to a couple hundred nodes), so a dense N×N propagation matrix is
// cheap and keeps the algebra legible: one matmul *is* one round of message passing.

import { Tensor } from './tensor';
import { dropout } from './ops';
import { applyActivation, mulberry32, type Activation } from './nn';

export type ConvKind = 'gcn' | 'sage' | 'gat';

const NEG_BIG = -1e9;

// Standard-normal sample (Box–Muller) from a uniform rng — used for weight init.
function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function initWeight(inF: number, outF: number, heLike: boolean, rng: () => number, label: string): Tensor {
  const gain = heLike ? Math.sqrt(2 / inF) : Math.sqrt(1 / inF);
  const w = new Float64Array(inF * outF);
  for (let i = 0; i < w.length; i++) w[i] = randn(rng) * gain;
  return Tensor.fromFlat(w, inF, outF, true).named(label);
}

// ---- the precomputed propagation operators for one graph ----------------------------
//
// All three are dense [N,N] and depend only on the edge set, so they are frozen leaves
// (requiresGrad = false): gradients flow through the node features, never the graph.

export interface GraphAdj {
  n: number;
  gcn: Float64Array; // symmetric-normalized  Â = D̃^(-1/2)(A+I)D̃^(-1/2)
  mean: Float64Array; // row-normalized neighbor mean (no self term)
  gatMask: Float64Array; // 0 on edges (incl. self-loop), NEG_BIG elsewhere
  degree: Int32Array; // graph degree (excluding the self-loop)
}

// Build the three propagation matrices from an undirected edge list. When `useGraph` is false
// every off-diagonal is dropped, so each operator collapses to the identity (GCN/SAGE become a
// plain per-node MLP and GAT attends only to itself) — that's the "ignore the edges" baseline
// that shows how much signal the graph structure alone carries.
export function buildAdj(n: number, edges: ReadonlyArray<readonly [number, number]>, useGraph: boolean): GraphAdj {
  const gcn = new Float64Array(n * n);
  const mean = new Float64Array(n * n);
  const gatMask = new Float64Array(n * n).fill(NEG_BIG);
  const degree = new Int32Array(n);
  // Adjacency with self-loops folded in for the spectral normalization.
  const adjSelf = new Float64Array(n * n);
  for (let i = 0; i < n; i++) adjSelf[i * n + i] = 1;
  if (useGraph) {
    for (const [u, v] of edges) {
      if (u === v) continue;
      adjSelf[u * n + v] = 1;
      adjSelf[v * n + u] = 1;
      degree[u]++;
      degree[v]++;
    }
  }
  // GCN: symmetric normalization by the self-loop degree d̃ = 1 + deg.
  const dInv = new Float64Array(n);
  for (let i = 0; i < n; i++) dInv[i] = 1 / Math.sqrt(1 + degree[i]);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (adjSelf[i * n + j]) {
        gcn[i * n + j] = dInv[i] * dInv[j];
        gatMask[i * n + j] = 0; // attend over self-loop + neighbors
      }
    }
  }
  // SAGE mean: average over the *strict* neighborhood (no self term — that's a separate weight).
  for (let i = 0; i < n; i++) {
    const d = degree[i];
    if (d === 0) continue;
    const w = 1 / d;
    for (let j = 0; j < n; j++) {
      if (j !== i && adjSelf[i * n + j]) mean[i * n + j] = w;
    }
  }
  return { n, gcn, mean, gatMask, degree };
}

// ---- layers -------------------------------------------------------------------------

interface Layer {
  forward(h: Tensor, capture: LayerCapture | null): Tensor;
  parameters(): Tensor[];
  outDim: number;
}

interface LayerCapture {
  attention: Float64Array | null; // [N,N] head-averaged attention of a GAT layer
  attHeads: Float64Array[] | null; // per-head [N,N]
}

// One graph-convolution: H' = Â · (H · W) + b. The propagation matrix Â is whichever frozen
// operator the conv kind picked (GCN's symmetric normalization here).
class GCNLayer implements Layer {
  private Ahat: Tensor;
  weight: Tensor;
  bias: Tensor;
  outDim: number;
  constructor(Ahat: Tensor, inF: number, outF: number, heLike: boolean, rng: () => number) {
    this.Ahat = Ahat;
    this.weight = initWeight(inF, outF, heLike, rng, 'W');
    this.bias = Tensor.zeros(1, outF, true).named('b');
    this.outDim = outF;
  }
  forward(h: Tensor): Tensor {
    return this.Ahat.matmul(h.matmul(this.weight)).add(this.bias);
  }
  parameters(): Tensor[] {
    return [this.weight, this.bias];
  }
}

// GraphSAGE mean aggregator: H' = H·W_self + (mean_{j∈N(i)} H_j)·W_neigh + b. Self and
// neighborhood get independent projections, so a node keeps its own signal even when its
// neighbors disagree.
class SAGELayer implements Layer {
  private mean: Tensor;
  wSelf: Tensor;
  wNeigh: Tensor;
  bias: Tensor;
  outDim: number;
  constructor(mean: Tensor, inF: number, outF: number, heLike: boolean, rng: () => number) {
    this.mean = mean;
    this.wSelf = initWeight(inF, outF, heLike, rng, 'W_self');
    this.wNeigh = initWeight(inF, outF, heLike, rng, 'W_neigh');
    this.bias = Tensor.zeros(1, outF, true).named('b');
    this.outDim = outF;
  }
  forward(h: Tensor): Tensor {
    const self = h.matmul(this.wSelf);
    const neigh = this.mean.matmul(h).matmul(this.wNeigh);
    return self.add(neigh).add(this.bias);
  }
  parameters(): Tensor[] {
    return [this.wSelf, this.wNeigh, this.bias];
  }
}

// Multi-head graph attention. Each head learns its own projection W and a pair of attention
// vectors (a_self, a_neigh) so the per-edge score is aᵀ[Wh_i ‖ Wh_j] decomposed additively as
// (Wh_i·a_self) + (Wh_j·a_neigh). LeakyReLU, an additive −∞ mask on non-edges, and a row-wise
// softmax give the normalized attention α; the head output is α·Wh. Hidden layers concat the
// heads, the output layer averages them.
class GATLayer implements Layer {
  W: Tensor[] = [];
  aSelf: Tensor[] = [];
  aNeigh: Tensor[] = [];
  outDim: number;
  private maskT: Tensor;
  private heads: number;
  private concat: boolean;
  private onesRow: Tensor; // [1,N] for broadcasting the self-score across columns
  constructor(maskT: Tensor, inF: number, perHead: number, heads: number, concat: boolean, rng: () => number) {
    this.maskT = maskT;
    this.heads = heads;
    this.concat = concat;
    const n = maskT.rows;
    this.onesRow = Tensor.fromFlat(new Float64Array(n).fill(1), 1, n, false);
    for (let k = 0; k < heads; k++) {
      this.W.push(initWeight(inF, perHead, true, rng, `W^${k}`));
      this.aSelf.push(initWeight(perHead, 1, false, rng, `a_self^${k}`));
      this.aNeigh.push(initWeight(perHead, 1, false, rng, `a_neigh^${k}`));
    }
    this.outDim = concat ? perHead * heads : perHead;
  }
  forward(h: Tensor, capture: LayerCapture | null): Tensor {
    const heads: Tensor[] = [];
    const attHeads: Float64Array[] = [];
    for (let k = 0; k < this.heads; k++) {
      const Wh = h.matmul(this.W[k]); // [N, perHead]
      const s = Wh.matmul(this.aSelf[k]); // [N,1] self score
      const t = Wh.matmul(this.aNeigh[k]); // [N,1] neighbor score
      // score[i][j] = s[i] + t[j]: broadcast s across columns (sᵀ⊗1) then t across rows.
      const score = s.matmul(this.onesRow).add(t.transpose());
      const alpha = score.leakyRelu(0.2).add(this.maskT).softmax(); // [N,N]
      heads.push(alpha.matmul(Wh));
      if (capture) attHeads.push(alpha.data.slice());
    }
    if (capture) {
      capture.attHeads = attHeads;
      const n = this.maskT.rows;
      const avg = new Float64Array(n * n);
      for (const a of attHeads) for (let i = 0; i < a.length; i++) avg[i] += a[i] / attHeads.length;
      capture.attention = avg;
    }
    if (this.concat) return concatHeads(heads);
    // average the heads (output layer)
    let acc = heads[0];
    for (let k = 1; k < heads.length; k++) acc = acc.add(heads[k]);
    return acc.scale(1 / heads.length);
  }
  parameters(): Tensor[] {
    return [...this.W, ...this.aSelf, ...this.aNeigh];
  }
}

// Column concat of equal-row tensors with a hand-derived split backward (a local copy so the
// GAT layer stays self-contained; mirrors ops.concatCols).
function concatHeads(parts: Tensor[]): Tensor {
  const R = parts[0].rows;
  let total = 0;
  for (const p of parts) total += p.cols;
  const out = Tensor.zeros(R, total);
  const o = out.data;
  let off = 0;
  for (const p of parts) {
    const a = p.data;
    for (let i = 0; i < R; i++) {
      const dst = i * total + off;
      const src = i * p.cols;
      for (let j = 0; j < p.cols; j++) o[dst + j] = a[src + j];
    }
    off += p.cols;
  }
  out.op = 'concatHeads';
  out.prev = parts.slice();
  out.backwardFn = () => {
    const g = out.grad;
    let off2 = 0;
    for (const p of parts) {
      const gp = p.grad;
      for (let i = 0; i < R; i++) {
        const src = i * total + off2;
        const dst = i * p.cols;
        for (let j = 0; j < p.cols; j++) gp[dst + j] += g[src + j];
      }
      off2 += p.cols;
    }
  };
  return out;
}

// ---- the model ----------------------------------------------------------------------

export interface GNNSpec {
  inDim: number;
  hidden: number[];
  numClasses: number;
  conv: ConvKind;
  activation: Activation;
  dropout: number;
  heads: number; // GAT only
}

export interface InferResult {
  logits: Tensor;
  embeddings: Float64Array; // [N, lastHiddenDim] penultimate activations
  embDim: number;
  attention: Float64Array | null; // [N,N] from the first GAT layer
  attHeads: Float64Array[] | null;
  probs: Float64Array; // [N, numClasses] softmax
}

export class GNN {
  private layers: Layer[] = [];
  private acts: Activation[] = [];
  private dropoutP: number;
  private dropRng: () => number;
  training = false;
  readonly spec: GNNSpec;
  readonly n: number;
  private embDim: number;

  constructor(spec: GNNSpec, adj: GraphAdj, rng: () => number) {
    this.spec = spec;
    this.n = adj.n;
    this.dropoutP = spec.dropout;
    this.dropRng = mulberry32((Math.floor(rng() * 1e9) ^ 0x9e3779b9) >>> 0);
    const heLike = spec.activation === 'relu' || spec.activation === 'elu' || spec.activation === 'leaky_relu';

    // Frozen propagation operators shared by every layer of the chosen kind.
    const gcnT = Tensor.fromFlat(adj.gcn.slice(), adj.n, adj.n, false).named('Â');
    const meanT = Tensor.fromFlat(adj.mean.slice(), adj.n, adj.n, false).named('mean');
    const maskT = Tensor.fromFlat(adj.gatMask.slice(), adj.n, adj.n, false).named('mask');

    const dims = [...spec.hidden, spec.numClasses];
    let prev = spec.inDim;
    for (let l = 0; l < dims.length; l++) {
      const isLast = l === dims.length - 1;
      const out = dims[l];
      let layer: Layer;
      if (spec.conv === 'gcn') layer = new GCNLayer(gcnT, prev, out, heLike, rng);
      else if (spec.conv === 'sage') layer = new SAGELayer(meanT, prev, out, heLike, rng);
      else layer = new GATLayer(maskT, prev, out, isLast ? 1 : spec.heads, !isLast, rng);
      this.layers.push(layer);
      this.acts.push(isLast ? 'linear' : spec.activation);
      prev = layer.outDim;
    }
    // penultimate width = the input width of the final layer
    this.embDim = this.layers.length >= 2 ? this.layers[this.layers.length - 2].outDim : spec.inDim;
  }

  train(): void {
    this.training = true;
  }
  eval(): void {
    this.training = false;
  }

  private run(x: Tensor, capture: { emb: Float64Array | null; cap: LayerCapture | null }): Tensor {
    let h = x;
    const last = this.layers.length - 1;
    for (let l = 0; l < this.layers.length; l++) {
      // Feature dropout on the layer input during training (the standard GCN regularizer).
      if (this.training && this.dropoutP > 0) h = dropout(h, this.dropoutP, true, this.dropRng);
      // Capture attention only from the first layer (the headline edge visual).
      const cap = capture.cap && l === 0 ? capture.cap : null;
      let z = this.layers[l].forward(h, cap);
      if (l < last) z = applyActivation(z, this.acts[l]);
      if (l === last - 1 && capture.emb) capture.emb.set(z.data); // penultimate activations
      h = z;
    }
    return h;
  }

  // Training forward: returns raw logits [N, numClasses]; participates in the tape.
  forward(x: Tensor): Tensor {
    return this.run(x, { emb: null, cap: null });
  }

  // Evaluation forward: no dropout, plus the embeddings / attention / probabilities the
  // visualizations need, captured in one pass.
  infer(x: Tensor): InferResult {
    const wasTraining = this.training;
    this.training = false;
    const emb = new Float64Array(this.n * this.embDim);
    const cap: LayerCapture = { attention: null, attHeads: null };
    const logits = this.run(x, { emb, cap: this.spec.conv === 'gat' ? cap : null });
    this.training = wasTraining;
    const C = this.spec.numClasses;
    const probs = new Float64Array(this.n * C);
    for (let i = 0; i < this.n; i++) {
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
    }
    return { logits, embeddings: emb, embDim: this.embDim, attention: cap.attention, attHeads: cap.attHeads, probs };
  }

  parameters(): Tensor[] {
    const ps: Tensor[] = [];
    for (const l of this.layers) ps.push(...l.parameters());
    return ps;
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
