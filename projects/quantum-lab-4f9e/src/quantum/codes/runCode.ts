/**
 * Run a full encode → inject → syndrome → correct → verify cycle for any stabilizer code on the
 * live Aaronson–Gottesman tableau (the same engine that powers the Stabilizer tab). The logical
 * |0…0⟩_L is loaded directly from the code's generators via `Stabilizer.fromGenerators`, the
 * syndrome is *read off the live state* (not from foreknowledge of the error), decoded by the
 * code's symplectic lookup table, corrected, and the recovery is confirmed against every
 * stabilizer and logical-Z operator. The tableau syndrome is also cross-checked against the pure
 * symplectic syndrome — two independent code paths that must agree.
 */

import { Stabilizer, type Generator, type Pauli1 } from '../Stabilizer';
import {
  StabilizerCode, type Pauli, type Residual,
  pauliMul, pauliString, pauliWeight,
} from './StabilizerCode';

function pauliToGenerator(p: Pauli): Generator {
  const paulis: Pauli1[] = [];
  for (let q = 0; q < p.x.length; q++) paulis.push(p.x[q] && p.z[q] ? 'Y' : p.x[q] ? 'X' : p.z[q] ? 'Z' : 'I');
  return { sign: 1, paulis };
}

function injectError(st: Stabilizer, err: Pauli): void {
  for (let q = 0; q < err.x.length; q++) {
    if (err.x[q]) st.x_(q);
    if (err.z[q]) st.z_(q);
  }
}

export interface CodeRun {
  generatorsBefore: string[];
  generatorsAfter: string[];
  syndrome: number[];
  syndromeMatchesSymplectic: boolean;
  correction: string;
  correctionWeight: number;
  residual: Residual;
  recovered: boolean; // every stabilizer + logical-Z back at +1
}

export function runCodeCycle(code: StabilizerCode, err: Pauli): CodeRun {
  // |0…0⟩_L is the joint +1 eigenstate of the stabilizers and the logical-Z operators.
  const pinning: Generator[] = [...code.stabs, ...code.logicalZ].map(pauliToGenerator);
  const st = Stabilizer.fromGenerators(pinning);
  const generatorsBefore = st.generatorStrings().slice(0, code.numChecks);

  injectError(st, err);
  const generatorsAfter = st.generatorStrings().slice(0, code.numChecks);

  // Read the syndrome from the live tableau, one stabilizer at a time.
  const syndrome = code.stabs.map((g) => (st.pauliEigenvalue(g.x, g.z) === -1 ? 1 : 0));
  const symSyndrome = code.syndrome(err);
  const syndromeMatchesSymplectic = syndrome.every((b, i) => b === symSyndrome[i]);

  const correction = code.decode(syndrome);
  injectError(st, correction);

  // Verify: every stabilizer and every logical-Z operator is back at eigenvalue +1.
  let recovered = code.stabs.every((g) => st.pauliEigenvalue(g.x, g.z) === 1);
  recovered = recovered && code.logicalZ.every((l) => st.pauliEigenvalue(l.x, l.z) === 1);

  const residual = code.classify(pauliMul(err, correction));
  return {
    generatorsBefore, generatorsAfter, syndrome, syndromeMatchesSymplectic,
    correction: pauliString(correction),
    correctionWeight: pauliWeight(correction),
    residual, recovered,
  };
}
