// Earning the weighted road — differential verification, the house way.
//
// Every claim this package makes is checked against an *independent* computation
// of the same number, over thousands of seeded random patterns × semirings ×
// weightings × words:
//
//   per word    forward(λμγ) ≡ backward(transpose) ≡ brute path-enumeration
//   cross-tab   Boolean weight ≡ the DFA's verdict (subset construction)
//   cross-tab   Counting weight ≡ #accepting runs (the Ambiguity tab's enumerator)
//   all-words   Lehmann M* ≡ iterative ⊕Mᵏ ≡ state-elimination regex ≡ brute Σ*-sum
//   the algebra distributivity & the star fixpoint star a = 1̄ ⊕ a·star a hold
//
// Any single mismatch is a real bug, surfaced with the exact pattern, semiring,
// weighting and word. The PRNG is seeded, so every run reproduces verbatim.

import { compile } from '../compile';
import { dfaAccepts } from '../simulate';
import { buildGlushkov } from '../glushkov';
import { glushkovENFA, enumerateRuns } from '../ambiguity';
import {
  Boolean2,
  Counting,
  Tropical,
  Viterbi,
  Probability,
  type Count,
  type Semiring,
} from './semiring';
import { buildWFAFromPA, seededWeights, uniformWeights, type WeightOf } from './wcompile';
import {
  closureMatrixIterative,
  closureMatrixLehmann,
  closureValue,
  combinedMatrix,
  maxAcceptedLength,
  wordWeightBackward,
  wordWeightForward,
  type WFA,
} from './wfa';
import { allWordsSum, bruteWordWeight } from './woracle';
import { eliminateToWReg, evalClosure } from './welim';

// --- Seeded PRNG (mulberry32) — the studio's standard fuzz engine ------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(n: number) {
    return Math.floor(this.next() * n);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)];
  }
  chance(p: number) {
    return this.next() < p;
  }
}

const LITERALS = ['a', 'b', 'c'] as const;
const ALPHABET = [97, 98, 99]; // a b c

function genAtom(rng: Rng, depth: number): string {
  const allowGroup = depth < 2;
  const roll = rng.int(allowGroup ? 9 : 7);
  if (roll <= 3) return rng.pick(LITERALS);
  if (roll === 4) return '.';
  if (roll <= 6) {
    const neg = rng.chance(0.3) ? '^' : '';
    const n = 1 + rng.int(2);
    const m: string[] = [];
    for (let i = 0; i < n; i++) m.push(rng.chance(0.4) ? 'a-b' : rng.pick(LITERALS));
    return `[${neg}${m.join('')}]`;
  }
  return `(${genAlt(rng, depth + 1)})`;
}
function genQuantified(rng: Rng, depth: number): string {
  const atom = genAtom(rng, depth);
  switch (rng.int(6)) {
    case 0:
      return atom + '*';
    case 1:
      return atom + '+';
    case 2:
      return atom + '?';
    case 3:
      return `${atom}{${rng.int(3)}}`;
    case 4: {
      const m = rng.int(2);
      return `${atom}{${m},${m + rng.int(3)}}`;
    }
    default:
      return atom;
  }
}
function genConcat(rng: Rng, depth: number): string {
  const n = 1 + rng.int(depth === 0 ? 3 : 2);
  let out = '';
  for (let i = 0; i < n; i++) out += genQuantified(rng, depth);
  return out;
}
function genAlt(rng: Rng, depth: number): string {
  const n = 1 + rng.int(depth < 1 ? 3 : 2);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(genConcat(rng, depth));
  return parts.join('|');
}

function randWord(rng: Rng, maxLen: number): string {
  const len = rng.int(maxLen + 1);
  let s = '';
  for (let i = 0; i < len; i++) s += rng.pick(LITERALS);
  return s;
}

// --- The report --------------------------------------------------------------

export interface WeightedFuzzConfig {
  seed: number;
  patterns: number;
}
export interface Failure {
  pattern: string;
  semiring: string;
  detail: string;
}
export interface WeightedFuzzReport {
  config: WeightedFuzzConfig;
  patternsTested: number;
  wordChecks: number;
  closureChecks: number;
  crossTabChecks: number;
  lawChecks: number;
  failures: Failure[];
  elapsedMs: number;
}

export const DEFAULT_WEIGHTED_FUZZ: WeightedFuzzConfig = { seed: 1, patterns: 300 };

// Per-semiring weight menus for the seeded (position-dependent) weighting.
function menuFor<K>(sr: Semiring<K>): K[] {
  switch (sr.name) {
    case Boolean2.name:
      return [true as unknown as K];
    case Counting.name:
      return [1n, 2n, 3n] as unknown as K[];
    case Tropical.name:
      return [0, 1, 2, 3] as unknown as K[];
    case Viterbi.name:
      return [0.5, 0.8, 1] as unknown as K[];
    case Probability.name:
      return [0.2, 0.4, 0.6] as unknown as K[];
    default:
      return [sr.one];
  }
}

