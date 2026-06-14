import { Complex, C } from './Complex';
import { hermitianEig, vonNeumannEntropy } from './Hermitian';
import type { QuantumState } from './QuantumState';

/**
 * Schmidt decomposition of a bipartite pure state.
 *
 * Any |ψ⟩ on a system split into parts A (qubits cut…n-1, the high bits) and B (qubits
 * 0…cut-1) can be written  |ψ⟩ = Σ_i λ_i |a_i⟩_A |b_i⟩_B  with λ_i ≥ 0, Σ λ_i² = 1. The
 * λ_i are the singular values of the amplitude matrix; equivalently λ_i² are the eigenvalues
 * of the reduced density matrix. The number of non-zero λ_i is the **Schmidt rank** (1 ⇔
 * separable across the cut) and S = -Σ λ_i² log₂ λ_i² is the entanglement entropy — so this
 * is the structural "why" behind the entropy number shown elsewhere in the app.
 */
export interface SchmidtResult {
  /** Schmidt coefficients λ_i, sorted descending (Σ λ_i² = 1). */
  coefficients: number[];
  /** Schmidt probabilities λ_i² = reduced-ρ eigenvalues, sorted descending. */
  weights: number[];
  /** Number of non-negligible coefficients. 1 ⇔ product state across the cut. */
  rank: number;
  /** Entanglement entropy S = -Σ λ_i² log₂ λ_i² (bits). */
  entropy: number;
  /** Dimension of the smaller subsystem (max possible Schmidt rank). */
  maxRank: number;
}

/**
 * Compute the Schmidt decomposition across the cut between qubits {0…cut-1} and {cut…n-1}.
 * Eigendecomposes the reduced density matrix of whichever side is smaller (≤ 2^⌊n/2⌋).
 */
export function schmidtDecompose(state: QuantumState, cut: number, eps = 1e-9): SchmidtResult {
  const n = state.numQubits;
  const amps = state.amplitudes;
  const rightSize = 1 << (n - cut); // subsystem B (low bits)
  const leftSize = 1 << cut;        // subsystem A (high bits)

  // Reduce whichever subsystem has the smaller dimension to keep the eigensolve cheap.
  const reduceLeft = leftSize <= rightSize;
  const dim = reduceLeft ? leftSize : rightSize;
  const rho: Complex[][] = Array.from({ length: dim }, () =>
    Array.from({ length: dim }, () => C(0)),
  );

  if (reduceLeft) {
    for (let a = 0; a < leftSize; a++) {
      for (let ap = 0; ap < leftSize; ap++) {
        let acc = C(0);
        for (let b = 0; b < rightSize; b++) {
          acc = acc.add(amps[a * rightSize + b].mul(amps[ap * rightSize + b].conj()));
        }
        rho[a][ap] = acc;
      }
    }
  } else {
    for (let b = 0; b < rightSize; b++) {
      for (let bp = 0; bp < rightSize; bp++) {
        let acc = C(0);
        for (let a = 0; a < leftSize; a++) {
          acc = acc.add(amps[a * rightSize + b].mul(amps[a * rightSize + bp].conj()));
        }
        rho[b][bp] = acc;
      }
    }
  }

  const eig = hermitianEig(rho);
  const weights = eig.values.map((v) => Math.max(0, v));
  const coefficients = weights.map((w) => Math.sqrt(w));
  const rank = weights.filter((w) => w > eps).length;
  const entropy = vonNeumannEntropy(weights);
  return { coefficients, weights, rank, entropy, maxRank: dim };
}
