/**
 * The Popescu–Rohrlich box and the three ceilings of CHSH.
 *
 * NPA proves quantum theory cannot beat S = 2√2. But is that ceiling *forced by causality*, or is it
 * a special fact about quantum mechanics? Popescu and Rohrlich (1994) answered: there exists a
 * NO-SIGNALLING correlation — the PR box — that reaches the *algebraic* maximum S = 4 while still
 * forbidding faster-than-light communication. So the CHSH value lives in a strict three-tier hierarchy:
 *
 *     local-hidden-variable  ≤  2   <   QUANTUM (Tsirelson)  =  2√2 ≈ 2.828   <   no-signalling  ≤  4.
 *
 * Quantum theory is *more* nonlocal than any classical theory, yet *less* nonlocal than causality
 * alone would allow. The PR box is the foil that makes the NPA bound a genuine, non-trivial fact about
 * nature: the universe could have been a PR box and still respected relativity — it chose not to.
 *
 * The PR box: inputs x,y ∈ {0,1}, outputs a,b ∈ {0,1}, with
 *     P(a,b | x,y) = ½  iff  a ⊕ b = x ∧ y,   else 0.
 * Its winning condition a⊕b = x∧y is exactly the CHSH game, won with certainty (p = 1), versus the
 * classical cap 0.75 and the quantum cos²(π/8) ≈ 0.854.
 */

export type Behaviour = number[][][][]; // P[a][b][x][y]

/** The Popescu–Rohrlich box behaviour P(a,b|x,y) = ½·[a⊕b = x∧y]. */
export function prBox(): Behaviour {
  const P: Behaviour = Array.from({ length: 2 }, () => Array.from({ length: 2 }, () => Array.from({ length: 2 }, () => [0, 0])));
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
    P[a][b][x][y] = ((a ^ b) === (x & y)) ? 0.5 : 0;
  }
  return P;
}

/** A maximally-mixed local box (every outcome ¼): the trivial no-signalling point, S = 0. */
export function whiteNoiseBox(): Behaviour {
  return Array.from({ length: 2 }, () => Array.from({ length: 2 }, () => Array.from({ length: 2 }, () => [0.25, 0.25])));
}

/** Correlator E_xy = Σ_{a,b} (−1)^{a⊕b} P(a,b|x,y). */
export function correlator(P: Behaviour, x: number, y: number): number {
  let e = 0;
  for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) e += ((a ^ b) === 0 ? 1 : -1) * P[a][b][x][y];
  return e;
}

/** The CHSH value S = E₀₀ + E₀₁ + E₁₀ − E₁₁ of a behaviour. */
export function chshOf(P: Behaviour): number {
  return correlator(P, 0, 0) + correlator(P, 0, 1) + correlator(P, 1, 0) - correlator(P, 1, 1);
}

/**
 * No-signalling check: Alice's marginal P(a|x,y) must not depend on Bob's input y (and vice versa).
 * Returns the largest signalling deviation found (0 ⇒ exactly no-signalling).
 */
export function signallingDeviation(P: Behaviour): number {
  let worst = 0;
  // Alice marginal P_A(a|x) independent of y.
  for (let x = 0; x < 2; x++) for (let a = 0; a < 2; a++) {
    const m0 = P[a][0][x][0] + P[a][1][x][0];
    const m1 = P[a][0][x][1] + P[a][1][x][1];
    worst = Math.max(worst, Math.abs(m0 - m1));
  }
  // Bob marginal P_B(b|y) independent of x.
  for (let y = 0; y < 2; y++) for (let b = 0; b < 2; b++) {
    const m0 = P[0][b][0][y] + P[1][b][0][y];
    const m1 = P[0][b][1][y] + P[1][b][1][y];
    worst = Math.max(worst, Math.abs(m0 - m1));
  }
  return worst;
}

/** CHSH-game win probability of a behaviour: average over inputs of P(a⊕b = x∧y). */
export function gameWinProbability(P: Behaviour): number {
  let win = 0;
  for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
    if ((a ^ b) === (x & y)) win += 0.25 * P[a][b][x][y];
  }
  return win;
}

export const LOCAL_BOUND = 2;
export const QUANTUM_BOUND = 2 * Math.SQRT2;
export const NO_SIGNALLING_BOUND = 4;

export interface CeilingRow {
  name: string;
  chsh: number;
  gameWin: number;
  note: string;
}

/** The three-tier summary table for the lab. */
export function ceilings(): CeilingRow[] {
  const pr = prBox();
  return [
    { name: 'Local (LHV)', chsh: LOCAL_BOUND, gameWin: 0.75, note: 'any classical / hidden-variable strategy' },
    { name: 'Quantum (Tsirelson)', chsh: QUANTUM_BOUND, gameWin: Math.cos(Math.PI / 8) ** 2, note: 'NPA-certified ceiling — proven by the SDP' },
    { name: 'No-signalling (PR box)', chsh: chshOf(pr), gameWin: gameWinProbability(pr), note: 'algebraic max, still causal — but supra-quantum' },
  ];
}
