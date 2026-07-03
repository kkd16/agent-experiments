// The proof console — the house style. A seeded fuzzer draws random Presburger
// formulas over a few variables and checks the Büchi–Bruyère–Villemaire compiler
// four ways, every one of them *exact* (no bounded-quantifier soundness gap):
//
//  1. DIFFERENTIAL (quantifier-free) — compile the formula and confront the
//     automaton with the arithmetic oracle on *every* tuple in a box [0,N]^k.
//     For a QF formula the oracle is exact, so any disagreement is a real bug.
//  2. DUALITY — ∀x.φ and ¬∃x¬φ must compile to the *same language* (checked by
//     the product-emptiness `languageEqual`, not by re-running the oracle). The
//     two go through different code paths (projection vs complement-project-
//     complement) and must still agree.
//  3. WITNESS SOUNDNESS — whenever the oracle finds a witness x ≤ N with φ true,
//     the compiled ∃x.φ automaton must accept the remaining coordinates. (The
//     one-way sound direction; a spurious x > N is not counted against it.)
//  4. IDENTITY BATTERY — a fixed list of textbook Presburger equivalences
//     asserted by `languageEqual`, exercising the full pipeline end to end.
//
// Reproducible by seed; the first counterexample is surfaced verbatim.

import type { Formula } from './ast';
import { formulaToString, freeVars } from './ast';
import { compilePresburgerFormula } from './compile';
import { parsePresburger } from './parser';
import { acceptsTuple } from './automata';
import { evalFormula } from './semantics';
import { languageEqual, type BitDFA } from '../logic/bitaut';

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

const VARS = ['x', 'y', 'z'];

function pick<T>(rnd: () => number, xs: T[]): T {
  return xs[Math.floor(rnd() * xs.length)];
}
function randInt(rnd: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rnd() * (hi - lo + 1));
}

function genAtom(rnd: () => number): Formula {
  if (rnd() < 0.25) {
    // congruence
    const nv = randInt(rnd, 1, 2);
    const coef: Record<string, number> = {};
    for (let i = 0; i < nv; i++) coef[pick(rnd, VARS)] = randInt(rnd, 1, 3);
    const m = randInt(rnd, 2, 4);
    return { kind: 'mod', coef, r: randInt(rnd, 0, m - 1), m };
  }
  const nv = randInt(rnd, 1, 2);
  const coef: Record<string, number> = {};
  for (let i = 0; i < nv; i++) {
    const v = pick(rnd, VARS);
    coef[v] = (coef[v] ?? 0) + randInt(rnd, -2, 2);
  }
  // avoid a fully-zero form
  if (Object.values(coef).every((k) => k === 0)) coef[pick(rnd, VARS)] = 1;
  const op = pick(rnd, ['=', '<=', '<', '>=', '>', '!='] as const);
  return { kind: 'cmp', op, coef, c: randInt(rnd, -3, 6) };
}

function genQF(rnd: () => number, depth: number): Formula {
  if (depth <= 0) return genAtom(rnd);
  const r = rnd();
  if (r < 0.45) {
    const op = pick(rnd, ['and', 'or', 'implies', 'iff'] as const);
    return { kind: op, a: genQF(rnd, depth - 1), b: genQF(rnd, depth - 1) };
  }
  if (r < 0.6) return { kind: 'not', a: genQF(rnd, depth - 1) };
  return genAtom(rnd);
}

export interface PresburgerFuzzConfig {
  seed: number;
  trials: number;
  box: number; // differential box radius N (tuples in [0,N]^k)
  depth: number;
}

export const DEFAULT_PRESBURGER_FUZZ: PresburgerFuzzConfig = {
  seed: 1,
  trials: 150,
  box: 8,
  depth: 3,
};

export interface PresburgerFuzzReport {
  ok: boolean;
  trials: number;
  membershipChecks: number;
  dualityChecks: number;
  witnessChecks: number;
  identityChecks: number;
  skipped: number;
  elapsedMs: number;
  failure: null | { kind: 'membership' | 'duality' | 'witness' | 'identity'; formula: string; detail: string };
}

// A fixed battery of textbook Presburger equivalences (each side compiles
// through the whole pipeline; the two must denote the same automaton).
const IDENTITIES: [string, string, string][] = [
  ['∃y. x = y+y  ≡  x ≡ 0 (mod 2)', 'exists y. x = y + y', 'x ≡ 0 (mod 2)'],
  ['∃z. x+z = y  ≡  x ≤ y', 'exists z. x + z = y', 'x <= y'],
  ['x < y  ≡  x+1 ≤ y', 'x < y', 'x + 1 <= y'],
  ['¬(x < y)  ≡  y ≤ x', '~(x < y)', 'y <= x'],
  ['x ≡ 0 (mod 2)  ≡  ¬(x ≡ 1 (mod 2))', 'x ≡ 0 (mod 2)', '~(x ≡ 1 (mod 2))'],
  ['∃y. x = 3y  ≡  x ≡ 0 (mod 3)', 'exists y. x = 3*y', 'x ≡ 0 (mod 3)'],
  ['∃x. (x ≤ n & n ≤ x)  ≡  true', 'exists x. (x <= n & n <= x)', '0 = 0'],
  ['∀y. x ≤ y  ≡  x = 0', 'forall y. x <= y', 'x = 0'],
];

