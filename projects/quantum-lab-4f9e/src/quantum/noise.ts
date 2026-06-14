import { Complex, C } from './Complex';
import type { Matrix } from './Matrix';

/**
 * Single-qubit quantum noise channels expressed as Kraus operator sets.
 * A channel acts on a density matrix as  ρ → Σ_k E_k ρ E_k†  with  Σ_k E_k† E_k = I.
 * These are the standard textbook channels (Nielsen & Chuang ch. 8).
 */
export type ChannelType =
  | 'depolarizing'
  | 'amplitude-damping'
  | 'phase-damping'
  | 'bit-flip'
  | 'phase-flip'
  | 'bit-phase-flip';

const I2: Matrix = [[C(1), C(0)], [C(0), C(1)]];
const X2: Matrix = [[C(0), C(1)], [C(1), C(0)]];
const Y2: Matrix = [[C(0), C(0, -1)], [C(0, 1), C(0)]];
const Z2: Matrix = [[C(1), C(0)], [C(0), C(-1)]];

function scaled(m: Matrix, s: number): Matrix {
  return m.map((row) => row.map((z) => z.scale(s)));
}

/** Kraus operators for a single-qubit channel at the given strength p ∈ [0,1]. */
export function krausOps(type: ChannelType, p: number): Matrix[] {
  const q = Math.max(0, Math.min(1, p));
  switch (type) {
    case 'depolarizing': {
      // ρ → (1-q)ρ + q·I/2.  K0=√(1-3q/4)I, K_{x,y,z}=√(q/4)σ.
      const a = Math.sqrt(Math.max(0, 1 - (3 * q) / 4));
      const b = Math.sqrt(q / 4);
      return [scaled(I2, a), scaled(X2, b), scaled(Y2, b), scaled(Z2, b)];
    }
    case 'amplitude-damping': {
      // Energy relaxation |1⟩→|0⟩ with probability γ=q.
      const g = q;
      const K0: Matrix = [[C(1), C(0)], [C(0), C(Math.sqrt(1 - g))]];
      const K1: Matrix = [[C(0), C(Math.sqrt(g))], [C(0), C(0)]];
      return [K0, K1];
    }
    case 'phase-damping': {
      // Loss of phase coherence without energy loss.
      const l = q;
      const K0: Matrix = [[C(1), C(0)], [C(0), C(Math.sqrt(1 - l))]];
      const K1: Matrix = [[C(0), C(0)], [C(0), C(Math.sqrt(l))]];
      return [K0, K1];
    }
    case 'bit-flip':
      return [scaled(I2, Math.sqrt(1 - q)), scaled(X2, Math.sqrt(q))];
    case 'phase-flip':
      return [scaled(I2, Math.sqrt(1 - q)), scaled(Z2, Math.sqrt(q))];
    case 'bit-phase-flip':
      return [scaled(I2, Math.sqrt(1 - q)), scaled(Y2, Math.sqrt(q))];
  }
}

export interface ChannelSpec {
  type: ChannelType;
  strength: number;
}

export interface NoiseModel {
  /** Channels applied (in order) after each gate. */
  channels: ChannelSpec[];
  /** Apply noise to just the qubits a gate touches, or to every qubit each step. */
  scope: 'touched' | 'all';
}

export const NO_NOISE: NoiseModel = { channels: [], scope: 'touched' };

export const CHANNEL_INFO: Record<ChannelType, { label: string; blurb: string }> = {
  'depolarizing': { label: 'Depolarizing', blurb: 'Mixes the qubit toward I/2 — the generic "white" noise.' },
  'amplitude-damping': { label: 'Amplitude damping', blurb: 'Energy relaxation T₁: |1⟩ decays toward |0⟩.' },
  'phase-damping': { label: 'Phase damping', blurb: 'Dephasing T₂: destroys coherence, conserves populations.' },
  'bit-flip': { label: 'Bit flip', blurb: 'Applies X with probability p.' },
  'phase-flip': { label: 'Phase flip', blurb: 'Applies Z with probability p.' },
  'bit-phase-flip': { label: 'Bit-phase flip', blurb: 'Applies Y with probability p.' },
};

export function isNoiseActive(m: NoiseModel): boolean {
  return m.channels.some((c) => c.strength > 1e-9);
}

// Re-export for callers that want raw Pauli matrices.
export const PAULI = { I: I2, X: X2, Y: Y2, Z: Z2 } as const;

/** Build a 2x2 complex matrix from a flat row-major number pair list (helper for tests). */
export function mat2(values: Complex[]): Matrix {
  return [[values[0], values[1]], [values[2], values[3]]];
}
