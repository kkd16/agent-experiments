// A from-scratch **Selective State-Space Model (Mamba / S6)** — the linear-time sequence
// architecture that is the modern rival to the Transformer (Gu & Dao, 2023). Built on the same
// hand-rolled reverse-mode autograd engine as the rest of Synapse: no SSM library, no associative
// "parallel scan" kernel, no fused CUDA. The heart is one hand-derived autograd op — the
// **selective scan** — that runs the input-dependent linear recurrence
//
//     h_l = Ā_l ⊙ h_{l-1} + B̄_l · x_l ,   y_l = ⟨C_l, h_l⟩ + D ⊙ x_l
//
// faithfully to the Mamba reference (`deltaA = exp(Δ·A)`, `deltaB·u = Δ·B·u`), with its full
// vector-Jacobian-product derived by hand and proven against finite differences in `selftest.ts`.
// Two more hand-derived ops complete the block: a causal **depthwise 1-D convolution** over the
// sequence and **RMSNorm**. Selectivity — the thing that makes S6 beat a linear-time-invariant
// SSM (S4) — is that Δ, B and C are *functions of the input* (`x_proj`/`dt_proj`), so the model
// chooses, per token and per channel, how much to remember vs. forget. Unlike the Transformer
// there is **no positional encoding**: order is carried by the recurrence and the causal conv.
//
// Everything below is differentiable through the tape and trains with the existing optimizers.

import { Tensor } from './tensor';
import { mulberry32 } from './nn';
import { embedding } from './ops';

// ---- three hand-derived autograd ops ----------------------------------------------------

// RMSNorm over the feature (column) axis with a learnable per-feature scale `gamma` [1,C].
//   ms_i = mean_j x_ij² ,  inv_i = (ms_i + eps)^(-1/2) ,  y_ij = gamma_j · x_ij · inv_i
// (no mean-subtraction, no bias — the normalization Mamba/LLaMA use). Backward is hand-derived:
//   dgamma_j = Σ_i g_ij · x_ij · inv_i
//   dx_ik    = inv_i·(g_ik·gamma_k) − (inv_i³/C)·x_ik·Σ_j g_ij·gamma_j·x_ij
export function rmsNorm(x: Tensor, gamma: Tensor, eps = 1e-5): Tensor {
  if (gamma.rows !== 1 || gamma.cols !== x.cols) {
    throw new Error(`rmsNorm gamma must be [1,${x.cols}] but got [${gamma.rows},${gamma.cols}]`);
  }
  const R = x.rows;
  const C = x.cols;
  const out = Tensor.zeros(R, C);
  const o = out.data;
  const a = x.data;
  const g = gamma.data;
  const inv = new Float64Array(R);
  for (let i = 0; i < R; i++) {
    const base = i * C;
    let ms = 0;
    for (let j = 0; j < C; j++) ms += a[base + j] * a[base + j];
    ms /= C;
    const is = 1 / Math.sqrt(ms + eps);
    inv[i] = is;
    for (let j = 0; j < C; j++) o[base + j] = g[j] * a[base + j] * is;
  }
  out.op = 'rmsNorm';
  out.prev = [x, gamma];
  out.backwardFn = () => {
    const go = out.grad;
    const gx = x.grad;
    const gg = gamma.grad;
    for (let i = 0; i < R; i++) {
      const base = i * C;
      const is = inv[i];
      let dot = 0; // Σ_j g_ij · gamma_j · x_ij
      for (let j = 0; j < C; j++) {
        dot += go[base + j] * g[j] * a[base + j];
        gg[j] += go[base + j] * a[base + j] * is;
      }
      const k = (is * is * is) / C;
      for (let j = 0; j < C; j++) {
        gx[base + j] += is * (go[base + j] * g[j]) - k * a[base + j] * dot;
      }
    }
  };
  return out;
}

