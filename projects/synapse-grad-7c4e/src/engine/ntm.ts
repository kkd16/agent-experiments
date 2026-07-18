// A from-scratch Neural Turing Machine (Graves, Wayne & Danihelka, 2014) — a recurrent
// controller coupled to an external, addressable memory matrix through differentiable
// read/write heads. The whole apparatus is one big autograd graph on the same hand-rolled
// reverse-mode engine as the rest of Synapse: the controller is an LSTM (or a feed-forward
// net), and the head addressing — content lookup by cosine similarity, interpolation with the
// previous focus, a circular-convolution location shift, and sharpening — is assembled from
// three new hand-derived ops plus the primitive tensor ops. Because every step threads the
// memory tensor M_t and the head weightings w_t forward on the tape, `backward()` runs all the
// way back through *reading and writing to memory across time* — which is exactly what lets an
// NTM learn an algorithm (copy, associative recall) rather than just a function.
//
// The three ops added here (`cosineSim`, `circularShift`, `sharpen`) are gradchecked to ~1e-6
// against finite differences in `selftest.ts`, exactly like every other op in the engine; the
// read (`wᵀM`) and write (erase/add, `M ⊙ (1 − weᵀ) + waᵀ`) reduce to matmul / elementwise ops
// that are already proven, so no memory-access gradient is left unchecked.

import { Tensor } from './tensor';
import { mulberry32 } from './nn';

// ----------------------------------------------------------------------------------------
// The three hand-derived addressing ops. Each returns a Tensor carrying its own backward
// closure, so it slots straight into the tape.
// ----------------------------------------------------------------------------------------

// Content-based addressing similarity. `key` is a single [1,M] query, `mem` is the [N,M]
// memory; the output is [1,N] holding the cosine similarity between the key and every memory
// row: K(k, mᵢ) = (k · mᵢ) / (‖k‖ ‖mᵢ‖ + eps). The controller turns these into a content
// weighting via a softmax sharpened by a key strength β.
export function cosineSim(key: Tensor, mem: Tensor, eps = 1e-8): Tensor {
  if (key.rows !== 1 || key.cols !== mem.cols) {
    throw new Error(`cosineSim shape mismatch key[${key.rows},${key.cols}] mem[${mem.rows},${mem.cols}]`);
  }
  const N = mem.rows;
  const M = mem.cols;
  const k = key.data;
  const m = mem.data;
  const out = Tensor.zeros(1, N);
  const o = out.data;
  // Cache the per-row scalars the backward needs.
  const dot = new Float64Array(N);
  const nm = new Float64Array(N); // ‖mᵢ‖
  let sk = 0;
  for (let j = 0; j < M; j++) sk += k[j] * k[j];
  const nk = Math.sqrt(Math.max(sk, 1e-24)); // ‖k‖
  for (let i = 0; i < N; i++) {
    const base = i * M;
    let d = 0;
    let s = 0;
    for (let j = 0; j < M; j++) {
      d += k[j] * m[base + j];
      s += m[base + j] * m[base + j];
    }
    dot[i] = d;
    nm[i] = Math.sqrt(Math.max(s, 1e-24));
    o[i] = d / (nk * nm[i] + eps);
  }
  out.op = 'cosineSim';
  out.prev = [key, mem];
  out.backwardFn = () => {
    const g = out.grad;
    const gk = key.grad;
    const gm = mem.grad;
    for (let i = 0; i < N; i++) {
      const gi = g[i];
      if (gi === 0) continue;
      const denom = nk * nm[i] + eps;
      const inv = 1 / denom;
      const inv2 = inv * inv;
      const base = i * M;
      // dK/dk_j = m_ij/denom − dot·(nm_i·k_j/nk)/denom²
      // dK/dm_ij = k_j/denom − dot·(nk·m_ij/nm_i)/denom²
      const kFactor = (dot[i] * nm[i]) / nk; // multiplies k_j
      const mFactor = (dot[i] * nk) / nm[i]; // multiplies m_ij
      for (let j = 0; j < M; j++) {
        gk[j] += gi * (m[base + j] * inv - kFactor * k[j] * inv2);
        gm[base + j] += gi * (k[j] * inv - mFactor * m[base + j] * inv2);
      }
    }
  };
  return out;
}

