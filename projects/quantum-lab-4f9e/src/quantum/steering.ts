import { eigenvalues, type RealMat } from './sdp';

/**
 * EPR steering — the asymmetric middle child of the quantum-correlation hierarchy.
 *
 * Between mere entanglement and full Bell-nonlocality sits STEERING (Schrödinger's word, formalised
 * by Wiseman–Jones–Doherty 2007): Alice can "steer" Bob's conditional states into ensembles that no
 * local-hidden-state (LHS) model for Bob can explain. It is strictly weaker than Bell-nonlocality
 * (some steerable states are Bell-local) and strictly stronger than entanglement, and — uniquely —
 * it is ASYMMETRIC: a state can be steerable from Alice to Bob but not the reverse. This module builds
 * two from-scratch tools, both on the state's 3×3 correlation data (the spin–spin matrix T, Bloch
 * vectors a, b):
 *
 *   1. THE STEERING ELLIPSOID (Jevtic–Pusey–Jennings–Rudolph, PRL 2014). The set of Bloch vectors
 *      Bob can be steered to, over all of Alice's measurements, is an ellipsoid inside the Bloch ball.
 *      Its geometry is a complete local-unitary invariant of the two-qubit state — a faithful picture
 *      of the correlations (a maximally-entangled state fills the whole ball; a product state
 *      collapses it to a point).
 *
 *   2. THE CJWR LINEAR STEERING INEQUALITY (Cavalcanti–Jones–Wiseman–Reid, PRA 2009):
 *         S_n = (1/√n) · |Σ_{k=1}^{n} ⟨Aₖ ⊗ Bₖ⟩|  ≤  1   for every LHS model,
 *      with n mutually-orthogonal measurement directions. The singlet violates it up to S_2 = √2 and
 *      S_3 = √3; a Werner state of visibility w gives S_n = w√n, so it is n-setting steerable exactly
 *      when w > 1/√n — the well-known critical visibilities 1/√2 ≈ 0.707 and 1/√3 ≈ 0.577.
 */

export type Vec3 = [number, number, number];
export type Mat3 = [Vec3, Vec3, Vec3];

/** A two-qubit state summarised by Alice/Bob Bloch vectors and the spin correlation matrix T_ij = ⟨σᵢ⊗σⱼ⟩. */
export interface TwoQubitData {
  a: Vec3; // Alice marginal Bloch vector
  b: Vec3; // Bob marginal Bloch vector
  T: Mat3; // correlation matrix
}

/** Werner state ρ = w|Ψ⁻⟩⟨Ψ⁻| + (1−w)·I/4: unbiased marginals, isotropic anti-correlation T = −w·I. */
export function wernerData(w: number): TwoQubitData {
  return { a: [0, 0, 0], b: [0, 0, 0], T: [[-w, 0, 0], [0, -w, 0], [0, 0, -w]] };
}

/** Pure partially-entangled state |ψ(θ)⟩ = cosθ|00⟩ + sinθ|11⟩ (θ=π/4 ⇒ maximally entangled). */
export function pureData(theta: number): TwoQubitData {
  const s2 = Math.sin(2 * theta), c2 = Math.cos(2 * theta);
  return { a: [0, 0, c2], b: [0, 0, c2], T: [[s2, 0, 0], [0, -s2, 0], [0, 0, 1]] };
}

// 3×3 helpers.
const transpose3 = (M: Mat3): Mat3 => [[M[0][0], M[1][0], M[2][0]], [M[0][1], M[1][1], M[2][1]], [M[0][2], M[1][2], M[2][2]]];
const mul3 = (X: Mat3, Y: Mat3): Mat3 => {
  const R: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) R[i][j] += X[i][k] * Y[k][j];
  return R as Mat3;
};

/** Singular values of T (descending) = √eigenvalues(TᵀT), via the lab's symmetric eigensolver. */
export function correlationSingularValues(T: Mat3): [number, number, number] {
  const TtT = mul3(transpose3(T), T) as unknown as RealMat;
  const ev = eigenvalues(TtT); // descending
  return [Math.sqrt(Math.max(0, ev[0])), Math.sqrt(Math.max(0, ev[1])), Math.sqrt(Math.max(0, ev[2]))];
}

