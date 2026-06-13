import { Complex, C } from './Complex';
import type { Matrix } from './Matrix';
// Matrix utilities used only in standalone functions (tree-shaken as needed)
import { getSingleGateMatrix } from './gates/single';
import { GATE_CNOT, GATE_CZ, GATE_SWAP, GATE_TOFFOLI, GATE_FREDKIN, gateCPhase } from './gates/multi';

export interface GateOp {
  name: string;
  qubits: number[];
  params?: number[];
}

export class QuantumState {
  public amplitudes: Complex[];
  public numQubits: number;

  constructor(numQubits: number) {
    this.numQubits = numQubits;
    const size = 1 << numQubits;
    this.amplitudes = Array.from({ length: size }, (_, i) => (i === 0 ? C(1) : C(0)));
  }

  static fromAmplitudes(amps: Complex[]): QuantumState {
    const n = Math.log2(amps.length);
    if (!Number.isInteger(n)) throw new Error('Amplitude vector length must be power of 2');
    const state = new QuantumState(n);
    state.amplitudes = [...amps];
    return state;
  }

  clone(): QuantumState {
    const s = new QuantumState(this.numQubits);
    s.amplitudes = this.amplitudes.map((a) => new Complex(a.re, a.im));
    return s;
  }

  norm(): number {
    return Math.sqrt(this.amplitudes.reduce((s, a) => s + a.abs2(), 0));
  }

  normalize(): void {
    const n = this.norm();
    if (n > 1e-12) this.amplitudes = this.amplitudes.map((a) => a.scale(1 / n));
  }

  probabilities(): number[] {
    return this.amplitudes.map((a) => a.abs2());
  }

  applyMatrix(matrix: Matrix, targetQubits: number[]): void {
    const n = this.numQubits;
    const size = 1 << n;
    const newAmps = Array.from({ length: size }, () => C(0));

    const numTargetQubits = targetQubits.length;
    const gateSize = 1 << numTargetQubits;

    // Sort qubits in descending order (high qubit index = more significant bit)
    const sortedTargets = [...targetQubits].sort((a, b) => b - a);

    for (let baseIdx = 0; baseIdx < size; baseIdx++) {
      // Extract bits for non-target qubits
      let isBase = true;
      for (const q of sortedTargets) {
        if ((baseIdx >> q) & 1) { isBase = false; break; }
      }
      if (!isBase) continue;

      // Enumerate all 2^k combinations of target qubit values
      for (let rowBits = 0; rowBits < gateSize; rowBits++) {
        let rowIdx = baseIdx;
        for (let bi = 0; bi < numTargetQubits; bi++) {
          const bit = (rowBits >> (numTargetQubits - 1 - bi)) & 1;
          rowIdx |= (bit << sortedTargets[bi]);
        }

        for (let colBits = 0; colBits < gateSize; colBits++) {
          let colIdx = baseIdx;
          for (let bi = 0; bi < numTargetQubits; bi++) {
            const bit = (colBits >> (numTargetQubits - 1 - bi)) & 1;
            colIdx |= (bit << sortedTargets[bi]);
          }
          newAmps[rowIdx] = newAmps[rowIdx].add(matrix[rowBits][colBits].mul(this.amplitudes[colIdx]));
        }
      }
    }

    this.amplitudes = newAmps;
  }

  applyGate(op: GateOp): void {
    const { name, qubits, params } = op;

    if (qubits.length === 1) {
      const m = getSingleGateMatrix(name, params);
      if (m) { this.applyMatrix(m, qubits); return; }
    }

    switch (name) {
      case 'CNOT': this.applyMatrix(GATE_CNOT, qubits); break;
      case 'CZ': this.applyMatrix(GATE_CZ, qubits); break;
      case 'SWAP': this.applyMatrix(GATE_SWAP, qubits); break;
      case 'Toffoli': this.applyMatrix(GATE_TOFFOLI, qubits); break;
      case 'Fredkin': this.applyMatrix(GATE_FREDKIN, qubits); break;
      case 'CPhase': this.applyMatrix(gateCPhase(params?.[0] ?? Math.PI / 2), qubits); break;
      default: console.warn(`Unknown gate: ${name}`);
    }
  }