// Circular-convolution location shift. `w` is a [1,N] weighting, `s` is a [1,S] shift
// distribution over the integer offsets in `offsets` (e.g. {−1,0,+1} for S=3). The output is
//   w̃_i = Σ_k s_k · w_{(i − offsets_k) mod N},
// i.e. each shift slides the whole focus by that many locations and s mixes them. This is the
// only NTM head mechanism that can move the focus to an *adjacent* address independent of
// content — the iterative traversal a copy needs.
export function circularShift(w: Tensor, s: Tensor, offsets: number[]): Tensor {
  if (w.rows !== 1 || s.rows !== 1 || s.cols !== offsets.length) {
    throw new Error(`circularShift shape mismatch w[${w.rows},${w.cols}] s[${s.rows},${s.cols}] offsets ${offsets.length}`);
  }
  const N = w.cols;
  const S = offsets.length;
  const wd = w.data;
  const sd = s.data;
  const out = Tensor.zeros(1, N);
  const o = out.data;
  const mod = (x: number) => ((x % N) + N) % N;
  for (let i = 0; i < N; i++) {
    let acc = 0;
    for (let k = 0; k < S; k++) acc += sd[k] * wd[mod(i - offsets[k])];
    o[i] = acc;
  }
  out.op = 'circularShift';
  out.prev = [w, s];
  out.backwardFn = () => {
    const g = out.grad;
    const gw = w.grad;
    const gs = s.grad;
    for (let k = 0; k < S; k++) {
      const off = offsets[k];
      let dsk = 0;
      for (let i = 0; i < N; i++) {
        const src = mod(i - off);
        dsk += g[i] * wd[src];
        // w_j feeds out_i where src == j, i.e. i == mod(j+off); accumulate onto gw[src].
        gw[src] += sd[k] * g[i];
      }
      gs[k] += dsk;
    }
  };
  return out;
}

// Sharpening. `w` is a [1,N] weighting, `gamma` a [1,1] scalar ≥ 1; the output is the
// power-normalised distribution w̃_i = w_iᵞ / Σ_l w_lᵞ. Larger γ concentrates the focus onto its
// peak (a soft arg-max), which is what turns a slightly blurred shifted weighting back into a
// crisp single-address pointer.
export function sharpen(w: Tensor, gamma: Tensor): Tensor {
  if (w.rows !== 1 || gamma.rows !== 1 || gamma.cols !== 1) {
    throw new Error(`sharpen shape mismatch w[${w.rows},${w.cols}] gamma[${gamma.rows},${gamma.cols}]`);
  }
  const N = w.cols;
  const floor = 1e-12;
  const wd = w.data;
  const g = gamma.data[0];
  const p = new Float64Array(N);
  const u = new Float64Array(N);
  let Z = 0;
  for (let i = 0; i < N; i++) {
    const ui = Math.max(wd[i], floor);
    u[i] = ui;
    p[i] = Math.pow(ui, g);
    Z += p[i];
  }
  const invZ = 1 / Math.max(Z, 1e-300);
  const out = Tensor.zeros(1, N);
  const o = out.data;
  for (let i = 0; i < N; i++) o[i] = p[i] * invZ;
  out.op = 'sharpen';
  out.prev = [w, gamma];
  out.backwardFn = () => {
    const go = out.grad;
    const gw = w.grad;
    const gg = gamma.grad;
    // gbar = Σ_i go_i · out_i ; dL/dp_j = (go_j − gbar)/Z.
    let gbar = 0;
    for (let i = 0; i < N; i++) gbar += go[i] * o[i];
    let dGamma = 0;
    for (let j = 0; j < N; j++) {
      const basej = (go[j] - gbar) * invZ; // dL/dp_j
      // dp_j/dw_j = γ·u_jᵞ⁻¹ = γ·p_j/u_j (0 when w_j clamped at the floor)
      if (wd[j] > floor) gw[j] += basej * g * (p[j] / u[j]);
      // dp_j/dγ = p_j·ln u_j
      dGamma += basej * p[j] * Math.log(u[j]);
    }
    gg[0] += dGamma;
  };
  return out;
}

