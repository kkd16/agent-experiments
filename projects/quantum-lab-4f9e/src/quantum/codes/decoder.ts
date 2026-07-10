/**
 * Decoding and the code-capacity threshold.
 *
 * A **decoder** is the map from a syndrome (all the decoder ever sees) back to a correction.
 * The optimal minimum-weight decoder is a lookup table: for every syndrome, the lowest-weight
 * Pauli producing it — its *coset leader*. Built once by enumerating errors in increasing
 * weight, it is exact for the small codes of the zoo.
 *
 * The **logical error rate** p_L(p) is then estimated by a Pauli-frame Monte Carlo: draw a
 * depolarizing error, read its syndrome, apply the table's correction, and declare failure iff
 * the residual is a non-trivial logical operator (an element of N(S) \ S). Because the whole
 * round is GF(2) symplectic algebra — no state vector — it runs millions of shots on codes far
 * beyond the reach of the amplitude simulator. Where p_L(p) crosses the break-even line p_L = p
 * is the code's **pseudo-threshold**: below it, encoding *helps*.
 */

import { type SymPauli, identity, multiply, weight } from './pauli';
import { StabilizerCode, enumeratePaulis } from './stabilizerCode';

export interface Decoder {
  /** syndrome key → minimum-weight correction. */
  table: Map<number, SymPauli>;
  /** Whether every syndrome (all 2^r) has an assigned coset leader. */
  complete: boolean;
  /** Guaranteed-correctable weight t = ⌊(d−1)/2⌋. */
  t: number;
  syndromes: number;
}

/** Build the minimum-weight lookup decoder by enumerating errors of increasing weight. */
export function buildDecoder(code: StabilizerCode, maxWeight?: number): Decoder {
  const r = code.gens.length;
  const totalSyndromes = 1 << r;
  const table = new Map<number, SymPauli>();
  table.set(0, identity(code.n)); // trivial syndrome ⇒ no correction
  const wMax = maxWeight ?? code.n;
  for (let w = 1; w <= wMax && table.size < totalSyndromes; w++) {
    // Enumerate exactly the weight-w Paulis (enumeratePaulis returns weight ≤ w; filter).
    for (const e of enumeratePaulis(code.n, w)) {
      if (weight(e) !== w) continue;
      const key = code.syndromeKey(e);
      if (!table.has(key)) table.set(key, e);
    }
  }
  return { table, complete: table.size === totalSyndromes, t: code.correctableWeight(), syndromes: table.size };
}

/** The correction a decoder proposes for a given error's syndrome. */
export function correctionFor(code: StabilizerCode, dec: Decoder, e: SymPauli): SymPauli {
  return dec.table.get(code.syndromeKey(e)) ?? identity(code.n);
}

export type NoiseKind = 'depolarizing' | 'independent-xz';

/** Sample a code-capacity error: each qubit is hit independently with probability p. */
export function sampleError(n: number, p: number, rng: () => number, kind: NoiseKind = 'depolarizing'): SymPauli {
  const e = identity(n);
  for (let q = 0; q < n; q++) {
    if (kind === 'depolarizing') {
      if (rng() < p) {
        const t = Math.floor(rng() * 3); // X, Z, or Y
        if (t === 0) e.x[q] = 1; else if (t === 1) e.z[q] = 1; else { e.x[q] = 1; e.z[q] = 1; }
      }
    } else {
      if (rng() < p) e.x[q] = 1;
      if (rng() < p) e.z[q] = 1;
    }
  }
  return e;
}

export interface LERResult {
  p: number;
  pL: number;
  trials: number;
  failures: number;
}

/** Monte-Carlo estimate of the logical error rate at physical rate p. */
export function logicalErrorRate(
  code: StabilizerCode,
  dec: Decoder,
  p: number,
  trials: number,
  rng: () => number,
  kind: NoiseKind = 'depolarizing',
): LERResult {
  let failures = 0;
  for (let i = 0; i < trials; i++) {
    const e = sampleError(code.n, p, rng, kind);
    const c = correctionFor(code, dec, e);
    const residual = multiply(e, c);
    // residual is always in N(S); a failure is a residual that is NOT in S (a logical fault).
    if (!code.inStabilizer(residual)) failures++;
  }
  return { p, pL: failures / trials, trials, failures };
}

/** Sweep p over a log-spaced range and return the p_L curve. */
export function sweepLER(
  code: StabilizerCode,
  dec: Decoder,
  ps: number[],
  trials: number,
  rng: () => number,
  kind: NoiseKind = 'depolarizing',
): LERResult[] {
  return ps.map((p) => logicalErrorRate(code, dec, p, trials, rng, kind));
}

/**
 * The pseudo-threshold: the physical rate p* where the p_L curve crosses the break-even line
 * p_L = p. Found by scanning the sweep for a sign change of (p_L − p) and interpolating in
 * log–log space. Returns null if the curve never crosses in range.
 */
export function pseudoThreshold(sweep: LERResult[]): number | null {
  const pts = sweep.filter((s) => s.pL > 0).sort((a, b) => a.p - b.p);
  for (let i = 0; i + 1 < pts.length; i++) {
    const d0 = pts[i].pL - pts[i].p;
    const d1 = pts[i + 1].pL - pts[i + 1].p;
    if (d0 === 0) return pts[i].p;
    if (d0 < 0 && d1 >= 0) {
      // Interpolate the crossing of log(pL) − log(p) between the two brackets.
      const f0 = Math.log(pts[i].pL) - Math.log(pts[i].p);
      const f1 = Math.log(pts[i + 1].pL) - Math.log(pts[i + 1].p);
      const t = f0 / (f0 - f1);
      const lp = Math.log(pts[i].p) + t * (Math.log(pts[i + 1].p) - Math.log(pts[i].p));
      return Math.exp(lp);
    }
  }
  return null;
}

/** A small deterministic PRNG (mulberry32) for reproducible Monte-Carlo runs. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
