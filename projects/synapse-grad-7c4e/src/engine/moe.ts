// A from-scratch *sparse* Mixture-of-Experts decoder-only Transformer, built on the same
// hand-rolled reverse-mode autograd engine as the rest of Synapse. The multi-head causal
// self-attention is assembled exactly as in `transformer.ts` (per-head matmuls, a transpose,
// a scaled dot product, an additive causal mask, a row-wise softmax, a concat of the heads);
// the one structural change is the feed-forward block. Instead of one dense MLP applied to
// every token, each block holds `E` independent expert MLPs and a tiny linear *router*. The
// router scores the experts per token, the top `k` are selected, and only those experts'
// outputs are mixed in — so the model's capacity (all `E` experts) decouples from its per-token
// cost (`k` experts). A Switch-Transformer load-balancing auxiliary loss keeps the router from
// collapsing onto a favourite expert. Everything below is differentiable through the tape and
// proven by `selftest.ts`.

import { Tensor } from './tensor';
import { mulberry32 } from './nn';
import { embedding, concatCols, layerNorm } from './ops';

// ---- two small autograd ops the MoE combine needs ---------------------------------------

// Scale every row of `x` [R,C] by a per-row scalar `w` [R,1]:  out[i,j] = x[i,j] * w[i].
// This is the differentiable "combine" that weights an expert's whole output vector by that
// token's router weight. Backward: dx[i,j] = g[i,j]·w[i];  dw[i] = Σ_j g[i,j]·x[i,j].
export function scaleRows(x: Tensor, w: Tensor): Tensor {
  if (w.rows !== x.rows || w.cols !== 1) {
    throw new Error(`scaleRows expects w [${x.rows},1] but got [${w.rows},${w.cols}]`);
  }
  const R = x.rows;
  const C = x.cols;
  const out = Tensor.zeros(R, C);
  const a = x.data;
  const wv = w.data;
  const o = out.data;
  for (let i = 0; i < R; i++) {
    const wi = wv[i];
    const base = i * C;
    for (let j = 0; j < C; j++) o[base + j] = a[base + j] * wi;
  }
  out.op = 'scaleRows';
  out.prev = [x, w];
  out.backwardFn = () => {
    const g = out.grad;
    const gx = x.grad;
    const gw = w.grad;
    for (let i = 0; i < R; i++) {
      const base = i * C;
      const wi = wv[i];
      let dw = 0;
      for (let j = 0; j < C; j++) {
        const gij = g[base + j];
        gx[base + j] += gij * wi;
        dw += gij * a[base + j];
      }
      gw[i] += dw;
    }
  };
  return out;
}

// Pull a single column `e` out of `x` [R,C] as an [R,1] gate column. Backward scatters each
// output gradient straight back to column `e` (every other column gets nothing).
export function selectCol(x: Tensor, e: number): Tensor {
  const R = x.rows;
  const C = x.cols;
  if (e < 0 || e >= C) throw new Error(`selectCol index ${e} out of range [0,${C})`);
  const out = Tensor.zeros(R, 1);
  const a = x.data;
  const o = out.data;
  for (let i = 0; i < R; i++) o[i] = a[i * C + e];
  out.op = 'selectCol';
  out.prev = [x];
  out.backwardFn = () => {
    const g = out.grad;
    const gx = x.grad;
    for (let i = 0; i < R; i++) gx[i * C + e] += g[i];
  };
  return out;
}

// ---- config + snapshots ------------------------------------------------------------------

export interface MoEConfig {
  vocab: number;
  dModel: number;
  nHeads: number;
  nLayers: number;
  dFF: number; // hidden width of *each* expert
  nExperts: number; // E
  topK: number; // k (1 <= k <= E)
  maxLen: number;
  seed: number;
  loadCoef?: number; // weight on the load-balancing aux loss (default 0.01)
  zCoef?: number; // weight on the router z-loss (default 1e-3)
}

