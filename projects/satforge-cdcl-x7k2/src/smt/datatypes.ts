// The theory of algebraic datatypes (QF_DT) — constructors, selectors and
// testers over a free term algebra (lists, trees, pairs, enums, `Nat`) — decided
// WITHOUT a new theory solver, by *reducing* it to the EUF + linear-integer
// arithmetic the DPLL(T) engine already has. This is the project's recurring move
// (`arithTrichotomy`, `reduceArrays`): teach the solver a whole new logic as a
// sound, satisfiability-preserving rewrite so every existing theory inherits it.
//
// Every datatype operation is ALREADY an ordinary term — a constructor `cons(h,t)`
// is a declared function application, a selector `tail(x)` likewise, and a tester
// `((_ is cons) x)` is a `pred` over a unary Boolean function `is-cons(x)`. So the
// reduction is purely ADDITIVE: it leaves the formula's atoms in place and only
// *conjoins* the axioms that pin those uninterpreted symbols to behave like a free
// term algebra, instantiated on the ground datatype terms (closed under selectors
// via the tester link, with a finite instantiation budget). Five ingredients:
//
//   1. Exhaustiveness + disjointness — every datatype term satisfies EXACTLY ONE
//      tester (`is_C₁(t) ∨ … ∨ is_Cₙ(t)` and `¬(is_Cᵢ(t) ∧ is_Cⱼ(t))`).
//
//   2. Constructor pinning — a literal term `C(a₁…aₖ)` forces `is_C` true and
//      `selᵢ(C(…)) = aᵢ`. The selector axioms give INJECTIVITY for free: from
//      `C(a)=C(b)`, congruence on each `selᵢ` yields `aᵢ=bᵢ`.
//
//   3. Tester link — `is_C(t) → t = C(sel₁(t), …, selₖ(t))`, materialising a
//      term's children when it is known to be a `C` (what makes selectors on
//      variables sound and complete).
//
//   4. Acyclicity by integer rank — the only genuinely non-EUF ingredient. A
//      finite term cannot be its own subterm, so we mint `rank : D → Int` and
//      assert `rank(t) > rank(child)` across every constructor edge. Over a FINITE
//      set of ground terms, a strict `>` ordering is exactly acyclicity (a cycle
//      would force `rank(t) > … > rank(t)`), and the existing simplex / integer
//      branch-and-bound discharges it. Datatypes become QF_UFLIA — Ackermann-
//      combined exactly like UFLIA / QF_ALIA already are.
//
// The output is an ordinary Formula over eq / pred / arith atoms handed straight
// to the existing EUF + simplex (+ Ackermann) pipeline — zero theory-solver code.

import { type DtConstructor, type Formula, type Sort, type Term, type TermManager } from './term'
import { collectAtoms } from './reference'

/** Does the formula mention any datatype-sorted term (constructor, selector, tester, var)? */
export function hasDatatypes(tm: TermManager, root: Formula): boolean {
  let found = false
  const scan = (t: Term): void => {
    if (found) return
    if (tm.isDatatypeSort(t.sort)) found = true
    for (const a of t.args) scan(a)
  }
  for (const a of collectAtoms(root)) {
    if (a.kind === 'eq') {
      scan(a.a)
      scan(a.b)
    } else if (a.kind === 'pred') {
      scan(a.term)
    } else {
      for (const id of a.lin.coeffs.keys()) {
        const t = tm.arithVars.get(id)
        if (t) scan(t)
      }
    }
  }
  return found
}

/**
 * Rewrite `root` into an equisatisfiable Formula over EUF + integer arithmetic
 * with the datatype axioms made explicit. Additive: the original formula is kept
 * verbatim and the axiom instances are conjoined.
 */