// Causal depthwise 1-D convolution over the sequence axis. `x` is [L, D] (row = timestep,
// col = channel), `weight` is [D, K] (one length-K kernel per channel), `bias` is [1, D]. The
// convolution is *causal* — output position l mixes only inputs at l-K+1 … l (left-padded with
// zeros) — and *depthwise* — each channel is convolved independently, exactly the short conv
// Mamba places before the SSM to give it a local receptive field. Hand-derived backward.
export function causalConv1d(x: Tensor, weight: Tensor, bias: Tensor): Tensor {
  const L = x.rows;
  const D = x.cols;
  const K = weight.cols;
  if (weight.rows !== D) throw new Error(`causalConv1d weight must be [${D},K] but got [${weight.rows},${weight.cols}]`);
  if (bias.rows !== 1 || bias.cols !== D) throw new Error(`causalConv1d bias must be [1,${D}]`);
  const out = Tensor.zeros(L, D);
  const o = out.data;
  const a = x.data;
  const w = weight.data;
  const b = bias.data;
  for (let l = 0; l < L; l++) {
    for (let d = 0; d < D; d++) {
      let acc = b[d];
      for (let k = 0; k < K; k++) {
        const idx = l - (K - 1) + k;
        if (idx < 0) continue;
        acc += w[d * K + k] * a[idx * D + d];
      }
      o[l * D + d] = acc;
    }
  }
  out.op = 'causalConv1d';
  out.prev = [x, weight, bias];
  out.backwardFn = () => {
    const go = out.grad;
    const gx = x.grad;
    const gw = weight.grad;
    const gb = bias.grad;
    for (let l = 0; l < L; l++) {
      for (let d = 0; d < D; d++) {
        const g = go[l * D + d];
        gb[d] += g;
        for (let k = 0; k < K; k++) {
          const idx = l - (K - 1) + k;
          if (idx < 0) continue;
          gw[d * K + k] += g * a[idx * D + d];
          gx[idx * D + d] += g * w[d * K + k];
        }
      }
    }
  };
  return out;
}

// Diagnostics captured (no gradient) from a selective-scan forward, for the visualiser.
export interface ScanCapture {
  stateNorm: Float64Array; // [L] — ‖h_l‖ over all (channel, state) at each timestep
}

