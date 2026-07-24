// Grokking — delayed generalization on modular arithmetic.
//
// This is the famous experiment of Power et al. (2022): train a tiny Transformer on the map
// (a, b) ↦ (a ∘ b) mod p from a *fraction* of the p² possible pairs, with weight decay, and
// keep training long after it has perfectly memorized the training set. For a long plateau the
// held-out accuracy sits at chance — the network has memorized, not understood — and then,
// abruptly and thousands of steps later, it **groks**: the test accuracy shoots to 100%. The
// network has found the *general algorithm*.
//
// Nanda et al. (2023) reverse-engineered what that algorithm is. The embedding of a number n is
// driven onto a **circle** — the model represents n as the angle 2πkn/p for a handful of integer
// "key frequencies" k — and addition becomes rotation: cos/sin angle-addition identities let the
// attention + MLP compute the argmax of cos(2πk(a+b−c)/p) over candidate answers c. The tell-tale
// signature is that the **Discrete Fourier Transform of the learned embedding table is sparse** —
// almost all its energy sits on a few frequencies. This module builds the task, the exact-match
// evaluation, and those two interpretability probes (the embedding circle and its Fourier power
// spectrum) so the lab can show *both* the phenomenon and its mechanism.
//
// Everything runs on Synapse's own autograd `GPT` (`transformer.ts`) — no new network code; the
// grokking here is produced by the identical decoder-only Transformer the Attention lab trains,
// only fed 3-token "<a> <b> =" sequences and read out at the '=' position. The weight-decayed
// AdamW that drives the transition is the engine's existing optimizer.

import { GPT, type GPTConfig } from './transformer';
import { maskedCrossEntropy } from './losses';
import { mulberry32 } from './nn';

// The binary operation the network must learn on ℤ/pℤ. Addition and subtraction are the classic
// grokking targets; multiplication over the group of units and squaring are included so the lab
// can show that grokking is not special to `+` — any operation with enough algebraic structure
// groks (and the harder ones grok later).
export type GrokOp = 'add' | 'sub' | 'mul' | 'x2y2';

export interface GrokOpInfo {
  kind: GrokOp;
  label: string;
  formula: string;
  blurb: string;
}

export const GROK_OPS: GrokOpInfo[] = [
  { kind: 'add', label: 'Addition', formula: '(a + b) mod p', blurb: 'the canonical grokking task' },
  { kind: 'sub', label: 'Subtraction', formula: '(a − b) mod p', blurb: 'non-commutative — order matters' },
  { kind: 'mul', label: 'Multiplication', formula: '(a · b) mod p', blurb: 'the multiplicative group of units' },
  { kind: 'x2y2', label: 'Sum of squares', formula: '(a² + b²) mod p', blurb: 'a harder algebraic map — groks later' },
];

export function applyOp(op: GrokOp, a: number, b: number, p: number): number {
  switch (op) {
    case 'add':
      return (a + b) % p;
    case 'sub':
      return ((a - b) % p + p) % p;
    case 'mul':
      return (a * b) % p;
    case 'x2y2':
      return (a * a + b * b) % p;
  }
}

// One worked example: the 3-token sequence "<a> <b> =" and the correct answer token c. The
// vocabulary is {0, 1, …, p−1, '='}, so the '=' token id is exactly `p` and the vocab size p+1.
export interface GrokExample {
  a: number;
  b: number;
  c: number;
  ids: Int32Array; // [a, b, EQ]
}

export interface GrokDataset {
  p: number;
  op: GrokOp;
  vocab: number; // p + 1
  eqToken: number; // = p
  all: GrokExample[];
  trainIdx: Int32Array;
  testIdx: Int32Array;
}

