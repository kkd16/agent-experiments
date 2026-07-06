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

// Per-layer, per-head key/value rows accumulated during an incremental decode. `K[l][h]` and
// `V[l][h]` are flat [maxLen, dHead] buffers; only the first `len` rows are populated.
export interface KVCache {
  K: Float64Array[][];
  V: Float64Array[][];
  len: number;
}

export interface DecodeOpts {
  temperature: number; // <= 0 ⇒ greedy argmax
  topK: number; // 0 ⇒ off
  topP: number; // 1 ⇒ off (nucleus)
}

export interface DecodeStep {
  tok: number;
  prob: number; // probability the sampler assigned the chosen token
  probs: Float64Array; // the (post-filter, renormalized) distribution it sampled from
}

export interface DecodeResult {
  tokens: Int32Array;
  steps: DecodeStep[];
}

// Cumulative information flow via attention rollout (Abnar & Zuidema, 2020): average the heads
// in each layer, mix in the residual connection as `Â = ½A + ½I`, then multiply the layers
// together. `final[q·T+k]` is how much of query position q's output is attributable to key
// position k once every layer's mixing has compounded. `perLayer[l]` is the running product up
// to and including layer l.
export interface RolloutResult {
  T: number;
  perLayer: Float64Array[];
  final: Float64Array;
}

// GELU (tanh approximation) — identical to Tensor.gelu, for the tape-free decode path.
const GELU_C0 = Math.sqrt(2 / Math.PI);
const GELU_K = 0.044715;
function gelu(x: number): number {
  return 0.5 * x * (1 + Math.tanh(GELU_C0 * (x + GELU_K * x * x * x)));
}

// Row LayerNorm matching ops.layerNorm exactly (population variance, eps 1e-5), writing into
// `out`. `x`, `g`, `b`, `out` are all length-C rows.
function layerNormRow(x: Float64Array, g: Float64Array, b: Float64Array, out: Float64Array, eps = 1e-5): void {
  const C = x.length;
  let mean = 0;
  for (let j = 0; j < C; j++) mean += x[j];
  mean /= C;
  let varr = 0;
  for (let j = 0; j < C; j++) {
    const d = x[j] - mean;
    varr += d * d;
  }
  varr /= C;
  const is = 1 / Math.sqrt(varr + eps);
  for (let j = 0; j < C; j++) out[j] = g[j] * ((x[j] - mean) * is) + b[j];
}

// out[0..C) = x[0..K) @ W[K,C], accumulation order matching Tensor.matmul (k outer). Writes at
// `outOff` so a result can land straight inside a larger buffer (e.g. a KV-cache row).
function matVec(x: Float64Array, W: Float64Array, K: number, C: number, out: Float64Array, outOff: number): void {
  for (let c = 0; c < C; c++) out[outOff + c] = 0;
  for (let k = 0; k < K; k++) {
    const xk = x[k];
    if (xk === 0) continue;
    const wb = k * C;
    for (let c = 0; c < C; c++) out[outOff + c] += xk * W[wb + c];
  }
}

// out[0..C) += x[0..K) @ W[K,C] (residual add of a projection).
function addMatVec(x: Float64Array, W: Float64Array, K: number, C: number, out: Float64Array): void {
  for (let k = 0; k < K; k++) {
    const xk = x[k];
    if (xk === 0) continue;
    const wb = k * C;
    for (let c = 0; c < C; c++) out[c] += xk * W[wb + c];
  }
}

// Draw one token from logits under temperature + top-k + top-p, and return the (filtered,
// renormalized) distribution it sampled from. Greedy argmax when temperature <= 0. Deterministic
// given `rng`.
export function sampleFromLogits(logits: Float64Array, opts: DecodeOpts, rng: () => number): { tok: number; probs: Float64Array } {
  const V = logits.length;
  if (opts.temperature <= 0) {
    // Greedy: a one-hot distribution on the argmax.
    let best = 0;
    for (let j = 1; j < V; j++) if (logits[j] > logits[best]) best = j;
    const probs = new Float64Array(V);
    probs[best] = 1;
    return { tok: best, probs };
  }
  const invT = 1 / opts.temperature;
  let mx = -Infinity;
  for (let j = 0; j < V; j++) {
    const z = logits[j] * invT;
    if (z > mx) mx = z;
  }
  const probs = new Float64Array(V);
  let sum = 0;
  for (let j = 0; j < V; j++) {
    const e = Math.exp(logits[j] * invT - mx);
    probs[j] = e;
    sum += e;
  }
  for (let j = 0; j < V; j++) probs[j] /= sum;

  // Rank once; both top-k and top-p operate on the descending order.
  const order = Array.from({ length: V }, (_, i) => i).sort((a, b) => probs[b] - probs[a]);
  const keep = new Uint8Array(V);
  const k = opts.topK > 0 ? Math.min(opts.topK, V) : V;
  let cum = 0;
  let kept = 0;
  for (let r = 0; r < V; r++) {
    const idx = order[r];
    if (r >= k) break; // beyond top-k
    keep[idx] = 1;
    kept++;
    cum += probs[idx];
    if (opts.topP < 1 && cum >= opts.topP) break; // nucleus reached
  }
  if (kept === 0) keep[order[0]] = 1; // degenerate guard

  // Renormalize over the kept set and sample.
  let z = 0;
  for (let j = 0; j < V; j++) {
    if (!keep[j]) probs[j] = 0;
    z += probs[j];
  }
  for (let j = 0; j < V; j++) probs[j] /= z;
  let r = rng();
  let tok = order[0];
  for (let j = 0; j < V; j++) {
    r -= probs[j];
    if (r <= 0) {
      tok = j;
      break;
    }
  }
  return { tok, probs };
}

