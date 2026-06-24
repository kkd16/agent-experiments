// The proof console — the house style for the infinite-word side. A seeded
// fuzzer draws random LTL formulas over a small alphabet and checks the GPVW
// pipeline two independent ways:
//
//  1. DIFFERENTIAL — build the NBA, draw random lassos u·vᵒ, and confront the
//     automaton's acceptance of each lasso with the brute-force LTL oracle on
//     that same ultimately-periodic word. They must agree on every lasso.
//  2. COMPLEMENT-DUALITY — build NBA(φ) and NBA(¬φ); for every sampled lasso
//     EXACTLY ONE must accept. The ultimately-periodic words are dense in the
//     ω-words, so this is a real test that the two ω-languages partition Σᵒ —
//     i.e. that ¬ really complements (Büchi closure under complement), checked
//     without ever consulting the oracle.
//
// Reproducible by seed; the first counterexample is surfaced verbatim.

import type { LTL } from './ltl';
import { ltlToString } from './ltl';
import { buildNBA } from './index';
import { nbaAcceptsLasso, OmegaError } from './nba';
import { satisfiesLasso, mulberry32, randomLasso, type LassoWord } from './semantics';

function pick<T>(rnd: () => number, xs: T[]): T {
  return xs[Math.floor(rnd() * xs.length)];
}

function genLTL(rnd: () => number, alphabet: string[], depth: number): LTL {
  if (depth <= 0) {
    const r = rnd();
    if (r < 0.85) return { k: 'prop', letter: pick(rnd, alphabet) };
    return r < 0.925 ? { k: 'true' } : { k: 'false' };
  }
  const r = rnd();
  if (r < 0.18) return { k: 'not', a: genLTL(rnd, alphabet, depth - 1) };
  if (r < 0.30) return { k: 'next', a: genLTL(rnd, alphabet, depth - 1) };
  if (r < 0.42) return { k: 'eventually', a: genLTL(rnd, alphabet, depth - 1) };
  if (r < 0.54) return { k: 'globally', a: genLTL(rnd, alphabet, depth - 1) };
  if (r < 0.66) return { k: 'until', a: genLTL(rnd, alphabet, depth - 1), b: genLTL(rnd, alphabet, depth - 1) };
  if (r < 0.76) return { k: 'release', a: genLTL(rnd, alphabet, depth - 1), b: genLTL(rnd, alphabet, depth - 1) };
  if (r < 0.86) return { k: 'weakuntil', a: genLTL(rnd, alphabet, depth - 1), b: genLTL(rnd, alphabet, depth - 1) };
  const op = pick(rnd, ['and', 'or', 'implies', 'iff'] as const);
  return { k: op, a: genLTL(rnd, alphabet, depth - 1), b: genLTL(rnd, alphabet, depth - 1) };
}

export interface OmegaFuzzConfig {
  seed: number;
  trials: number;
  alphabet: string[];
  depth: number;
  lassosPerFormula: number;
  maxStem: number;
  maxLoop: number;
}

export const DEFAULT_OMEGA_FUZZ: OmegaFuzzConfig = {
  seed: 1,
  trials: 120,
  alphabet: ['a', 'b'],
  depth: 3,
  lassosPerFormula: 24,
  maxStem: 3,
  maxLoop: 3,
};

export interface OmegaFuzzReport {
  ok: boolean;
  trials: number;
  membershipChecks: number;
  dualityChecks: number;
  skipped: number;
  elapsedMs: number;
  failure: null | { kind: 'membership' | 'duality'; formula: string; detail: string };
}

function lassoStr(w: LassoWord): string {
  return `${w.u.join('') || 'ε'}·(${w.v.join('')})ᵒ`;
}

export function runOmegaFuzz(config: OmegaFuzzConfig = DEFAULT_OMEGA_FUZZ): OmegaFuzzReport {
  const start = performance.now();
  const rnd = mulberry32(config.seed * 2654435761 + 12345);
  let membershipChecks = 0;
  let dualityChecks = 0;
  let skipped = 0;

  for (let t = 0; t < config.trials; t++) {
    const phi = genLTL(rnd, config.alphabet, config.depth);

    let pos: ReturnType<typeof buildNBA>;
    let neg: ReturnType<typeof buildNBA>;
    try {
      pos = buildNBA(phi, config.alphabet);
      neg = buildNBA({ k: 'not', a: phi }, config.alphabet);
    } catch (e) {
      if (e instanceof OmegaError) { skipped++; continue; }
      throw e;
    }

    for (let j = 0; j < config.lassosPerFormula; j++) {
      const w = randomLasso(rnd, config.alphabet, config.maxStem, config.maxLoop);

      const oracle = satisfiesLasso(phi, w);
      const auto = nbaAcceptsLasso(pos.nba, w.u, w.v);
      membershipChecks++;
      if (oracle !== auto) {
        return done({
          kind: 'membership',
          formula: ltlToString(phi),
          detail: `lasso ${lassoStr(w)} — oracle ${oracle}, automaton ${auto}`,
        });
      }

      const negAuto = nbaAcceptsLasso(neg.nba, w.u, w.v);
      dualityChecks++;
      if (auto === negAuto) {
        return done({
          kind: 'duality',
          formula: ltlToString(phi),
          detail: `lasso ${lassoStr(w)} — NBA(φ) and NBA(¬φ) ${auto ? 'both accept' : 'both reject'} (must be exactly one)`,
        });
      }
    }
  }

  return {
    ok: true,
    trials: config.trials,
    membershipChecks,
    dualityChecks,
    skipped,
    elapsedMs: performance.now() - start,
    failure: null,
  };

  function done(failure: NonNullable<OmegaFuzzReport['failure']>): OmegaFuzzReport {
    return {
      ok: false,
      trials: config.trials,
      membershipChecks,
      dualityChecks,
      skipped,
      elapsedMs: performance.now() - start,
      failure,
    };
  }
}
