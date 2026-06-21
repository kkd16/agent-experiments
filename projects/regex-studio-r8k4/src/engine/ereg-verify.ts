// Proving the Boolean-derivative engine the studio's way: live algebraic-law
// badges plus a seeded differential fuzzer.
//
// Two kinds of evidence:
//   1. **Algebraic laws** on the user's own pattern — involution (~~A ≡ A),
//      idempotence (A & A ≡ A), and the complement laws (A ∪ ~A ≡ Σ*,
//      A ∩ ~A ≡ ∅) — each decided by determinising both sides and running the
//      product-automaton equivalence check.
//   2. A **classical cross-check** — rebuild the same extended language with the
//      *classic* automata pipeline (Thompson→subset→Moore for the regular cores,
//      product/complement DFA for the Boolean operators) and prove it equal to
//      the Boolean-derivative DFA. The two share no code on the Boolean side.
//   3. A **three-engine differential fuzzer** — streaming derivative vs derivative
//      DFA vs the span oracle `ends`, over random expressions and strings.

import { analyzeFeatures, type RegexNode } from './ast';
import { CharSet } from './charset';
import { compareDFAs } from './equivalence';
import { buildDFA, atomIndexFor, type DFA } from './dfa';
import { buildNFA } from './nfa';
import { minimizeDFA } from './minimize';
import { complementDFA, productDFA } from './booldfa';
import {
  acceptsCodesE,
  acceptsOracle,
  buildEregDFA,
  EMP,
  type EReg,
  fromAstE,
  mkAlt,
  mkAnd,
  showE,
  TOP,
} from './ereg';

// --- shared helpers ---------------------------------------------------------

function minE(d: EReg): DFA {
  return minimizeDFA(buildEregDFA(d));
}

function equal(a: DFA, b: DFA): boolean {
  return compareDFAs(a, b).relation === 'equal';
}

// Run a (possibly complete) derivative DFA over a code sequence.
export function runEregDFA(dfa: DFA, codes: number[]): boolean {
  let s = dfa.start;
  for (const c of codes) {
    const idx = atomIndexFor(dfa.atoms, c);
    s = idx < 0 ? -1 : dfa.table[s][idx];
    if (s < 0) return false;
  }
  return dfa.states[s].accept;
}

// --- the classical reconstruction -------------------------------------------
// Rebuild the extended language using the classic pipeline + Boolean DFA ops.
// Returns null when a Boolean operator sits *inside* a core combinator (e.g.
// `(a & b)*`), which has no classic DFA recipe — those rely on the laws + fuzzer.

export function tryClassicalDFA(node: RegexNode): DFA | null {
  if (node.type === 'intersect') {
    const parts = node.parts.map(tryClassicalDFA);
    if (parts.some((p) => p === null)) return null;
    return (parts as DFA[]).reduce((a, b) => productDFA(a, b, 'and'));
  }
  if (node.type === 'complement') {
    const inner = tryClassicalDFA(node.node);
    return inner ? complementDFA(inner) : null;
  }
  // A regular core: build it the classic way. Anything non-regular (anchors,
  // backrefs, …) or with a Boolean op nested inside it has no recipe here.
  return analyzeFeatures(node).regular ? minimizeDFA(buildDFA(buildNFA(node))) : null;
}

export interface Law {
  name: string;
  formula: string;
  ok: boolean | null; // null = not applicable to this pattern
  detail: string;
}

export function verifyExtended(ast: RegexNode): Law[] {
  const laws: Law[] = [];
  let d: EReg;
  try {
    d = fromAstE(ast);
  } catch {
    return laws;
  }
  const base = minE(d);

  // Involution — built from a *raw* double complement so it exercises the
  // engine's derivative rules, not just the smart constructor.
  const rawNotNot: EReg = { k: 'not', a: { k: 'not', a: d } };
  laws.push({
    name: 'Double complement (involution)',
    formula: '~~A ≡ A',
    ok: equal(minE(rawNotNot), base),
    detail: 'complementing twice returns the original language',
  });

  // Idempotence — again raw, so derivativeE actually intersects two copies.
  const rawAnd: EReg = { k: 'and', ts: [d, d] };
  laws.push({
    name: 'Idempotent intersection',
    formula: 'A & A ≡ A',
    ok: equal(minE(rawAnd), base),
    detail: 'a language intersected with itself is unchanged',
  });

  // Complement laws — the load-bearing ones.
  laws.push({
    name: 'Excluded middle',
    formula: 'A ∪ ~A ≡ Σ*',
    ok: equal(minE(mkAlt(d, { k: 'not', a: d })), minE(TOP)),
    detail: 'every string is in A or its complement',
  });
  laws.push({
    name: 'Non-contradiction',
    formula: 'A ∩ ~A ≡ ∅',
    ok: equal(minE(mkAnd(d, { k: 'not', a: d })), minE(EMP)),
    detail: 'no string is in both A and its complement',
  });

  // The classical cross-check, when the pattern's shape admits one.
  const cls = tryClassicalDFA(ast);
  if (cls) {
    const shape =
      ast.type === 'intersect'
        ? 'A & B ≡ product(DFA A, DFA B)'
        : ast.type === 'complement'
          ? '~A ≡ complement(DFA A)'
          : 'Boolean engine ≡ classic DFA';
    laws.push({
      name: 'Classical cross-check',
      formula: shape,
      ok: equal(base, minimizeDFA(cls)),
      detail: 'the Boolean-derivative DFA equals the classic product/complement automaton',
    });
  } else {
    laws.push({
      name: 'Classical cross-check',
      formula: '—',
      ok: null,
      detail: 'a Boolean operator is nested inside a core combinator — covered by the laws and the fuzzer',
    });
  }

  return laws;
}

