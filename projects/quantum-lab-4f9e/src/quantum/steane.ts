import type { GateOp } from './QuantumState';
import { Stabilizer, type Pauli1 } from './Stabilizer';

/**
 * The Steane [[7,1,3]] code — a CSS code built from two copies of the classical [7,4,3]
 * Hamming code. It encodes one logical qubit in seven physical qubits and corrects an
 * arbitrary single-qubit error. Unlike the 9-qubit Shor code (a concatenation), Steane is
 * the smallest code where the logical Clifford gates are *transversal*, which is why it is a
 * workhorse of fault-tolerant proposals.
 *
 * Qubit q carries Hamming column number (q+1) in binary, so a single X (or Z) error produces
 * a 3-bit Z- (or X-) syndrome that reads out the error position directly.
 */

/** X-type stabilizers (detect Z errors). Each is the qubit support of an X-check. */
export const STEANE_X_CHECKS: number[][] = [
  [3, 4, 5, 6], // IIIXXXX  (Hamming bit 2)
  [1, 2, 5, 6], // IXXIIXX  (Hamming bit 1)
  [0, 2, 4, 6], // XIXIXIX  (Hamming bit 0)
];

/** Z-type stabilizers (detect X errors), same support pattern as the X-checks. */
export const STEANE_Z_CHECKS: number[][] = [
  [3, 4, 5, 6], // IIIZZZZ
  [1, 2, 5, 6], // IZZIIZZ
  [0, 2, 4, 6], // ZIZIZIZ
];

export const STEANE_LOGICAL_Z = [0, 1, 2, 3, 4, 5, 6]; // ZZZZZZZ
export const STEANE_LOGICAL_X = [0, 1, 2, 3, 4, 5, 6]; // XXXXXXX

/**
 * Prepare the logical |0⟩_L. Each X-check is seeded with an H on a qubit not targeted by any
 * other seed, then CNOT-spread across its support — building (I+g_i)/√2 projectors on |0…0⟩.
 */
export function steanePrepZeroL(): GateOp[] {
  return [
    { name: 'H', qubits: [0] }, { name: 'H', qubits: [1] }, { name: 'H', qubits: [3] },
    { name: 'CNOT', qubits: [3, 4] }, { name: 'CNOT', qubits: [3, 5] }, { name: 'CNOT', qubits: [3, 6] },
    { name: 'CNOT', qubits: [1, 2] }, { name: 'CNOT', qubits: [1, 5] }, { name: 'CNOT', qubits: [1, 6] },
    { name: 'CNOT', qubits: [0, 2] }, { name: 'CNOT', qubits: [0, 4] }, { name: 'CNOT', qubits: [0, 6] },
  ];
}

export type ErrorType = 'X' | 'Y' | 'Z';

/** Decode a 3-bit check syndrome (checks ordered MSB→LSB) to an error position, or -1. */
export function decodePosition(syndrome: [number, number, number]): number {
  const pos = (syndrome[0] << 2) | (syndrome[1] << 1) | syndrome[2]; // Hamming column = q+1
  return pos === 0 ? -1 : pos - 1;
}

function checkVector(support: number[], pauli: 'X' | 'Z'): { px: number[]; pz: number[] } {
  const px = new Array(7).fill(0), pz = new Array(7).fill(0);
  for (const q of support) (pauli === 'X' ? px : pz)[q] = 1;
  return { px, pz };
}

export interface SteaneRun {
  generatorsBefore: string[];
  generatorsAfterError: string[];
  zSyndrome: [number, number, number]; // from Z-checks → locates X part of the error
  xSyndrome: [number, number, number]; // from X-checks → locates Z part of the error
  detectedXAt: number;
  detectedZAt: number;
  recovered: boolean; // all six stabilizers back to +1 and logical Z preserved
}

/** Read a syndrome bit: 0 if the check still has eigenvalue +1, 1 if it flipped to -1. */
function syndromeBits(st: Stabilizer, checks: number[][], pauli: 'X' | 'Z'): [number, number, number] {
  return checks.map((support) => {
    const { px, pz } = checkVector(support, pauli);
    return st.pauliEigenvalue(px, pz) === -1 ? 1 : 0;
  }) as [number, number, number];
}

/**
 * Full encode → inject error → extract syndrome → correct → verify cycle on the stabilizer
 * tableau. The syndrome is read from the live state (not from foreknowledge of the error),
 * decoded via the Hamming lookup, and the correction applied; we then confirm every
 * stabilizer is back to +1 and the logical operator is undisturbed.
 */
export function runSteane(error: { type: ErrorType; qubit: number }): SteaneRun {
  const st = Stabilizer.fromCircuit(7, steanePrepZeroL());
  const generatorsBefore = st.generatorStrings();

  // Inject the error.
  if (error.type === 'X' || error.type === 'Y') st.x_(error.qubit);
  if (error.type === 'Z' || error.type === 'Y') st.z_(error.qubit);
  const generatorsAfterError = st.generatorStrings();

  // Z-checks anticommute with the X-part of the error; X-checks with the Z-part.
  const zSyndrome = syndromeBits(st, STEANE_Z_CHECKS, 'Z');
  const xSyndrome = syndromeBits(st, STEANE_X_CHECKS, 'X');
  const detectedXAt = decodePosition(zSyndrome); // location of the bit-flip part
  const detectedZAt = decodePosition(xSyndrome); // location of the phase-flip part

  // Apply the recovery (same Pauli at the detected position cancels the error).
  if (detectedXAt >= 0) st.x_(detectedXAt);
  if (detectedZAt >= 0) st.z_(detectedZAt);

  // Verify recovery: all six stabilizers +1 and logical Z preserved.
  const allChecks = [
    ...STEANE_Z_CHECKS.map((s) => checkVector(s, 'Z')),
    ...STEANE_X_CHECKS.map((s) => checkVector(s, 'X')),
  ];
  let recovered = allChecks.every(({ px, pz }) => st.pauliEigenvalue(px, pz) === 1);
  const lz = checkVector(STEANE_LOGICAL_Z, 'Z');
  recovered = recovered && st.pauliEigenvalue(lz.px, lz.pz) === 1;

  return {
    generatorsBefore, generatorsAfterError, zSyndrome, xSyndrome,
    detectedXAt, detectedZAt, recovered,
  };
}

/** Human label for a generator entry (helper for the UI). */
export function pauliLabel(paulis: Pauli1[]): string {
  return paulis.join('');
}
