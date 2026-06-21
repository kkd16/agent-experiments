// Magic-state distillation — manufacturing clean T-states from noisy ones, from scratch.
//
// This is the partner of the Solovay–Kitaev tab. SK compiles any computation into a word
// over {H, T} + Clifford and tells you the T-COUNT — how many T = diag(1, e^{iπ/4}) gates
// it needs. But on a fault-tolerant machine the Clifford gates are essentially free
// (Gottesman–Knill: they are classically simulable, the lab's stabilizer engine) while the
// T gate is NOT transversal and cannot be done directly. The standard answer is to inject
// each T via a "magic state" |T⟩ = (|0⟩ + e^{iπ/4}|1⟩)/√2 prepared offline — but offline
// preparation is noisy. Magic-state DISTILLATION takes many low-fidelity copies and, using
// only (cheap) Clifford operations and measurement, outputs fewer copies of much higher
// fidelity.
//
// The workhorse is the BRAVYI–KITAEV 15-to-1 routine, built on the [[15,1,3]] punctured
// Reed–Muller code, which admits a TRANSVERSAL T gate. Its error analysis reduces, exactly,
// to the classical [15,11,3] Hamming code: an imperfect T-state carries a phase (Z) error
// with probability p; the routine post-selects on a trivial X-syndrome (the error must be a
// Hamming codeword) and the surviving error is a logical fault iff it is an ODD-weight
// Hamming codeword — a Z-logical of the code. Because the code has distance 3 and exactly
// 35 weight-3 codewords, the output error rate is
//
//        p_out = 35 p³ + O(p⁴),
//
// the celebrated CUBIC suppression. Below a threshold p < p* the output is cleaner than the
// input, so iterating the routine drives the error toward zero doubly-exponentially. This
// module builds the [15,11,3] code from scratch (parity-check columns = the binary numerals
// 1…15), computes p_out exactly by summing over its 2¹¹ codewords, cross-checks against a
// Monte-Carlo of the post-selected protocol, and recovers the 35 p³ law and the threshold.

// ───────────────────────────── the [15,11,3] Hamming code ─────────────────────────────

export const N_DATA = 15;

/** 4-bit X-syndrome of a 15-bit Z-error mask: XOR of the binary numerals of the flipped qubits. */
export function hammingSyndrome(errMask: number): number {
  let s = 0;
  for (let j = 0; j < 15; j++) if ((errMask >> j) & 1) s ^= (j + 1);   // column j ↔ numeral j+1
  return s;
}

export const popcount = (x: number): number => {
  let c = 0;
  while (x) { c += x & 1; x >>>= 1; }
  return c;
};

let CACHED_CODE: number[] | null = null;
/** All 2¹¹ codewords of the [15,11,3] Hamming code (trivial-X-syndrome error patterns). */
export function hammingCode(): number[] {
  if (CACHED_CODE) return CACHED_CODE;
  const code: number[] = [];
  for (let e = 0; e < (1 << 15); e++) if (hammingSyndrome(e) === 0) code.push(e);
  CACHED_CODE = code;
  return code;
}

/** Weight enumerator A_w = #{codewords of weight w}. For Hamming[15,11]: A₀=1, A₃=35, A₄=105, … */
export function weightEnumerator(): number[] {
  const A = new Array(16).fill(0);
  for (const e of hammingCode()) A[popcount(e)]++;
  return A;
}

// ───────────────────────────── exact output error rate ─────────────────────────────

export interface DistillResult {
  pIn: number;
  pOut: number;            // logical error of the distilled output
  pAccept: number;         // probability the routine accepts (post-selection survival)
  improves: boolean;       // pOut < pIn — distillation actually helps
  leading: number;         // 35 p³, the leading-order prediction
}

/**
 * Exact 15-to-1 output error rate by summing over every Hamming codeword (undetected error
 * pattern). Accepted ⇔ error is a codeword; failure ⇔ that codeword has odd weight (a
 * Z-logical). p_out = Σ_{odd-weight cw} P(e) / Σ_{cw} P(e), with P(e) = p^|e| (1−p)^{15−|e|}.
 */
export function distill(p: number): DistillResult {
  let num = 0, den = 0;
  for (const e of hammingCode()) {
    const w = popcount(e);
    const pr = Math.pow(p, w) * Math.pow(1 - p, 15 - w);
    den += pr;
    if (w & 1) num += pr;
  }
  const pOut = den > 0 ? num / den : 0;
  return { pIn: p, pOut, pAccept: den, improves: pOut < p, leading: 35 * p * p * p };
}

/** The exact distillability threshold p* where p_out = p (below it, distillation helps). */
export function exactThreshold(): number {
  let lo = 1e-4, hi = 0.3;
  for (let i = 0; i < 80; i++) {
    const m = (lo + hi) / 2;
    if (distill(m).pOut < m) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
}

/** The leading-order threshold estimate from p = 35 p³ ⇒ p* = 1/√35. */
export const LEADING_THRESHOLD = 1 / Math.sqrt(35);

// ───────────────────────────── iterated distillation ─────────────────────────────

export interface CascadeRound { round: number; p: number; rawStates: number; }

/**
 * Iterate the routine `rounds` times from `pIn`. Each round consumes 15 inputs per output,
 * so producing one round-r output costs 15^r raw states (before accounting for rejected
 * batches). Returns the error after each round and the cumulative raw-state cost.
 */
export function distillCascade(pIn: number, rounds: number): CascadeRound[] {
  const out: CascadeRound[] = [{ round: 0, p: pIn, rawStates: 1 }];
  let p = pIn;
  for (let r = 1; r <= rounds; r++) {
    p = distill(p).pOut;
    out.push({ round: r, p, rawStates: Math.pow(15, r) });
  }
  return out;
}

/** Distillation rounds needed to push pIn at or below a target output error (∞ if above threshold). */
export function roundsNeeded(pIn: number, target: number, maxRounds = 12): number {
  let p = pIn;
  for (let r = 0; r <= maxRounds; r++) {
    if (p <= target) return r;
    const next = distill(p).pOut;
    if (next >= p) return Infinity;      // not converging — above threshold
    p = next;
  }
  return Infinity;
}

// ───────────────────────────── Monte-Carlo cross-check ─────────────────────────────

/** Seeded mulberry32 PRNG (matches the repo's surface-code RNG convention). */
export function distillRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface MonteCarloResult { trials: number; accepted: number; pOut: number; pAccept: number; }

/**
 * Monte-Carlo the post-selected protocol: draw 15 i.i.d. Z-errors at rate p, accept iff the
 * pattern is a Hamming codeword, count odd-weight acceptances as logical failures. Converges
 * to the exact `distill(p)`.
 */
export function distillMonteCarlo(p: number, trials: number, seed = 1): MonteCarloResult {
  const rng = distillRng(seed);
  let accepted = 0, fail = 0;
  for (let t = 0; t < trials; t++) {
    let e = 0;
    for (let j = 0; j < 15; j++) if (rng() < p) e |= 1 << j;
    if (hammingSyndrome(e) === 0) { accepted++; if (popcount(e) & 1) fail++; }
  }
  return { trials, accepted, pOut: accepted ? fail / accepted : 0, pAccept: trials ? accepted / trials : 0 };
}

// ───────────────────────────── the [[15,1,3]] code facts (for display) ─────────────────────────────

export const CODE_FACTS = {
  n: 15, k: 1, d: 3,
  xStabilizers: 4,    // the Hamming parity checks (X-type)
  zStabilizers: 10,   // the even-weight Hamming subcode generators (Z-type)
  weight3Logicals: 35,
};
