/**
 * A from-scratch Gaussian-basis molecular-integral engine — the numerical foundation of
 * quantum chemistry, built with no external libraries (not even a Boys-function table).
 *
 * The lab restricts itself to **s-type** contracted Gaussians (the STO-3G 1s functions of
 * hydrogen and helium). That is not a toy simplification: with only s primitives every
 * molecular integral — overlap, kinetic energy, electron–nucleus attraction and the
 * four-index electron–electron repulsion — collapses to a *closed form* in the Boys
 * function F₀, so the whole engine is exact analytic arithmetic rather than quadrature.
 * That still covers a remarkably rich chemistry: H₂, HeH⁺, H₃⁺, He and hydrogen chains.
 *
 * Everything here is checked against textbook numbers: for H₂ at R = 1.4 a₀ the engine
 * reproduces Szabo & Ostlund's integrals (S₁₂ = 0.6593, T₁₁ = 0.7600, (11|11) = 0.7746)
 * to all printed digits, and the downstream Hartree–Fock energy lands on −1.1167 Eₕ.
 */

/** Elements the s-only STO-3G basis supports. */
export type Element = 'H' | 'He';

/** A nucleus: element symbol and a position in bohr (atomic units of length, a₀). */
export interface Atom {
  el: Element;
  pos: [number, number, number];
}

/** Nuclear charge of each supported element. */
export const NUCLEAR_CHARGE: Record<Element, number> = { H: 1, He: 2 };

/**
 * STO-3G contraction of a Slater 1s orbital by three Gaussians. The contraction
 * coefficients are shared across elements; only the exponents differ (they encode the
 * element's optimal Slater exponent ζ). Values are the canonical Hehre–Stewart–Pople set.
 */
const STO3G_COEFFS = [0.15432897, 0.53532814, 0.44463454];
const STO3G_EXPONENTS: Record<Element, number[]> = {
  H: [3.42525091, 0.62391373, 0.16885540],
  He: [6.36242139, 1.15892300, 0.31364979],
};

/** A contracted s-type basis function centred on one atom. */
export interface BasisFunction {
  center: [number, number, number];
  /** Primitive Gaussian exponents α_i (exp(−α_i r²)). */
  exps: number[];
  /** Contraction coefficients folded with primitive normalisation and overall normalisation. */
  coeffs: number[];
  /** Index of the owning atom (used to pretty-print the basis). */
  atom: number;
}

/** The Boys function of order zero, F₀(x) = ∫₀¹ e^(−x t²) dt = ½√(π/x)·erf(√x). */
export function boys0(x: number): number {
  if (x < 1e-12) return 1 - x / 3; // stable small-x limit
  return 0.5 * Math.sqrt(Math.PI / x) * erf(Math.sqrt(x));
}

/** Error function (Abramowitz & Stegun 7.1.26), accurate to ~1e-7 — plenty for chemistry. */
export function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
}

/** Normalisation of a primitive s-Gaussian exp(−α r²): (2α/π)^(3/4). */
function primNorm(a: number): number {
  return Math.pow((2 * a) / Math.PI, 0.75);
}