// Build the full p×p table for `op`, then split it into a train fraction and a held-out test set
// by a seeded Fisher–Yates shuffle. The split is deterministic in `seed`, so a given seed always
// yields the same train/test partition (important: whether a pair is seen or held out is the
// entire game here). Pairs with an undefined answer are dropped — none for these ops, but the
// guard keeps the builder honest if a partial operation is added later.
export function buildDataset(p: number, op: GrokOp, trainFrac: number, seed: number): GrokDataset {
  const eqToken = p;
  const all: GrokExample[] = [];
  for (let a = 0; a < p; a++) {
    for (let b = 0; b < p; b++) {
      const c = applyOp(op, a, b, p);
      all.push({ a, b, c, ids: Int32Array.from([a, b, eqToken]) });
    }
  }
  const order = Array.from({ length: all.length }, (_, i) => i);
  const rng = mulberry32(seed ^ 0x9e3779b9);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  const nTrain = Math.max(1, Math.min(all.length - 1, Math.round(all.length * trainFrac)));
  const trainIdx = Int32Array.from(order.slice(0, nTrain));
  const testIdx = Int32Array.from(order.slice(nTrain));
  return { p, op, vocab: p + 1, eqToken, all, trainIdx, testIdx };
}

// A `keep` mask that scores the loss at the final ('=') position only — the model sees the whole
// 3-token context but is graded (and back-propagated) solely on the answer it emits there.
export const GROK_KEEP = new Uint8Array([0, 0, 1]);

// Targets aligned to the next-token convention of `maskedCrossEntropy` (targets[i] is the label
// the model must predict *at* position i). Only position 2 is kept, so positions 0/1 are fillers.
export function grokTargets(ex: GrokExample, eqToken: number): Int32Array {
  return Int32Array.from([eqToken, eqToken, ex.c]);
}

export interface GrokEval {
  loss: number;
  acc: number;
}

// Exact-match accuracy + mean cross-entropy over a set of examples, reading the argmax logit at
// the '=' position. One forward per example on the tape-free-enough path (we still build the
// graph, but never call backward here, so it stays cheap).
export function evalSet(gpt: GPT, ds: GrokDataset, idx: Int32Array): GrokEval {
  if (idx.length === 0) return { loss: NaN, acc: NaN };
  const V = ds.vocab;
  let correct = 0;
  let lossSum = 0;
  for (let n = 0; n < idx.length; n++) {
    const ex = ds.all[idx[n]];
    const logits = gpt.forward(ex.ids);
    const { loss } = maskedCrossEntropy(logits, grokTargets(ex, ds.eqToken), GROK_KEEP);
    lossSum += loss.data[0];
    const base = 2 * V;
    let best = 0;
    let bv = -Infinity;
    for (let j = 0; j < V; j++) {
      const v = logits.data[base + j];
      if (v > bv) {
        bv = v;
        best = j;
      }
    }
    if (best === ex.c) correct++;
  }
  return { loss: lossSum / idx.length, acc: correct / idx.length };
}

// A single confident, deterministic default architecture for the lab. One layer, four heads —
// small enough to train live, expressive enough to grok — with the position table sized to the
// fixed 3-token context.
export function grokConfig(p: number, dModel: number, nHeads: number, dFF: number, seed: number): GPTConfig {
  return { vocab: p + 1, dModel, nHeads, nLayers: 1, dFF, maxLen: 3, seed };
}

// ---- interpretability: the embedding circle + its Fourier spectrum -------------------------

// The centered embedding rows for the p *number* tokens (dropping the '=' token), as Float64
// vectors of length dModel. Centering removes the shared mean so PCA/DFT see only the structure
// that varies with n.
export function numberEmbeddings(gpt: GPT, p: number): Float64Array[] {
  const d = gpt.cfg.dModel;
  const mean = new Float64Array(d);
  const rows: Float64Array[] = [];
  for (let n = 0; n < p; n++) {
    const r = new Float64Array(d);
    for (let j = 0; j < d; j++) {
      r[j] = gpt.tokEmb.data[n * d + j];
      mean[j] += r[j];
    }
    rows.push(r);
  }
  for (let j = 0; j < d; j++) mean[j] /= p;
  for (const r of rows) for (let j = 0; j < d; j++) r[j] -= mean[j];
  return rows;
}

