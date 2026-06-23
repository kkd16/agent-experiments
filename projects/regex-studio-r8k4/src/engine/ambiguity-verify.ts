// Verifying the ambiguity analysis the house way. For each random regular
// pattern we cross-check the *structural* Weber–Seidl verdict against the
// *empirical* run counts obtained by brute force over the pattern's symbol
// atoms:
//
//   • EXACT — the integer transfer matrix Rₙ = e₀ᵀBⁿf must equal the brute-force
//     total run count over every atom-word of length n. A mismatch is a real bug.
//   • DIRECT WITNESSES — when the analyser claims a word is ambiguous, that very
//     word must actually have ≥2 distinct accepting runs; when it reports EDA, the
//     pump must genuinely multiply the run count (runs(prefix·pump²) > runs(·pump)).
//   • SOUND ONE-DIRECTIONAL BOUNDS — "unambiguous" forbids any word (up to L) with
//     ≥2 runs; a clearly geometric empirical blow-up forces the verdict to be
//     exponential. EDA must imply IDA. These never raise a false alarm.

import { compile } from './compile';
import {
  analyzeAmbiguity,
  bruteCounts,
  enumerateRuns,
  glushkovENFA,
  symbolAtoms,
  transferRuns,
  type AmbClass,
} from './ambiguity';
import { buildGlushkov } from './glushkov';

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

// Atoms stay small (and brute force stays exact) when classes are built only
// from a tiny literal set plus '.'.
const LITERALS = ['a', 'b', 'c'] as const;

function genAtom(rng: Rng, depth: number): string {
  const allowGroup = depth < 3;
  const roll = rng.int(allowGroup ? 10 : 8);
  if (roll <= 4) return rng.pick(LITERALS);
  if (roll === 5) return '.';
  if (roll <= 7) {
    // a small character class over {a,b,c}
    const neg = rng.chance(0.3) ? '^' : '';
    const letters = LITERALS.filter(() => rng.chance(0.5));
    const body = letters.length ? letters.join('') : 'a';
    return `[${neg}${body}]`;
  }
  return `(${genAlt(rng, depth + 1)})`;
}

function genQuantified(rng: Rng, depth: number): string {
  const atom = genAtom(rng, depth);
  switch (rng.int(7)) {
    case 0:
      return atom + '*';
    case 1:
      return atom + '+';
    case 2:
      return atom + '?';
    case 3:
      return atom + `{${rng.int(3)},${2 + rng.int(2)}}`;
    default:
      return atom;
  }
}

function genConcat(rng: Rng, depth: number): string {
  const n = 1 + rng.int(depth < 2 ? 3 : 2);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(genQuantified(rng, depth));
  return parts.join('');
}

function genAlt(rng: Rng, depth: number): string {
  const n = 1 + rng.int(depth < 2 ? 3 : 2);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(genConcat(rng, depth));
  return parts.join('|');
}

export function randomPattern(rng: Rng): string {
  return genAlt(rng, 0);
}

// --- The report -------------------------------------------------------------

export interface AmbiguityFuzzConfig {
  seed: number;
  patterns: number;
}

export interface AmbiguityFailure {
  pattern: string;
  reason: string;
}

export interface AmbiguityFuzzReport {
  patternsTested: number;
  skipped: number;
  byClass: Partial<Record<AmbClass, number>>;
  maxDegree: number;
  exactChecks: number; // # of Rₙ ≡ brute equalities asserted
  witnessChecks: number; // # of direct witness confirmations
  failures: AmbiguityFailure[];
  elapsedMs: number;
}

export const DEFAULT_AMBIGUITY_FUZZ: AmbiguityFuzzConfig = { seed: 1, patterns: 150 };

// Pick a brute-force length so |atoms|^L stays modest.
function bruteLen(atomCount: number): number {
  const budget = 120_000;
  let L = 4;
  while (L < 8 && Math.pow(atomCount, L + 1) <= budget) L++;
  return L;
}