// ----------------------------------------------------------------------------------------
// Small parameter helpers.
// ----------------------------------------------------------------------------------------

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

// One linear map y = x·W + b, with its own [inF,outF] weight and [1,outF] bias.
class Dense {
  W: Tensor;
  b: Tensor;
  constructor(inF: number, outF: number, std: number, rng: () => number, tag: string) {
    this.W = randTensor(inF, outF, std, rng, `${tag}.W`);
    this.b = Tensor.zeros(1, outF, true).named(`${tag}.b`);
  }
  forward(x: Tensor): Tensor {
    return x.matmul(this.W).add(this.b);
  }
  params(): Tensor[] {
    return [this.W, this.b];
  }
}

export type ControllerKind = 'lstm' | 'feedforward';

export interface NtmConfig {
  inputWidth: number; // width of one external input vector (data bits + flag channels)
  outputWidth: number; // width of one output vector (usually the data-bit width)
  memLocations: number; // N — number of memory rows
  memWidth: number; // M — width of a memory row
  controller: ControllerKind;
  controllerSize: number; // hidden units H
  readHeads: number; // R
  writeHeads: number; // W
  shiftRange: number; // allowed shift radius; offsets = {−r..+r}, so S = 2r+1
  seed: number;
}

// Per-timestep activations captured for the visualizers.
export interface NtmTrace {
  N: number;
  M: number;
  T: number;
  outputWidth: number;
  readHeads: number;
  writeHeads: number;
  // [head][t] -> length-N weighting over memory locations.
  readWeights: Float64Array[][];
  writeWeights: Float64Array[][];
  // The evolving memory as a per-step, per-location L2 magnitude [t] -> length-N.
  memoryNorm: Float64Array[];
  memoryFinal: Float64Array; // [N*M]
  outputs: Float64Array[]; // [t] -> length-outputWidth sigmoid probabilities
}

interface Head {
  read: boolean;
  key: Dense; // -> [1,M]
  beta: Dense; // -> [1,1] (softplus -> β ≥ 0)
  gate: Dense; // -> [1,1] (sigmoid -> g ∈ [0,1])
  shift: Dense; // -> [1,S] (softmax)
  gamma: Dense; // -> [1,1] (softplus + 1 -> γ ≥ 1)
  erase: Dense | null; // write only -> [1,M] (sigmoid)
  add: Dense | null; // write only -> [1,M] (tanh)
  wInit: Tensor; // [1,N] learned logits for the initial focus (softmax'd)
}

interface LstmGate {
  W: Tensor; // [inDim,H]
  U: Tensor; // [H,H]
  b: Tensor; // [1,H]
}

export class NTM {
  cfg: NtmConfig;
  offsets: number[];

  // Controller.
  private lstm: LstmGate[] | null = null; // i,f,o,g gates (lstm)
  private ff: Dense[] | null = null; // two-layer tanh MLP (feedforward)
  private ctrlInDim: number;

  // Heads and output.
  private heads: Head[];
  private rInit: Tensor[]; // [R] learned initial read vectors [1,M]
  private out: Dense; // ([1,H] ++ reads[1,R*M]) -> [1,outputWidth]

  lastTrace: NtmTrace | null = null;

