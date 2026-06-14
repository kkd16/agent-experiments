import { Complex, C } from './Complex';
import type { Matrix } from './Matrix';
import { matMul, dagger } from './Matrix';
import { QuantumState, type GateOp } from './QuantumState';
import { gateMatrixFor } from './gateMatrix';
import { hermitianEig, vonNeumannEntropy } from './Hermitian';
import { krausOps, type NoiseModel } from './noise';

/**
 * Embed a local operator acting on `targets` into the full 2^n Hilbert space.
 * Uses the exact bit-layout convention of QuantumState.applyMatrix: targets[0] is the
 * most-significant gate qubit (array order, not sorted), so the density-matrix and
 * state-vector engines stay byte-for-byte consistent.
 */
export function embedOperator(local: Matrix, targets: number[], n: number): Matrix {
  const size = 1 << n;
  const k = targets.length;
  const gateSize = 1 << k;
  const U: Matrix = Array.from({ length: size }, () => Array.from({ length: size }, () => C(0)));

  for (let base = 0; base < size; base++) {
    let isBase = true;
    for (const q of targets) { if ((base >> q) & 1) { isBase = false; break; } }
    if (!isBase) continue;
    for (let rb = 0; rb < gateSize; rb++) {
      let rowIdx = base;
      for (let bi = 0; bi < k; bi++) rowIdx |= (((rb >> (k - 1 - bi)) & 1) << targets[bi]);
      for (let cb = 0; cb < gateSize; cb++) {
        let colIdx = base;
        for (let bi = 0; bi < k; bi++) colIdx |= (((cb >> (k - 1 - bi)) & 1) << targets[bi]);
        U[rowIdx][colIdx] = local[rb][cb];
      }
    }
  }
  return U;
}

/**
 * A mixed-state quantum register held as a density matrix ρ (2^n × 2^n, Hermitian,
 * trace 1). This is the open-system counterpart to QuantumState: it can represent
 * statistical mixtures produced by noise channels, which a pure state vector cannot.
 */
export class DensityMatrix {
  public rho: Matrix;
  public numQubits: number;

  constructor(numQubits: number) {
    this.numQubits = numQubits;
    const size = 1 << numQubits;
    this.rho = Array.from({ length: size }, (_, i) =>
      Array.from({ length: size }, (_, j) => (i === 0 && j === 0 ? C(1) : C(0))),
    );
  }

  static fromPureState(state: QuantumState): DensityMatrix {
    const dm = new DensityMatrix(state.numQubits);
    const a = state.amplitudes;
    const size = a.length;
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) dm.rho[i][j] = a[i].mul(a[j].conj());
    }
    return dm;
  }

  clone(): DensityMatrix {
    const dm = new DensityMatrix(this.numQubits);
    dm.rho = this.rho.map((row) => row.map((z) => new Complex(z.re, z.im)));
    return dm;
  }

  /** Unitary evolution ρ → U ρ U†. */
  applyUnitary(local: Matrix, targets: number[]): void {
    const U = embedOperator(local, targets, this.numQubits);
    this.rho = matMul(matMul(U, this.rho), dagger(U));
  }

  applyGate(op: GateOp): void {
    const m = gateMatrixFor(op);
    if (!m) { console.warn(`DensityMatrix: unknown gate ${op.name}`); return; }
    this.applyUnitary(m, op.qubits);
  }

  /** Apply a CPTP channel given by local Kraus operators on `targets`: ρ → Σ E ρ E†. */
  applyChannel(localKraus: Matrix[], targets: number[]): void {
    const size = 1 << this.numQubits;
    const next: Matrix = Array.from({ length: size }, () => Array.from({ length: size }, () => C(0)));
    for (const k of localKraus) {
      const E = embedOperator(k, targets, this.numQubits);
      const term = matMul(matMul(E, this.rho), dagger(E));
      for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) next[i][j] = next[i][j].add(term[i][j]);
      }
    }
    this.rho = next;
  }

  /** Diagonal of ρ — the measurement probabilities in the computational basis. */
  probabilities(): number[] {
    return this.rho.map((row, i) => row[i].re);
  }

  /** Trace of ρ (≈1 for a valid state). */
  trace(): number {
    let t = 0;
    for (let i = 0; i < this.rho.length; i++) t += this.rho[i][i].re;
    return t;
  }

  /** Purity Tr(ρ²) = Σ_ij |ρ_ij|². 1 = pure, 1/2^n = maximally mixed. */
  purity(): number {
    let s = 0;
    for (const row of this.rho) for (const z of row) s += z.abs2();
    return s;
  }

  /** Eigenvalues of ρ (its mixture spectrum), sorted descending. */
  spectrum(): number[] {
    return hermitianEig(this.rho).values;
  }

  /** Full-state von Neumann entropy S(ρ) = -Tr(ρ log₂ ρ). 0 for pure states. */
  vonNeumannEntropy(): number {
    return vonNeumannEntropy(this.spectrum());
  }

  /** Partial trace: keep the listed qubits, trace out the rest. Returns a Matrix. */
  partialTrace(keep: number[]): Matrix {
    const keepS = [...keep].sort((a, b) => a - b);
    const all = Array.from({ length: this.numQubits }, (_, i) => i);
    const traceQ = all.filter((q) => !keepS.includes(q));
    const kd = 1 << keepS.length;
    const td = 1 << traceQ.length;
    const scatter = (value: number, pos: number[]) => {
      let r = 0;
      for (let m = 0; m < pos.length; m++) if ((value >> m) & 1) r |= (1 << pos[m]);
      return r;
    };
    const out: Matrix = Array.from({ length: kd }, () => Array.from({ length: kd }, () => C(0)));
    for (let a = 0; a < kd; a++) {
      for (let b = 0; b < kd; b++) {
        for (let t = 0; t < td; t++) {
          const i = scatter(a, keepS) | scatter(t, traceQ);
          const j = scatter(b, keepS) | scatter(t, traceQ);
          out[a][b] = out[a][b].add(this.rho[i][j]);
        }
      }
    }
    return out;
  }

  /** Bloch vector of a single qubit's reduced state (r<1 ⇒ mixed/entangled). */
  blochVector(qubit: number): [number, number, number] {
    const r = this.partialTrace([qubit]);
    const x = 2 * r[0][1].re;
    const y = 2 * r[1][0].im;
    const z = r[0][0].re - r[1][1].re;
    return [x, y, z];
  }

  /** Entanglement (von Neumann) entropy of the subsystem of qubits 0..cut-1. */
  entanglementEntropy(cut: number): number {
    const keep = Array.from({ length: cut }, (_, i) => i);
    const rdm = this.partialTrace(keep);
    return vonNeumannEntropy(hermitianEig(rdm).values);
  }
}

/**
 * Run a circuit under an optional noise model, returning the final density matrix.
 * With no active noise this reduces to the pure evolution (ρ stays rank-1).
 */
export function simulateDensity(numQubits: number, ops: GateOp[], noise: NoiseModel): DensityMatrix {
  const dm = new DensityMatrix(numQubits);
  const active = noise.channels.filter((c) => c.strength > 1e-9);
  for (const op of ops) {
    try { dm.applyGate(op); } catch { /* skip invalid */ }
    if (active.length === 0) continue;
    const targets = noise.scope === 'all'
      ? Array.from({ length: numQubits }, (_, i) => i)
      : op.qubits;
    for (const q of targets) {
      for (const ch of active) dm.applyChannel(krausOps(ch.type, ch.strength), [q]);
    }
  }
  return dm;
}