// --- the differential fuzzer ------------------------------------------------

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

const ALPHA = [97, 98, 99]; // a b c — the symbols expressions are built from

function randExpr(rng: () => number, depth: number): EReg {
  if (depth <= 0 || rng() < 0.32) {
    const r = rng();
    if (r < 0.15) return { k: 'eps' };
    if (r < 0.25) return { k: 'emp' };
    // a random non-empty subset of the alphabet
    const chosen = ALPHA.filter(() => rng() < 0.5);
    const codes = chosen.length ? chosen : [ALPHA[(rng() * ALPHA.length) | 0]];
    const sets = codes.map((c) => ({ lo: c, hi: c }));
    return { k: 'chr', set: importRanges(sets) };
  }
  const pick = rng();
  if (pick < 0.22) return mkCatN(randExpr(rng, depth - 1), randExpr(rng, depth - 1));
  if (pick < 0.42) return mkAltN(randExpr(rng, depth - 1), randExpr(rng, depth - 1));
  if (pick < 0.58) return starN(randExpr(rng, depth - 1));
  if (pick < 0.78) return mkAnd(randExpr(rng, depth - 1), randExpr(rng, depth - 1));
  return { k: 'not', a: randExpr(rng, depth - 1) };
}

// Tiny local builders so the fuzzer keeps raw shapes for `&`/`*`/`cat`.
function importRanges(rs: { lo: number; hi: number }[]): CharSet {
  return CharSet.fromRanges(rs);
}
function mkCatN(a: EReg, b: EReg): EReg {
  return { k: 'cat', a, b };
}
function mkAltN(a: EReg, b: EReg): EReg {
  return mkAlt(a, b);
}
function starN(a: EReg): EReg {
  if (a.k === 'emp' || a.k === 'eps') return { k: 'eps' };
  return { k: 'star', a };
}

export interface FuzzCounterexample {
  pattern: string;
  input: string;
  oracle: boolean;
  streaming: boolean;
  dfa: boolean;
}

export interface FuzzResult {
  patterns: number;
  strings: number;
  checks: number;
  disagreements: number;
  skipped: number; // expressions whose DFA hit the cap (not counted)
  ms: number;
  counterexample: FuzzCounterexample | null;
}

export function fuzzExtended(opts: { seed?: number; patterns?: number; strings?: number } = {}): FuzzResult {
  const seed = opts.seed ?? 0x1234;
  const patterns = opts.patterns ?? 400;
  const stringsPer = opts.strings ?? 24;
  const rng = mulberry32(seed);
  const t0 = performance.now();

  // Strings draw from the alphabet plus one out-of-alphabet symbol 'd' (100), so
  // complement's "every other character" transitions are exercised.
  const sampleAlpha = [...ALPHA, 100];
  const randString = (): number[] => {
    const len = (rng() * 7) | 0;
    const out: number[] = [];
    for (let i = 0; i < len; i++) out.push(sampleAlpha[(rng() * sampleAlpha.length) | 0]);
    return out;
  };

  let checks = 0;
  let disagreements = 0;
  let skipped = 0;
  let counterexample: FuzzCounterexample | null = null;

  for (let p = 0; p < patterns; p++) {
    const d = randExpr(rng, 4);
    const dfa = buildEregDFA(d, 1500, 3000);
    if (dfa.truncated) {
      skipped++;
      continue;
    }
    for (let s = 0; s < stringsPer; s++) {
      const codes = randString();
      const oracle = acceptsOracle(d, codes);
      const streaming = acceptsCodesE(d, codes);
      const dfaAcc = runEregDFA(dfa, codes);
      checks++;
      if (oracle !== streaming || oracle !== dfaAcc) {
        disagreements++;
        if (!counterexample) {
          counterexample = {
            pattern: showE(d),
            input: codes.map((c) => String.fromCodePoint(c)).join('') || 'ε',
            oracle,
            streaming,
            dfa: dfaAcc,
          };
        }
      }
    }
  }

  return {
    patterns,
    strings: stringsPer,
    checks,
    disagreements,
    skipped,
    ms: performance.now() - t0,
    counterexample,
  };
}
