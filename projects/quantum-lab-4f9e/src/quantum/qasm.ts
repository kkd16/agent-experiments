import type { GateOp } from './QuantumState';

/**
 * Export a circuit to OpenQASM 2.0 — the de-facto interchange format read by Qiskit,
 * Cirq and the IBM Quantum hardware. Gates are mapped to the qelib1.inc standard set;
 * gates with no direct equivalent (Toffoli/Fredkin/iSWAP) are decomposed.
 */

function fmt(x: number): string {
  // Prefer compact π-fraction notation where it's exact, else a decimal.
  const ratios: [number, string][] = [
    [Math.PI, 'pi'], [Math.PI / 2, 'pi/2'], [Math.PI / 4, 'pi/4'], [Math.PI / 8, 'pi/8'],
    [-Math.PI, '-pi'], [-Math.PI / 2, '-pi/2'], [-Math.PI / 4, '-pi/4'], [Math.PI * 2, '2*pi'],
    [3 * Math.PI / 4, '3*pi/4'], [Math.PI / 3, 'pi/3'], [2 * Math.PI / 3, '2*pi/3'],
  ];
  for (const [v, s] of ratios) if (Math.abs(x - v) < 1e-9) return s;
  return x.toFixed(6);
}

function gateLine(op: GateOp, q: (i: number) => string): string[] {
  const p = op.params ?? [];
  switch (op.name) {
    case 'H': return [`h ${q(0)};`];
    case 'X': return [`x ${q(0)};`];
    case 'Y': return [`y ${q(0)};`];
    case 'Z': return [`z ${q(0)};`];
    case 'S': return [`s ${q(0)};`];
    case 'Sdg': return [`sdg ${q(0)};`];
    case 'T': return [`t ${q(0)};`];
    case 'Tdg': return [`tdg ${q(0)};`];
    case 'SX': return [`sx ${q(0)};`];
    case 'I': return [`id ${q(0)};`];
    case 'Rx': return [`rx(${fmt(p[0] ?? Math.PI)}) ${q(0)};`];
    case 'Ry': return [`ry(${fmt(p[0] ?? Math.PI)}) ${q(0)};`];
    case 'Rz': return [`rz(${fmt(p[0] ?? Math.PI)}) ${q(0)};`];
    case 'Phase': return [`p(${fmt(p[0] ?? Math.PI / 2)}) ${q(0)};`];
    case 'U': return [`u(${fmt(p[0] ?? 0)},${fmt(p[1] ?? 0)},${fmt(p[2] ?? 0)}) ${q(0)};`];
    case 'CNOT': return [`cx ${q(0)},${q(1)};`];
    case 'CZ': return [`cz ${q(0)},${q(1)};`];
    case 'SWAP': return [`swap ${q(0)},${q(1)};`];
    case 'CPhase': return [`cp(${fmt(p[0] ?? Math.PI / 2)}) ${q(0)},${q(1)};`];
    case 'Toffoli': return [`ccx ${q(0)},${q(1)},${q(2)};`];
    case 'Fredkin': return [`cswap ${q(0)},${q(1)},${q(2)};`];
    case 'iSWAP': // decompose: iswap = S⊗S · H·CX·CX·H type; use a known decomposition
      return [`s ${q(0)};`, `s ${q(1)};`, `h ${q(0)};`, `cx ${q(0)},${q(1)};`, `cx ${q(1)},${q(0)};`, `h ${q(1)};`];
    default: return [`// unsupported gate: ${op.name}`];
  }
}

export function toQASM(numQubits: number, ops: GateOp[]): string {
  const lines = [
    'OPENQASM 2.0;',
    'include "qelib1.inc";',
    '',
    `qreg q[${numQubits}];`,
    `creg c[${numQubits}];`,
    '',
  ];
  for (const op of ops) {
    const q = (i: number) => `q[${op.qubits[i]}]`;
    lines.push(...gateLine(op, q));
  }
  lines.push('');
  for (let i = 0; i < numQubits; i++) lines.push(`measure q[${i}] -> c[${i}];`);
  return lines.join('\n');
}