  constructor(cfg: NtmConfig) {
    this.cfg = cfg;
    const rng = mulberry32(cfg.seed);
    const r = cfg.shiftRange;
    this.offsets = [];
    for (let o = -r; o <= r; o++) this.offsets.push(o);
    const S = this.offsets.length;
    const H = cfg.controllerSize;
    const M = cfg.memWidth;
    const N = cfg.memLocations;

    this.ctrlInDim = cfg.inputWidth + cfg.readHeads * M;

    if (cfg.controller === 'lstm') {
      const names = ['i', 'f', 'o', 'g'];
      this.lstm = [];
      for (let gi = 0; gi < 4; gi++) {
        const W = randTensor(this.ctrlInDim, H, 1 / Math.sqrt(this.ctrlInDim), rng, `ctrl.${names[gi]}.W`);
        const U = randTensor(H, H, 1 / Math.sqrt(H), rng, `ctrl.${names[gi]}.U`);
        const b = Tensor.zeros(1, H, true).named(`ctrl.${names[gi]}.b`);
        if (gi === 1) b.data.fill(1); // forget-gate bias +1: default to "remember"
        this.lstm.push({ W, U, b });
      }
    } else {
      this.ff = [
        new Dense(this.ctrlInDim, H, 1 / Math.sqrt(this.ctrlInDim), rng, 'ctrl.ff0'),
        new Dense(H, H, 1 / Math.sqrt(H), rng, 'ctrl.ff1'),
      ];
    }

    // Heads. Keys use a small std so the initial content weighting starts diffuse; the shift
    // Dense weights start near zero so the initial shift distribution is ~uniform.
    const makeHead = (read: boolean, idx: number): Head => {
      const tag = `${read ? 'r' : 'w'}head${idx}`;
      return {
        read,
        key: new Dense(H, M, 1 / Math.sqrt(H), rng, `${tag}.k`),
        beta: new Dense(H, 1, 1 / Math.sqrt(H), rng, `${tag}.beta`),
        gate: new Dense(H, 1, 1 / Math.sqrt(H), rng, `${tag}.g`),
        shift: new Dense(H, S, 0.1 / Math.sqrt(H), rng, `${tag}.s`),
        gamma: new Dense(H, 1, 1 / Math.sqrt(H), rng, `${tag}.gamma`),
        erase: read ? null : new Dense(H, M, 1 / Math.sqrt(H), rng, `${tag}.e`),
        add: read ? null : new Dense(H, M, 1 / Math.sqrt(H), rng, `${tag}.a`),
        wInit: randTensor(1, N, 0.1, rng, `${tag}.wInit`),
      };
    };
    this.heads = [];
    for (let i = 0; i < cfg.readHeads; i++) this.heads.push(makeHead(true, i));
    for (let i = 0; i < cfg.writeHeads; i++) this.heads.push(makeHead(false, i));

    this.rInit = [];
    for (let i = 0; i < cfg.readHeads; i++) this.rInit.push(randTensor(1, M, 0.1, rng, `rInit${i}`));

    this.out = new Dense(H + cfg.readHeads * M, cfg.outputWidth, 1 / Math.sqrt(H + cfg.readHeads * M), rng, 'out');
  }

  // One controller step. Returns the exposed hidden vector h_t [1,H] and the carried LSTM
  // states (null for a feed-forward controller).
  private controllerStep(
    x: Tensor,
    h: Tensor,
    c: Tensor | null,
  ): { h: Tensor; c: Tensor | null } {
    if (this.lstm) {
      const g = this.lstm;
      const i = x.matmul(g[0].W).add(h.matmul(g[0].U)).add(g[0].b).sigmoid();
      const f = x.matmul(g[1].W).add(h.matmul(g[1].U)).add(g[1].b).sigmoid();
      const o = x.matmul(g[2].W).add(h.matmul(g[2].U)).add(g[2].b).sigmoid();
      const gg = x.matmul(g[3].W).add(h.matmul(g[3].U)).add(g[3].b).tanh();
      const cNew = f.mul(c as Tensor).add(i.mul(gg));
      const hNew = o.mul(cNew.tanh());
      return { h: hNew, c: cNew };
    }
    const ff = this.ff!;
    const h1 = ff[0].forward(x).tanh();
    const h2 = ff[1].forward(h1).tanh();
    return { h: h2, c: null };
  }

  // Produce a head's new location weighting from the controller hidden state and the head's
  // previous weighting, addressing into `mem`. Returns the weighting [1,N] and the extra
  // write signals (erase/add [1,M]) for a write head.
  private address(
    head: Head,
    h: Tensor,
    wPrev: Tensor,
    mem: Tensor,
  ): { w: Tensor; erase: Tensor | null; add: Tensor | null } {
    const N = this.cfg.memLocations;
    const key = head.key.forward(h); // [1,M]
    const beta = head.beta.forward(h).softplus(); // [1,1] ≥ 0
    const gate = head.gate.forward(h).sigmoid(); // [1,1] ∈ [0,1]
    const shift = head.shift.forward(h).softmax(); // [1,S]
    const gamma = head.gamma.forward(h).softplus().add(ONE); // [1,1] ≥ 1

    // Content addressing: softmax(β · cosineSim(k, M)).
    const sims = cosineSim(key, mem); // [1,N]
    const wc = beta.tile(1, N).mul(sims).softmax(); // [1,N]
    // Interpolation with the previous focus: w_g = g·w_c + (1−g)·w_prev.
    const gTile = gate.tile(1, N);
    const wg = gTile.mul(wc).add(ONE_ROW_N(N).sub(gTile).mul(wPrev));
    // Location shift then sharpen.
    const wShift = circularShift(wg, shift, this.offsets);
    const w = sharpen(wShift, gamma);

    if (head.read) return { w, erase: null, add: null };
    const erase = head.erase!.forward(h).sigmoid(); // [1,M]
    const add = head.add!.forward(h).tanh(); // [1,M]
    return { w, erase, add };
  }