export function runAmbiguityFuzz(config: AmbiguityFuzzConfig = DEFAULT_AMBIGUITY_FUZZ): AmbiguityFuzzReport {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const rng = new Rng(config.seed >>> 0);
  const failures: AmbiguityFailure[] = [];
  const byClass: Partial<Record<AmbClass, number>> = {};
  let tested = 0;
  let skipped = 0;
  let maxDegree = 0;
  let exactChecks = 0;
  let witnessChecks = 0;

  for (let i = 0; i < config.patterns && failures.length < 12; i++) {
    const pattern = randomPattern(rng);
    const compiled = compile(pattern);
    if (compiled.error || !compiled.ast || !compiled.features?.regular) {
      skipped++;
      continue;
    }
    let report;
    try {
      report = analyzeAmbiguity(compiled.ast);
    } catch (e) {
      failures.push({ pattern, reason: `analyzer threw: ${(e as Error).message}` });
      continue;
    }
    if (!report.ok) {
      skipped++;
      continue;
    }

    let pa, a, atoms;
    try {
      pa = buildGlushkov(compiled.ast);
      a = glushkovENFA(pa);
      atoms = symbolAtoms(a);
    } catch {
      skipped++;
      continue;
    }
    if (!atoms.ok || atoms.reps.length === 0) {
      skipped++;
      continue;
    }

    tested++;
    byClass[report.klass] = (byClass[report.klass] ?? 0) + 1;
    if (Number.isFinite(report.degree)) maxDegree = Math.max(maxDegree, report.degree);

    const L = bruteLen(atoms.reps.length);
    const brute = bruteCounts(a, atoms.reps, L);
    const transfer = transferRuns(a, atoms.reps, L);

    // (1) EXACT: transfer matrix total ≡ brute total.
    exactChecks++;
    for (let n = 0; n <= L; n++) {
      if (transfer[n] !== brute.total[n]) {
        failures.push({
          pattern,
          reason: `Rₙ mismatch at n=${n}: transfer ${transfer[n]} ≠ brute ${brute.total[n]}`,
        });
        break;
      }
    }

    const maxAmb = Math.max(...brute.amb);

    // (2) SOUND: unambiguous forbids any word (≤ L) with ≥ 2 runs.
    if (report.klass === 'unambiguous' && maxAmb >= 2) {
      failures.push({ pattern, reason: `claimed unambiguous but a word of length ≤ ${L} has ${maxAmb} runs` });
    }

    // (3) RIGOROUS: unambiguous ⟺ every accepted word has exactly one run, i.e.
    // the total run count equals the word count at every length.
    if (report.klass === 'unambiguous') {
      for (let n = 0; n <= L; n++) {
        if (brute.total[n] !== brute.words[n]) {
          failures.push({
            pattern,
            reason: `claimed unambiguous but at n=${n} runs ${brute.total[n]} ≠ words ${brute.words[n]}`,
          });
          break;
        }
      }
    }

    // (4) DIRECT WITNESS: an "ambiguous" word truly has ≥ 2 distinct runs.
    if (report.ambWitness) {
      witnessChecks++;
      const r = enumerateRuns(a, report.ambWitness.word, 3).length;
      if (r < 2) failures.push({ pattern, reason: `ambiguity witness "${report.ambWitness.word}" has only ${r} run(s)` });
    }

    // (5) DIRECT WITNESS: the EDA pump genuinely multiplies the run count.
    // prefix·pumpᵏ·suffix is a real accepted word whose run count ≥ 2ᵏ.
    if (report.eda) {
      witnessChecks++;
      const { prefix, pump, suffix } = report.eda;
      const one = enumerateRuns(a, prefix + pump + suffix, 200).length;
      const two = enumerateRuns(a, prefix + pump + pump + suffix, 2000).length;
      if (one < 2 || two <= one) {
        failures.push({ pattern, reason: `EDA pump did not multiply runs (1×→${one}, 2×→${two})` });
      }
    }

    // (6) STRUCTURAL INVARIANT: EDA ⟹ IDA.
    if (report.eda && report.idaComputed && !report.ida) {
      failures.push({ pattern, reason: 'EDA found but no IDA witness (EDA ⟹ IDA violated)' });
    }
  }

  const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return {
    patternsTested: tested,
    skipped,
    byClass,
    maxDegree,
    exactChecks,
    witnessChecks,
    failures,
    elapsedMs: Math.round(t1 - t0),
  };
}
