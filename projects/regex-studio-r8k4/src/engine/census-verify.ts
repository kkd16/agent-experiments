// Verifying the census the house way. For each random regular pattern, the
// rational generating function P(x)/Q(x) is re-expanded as a power series and
// must reproduce the transfer-matrix counts exactly, which must in turn match a
// brute-force enumeration; and the structural growth classification must agree
// with the empirical count ratio sₙ₊₁/sₙ (exponential ⇒ the ratio exceeds 1;
// polynomial/finite ⇒ it does not).

import { compile } from './compile';
import { analyzeCensus } from './census';

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

export interface CensusFuzzConfig {
  seed: number;
  patterns: number;
}

export interface CensusFuzzReport {
  config: CensusFuzzConfig;
  patternsTested: number;
  failures: { pattern: string; reason: string }[];
  byClass: Record<string, number>;
  maxLambda: number;
  elapsedMs: number;
}

export const DEFAULT_CENSUS_FUZZ: CensusFuzzConfig = { seed: 1, patterns: 400 };

export function runCensusFuzz(config: CensusFuzzConfig = DEFAULT_CENSUS_FUZZ): CensusFuzzReport {
  const t0 = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  const rng = new Rng(config.seed);
  const failures: { pattern: string; reason: string }[] = [];
  const byClass: Record<string, number> = { empty: 0, finite: 0, polynomial: 0, exponential: 0 };
  let patternsTested = 0;
  let maxLambda = 0;

  let attempts = 0;
  const cap = config.patterns * 4;
  while (patternsTested < config.patterns && attempts < cap) {
    attempts++;
    const pattern = genAlt(rng, 0);
    const compiled = compile(pattern);
    if (!compiled.minDfa || compiled.error || (compiled.features && !compiled.features.regular)) continue;
    if (compiled.minDfa.states.length > 22) continue;
    patternsTested++;

    const ci = analyzeCensus(compiled.minDfa, { maxLen: 12 });
    byClass[ci.growth] = (byClass[ci.growth] ?? 0) + 1;
    maxLambda = Math.max(maxLambda, ci.lambda);

    if (!ci.gfMatchesCounts) failures.push({ pattern, reason: 'generating function series ≠ counts' });
    if (!ci.bruteMatches) failures.push({ pattern, reason: 'transfer-matrix counts ≠ brute force' });

    // The growth class is read off the automaton's cycle structure; cross-check
    // it against the *denominator* of the generating function (its poles), which
    // is computed by a completely different route (the characteristic polynomial).
    const Q = ci.gf.denominator; // 1 − a₁x − … (low-degree first)
    const finiteByGF = Q.length <= 1; // constant denominator ⇒ polynomial GF ⇒ finite
    const isFinite = ci.growth === 'finite' || ci.growth === 'empty';
    if (finiteByGF !== isFinite) {
      failures.push({ pattern, reason: `finite mismatch: growth=${ci.growth} but deg(Q)=${Q.length - 1}` });
    }
    if (ci.growth === 'polynomial') {
      // Polynomial growth ⇒ λ = 1 ⇒ x = 1 is a pole, i.e. Q(1) = 0 (exact).
      let q1 = 0n;
      for (const c of Q) q1 += c;
      if (q1 !== 0n) failures.push({ pattern, reason: `polynomial but Q(1)=${q1} ≠ 0` });
      if (Math.abs(ci.lambda - 1) > 1e-9) failures.push({ pattern, reason: `polynomial but λ=${ci.lambda} ≠ 1` });
    }
    if (ci.growth === 'exponential') {
      if (ci.lambda <= 1 + 1e-6) failures.push({ pattern, reason: `exponential but λ=${ci.lambda} ≤ 1` });
      // The Perron root is a pole of the GF: Q(1/λ) ≈ 0. Tolerance scales with
      // the coefficient magnitudes and the (geometric-mean) precision of λ.
      const x = 1 / ci.lambda;
      let qx = 0;
      let scale = 0;
      let p = 1;
      for (const c of Q) {
        qx += Number(c) * p;
        scale += Math.abs(Number(c)) * Math.abs(p);
        p *= x;
      }
      if (Math.abs(qx) > 1e-2 * Math.max(1, scale)) {
        failures.push({ pattern, reason: `exponential but Q(1/λ)=${qx.toExponential(2)} ≠ 0` });
      }
    }
  }

  const t1 = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  return {
    config,
    patternsTested,
    failures,
    byClass,
    maxLambda,
    elapsedMs: Math.round(t1 - t0),
  };
}
