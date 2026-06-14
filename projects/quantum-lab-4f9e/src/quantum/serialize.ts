import type { GateOp } from './QuantumState';

/**
 * Circuit persistence: a compact JSON schema plus URL-hash sharing. All storage is
 * wrapped in try/catch so the sandboxed catalog thumbnail (no same-origin, no storage)
 * still renders if these throw.
 */
export interface CircuitDoc {
  v: 1;
  numQubits: number;
  ops: GateOp[];
  name?: string;
}

export function toJSON(doc: CircuitDoc): string {
  return JSON.stringify(doc, null, 2);
}

export function fromJSON(text: string): CircuitDoc | null {
  try {
    const obj = JSON.parse(text);
    if (typeof obj !== 'object' || obj === null) return null;
    if (!Array.isArray(obj.ops) || typeof obj.numQubits !== 'number') return null;
    const ops: GateOp[] = obj.ops
      .filter((o: unknown): o is GateOp =>
        !!o && typeof (o as GateOp).name === 'string' && Array.isArray((o as GateOp).qubits))
      .map((o: GateOp) => ({ name: o.name, qubits: o.qubits.map(Number), params: o.params?.map(Number) }));
    return { v: 1, numQubits: Math.max(1, Math.min(10, obj.numQubits | 0)), ops, name: obj.name };
  } catch {
    return null;
  }
}

// Base64-encode a compact circuit for a shareable #c=… URL.
export function encodeToHash(doc: CircuitDoc): string {
  try {
    const compact = { n: doc.numQubits, o: doc.ops.map((op) => [op.name, op.qubits, op.params ?? []]) };
    return btoa(unescape(encodeURIComponent(JSON.stringify(compact))));
  } catch {
    return '';
  }
}

export function decodeFromHash(hash: string): CircuitDoc | null {
  try {
    const json = decodeURIComponent(escape(atob(hash)));
    const c = JSON.parse(json);
    if (!c || !Array.isArray(c.o)) return null;
    const ops: GateOp[] = c.o.map((t: [string, number[], number[]]) => ({
      name: t[0], qubits: t[1].map(Number), params: t[2]?.length ? t[2].map(Number) : undefined,
    }));
    return { v: 1, numQubits: Math.max(1, Math.min(10, Number(c.n) || 1)), ops };
  } catch {
    return null;
  }
}

export function download(filename: string, text: string): void {
  try {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    /* sandboxed preview — ignore */
  }
}
