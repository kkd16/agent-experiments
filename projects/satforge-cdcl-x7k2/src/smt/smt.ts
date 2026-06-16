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
import { hasArrays, reduceArrays } from './arrays'

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
  /** Truth value of each original atom in the satisfying model (UI only). */
  atomList?: { name: string; value: boolean }[]
  /** EUF congruence classes (every class, as groups of term names). */
  congruenceClasses?: string[][]
  /** Elapsed wall-clock time in ms. */
  timeMs?: number
}

/** Solve a formula with the EUF + arithmetic theories. */
export function checkSat(tm: TermManager, root: Formula, opts: SmtOptions = {}): FullSmtResult {
  const euf = new EufSolver(tm)
  const simplex = new SimplexSolver(tm)
  const theories: Theory[] = [euf as unknown as Theory, simplex as unknown as Theory]
  // Arrays: reduce select/store to EUF + arithmetic first (no theory solver of
  // their own — read-over-write purification + extensionality instantiation).
  const work = hasArrays(tm, root) ? reduceArrays(tm, root) : root
  // Mixed UF + arithmetic: Ackermannize so the theories no longer share terms.
  const atoms = collectAtoms(work)
  const mixed = atoms.some((a) => a.kind === 'arith') && hasUninterpretedFunctions(tm, work)
  const base = mixed ? ackermannize(tm, work) : work
  const expanded = arithTrichotomy(tm, base)
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const res = solveSmt(expanded, theories, {
    atomName: (a: Atom) => atomName(tm, a),
    ...opts,
  })
  const full: FullSmtResult = { ...res }
  full.timeMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0
  if (res.status === 'sat' && res.assignment) {
    full.atomList = atoms
      .filter((a) => res.assignment!.has(a.id))
      .map((a) => ({ name: atomName(tm, a), value: res.assignment!.get(a.id)! }))
      .sort((x, y) => x.name.localeCompare(y.name))
    // Rebuild the per-theory satisfying literal sets to describe the model.
    const lits = collectAtoms(expanded)
      .filter((a) => res.assignment!.has(a.id))
      .map((a) => ({ atom: a, value: res.assignment!.get(a.id)! }))
    const eufLits = lits.filter((l) => euf.owns(l.atom))
    const desc: string[] = []
    desc.push(...euf.describeModel(eufLits))
    desc.push(...simplex.describeModel(lits.filter((l) => simplex.owns(l.atom))))
    full.model = desc
    const classes = euf.allClasses(eufLits).filter((g) => g.length > 1)
    if (classes.length) full.congruenceClasses = classes
  }
  return full
}

/**
 * A minimal unsat core over a list of assertions: a subset whose conjunction is
 * still UNSAT but from which removing *any* element becomes SAT. Deletion-based,
 * re-deciding with the full DPLL(T) solver — the SMT analogue of the SAT MUS.
 * Returns the indices (into `assertions`) that survive. Assumes the whole
 * conjunction is UNSAT.
 */
export function smtUnsatCore(tm: TermManager, assertions: Formula[], opts: SmtOptions = {}): number[] {
  let core = assertions.map((_, i) => i)
  for (let k = 0; k < core.length; ) {
    const trial = core.filter((_, j) => j !== k)
    const f = tm.and(trial.map((i) => assertions[i]))
    if (trial.length > 0 && checkSat(tm, f, opts).status === 'unsat') {
      core = trial // assertion core[k] was not needed
    } else {
      k++
    }
  }
  return core
}

/** Render a formula back to an SMT-LIB-ish string (UI / core display). */
export function formulaToString(tm: TermManager, f: Formula): string {
  switch (f.kind) {
    case 'const':
      return f.val ? 'true' : 'false'
    case 'not':
      return `(not ${formulaToString(tm, f.arg)})`
    case 'and':
      return `(and ${f.args.map((g) => formulaToString(tm, g)).join(' ')})`
    case 'or':
      return `(or ${f.args.map((g) => formulaToString(tm, g)).join(' ')})`
    case 'imp':
      return `(=> ${formulaToString(tm, f.a)} ${formulaToString(tm, f.b)})`
    case 'iff':
      return `(= ${formulaToString(tm, f.a)} ${formulaToString(tm, f.b)})`
    case 'xor':
      return `(xor ${formulaToString(tm, f.a)} ${formulaToString(tm, f.b)})`
    case 'ite':
      return `(ite ${formulaToString(tm, f.c)} ${formulaToString(tm, f.t)} ${formulaToString(tm, f.e)})`
    case 'pred':
    case 'eq':
    case 'arith':
      return atomName(tm, f)
  }
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
