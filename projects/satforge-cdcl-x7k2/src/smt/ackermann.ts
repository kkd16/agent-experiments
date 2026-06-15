// Ackermann's reduction. When a formula mixes uninterpreted functions with
// arithmetic, the two theories would otherwise need Nelson–Oppen combination to
// stay sound: a fact like `x = y ⇒ f(x) = f(y)` is invisible to a simplex that
// treats f(x), f(y) as opaque reals. Ackermannization removes the need for
// combination entirely: replace every application f(t₁…tₙ) by a fresh variable
// vf, and add, for each pair of applications of the same f, the functional
// consistency axiom  (t₁=t₁' ∧ … ∧ tₙ=tₙ') → vf = vf'.
//
// After the rewrite there are *no* function symbols, so each remaining atom
// belongs to a single theory and the theories share no variables — the lazy
// DPLL(T) loop with independent EUF + simplex checks is then sound and complete.

import { TermManager, addLin, scaleLin, type Formula, type LinExpr, type Term } from './term'
import { Rational } from './rational'
import { collectAtoms } from './reference'

/** Is `t` an uninterpreted application (arity ≥ 1, not a builtin arithmetic op)? */
function isUFApp(t: Term): boolean {
  return t.kind === 'app' && t.args.length > 0 && !t.arith
}

function subterms(t: Term, out: Map<number, Term>): void {
  if (out.has(t.id)) return
  out.set(t.id, t)
  for (const a of t.args) subterms(a, out)
}

export function hasUninterpretedFunctions(tm: TermManager, root: Formula): boolean {
  const terms = collectTerms(tm, root)
  for (const t of terms.values()) if (isUFApp(t)) return true
  return false
}

function collectTerms(tm: TermManager, root: Formula): Map<number, Term> {
  const terms = new Map<number, Term>()
  for (const a of collectAtoms(root)) {
    if (a.kind === 'eq') {
      subterms(a.a, terms)
      subterms(a.b, terms)
    } else if (a.kind === 'pred') {
      subterms(a.term, terms)
    } else {
      for (const id of a.lin.coeffs.keys()) {
        const t = tm.arithVars.get(id)
        if (t) subterms(t, terms)
      }
    }
  }
  return terms
}

export function ackermannize(tm: TermManager, root: Formula): Formula {
  const terms = collectTerms(tm, root)
  // Fresh replacement constant for each uninterpreted application.
  const repl = new Map<number, Term>() // app term id → fresh const term
  let counter = 0
  for (const t of terms.values()) {
    if (!isUFApp(t)) continue
    const name = `ack!${t.op}!${counter++}`
    tm.declareFun({ name, argSorts: [], retSort: t.sort })
    repl.set(t.id, tm.app(name))
  }

  const rw = (t: Term): Term => {
    if (t.kind === 'num' || t.args.length === 0) return t
    if (t.arith) {
      const a = t.args.map(rw)
      if (t.op === '+') return a.reduce((x, y) => tm.add(x, y))
      if (t.op === '-') return a.length === 1 ? tm.negTerm(a[0]) : a.reduce((x, y) => tm.sub(x, y))
      if (t.op === '*') return a.reduce((x, y) => tm.mul(x, y))
      return t
    }
    // uninterpreted application → its fresh constant
    return repl.get(t.id)!
  }

  const rwLin = (lin: LinExpr): LinExpr => {
    let out: LinExpr = { coeffs: new Map(), constant: lin.constant }
    for (const [id, c] of lin.coeffs) {
      const leaf = tm.arithVars.get(id)!
      out = addLin(out, scaleLin(tm.linearize(rw(leaf)), c))
    }
    return out
  }

  const rwFormula = (f: Formula): Formula => {
    switch (f.kind) {
      case 'const':
        return f
      case 'not':
        return tm.not(rwFormula(f.arg))
      case 'and':
        return tm.and(f.args.map(rwFormula))
      case 'or':
        return tm.or(f.args.map(rwFormula))
      case 'imp':
        return tm.imp(rwFormula(f.a), rwFormula(f.b))
      case 'iff':
        return tm.iff(rwFormula(f.a), rwFormula(f.b))
      case 'xor':
        return tm.xor(rwFormula(f.a), rwFormula(f.b))
      case 'ite':
        return tm.ite(rwFormula(f.c), rwFormula(f.t), rwFormula(f.e))
      case 'pred':
        return tm.pred(rw(f.term))
      case 'eq':
        return tm.eq(rw(f.a), rw(f.b))
      case 'arith':
        return tm.arithAtom(f.rel, rwLin(f.lin))
    }
  }

  // functional consistency axioms, grouped by function symbol.
  const byFun = new Map<string, Term[]>()
  for (const t of terms.values()) {
    if (!isUFApp(t)) continue
    if (!byFun.has(t.op)) byFun.set(t.op, [])
    byFun.get(t.op)!.push(t)
  }
  const axioms: Formula[] = []
  for (const apps of byFun.values()) {
    for (let i = 0; i < apps.length; i++) {
      for (let j = i + 1; j < apps.length; j++) {
        const p = apps[i]
        const q = apps[j]
        if (p.args.length !== q.args.length) continue
        const premise: Formula[] = []
        for (let k = 0; k < p.args.length; k++) premise.push(tm.eq(rw(p.args[k]), rw(q.args[k])))
        const concl = tm.eq(repl.get(p.id)!, repl.get(q.id)!)
        axioms.push(tm.imp(tm.and(premise), concl))
      }
    }
  }

  const body = rwFormula(root)
  void Rational
  return axioms.length ? tm.and([body, ...axioms]) : body
}