// Attention rollout over a captured snapshot (see RolloutResult).
export function attentionRollout(snap: AttnSnapshot): RolloutResult {
  const T = snap.T;
  const nHeads = snap.nHeads;
  const matmul = (A: Float64Array, B: Float64Array): Float64Array => {
    const out = new Float64Array(T * T);
    for (let i = 0; i < T; i++) {
      for (let kk = 0; kk < T; kk++) {
        const a = A[i * T + kk];
        if (a === 0) continue;
        const bRow = kk * T;
        const oRow = i * T;
        for (let j = 0; j < T; j++) out[oRow + j] += a * B[bRow + j];
      }
    }
    return out;
  };
  const perLayer: Float64Array[] = [];
  let running: Float64Array | null = null;
  for (let l = 0; l < snap.maps.length; l++) {
    // Â = ½·(head-averaged A) + ½·I
    const hat = new Float64Array(T * T);
    for (let h = 0; h < nHeads; h++) {
      const m = snap.maps[l][h];
      for (let idx = 0; idx < T * T; idx++) hat[idx] += 0.5 * m[idx] / nHeads;
    }
    for (let i = 0; i < T; i++) hat[i * T + i] += 0.5;
    running = running ? matmul(hat, running) : hat;
    perLayer.push(running.slice());
  }
  return { T, perLayer, final: running ? running.slice() : new Float64Array(T * T) };
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
  // set, the per-head attention matrices are stashed on `lastAttn` for the visualizer. When a
  // set of `"layer:head"` keys is passed in `ablated`, those heads' outputs are forced to zero
  // (a clean lesion: the head still computes its attention for the map view, but contributes
  // nothing to the residual stream) so the interpretability view can measure each head's causal
  // importance. Ablation runs on the tape-backed path only — the fast KV-cache decode is a
  // separate route used for generation.
  forward(ids: Int32Array, capture = false, ablated?: ReadonlySet<string>): Tensor {
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
        const out = attn.matmul(v); // [T, dHead]
        heads.push(ablated?.has(`${l}:${head}`) ? out.scale(0) : out);
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

  // ---- KV-cache incremental decode --------------------------------------------------------
  //
  // The `generate` path above re-runs the full O(T²) forward for every new token — clear, but
  // wasteful, since a decoder-only Transformer never revises a token's representation once the
  // token is written (LayerNorm and the MLP are per-position; attention is causal, so position t
  // only ever reads keys/values at positions ≤ t). A KV-cache exploits exactly that: keep every
  // layer/head's key and value rows, and when a new token arrives compute *one* query row that
  // attends over the cached keys. Decoding a length-L sequence then costs O(L²) total instead of
  // O(L³), and — crucially — is *byte-for-byte identical* to the batched forward, because the
  // masked-out keys in the full pass contribute exp(−1e9)=0 to both the softmax denominator and
  // the value mixture. That identity is machine-checked in the self-test (`kv-cache (decode≡forward)`).
  //
  // This route is a hand-written numeric mirror of `forward` (no tape — inference needs no
  // gradients) that reproduces the tape ops arithmetic-for-arithmetic: the same LayerNorm
  // (population variance, eps 1e-5), the same tanh-GELU, the same max-stable softmax, and the
  // same matmul accumulation order.
  newCache(): KVCache {
    const { nLayers, nHeads, maxLen } = this.cfg;
    const dHead = this.dHead;
    const K: Float64Array[][] = [];
    const V: Float64Array[][] = [];
    for (let l = 0; l < nLayers; l++) {
      const kl: Float64Array[] = [];
      const vl: Float64Array[] = [];
      for (let h = 0; h < nHeads; h++) {
        kl.push(new Float64Array(maxLen * dHead));
        vl.push(new Float64Array(maxLen * dHead));
      }
      K.push(kl);
      V.push(vl);
    }
    return { K, V, len: 0 };
  }

  // Consume a single token at absolute position `pos`, updating `cache` in place, and return the
  // next-token logits [vocab]. `pos` must equal `cache.len` (tokens arrive in order).
  step(tokenId: number, pos: number, cache: KVCache): Float64Array {
    const { dModel, nHeads, vocab } = this.cfg;
    const dHead = this.dHead;
    const invSqrt = 1 / Math.sqrt(dHead);

    // token + position embedding (row copy + add)
    const h = new Float64Array(dModel);
    for (let d = 0; d < dModel; d++) {
      h[d] = this.tokEmb.data[tokenId * dModel + d] + this.posEmb.data[pos * dModel + d];
    }

    const a = new Float64Array(dModel);
    const merged = new Float64Array(dModel);
    const q = new Float64Array(dHead);
    for (let l = 0; l < this.blocks.length; l++) {
      const blk = this.blocks[l];
      // pre-LN attention
      layerNormRow(h, blk.ln1g.data, blk.ln1b.data, a);
      for (let head = 0; head < nHeads; head++) {
        const Khh = cache.K[l][head];
        const Vhh = cache.V[l][head];
        // q,k,v = a @ {Wq,Wk,Wv}[head]  (write k,v straight into the cache row at `pos`)
        matVec(a, blk.wq[head].data, dModel, dHead, q, 0);
        matVec(a, blk.wk[head].data, dModel, dHead, Khh, pos * dHead);
        matVec(a, blk.wv[head].data, dModel, dHead, Vhh, pos * dHead);
        // scores over keys 0..pos, then softmax
        const scores = new Float64Array(pos + 1);
        let mx = -Infinity;
        for (let j = 0; j <= pos; j++) {
          let s = 0;
          const kb = j * dHead;
          for (let d = 0; d < dHead; d++) s += q[d] * Khh[kb + d];
          s *= invSqrt;
          scores[j] = s;
          if (s > mx) mx = s;
        }
        let denom = 0;
        for (let j = 0; j <= pos; j++) {
          const e = Math.exp(scores[j] - mx);
          scores[j] = e;
          denom += e;
        }
        // headOut = softmax(scores) @ V, written into merged[head*dHead .. ]
        const mb = head * dHead;
        for (let d = 0; d < dHead; d++) merged[mb + d] = 0;
        for (let j = 0; j <= pos; j++) {
          const w = scores[j] / denom;
          const vb = j * dHead;
          for (let d = 0; d < dHead; d++) merged[mb + d] += w * Vhh[vb + d];
        }
      }
      // attnOut = merged @ Wo, add to residual
      addMatVec(merged, blk.wo.data, dModel, dModel, h);
      // pre-LN MLP: gelu(m @ W1 + b1) @ W2 + b2
      const { dFF } = this.cfg;
      layerNormRow(h, blk.ln2g.data, blk.ln2b.data, a);
      const ff1 = new Float64Array(dFF);
      matVec(a, blk.w1.data, dModel, dFF, ff1, 0);
      for (let f = 0; f < dFF; f++) ff1[f] = gelu(ff1[f] + blk.b1.data[f]);
      const ff2 = new Float64Array(dModel);
      matVec(ff1, blk.w2.data, dFF, dModel, ff2, 0);
      for (let d = 0; d < dModel; d++) h[d] += ff2[d] + blk.b2.data[d];
    }

    // final LN, then the weight-tied readout: logits[w] = <ln(h), tokEmb.row(w)>
    layerNormRow(h, this.lnfg.data, this.lnfb.data, a);
    const logits = new Float64Array(vocab);
    for (let w = 0; w < vocab; w++) {
      let s = 0;
      const tb = w * dModel;
      for (let d = 0; d < dModel; d++) s += a[d] * this.tokEmb.data[tb + d];
      logits[w] = s;
    }
    cache.len = pos + 1;
    return logits;
  }

  // Feed a whole sequence through the KV-cache and return the per-position next-token logits,
  // flattened [T, vocab] exactly like `forward`. Used by the self-test to prove the cache path
  // reproduces the batched forward.
  cachedLogits(ids: Int32Array): Float64Array {
    const { vocab } = this.cfg;
    const cache = this.newCache();
    const out = new Float64Array(ids.length * vocab);
    for (let t = 0; t < ids.length; t++) {
      const lg = this.step(ids[t], t, cache);
      out.set(lg, t * vocab);
    }
    return out;
  }

  // Autoregressive decode with a KV-cache and a real sampler. Feeds `prompt`, then appends
  // `count` tokens — greedy when `temperature <= 0`, otherwise temperature + top-k + top-p
  // (nucleus) sampling from a seeded RNG. Returns the full token stream plus, for every generated
  // step, the sampled token and the probability the model assigned it (for the confidence bars).
  decode(prompt: Int32Array, count: number, opts: DecodeOpts, rng: () => number): DecodeResult {
    const cache = this.newCache();
    const tokens: number[] = Array.from(prompt);
    let logits: Float64Array = new Float64Array(this.cfg.vocab);
    for (let t = 0; t < tokens.length; t++) logits = this.step(tokens[t], t, cache);
    const steps: DecodeStep[] = [];
    for (let i = 0; i < count; i++) {
      const { tok, probs } = sampleFromLogits(logits, opts, rng);
      steps.push({ tok, prob: probs[tok], probs });
      tokens.push(tok);
      logits = this.step(tok, tokens.length - 1, cache);
    }
    return { tokens: Int32Array.from(tokens), steps };
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
