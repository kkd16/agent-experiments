/**
 * Restricted Hartree–Fock (RHF) self-consistent field, from scratch.
 *
 * RHF is the mean-field workhorse of electronic structure: every electron moves in the
 * averaged field of the others, so the many-body problem becomes a *self-consistent*
 * one-electron eigenproblem (the Roothaan equations F C = S C ε). We solve it in a
 * symmetrically-orthogonalised basis (Löwdin's S^{−1/2}) using the lab's own complex
 * Hermitian eigensolver, iterating the Fock matrix to convergence.
 *
 * The output is not just an energy: it is the full molecular-orbital picture (coefficients,
 * orbital energies) plus the one- and two-electron integrals *transformed into the MO basis*
 * — exactly the ingredients the second-quantised, Jordan–Wigner-mapped qubit Hamiltonian
 * needs downstream.
 */

import { Complex, C } from '../Complex';
import { hermitianEig } from '../Hermitian';
import {
  type Atom, buildBasis, oneElectronIntegrals, twoElectronIntegrals, nuclearRepulsion,
} from './integrals';

/** Ascending eigen-decomposition of a real symmetric matrix (via the complex Hermitian solver). */
export function symEig(m: number[][]): { values: number[]; vectors: number[][] } {
  const n = m.length;
  const cm: Complex[][] = m.map((row) => row.map((x) => C(x)));
  const { values, vectors } = hermitianEig(cm); // values DESCENDING, vectors columns
  // Re-sort ascending and drop the (zero) imaginary parts of the real eigenvectors.
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const vals = order.map((i) => values[i]);
  const vecs: number[][] = Array.from({ length: n }, (_, row) =>
    order.map((i) => vectors[row][i].re));
  return { values: vals, vectors: vecs }; // vectors[row][k] = component row of k-th eigenvector
}

/** The complete RHF solution plus everything the qubit Hamiltonian needs. */
export interface SCFResult {
  /** Total electronic energy (hartree, excludes nuclear repulsion). */
  electronic: number;
  /** Nuclear–nuclear repulsion (hartree). */
  nuclearRepulsion: number;
  /** Total RHF energy = electronic + nuclearRepulsion. */
  total: number;
  /** Number of basis functions / molecular orbitals. */
  nBasis: number;
  /** Number of electrons. */
  nElectrons: number;
  /** Orbital (MO) energies, ascending. */
  orbitalEnergies: number[];
  /** MO coefficients C[μ][p]: AO μ contribution to MO p. */
  C: number[][];
  /** One-electron integrals in the MO basis, h_pq. */
  hMO: number[][];
  /** Two-electron integrals in the MO basis, chemist notation (pq|rs). */
  eriMO: number[][][][];
  /** Whether the SCF converged. */
  converged: boolean;
  /** SCF energy at each iteration (for a convergence plot). */
  history: number[];
}

/**
 * Run RHF for a closed-shell molecule with `nElectrons` (must be even).
 * Uses a core-Hamiltonian initial guess and simple density iteration — robust for the
 * small minimal-basis systems the lab studies.
 */
export function runRHF(atoms: Atom[], nElectrons: number): SCFResult {
  const basis = buildBasis(atoms);
  const n = basis.length;
  const { S, Hcore } = oneElectronIntegrals(basis, atoms);
  const eri = twoElectronIntegrals(basis);
  const Enn = nuclearRepulsion(atoms);
  const nocc = nElectrons / 2;

  const X = symmetricOrthogonalizer(S);
  let P = zeros(n); // density matrix
  let electronic = 0;
  let converged = false;
  const history: number[] = [];
  let C_mo = zeros(n);
  let orbitalEnergies = new Array(n).fill(0);

  for (let iter = 0; iter < 200; iter++) {
    const F = buildFock(Hcore, P, eri, n);
    // Transform to the orthogonal basis, diagonalise, transform MOs back.
    const Fp = mul(mul(transpose(X), F), X);
    const { values, vectors } = symEig(Fp);
    orbitalEnergies = values;
    C_mo = mul(X, vectors); // C[μ][p]
    // Build the new density from the occupied orbitals.
    const Pnew = zeros(n);
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        let s = 0;
        for (let a = 0; a < nocc; a++) s += 2 * C_mo[i][a] * C_mo[j][a];
        Pnew[i][j] = s;
      }
    let Enew = 0;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) Enew += 0.5 * Pnew[i][j] * (Hcore[i][j] + F[i][j]);
    history.push(Enew + Enn);
    if (Math.abs(Enew - electronic) < 1e-11) {
      electronic = Enew; converged = true; break;
    }
    electronic = Enew; P = Pnew;
  }

  // Transform the integrals into the MO basis for the second-quantised Hamiltonian.
  const hMO = transformOne(Hcore, C_mo, n);
  const eriMO = transformTwo(eri, C_mo, n);

  return {
    electronic, nuclearRepulsion: Enn, total: electronic + Enn,
    nBasis: n, nElectrons, orbitalEnergies, C: C_mo, hMO, eriMO, converged, history,
  };
}