  // Run the whole sequence. `inputs` is the [T][inputWidth] external input stream; the model
  // emits one [1,outputWidth] logit row per step. Returns those rows stacked into [T,outputWidth]
  // logits (pre-sigmoid). When `capture` is set, per-step head weightings and the memory are
  // recorded on `lastTrace` for the visualizers.
  forward(inputs: Float64Array[], capture = false): { logits: Tensor[]; T: number } {
    const T = inputs.length;
    const N = this.cfg.memLocations;
    const M = this.cfg.memWidth;
    const R = this.cfg.readHeads;
    const H = this.cfg.controllerSize;

    // Fresh per-sequence state. Memory starts at a small constant; head weightings start from
    // the learned initial-focus logits; read vectors from the learned initial read.
    let mem = Tensor.fromFlat(new Float64Array(N * M).fill(1e-6), N, M, false);
    let h = Tensor.zeros(1, H, false);
    let c: Tensor | null = this.lstm ? Tensor.zeros(1, H, false) : null;
    const wPrev: Tensor[] = this.heads.map((head) => head.wInit.softmax());
    let reads: Tensor[] = this.rInit.map((t) => t); // [R] of [1,M]

    const trace: NtmTrace | null = capture
      ? {
          N,
          M,
          T,
          outputWidth: this.cfg.outputWidth,
          readHeads: R,
          writeHeads: this.cfg.writeHeads,
          readWeights: Array.from({ length: R }, () => []),
          writeWeights: Array.from({ length: this.cfg.writeHeads }, () => []),
          memoryNorm: [],
          memoryFinal: new Float64Array(N * M),
          outputs: [],
        }
      : null;

    const logits: Tensor[] = [];

    for (let t = 0; t < T; t++) {
      const x = Tensor.fromFlat(inputs[t].slice(), 1, this.cfg.inputWidth, false);
      // Controller sees the external input plus the previous read vectors.
      const ctrlIn = R > 0 ? concatRow([x, ...reads]) : x;
      const step = this.controllerStep(ctrlIn, h, c);
      h = step.h;
      c = step.c;

      const newW: Tensor[] = new Array(this.heads.length);
      const newReads: Tensor[] = [];
      let readHeadIdx = 0;
      let writeHeadIdx = 0;

      // Write heads act first (so the read heads see the freshly written memory).
      for (let hi = 0; hi < this.heads.length; hi++) {
        const head = this.heads[hi];
        if (head.read) continue;
        const a = this.address(head, h, wPrev[hi], mem);
        newW[hi] = a.w;
        // M ← M ⊙ (1 − w eᵀ) + w aᵀ, with w as a column [N,1].
        const wCol = a.w.transpose(); // [N,1]
        const eraseOuter = wCol.matmul(a.erase!); // [N,M]
        const addOuter = wCol.matmul(a.add!); // [N,M]
        mem = mem.mul(ONE_NM(N, M).sub(eraseOuter)).add(addOuter);
        if (trace) trace.writeWeights[writeHeadIdx].push(a.w.data.slice());
        writeHeadIdx++;
      }

      // Read heads.
      for (let hi = 0; hi < this.heads.length; hi++) {
        const head = this.heads[hi];
        if (!head.read) continue;
        const a = this.address(head, h, wPrev[hi], mem);
        newW[hi] = a.w;
        const rVec = a.w.matmul(mem); // [1,N]·[N,M] = [1,M]
        newReads.push(rVec);
        if (trace) trace.readWeights[readHeadIdx].push(a.w.data.slice());
        readHeadIdx++;
      }

      for (let hi = 0; hi < this.heads.length; hi++) wPrev[hi] = newW[hi];
      reads = newReads.length ? newReads : reads;

      // Output: y_t = Linear([h_t ; reads_t]).
      const outIn = R > 0 ? concatRow([h, ...reads]) : h;
      const y = this.out.forward(outIn); // [1,outputWidth] logits
      logits.push(y);

      if (trace) {
        const norms = new Float64Array(N);
        for (let i = 0; i < N; i++) {
          let s = 0;
          for (let j = 0; j < M; j++) s += mem.data[i * M + j] * mem.data[i * M + j];
          norms[i] = Math.sqrt(s);
        }
        trace.memoryNorm.push(norms);
        const probs = new Float64Array(this.cfg.outputWidth);
        for (let j = 0; j < this.cfg.outputWidth; j++) probs[j] = 1 / (1 + Math.exp(-y.data[j]));
        trace.outputs.push(probs);
      }
    }

    if (trace) {
      trace.memoryFinal.set(mem.data);
      this.lastTrace = trace;
    }
    return { logits, T };
  }

