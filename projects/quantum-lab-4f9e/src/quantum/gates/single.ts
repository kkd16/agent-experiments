import { Complex, C, EXP_I } from '../Complex';
import type { Matrix } from '../Matrix';

const RT2 = 1 / Math.SQRT2;

export const GATE_H: Matrix = [
  [C(RT2), C(RT2)],
  [C(RT2), C(-RT2)],
];

export const GATE_X: Matrix = [
  [C(0), C(1)],
  [C(1), C(0)],
];

export const GATE_Y: Matrix = [
  [C(0), C(0, -1)],
  [C(0, 1), C(0)],
];

export const GATE_Z: Matrix = [
  [C(1), C(0)],
  [C(0), C(-1)],
];

export const GATE_S: Matrix = [
  [C(1), C(0)],
  [C(0), C(0, 1)],
];

export const GATE_SDG: Matrix = [
  [C(1), C(0)],
  [C(0), C(0, -1)],
];

export const GATE_T: Matrix = [
  [C(1), C(0)],
  [C(0), EXP_I(Math.PI / 4)],
];

export const GATE_TDG: Matrix = [
  [C(1), C(0)],
  [C(0), EXP_I(-Math.PI / 4)],
];

export const GATE_I: Matrix = [
  [C(1), C(0)],
  [C(0), C(1)],
];

export const GATE_SX: Matrix = [
  [new Complex(1, 1).scale(0.5), new Complex(1, -1).scale(0.5)],
  [new Complex(1, -1).scale(0.5), new Complex(1, 1).scale(0.5)],
];

export function gateRx(theta: number): Matrix {
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  return [
    [C(c), C(0, -s)],
    [C(0, -s), C(c)],
  ];
}

export function gateRy(theta: number): Matrix {
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  return [
    [C(c), C(-s)],
    [C(s), C(c)],
  ];
}

export function gateRz(theta: number): Matrix {
  return [
    [EXP_I(-theta / 2), C(0)],
    [C(0), EXP_I(theta / 2)],
  ];
}

export function gatePhase(phi: number): Matrix {
  return [
    [C(1), C(0)],
    [C(0), EXP_I(phi)],
  ];
}

export function gateU(theta: number, phi: number, lambda: number): Matrix {
  const c = Math.cos(theta / 2);
  const s = Math.sin(theta / 2);
  return [
    [C(c), EXP_I(lambda).neg().scale(s)],
    [EXP_I(phi).scale(s), EXP_I(phi + lambda).scale(c)],
  ];
}

export const SINGLE_GATE_DEFS: Record<string, { label: string; color: string; description: string; matrix: () => Matrix }> = {
  H: { label: 'H', color: '#7c3aed', description: 'Hadamard — creates superposition', matrix: () => GATE_H },
  X: { label: 'X', color: '#dc2626', description: 'Pauli-X — bit flip (NOT gate)', matrix: () => GATE_X },
  Y: { label: 'Y', color: '#d97706', description: 'Pauli-Y — bit+phase flip', matrix: () => GATE_Y },
  Z: { label: 'Z', color: '#059669', description: 'Pauli-Z — phase flip', matrix: () => GATE_Z },
  S: { label: 'S', color: '#0891b2', description: 'S gate — π/2 phase rotation', matrix: () => GATE_S },
  T: { label: 'T', color: '#7c3aed', description: 'T gate — π/4 phase rotation', matrix: () => GATE_T },
  I: { label: 'I', color: '#6b7280', description: 'Identity — no operation', matrix: () => GATE_I },
  SX: { label: '√X', color: '#be185d', description: 'Square root of X', matrix: () => GATE_SX },
};

export function getSingleGateMatrix(name: string, params?: number[]): Matrix | null {
  switch (name) {
    case 'H': return GATE_H;
    case 'X': return GATE_X;
    case 'Y': return GATE_Y;
    case 'Z': return GATE_Z;
    case 'S': return GATE_S;
    case 'Sdg': return GATE_SDG;
    case 'T': return GATE_T;
    case 'Tdg': return GATE_TDG;
    case 'I': return GATE_I;
    case 'SX': return GATE_SX;
    case 'Rx': return gateRx(params?.[0] ?? Math.PI);
    case 'Ry': return gateRy(params?.[0] ?? Math.PI);
    case 'Rz': return gateRz(params?.[0] ?? Math.PI);
    case 'Phase': return gatePhase(params?.[0] ?? Math.PI / 2);
    case 'U': return gateU(params?.[0] ?? 0, params?.[1] ?? 0, params?.[2] ?? 0);
    default: return null;
  }
}