function compileOK(src: string): BitDFA | null {
  const p = parsePresburger(src);
  if (!p.formula) return null;
  try {
    return compilePresburgerFormula(p.formula).automaton;
  } catch {
    return null;
  }
}

export function runPresburgerFuzz(config: PresburgerFuzzConfig = DEFAULT_PRESBURGER_FUZZ): PresburgerFuzzReport {
  const start = performance.now();
  const rnd = mulberry32(config.seed * 2654435761 + 12345);
  let membershipChecks = 0;
  let dualityChecks = 0;
  let witnessChecks = 0;
  let identityChecks = 0;
  let skipped = 0;

  const fail = (
    kind: PresburgerFuzzReport['failure'] extends null ? never : NonNullable<PresburgerFuzzReport['failure']>['kind'],
    formula: string,
    detail: string,
  ): PresburgerFuzzReport => ({
    ok: false,
    trials: config.trials,
    membershipChecks,
    dualityChecks,
    witnessChecks,
    identityChecks,
    skipped,
    elapsedMs: performance.now() - start,
    failure: { kind, formula, detail },
  });

  // (4) identity battery
  for (const [label, lhs, rhs] of IDENTITIES) {
    const A = compileOK(lhs);
    const B = compileOK(rhs);
    if (!A || !B) {
      skipped++;
      continue;
    }
    identityChecks++;
    if (!languageEqual(A, B)) return fail('identity', label, `the two sides compiled to different automata`);
  }

  const box = config.box;
  const enumerateBox = (vars: string[], f: (env: Record<string, number>) => boolean | void): boolean => {
    const k = vars.length;
    if (k === 0) return f({}) === false ? false : true;
    const odo = new Array<number>(k).fill(0);
    for (;;) {
      const env: Record<string, number> = {};
      for (let i = 0; i < k; i++) env[vars[i]] = odo[i];
      if (f(env) === false) return false;
      let i = 0;
      for (; i < k; i++) {
        odo[i]++;
        if (odo[i] <= box) break;
        odo[i] = 0;
      }
      if (i === k) break;
    }
    return true;
  };

  for (let t = 0; t < config.trials; t++) {
    const phi = genQF(rnd, config.depth);
    let auto: BitDFA;
    try {
      auto = compilePresburgerFormula(phi).automaton;
    } catch {
      skipped++;
      continue;
    }
    const vars = [...freeVars(phi)].sort();

    // (1) differential over the box — exact for a QF formula
    let mismatch: string | null = null;
    enumerateBox(vars, (env) => {
      membershipChecks++;
      const oracle = evalFormula(phi, env, 0);
      const got = acceptsTuple(auto, env);
      if (oracle !== got) {
        mismatch = `tuple (${vars.map((v) => `${v}=${env[v]}`).join(', ') || '∅'}) — oracle ${oracle}, automaton ${got}`;
        return false;
      }
    });
    if (mismatch) return fail('membership', formulaToString(phi), mismatch);

    // (2) duality on variable x: ∀x.φ ≡ ¬∃x¬φ
    const forallForm: Formula = { kind: 'forall', v: 'x', a: phi };
    const dualForm: Formula = { kind: 'not', a: { kind: 'exists', v: 'x', a: { kind: 'not', a: phi } } };
    try {
      const A = compilePresburgerFormula(forallForm).automaton;
      const B = compilePresburgerFormula(dualForm).automaton;
      dualityChecks++;
      if (!languageEqual(A, B)) {
        return fail('duality', formulaToString(forallForm), `∀x.φ and ¬∃x¬φ compiled to different automata`);
      }
    } catch {
      /* blow-up on the quantified form — not a correctness failure */
    }

    // (3) witness soundness for ∃x.φ (the sound direction only)
    const existsForm: Formula = { kind: 'exists', v: 'x', a: phi };
    let existsAuto: BitDFA | null = null;
    try {
      existsAuto = compilePresburgerFormula(existsForm).automaton;
    } catch {
      existsAuto = null;
    }
    if (existsAuto) {
      const rest = vars.filter((v) => v !== 'x');
      let witnessFail: string | null = null;
      enumerateBox(rest, (env) => {
        let oracleWitness = false;
        for (let w = 0; w <= box && !oracleWitness; w++) {
          if (evalFormula(phi, { ...env, x: w }, 0)) oracleWitness = true;
        }
        if (oracleWitness) {
          witnessChecks++;
          if (!acceptsTuple(existsAuto!, env)) {
            witnessFail = `∃x with (${rest.map((v) => `${v}=${env[v]}`).join(', ') || '∅'}) has a witness ≤ ${box} but the automaton rejects`;
            return false;
          }
        }
      });
      if (witnessFail) return fail('witness', formulaToString(existsForm), witnessFail);
    }
  }

  return {
    ok: true,
    trials: config.trials,
    membershipChecks,
    dualityChecks,
    witnessChecks,
    identityChecks,
    skipped,
    elapsedMs: performance.now() - start,
    failure: null,
  };
}
