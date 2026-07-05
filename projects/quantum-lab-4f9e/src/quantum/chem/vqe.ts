/**
 * The variational quantum eigensolver, wired to real molecules.
 *
 * The state-vector simulator plays the role of the quantum processor: it prepares the
 * Hartree–Fock reference |HF⟩ (a computational basis state), then applies a **UCCSD** ansatz
 * — a product of exponentiated singles/doubles excitation generators exp(θ·G) — to build a
 * correlated trial state. A classical Nelder–Mead optimiser tunes the angles θ to minimise
 * ⟨ψ(θ)|H|ψ(θ)⟩. The minimum is the molecule's ground-state energy, and for these minimal
 * bases it reaches the exact (FCI) answer — recovering the electron-correlation energy that
 * Hartree–Fock misses.
 */

import { Complex } from '../Complex';
import { QuantumState } from '../QuantumState';
import { expectation, exactGroundEnergy, nelderMead } from '../variational';
import { runRHF, type SCFResult } from './scf';
import { buildQubitHamiltonian, uccsdExcitations, numberPenaltyTerms, type Excitation, type QubitHamiltonian } from './hamiltonian';
import { type Molecule } from './molecules';
import { type PauliTerm } from './pauli';

/** Prepare |HF⟩ by flipping the occupied spin-orbital qubits from |0…0⟩. */
export function hartreeFockState(nQubits: number, occupation: number[]): QuantumState {
  const s = new QuantumState(nQubits);
  for (const q of occupation) s.applyGate({ name: 'X', qubits: [q] });
  return s;
}

/** Apply exp(i·angle·P) for a single Pauli string P (using exp(iθP) = cosθ·I + i·sinθ·P). */
function applyPauliRotation(state: QuantumState, angle: number, key: string): void {
  const c = Math.cos(angle), sn = Math.sin(angle);
  const p = state.clone();
  for (let q = 0; q < key.length; q++) {
    const ch = key[q];
    if (ch !== 'I') p.applyGate({ name: ch, qubits: [q] });
  }
  for (let i = 0; i < state.amplitudes.length; i++) {
    const o = state.amplitudes[i], pv = p.amplitudes[i];
    // c·o + i·sn·(P|ψ⟩)
    state.amplitudes[i] = new Complex(c * o.re - sn * pv.im, c * o.im + sn * pv.re);
  }
}

/** Apply a full UCCSD excitation generator exp(θ·G) = ∏ₖ exp(iθcₖ Pₖ). */
function applyExcitation(state: QuantumState, exc: Excitation, theta: number): void {
  for (const { key, coeff } of exc.strings) applyPauliRotation(state, theta * coeff, key);
}

/** Build the UCCSD trial state |ψ(θ)⟩ for a set of excitation amplitudes. */
export function ansatzState(
  nQubits: number, occupation: number[], excitations: Excitation[], thetas: number[],
): QuantumState {
  const s = hartreeFockState(nQubits, occupation);
  for (let i = 0; i < excitations.length; i++) applyExcitation(s, excitations[i], thetas[i]);
  return s;
}

/** Everything computed at one molecular geometry. */
export interface MoleculePoint {
  param: number;
  scf: SCFResult;
  hamiltonian: QubitHamiltonian;
  excitations: Excitation[];
  /** Hartree–Fock total energy. */
  hf: number;
  /** Exact (FCI) total energy, or null if too large to diagonalise here. */
  fci: number | null;
}

/** Solve one geometry: RHF, the qubit Hamiltonian, and (if small enough) FCI. */
export function solvePoint(mol: Molecule, param: number): MoleculePoint {
  const atoms = mol.geometry(param);
  const scf = runRHF(atoms, mol.nElectrons);
  const hamiltonian = buildQubitHamiltonian(scf);
  const excitations = uccsdExcitations(scf);
  const canFCI = mol.correlated && hamiltonian.nQubits <= 6;
  // Restrict the exact diagonalisation to the physical electron-number sector with a penalty,
  // otherwise the global ground state can live in a wrong-particle-number sector.
  const fci = canFCI
    ? exactGroundEnergy(hamiltonian.nQubits, [
        ...(hamiltonian.terms as PauliTerm[]),
        ...(numberPenaltyTerms(hamiltonian.nQubits, mol.nElectrons) as PauliTerm[]),
      ]) + hamiltonian.constant
    : null;
  return { param, scf, hamiltonian, excitations, hf: scf.total, fci };
}

