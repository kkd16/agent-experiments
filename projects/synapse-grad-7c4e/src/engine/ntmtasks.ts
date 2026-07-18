// The Neural Turing Machine's algorithmic tasks, straight from Graves, Wayne & Danihelka
// (2014). Every example is a stream of small binary vectors generated on the fly from a seeded
// RNG — there is no bundled dataset. The network is *told nothing* about the algorithm; it must
// discover "store, then traverse and read back" (copy), "store, then read back R times"
// (repeat-copy), or "index by content" (associative recall) purely from input/target pairs, and
// the only reason it can is the external memory. Loss is bit-wise binary cross-entropy over the
// scored (answer-phase) steps; a solve is every scored bit correct after thresholding at 0.5.

import { Tensor } from './tensor';
import { stackRows } from './ops';
import { bceWithLogits } from './losses';

export type NtmTaskKind = 'copy' | 'repeat-copy' | 'associative';

export interface NtmTaskInfo {
  kind: NtmTaskKind;
  label: string;
  blurb: string;
}

export const NTM_TASKS: NtmTaskInfo[] = [
  { kind: 'copy', label: 'Copy', blurb: 'store a sequence, then reproduce it exactly' },
  { kind: 'repeat-copy', label: 'Repeat-Copy', blurb: 'reproduce the stored sequence R times' },
  { kind: 'associative', label: 'Assoc. Recall', blurb: 'return the item that followed the query' },
];

export interface NtmTaskConfig {
  kind: NtmTaskKind;
  bitWidth: number; // W — width of one data vector
  minLen: number; // shortest item/sequence length sampled
  curLen: number; // current maximum length (grows with the curriculum)
  maxRepeats: number; // repeat-copy: largest R
  itemLen: number; // associative: vectors per item
  maxItems: number; // associative: largest number of items before the query
}

// One worked example.
export interface NtmSample {
  inputs: Float64Array[]; // [T][inputWidth]
  targets: Float64Array[]; // [T][outputWidth] — only meaningful where scored[t] = 1
  scored: Uint8Array; // [T] — 1 = this step counts toward loss + accuracy
  inputWidth: number;
  outputWidth: number;
  length: number; // the sampled item/sequence length
  repeats: number; // repeat-copy only (1 otherwise)
  items: number; // associative only (0 otherwise)
}

// Channel layout. Data occupies the first W input channels; the trailing channels are control
// flags. Copy/repeat-copy: [data(W), start-flag, extra]. Associative: [data(W), item-flag,
// query-flag]. The output is always the W data bits.
export function inputWidth(cfg: NtmTaskConfig): number {
  if (cfg.kind === 'associative') return cfg.bitWidth + 2;
  return cfg.bitWidth + 2; // start flag + (repeat-count for repeat-copy, else spare)
}
export function outputWidth(cfg: NtmTaskConfig): number {
  return cfg.bitWidth;
}

// Upper bound on the number of timesteps a config can produce — used to reason about UI sizing.
export function maxSteps(cfg: NtmTaskConfig): number {
  if (cfg.kind === 'copy') return 2 * cfg.curLen + 1;
  if (cfg.kind === 'repeat-copy') return cfg.curLen + 2 + cfg.maxRepeats * cfg.curLen;
  // associative: (itemLen+1) per item * maxItems  +  query block  +  answer
  return (cfg.itemLen + 1) * cfg.maxItems + (cfg.itemLen + 1) + cfg.itemLen;
}

function randBits(W: number, rng: () => number): Float64Array {
  const v = new Float64Array(W);
  for (let j = 0; j < W; j++) v[j] = rng() < 0.5 ? 0 : 1;
  return v;
}