function dist2(a: number[], b: number[]): number {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

// ---- Primitive integrals (unnormalised Gaussians, closed forms for s-orbitals) -----------

/** Overlap ⟨a|b⟩ of two primitive s-Gaussians. */
function sPrim(a: number, A: number[], b: number, B: number[]): number {
  const p = a + b;
  const K = Math.exp((-a * b / p) * dist2(A, B));
  return Math.pow(Math.PI / p, 1.5) * K;
}

/** Kinetic energy ⟨a|−½∇²|b⟩ (closed form ξ(3−2ξR²)·S). */
function tPrim(a: number, A: number[], b: number, B: number[]): number {
  const p = a + b;
  const xi = (a * b) / p;
  const r2 = dist2(A, B);
  return xi * (3 - 2 * xi * r2) * Math.pow(Math.PI / p, 1.5) * Math.exp(-xi * r2);
}

/** Nuclear-attraction ⟨a| −Z/|r−C| |b⟩ to a nucleus of charge Z at C. */
function vPrim(a: number, A: number[], b: number, B: number[], C: number[], Z: number): number {
  const p = a + b;
  const K = Math.exp((-a * b / p) * dist2(A, B));
  const P = [(a * A[0] + b * B[0]) / p, (a * A[1] + b * B[1]) / p, (a * A[2] + b * B[2]) / p];
  return -Z * ((2 * Math.PI) / p) * K * boys0(p * dist2(P, C));
}

/** Two-electron repulsion (ab|cd) in chemist notation over four primitive s-Gaussians. */
function eriPrim(
  a: number, A: number[], b: number, B: number[],
  c: number, C: number[], d: number, D: number[],
): number {
  const p = a + b, q = c + d;
  const P = [(a * A[0] + b * B[0]) / p, (a * A[1] + b * B[1]) / p, (a * A[2] + b * B[2]) / p];
  const Q = [(c * C[0] + d * D[0]) / q, (c * C[1] + d * D[1]) / q, (c * C[2] + d * D[2]) / q];
  const Kab = Math.exp((-a * b / p) * dist2(A, B));
  const Kcd = Math.exp((-c * d / q) * dist2(C, D));
  const alpha = (p * q) / (p + q);
  return (
    (2 * Math.pow(Math.PI, 2.5)) / (p * q * Math.sqrt(p + q)) *
    Kab * Kcd * boys0(alpha * dist2(P, Q))
  );
}

/** Contract a two-centre primitive integral over both STO-3G expansions. */
function contract2(
  f: (a: number, A: number[], b: number, B: number[]) => number,
  bi: BasisFunction, bj: BasisFunction,
): number {
  let v = 0;
  for (let i = 0; i < bi.exps.length; i++)
    for (let j = 0; j < bj.exps.length; j++)
      v += bi.coeffs[i] * bj.coeffs[j] * f(bi.exps[i], bi.center, bj.exps[j], bj.center);
  return v;
}

/** Build the (normalised, contracted) basis for a molecule: one 1s function per atom. */
export function buildBasis(atoms: Atom[]): BasisFunction[] {
  return atoms.map((at, atomIdx) => {
    const exps = STO3G_EXPONENTS[at.el];
    const raw = exps.map((a, i) => STO3G_COEFFS[i] * primNorm(a));
    // Normalise the contracted function: enforce ⟨φ|φ⟩ = 1.
    let self = 0;
    for (let i = 0; i < exps.length; i++)
      for (let j = 0; j < exps.length; j++)
        self += raw[i] * raw[j] * sPrim(exps[i], at.pos, exps[j], at.pos);
    const norm = 1 / Math.sqrt(self);
    return { center: at.pos, exps, coeffs: raw.map((c) => c * norm), atom: atomIdx };
  });
}

/** Dense one-electron integrals over a basis: overlap S, kinetic T, and core Hcore = T + V. */
export interface OneElectron {
  S: number[][];
  T: number[][];
  V: number[][];
  Hcore: number[][];
}

export function oneElectronIntegrals(basis: BasisFunction[], atoms: Atom[]): OneElectron {
  const n = basis.length;
  const S = zeros(n), T = zeros(n), V = zeros(n), Hcore = zeros(n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      S[i][j] = contract2(sPrim, basis[i], basis[j]);
      T[i][j] = contract2(tPrim, basis[i], basis[j]);
      let v = 0;
      for (const at of atoms) {
        const Z = NUCLEAR_CHARGE[at.el];
        for (let p = 0; p < basis[i].exps.length; p++)
          for (let q = 0; q < basis[j].exps.length; q++)
            v += basis[i].coeffs[p] * basis[j].coeffs[q] *
              vPrim(basis[i].exps[p], basis[i].center, basis[j].exps[q], basis[j].center, at.pos, Z);
      }
      V[i][j] = v;
      Hcore[i][j] = T[i][j] + v;
    }
  }
  return { S, T, V, Hcore };
}

/** Dense four-index electron-repulsion tensor in chemist notation (ij|kl). */
export function twoElectronIntegrals(basis: BasisFunction[]): number[][][][] {
  const n = basis.length;
  const eri: number[][][][] = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => Array.from({ length: n }, () => new Array(n).fill(0))));
  // Fold the 8-fold permutational symmetry (ij|kl) = (ji|kl) = (kl|ij) … into one unique loop.
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++)
      for (let k = 0; k < n; k++)
        for (let l = 0; l <= k; l++) {
          if (i * (i + 1) / 2 + j < k * (k + 1) / 2 + l) continue;
          const bi = basis[i], bj = basis[j], bk = basis[k], bl = basis[l];
          let v = 0;
          for (let a = 0; a < bi.exps.length; a++)
            for (let b = 0; b < bj.exps.length; b++)
              for (let c = 0; c < bk.exps.length; c++)
                for (let d = 0; d < bl.exps.length; d++)
                  v += bi.coeffs[a] * bj.coeffs[b] * bk.coeffs[c] * bl.coeffs[d] *
                    eriPrim(bi.exps[a], bi.center, bj.exps[b], bj.center,
                            bk.exps[c], bk.center, bl.exps[d], bl.center);
          // Scatter to all 8 symmetry-related entries.
          eri[i][j][k][l] = v; eri[j][i][k][l] = v; eri[i][j][l][k] = v; eri[j][i][l][k] = v;
          eri[k][l][i][j] = v; eri[l][k][i][j] = v; eri[k][l][j][i] = v; eri[l][k][j][i] = v;
        }
  return eri;
}

/** Classical nucleus–nucleus repulsion Σ_{A<B} Z_A Z_B / R_AB (in hartree). */
export function nuclearRepulsion(atoms: Atom[]): number {
  let e = 0;
  for (let i = 0; i < atoms.length; i++)
    for (let j = i + 1; j < atoms.length; j++)
      e += (NUCLEAR_CHARGE[atoms[i].el] * NUCLEAR_CHARGE[atoms[j].el]) /
        Math.sqrt(dist2(atoms[i].pos, atoms[j].pos));
  return e;
}

function zeros(n: number): number[][] {
  return Array.from({ length: n }, () => new Array(n).fill(0));
}
