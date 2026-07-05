/**
 * From a Hartree–Fock solution to a **qubit Hamiltonian** — the bridge that lets a quantum
 * computer (or, here, the lab's state-vector simulator) find molecular energies.
 *
 * The molecular electronic Hamiltonian in second quantisation is
 *
 *     H = Σ_PQ  h_PQ a†_P a_Q  +  ½ Σ_PQRS ⟨PQ|RS⟩ a†_P a†_Q a_S a_R
 *
 * over spin-orbitals P = (spatial p, spin σ), with h and ⟨·⟩ the MO integrals from `scf.ts`.
 * Jordan–Wigner maps every fermionic operator to Pauli strings; expanding and collecting
 * gives a real, Hermitian Pauli Hamiltonian (for H₂ this is the famous 15-term operator).
 *
 * We also build the **UCCSD excitation generators** — the anti-Hermitian singles/doubles
 * that a Variational Quantum Eigensolver exponentiates to prepare a correlated trial state.
 */

import { type SCFResult } from './scf';
import {
  type PauliSum, type PauliTerm, psAdd, psScale, psMul, single, jwProduct, toPauliTerms,
} from './pauli';

/** Spin-orbital index for spatial orbital `p` and spin `s` (0 = ↑, 1 = ↓). */
function so(p: number, s: number): number { return 2 * p + s; }

/** The qubit Hamiltonian, plus the constant (nuclear-repulsion) shift to add to every energy. */
export interface QubitHamiltonian {
  /** Number of qubits = number of spin-orbitals = 2 × nBasis. */
  nQubits: number;
  /** Real Pauli terms (identity folded into `constant`). */
  terms: PauliTerm[];
  /** Constant energy offset (electronic identity term + nuclear repulsion). */
  constant: number;
  /** HF reference occupation: spin-orbital indices that are filled in |HF⟩. */
  hfOccupation: number[];
}

/** Build the Jordan–Wigner qubit Hamiltonian from an RHF solution. */
export function buildQubitHamiltonian(scf: SCFResult): QubitHamiltonian {
  const nOrb = scf.nBasis;
  const M = 2 * nOrb;
  let H: PauliSum = new Map();

  // One-electron:  Σ_pq Σ_σ h_pq a†_{pσ} a_{qσ}
  for (let p = 0; p < nOrb; p++)
    for (let q = 0; q < nOrb; q++) {
      const h = scf.hMO[p][q];
      if (Math.abs(h) < 1e-14) continue;
      for (let s = 0; s < 2; s++)
        H = psAdd(H, psScale(jwProduct(M, [{ kind: 'c', mode: so(p, s) }, { kind: 'a', mode: so(q, s) }]), { re: h, im: 0 }));
    }

  // Two-electron (physicist notation): ½ Σ_PQRS ⟨PQ|RS⟩ a†_P a†_Q a_S a_R,
  // with ⟨PQ|RS⟩ = (p r | q s)_chem × δ(σ_P,σ_R) δ(σ_Q,σ_S).
  for (let p = 0; p < nOrb; p++)
    for (let q = 0; q < nOrb; q++)
      for (let r = 0; r < nOrb; r++)
        for (let sOrb = 0; sOrb < nOrb; sOrb++) {
          const g = scf.eriMO[p][r][q][sOrb]; // (pr|qs) chemist
          if (Math.abs(g) < 1e-14) continue;
          for (let sp = 0; sp < 2; sp++)
            for (let sq = 0; sq < 2; sq++) {
              const P = so(p, sp), Q = so(q, sq), R = so(r, sp), S = so(sOrb, sq);
              const term = jwProduct(M, [
                { kind: 'c', mode: P }, { kind: 'c', mode: Q },
                { kind: 'a', mode: S }, { kind: 'a', mode: R },
              ]);
              H = psAdd(H, psScale(term, { re: 0.5 * g, im: 0 }));
            }
        }

  const { terms, constant } = toPauliTerms(H);
  const hfOccupation = Array.from({ length: scf.nElectrons }, (_, i) => i); // lowest spin-orbitals
  return { nQubits: M, terms, constant: constant + scf.nuclearRepulsion, hfOccupation };
}

/**
 * A number-operator penalty μ·(N̂ − N)² as Pauli terms, where N̂ = Σᵢ (I − Zᵢ)/2 counts
 * filled spin-orbitals. Added to the Hamiltonian it lifts every wrong-electron-number sector
 * by ≥ μ while leaving the physical N-electron sector untouched — so exact diagonalisation of
 * H + penalty returns the *chemically correct* (fixed particle number) ground state, i.e. FCI.
 * The identity part is kept as an explicit term so the caller can pass everything to
 * `exactGroundEnergy` unchanged.
 */