// Per-layer routing captured from the most recent forward pass — what the visualiser renders.
export interface RoutingSnapshot {
  T: number;
  nLayers: number;
  nExperts: number;
  topK: number;
  // combine[layer] is length T*E (row = token position, col = expert) of the renormalised
  // top-k router weights (0 for experts a token did not pick).
  combine: Float64Array[];
  // topIdx[layer] is length T*k — the expert ids each token routed to, best first.
  topIdx: Int32Array[];
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

interface Expert {
  w1: Tensor; // [dModel, dFF]
  b1: Tensor; // [1, dFF]
  w2: Tensor; // [dFF, dModel]
  b2: Tensor; // [1, dModel]
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
  wg: Tensor; // router [dModel, nExperts]
  experts: Expert[];
}

// Result of one MoE feed-forward layer: the combined output, the differentiable aux-loss
// contributions, and the routing data for the snapshot.
interface MoELayerOut {
  out: Tensor; // [T, dModel]
  load: Tensor; // scalar [1,1] — E·Σ_i f_i·P_i for this layer
  z: Tensor; // scalar [1,1] — mean_t (logsumexp_e G)^2
  combine: Float64Array; // T*E renormalised top-k weights (snapshot)
  topIdx: Int32Array; // T*k chosen expert ids (snapshot)
}

export class MoEGPT {
  cfg: MoEConfig;
  dHead: number;
  loadCoef: number;
  zCoef: number;
  tokEmb: Tensor; // [vocab, dModel] — tied with the output projection
  posEmb: Tensor; // [maxLen, dModel]
  lnfg: Tensor;
  lnfb: Tensor;
  blocks: Block[];
  lastRouting: RoutingSnapshot | null = null;
  lastAux: Tensor | null = null; // scalar: Σ_layers (loadCoef·load + zCoef·z), built on the tape
  lastLoadValue = 0; // diagnostic (numbers, no grad)
  lastZValue = 0;
  private maskCache = new Map<number, Tensor>();

