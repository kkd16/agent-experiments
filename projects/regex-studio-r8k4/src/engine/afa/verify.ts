// The proof console — the house style. A seeded fuzzer draws random alternating
// automata and checks, differentially against the brute-force alternating
// semantics (`afaAccepts`, the oracle), that:
//
//  1. DIFFERENTIAL — the AFA→NFA→DFA→min pipeline accepts exactly the words the
//     oracle says the AFA accepts, on *every* word up to length L.
//  2. COMPLEMENT — dualising the AFA (∧↔∨, flip F) recognises exactly the
//     complement of the oracle's language. Alternation complements for free.
//  3. CLOSURE — the ∧/∨ combination of two AFAs over their disjoint union
//     recognises the intersection/union of their languages, again vs the oracle.
//
// Reproducible by seed; the first counterexample is surfaced verbatim as source.

import {
  afaAccepts,
  afaToNFA,
  complementAFA,
  intersectAFA,
  unionAFA,
  bfAnd,
  bfOr,
  bfVar,
  BF_TRUE,
  BF_FALSE,
  type AFA,
  type BF,
} from './afa';
import { afaToSource } from './parse';
import { buildDFA } from '../dfa';
import { minimizeDFA } from '../minimize';
import { dfaAccepts } from '../simulate';
import { dfaToRegex } from '../synthesize';
import type { DFA } from '../dfa';

// ── a seeded PRNG (mulberry32) ───────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── random positive boolean formulas + AFAs ──────────────────────────────────
function genBF(rnd: () => number, n: number, depth: number): BF {
  if (depth <= 0 || rnd() < 0.42) {
    const r = rnd();
    if (r < 0.12) return BF_TRUE;
    if (r < 0.24) return BF_FALSE;
    return bfVar(Math.floor(rnd() * n));
  }
  const a = genBF(rnd, n, depth - 1);
  const b = genBF(rnd, n, depth - 1);
  return rnd() < 0.5 ? bfAnd(a, b) : bfOr(a, b);
}

function genAFA(rnd: () => number, symbols: string[]): AFA {
  const n = 1 + Math.floor(rnd() * 4); // 1..4 states
  const names = Array.from({ length: n }, (_, i) => `q${i}`);
  const delta: BF[][] = Array.from({ length: n }, () => symbols.map(() => genBF(rnd, n, 2)));
  const init = genBF(rnd, n, 2);
  const final = Array.from({ length: n }, () => rnd() < 0.45);
  return { n, names, symbols, init, delta, final };
}

// Every word up to `maxLen` over the alphabet.
function allWords(symbols: string[], maxLen: number): string[] {
  const out: string[] = [''];
  let frontier = [''];
  for (let len = 1; len <= maxLen; len++) {
    const next: string[] = [];
    for (const w of frontier) for (const s of symbols) next.push(w + s);
    out.push(...next);
    frontier = next;
  }
  return out;
}

export interface AfaFuzzConfig {
  seed: number;
  trials: number;
  maxLen: number;
}

export const DEFAULT_AFA_FUZZ: AfaFuzzConfig = { seed: 0x5eed, trials: 200, maxLen: 5 };

export interface AfaFuzzReport {
  ok: boolean;
  trials: number;
  membershipChecks: number;
  complementChecks: number;
  closureChecks: number;
  maxBlowup: number; // largest (min-DFA states / AFA states) ratio seen — alternation's succinctness, live
  skipped: number;
  elapsedMs: number;
  failure: { kind: 'membership' | 'complement' | 'closure'; source: string; detail: string } | null;
}

/** Build the AFA all the way to a minimised DFA. Returns null if it blew past the cap. */
function pipeline(afa: AFA): DFA | null {
  const built = afaToNFA(afa);
  if (built.truncated) return null;
  return minimizeDFA(buildDFA(built.nfa));
}

