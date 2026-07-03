// The proof console for the **regex → AFA** road (`build.ts`) and the two
// deciders (`decide.ts`). Same house style as `verify.ts`: a seeded fuzzer draws
// random *extended* regular expressions and confronts the built AFA with three
// independent authorities, on every word up to a horizon.
//
//  1. ORACLE — `ereg`'s span oracle `acceptsOracle` decides membership straight
//     from the algebraic definition (`ends(A&B)=ends A ∩ ends B`,
//     `ends(~A)=complement`), touching neither derivatives nor the AFA. The built
//     AFA's brute-force alternating semantics must agree with it word for word.
//  2. DETERMINISED — the AFA→NFA→DFA→min pipeline must accept the same language,
//     so the alternating machine and its flattening agree.
//  3. DECIDERS — the antichain emptiness/universality verdicts on the AFA must
//     match the determinised DFA's own emptiness/universality (computed by direct
//     reachability), and every witness word must really be (non-)accepted.
//
// Reproducible by seed; the first disagreement is surfaced as regex source.

import { eregToAFA } from './build';
import { afaEmptiness, afaUniversality } from './decide';
import { afaAccepts } from './afa';
import {
  type EReg,
  mkCat,
  mkAlt,
  mkStar,
  mkAnd,
  mkNot,
  showE,
  acceptsOracle,
  EPS,
  EMP,
} from '../ereg';
import { CharSet } from '../charset';
import { buildDFA, atomIndexFor, type DFA } from '../dfa';
import { minimizeDFA } from '../minimize';
import { dfaAccepts } from '../simulate';
import { afaToNFA } from './afa';

// ── seeded PRNG (mulberry32) ─────────────────────────────────────────────────
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

// ── random extended regular expressions over {a, b} ──────────────────────────
const SET_A = CharSet.fromChar(0x61);
const SET_B = CharSet.fromChar(0x62);
const SET_AB = CharSet.union([SET_A, SET_B]); // the "." over {a,b}

function genEReg(rnd: () => number, depth: number): EReg {
  if (depth <= 0 || rnd() < 0.34) {
    const r = rnd();
    if (r < 0.12) return EPS;
    if (r < 0.16) return EMP;
    if (r < 0.44) return { k: 'chr', set: SET_A };
    if (r < 0.72) return { k: 'chr', set: SET_B };
    return { k: 'chr', set: SET_AB };
  }
  const r = rnd();
  if (r < 0.3) return mkCat(genEReg(rnd, depth - 1), genEReg(rnd, depth - 1));
  if (r < 0.5) return mkAlt(genEReg(rnd, depth - 1), genEReg(rnd, depth - 1));
  if (r < 0.66) return mkStar(genEReg(rnd, depth - 1));
  if (r < 0.83) return mkAnd(genEReg(rnd, depth - 1), genEReg(rnd, depth - 1));
  return mkNot(genEReg(rnd, depth - 1));
}

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

// ── determinised deciders (the independent authority for emptiness/univ.) ─────
function reachableAcceptingDFA(dfa: DFA): boolean {
  const seen = new Set<number>([dfa.start]);
  const stack = [dfa.start];
  while (stack.length) {
    const s = stack.pop()!;
    if (dfa.states[s]?.accept) return true;
    for (let a = 0; a < dfa.atoms.length; a++) {
      const to = dfa.table[s][a];
      if (to >= 0 && !seen.has(to)) {
        seen.add(to);
        stack.push(to);
      }
    }
  }
  return false;
}

// Universal over exactly `symbols`: every reachable state accepting AND total on
// every symbol (a missing transition is a reject, hence non-universal).
function universalDFAoverSymbols(dfa: DFA, symbols: string[]): boolean {
  const codes = symbols.map((s) => s.codePointAt(0) ?? 0);
  const seen = new Set<number>([dfa.start]);
  const stack = [dfa.start];
  while (stack.length) {
    const s = stack.pop()!;
    if (!dfa.states[s]?.accept) return false;
    for (const c of codes) {
      const ai = atomIndexFor(dfa.atoms, c);
      const to = ai < 0 ? -1 : dfa.table[s][ai];
      if (to < 0) return false;
      if (!seen.has(to)) {
        seen.add(to);
        stack.push(to);
      }
    }
  }
  return true;
}

export interface RegexAfaFuzzConfig {
  seed: number;
  trials: number;
  maxLen: number;
}

export const DEFAULT_REGEX_AFA_FUZZ: RegexAfaFuzzConfig = { seed: 0xa17e2, trials: 250, maxLen: 5 };