interface Ctx {
  rng: Rng;
  failures: Failure[];
  counters: { word: number; closure: number; crossTab: number; law: number };
}

// Per-word: forward ≡ backward ≡ brute, for one semiring + weighting.
function checkWords<K>(sr: Semiring<K>, wfa: WFA<K>, words: string[], pattern: string, ctx: Ctx): void {
  for (const w of words) {
    const codes = Array.from(w, (ch) => ch.codePointAt(0)!);
    const f = wordWeightForward(wfa, sr, codes);
    const b = wordWeightBackward(wfa, sr, codes);
    const brute = bruteWordWeight(wfa, sr, codes);
    ctx.counters.word++;
    if (!sr.eq(f, b))
      ctx.failures.push({ pattern, semiring: sr.name, detail: `word "${w}": forward ${sr.show(f)} ≠ backward ${sr.show(b)}` });
    if (!brute.capped && !sr.eq(f, brute.weight))
      ctx.failures.push({
        pattern,
        semiring: sr.name,
        detail: `word "${w}": forward ${sr.show(f)} ≠ brute ${sr.show(brute.weight)}`,
      });
  }
}

// All-words closure: Lehmann ≡ iterative ≡ state-elimination ≡ brute Σ*-sum.
function checkClosure<K>(sr: Semiring<K>, wfa: WFA<K>, pattern: string, ctx: Ctx): void {
  const M = combinedMatrix(wfa, sr, ALPHABET);
  const lehmann = closureValue(wfa, sr, closureMatrixLehmann(M, sr));
  const reg = eliminateToWReg(wfa, sr);
  const regVal = evalClosure(reg, sr, ALPHABET);
  ctx.counters.closure++;
  // The algebraic identity that holds in *every* semiring: two closed-form
  // routes to λ·M*·γ — Lehmann's matrix asteration vs. state-elimination's regex.
  if (!sr.eq(lehmann, regVal))
    ctx.failures.push({ pattern, semiring: sr.name, detail: `closure: Lehmann ${sr.show(lehmann)} ≠ state-elim regex ${sr.show(regVal)}` });
  // Iterative ⊕Mᵏ — its own matrix-fixpoint flag is reliable, but for the float
  // Probability carrier a converged display still hides truncation error, so we
  // hold Lehmann to it only on the exact carriers (idempotent, or integer Counting).
  if (sr.idempotent || sr.name === Counting.name) {
    const it = closureMatrixIterative(M, sr, 80);
    if (it.converged) {
      const iter = closureValue(wfa, sr, it.sum);
      if (!sr.eq(lehmann, iter))
        ctx.failures.push({ pattern, semiring: sr.name, detail: `closure: Lehmann ${sr.show(lehmann)} ≠ iterative ${sr.show(iter)}` });
    }
  }
  // Brute Σ*-sum — only when the language is genuinely *finite* (acyclic) and
  // shallow enough that Σ^{≤L} covers every accepted word. Then the sum is the
  // complete closure in *every* semiring (no truncation, no convergence guess).
  const len = maxAcceptedLength(wfa);
  if (len !== null && len <= 6) {
    const aw = allWordsSum(wfa, sr, ALPHABET, len);
    if (!sr.eq(lehmann, aw.sum))
      ctx.failures.push({ pattern, semiring: sr.name, detail: `closure: Lehmann ${sr.show(lehmann)} ≠ brute Σ*-sum ${sr.show(aw.sum)}` });
  }
}

// Cross-tab: the Boolean and Counting readings, against other tabs' machinery.
function checkCrossTabs(
  pattern: string,
  pa: ReturnType<typeof buildGlushkov>,
  dfa: Parameters<typeof dfaAccepts>[0],
  words: string[],
  ctx: Ctx,
): void {
  const boolWfa = buildWFAFromPA(pa, Boolean2, uniformWeights(Boolean2));
  const countWfa = buildWFAFromPA(pa, Counting, uniformWeights(Counting));
  const enfa = glushkovENFA(pa);
  for (const w of words) {
    ctx.counters.crossTab++;
    // Boolean weight ⇔ the DFA accepts (an independent subset-construction road).
    const recognised = wordWeightForward(boolWfa, Boolean2, Array.from(w, (c) => c.codePointAt(0)!));
    const viaDfa = dfaAccepts(dfa, w);
    if (recognised !== viaDfa)
      ctx.failures.push({ pattern, semiring: 'Boolean×DFA', detail: `word "${w}": weight ${recognised} ≠ DFA ${viaDfa}` });
    // Counting weight ⇔ #accepting runs (the Ambiguity tab's enumerator).
    const count = wordWeightForward(countWfa, Counting, Array.from(w, (c) => c.codePointAt(0)!)) as Count;
    const runs = enumerateRuns(enfa, w, 1_000_000);
    const runsBig = BigInt(runs.length);
    if (count !== null && count !== runsBig)
      ctx.failures.push({ pattern, semiring: 'Counting×Ambiguity', detail: `word "${w}": weight ${count} ≠ runs ${runsBig}` });
  }
}