// **The selective scan** — the core of Mamba (the `selective_scan_ref` of the paper, in TS).
// All channels d ∈ [0,D) run an independent diagonal SSM with state size N; the parameters are
// *selective* (input-dependent) so each (timestep, channel) discretizes its own dynamics:
//
//   inputs:  x [L,D] (the SSM input u),  delta [L,D] (Δ, after softplus so > 0),
//            A [D,N] (state matrix, typically −exp(A_log) < 0),  B [L,N],  C [L,N],
//            Dskip [1,D] (the per-channel skip connection)
//   per (l,d,n):  ā = exp(Δ_ld · A_dn),   b̄ = Δ_ld · B_ln · x_ld
//                 h_ldn = ā · h_(l-1)dn + b̄
//   output:  y_ld = Σ_n C_ln · h_ldn  +  Dskip_d · x_ld          → [L,D]
//
// The whole vector-Jacobian product (w.r.t. all six inputs) is hand-derived below: the state
// adjoint is swept backward through the recurrence, gs_l = C_l·gy_l + ā_(l+1)⊙gs_(l+1), and the
// per-step coefficient grads chain through ā = exp(Δ·A) and b̄ = Δ·B·x. Proven in `selftest.ts`.
export function selectiveScan(
  x: Tensor,
  delta: Tensor,
  A: Tensor,
  B: Tensor,
  C: Tensor,
  Dskip: Tensor,
  capture?: ScanCapture,
): Tensor {
  const L = x.rows;
  const D = x.cols;
  const N = A.cols;
  if (delta.rows !== L || delta.cols !== D) throw new Error('selectiveScan delta shape mismatch');
  if (A.rows !== D) throw new Error('selectiveScan A shape mismatch');
  if (B.rows !== L || B.cols !== N) throw new Error('selectiveScan B shape mismatch');
  if (C.rows !== L || C.cols !== N) throw new Error('selectiveScan C shape mismatch');
  if (Dskip.rows !== 1 || Dskip.cols !== D) throw new Error('selectiveScan Dskip shape mismatch');

  const out = Tensor.zeros(L, D);
  const o = out.data;
  const xd = x.data;
  const dd = delta.data;
  const Ad = A.data;
  const Bd = B.data;
  const Cd = C.data;
  const Dd = Dskip.data;

  // Full state trajectory h_l (needed by backward), flat as [(l*D + d)*N + n].
  const S = new Float64Array(L * D * N);
  const sloc = new Float64Array(N);
  for (let d = 0; d < D; d++) {
    sloc.fill(0);
    for (let l = 0; l < L; l++) {
      const dl = dd[l * D + d];
      const xl = xd[l * D + d];
      let y = 0;
      const sBase = (l * D + d) * N;
      for (let n = 0; n < N; n++) {
        const aa = Math.exp(dl * Ad[d * N + n]);
        const bb = dl * Bd[l * N + n] * xl;
        const s = aa * sloc[n] + bb;
        sloc[n] = s;
        S[sBase + n] = s;
        y += Cd[l * N + n] * s;
      }
      o[l * D + d] = y + Dd[d] * xl;
    }
  }

  if (capture) {
    const sn = new Float64Array(L);
    for (let l = 0; l < L; l++) {
      let sq = 0;
      for (let d = 0; d < D; d++) {
        const sBase = (l * D + d) * N;
        for (let n = 0; n < N; n++) sq += S[sBase + n] * S[sBase + n];
      }
      sn[l] = Math.sqrt(sq);
    }
    capture.stateNorm = sn;
  }

  out.op = 'selectiveScan';
  out.prev = [x, delta, A, B, C, Dskip];
  out.backwardFn = () => {
    const go = out.grad;
    const gx = x.grad;
    const gdelta = delta.grad;
    const gA = A.grad;
    const gB = B.grad;
    const gC = C.grad;
    const gD = Dskip.grad;
    const carry = new Float64Array(N); // gs_(l+1)[n] · ā_(l+1)[n] flowing into step l
    for (let d = 0; d < D; d++) {
      carry.fill(0);
      for (let l = L - 1; l >= 0; l--) {
        const dl = dd[l * D + d];
        const xl = xd[l * D + d];
        const gy = go[l * D + d];
        // skip path: y_l = … + Dskip_d · x_l
        gx[l * D + d] += gy * Dd[d];
        gD[d] += gy * xl;
        let gdl = 0; // dL/dΔ_ld
        let gxl = 0; // dL/dx_ld via the state path
        const sBase = (l * D + d) * N;
        for (let n = 0; n < N; n++) {
          const Adn = Ad[d * N + n];
          const aa = Math.exp(dl * Adn); // ā_l[n]
          const gsn = gy * Cd[l * N + n] + carry[n]; // gs_l[n]
          const sprev = l > 0 ? S[((l - 1) * D + d) * N + n] : 0;
          const ga = gsn * sprev; // dL/dā_l[n]
          const gb = gsn; // dL/db̄_l[n]
          // ā = exp(Δ·A)
          gdl += ga * aa * Adn;
          gA[d * N + n] += ga * aa * dl;
          // b̄ = Δ·B·x
          gdl += gb * Bd[l * N + n] * xl;
          gB[l * N + n] += gb * dl * xl;
          gxl += gb * dl * Bd[l * N + n];
          // C only appears in y_l: dL/dC_ln = gy · h_ln
          gC[l * N + n] += gy * S[sBase + n];
          // pass gs_l[n]·ā_l[n] back to step l-1
          carry[n] = gsn * aa;
        }
        gdelta[l * D + d] += gdl;
        gx[l * D + d] += gxl;
      }
    }
  };
  return out;
}

// ---- the Mamba block + language model ---------------------------------------------------

export interface MambaConfig {
  vocab: number;
  dModel: number;
  dState: number; // N — SSM state size per channel
  dConv: number; // depthwise causal conv kernel width
  expand: number; // dInner = expand · dModel
  dtRank: number; // low-rank dimension of the Δ projection
  nLayers: number;
  maxLen: number;
  seed: number;
}

export function defaultDtRank(dModel: number, expand: number): number {
  return Math.max(2, Math.ceil((expand * dModel) / 16));
}

