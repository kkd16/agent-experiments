import type { Matrix } from './Matrix';
import type { GateOp } from './QuantumState';
import { getSingleGateMatrix } from './gates/single';
import {
  GATE_CNOT, GATE_CZ, GATE_SWAP, GATE_ISWAP, GATE_TOFFOLI, GATE_FREDKIN, gateCPhase,
} from './gates/multi';

/**
 * Resolve any GateOp to its *local* unitary (2x2 for single-qubit gates, 4x4 / 8x8
 * for multi-qubit gates). Shared by the state-vector path and the density-matrix
 * engine so both evolve identically. Returns null for an unknown gate.
 */
export function gateMatrixFor(op: GateOp): Matrix | null {
  const { name, qubits, params } = op;
  if (qubits.length === 1) {
    const m = getSingleGateMatrix(name, params);
    if (m) return m;
  }
  switch (name) {
    case 'CNOT': return GATE_CNOT;
    case 'CZ': return GATE_CZ;
    case 'SWAP': return GATE_SWAP;
    case 'iSWAP': return GATE_ISWAP;
    case 'Toffoli': return GATE_TOFFOLI;
    case 'Fredkin': return GATE_FREDKIN;
    case 'CPhase': return gateCPhase(params?.[0] ?? Math.PI / 2);
    default: return getSingleGateMatrix(name, params);
  }
}