export function reduceDatatypes(tm: TermManager, root: Formula): Formula {
  const aux: Formula[] = []
  const seen = new Set<number>() // datatype term ids already axiomatized
  const queue: { t: Term; depth: number }[] = []

  // A single integer rank function per datatype sort: rank$D : D → Int.
  const rankFun = new Map<Sort, string>()
  const rankOf = (t: Term): Term => {
    let fn = rankFun.get(t.sort)
    if (!fn) {
      fn = `rank$${t.sort}`
      if (!tm.getFun(fn)) tm.declareFun({ name: fn, argSorts: [t.sort], retSort: 'Int' })
      rankFun.set(t.sort, fn)
    }
    return tm.app(fn, [t])
  }

  const enqueue = (t: Term, depth: number): void => {
    if (tm.isDatatypeSort(t.sort) && !seen.has(t.id)) {
      seen.add(t.id)
      queue.push({ t, depth })
    }
  }

  // Seed the queue with every datatype-sorted subterm in the formula (depth 0).
  const collect = (t: Term): void => {
    for (const a of t.args) collect(a)
    enqueue(t, 0)
  }
  for (const a of collectAtoms(root)) {
    if (a.kind === 'eq') {
      collect(a.a)
      collect(a.b)
    } else if (a.kind === 'pred') {
      collect(a.term)
    } else {
      for (const id of a.lin.coeffs.keys()) {
        const t = tm.arithVars.get(id)
        if (t) collect(t)
      }
    }
  }

  // Finite instantiation bound for the selector closure introduced by the tester
  // link. Ground datatype satisfiability needs only a bounded selector expansion;
  // the recursive types' links are instantiated on the formula's own terms (depth
  // 0) plus a couple of fresh selector levels — enough to expose any cycle already
  // expressible over those terms. A hard term cap is a backstop. Stopping early
  // stays sound — it only ever drops valid axioms, never adds a wrong one.
  const linkDepth = 2
  const cap = seen.size + 256

  const isCtor = (op: string, ctors: DtConstructor[]): DtConstructor | undefined => ctors.find((c) => c.name === op)

  while (queue.length) {
    const { t, depth } = queue.shift()!
    const dt = tm.getDatatype(t.sort)
    if (!dt) continue
    const testers = dt.ctors.map((c) => tm.pred(tm.app(c.tester, [t])))

    // (1) Exhaustiveness + disjointness: exactly one tester holds.
    aux.push(tm.or(testers))
    for (let i = 0; i < testers.length; i++)
      for (let j = i + 1; j < testers.length; j++) aux.push(tm.not(tm.and([testers[i], testers[j]])))

    const ownCtor = t.kind === 'app' && !t.arith ? isCtor(t.op, dt.ctors) : undefined
    if (ownCtor) {
      // (2) Constructor pinning. `t = C(a₁…aₖ)`: recognize it, fix its selectors
      // (→ injectivity via congruence), and rank above its datatype children.
      aux.push(tm.pred(tm.app(ownCtor.tester, [t])))
      for (let k = 0; k < ownCtor.selectors.length; k++) {
        aux.push(tm.eq(tm.app(ownCtor.selectors[k].name, [t]), t.args[k]))
        if (tm.isDatatypeSort(ownCtor.selectors[k].sort)) {
          aux.push(tm.rel('gt', rankOf(t), rankOf(t.args[k])))
          enqueue(t.args[k], depth) // children of a literal constructor keep the depth
        }
      }
      continue // shape is fully known — no tester link needed
    }

    // Past the link-instantiation depth, a term still gets exactly-one-tester (and
    // a well-defined rank), but we stop materialising fresh selector children.
    if (depth >= linkDepth) continue

    // (3) + (4) Tester link with rank edges, for non-constructor terms (variables,
    // selector applications). Each `is_C(t)` makes `t` a `C` of its own selectors,
    // strictly out-ranking every recursive child.
    for (const c of dt.ctors) {
      const isC = tm.pred(tm.app(c.tester, [t]))
      const sels = c.selectors.map((s) => tm.app(s.name, [t]))
      const recon = tm.app(c.name, sels)
      aux.push(tm.imp(isC, tm.eq(t, recon)))
      for (let k = 0; k < c.selectors.length; k++) {
        if (tm.isDatatypeSort(c.selectors[k].sort)) {
          aux.push(tm.imp(isC, tm.rel('gt', rankOf(t), rankOf(sels[k]))))
          if (seen.size < cap) enqueue(sels[k], depth + 1)
        }
      }
    }
  }

  return aux.length ? tm.and([root, ...aux]) : root
}
