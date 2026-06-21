// The Session-8 proofs, packaged for the Algebra panel's "run cross-check"
// button — the same house move the Fuzz / Extended panels make: draw random
// regular patterns, build each one's syntactic monoid, and confirm the
// independent computations of the same fact agree, surfacing any counterexample.
//
// The headline invariant is that the three roads to "aperiodic" (⇔ star-free)
// all land on the same verdict for every pattern:
//   (a) every Green H-class is a singleton,
//   (b) every monoid element is group-free (mⁿ = mⁿ⁺¹), and
//   (c) the minimal DFA is counter-free (no word induces a non-trivial cycle).
// Plus structural sanity on Green's relations (H = R ∩ L, R,L ⊆ D, full
// egg-boxes) and the classical implications (J-trivial ⇒ aperiodic, etc.).

import { compile } from './compile';
import {
  buildSyntacticMonoid,
  greenRelations,
  monoidProperties,
  counterFreeWitness,
} from './monoid';

export interface MonoidFuzzReport {
  seed: number;
  patterns: number; // patterns drawn
  analyzed: number; // patterns whose monoid was small enough to enumerate
  checks: number; // individual invariant assertions made
  disagreements: number;
  firstFailure: string | null;
  aperiodic: number; // how many analyzed languages were star-free
  withGroups: number; // how many had a non-trivial syntactic group
  ms: number;
}

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

function genPattern(rng: () => number, depth: number): string {
  const r = rng();
  if (depth <= 0 || r < 0.4) return rng() < 0.5 ? 'a' : 'b';
  if (r < 0.55) return genPattern(rng, depth - 1) + genPattern(rng, depth - 1);
  if (r < 0.7) return '(' + genPattern(rng, depth - 1) + '|' + genPattern(rng, depth - 1) + ')';
  if (r < 0.82) return '(' + genPattern(rng, depth - 1) + ')*';
  if (r < 0.92) return '(' + genPattern(rng, depth - 1) + ')+';
  return '(' + genPattern(rng, depth - 1) + ')?';
}

export function runMonoidFuzz(seed: number, patterns: number): MonoidFuzzReport {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const rng = mulberry32(seed);
  let analyzed = 0;
  let checks = 0;
  let disagreements = 0;
  let firstFailure: string | null = null;
  let aperiodic = 0;
  let withGroups = 0;

  const note = (ok: boolean, why: string) => {
    checks++;
    if (!ok) {
      disagreements++;
      if (firstFailure === null) firstFailure = why;
    }
  };

  for (let i = 0; i < patterns; i++) {
    const pat = genPattern(rng, 4);
    let c;
    try {
      c = compile(pat);
    } catch {
      continue;
    }
    if (!c.minDfa) continue;
    const m = buildSyntacticMonoid(c.minDfa);
    if (m.truncated) continue;
    const g = greenRelations(m);
    if (!g) continue;
    const p = monoidProperties(m, g);
    analyzed++;
    if (p.aperiodic) aperiodic++;
    if (p.countingModulus > 1) withGroups++;

    note(p.crossCheckOk, `/${pat}/ — aperiodicity verdicts disagree`);

    const pairs = new Set<string>();
    for (let e = 0; e < m.size; e++) pairs.add(g.rClassOf[e] + '|' + g.lClassOf[e]);
    note(pairs.size === g.hClasses.length, `/${pat}/ — H ≠ R ∩ L`);

    let dOk = true;
    for (const cls of g.rClasses) for (const e of cls) if (g.dClassOf[e] !== g.dClassOf[cls[0]]) dOk = false;
    for (const cls of g.lClasses) for (const e of cls) if (g.dClassOf[e] !== g.dClassOf[cls[0]]) dOk = false;
    note(dOk, `/${pat}/ — an R- or L-class straddles two D-classes`);

    let gridOk = true;
    for (const d of g.dClasses) if (d.cell.size !== d.rows.length * d.cols.length) gridOk = false;
    note(gridOk, `/${pat}/ — egg-box is not a full grid`);

    note(!p.jTrivial || p.aperiodic, `/${pat}/ — J-trivial but not aperiodic`);
    note(p.aperiodic === (p.countingModulus === 1), `/${pat}/ — aperiodic ⇎ modulus 1`);

    const cf = counterFreeWitness(m);
    note(cf.counterFree === p.aperiodic, `/${pat}/ — counter-free ⇎ aperiodic`);
  }

  const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return {
    seed,
    patterns,
    analyzed,
    checks,
    disagreements,
    firstFailure,
    aperiodic,
    withGroups,
    ms: Math.round(t1 - t0),
  };
}