// Per-layer selectivity captured from the most recent forward pass — what the lab renders.
export interface SsmSnapshot {
  T: number;
  nLayers: number;
  dInner: number;
  // delta[layer] is length T*dInner — Δ per token per inner channel (the selectivity heatmap).
  delta: Float64Array[];
  // stateNorm[layer] is length T — ‖h_l‖ across the layer's SSM state at each token.
  stateNorm: Float64Array[];
  // deltaTokenMean[layer] is length T — mean Δ over channels (how much each token "writes").
  deltaTokenMean: Float64Array[];
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

interface MambaLayer {
  norm: Tensor; // RMSNorm γ [1, dModel]
  inProj: Tensor; // [dModel, 2·dInner] → (x path, gate z)
  convW: Tensor; // [dInner, dConv] depthwise causal conv kernel
  convB: Tensor; // [1, dInner]
  xProj: Tensor; // [dInner, dtRank + 2·N] → (Δ_raw, B, C)
  dtProjW: Tensor; // [dtRank, dInner]
  dtBias: Tensor; // [1, dInner] — Δ = softplus(Δ_raw·dtProjW + dtBias)
  ALog: Tensor; // [dInner, N] — A = −exp(ALog) (negative, stable)
  Dskip: Tensor; // [1, dInner]
  outProj: Tensor; // [dInner, dModel]
}

export class MambaLM {
  cfg: MambaConfig;
  dInner: number;
  tokEmb: Tensor; // [vocab, dModel] — tied with the output projection
  normF: Tensor; // final RMSNorm γ
  layers: MambaLayer[];
  lastSnapshot: SsmSnapshot | null = null;

  constructor(cfg: MambaConfig) {
    this.cfg = cfg;
    this.dInner = cfg.expand * cfg.dModel;
    const N = cfg.dState;
    const dInner = this.dInner;
    const rng = mulberry32(cfg.seed);
    this.tokEmb = randTensor(cfg.vocab, cfg.dModel, 0.04, rng, 'tokEmb');
    this.normF = Tensor.fromFlat(new Float64Array(cfg.dModel).fill(1), 1, cfg.dModel, true).named('normF.γ');
    this.layers = [];
    for (let l = 0; l < cfg.nLayers; l++) {
      // A init: the S4D-real diagonal A_n = −(n+1), stored as ALog = log(n+1) so A = −exp(ALog).
      const aLog = new Float64Array(dInner * N);
      for (let d = 0; d < dInner; d++) for (let n = 0; n < N; n++) aLog[d * N + n] = Math.log(n + 1);
      // dt bias: softplus(dtBias) ≈ 0.1 (the middle of Mamba's [dt_min, dt_max]).
      const dtb = new Float64Array(dInner).fill(Math.log(Math.expm1(0.1)));
      this.layers.push({
        norm: Tensor.fromFlat(new Float64Array(cfg.dModel).fill(1), 1, cfg.dModel, true).named(`L${l}.norm.γ`),
        inProj: randTensor(cfg.dModel, 2 * dInner, 1 / Math.sqrt(cfg.dModel), rng, `L${l}.inProj`),
        convW: randTensor(dInner, cfg.dConv, 0.2, rng, `L${l}.convW`),
        convB: Tensor.zeros(1, dInner, true).named(`L${l}.convB`),
        xProj: randTensor(dInner, cfg.dtRank + 2 * N, 1 / Math.sqrt(dInner), rng, `L${l}.xProj`),
        dtProjW: randTensor(cfg.dtRank, dInner, 1 / Math.sqrt(cfg.dtRank), rng, `L${l}.dtProjW`),
        dtBias: Tensor.fromFlat(dtb, 1, dInner, true).named(`L${l}.dtBias`),
        ALog: Tensor.fromFlat(aLog, dInner, N, true).named(`L${l}.ALog`),
        Dskip: Tensor.fromFlat(new Float64Array(dInner).fill(1), 1, dInner, true).named(`L${l}.D`),
        outProj: randTensor(dInner, cfg.dModel, 1 / Math.sqrt(dInner), rng, `L${l}.outProj`),
      });
    }
  }

  // Slice columns [c0, c1) out of a [R, C] tensor as a [R, c1−c0] tensor (differentiable).
  // (A thin local helper; the engine has concatCols but not a column slice.)
  private static sliceCols(x: Tensor, c0: number, c1: number): Tensor {
    const R = x.rows;
    const C = x.cols;
    const w = c1 - c0;
    const out = Tensor.zeros(R, w);
    const o = out.data;
    const a = x.data;
    for (let i = 0; i < R; i++) for (let j = 0; j < w; j++) o[i * w + j] = a[i * C + c0 + j];
    out.op = 'sliceCols';
    out.prev = [x];
    out.backwardFn = () => {
      const g = out.grad;
      const gx = x.grad;
      for (let i = 0; i < R; i++) for (let j = 0; j < w; j++) gx[i * C + c0 + j] += g[i * w + j];
    };
    return out;
  }

