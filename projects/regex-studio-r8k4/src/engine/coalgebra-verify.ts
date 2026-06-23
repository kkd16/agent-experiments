// Earning the coalgebra & antichain roads — differential verification.
//
// Two new decision procedures (`coalgebra.ts`, `antichain.ts`) claim the same
// verdicts as the studio's established product-of-minimal-DFAs road
// (`equivalence.ts`). "Claim" isn't "proven", so this module pits them against
// it on thousands of random pattern *pairs* drawn from a seeded PRNG. For each
// pair we check, all from independent code paths:
//
//   1. the three HKC modes (naïve / up-to-equivalence / up-to-congruence) all
//      agree with each other on equivalence, and with `compareDFAs`;
//   2. the antichain inclusion both ways reconstructs the *same 5-way relation*
//      (equal / subset / superset / disjoint / overlap) as `compareDFAs`;
//   3. antichain universality agrees with "the minimal DFA is a single
//      accepting state with all self-loops" (the DFA-side universality test);
//   4. and — the technique's whole point — HKC never explores more pairs than
//      naïve Hopcroft–Karp.
//
// Any single mismatch is a real bug, surfaced with the exact pattern pair.
// Because the PRNG is seeded, every run reproduces exactly.

import { compile } from './compile';
import { compareDFAs, type Relation } from './equivalence';
import { runEquivalence } from './coalgebra';
import { relationByAntichains, decideUniversality } from './antichain';
import type { DFA } from './dfa';
import type { NFA } from './nfa';

