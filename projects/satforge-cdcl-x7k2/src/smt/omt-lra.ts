// OMT over a *real* (QF_LRA) objective. Where integer objectives are pinned down
// by an exact binary search on the bound (`omt.ts`), a real objective can sit at
// a rational vertex of the feasible polytope — or at an *open* infimum a strict
// inequality never lets it reach — so a bound search would not terminate. Instead
// we optimize the way real OMT solvers do: combine the Boolean search with
// linear programming.
//
//   repeat:
//     1. ask DPLL(T) for any model of  φ ∧ (obj strictly better than `best`);
//     2. on that model's theory polytope, run the simplex LP optimizer to jump
//        to the branch's *exact* optimal vertex;
//     3. record it as the new `best` and tighten the strict bound.
//   until UNSAT — at which point `best` is the global optimum.
//
// Each round strictly improves `best`, and the reachable objective values are the
// finitely-many vertices of an arrangement of polytopes, so the loop terminates.
// Everything is exact rational arithmetic; attainment (open vs. closed optimum)
// is then settled by one final `obj = best` satisfiability query.

import { Rational } from './rational'
import { addLin, scaleLin, type Atom, type Formula, type LinExpr, type TermManager } from './term'
import { prepareSmt, checkSat, atomName } from './smt'
import { solveSmt, type SmtOptions } from './dpllt'
import { collectAtoms } from './reference'
import type { OmtResult } from './omt'

// `solveSmt`/theory `check` consume lists of (atom, value).
type ArithLit = { atom: Atom; value: boolean }

/** Build the arithmetic atom `obj ⋈ k`. */
function boundFormula(tm: TermManager, objLin: LinExpr, k: Rational, op: 'le' | 'lt' | 'ge' | 'gt'): Formula {
  if (op === 'le' || op === 'lt') {
    const lin = addLin(objLin, { coeffs: new Map(), constant: k.neg() })
    return tm.arithAtom(op, lin)
  }
  const lin = addLin({ coeffs: new Map(), constant: k }, scaleLin(objLin, Rational.of(-1n)))
  return tm.arithAtom(op === 'ge' ? 'le' : 'lt', lin)
}

/** Does the formula mention any integer-sorted arithmetic variable? */
function hasIntegerVars(tm: TermManager, expanded: Formula): boolean {
  for (const a of collectAtoms(expanded)) {
    if (a.kind !== 'arith') continue
    for (const v of a.lin.coeffs.keys()) if (tm.arithVars.get(v)?.sort === 'Int') return true
  }
  return false
}

export function optimizeReal(
  tm: TermManager,
  root: Formula,
  objLin: LinExpr,
  dir: 'min' | 'max',
  opts: SmtOptions = {},
): OmtResult {
  // Reject mixed integer/real problems — branch-and-bound + LP optimization is a
  // genuinely harder (MILP) problem we don't claim to solve exactly.
  {
    const probe = prepareSmt(tm, root, opts)
    if (hasIntegerVars(tm, probe.expanded)) {
      return {
        status: 'unknown',
        calls: 0,
        trace: [],
        message: 'real-objective OMT requires a pure-real (QF_LRA) problem; this one has integer variables',
      }
    }
  }

  const trace: OmtResult['trace'] = []
  let calls = 0
  let best: Rational | null = null
  const MAX_ROUNDS = 4000

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const f = best === null ? root : tm.and([root, boundFormula(tm, objLin, best, dir === 'min' ? 'lt' : 'gt')])
    const prep = prepareSmt(tm, f, opts)
    calls++
    const res = solveSmt(prep.expanded, prep.theories, { atomName: (a) => atomName(tm, a), ...opts })
    if (res.status === 'unknown') return { status: 'unknown', calls, trace, message: res.message }
    if (res.status === 'unsat') break // `best` is now globally optimal

    // Re-derive the arithmetic literals of this model and LP-optimize the branch.
    const arithLits: ArithLit[] = []
    for (const a of collectAtoms(prep.expanded))
      if (a.kind === 'arith' && res.assignment!.has(a.id)) arithLits.push({ atom: a, value: res.assignment!.get(a.id)! })
    const lp = prep.simplex.optimize(arithLits, objLin, dir === 'max')
    if (lp.kind === 'unbounded') return { status: 'unbounded', calls, trace, attained: false, method: 'lra-simplex' }
    if (lp.kind !== 'optimal') break

    const v = lp.c!
    const improved = best === null || (dir === 'min' ? v.lt(best) : v.gt(best))
    trace.push({ bound: `obj → ${v.toString()}`, sat: true, value: v.toString() })
    if (improved) best = v
    // Guard against a non-improving round (should not happen given the strict bound).
    else break
  }

  if (best === null) return { status: 'infeasible', calls, trace }

  // Settle attainment + recover a clean model: is `obj = best` satisfiable?
  const eqAtom = tm.arithAtom('eq0', addLin(objLin, { coeffs: new Map(), constant: best.neg() }))
  const eq = checkSat(tm, tm.and([root, eqAtom]), opts)
  calls++
  const attained = eq.status === 'sat'
  return {
    status: 'optimal',
    value: best,
    attained,
    model: attained ? eq : undefined,
    method: 'lra-simplex',
    calls,
    trace,
    message: attained ? undefined : `open ${dir === 'min' ? 'infimum' : 'supremum'} — the optimum value is not attained`,
  }
}
