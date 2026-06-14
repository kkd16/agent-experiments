import type { GateOp } from './QuantumState';

export interface CircuitMetrics {
  gateCount: number;
  twoQubitGates: number;
  depth: number;
  perType: { name: string; count: number }[];
  qubitUsage: number[]; // gates touching each qubit
}

/**
 * Circuit metrics. Depth is the number of "moments" (ASAP scheduling): each gate is
 * placed in the earliest layer after the last gate touching any of its qubits — the
 * standard notion of circuit depth / critical path.
 */
export function circuitMetrics(numQubits: number, ops: GateOp[]): CircuitMetrics {
  const ready = new Array(numQubits).fill(0); // next free layer per qubit
  let depth = 0;
  let twoQubitGates = 0;
  const counts = new Map<string, number>();
  const usage = new Array(numQubits).fill(0);

  for (const op of ops) {
    const layer = Math.max(0, ...op.qubits.map((q) => ready[q] ?? 0));
    for (const q of op.qubits) { ready[q] = layer + 1; usage[q] = (usage[q] ?? 0) + 1; }
    depth = Math.max(depth, layer + 1);
    if (op.qubits.length >= 2) twoQubitGates++;
    counts.set(op.name, (counts.get(op.name) ?? 0) + 1);
  }

  const perType = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return { gateCount: ops.length, twoQubitGates, depth, perType, qubitUsage: usage };
}
