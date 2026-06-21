// A from-scratch decoder-only Transformer (a tiny GPT), built on the same hand-rolled
// reverse-mode autograd engine as the rest of Synapse — no attention library, no fused
// kernels. Multi-head causal self-attention is assembled out of the primitive ops you can
// read in `tensor.ts` / `ops.ts`: per-head matmuls, a transpose, a scaled dot product, an
// additive causal mask, a row-wise softmax, and a concat of the heads. Pre-LayerNorm blocks
// with a GELU feed-forward, residual connections, and weight-tied token embeddings round it
// out. Everything below is differentiable through the tape, so the whole network trains with
// the existing optimizers and is provable with the existing gradient checker.

import { Tensor } from './tensor';
import { mulberry32 } from './nn';
import { embedding, concatCols, layerNorm } from './ops';

export interface GPTConfig {
  vocab: number;
  dModel: number;
  nHeads: number;
  nLayers: number;
  dFF: number;
  maxLen: number;
  seed: number;
}

// Per-head, per-layer attention probabilities captured from the most recent forward pass —
// the [T,T] matrices the attention-map view renders.
export interface AttnSnapshot {
  T: number;
  nLayers: number;
  nHeads: number;
  maps: Float64Array[][]; // maps[layer][head] is length T*T (row = query, col = key)
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

interface Block {
  ln1g: Tensor;
  ln1b: Tensor;
  wq: Tensor[]; // per head [dModel, dHead]
  wk: Tensor[];
  wv: Tensor[];
  wo: Tensor; // [dModel, dModel]
  ln2g: Tensor;
  ln2b: Tensor;
  w1: Tensor; // [dModel, dFF]
  b1: Tensor; // [1, dFF]
  w2: Tensor; // [dFF, dModel]
  b2: Tensor; // [1, dModel]
}

export class GPT {
  cfg: GPTConfig;
  dHead: number;
  tokEmb: Tensor; // [vocab, dModel] — tied with the output projection
  posEmb: Tensor; // [maxLen, dModel]
  lnfg: Tensor;
  lnfb: Tensor;
  blocks: Block[];
  lastAttn: AttnSnapshot | null = null;
  private maskCache = new Map<number, Tensor>();

  constructor(cfg: GPTConfig) {
    if (cfg.dModel % cfg.nHeads !== 0) {
      throw new Error(`dModel ${cfg.dModel} not divisible by nHeads ${cfg.nHeads}`);
    }
    this.cfg = cfg;
    this.dHead = cfg.dModel / cfg.nHeads;
    const rng = mulberry32(cfg.seed);
    const projStd = 1 / Math.sqrt(cfg.dModel);
    this.tokEmb = randTensor(cfg.vocab, cfg.dModel, 0.04, rng, 'tokEmb');
    this.posEmb = randTensor(cfg.maxLen, cfg.dModel, 0.04, rng, 'posEmb');
    this.lnfg = Tensor.fromFlat(new Float64Array(cfg.dModel).fill(1), 1, cfg.dModel, true).named('lnf.γ');
    this.lnfb = Tensor.zeros(1, cfg.dModel, true).named('lnf.β');
    this.blocks = [];
    for (let l = 0; l < cfg.nLayers; l++) {
      const wq: Tensor[] = [];
      const wk: Tensor[] = [];
      const wv: Tensor[] = [];
      for (let h = 0; h < cfg.nHeads; h++) {
        wq.push(randTensor(cfg.dModel, this.dHead, projStd, rng, `L${l}.Wq${h}`));
        wk.push(randTensor(cfg.dModel, this.dHead, projStd, rng, `L${l}.Wk${h}`));
        wv.push(randTensor(cfg.dModel, this.dHead, projStd, rng, `L${l}.Wv${h}`));
      }
      this.blocks.push({
        ln1g: Tensor.fromFlat(new Float64Array(cfg.dModel).fill(1), 1, cfg.dModel, true).named(`L${l}.ln1.γ`),
        ln1b: Tensor.zeros(1, cfg.dModel, true).named(`L${l}.ln1.β`),
        wq,
        wk,
        wv,
        wo: randTensor(cfg.dModel, cfg.dModel, projStd, rng, `L${l}.Wo`),
        ln2g: Tensor.fromFlat(new Float64Array(cfg.dModel).fill(1), 1, cfg.dModel, true).named(`L${l}.ln2.γ`),
        ln2b: Tensor.zeros(1, cfg.dModel, true).named(`L${l}.ln2.β`),
        w1: randTensor(cfg.dModel, cfg.dFF, Math.sqrt(2 / cfg.dModel), rng, `L${l}.W1`),
        b1: Tensor.zeros(1, cfg.dFF, true).named(`L${l}.b1`),
        w2: randTensor(cfg.dFF, cfg.dModel, 1 / Math.sqrt(cfg.dFF), rng, `L${l}.W2`),
        b2: Tensor.zeros(1, cfg.dModel, true).named(`L${l}.b2`),
      });
    }
  }