export function runAfaFuzz(cfg: AfaFuzzConfig = DEFAULT_AFA_FUZZ): AfaFuzzReport {
  const t0 = now();
  const rnd = mulberry32(cfg.seed);
  const symbols = ['a', 'b'];
  const words = allWords(symbols, cfg.maxLen);
  let membershipChecks = 0;
  let complementChecks = 0;
  let closureChecks = 0;
  let skipped = 0;
  let maxBlowup = 1;

  const wordIdx = words.map((w) => [...w].map((c) => symbols.indexOf(c)));

  for (let t = 0; t < cfg.trials; t++) {
    const A = genAFA(rnd, symbols);
    const dfaA = pipeline(A);
    if (!dfaA) {
      skipped++;
      continue;
    }
    const oracleA = wordIdx.map((idx) => afaAccepts(A, idx));

    // 1. differential
    for (let i = 0; i < words.length; i++) {
      membershipChecks++;
      if (dfaAccepts(dfaA, words[i]) !== oracleA[i]) {
        return fail('membership', A, `word "${words[i] || 'ε'}": oracle=${oracleA[i]} dfa=${!oracleA[i]}`, t0, {
          membershipChecks,
          complementChecks,
          closureChecks,
          skipped,
          maxBlowup,
          trials: cfg.trials,
        });
      }
    }
    if (dfaA.states.length / A.n > maxBlowup) maxBlowup = dfaA.states.length / A.n;

    // 2. complement (checked directly against the oracle — no DFA needed)
    const notA = complementAFA(A);
    for (let i = 0; i < words.length; i++) {
      complementChecks++;
      if (afaAccepts(notA, wordIdx[i]) !== !oracleA[i]) {
        return fail('complement', notA, `word "${words[i] || 'ε'}": dual=${afaAccepts(notA, wordIdx[i])} expected=${!oracleA[i]}`, t0, {
          membershipChecks,
          complementChecks,
          closureChecks,
          skipped,
          maxBlowup,
          trials: cfg.trials,
        });
      }
    }

    // 3. closure — ∧ / ∨ against a second AFA
    const B = genAFA(rnd, symbols);
    const oracleB = wordIdx.map((idx) => afaAccepts(B, idx));
    const inter = intersectAFA(A, B);
    const uni = unionAFA(A, B);
    for (let i = 0; i < words.length; i++) {
      closureChecks += 2;
      if (afaAccepts(inter, wordIdx[i]) !== (oracleA[i] && oracleB[i])) {
        return fail('closure', inter, `∩ on "${words[i] || 'ε'}": got=${afaAccepts(inter, wordIdx[i])} expected=${oracleA[i] && oracleB[i]}`, t0, {
          membershipChecks,
          complementChecks,
          closureChecks,
          skipped,
          maxBlowup,
          trials: cfg.trials,
        });
      }
      if (afaAccepts(uni, wordIdx[i]) !== (oracleA[i] || oracleB[i])) {
        return fail('closure', uni, `∪ on "${words[i] || 'ε'}": got=${afaAccepts(uni, wordIdx[i])} expected=${oracleA[i] || oracleB[i]}`, t0, {
          membershipChecks,
          complementChecks,
          closureChecks,
          skipped,
          maxBlowup,
          trials: cfg.trials,
        });
      }
    }
  }

  return {
    ok: true,
    trials: cfg.trials,
    membershipChecks,
    complementChecks,
    closureChecks,
    maxBlowup,
    skipped,
    elapsedMs: now() - t0,
    failure: null,
  };
}

function fail(
  kind: 'membership' | 'complement' | 'closure',
  afa: AFA,
  detail: string,
  t0: number,
  acc: { membershipChecks: number; complementChecks: number; closureChecks: number; skipped: number; maxBlowup: number; trials: number },
): AfaFuzzReport {
  return {
    ok: false,
    trials: acc.trials,
    membershipChecks: acc.membershipChecks,
    complementChecks: acc.complementChecks,
    closureChecks: acc.closureChecks,
    maxBlowup: acc.maxBlowup,
    skipped: acc.skipped,
    elapsedMs: now() - t0,
    failure: { kind, source: afaToSource(afa), detail },
  };
}

function now(): number {
  try {
    return performance.now();
  } catch {
    return 0;
  }
}

// ── Per-AFA analysis for the panel: build the machines, cross-check, read the
//    language back as a regex. ─────────────────────────────────────────────────

export interface AfaAnalysis {
  states: number;
  nfaStates: number; // macrostates + fresh start/accept
  dfaStates: number;
  minStates: number;
  truncated: boolean;
  regex: string; // the language read back off the minimal DFA (Kleene / state elimination)
  empty: boolean;
  epsilonOnly: boolean;
  agree: boolean; // oracle ≡ min-DFA on every word up to maxLen
  maxLen: number;
  rows: { word: string; accept: boolean }[];
  minDfa: DFA | null; // the minimised DFA, for the graph view (null if truncated)
}

export function analyzeAFA(afa: AFA, maxLen = 6): AfaAnalysis | null {
  if (afa.n > 16) return null;
  const built = afaToNFA(afa);
  if (built.truncated) {
    return {
      states: afa.n,
      nfaStates: built.nfa.stateCount,
      dfaStates: 0,
      minStates: 0,
      truncated: true,
      regex: '',
      empty: false,
      epsilonOnly: false,
      agree: false,
      maxLen,
      rows: [],
      minDfa: null,
    };
  }
  const dfa = buildDFA(built.nfa);
  const min = minimizeDFA(dfa);
  const synth = dfaToRegex(min);

  // Oracle vs min-DFA on every word up to maxLen (bounded so it always renders).
  const sigma = afa.symbols.length;
  let m = maxLen;
  while (m > 1 && geomCount(sigma, m) > 120) m--;
  const words = allWords(afa.symbols, m);
  let agree = true;
  const rows = words.map((w) => {
    const idx = [...w].map((c) => afa.symbols.indexOf(c));
    const oracle = afaAccepts(afa, idx);
    if (dfaAccepts(min, w) !== oracle) agree = false;
    return { word: w, accept: oracle };
  });

  return {
    states: afa.n,
    nfaStates: built.nfa.stateCount,
    dfaStates: dfa.states.length,
    minStates: min.states.length,
    truncated: false,
    regex: synth.regex,
    empty: synth.empty,
    epsilonOnly: synth.epsilonOnly,
    agree,
    maxLen: m,
    rows,
    minDfa: min,
  };
}

function geomCount(sigma: number, maxLen: number): number {
  if (sigma <= 1) return maxLen + 1;
  return (Math.pow(sigma, maxLen + 1) - 1) / (sigma - 1);
}
