// The weighted package's façade — one call the panel leans on, all the
// semiring-generic K-work sealed inside so the UI only ever sees display strings,
// a graph and a verdict. Pick a semiring, weight the pattern, and read back: the
// WFA, a word's weight three ways (forward / brute, with agreement), the all-words
// closure (Mohri's algebraic path value), and the weighted regex the automaton
// eliminates to.

import { compile } from '../compile';
import { buildGlushkov } from '../glushkov';
import {
  Boolean2,
  Counting,
  Probability,
  Tropical,
  Viterbi,
  type Count,
  type Semiring,
  type SemiringId,
  SEMIRING_MEANING,
} from './semiring';
import type { GraphInput } from '../layout';
import {
  closureMatrixLehmann,
  closureValue,
  combinedMatrix,
  maxAcceptedLength,
  wfaToGraph,
  wordWeightForward,
  type WFA,
} from './wfa';
import { bruteWordWeight } from './woracle';
import { eliminateToWReg, showWReg, wregSize } from './welim';
import {
  buildWFAFromPA,
  letterTableWeights,
  seededWeights,
  uniformWeights,
  type WeightOf,
} from './wcompile';

export type WeightMode = 'uniform' | 'letter' | 'seed';

export interface WeightSpec {
  mode: WeightMode;
  letters: Record<string, string>; // letter → weight text (for mode 'letter')
  seed: number; // for mode 'seed'
}

export interface AnalyzeOptions {
  source: string;
  semiring: SemiringId;
  alphabet: string; // working Σ, e.g. "abc"
  weights: WeightSpec;
  word: string; // the test word to weigh
}

export interface PositionWeight {
  pos: number;
  label: string;
  weight: string;
}

export interface WeightedAnalysis {
  ok: boolean;
  error?: string;
  semiringName: string;
  meaning: string;
  alphabet: string;
  states?: number;
  positions?: number;
  graph?: GraphInput;
  positionWeights?: PositionWeight[];
  // the test word
  word: string;
  wordWeight?: string;
  wordRuns?: number;
  wordBruteWeight?: string;
  wordCapped?: boolean;
  wordAgree?: boolean;
  // the all-words closure
  closureValue?: string;
  closureInfinite?: boolean;
  closureConverged?: boolean;
  closureRegex?: string;
  regexSize?: number;
}

export function parseAlphabet(s: string): number[] {
  const codes: number[] = [];
  const seen = new Set<number>();
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (!seen.has(c)) {
      seen.add(c);
      codes.push(c);
    }
  }
  return codes;
}

// --- Per-semiring weight vocabulary -----------------------------------------

interface Vocab<K> {
  sr: Semiring<K>;
  parse(text: string): K | undefined; // undefined = unparseable (∞ is a *valid* value, not an error)
  menu: K[]; // the seeded-mode menu
  defaults: Record<string, string>; // sensible per-letter defaults for 'letter' mode
}

const boolVocab: Vocab<boolean> = {
  sr: Boolean2,
  parse: (t) => {
    const s = t.trim().toLowerCase();
    if (s === '1' || s === 'true' || s === '⊤' || s === 't') return true;
    if (s === '0' || s === 'false' || s === '⊥' || s === 'f') return false;
    return undefined;
  },
  menu: [true],
  defaults: { a: '1', b: '1', c: '1' },
};
const countVocab: Vocab<Count> = {
  sr: Counting,
  parse: (t) => {
    const s = t.trim();
    if (s === '∞' || s.toLowerCase() === 'inf') return null; // ∞ is a legitimate count
    if (!/^\d+$/.test(s)) return undefined;
    return BigInt(s);
  },
  menu: [1n, 2n, 3n],
  defaults: { a: '1', b: '2', c: '1' },
};
const tropVocab: Vocab<number> = {
  sr: Tropical,
  parse: (t) => {
    const s = t.trim();
    if (s === '∞' || s.toLowerCase() === 'inf') return Infinity;
    const v = Number(s);
    return Number.isFinite(v) && v >= 0 ? v : undefined;
  },
  menu: [0, 1, 2, 3],
  defaults: { a: '1', b: '2', c: '3' },
};
const vitVocab: Vocab<number> = {
  sr: Viterbi,
  parse: (t) => {
    const v = Number(t.trim());
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : undefined;
  },
  menu: [0.5, 0.8, 1],
  defaults: { a: '0.9', b: '0.6', c: '0.3' },
};
const probVocab: Vocab<number> = {
  sr: Probability,
  parse: (t) => {
    const v = Number(t.trim());
    return Number.isFinite(v) && v >= 0 ? v : undefined;
  },
  menu: [0.2, 0.4, 0.6],
  defaults: { a: '0.5', b: '0.3', c: '0.2' },
};

function vocabFor(id: SemiringId): Vocab<unknown> {
  switch (id) {
    case 'boolean':
      return boolVocab as Vocab<unknown>;
    case 'counting':
      return countVocab as Vocab<unknown>;
    case 'tropical':
      return tropVocab as Vocab<unknown>;
    case 'viterbi':
      return vitVocab as Vocab<unknown>;
    case 'probability':
      return probVocab as Vocab<unknown>;
  }
}

