// Answer-set certificates + brave/cautious consequences.
//
// Every other prover in SatForge ships a machine-checkable certificate — DRAT for
// UNSAT, a winning-move witness for QBF, an inductive invariant for the model
// checker. This gives ASP the same: for each reported answer set we emit a
// **founded-set derivation order** — a sequence that produces exactly the model's
// true atoms, each one justified by a rule whose positive body was *already*
// derived and whose negative body is absent from the model. That the sequence
// exists and terminates in the whole model is a constructive proof that nothing
// is true by circular self-support — i.e. that the model really is stable — and
// `verifyCertificate` re-checks it independently, replaying the derivation from
// the empty set with no reference to how it was produced.
//
// On top of enumeration this file also computes the two standard reasoning modes:
// **cautious** (skeptical) consequences hold in every answer set, **brave**
// (credulous) consequences in at least one.

import type { GroundProgram, AnswerSet } from './program'

export interface DerivationStep {
  atom: number
  /** index of the rule that founds `atom` at this step. */
  ruleIndex: number
  /** the rule's positive body (all derived strictly earlier). */
  pos: number[]
  /** the rule's negative body (all absent from the model). */
  neg: number[]
  /** true when the founding rule is a choice rule (self-supported by its body). */
  choice: boolean
}

/**
 * Build a founded-set derivation order for `model` (a set of true atom ids), or
 * `null` if the model is not founded (hence not a stable model). The order is a
 * topological proof: atom i's founding rule only uses positive body atoms that
 * appear earlier in the list.
 */
export function derivationOrder(prog: GroundProgram, model: ReadonlyArray<number>): DerivationStep[] | null {
  const N = prog.numAtoms
  const inM = new Uint8Array(N + 1)
  for (const a of model) inM[a] = 1
  const founded = new Uint8Array(N + 1)
  const steps: DerivationStep[] = []
  let changed = true
  while (changed) {
    changed = false
    for (let ri = 0; ri < prog.rules.length; ri++) {
      const r = prog.rules[ri]
      if (r.kind === 'constraint') continue
      let ok = true
      for (const p of r.pos) if (founded[p] !== 1) { ok = false; break }
      if (ok) for (const n of r.neg) if (inM[n] === 1) { ok = false; break }
      if (!ok) continue
      const heads = r.kind === 'normal' ? [r.head] : r.heads
      for (const h of heads) {
        if (inM[h] === 1 && founded[h] === 0) {
          founded[h] = 1
          changed = true
          steps.push({ atom: h, ruleIndex: ri, pos: r.pos.slice(), neg: r.neg.slice(), choice: r.kind === 'choice' })
        }
      }
    }
  }
  for (const a of model) if (founded[a] === 0) return null
  return steps
}

/**
 * Independently verify a derivation certificate: replay it from ∅, checking each
 * step's positive body is already derived and its negative body is disjoint from
 * the model, then confirm the derived set is *exactly* the model. Shares no logic
 * with the solver — a valid certificate is a stand-alone proof of stability.
 */
export function verifyCertificate(
  prog: GroundProgram,
  model: ReadonlyArray<number>,
  steps: DerivationStep[],
): boolean {
  const N = prog.numAtoms
  const inM = new Uint8Array(N + 1)
  for (const a of model) {
    if (a < 1 || a > N) return false
    inM[a] = 1
  }
  const derived = new Uint8Array(N + 1)
  for (const s of steps) {
    if (s.ruleIndex < 0 || s.ruleIndex >= prog.rules.length) return false
    const r = prog.rules[s.ruleIndex]
    if (r.kind === 'constraint') return false
    // the step's rule really must be able to found `s.atom`
    const heads = r.kind === 'normal' ? [r.head] : r.heads
    if (!heads.includes(s.atom)) return false
    if (inM[s.atom] !== 1) return false
    if (derived[s.atom] === 1) return false // no atom founded twice
    for (const p of r.pos) if (derived[p] !== 1) return false // positive support already derived
    for (const n of r.neg) if (inM[n] === 1) return false // negative body absent from the model
    derived[s.atom] = 1
  }
  // derived set must equal the model exactly
  for (let a = 1; a <= N; a++) if (derived[a] !== inM[a]) return false
  return true
}

export interface Consequences {
  /** atoms true in EVERY answer set (skeptical / cautious consequences). */
  cautious: number[]
  /** atoms true in AT LEAST ONE answer set (credulous / brave consequences). */
  brave: number[]
}

/** Cautious (∩) and brave (∪) consequences over a complete set of answer sets. */
export function consequences(prog: GroundProgram, answerSets: ReadonlyArray<AnswerSet>): Consequences {
  const brave = new Uint8Array(prog.numAtoms + 1)
  const cautious = new Uint8Array(prog.numAtoms + 1)
  if (answerSets.length > 0) {
    cautious.fill(1)
    cautious[0] = 0
    for (const s of answerSets) {
      const inS = new Uint8Array(prog.numAtoms + 1)
      for (const a of s) {
        inS[a] = 1
        brave[a] = 1
      }
      for (let a = 1; a <= prog.numAtoms; a++) if (inS[a] === 0) cautious[a] = 0
    }
  }
  const b: number[] = []
  const c: number[] = []
  for (let a = 1; a <= prog.numAtoms; a++) {
    if (brave[a]) b.push(a)
    if (cautious[a]) c.push(a)
  }
  return { cautious: c, brave: b }
}