// Semiring laws — validate the carriers themselves on sampled values.
function checkLaws<K>(sr: Semiring<K>, samples: K[], ctx: Ctx): void {
  for (const a of samples)
    for (const b of samples)
      for (const c of samples) {
        ctx.counters.law++;
        const lhs = sr.times(a, sr.plus(b, c));
        const rhs = sr.plus(sr.times(a, b), sr.times(a, c));
        if (!sr.eq(lhs, rhs))
          ctx.failures.push({ pattern: '—', semiring: sr.name, detail: `left-distributivity fails at (${sr.show(a)},${sr.show(b)},${sr.show(c)})` });
      }
  // Star fixpoint: a* = 1̄ ⊕ a·a*  (a defining identity of the closure).
  for (const a of samples) {
    ctx.counters.law++;
    const sa = sr.star(a);
    const rhs = sr.plus(sr.one, sr.times(a, sa));
    // Skip the saturated/∞ case where both sides are the same infinity but float ≠ may bite.
    if (sr.isInfinite && sr.isInfinite(sa)) continue;
    if (!sr.eq(sa, rhs)) ctx.failures.push({ pattern: '—', semiring: sr.name, detail: `star fixpoint fails at ${sr.show(a)}: a*=${sr.show(sa)}, 1+a·a*=${sr.show(rhs)}` });
  }
}

function runOnePattern(pattern: string, ctx: Ctx): boolean {
  const compiled = compile(pattern);
  if (compiled.error || !compiled.dfa || (compiled.features && !compiled.features.regular)) return false;
  let pa;
  try {
    pa = buildGlushkov(compiled.ast!, 400);
  } catch {
    return false;
  }
  if (pa.m > 12) return false; // keep brute enumeration & Σ*-sums affordable

  const words: string[] = [];
  for (let i = 0; i < 8; i++) words.push(randWord(ctx.rng, 6));

  // Per-word + closure across the semiring zoo, with two weightings each.
  checkOne(Boolean2, pa, words, pattern, ctx);
  checkOne(Counting, pa, words, pattern, ctx);
  checkOne(Tropical, pa, words, pattern, ctx);
  checkOne(Viterbi, pa, words, pattern, ctx);
  checkOne(Probability, pa, words, pattern, ctx);

  checkCrossTabs(pattern, pa, compiled.dfa, words, ctx);
  return true;
}

function checkOne<K>(sr: Semiring<K>, pa: ReturnType<typeof buildGlushkov>, words: string[], pattern: string, ctx: Ctx): void {
  const uni = buildWFAFromPA(pa, sr, uniformWeights(sr));
  checkWords(sr, uni, words, pattern, ctx);
  checkClosure(sr, uni, pattern, ctx);
  const seededOf: WeightOf<K> = seededWeights(ctx.rng.int(1 << 30), menuFor(sr));
  const wgt = buildWFAFromPA(pa, sr, seededOf);
  checkWords(sr, wgt, words, pattern, ctx);
  checkClosure(sr, wgt, pattern, ctx);
}

export function runWeightedFuzz(config: WeightedFuzzConfig = DEFAULT_WEIGHTED_FUZZ): WeightedFuzzReport {
  const t0 = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  const ctx: Ctx = { rng: new Rng(config.seed), failures: [], counters: { word: 0, closure: 0, crossTab: 0, law: 0 } };

  // The semiring laws, once per run (the carriers are pattern-independent).
  checkLaws(Boolean2, [false, true], ctx);
  checkLaws(Counting, [0n, 1n, 2n, 3n] as Count[], ctx);
  checkLaws(Tropical, [0, 1, 2, Infinity], ctx);
  checkLaws(Viterbi, [0, 0.5, 0.8, 1], ctx);
  checkLaws(Probability, [0, 0.25, 0.5, 0.9], ctx);

  let patternsTested = 0;
  let attempts = 0;
  const cap = config.patterns * 4;
  while (patternsTested < config.patterns && attempts < cap) {
    attempts++;
    const pattern = genAlt(ctx.rng, 0);
    if (runOnePattern(pattern, ctx)) patternsTested++;
    if (ctx.failures.length > 40) break; // surface early, don't spew
  }

  const t1 = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  return {
    config,
    patternsTested,
    wordChecks: ctx.counters.word,
    closureChecks: ctx.counters.closure,
    crossTabChecks: ctx.counters.crossTab,
    lawChecks: ctx.counters.law,
    failures: ctx.failures,
    elapsedMs: t1 - t0,
  };
}