export interface SteeringEllipsoid {
  /** Centre of Bob's steering ellipsoid inside the Bloch ball. */
  center: Vec3;
  /** Semi-axis lengths (descending). */
  semiAxes: [number, number, number];
  /** Volume relative to the full Bloch ball (1 = fills it; 0 = a point). */
  relativeVolume: number;
}

/**
 * Bob's steering ellipsoid (the states Alice can steer Bob to). Jevtic et al.:
 *   centre  c = (b − Tᵀa)/(1 − |a|²),
 *   matrix  Q = (1/(1−|a|²)) (Tᵀ − b aᵀ)( I + aaᵀ/(1−|a|²) )(T − a bᵀ),  semi-axes = √eig(Q).
 */
export function steeringEllipsoid(data: TwoQubitData): SteeringEllipsoid {
  const { a, b, T } = data;
  const a2 = a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
  const g = 1 - a2;
  const Tt = transpose3(T);
  const center: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    let TtA = 0;
    for (let k = 0; k < 3; k++) TtA += Tt[i][k] * a[k];
    center[i] = g > 1e-12 ? (b[i] - TtA) / g : 0;
  }
  if (g <= 1e-12) {
    // Alice's marginal is pure (a product state from her side): the ellipsoid degenerates to a point.
    return { center: [b[0], b[1], b[2]], semiAxes: [0, 0, 0], relativeVolume: 0 };
  }
  // M1 = Tᵀ − b aᵀ ; M2 = I + aaᵀ/g ; M3 = T − a bᵀ ; Q = (1/g)·M1·M2·M3.
  const outer = (u: Vec3, v: Vec3): Mat3 => [[u[0] * v[0], u[0] * v[1], u[0] * v[2]], [u[1] * v[0], u[1] * v[1], u[1] * v[2]], [u[2] * v[0], u[2] * v[1], u[2] * v[2]]];
  const baT = outer(b, a);
  const abT = outer(a, b);
  const aaT = outer(a, a);
  const M1: Mat3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]] as Mat3;
  const M3: Mat3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]] as Mat3;
  const M2: Mat3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]] as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    M1[i][j] = Tt[i][j] - baT[i][j];
    M3[i][j] = T[i][j] - abT[i][j];
    M2[i][j] = (i === j ? 1 : 0) + aaT[i][j] / g;
  }
  const Qraw = mul3(mul3(M1, M2), M3);
  const Q: Mat3 = Qraw.map((row) => row.map((x) => x / g)) as Mat3;
  // Symmetrise (numerical) and take √eigenvalues as semi-axes.
  const Qsym: RealMat = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) Qsym[i][j] = 0.5 * (Q[i][j] + Q[j][i]);
  const ev = eigenvalues(Qsym);
  const semiAxes: [number, number, number] = [Math.sqrt(Math.max(0, ev[0])), Math.sqrt(Math.max(0, ev[1])), Math.sqrt(Math.max(0, ev[2]))];
  return { center, semiAxes, relativeVolume: semiAxes[0] * semiAxes[1] * semiAxes[2] };
}

/** The LHS bound on every CJWR linear steering inequality. */
export const LHS_BOUND = 1;

export interface CJWRResult {
  n: number;
  value: number;   // S_n
  steerable: boolean;
}

/** S_n = (1/√n)·(sum of the n largest singular values of T) — optimal over orthogonal settings. */
export function cjwrSteering(data: TwoQubitData, n: 2 | 3): CJWRResult {
  const sv = correlationSingularValues(data.T);
  let sum = 0;
  for (let k = 0; k < n; k++) sum += sv[k];
  const value = sum / Math.sqrt(n);
  return { n, value, steerable: value > LHS_BOUND + 1e-12 };
}

/** The critical Werner visibility for n-setting CJWR steerability: w > 1/√n. */
export function criticalVisibility(n: 2 | 3): number {
  return 1 / Math.sqrt(n);
}

export interface SteeringSweepPoint { w: number; S2: number; S3: number; }

/** Sweep the Werner visibility and report S_2, S_3 (for the violation plot). */
export function wernerSweep(steps = 101): SteeringSweepPoint[] {
  const out: SteeringSweepPoint[] = [];
  for (let i = 0; i < steps; i++) {
    const w = i / (steps - 1);
    const d = wernerData(w);
    out.push({ w, S2: cjwrSteering(d, 2).value, S3: cjwrSteering(d, 3).value });
  }
  return out;
}