export function defaultWeightsFor(id: SemiringId): Record<string, string> {
  return { ...vocabFor(id).defaults };
}

// --- The semiring-generic core ----------------------------------------------

function weightOfFor<K>(v: Vocab<K>, spec: WeightSpec): WeightOf<K> {
  if (spec.mode === 'uniform') return uniformWeights(v.sr);
  if (spec.mode === 'seed') return seededWeights(spec.seed | 0, v.menu);
  // 'letter' — a code-keyed table parsed per semiring, falling back to 1̄.
  const table = new Map<number, K>();
  for (const [ch, text] of Object.entries(spec.letters)) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    const parsed = v.parse(text);
    if (parsed !== undefined) table.set(code, parsed as K);
  }
  return letterTableWeights(table, v.sr.one);
}

function analyzeCore<K>(
  v: Vocab<K>,
  ast: Parameters<typeof buildGlushkov>[0],
  alphabet: number[],
  spec: WeightSpec,
  word: string,
  base: WeightedAnalysis,
): WeightedAnalysis {
  const sr = v.sr;
  const pa = buildGlushkov(ast, 600);
  const weightOf = weightOfFor(v, spec);
  const wfa: WFA<K> = buildWFAFromPA(pa, sr, weightOf);

  const positionWeights: PositionWeight[] = [];
  for (let p = 1; p < wfa.n; p++)
    positionWeights.push({ pos: p, label: wfa.positions[p].label(), weight: sr.show(wfa.weights[p]) });

  const codes = Array.from(word, (ch) => ch.codePointAt(0)!);
  const fwd = wordWeightForward(wfa, sr, codes);
  const brute = bruteWordWeight(wfa, sr, codes);

  const M = combinedMatrix(wfa, sr, alphabet);
  const clos = closureValue(wfa, sr, closureMatrixLehmann(M, sr));
  const reg = eliminateToWReg(wfa, sr);
  const finiteLen = maxAcceptedLength(wfa); // null ⇒ an accepting cycle ⇒ infinite language

  return {
    ...base,
    ok: true,
    states: wfa.n,
    positions: pa.m,
    graph: wfaToGraph(wfa, sr),
    positionWeights,
    wordWeight: sr.show(fwd),
    wordRuns: brute.runs,
    wordBruteWeight: sr.show(brute.weight),
    wordCapped: brute.capped,
    wordAgree: brute.capped ? undefined : sr.eq(fwd, brute.weight),
    closureValue: sr.show(clos),
    closureInfinite: sr.isInfinite ? sr.isInfinite(clos) : false,
    closureConverged: finiteLen !== null,
    closureRegex: showWReg(reg, sr),
    regexSize: wregSize(reg),
  };
}

export function analyzeWeighted(opts: AnalyzeOptions): WeightedAnalysis {
  const v = vocabFor(opts.semiring);
  const alphabet = parseAlphabet(opts.alphabet || 'abc');
  const base: WeightedAnalysis = {
    ok: false,
    semiringName: v.sr.name,
    meaning: SEMIRING_MEANING[opts.semiring],
    alphabet: opts.alphabet || 'abc',
    word: opts.word,
  };

  const compiled = compile(opts.source);
  if (compiled.error) return { ...base, error: `parse error at ${compiled.error.index}: ${compiled.error.message}` };
  if (!compiled.ast) return { ...base, error: 'empty pattern' };
  if (compiled.features && !compiled.features.regular)
    return { ...base, error: `weighted automata need a regular pattern — this one uses ${compiled.features.reasons.join(', ')}` };

  try {
    return analyzeCore(v, compiled.ast, alphabet, opts.weights, opts.word, base);
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

// A tiny curated gallery — each line a one-click demo of a different reading.
export interface WeightedExample {
  source: string;
  semiring: SemiringId;
  weights: WeightSpec;
  word: string;
  blurb: string;
}

const L = (letters: Record<string, string>): WeightSpec => ({ mode: 'letter', letters, seed: 1 });
const U: WeightSpec = { mode: 'uniform', letters: {}, seed: 1 };

export const WEIGHTED_EXAMPLES: WeightedExample[] = [
  { source: '(a|b)*abb', semiring: 'counting', weights: U, word: 'ababb', blurb: 'how many ways does the word parse? — ambiguity = the Counting weight' },
  { source: '(a|a)(b|b)', semiring: 'counting', weights: U, word: 'ab', blurb: 'a deliberately ambiguous pattern: 4 distinct accepting runs' },
  { source: 'a*b*', semiring: 'tropical', weights: L({ a: '1', b: '2' }), word: 'aabbb', blurb: 'cheapest spelling — Tropical (min,+) is shortest distance' },
  { source: '(a|b|c)+', semiring: 'viterbi', weights: L({ a: '0.9', b: '0.6', c: '0.3' }), word: 'aac', blurb: 'the most-likely run — Viterbi (max,×), an HMM in miniature' },
  { source: '(ab|ba)*', semiring: 'probability', weights: L({ a: '0.5', b: '0.5' }), word: 'abba', blurb: 'total mass over runs — Probability (+,×)' },
  { source: '[ab]*c', semiring: 'boolean', weights: U, word: 'abac', blurb: 'plain recognition — the Boolean (∨,∧) weighted automaton is the DFA' },
];