  constructor(cfg: MoEConfig) {
    if (cfg.dModel % cfg.nHeads !== 0) {
      throw new Error(`dModel ${cfg.dModel} not divisible by nHeads ${cfg.nHeads}`);
    }
    if (cfg.topK < 1 || cfg.topK > cfg.nExperts) {
      throw new Error(`topK ${cfg.topK} out of range [1, ${cfg.nExperts}]`);
    }
    this.cfg = cfg;
    this.loadCoef = cfg.loadCoef ?? 0.01;
    this.zCoef = cfg.zCoef ?? 1e-3;
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
      const experts: Expert[] = [];
      for (let e = 0; e < cfg.nExperts; e++) {
        experts.push({
          w1: randTensor(cfg.dModel, cfg.dFF, Math.sqrt(2 / cfg.dModel), rng, `L${l}.E${e}.W1`),
          b1: Tensor.zeros(1, cfg.dFF, true).named(`L${l}.E${e}.b1`),
          w2: randTensor(cfg.dFF, cfg.dModel, 1 / Math.sqrt(cfg.dFF), rng, `L${l}.E${e}.W2`),
          b2: Tensor.zeros(1, cfg.dModel, true).named(`L${l}.E${e}.b2`),
        });
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
        // Small router init so the initial routing is near-uniform (no expert pre-favoured).
        wg: randTensor(cfg.dModel, cfg.nExperts, projStd * 0.5, rng, `L${l}.Wg`),
        experts,
      });
    }
  }

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

  // One sparse MoE feed-forward layer over the normalised token states `m` [T, dModel].
  private moeLayer(blk: Block, m: Tensor): MoELayerOut {
    const T = m.rows;
    const E = this.cfg.nExperts;
    const k = this.cfg.topK;

    // Router logits and the full (dense) softmax used for the load-balancing importance term.
    const gLogits = m.matmul(blk.wg); // [T, E]
    const pFull = gLogits.softmax(); // [T, E] — differentiable

    // Top-k selection per token (read off the data, no grad) -> an additive mask. Selecting
    // the top-k logits then re-softmaxing over just those is the same as softmax(G + mask)
    // with mask = 0 on the chosen experts and -1e9 elsewhere — fully differentiable in G.
    const gl = gLogits.data;
    const maskData = new Float64Array(T * E);
    maskData.fill(-1e9);
    const topIdx = new Int32Array(T * k);
    const loadCount = new Float64Array(E); // how many (token, slot) dispatches each expert got
    for (let t = 0; t < T; t++) {
      const base = t * E;
      // partial selection sort for the top-k indices of row t
      const order: number[] = [];
      for (let e = 0; e < E; e++) order.push(e);
      order.sort((x, y) => gl[base + y] - gl[base + x]);
      for (let s = 0; s < k; s++) {
        const e = order[s];
        maskData[base + e] = 0;
        topIdx[t * k + s] = e;
        loadCount[e] += 1;
      }
    }
    const topMask = Tensor.fromFlat(maskData, T, E, false);
    const combine = gLogits.add(topMask).softmax(); // [T, E] — renormalised over the top-k

    // Mix the experts: out[t] = Σ_e combine[t,e] · expert_e(m)[t].
    let mixed: Tensor | null = null;
    for (let e = 0; e < E; e++) {
      const ex = blk.experts[e];
      const y = m.matmul(ex.w1).add(ex.b1).gelu().matmul(ex.w2).add(ex.b2); // [T, dModel]
      const w = selectCol(combine, e); // [T, 1]
      const term = scaleRows(y, w); // [T, dModel]
      mixed = mixed ? mixed.add(term) : term;
    }
    const out = mixed!;

    // Switch-Transformer load-balancing aux: E · Σ_i f_i · P_i.
    //   f_i = fraction of dispatches that went to expert i  (constant, detached)
    //   P_i = mean over tokens of the router softmax prob   (differentiable)
    const fData = new Float64Array(E);
    const denom = T * k;
    for (let e = 0; e < E; e++) fData[e] = loadCount[e] / denom;
    const fVec = Tensor.fromFlat(fData, 1, E, false);
    const onesRow = Tensor.fromFlat(new Float64Array(T).fill(1), 1, T, false);
    const pMean = onesRow.matmul(pFull).scale(1 / T); // [1, E] — column means of pFull
    const load = fVec.mul(pMean).sumAll().scale(E); // scalar

    // Router z-loss: mean_t (logsumexp_e G[t,:])^2, keeping the logits from drifting large.
    const lse = gLogits.exp().rowSum().log(); // [T, 1]
    const z = lse.mul(lse).meanAll(); // scalar

    return { out, load, z, combine: combine.data.slice(), topIdx };
  }

  // Forward pass over a single token sequence. Returns logits [T, vocab]. Always records the
  // routing snapshot and the differentiable aux loss (`lastAux`) for the trainer to fold in.
  forward(ids: Int32Array): Tensor {
    const T = ids.length;
    const { nHeads, nLayers, nExperts, topK } = this.cfg;
    const invSqrt = 1 / Math.sqrt(this.dHead);
    const mask = this.causalMask(T);
    const posIds = new Int32Array(T);
    for (let i = 0; i < T; i++) posIds[i] = i;

    let h = embedding(this.tokEmb, ids).add(embedding(this.posEmb, posIds)); // [T, dModel]

    const snap: RoutingSnapshot = { T, nLayers, nExperts, topK, combine: [], topIdx: [] };
    let aux: Tensor | null = null;
    let loadSum = 0;
    let zSum = 0;

    for (let l = 0; l < this.blocks.length; l++) {
      const blk = this.blocks[l];
      // --- multi-head causal self-attention (pre-LN) ---
      const a = layerNorm(h, blk.ln1g, blk.ln1b);
      const heads: Tensor[] = [];
      for (let head = 0; head < nHeads; head++) {
        const q = a.matmul(blk.wq[head]); // [T, dHead]
        const kk = a.matmul(blk.wk[head]);
        const v = a.matmul(blk.wv[head]);
        const scores = q.matmul(kk.transpose()).scale(invSqrt).add(mask); // [T,T]
        const attn = scores.softmax();
        heads.push(attn.matmul(v)); // [T, dHead]
      }
      const merged = nHeads === 1 ? heads[0] : concatCols(heads);
      h = h.add(merged.matmul(blk.wo));
      // --- sparse Mixture-of-Experts feed-forward (pre-LN) ---
      const m = layerNorm(h, blk.ln2g, blk.ln2b);
      const layer = this.moeLayer(blk, m);
      h = h.add(layer.out);
      snap.combine.push(layer.combine);
      snap.topIdx.push(layer.topIdx);
      const contrib = layer.load.scale(this.loadCoef).add(layer.z.scale(this.zCoef));
      aux = aux ? aux.add(contrib) : contrib;
      loadSum += layer.load.data[0];
      zSum += layer.z.data[0];
    }

    h = layerNorm(h, this.lnfg, this.lnfb);
    const logits = h.matmul(this.tokEmb.transpose()); // weight-tied head -> [T, vocab]
    this.lastRouting = snap;
    this.lastAux = aux;
    this.lastLoadValue = loadSum / Math.max(nLayers, 1);
    this.lastZValue = zSum / Math.max(nLayers, 1);
    return logits;
  }

  // Greedy autoregressive decode, re-running the forward each step (no KV cache).
  generate(prompt: Int32Array, count: number): Int32Array {
    const out: number[] = Array.from(prompt);
    for (let i = 0; i < count; i++) {
      const ids = Int32Array.from(out);
      const logits = this.forward(ids);
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
      ps.push(b.ln1g, b.ln1b, ...b.wq, ...b.wk, ...b.wv, b.wo, b.ln2g, b.ln2b, b.wg);
      for (const e of b.experts) ps.push(e.w1, e.b1, e.w2, e.b2);
    }
    return ps;
  }

  paramCount(): number {
    let n = 0;
    for (const p of this.parameters()) n += p.size;
    return n;
  }

  // Parameters that actually fire for a single token: everything except the experts, plus the
  // router, plus exactly `k` of the `E` experts. This is the "cost" the sparsity buys down.
  activeParamCount(): number {
    const { dModel, dFF, nExperts, topK } = this.cfg;
    const perExpert = dModel * dFF + dFF + dFF * dModel + dModel; // W1,b1,W2,b2
    const allExperts = perExpert * nExperts * this.cfg.nLayers;
    return this.paramCount() - allExperts + perExpert * topK * this.cfg.nLayers;
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