export interface RegexAfaFuzzReport {
  ok: boolean;
  trials: number;
  membershipChecks: number;
  determinisedChecks: number;
  deciderChecks: number;
  maxBlowup: number; // largest (min-DFA states / AFA states) — succinctness, live
  maxSaving: number; // largest (naive macrostates / antichain explored) in a decider
  fallbacks: number; // patterns that needed the non-linear DFA lift
  skipped: number; // too large to determinise / decide
  elapsedMs: number;
  failure: { kind: string; source: string; detail: string } | null;
}

export function runRegexAfaFuzz(cfg: RegexAfaFuzzConfig = DEFAULT_REGEX_AFA_FUZZ): RegexAfaFuzzReport {
  const t0 = now();
  const rnd = mulberry32(cfg.seed);
  let membershipChecks = 0;
  let determinisedChecks = 0;
  let deciderChecks = 0;
  let maxBlowup = 1;
  let maxSaving = 1;
  let fallbacks = 0;
  let skipped = 0;

  const fail = (kind: string, ereg: EReg, detail: string): RegexAfaFuzzReport => ({
    ok: false,
    trials: cfg.trials,
    membershipChecks,
    determinisedChecks,
    deciderChecks,
    maxBlowup,
    maxSaving,
    fallbacks,
    skipped,
    elapsedMs: now() - t0,
    failure: { kind, source: showE(ereg), detail },
  });

  for (let t = 0; t < cfg.trials; t++) {
    const ereg = genEReg(rnd, 3);
    const built = eregToAFA(ereg);
    const afa = built.afa;
    if (built.usedFallback) fallbacks++;
    if (afa.n > 20) {
      skipped++;
      continue;
    }
    const symbols = afa.symbols;
    const words = allWords(symbols, cfg.maxLen);

    // 1. ORACLE — the AFA's alternating semantics vs ereg's span oracle.
    const oracle = words.map((w) => acceptsOracle(ereg, [...w].map((c) => c.codePointAt(0)!)));
    for (let i = 0; i < words.length; i++) {
      membershipChecks++;
      const idx = [...words[i]].map((c) => symbols.indexOf(c));
      if (afaAccepts(afa, idx) !== oracle[i])
        return fail('membership', ereg, `word "${words[i] || 'ε'}": AFA=${afaAccepts(afa, idx)} oracle=${oracle[i]} — Σ={${symbols.join(' ')}}`);
    }

    // 2. DETERMINISED — the AFA→NFA→DFA→min pipeline vs the same oracle.
    const built2 = afaToNFA(afa);
    let dfa: DFA | null = null;
    if (!built2.truncated) {
      dfa = minimizeDFA(buildDFA(built2.nfa));
      for (let i = 0; i < words.length; i++) {
        determinisedChecks++;
        if (dfaAccepts(dfa, words[i]) !== oracle[i])
          return fail('determinised', ereg, `word "${words[i] || 'ε'}": DFA=${dfaAccepts(dfa, words[i])} oracle=${oracle[i]}`);
      }
      if (dfa.states.length / afa.n > maxBlowup) maxBlowup = dfa.states.length / afa.n;
    }

    // 3. DECIDERS — antichain emptiness/universality vs the determinised DFA.
    if (dfa) {
      const emp = afaEmptiness(afa);
      const uni = afaUniversality(afa);
      if (emp.decided) {
        deciderChecks++;
        const dfaEmpty = !reachableAcceptingDFA(dfa);
        if (emp.empty !== dfaEmpty)
          return fail('emptiness', ereg, `antichain empty=${emp.empty} but DFA empty=${dfaEmpty}`);
        if (!emp.empty && emp.witness !== null) {
          const w = emp.witness;
          if (!acceptsOracle(ereg, [...w].map((c) => c.codePointAt(0)!)))
            return fail('emptiness-witness', ereg, `witness "${w || 'ε'}" is NOT in the language`);
        }
        if (emp.naiveExplored && emp.naiveExplored / Math.max(1, emp.explored) > maxSaving)
          maxSaving = emp.naiveExplored / Math.max(1, emp.explored);
      }
      if (uni.decided) {
        deciderChecks++;
        const dfaUniv = universalDFAoverSymbols(dfa, symbols);
        if (uni.universal !== dfaUniv)
          return fail('universality', ereg, `antichain universal=${uni.universal} but DFA universal=${dfaUniv}`);
        if (!uni.universal && uni.witness !== null) {
          const w = uni.witness;
          if (acceptsOracle(ereg, [...w].map((c) => c.codePointAt(0)!)))
            return fail('universality-witness', ereg, `rejected-witness "${w || 'ε'}" IS in the language`);
        }
      }
    }
  }

  return {
    ok: true,
    trials: cfg.trials,
    membershipChecks,
    determinisedChecks,
    deciderChecks,
    maxBlowup,
    maxSaving,
    fallbacks,
    skipped,
    elapsedMs: now() - t0,
    failure: null,
  };
}

function now(): number {
  try {
    return performance.now();
  } catch {
    return 0;
  }
}