  // Lower-triangular additive mask [T,T]: 0 where a query may attend (key <= query), a large
  // negative constant above the diagonal so softmax drives those weights to zero.
  private causalMask(T: number): Tensor {
    const cached = this.maskCache.get(T);
    if (cached) return cached;
    const d = new Float64Array(T * T);
    for (let i = 0; i < T; i++) {
      for (let j = 0; j < T; j++) d[i * T + j] = j <= i ? 0 : -1e9;
    }
    const t = Tensor.fromFlat(d, T, T, false);
    this.maskCache.set(T, t);
    return t;
  }

  // Forward pass over a single token sequence. Returns logits [T, vocab]. When `capture` is
  // set, the per-head attention matrices are stashed on `lastAttn` for the visualizer.
  forward(ids: Int32Array, capture = false): Tensor {
    const T = ids.length;
    const { dModel, nHeads } = this.cfg;
    const invSqrt = 1 / Math.sqrt(this.dHead);
    const mask = this.causalMask(T);
    const posIds = new Int32Array(T);
    for (let i = 0; i < T; i++) posIds[i] = i;

    let h = embedding(this.tokEmb, ids).add(embedding(this.posEmb, posIds)); // [T, dModel]

    const snapshot: AttnSnapshot | null = capture
      ? { T, nLayers: this.cfg.nLayers, nHeads, maps: [] }
      : null;

    for (let l = 0; l < this.blocks.length; l++) {
      const blk = this.blocks[l];
      // --- multi-head causal self-attention (pre-LN) ---
      const a = layerNorm(h, blk.ln1g, blk.ln1b);
      const heads: Tensor[] = [];
      const layerMaps: Float64Array[] = [];
      for (let head = 0; head < nHeads; head++) {
        const q = a.matmul(blk.wq[head]); // [T, dHead]
        const k = a.matmul(blk.wk[head]);
        const v = a.matmul(blk.wv[head]);
        const scores = q.matmul(k.transpose()).scale(invSqrt).add(mask); // [T,T]
        const attn = scores.softmax();
        if (snapshot) layerMaps.push(attn.data.slice());
        heads.push(attn.matmul(v)); // [T, dHead]
      }
      if (snapshot) snapshot.maps.push(layerMaps);
      const merged = nHeads === 1 ? heads[0] : concatCols(heads); // [T, dModel]
      const attnOut = merged.matmul(blk.wo);
      h = h.add(attnOut);
      // --- position-wise feed-forward (pre-LN) ---
      const m = layerNorm(h, blk.ln2g, blk.ln2b);
      const ff = m.matmul(blk.w1).add(blk.b1).gelu().matmul(blk.w2).add(blk.b2);
      h = h.add(ff);
    }

    h = layerNorm(h, this.lnfg, this.lnfb);
    const logits = h.matmul(this.tokEmb.transpose()); // weight-tied head -> [T, vocab]
    if (snapshot) this.lastAttn = snapshot;
    void dModel;
    return logits;
  }

  // Greedy autoregressive decode. Feeds `prompt`, then appends `count` argmax tokens, one at a
  // time, re-running the forward each step (no KV cache — clarity over speed at this scale).
  // Captures attention on the final step so the visualizer reflects the finished sequence.
  generate(prompt: Int32Array, count: number): Int32Array {
    const out: number[] = Array.from(prompt);
    for (let i = 0; i < count; i++) {
      const ids = Int32Array.from(out);
      const logits = this.forward(ids, i === count - 1);
      const T = ids.length;
      const base = (T - 1) * this.cfg.vocab;
      let best = 0;
      let bv = -Infinity;
      for (let j = 0; j < this.cfg.vocab; j++) {
        const val = logits.data[base + j];
        if (val > bv) {
          bv = val;
          best = j;
        }
      }
      out.push(best);
    }
    return Int32Array.from(out);
  }

  parameters(): Tensor[] {
    const ps: Tensor[] = [this.tokEmb, this.posEmb, this.lnfg, this.lnfb];
    for (const b of this.blocks) {
      ps.push(b.ln1g, b.ln1b, ...b.wq, ...b.wk, ...b.wv, b.wo, b.ln2g, b.ln2b, b.w1, b.b1, b.w2, b.b2);
    }
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