function randInt(lo: number, hi: number, rng: () => number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function makeSample(cfg: NtmTaskConfig, rng: () => number): NtmSample {
  if (cfg.kind === 'copy') return makeCopy(cfg, rng);
  if (cfg.kind === 'repeat-copy') return makeRepeatCopy(cfg, rng);
  return makeAssociative(cfg, rng);
}

// Copy: present L data vectors, a one-step delimiter (start-flag = 1), then L blank steps whose
// targets are the original vectors, in order.
function makeCopy(cfg: NtmTaskConfig, rng: () => number): NtmSample {
  const W = cfg.bitWidth;
  const IW = inputWidth(cfg);
  const L = randInt(cfg.minLen, cfg.curLen, rng);
  const seq: Float64Array[] = [];
  for (let i = 0; i < L; i++) seq.push(randBits(W, rng));

  const inputs: Float64Array[] = [];
  const targets: Float64Array[] = [];
  const scored: number[] = [];

  for (let i = 0; i < L; i++) {
    const x = new Float64Array(IW);
    x.set(seq[i], 0);
    inputs.push(x);
    targets.push(new Float64Array(W));
    scored.push(0);
  }
  const delim = new Float64Array(IW);
  delim[W] = 1; // start-of-output flag
  inputs.push(delim);
  targets.push(new Float64Array(W));
  scored.push(0);

  for (let i = 0; i < L; i++) {
    inputs.push(new Float64Array(IW));
    targets.push(seq[i]);
    scored.push(1);
  }
  return {
    inputs,
    targets,
    scored: Uint8Array.from(scored),
    inputWidth: IW,
    outputWidth: W,
    length: L,
    repeats: 1,
    items: 0,
  };
}

// Repeat-copy: present L data vectors, a delimiter carrying the repeat count R on its second
// flag channel (scaled), then R·L blank steps whose targets are the sequence repeated R times.
function makeRepeatCopy(cfg: NtmTaskConfig, rng: () => number): NtmSample {
  const W = cfg.bitWidth;
  const IW = inputWidth(cfg);
  const L = randInt(cfg.minLen, cfg.curLen, rng);
  const R = randInt(1, cfg.maxRepeats, rng);
  const seq: Float64Array[] = [];
  for (let i = 0; i < L; i++) seq.push(randBits(W, rng));

  const inputs: Float64Array[] = [];
  const targets: Float64Array[] = [];
  const scored: number[] = [];

  for (let i = 0; i < L; i++) {
    const x = new Float64Array(IW);
    x.set(seq[i], 0);
    inputs.push(x);
    targets.push(new Float64Array(W));
    scored.push(0);
  }
  const delim = new Float64Array(IW);
  delim[W] = 1; // start-of-output flag
  delim[W + 1] = R / cfg.maxRepeats; // normalised repeat count
  inputs.push(delim);
  targets.push(new Float64Array(W));
  scored.push(0);

  for (let r = 0; r < R; r++) {
    for (let i = 0; i < L; i++) {
      inputs.push(new Float64Array(IW));
      targets.push(seq[i]);
      scored.push(1);
    }
  }
  return {
    inputs,
    targets,
    scored: Uint8Array.from(scored),
    inputWidth: IW,
    outputWidth: W,
    length: L,
    repeats: R,
    items: 0,
  };
}

// Associative recall: present K items (each `itemLen` vectors) each preceded by an item-flag
// step, then a query-flag step followed by one of the presented items, then blanks whose target
// is the *next* item. The model must use content to find where the query is stored and read the
// following item.
function makeAssociative(cfg: NtmTaskConfig, rng: () => number): NtmSample {
  const W = cfg.bitWidth;
  const IW = inputWidth(cfg);
  const P = cfg.itemLen;
  const lo = Math.max(2, cfg.minLen);
  const K = randInt(lo, Math.max(lo, cfg.maxItems), rng);
  const items: Float64Array[][] = [];
  for (let k = 0; k < K; k++) {
    const it: Float64Array[] = [];
    for (let p = 0; p < P; p++) it.push(randBits(W, rng));
    items.push(it);
  }

  const inputs: Float64Array[] = [];
  const targets: Float64Array[] = [];
  const scored: number[] = [];

  const pushBlankTarget = () => targets.push(new Float64Array(W));

  // Item flag = channel W; query flag = channel W+1.
  for (let k = 0; k < K; k++) {
    const flag = new Float64Array(IW);
    flag[W] = 1; // item separator
    inputs.push(flag);
    pushBlankTarget();
    scored.push(0);
    for (let p = 0; p < P; p++) {
      const x = new Float64Array(IW);
      x.set(items[k][p], 0);
      inputs.push(x);
      pushBlankTarget();
      scored.push(0);
    }
  }
  // Query = an item that is NOT the last one (so a "next" exists).
  const q = randInt(0, K - 2, rng);
  const qflag = new Float64Array(IW);
  qflag[W + 1] = 1; // query marker
  inputs.push(qflag);
  pushBlankTarget();
  scored.push(0);
  for (let p = 0; p < P; p++) {
    const x = new Float64Array(IW);
    x.set(items[q][p], 0);
    inputs.push(x);
    pushBlankTarget();
    scored.push(0);
  }
  // Answer: the item after q, scored.
  for (let p = 0; p < P; p++) {
    inputs.push(new Float64Array(IW));
    targets.push(items[q + 1][p]);
    scored.push(1);
  }
  return {
    inputs,
    targets,
    scored: Uint8Array.from(scored),
    inputWidth: IW,
    outputWidth: W,
    length: P,
    repeats: 1,
    items: K,
  };
}

// Assemble the scored logit rows and their targets into aligned matrices for the loss.
export function assembleScored(logits: Tensor[], sample: NtmSample): { pred: Tensor; target: Tensor } | null {
  const rows: Tensor[] = [];
  const tgt: number[] = [];
  const W = sample.outputWidth;
  for (let t = 0; t < logits.length; t++) {
    if (!sample.scored[t]) continue;
    rows.push(logits[t]);
    for (let j = 0; j < W; j++) tgt.push(sample.targets[t][j]);
  }
  if (rows.length === 0) return null;
  const pred = stackRows(rows); // [S, W]
  const target = Tensor.fromFlat(Float64Array.from(tgt), rows.length, W, false);
  return { pred, target };
}

// Bit-wise BCE over the scored steps (sum over bits, mean over scored steps).
export function ntmLoss(logits: Tensor[], sample: NtmSample): Tensor | null {
  const a = assembleScored(logits, sample);
  if (!a) return null;
  return bceWithLogits(a.pred, a.target);
}

export interface NtmEval {
  loss: number;
  bitAcc: number;
  seqAcc: number; // fraction of samples with every scored bit correct
}

// Evaluate a batch of already-computed (logits, sample) pairs. `logitData` is each sample's
// per-step logit rows read straight off the forward pass.
export function scoreSample(logits: Tensor[], sample: NtmSample): { bitTotal: number; bitCorrect: number; solved: boolean } {
  const W = sample.outputWidth;
  let bitTotal = 0;
  let bitCorrect = 0;
  let solved = true;
  for (let t = 0; t < logits.length; t++) {
    if (!sample.scored[t]) continue;
    for (let j = 0; j < W; j++) {
      const prob = 1 / (1 + Math.exp(-logits[t].data[j]));
      const pred = prob > 0.5 ? 1 : 0;
      bitTotal++;
      if (pred === sample.targets[t][j]) bitCorrect++;
      else solved = false;
    }
  }
  return { bitTotal, bitCorrect, solved };
}