  // One Mamba block over token states `h` [T, dModel] (pre-RMSNorm residual). Returns the new
  // residual stream; when `snap` is given, records this layer's selectivity for the visualiser.
  private block(layer: MambaLayer, h: Tensor, snap: SsmSnapshot | null): Tensor {
    const T = h.rows;
    const N = this.cfg.dState;
    const dInner = this.dInner;
    const dtRank = this.cfg.dtRank;

    const normed = rmsNorm(h, layer.norm);
    const xz = normed.matmul(layer.inProj); // [T, 2·dInner]
    const xin = MambaLM.sliceCols(xz, 0, dInner); // SSM path
    const z = MambaLM.sliceCols(xz, dInner, 2 * dInner); // gate

    // Short causal depthwise conv + SiLU.
    const xConv = causalConv1d(xin, layer.convW, layer.convB).silu(); // [T, dInner]

    // Input-dependent Δ, B, C (the selectivity).
    const dbl = xConv.matmul(layer.xProj); // [T, dtRank + 2N]
    const dtRaw = MambaLM.sliceCols(dbl, 0, dtRank); // [T, dtRank]
    const B = MambaLM.sliceCols(dbl, dtRank, dtRank + N); // [T, N]
    const C = MambaLM.sliceCols(dbl, dtRank + N, dtRank + 2 * N); // [T, N]
    const delta = dtRaw.matmul(layer.dtProjW).add(layer.dtBias).softplus(); // [T, dInner] > 0

    // A = −exp(ALog) (diagonal, negative → contractive recurrence).
    const A = layer.ALog.exp().neg(); // [dInner, N]

    const cap: ScanCapture | undefined = snap ? { stateNorm: new Float64Array(T) } : undefined;
    let y = selectiveScan(xConv, delta, A, B, C, layer.Dskip, cap); // [T, dInner]
    y = y.mul(z.silu()); // gated
    const out = y.matmul(layer.outProj); // [T, dModel]

    if (snap && cap) {
      snap.delta.push(delta.data.slice());
      snap.stateNorm.push(cap.stateNorm);
      const mean = new Float64Array(T);
      for (let t = 0; t < T; t++) {
        let s = 0;
        for (let d = 0; d < dInner; d++) s += delta.data[t * dInner + d];
        mean[t] = s / dInner;
      }
      snap.deltaTokenMean.push(mean);
    }

    return h.add(out); // residual
  }

  // Forward over a single token sequence → logits [T, vocab]. No positional encoding: the conv
  // and the recurrence carry order. `capture` stashes per-layer selectivity on `lastSnapshot`.
  forward(ids: Int32Array, capture = false): Tensor {
    const T = ids.length;
    let h = embedding(this.tokEmb, ids); // [T, dModel]
    const snap: SsmSnapshot | null = capture
      ? { T, nLayers: this.cfg.nLayers, dInner: this.dInner, delta: [], stateNorm: [], deltaTokenMean: [] }
      : null;
    for (const layer of this.layers) h = this.block(layer, h, snap);
    h = rmsNorm(h, this.normF);
    const logits = h.matmul(this.tokEmb.transpose()); // weight-tied head → [T, vocab]
    if (snap) this.lastSnapshot = snap;
    return logits;
  }

  // Greedy autoregressive decode (re-runs the forward each step; clarity over speed at this scale).
  generate(prompt: Int32Array, count: number): Int32Array {
    const out: number[] = Array.from(prompt);
    for (let i = 0; i < count; i++) {
      const ids = Int32Array.from(out);
      const logits = this.forward(ids);
      const base = (ids.length - 1) * this.cfg.vocab;
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
    const ps: Tensor[] = [this.tokEmb, this.normF];
    for (const l of this.layers) {
      ps.push(l.norm, l.inProj, l.convW, l.convB, l.xProj, l.dtProjW, l.dtBias, l.ALog, l.Dskip, l.outProj);
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