export interface VQEChemResult {
  /** Optimised total energy. */
  energy: number;
  /** Exact FCI energy for comparison. */
  fci: number;
  /** Hartree–Fock energy (the starting point). */
  hf: number;
  /** Correlation energy recovered = HF − VQE. */
  correlation: number;
  /** Best-so-far energy at each optimiser evaluation (for a convergence plot). */
  history: number[];
  /** Optimised excitation amplitudes. */
  thetas: number[];
  /** Number of variational parameters. */
  nParams: number;
}

/**
 * Run VQE at one geometry with the UCCSD ansatz. Returns the converged energy and the full
 * convergence trace. Requires a correlated (≤6-qubit) molecule.
 */
export function runVQEChem(mol: Molecule, param: number): VQEChemResult {
  const point = solvePoint(mol, param);
  const { hamiltonian, excitations, scf } = point;
  const terms = hamiltonian.terms as PauliTerm[];
  const fci = point.fci ?? scf.total;
  const nParams = Math.max(excitations.length, 1);

  const history: number[] = [];
  let best = Infinity;
  const energy = (thetas: number[]): number => {
    const psi = ansatzState(hamiltonian.nQubits, hamiltonian.hfOccupation, excitations, thetas);
    const e = expectation(psi, terms) + hamiltonian.constant;
    best = Math.min(best, e);
    history.push(best);
    return e;
  };

  const x0 = new Array(nParams).fill(0);
  // A short multi-start guards against Nelder–Mead stalling in a flat region at θ = 0.
  let bestRes = nelderMead(energy, x0, { maxIter: 400, step: 0.35 });
  for (const seed of [0.1, -0.1]) {
    const res = nelderMead(energy, x0.map(() => seed), { maxIter: 200, step: 0.3 });
    if (res.fx < bestRes.fx) bestRes = res;
  }

  const vqeEnergy = bestRes.fx;
  return {
    energy: vqeEnergy,
    fci,
    hf: point.hf,
    correlation: point.hf - vqeEnergy,
    history,
    thetas: bestRes.x,
    nParams,
  };
}

export interface CurvePoint {
  param: number;
  /** Distance in Å (for display); equals param×bohr for diatomics. */
  hf: number;
  fci: number | null;
}

/**
 * Trace the potential-energy surface: Hartree–Fock (always) and FCI (for correlated
 * ≤6-qubit molecules) across the geometry range.
 */
export function dissociationCurve(mol: Molecule, samples = 40): CurvePoint[] {
  if (mol.range[0] === mol.range[1]) return []; // single atom — no curve
  const pts: CurvePoint[] = [];
  for (let i = 0; i < samples; i++) {
    const t = mol.range[0] + ((mol.range[1] - mol.range[0]) * i) / (samples - 1);
    const p = solvePoint(mol, t);
    pts.push({ param: t, hf: p.hf, fci: p.fci });
  }
  return pts;
}

/** Locate the equilibrium geometry (curve minimum) on the best available energy curve. */
export function equilibrium(curve: CurvePoint[]): { param: number; energy: number } | null {
  if (!curve.length) return null;
  let best = curve[0];
  let bestE = curve[0].fci ?? curve[0].hf;
  for (const p of curve) {
    const e = p.fci ?? p.hf;
    if (e < bestE) { bestE = e; best = p; }
  }
  return { param: best.param, energy: bestE };
}

/**
 * Refine the equilibrium bond length with a fine local scan around the coarse curve minimum,
 * so the reported bond length is accurate to the underlying method rather than the sampling.
 * The scan uses the cheap Hartree–Fock energy (whose minimum tracks the exact one closely);
 * a single exact evaluation at the refined geometry gives the reported energy.
 */
export function refinedEquilibrium(mol: Molecule, coarse: number): { param: number; energy: number } {
  const span = (mol.range[1] - mol.range[0]) / 12;
  const lo = Math.max(mol.range[0], coarse - span), hi = Math.min(mol.range[1], coarse + span);
  let bestParam = coarse, bestHF = Infinity;
  const N = 40;
  for (let i = 0; i <= N; i++) {
    const p = lo + ((hi - lo) * i) / N;
    const e = runRHF(mol.geometry(p), mol.nElectrons).total;
    if (e < bestHF) { bestHF = e; bestParam = p; }
  }
  const pt = solvePoint(mol, bestParam);
  return { param: bestParam, energy: pt.fci ?? pt.hf };
}
