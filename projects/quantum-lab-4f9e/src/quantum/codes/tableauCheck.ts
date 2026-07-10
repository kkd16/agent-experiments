/**
 * Cross-checking the GF(2) code engine against the *actual* quantum simulator.
 *
 * The whole point of the lab is that every number is pinned to a real computation, not quoted.
 * Here the symplectic bookkeeping of `StabilizerCode` (syndromes, corrections, logical
 * membership) is validated against the from-scratch CHP tableau simulator: we genuinely prepare
 * the encoded |0…0⟩_L by projecting onto each stabilizer's +1 eigenspace, inject a real Pauli
 * error as gates, read the syndrome the simulator reports, decode, correct, and confirm the
 * logical information survives — all on the same tableau engine the Stabilizer tab uses.
 */

import { Stabilizer } from '../Stabilizer';
import { type SymPauli } from './pauli';
import { StabilizerCode } from './stabilizerCode';
import { type Decoder, correctionFor } from './decoder';

/** Prepare the encoded |0…0⟩_L on a fresh tableau by post-selecting +1 on every generator of
 *  the codeword stabilizer group (the code's stabilizers ∪ its logical Z̄ᵢ). */
export function prepareZeroL(code: StabilizerCode): Stabilizer {
  const st = new Stabilizer(code.n);
  for (const g of code.zeroLGenerators()) st.measurePauli(g.x, g.z, 0);
  return st;
}

/** Apply a Pauli (as X/Z gates) to a tableau in place. */
function applyPauli(st: Stabilizer, p: SymPauli): void {
  for (let q = 0; q < p.x.length; q++) {
    if (p.x[q]) st.apply('X', [q]);
    if (p.z[q]) st.apply('Z', [q]);
  }
}

/** The syndrome the *simulator* reports: each stabilizer's eigenvalue on the current state. */
export function tableauSyndrome(st: Stabilizer, code: StabilizerCode): number[] {
  return code.gens.map((g) => (st.pauliEigenvalue(g.x, g.z) < 0 ? 1 : 0));
}

export interface CrossCheck {
  ok: boolean;
  prepared: boolean; // |0⟩_L is a +1 eigenstate of every stabilizer and every Z̄
  syndromeAgree: boolean; // tableau syndrome == GF(2) syndrome for every tested error
  corrected: boolean; // after decode+correct the logical Z̄ is restored to +1
  tested: number;
  detail: string;
}

/**
 * End-to-end check: prepare a codeword, then for each supplied error confirm the simulator's
 * syndrome equals the algebraic syndrome, and that decoding + correcting returns the state to
 * the *same* codeword (its stabilizer and logical Z̄ᵢ eigenvalues restored to their baseline).
 * Everything is compared against the prepared state's own signs, so it is immune to whether the
 * projection landed on the +1 or a −1 codeword.
 */
export function crossCheck(code: StabilizerCode, dec: Decoder, errors: SymPauli[]): CrossCheck {
  const base = prepareZeroL(code);
  // Baseline signs of the prepared codeword. A genuine codeword makes every stabilizer AND
  // every logical Z̄ a definite ±1 eigenstate (pauliEigenvalue never returns 0).
  const sBase = code.gens.map((g) => base.pauliEigenvalue(g.x, g.z));
  const zBase = code.logicalZ.map((z) => base.pauliEigenvalue(z.x, z.z));
  const prepared = sBase.every((v) => v !== 0) && zBase.every((v) => v !== 0);

  let syndromeAgree = true;
  let corrected = true;
  for (const e of errors) {
    const st = base.clone();
    applyPauli(st, e);
    // Syndrome from the simulator = which stabilizer eigenvalues flipped from baseline.
    const tsyn = code.gens.map((g, i) => (st.pauliEigenvalue(g.x, g.z) !== sBase[i] ? 1 : 0));
    const asyn = code.syndrome(e);
    if (tsyn.join('') !== asyn.join('')) { syndromeAgree = false; break; }
    // Correct, then confirm the codeword: stabilizers back to baseline, and (for a genuinely
    // correctable error) the logical Z̄ᵢ back to baseline too — the information survived.
    const c = correctionFor(code, dec, e);
    applyPauli(st, c);
    const stabOK = code.gens.every((g, i) => st.pauliEigenvalue(g.x, g.z) === sBase[i]);
    const logicalOK = code.logicalZ.every((z, i) => st.pauliEigenvalue(z.x, z.z) === zBase[i]);
    if (!stabOK) { corrected = false; break; }
    if (dec.t >= 1 && !logicalOK) { corrected = false; break; }
  }
  const ok = prepared && syndromeAgree && corrected;
  return {
    ok, prepared, syndromeAgree, corrected, tested: errors.length,
    detail: `prep=${prepared} syndrome=${syndromeAgree} correct=${corrected}`,
  };
}