  parameters(): Tensor[] {
    const ps: Tensor[] = [];
    if (this.lstm) for (const g of this.lstm) ps.push(g.W, g.U, g.b);
    if (this.ff) for (const d of this.ff) ps.push(...d.params());
    for (const head of this.heads) {
      ps.push(...head.key.params(), ...head.beta.params(), ...head.gate.params(), ...head.shift.params(), ...head.gamma.params());
      if (head.erase) ps.push(...head.erase.params());
      if (head.add) ps.push(...head.add.params());
      ps.push(head.wInit);
    }
    for (const r of this.rInit) ps.push(r);
    ps.push(...this.out.params());
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

// ----------------------------------------------------------------------------------------
// Shared small constant tensors + a row-concatenation helper.
// ----------------------------------------------------------------------------------------

// A [1,1] constant 1 (non-trainable) used for γ = softplus(·) + 1.
const ONE = Tensor.fromFlat(new Float64Array([1]), 1, 1, false);

// A cached [1,N] all-ones row (for the 1 − g interpolation complement).
const ONE_ROW_CACHE = new Map<number, Tensor>();
function ONE_ROW_N(n: number): Tensor {
  let t = ONE_ROW_CACHE.get(n);
  if (!t) {
    t = Tensor.fromFlat(new Float64Array(n).fill(1), 1, n, false);
    ONE_ROW_CACHE.set(n, t);
  }
  return t;
}

// A cached [N,M] all-ones matrix (for the 1 − w eᵀ erase complement).
const ONE_NM_CACHE = new Map<string, Tensor>();
function ONE_NM(n: number, m: number): Tensor {
  const key = `${n}x${m}`;
  let t = ONE_NM_CACHE.get(key);
  if (!t) {
    t = Tensor.fromFlat(new Float64Array(n * m).fill(1), n, m, false);
    ONE_NM_CACHE.set(key, t);
  }
  return t;
}

// Concatenate several [1,·] row tensors along the column axis into one [1, Σcols] row, on the
// tape. This is the multi-input merge the controller input (x ++ reads) and the output input
// (h ++ reads) both need; it mirrors `concatCols` in ops.ts but for the single-row case and is
// self-contained so the NTM module has no extra coupling.
export function concatRow(parts: Tensor[]): Tensor {
  let total = 0;
  for (const p of parts) {
    if (p.rows !== 1) throw new Error('concatRow expects single-row tensors');
    total += p.cols;
  }
  const out = Tensor.zeros(1, total);
  let off = 0;
  for (const p of parts) {
    out.data.set(p.data, off);
    off += p.cols;
  }
  out.op = 'concatRow';
  out.prev = parts.slice();
  out.backwardFn = () => {
    const g = out.grad;
    let o = 0;
    for (const p of parts) {
      const gp = p.grad;
      for (let j = 0; j < p.cols; j++) gp[j] += g[o + j];
      o += p.cols;
    }
  };
  return out;
}
