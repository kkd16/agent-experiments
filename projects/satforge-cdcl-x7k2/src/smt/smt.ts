// Top-level SMT assembly: wire the theories to the DPLL(T) loop and add the
// arithmetic *trichotomy* clauses that let the simplex avoid raw disequalities.
//
// For every arithmetic equality atom E ≡ (L = 0) we conjoin the tautology
//   (E ∨ L<0 ∨ L>0) ∧ (¬E ∨ ¬(L<0)) ∧ (¬E ∨ ¬(L>0)) ∧ (¬(L<0) ∨ ¬(L>0))
// i.e. exactly one of {L=0, L<0, L>0} holds. This is valid over a dense order and
// turns "E is false" (a disequality) into a Boolean choice between two strict
// inequalities, both of which the simplex handles directly.

import { TermManager, type Atom, type Formula } from './term'
import { scaleLin } from './term'
import { Rational } from './rational'
import { EufSolver } from './euf'
import { SimplexSolver } from './simplex'
import { solveSmt, type SmtResult, type SmtOptions, type Theory } from './dpllt'
import { collectAtoms } from './reference'
import { ackermannize, hasUninterpretedFunctions } from './ackermann'

export function arithTrichotomy(tm: TermManager, root: Formula): Formula {
  const atoms = collectAtoms(root)
  const extra: Formula[] = []
  for (const a of atoms) {
    if (a.kind !== 'arith' || a.rel !== 'eq0') continue
    const E: Formula = a
    const lt = tm.arithAtom('lt', a.lin) // L < 0
    const gt = tm.arithAtom('lt', scaleLin(a.lin, Rational.of(-1n))) // −L < 0  ⟺ L > 0
    extra.push(tm.or([E, lt, gt]))
    extra.push(tm.or([tm.not(E), tm.not(lt)]))
    extra.push(tm.or([tm.not(E), tm.not(gt)]))
    extra.push(tm.or([tm.not(lt), tm.not(gt)]))
  }
  return extra.length ? tm.and([root, ...extra]) : root
}

export interface FullSmtResult extends SmtResult {
  /** Human-readable model description from each theory (UI only). */
  model?: string[]
}

/** Solve a formula with the EUF + arithmetic theories. */
export function checkSat(tm: TermManager, root: Formula, opts: SmtOptions = {}): FullSmtResult {
  const euf = new EufSolver(tm)
  const simplex = new SimplexSolver(tm)
  const theories: Theory[] = [euf as unknown as Theory, simplex as unknown as Theory]
  // Mixed UF + arithmetic: Ackermannize so the theories no longer share terms.
  const atoms = collectAtoms(root)
  const mixed = atoms.some((a) => a.kind === 'arith') && hasUninterpretedFunctions(tm, root)
  const base = mixed ? ackermannize(tm, root) : root
  const expanded = arithTrichotomy(tm, base)
  const res = solveSmt(expanded, theories, {
    atomName: (a: Atom) => atomName(tm, a),
    ...opts,
  })
  const full: FullSmtResult = { ...res }
  if (res.status === 'sat' && res.assignment) {
    // Rebuild the per-theory satisfying literal sets to describe the model.
    const lits = collectAtoms(expanded)
      .filter((a) => res.assignment!.has(a.id))
      .map((a) => ({ atom: a, value: res.assignment!.get(a.id)! }))
    const desc: string[] = []
    desc.push(...euf.describeModel(lits.filter((l) => euf.owns(l.atom))))
    desc.push(...simplex.describeModel(lits.filter((l) => simplex.owns(l.atom))))
    full.model = desc
  }
  return full
}

export function atomName(tm: TermManager, a: Atom): string {
  switch (a.kind) {
    case 'pred':
      return tm.termToString(a.term)
    case 'eq':
      return `${tm.termToString(a.a)} = ${tm.termToString(a.b)}`
    case 'arith': {
      const lhs = linToString(tm, a)
      const op = a.rel === 'eq0' ? '=' : a.rel === 'lt' ? '<' : '≤'
      return `${lhs} ${op} 0`
    }
  }
}

function linToString(tm: TermManager, a: Extract<Atom, { kind: 'arith' }>): string {
  const parts: string[] = []
  for (const [tid, c] of [...a.lin.coeffs.entries()].sort((x, y) => x[0] - y[0])) {
    const t = tm.arithVars.get(tid)
    const name = t ? tm.termToString(t) : `v${tid}`
    parts.push(`${c.toString()}·${name}`)
  }
  if (!a.lin.constant.isZero() || parts.length === 0) parts.push(a.lin.constant.toString())
  return parts.join(' + ')
}