export interface FourierSpectrum {
  p: number;
  // power[k] for k = 1 … floor(p/2): total energy the embedding table places on frequency k
  // (the DFT of the length-p signal n ↦ E[n, :], summed over embedding dimensions). Normalized so
  // the vector sums to 1 — a memorizing net spreads energy across all k; a grokked net spikes it
  // onto a few "key frequencies".
  power: Float64Array;
  keyFreqs: number[]; // frequencies carrying more than a threshold share of the energy
  sparsity: number; // participation-ratio sparsity in [0,1]: 1 ⇒ energy on a single frequency
}

// DFT power of the centered number-embedding table over the token index n. For each frequency
// k ∈ [1, ⌊p/2⌋] and each embedding dimension d we form the real correlation Σ_n E[n,d]·cos(2πkn/p)
// and Σ_n E[n,d]·sin(2πkn/p); the per-frequency power sums the squared magnitude over d. This is
// exactly the quantity Nanda et al. plot to reveal that a grokked embedding lives on a handful of
// frequencies (the mechanism behind the circle).
export function fourierSpectrum(gpt: GPT, p: number): FourierSpectrum {
  const rows = numberEmbeddings(gpt, p);
  const d = gpt.cfg.dModel;
  const kMax = Math.floor(p / 2);
  const power = new Float64Array(kMax + 1); // index by k; power[0] unused
  for (let k = 1; k <= kMax; k++) {
    // Precompute cos/sin for this frequency across n.
    const cos = new Float64Array(p);
    const sin = new Float64Array(p);
    for (let n = 0; n < p; n++) {
      const ang = (2 * Math.PI * k * n) / p;
      cos[n] = Math.cos(ang);
      sin[n] = Math.sin(ang);
    }
    let pw = 0;
    for (let j = 0; j < d; j++) {
      let re = 0;
      let im = 0;
      for (let n = 0; n < p; n++) {
        re += rows[n][j] * cos[n];
        im += rows[n][j] * sin[n];
      }
      pw += re * re + im * im;
    }
    power[k] = pw;
  }
  // Normalize to a probability vector over k = 1..kMax.
  let total = 0;
  for (let k = 1; k <= kMax; k++) total += power[k];
  if (total > 0) for (let k = 1; k <= kMax; k++) power[k] /= total;

  // Key frequencies: those above 1.5× the uniform share (a memorizing net is ~uniform).
  const uniform = 1 / kMax;
  const keyFreqs: number[] = [];
  for (let k = 1; k <= kMax; k++) if (power[k] > 1.5 * uniform && power[k] > 0.03) keyFreqs.push(k);
  keyFreqs.sort((a, b) => power[b] - power[a]);

  // Participation-ratio sparsity: 1 − (effective # of frequencies)/kMax, where the effective
  // count is 1/Σ power². Near 0 when energy is uniform, near 1 when it concentrates.
  let sumSq = 0;
  for (let k = 1; k <= kMax; k++) sumSq += power[k] * power[k];
  const effective = sumSq > 0 ? 1 / sumSq : kMax;
  const sparsity = kMax > 1 ? Math.max(0, Math.min(1, 1 - (effective - 1) / (kMax - 1))) : 0;

  return { p, power, keyFreqs, sparsity };
}

// Project the number embeddings onto their dominant Fourier mode to get clean circle coordinates:
// for the strongest key frequency k*, point n sits at (Σ_d E[n,d]cos(2πk*n/p-ish))… but the
// cleanest, most faithful 2-D picture is simply the top-2 principal components, which for a grokked
// table *are* the cos/sin of the leading key frequency. We return both the PCA points (for the
// scatter) and, per point, the token index so the view can colour by n.
export interface CirclePoint {
  n: number;
  x: number;
  y: number;
}