  measure(qubit: number): { result: 0 | 1; newState: QuantumState } {
    const probOne = this.amplitudes.reduce((sum, amp, idx) => {
      return sum + ((idx >> qubit) & 1 ? amp.abs2() : 0);
    }, 0);

    const result: 0 | 1 = Math.random() < probOne ? 1 : 0;
    const newAmps = this.amplitudes.map((amp, idx) => {
      const bit = (idx >> qubit) & 1;
      return bit === result ? amp : C(0);
    });

    const newState = QuantumState.fromAmplitudes(newAmps);
    newState.normalize();
    return { result, newState };
  }

  measureAll(): { results: number[]; probabilities: number[] } {
    const probs = this.probabilities();
    const r = Math.random();
    let cumulative = 0;
    let outcome = 0;
    for (let i = 0; i < probs.length; i++) {
      cumulative += probs[i];
      if (r < cumulative) { outcome = i; break; }
    }
    const results = Array.from({ length: this.numQubits }, (_, q) => (outcome >> q) & 1);
    return { results, probabilities: probs };
  }

  blochVector(qubit: number): [number, number, number] {
    // Trace out all other qubits to get single-qubit reduced density matrix
    const size = 1 << this.numQubits;
    let rho00 = C(0), rho01 = C(0), rho10 = C(0), rho11 = C(0);

    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        const iOther = i & ~(1 << qubit);
        const jOther = j & ~(1 << qubit);
        if (iOther !== jOther) continue;

        const iBit = (i >> qubit) & 1;
        const jBit = (j >> qubit) & 1;
        const elem = this.amplitudes[i].mul(this.amplitudes[j].conj());

        if (iBit === 0 && jBit === 0) rho00 = rho00.add(elem);
        if (iBit === 0 && jBit === 1) rho01 = rho01.add(elem);
        if (iBit === 1 && jBit === 0) rho10 = rho10.add(elem);
        if (iBit === 1 && jBit === 1) rho11 = rho11.add(elem);
      }
    }

    // Bloch vector: x = 2*Re(rho01), y = 2*Im(rho10), z = rho00 - rho11
    const x = 2 * rho01.re;
    const y = 2 * rho10.im;
    const z = rho00.re - rho11.re;
    return [x, y, z];
  }

  getStateLabel(index: number): string {
    return '|' + index.toString(2).padStart(this.numQubits, '0') + '⟩';
  }

  // Entanglement entropy of bipartition at cut
  entanglementEntropy(cut: number): number {
    const leftSize = 1 << cut;
    const rightSize = 1 << (this.numQubits - cut);

    // Build reduced density matrix for left subsystem by tracing out right
    const rho: Complex[][] = Array.from({ length: leftSize }, () =>
      Array.from({ length: leftSize }, () => C(0))
    );

    for (let i = 0; i < leftSize; i++) {
      for (let j = 0; j < leftSize; j++) {
        for (let k = 0; k < rightSize; k++) {
          const ampI = this.amplitudes[i * rightSize + k];
          const ampJ = this.amplitudes[j * rightSize + k];
          rho[i][j] = rho[i][j].add(ampI.mul(ampJ.conj()));
        }
      }
    }

    // Compute von Neumann entropy S = -Tr(rho * log(rho)) via eigenvalues
    // For now approximate with diagonal elements (valid for diagonal rho)
    let entropy = 0;
    for (let i = 0; i < leftSize; i++) {
      const p = rho[i][i].re;
      if (p > 1e-12) entropy -= p * Math.log2(p);
    }
    return Math.max(0, entropy);
  }
}

export function buildCircuitMatrix(numQubits: number, ops: GateOp[]): QuantumState {
  const state = new QuantumState(numQubits);
  for (const op of ops) {
    state.applyGate(op);
  }
  return state;
}
