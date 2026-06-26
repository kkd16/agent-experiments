/**
 * Device-independent randomness certified by the CHSH violation.
 *
 * The most striking practical consequence of Bell nonlocality: a CHSH value S > 2 certifies that the
 * measurement outcomes are *genuinely unpredictable* — not merely to us, but to ANY adversary, even
 * one who manufactured the devices and holds a system entangled with them. The certificate trusts
 * NOTHING about the devices' internal workings (Hilbert-space dimension, what the measurements really
 * are): only the observed statistic S. This is the foundation of device-independent random-number
 * generation and quantum key distribution.
 *
 * The bound (Pironio et al., Nature 2010; Masanes–Pironio–Acín): an adversary's optimal probability
 * of guessing a fresh outcome, given an observed CHSH value S, is
 *
 *     P_guess(S) = ½ + ½·√( 2 − S²/4 ).
 *
 * It interpolates exactly between the two extremes:
 *   • S = 2 (classical / local): P_guess = ½ + ½·√(2 − 1) = 1  →  fully predictable, 0 bits.
 *   • S = 2√2 (Tsirelson): P_guess = ½ + ½·√(2 − 2) = ½       →  perfectly random, 1 bit.
 *
 * The certified min-entropy is H_min = −log₂ P_guess — the number of (near-)uniform random bits a
 * randomness extractor can distil per use, guaranteed against the adversary. Below S = 2 nothing is
 * certified (a local-deterministic strategy could reproduce the data).
 */

/** Tsirelson's bound — the CHSH value at which one full bit of private randomness is certified. */
export const TSIRELSON = 2 * Math.SQRT2;

/** The adversary's optimal guessing probability given an observed CHSH value S ∈ [2, 2√2]. */
export function guessingProbability(S: number): number {
  const s = Math.min(Math.max(S, 2), TSIRELSON);
  return 0.5 + 0.5 * Math.sqrt(Math.max(0, 2 - (s * s) / 4));
}

/** Certified min-entropy H_min = −log₂ P_guess (bits of randomness per use). 0 at S=2, 1 at 2√2. */
export function certifiedMinEntropy(S: number): number {
  if (S <= 2) return 0;
  return -Math.log2(guessingProbability(S));
}

export interface RandomnessPoint {
  S: number;
  pGuess: number;
  hMin: number;
}

/** The full certification curve over the violation range [2, 2√2] for plotting. */
export function randomnessCurve(n = 121): RandomnessPoint[] {
  const out: RandomnessPoint[] = [];
  for (let i = 0; i < n; i++) {
    const S = 2 + (TSIRELSON - 2) * (i / (n - 1));
    out.push({ S, pGuess: guessingProbability(S), hMin: certifiedMinEntropy(S) });
  }
  return out;
}

/** The two endpoints, used by the self-tests: S=2 → 0 bits, S=2√2 → 1 bit. */
export const RANDOMNESS_ENDPOINTS = {
  classical: { S: 2, hMin: certifiedMinEntropy(2) },
  tsirelson: { S: TSIRELSON, hMin: certifiedMinEntropy(TSIRELSON) },
};
