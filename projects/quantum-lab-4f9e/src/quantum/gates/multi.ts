import { C, EXP_I } from '../Complex';
import type { Matrix } from '../Matrix';

export const GATE_CNOT: Matrix = [
  [C(1), C(0), C(0), C(0)],
  [C(0), C(1), C(0), C(0)],
  [C(0), C(0), C(0), C(1)],
  [C(0), C(0), C(1), C(0)],
];

export const GATE_CZ: Matrix = [
  [C(1), C(0), C(0), C(0)],
  [C(0), C(1), C(0), C(0)],
  [C(0), C(0), C(1), C(0)],
  [C(0), C(0), C(0), C(-1)],
];

export const GATE_SWAP: Matrix = [
  [C(1), C(0), C(0), C(0)],
  [C(0), C(0), C(1), C(0)],
  [C(0), C(1), C(0), C(0)],
  [C(0), C(0), C(0), C(1)],
];

export const GATE_ISWAP: Matrix = [
  [C(1), C(0), C(0), C(0)],
  [C(0), C(0), C(0, 1), C(0)],
  [C(0), C(0, 1), C(0), C(0)],
  [C(0), C(0), C(0), C(1)],
];

export const GATE_TOFFOLI: Matrix = (() => {
  const m: Matrix = Array.from({ length: 8 }, (_, i) =>
    Array.from({ length: 8 }, (_, j) => (i === j ? C(1) : C(0)))
  );
  m[6][6] = C(0); m[6][7] = C(1);
  m[7][7] = C(0); m[7][6] = C(1);
  return m;
})();

export const GATE_FREDKIN: Matrix = (() => {
  const m: Matrix = Array.from({ length: 8 }, (_, i) =>
    Array.from({ length: 8 }, (_, j) => (i === j ? C(1) : C(0)))
  );
  m[5][5] = C(0); m[5][6] = C(1);
  m[6][6] = C(0); m[6][5] = C(1);
  return m;
})();

export function gateCPhase(phi: number): Matrix {
  return [
    [C(1), C(0), C(0), C(0)],
    [C(0), C(1), C(0), C(0)],
    [C(0), C(0), C(1), C(0)],
    [C(0), C(0), C(0), EXP_I(phi)],
  ];
}

export const MULTI_GATE_DEFS: Record<string, { label: string; color: string; description: string; qubits: number }> = {
  CNOT: { label: 'CX', color: '#dc2626', description: 'Controlled-NOT — entangles qubits', qubits: 2 },
  CZ: { label: 'CZ', color: '#059669', description: 'Controlled-Z — phase entanglement', qubits: 2 },
  SWAP: { label: '⇄', color: '#0891b2', description: 'SWAP — exchanges qubit states', qubits: 2 },
  Toffoli: { label: 'CCX', color: '#7c3aed', description: 'Toffoli — doubly controlled NOT', qubits: 3 },
  Fredkin: { label: 'CSWAP', color: '#d97706', description: 'Fredkin — controlled SWAP', qubits: 3 },
};