/** Fock matrix F = Hcore + G, with G_ij = Σ_kl P_kl [(ij|lk) − ½(ik|lj)]. */
function buildFock(Hcore: number[][], P: number[][], eri: number[][][][], n: number): number[][] {
  const F = zeros(n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      let g = 0;
      for (let k = 0; k < n; k++)
        for (let l = 0; l < n; l++)
          g += P[k][l] * (eri[i][j][l][k] - 0.5 * eri[i][k][l][j]);
      F[i][j] = Hcore[i][j] + g;
    }
  return F;
}

/** Löwdin symmetric orthogonaliser X = S^{−1/2} (so XᵀSX = I). */
function symmetricOrthogonalizer(S: number[][]): number[][] {
  const n = S.length;
  const { values, vectors } = symEig(S);
  const X = zeros(n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      let v = 0;
      for (let k = 0; k < n; k++) v += (vectors[i][k] * vectors[j][k]) / Math.sqrt(values[k]);
      X[i][j] = v;
    }
  return X;
}

/** One-electron AO→MO transform: h_pq = Σ_μν C_μp C_νq H_μν. */
function transformOne(H: number[][], Cc: number[][], n: number): number[][] {
  const h = zeros(n);
  for (let p = 0; p < n; p++)
    for (let q = 0; q < n; q++) {
      let s = 0;
      for (let mu = 0; mu < n; mu++)
        for (let nu = 0; nu < n; nu++) s += Cc[mu][p] * Cc[nu][q] * H[mu][nu];
      h[p][q] = s;
    }
  return h;
}

/** Four-index AO→MO transform, done as four O(n⁵) quarter-transforms (chemist notation). */
function transformTwo(eri: number[][][][], Cc: number[][], n: number): number[][][][] {
  const alloc = () => Array.from({ length: n }, () =>
    Array.from({ length: n }, () => Array.from({ length: n }, () => new Array(n).fill(0))));
  let t = eri;
  // Transform index 0.
  let out = alloc();
  for (let p = 0; p < n; p++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) for (let l = 0; l < n; l++) {
    let s = 0; for (let mu = 0; mu < n; mu++) s += Cc[mu][p] * t[mu][j][k][l]; out[p][j][k][l] = s;
  }
  t = out; out = alloc();
  for (let p = 0; p < n; p++) for (let q = 0; q < n; q++) for (let k = 0; k < n; k++) for (let l = 0; l < n; l++) {
    let s = 0; for (let nu = 0; nu < n; nu++) s += Cc[nu][q] * t[p][nu][k][l]; out[p][q][k][l] = s;
  }
  t = out; out = alloc();
  for (let p = 0; p < n; p++) for (let q = 0; q < n; q++) for (let r = 0; r < n; r++) for (let l = 0; l < n; l++) {
    let s = 0; for (let la = 0; la < n; la++) s += Cc[la][r] * t[p][q][la][l]; out[p][q][r][l] = s;
  }
  t = out; out = alloc();
  for (let p = 0; p < n; p++) for (let q = 0; q < n; q++) for (let r = 0; r < n; r++) for (let ss = 0; ss < n; ss++) {
    let s = 0; for (let si = 0; si < n; si++) s += Cc[si][ss] * t[p][q][r][si]; out[p][q][r][ss] = s;
  }
  return out;
}

function zeros(n: number): number[][] {
  return Array.from({ length: n }, () => new Array(n).fill(0));
}
function transpose(A: number[][]): number[][] {
  const n = A.length, m = A[0].length;
  const R = Array.from({ length: m }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) R[j][i] = A[i][j];
  return R;
}
function mul(A: number[][], B: number[][]): number[][] {
  const n = A.length, m = B[0].length, K = B.length;
  const R = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) { let s = 0; for (let k = 0; k < K; k++) s += A[i][k] * B[k][j]; R[i][j] = s; }
  return R;
}