// --- Seeded PRNG (mulberry32) — same family the differential fuzzer uses -----

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
  constructor(next: () => number) {
    this.next = next;
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

// --- Random pattern generation (a tiny, two-letter alphabet) -----------------
//
// A deliberately *small* alphabet (a, b) and shallow trees keep the determinised
// DFAs small enough that `compareDFAs` stays cheap, while still covering the full
// regular operator set — and crucially producing many genuinely *equivalent but
// syntactically different* pairs (the case HKC is built for).

const LITERALS = ['a', 'b'] as const;

function genAtom(rng: Rng, depth: number): string {
  const allowGroup = depth < 2;
  const roll = rng.int(allowGroup ? 9 : 7);
  switch (roll) {
    case 0:
    case 1:
    case 2:
    case 3:
      return rng.pick(LITERALS);
    case 4:
      return '.';
    case 5:
    case 6: {
      const neg = rng.chance(0.3) ? '^' : '';
      return `[${neg}${rng.pick(LITERALS)}${rng.chance(0.5) ? rng.pick(LITERALS) : ''}]`;
    }
    default:
      return `(${genAlt(rng, depth + 1)})`;
  }
}
function genQuant(rng: Rng, depth: number): string {
  const atom = genAtom(rng, depth);
  switch (rng.int(6)) {
    case 0:
      return atom + '*';
    case 1:
      return atom + '+';
    case 2:
      return atom + '?';
    case 3: {
      const m = rng.int(3);
      return `${atom}{${m}}`;
    }
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
  for (let i = 0; i < n; i++) out += genQuant(rng, depth);
  return out;
}
function genAlt(rng: Rng, depth: number): string {
  const n = 1 + rng.int(depth < 1 ? 3 : 2);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(genConcat(rng, depth));
  return parts.join('|');
}
function genPattern(rng: Rng): string {
  return genAlt(rng, 0);
}

// --- DFA-side universality oracle -------------------------------------------
//
// L(D) = Σ* over D's alphabet ⇔ every state reachable from the start is
// accepting *and* total (a defined transition on every atom). The minimal DFA
// of a universal language is the single all-accepting self-looping state.
function dfaUniversal(d: DFA): boolean {
  if (d.atoms.length === 0) {
    // No alphabet: Σ* = {ε}; universal ⇔ the start state accepts.
    return d.states[d.start]?.accept ?? false;
  }
  const seen = new Uint8Array(d.states.length);
  const stack = [d.start];
  seen[d.start] = 1;
  while (stack.length) {
    const s = stack.pop()!;
    if (!d.states[s].accept) return false; // a reachable non-accepting state ⇒ rejects some word
    for (let ai = 0; ai < d.atoms.length; ai++) {
      const t = d.table[s][ai];
      if (t < 0) return false; // a missing transition ⇒ that word is rejected
      if (!seen[t]) {
        seen[t] = 1;
        stack.push(t);
      }
    }
  }
  return true;
}

// --- The report -------------------------------------------------------------

export interface VerifyConfig {
  seed: number;
  pairs: number;
}

export const DEFAULT_VERIFY: VerifyConfig = { seed: 0xc0a1, pairs: 3000 };

export interface Mismatch {
  patternA: string;
  patternB: string;
  detail: string;
}

export interface VerifyReport {
  pairs: number; // pattern pairs actually checked (both regular)
  equivalenceChecks: number;
  relationChecks: number;
  universalityChecks: number;
  // The headline numbers: total pairs explored across all checks, per mode.
  totalNaive: number;
  totalHk: number;
  totalHkc: number;
  // The single most dramatic congruence win seen (naïve ÷ hkc pairs processed).
  bestRatio: number;
  bestRatioPattern: { a: string; b: string; naive: number; hkc: number } | null;
  mismatches: Mismatch[];
  ok: boolean;
  elapsedMs: number;
  config: VerifyConfig;
}

function relName(r: Relation): string {
  return r;
}

export function runCoalgebraVerify(cfg: VerifyConfig = DEFAULT_VERIFY): VerifyReport {
  const started = Date.now();
  const rng = new Rng(mulberry32(cfg.seed));
  const mismatches: Mismatch[] = [];
  let pairs = 0;
  let equivalenceChecks = 0;
  let relationChecks = 0;
  let universalityChecks = 0;
  let totalNaive = 0;
  let totalHk = 0;
  let totalHkc = 0;
  let bestRatio = 1;
  let bestRatioPattern: VerifyReport['bestRatioPattern'] = null;

  // A reusable handful of universal/empty patterns so equal/superset/universal
  // cases turn up often, not just by luck.
  const SPECIALS = ['.*', '(a|b)*', 'a*', '', 'a*b*', '(ab)*', '.*a.*'];

  for (let i = 0; i < cfg.pairs && mismatches.length < 12; i++) {
    const pa = rng.chance(0.15) ? rng.pick(SPECIALS) : genPattern(rng);
    const pb = rng.chance(0.25)
      ? // bias toward related patterns: reuse A, or a special, to hit equal/⊆ cases
        rng.chance(0.5)
        ? pa
        : rng.pick(SPECIALS)
      : genPattern(rng);

    const ca = compile(pa);
    const cb = compile(pb);
    const nfaA = ca.nfa;
    const nfaB = cb.nfa;
    const dfaA = ca.minDfa;
    const dfaB = cb.minDfa;
    if (!nfaA || !nfaB || !dfaA || !dfaB) continue; // skip non-regular
    pairs++;

    // (1) HKC equivalence vs. compareDFAs.
    const eq = runEquivalence(nfaA, nfaB);
    equivalenceChecks++;
    if (!eq.naive.budgetHit && !eq.hk.budgetHit && !eq.hkc.budgetHit) {
      totalNaive += eq.naive.processed;
      totalHk += eq.hk.processed;
      totalHkc += eq.hkc.processed;
      const oracle = compareDFAs(dfaA, dfaB).relation === 'equal';
      if (!eq.agree) addMismatch(mismatches, pa, pb, `HKC modes disagree on equivalence`);
      if (eq.hkc.equivalent !== oracle) {
        addMismatch(mismatches, pa, pb, `HKC says ${eq.hkc.equivalent ? 'equal' : '≠'}, DFA product says ${oracle ? 'equal' : '≠'}`);
      }
      // The up-to invariant: congruence never explores more than naïve.
      if (eq.hkc.processed > eq.naive.processed) {
        addMismatch(mismatches, pa, pb, `HKC processed ${eq.hkc.processed} > naïve ${eq.naive.processed}`);
      }
      if (eq.naive.processed > 0 && eq.hkc.processed > 0) {
        const ratio = eq.naive.processed / eq.hkc.processed;
        if (ratio > bestRatio) {
          bestRatio = ratio;
          bestRatioPattern = { a: pa, b: pb, naive: eq.naive.processed, hkc: eq.hkc.processed };
        }
      }
    }

    // (2) Antichain 5-way relation vs. compareDFAs.
    const rel = relationByAntichains(nfaA, nfaB);
    relationChecks++;
    if (!rel.aSubB.budgetHit && !rel.bSubA.budgetHit) {
      const oracleRel = compareDFAs(dfaA, dfaB).relation;
      if (rel.relation !== oracleRel) {
        addMismatch(mismatches, pa, pb, `antichain relation ${relName(rel.relation)} ≠ DFA product ${relName(oracleRel)}`);
      }
      verifyWitness(mismatches, pa, pb, rel.inAnotB, nfaA, nfaB, 'A\\B');
      verifyWitness(mismatches, pa, pb, rel.inBnotA, nfaB, nfaA, 'B\\A');
    }

    // (3) Antichain universality vs. the DFA oracle (test A only, cheap).
    const uni = decideUniversality(nfaA);
    universalityChecks++;
    const oracleUni = dfaUniversal(dfaA);
    if (uni.universal !== oracleUni) {
      addMismatch(mismatches, pa, pa, `antichain universality ${uni.universal} ≠ DFA oracle ${oracleUni}`);
    }
  }

  return {
    pairs,
    equivalenceChecks,
    relationChecks,
    universalityChecks,
    totalNaive,
    totalHk,
    totalHkc,
    bestRatio,
    bestRatioPattern,
    mismatches,
    ok: mismatches.length === 0,
    elapsedMs: Date.now() - started,
    config: cfg,
  };
}

function addMismatch(list: Mismatch[], a: string, b: string, detail: string) {
  list.push({ patternA: a, patternB: b, detail });
}

// A reported witness for "in L(X) but not L(Y)" must actually be a member of X
// and a non-member of Y — checked against the engines (here, the minimal DFAs).
function verifyWitness(
  list: Mismatch[],
  pa: string,
  pb: string,
  w: { codes: number[] } | null,
  inNfa: NFA,
  notInNfa: NFA,
  label: string,
) {
  if (!w) return;
  if (!nfaAccepts(inNfa, w.codes)) addMismatch(list, pa, pb, `witness "${w.codes.join(',')}" for ${label} not accepted by the first language`);
  if (nfaAccepts(notInNfa, w.codes)) addMismatch(list, pa, pb, `witness "${w.codes.join(',')}" for ${label} *is* accepted by the second language`);
}

// Direct ε-NFA membership by determinised subset simulation (a fourth,
// independent acceptance path, so the witness check doesn't lean on the same
// code it is verifying).
function nfaAccepts(nfa: NFA, codes: number[]): boolean {
  // Build adjacency lazily.
  const eps: number[][] = Array.from({ length: nfa.stateCount }, () => []);
  const sym: { to: number; has: (c: number) => boolean }[][] = Array.from({ length: nfa.stateCount }, () => []);
  for (const e of nfa.edges) {
    if (e.set === null) eps[e.from].push(e.to);
    else sym[e.from].push({ to: e.to, has: (c: number) => e.set!.contains(c) });
  }
  const close = (set: Set<number>): Set<number> => {
    const stack = [...set];
    while (stack.length) {
      const s = stack.pop()!;
      for (const t of eps[s]) if (!set.has(t)) {
        set.add(t);
        stack.push(t);
      }
    }
    return set;
  };
  let cur = close(new Set([nfa.start]));
  for (const c of codes) {
    const next = new Set<number>();
    for (const s of cur) for (const e of sym[s]) if (e.has(c)) next.add(e.to);
    cur = close(next);
    if (cur.size === 0) return false;
  }
  return cur.has(nfa.accept);
}