export function numberPenaltyTerms(nQubits: number, nElectrons: number, mu = 20): PauliTerm[] {
  const I = 'I'.repeat(nQubits);
  // N̂ = Σᵢ (½ I − ½ Zᵢ)
  let N: PauliSum = new Map();
  for (let i = 0; i < nQubits; i++) {
    N = psAdd(N, new Map([[I, { re: 0.5, im: 0 }]]));
    N = psAdd(N, single(nQubits, i, 'Z', { re: -0.5, im: 0 }));
  }
  // N̂ − N·I
  const shifted = psAdd(N, new Map([[I, { re: -nElectrons, im: 0 }]]));
  const penalty = psScale(psMul(shifted, shifted, nQubits), { re: mu, im: 0 });
  const { terms, constant } = toPauliTerms(penalty);
  return [...terms, { coeff: constant, ops: {} }]; // keep the identity part explicit
}

/** One UCCSD excitation generator, expressed for exp(θ·G) with G = i·Σ cₖ·Pₖ (anti-Hermitian). */
export interface Excitation {
  /** Human label, e.g. "double 0,1→2,3" (spin-orbital indices). */
  label: string;
  /** 'single' or 'double'. */
  kind: 'single' | 'double';
  /** The Pauli strings and their real coefficients cₖ (the imaginary part of G's Pauli sum). */
  strings: { key: string; coeff: number }[];
}

/**
 * Spin-conserving UCCSD singles and doubles from the HF reference. Each is the anti-Hermitian
 * generator κ − κ† mapped through Jordan–Wigner. Because κ − κ† is anti-Hermitian, its Pauli
 * coefficients are pure-imaginary; we return the real cₖ so exp(θG) = ∏ₖ exp(iθcₖ Pₖ).
 */
export function uccsdExcitations(scf: SCFResult): Excitation[] {
  const nOrb = scf.nBasis;
  const M = 2 * nOrb;
  const nocc = scf.nElectrons;
  const occ = Array.from({ length: nocc }, (_, i) => i);
  const virt = Array.from({ length: M - nocc }, (_, i) => nocc + i);
  const excitations: Excitation[] = [];

  const emit = (sum: PauliSum, label: string, kind: 'single' | 'double') => {
    const strings: { key: string; coeff: number }[] = [];
    for (const [key, v] of sum) {
      if (Math.abs(v.im) < 1e-12) continue; // anti-Hermitian ⇒ imaginary coefficients
      strings.push({ key, coeff: v.im });
    }
    if (strings.length) excitations.push({ label, kind, strings });
  };

  // Singles: a†_a a_i − a†_i a_a  (spin conserving ⇒ same parity).
  for (const i of occ)
    for (const a of virt) {
      if (i % 2 !== a % 2) continue;
      let g = jwProduct(M, [{ kind: 'c', mode: a }, { kind: 'a', mode: i }]);
      g = psAdd(g, psScale(jwProduct(M, [{ kind: 'c', mode: i }, { kind: 'a', mode: a }]), { re: -1, im: 0 }));
      emit(g, `single ${i}→${a}`, 'single');
    }

  // Doubles: a†_a a†_b a_j a_i − h.c.
  for (let x = 0; x < occ.length; x++)
    for (let y = x + 1; y < occ.length; y++)
      for (let u = 0; u < virt.length; u++)
        for (let w = u + 1; w < virt.length; w++) {
          const i = occ[x], j = occ[y], a = virt[u], b = virt[w];
          // Spin must be conserved overall: {σ_i,σ_j} as a multiset equals {σ_a,σ_b}.
          const spinIn = [i % 2, j % 2].sort().join('');
          const spinOut = [a % 2, b % 2].sort().join('');
          if (spinIn !== spinOut) continue;
          let g = jwProduct(M, [
            { kind: 'c', mode: a }, { kind: 'c', mode: b }, { kind: 'a', mode: j }, { kind: 'a', mode: i },
          ]);
          g = psAdd(g, psScale(jwProduct(M, [
            { kind: 'c', mode: i }, { kind: 'c', mode: j }, { kind: 'a', mode: b }, { kind: 'a', mode: a },
          ]), { re: -1, im: 0 }));
          emit(g, `double ${i},${j}→${a},${b}`, 'double');
        }

  return excitations;
}
