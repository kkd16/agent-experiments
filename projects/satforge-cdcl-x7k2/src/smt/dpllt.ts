// The DPLL(T) loop — the bridge that turns the propositional CDCL engine into a
// full SMT solver.
//
// This is the *lazy* (a.k.a. offline) schema, the cleanest correct realization:
//   1. Abstract the formula's Boolean skeleton to CNF (one var per atom).
//   2. SAT-solve it with the existing CDCL solver.
//   3. UNSAT ⇒ the formula is UNSAT. SAT ⇒ read the truth value of every theory
//      atom and hand each theory the conjunction it owns.
//   4. If every theory is consistent, that Boolean model lifts to a real model:
//      SAT. If a theory is inconsistent it returns an *explanation* — a small
//      inconsistent subset of literals — whose negation is added as a **theory
//      lemma** clause, and we re-solve. The explanation (not the whole model) is
//      what keeps the loop from blocking one model at a time.
//
// Theory combination (EUF + arithmetic) is layered on top via Nelson–Oppen in
// combine.ts, which presents a single combined Theory to this loop.

import { solve } from '../sat/solver'
import type { Atom, Formula } from './term'
import { abstractFormula } from './abstract'
import type { TheoryLit, TheoryResult } from './euf'

export interface Theory {
  /** Does this theory reason about the given atom? */
  owns(atom: Atom): boolean
  /** Check a conjunction of (atom, value) literals for theory consistency. */
  check(lits: TheoryLit[]): TheoryResult
  /** Optional: after a consistent check, describe the model (UI only). */
  describeModel?(lits: TheoryLit[]): string[]
}

export interface SmtResult {
  status: 'sat' | 'unsat' | 'unknown'
  /** Truth value assigned to each atom in a satisfying model (atom id → bool). */
  assignment?: Map<number, boolean>
  /** Theory lemmas learned during the refinement loop, as readable strings. */
  lemmas: string[]
  rounds: number
  message?: string
}

export interface SmtOptions {
  maxRounds?: number
  maxConflicts?: number // per SAT call
  atomName?: (a: Atom) => string
}

export function solveSmt(root: Formula, theories: Theory[], opts: SmtOptions = {}): SmtResult {
  const maxRounds = opts.maxRounds ?? 100000
  const ab = abstractFormula(root)
  const clauses = ab.clauses.map((c) => [...c])
  const lemmas: string[] = []
  const name = opts.atomName ?? (() => '?')

  for (let round = 1; round <= maxRounds; round++) {
    const res = solve(
      { numVars: ab.numVars, clauses },
      { maxConflicts: opts.maxConflicts ?? 0, randomSeed: 0x5a7f },
    )
    if (res.status === 'unknown') return { status: 'unknown', lemmas, rounds: round, message: res.message }
    if (res.status === 'unsat') return { status: 'unsat', lemmas, rounds: round }

    const model = res.model! // 1-based booleans
    // Group atom truth values per theory.
    let conflict: TheoryLit[] | null = null
    for (const th of theories) {
      const lits: TheoryLit[] = []
      for (const [v, atom] of ab.varAtom) if (th.owns(atom)) lits.push({ atom, value: model[v] })
      const r = th.check(lits)
      if (r.unknown) return { status: 'unknown', lemmas, rounds: round, message: 'theory undecided' }
      if (!r.ok) {
        conflict = r.conflict!
        break
      }
    }

    if (!conflict) {
      // Consistent Boolean model that every theory accepts ⇒ SAT.
      const assignment = new Map<number, boolean>()
      for (const [v, atom] of ab.varAtom) assignment.set(atom.id, model[v])
      return { status: 'sat', assignment, lemmas, rounds: round }
    }

    // Build the theory-lemma clause: at least one conflicting literal must flip.
    const lemma: number[] = []
    const parts: string[] = []
    for (const l of conflict) {
      const v = ab.atomVar.get(l.atom.id)
      if (v === undefined) continue
      lemma.push(l.value ? -v : v)
      parts.push(`${l.value ? '¬' : ''}${name(l.atom)}`)
    }
    if (lemma.length === 0) {
      // Empty conflict from a theory means UNSAT outright (e.g. ⊤≠⊥ alone).
      return { status: 'unsat', lemmas, rounds: round }
    }
    clauses.push(lemma)
    lemmas.push(`(or ${parts.join(' ')})`)
  }
  return { status: 'unknown', lemmas, rounds: maxRounds, message: 'round limit exhausted' }
}
