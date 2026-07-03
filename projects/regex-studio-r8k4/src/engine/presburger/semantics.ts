// A direct, defining-by-the-book evaluator for Presburger formulas: the atoms
// are evaluated as integer arithmetic and the quantifiers are interpreted
// literally over the naturals — but, since ℕ is infinite, over a bounded window
// [0, horizon]. This is the independent ground truth the compiled automaton is
// differentially checked against.
//
// For a **quantifier-free** formula the horizon is irrelevant and the evaluator
// is *exact*: the automaton is confronted with it on every tuple in a box, and
// they must agree. For quantified formulas the oracle is exact whenever every
// witness / counterexample it needs lies within the window (true for the gallery
// and the fuzzer's small formulas); the cross-check also leans on horizon-free
// tests — the ∀ ≡ ¬∃¬ duality and a battery of algebraic identities.

import type { Formula } from './ast';

export type Assignment = Record<string, number>;

function evalLinear(coef: Record<string, number>, env: Assignment): number {
  let s = 0;
  for (const [v, k] of Object.entries(coef)) s += k * (env[v] ?? 0);
  return s;
}

export function evalFormula(f: Formula, env: Assignment, horizon: number): boolean {
  switch (f.kind) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'cmp': {
      const v = evalLinear(f.coef, env);
      switch (f.op) {
        case '=':
          return v === f.c;
        case '!=':
          return v !== f.c;
        case '<':
          return v < f.c;
        case '<=':
          return v <= f.c;
        case '>':
          return v > f.c;
        case '>=':
          return v >= f.c;
      }
      return false;
    }
    case 'mod': {
      const v = evalLinear(f.coef, env);
      const m = f.m;
      return ((v % m) + m) % m === ((f.r % m) + m) % m;
    }
    case 'not':
      return !evalFormula(f.a, env, horizon);
    case 'and':
      return evalFormula(f.a, env, horizon) && evalFormula(f.b, env, horizon);
    case 'or':
      return evalFormula(f.a, env, horizon) || evalFormula(f.b, env, horizon);
    case 'implies':
      return !evalFormula(f.a, env, horizon) || evalFormula(f.b, env, horizon);
    case 'iff':
      return evalFormula(f.a, env, horizon) === evalFormula(f.b, env, horizon);
    case 'exists': {
      const save = env[f.v];
      for (let w = 0; w <= horizon; w++) {
        env[f.v] = w;
        if (evalFormula(f.a, env, horizon)) {
          env[f.v] = save;
          return true;
        }
      }
      env[f.v] = save;
      return false;
    }
    case 'forall': {
      const save = env[f.v];
      for (let w = 0; w <= horizon; w++) {
        env[f.v] = w;
        if (!evalFormula(f.a, env, horizon)) {
          env[f.v] = save;
          return false;
        }
      }
      env[f.v] = save;
      return true;
    }
  }
}

export function isQuantifierFree(f: Formula): boolean {
  switch (f.kind) {
    case 'exists':
    case 'forall':
      return false;
    case 'not':
      return isQuantifierFree(f.a);
    case 'and':
    case 'or':
    case 'implies':
    case 'iff':
      return isQuantifierFree(f.a) && isQuantifierFree(f.b);
    default:
      return true;
  }
}

export interface TupleVerdict {
  tuple: number[]; // aligned to `vars`
  accept: boolean; // the oracle's verdict
}

// Every tuple over `vars` in the box [0, maxValue]^|vars|, with the oracle's
// verdict at the given horizon. Guarded so the grid never explodes.
export function tuplesUpTo(
  formula: Formula,
  vars: string[],
  maxValue: number,
  horizon: number,
): { rows: TupleVerdict[]; truncated: boolean } {
  const k = vars.length;
  const span = maxValue + 1;
  const rows: TupleVerdict[] = [];
  const cap = 4096;
  if (k === 0) {
    rows.push({ tuple: [], accept: evalFormula(formula, {}, horizon) });
    return { rows, truncated: false };
  }
  const odometer = new Array<number>(k).fill(0);
  let truncated = false;
  for (;;) {
    const env: Assignment = {};
    for (let i = 0; i < k; i++) env[vars[i]] = odometer[i];
    rows.push({ tuple: odometer.slice(), accept: evalFormula(formula, env, horizon) });
    if (rows.length >= cap) {
      truncated = true;
      break;
    }
    let i = 0;
    for (; i < k; i++) {
      odometer[i]++;
      if (odometer[i] < span) break;
      odometer[i] = 0;
    }
    if (i === k) break;
  }
  return { rows, truncated };
}
