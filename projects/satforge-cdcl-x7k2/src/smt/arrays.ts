// The theory of arrays (QF_AX) — McCarthy `select`/`store` — decided WITHOUT a
// new theory solver, by *reducing* arrays to the EUF + linear-arithmetic the
// DPLL(T) engine already has. This mirrors the project's recurring move
// (`arithTrichotomy`, `deriving`-style desugaring): teach the solver a whole new
// logic purely as a sound, complete, equisatisfiability-preserving rewrite, so
// every existing theory inherits it for free.
//
// Two ingredients:
//
//   1. Read-over-write purification. McCarthy's axioms say
//        select(store(a,i,v), j) = (i = j) ? v : select(a, j)
//      We eliminate every write that sits under a read by introducing a fresh
//      element symbol e for the read and *pinning* it with two implications
//        (i = j → e = v)   and   (i ≠ j → e = read(a, j))
//      recursing through nested stores. After purification every surviving
//      `select` is applied to a *plain* array term, so it is just an
//      uninterpreted binary function the congruence-closure engine already
//      reasons about (equal array + equal index ⇒ equal read).
//
//   2. Extensionality. Two arrays are equal iff they agree at every index. We
//      encode each array-equality atom a = b with a Boolean proxy P and a fresh
//      *witness* index k (Skolem):
//        ¬P → read(a,k) ≠ read(b,k)            (unequal ⇒ differ somewhere)
//        P  → read(a,j) = read(b,j)  ∀ j ∈ I   (equal ⇒ agree on every index)
//      over a *saturated* index set I (all read/write indices plus every
//      witness). This is the Stump–Barrett–Dill scheme, made finite and ground.
//      Dropping the extensionality clauses leaves a sound, complete procedure
//      for the (very common) non-extensional fragment, where arrays are only
//      observed through reads and writes.
//
// The output is an ordinary Formula over eq / arith / pred atoms, handed
// straight to the existing EUF + simplex (+ Ackermann, when arithmetic and the
// residual `select` UF mix) pipeline — zero changes to any theory solver.

import {
  addLin,
  scaleLin,
  isArraySort,
  isConstArrayOp,
  type Formula,
  type LinExpr,
  type Sort,
  type Term,
  type TermManager,
} from './term'
import { collectAtoms } from './reference'

let freshCounter = 0

/** Does the formula mention any array sort, `select`, or `store`? */
export function hasArrays(tm: TermManager, root: Formula): boolean {
  for (const a of collectAtoms(root)) {
    if (a.kind === 'eq') {
      if (termHasArray(a.a) || termHasArray(a.b)) return true
    } else if (a.kind === 'pred') {
      if (termHasArray(a.term)) return true
    } else {
      for (const id of a.lin.coeffs.keys()) {
        const t = tm.arithVars.get(id)
        if (t && termHasArray(t)) return true
      }
    }
  }
  return false
}

function termHasArray(t: Term): boolean {
  if (isArraySort(t.sort) || t.op === 'select' || t.op === 'store') return true
  return t.args.some(termHasArray)
}

interface ArrayEq {
  proxy: Term // fresh 0-ary Bool symbol standing for (a = b)
  witness: Term // fresh index symbol where a, b must differ when unequal
  a: Term // rewritten array term
  b: Term
  idxSort: Sort
}

/**
 * Rewrite `root` into an equisatisfiable Formula over EUF + arithmetic, with all
 * array operations eliminated. The returned formula uses only the existing atom
 * kinds, so the unmodified EUF + simplex theories decide it.
 */
export function reduceArrays(tm: TermManager, root: Formula): Formula {
  const aux: Formula[] = []
  const termMemo = new Map<number, Term>()
  const readMemo = new Map<string, Term>()
  const eqMemo = new Map<string, Formula>()
  const arrayEqs: ArrayEq[] = []
  // Index terms seen, bucketed by their (index) sort, for saturated instantiation.
  const indexSet = new Map<Sort, Map<number, Term>>()

  const recordIndex = (idx: Term): void => {
    let bucket = indexSet.get(idx.sort)
    if (!bucket) indexSet.set(idx.sort, (bucket = new Map()))
    if (!bucket.has(idx.id)) bucket.set(idx.id, idx)
  }

  const freshSym = (sort: Sort, tag: string): Term => {
    const name = `${tag}!${freshCounter++}`
    tm.declareFun({ name, argSorts: [], retSort: sort })
    return tm.app(name)
  }

  // read(arr, idx): the element value select(arr, idx), with writes purified.
  // Both arr and idx are already-rewritten terms.
  const read = (arr: Term, idx: Term): Term => {
    recordIndex(idx)
    const key = `${arr.id}.${idx.id}`
    const hit = readMemo.get(key)
    if (hit) return hit
    let out: Term
    if (arr.op === 'store' && arr.args.length === 3) {
      const [a, i, v] = arr.args
      recordIndex(i)
      const e = freshSym(tm.arrayElemSort(arr.sort), 'rd')
      aux.push(tm.imp(tm.eq(i, idx), tm.eq(e, v)))
      aux.push(tm.imp(tm.not(tm.eq(i, idx)), tm.eq(e, read(a, idx))))
      out = e
    } else if (isConstArrayOp(arr.op) && arr.args.length === 1) {
      // Every cell of a constant array reads back its single value.
      out = arr.args[0]
    } else {
      // Plain array term: select is an uninterpreted binary function.
      out = tm.select(arr, idx)
    }
    readMemo.set(key, out)
    return out
  }

  const rwTerm = (t: Term): Term => {
    const cached = termMemo.get(t.id)
    if (cached) return cached
    let out: Term
    if (t.kind === 'num' || t.args.length === 0) {
      out = t
    } else if (t.arith) {
      const a = t.args.map(rwTerm)
      if (t.op === '+') out = a.reduce((x, y) => tm.add(x, y))
      else if (t.op === '-') out = a.length === 1 ? tm.negTerm(a[0]) : a.reduce((x, y) => tm.sub(x, y))
      else if (t.op === '*') out = a.reduce((x, y) => tm.mul(x, y))
      else out = t
    } else if (t.op === 'select' && t.args.length === 2) {
      out = read(rwTerm(t.args[0]), rwTerm(t.args[1]))
    } else if (t.op === 'store' && t.args.length === 3) {
      out = tm.store(rwTerm(t.args[0]), rwTerm(t.args[1]), rwTerm(t.args[2]))
    } else if (isConstArrayOp(t.op) && t.args.length === 1) {
      out = tm.constArray(t.sort, rwTerm(t.args[0]))
    } else {
      out = tm.app(t.op, t.args.map(rwTerm))
    }
    termMemo.set(t.id, out)
    return out
  }

  const rwLin = (lin: LinExpr): LinExpr => {
    let out: LinExpr = { coeffs: new Map(), constant: lin.constant }
    for (const [id, c] of lin.coeffs) {
      const leaf = tm.arithVars.get(id)!
      out = addLin(out, scaleLin(tm.linearize(rwTerm(leaf)), c))
    }
    return out
  }

  // Replace an array-equality atom a = b by its Boolean proxy, registering the
  // extensionality obligation (and reusing one proxy per array pair).
  const arrayEqProxy = (a: Term, b: Term): Formula => {
    if (a.id === b.id) return tm.tt
    const key = a.id < b.id ? `${a.id},${b.id}` : `${b.id},${a.id}`
    const hit = eqMemo.get(key)
    if (hit) return hit
    const idxSort = tm.arrayIndexSort(a.sort)
    const proxy = freshSym('Bool', 'aeq')
    const witness = freshSym(idxSort, 'wit')
    arrayEqs.push({ proxy, witness, a, b, idxSort })
    const f = tm.pred(proxy)
    eqMemo.set(key, f)
    return f
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
        return tm.pred(rwTerm(f.term))
      case 'eq': {
        const a = rwTerm(f.a)
        const b = rwTerm(f.b)
        if (isArraySort(a.sort)) return arrayEqProxy(a, b)
        return tm.eq(a, b)
      }
      case 'arith':
        return tm.arithAtom(f.rel, rwLin(f.lin))
    }
  }

  const body = rwFormula(root)

  // Extensionality: build witness + agreement clauses over the *saturated* index
  // set. Completeness needs the agreement to range over every index term of the
  // relevant sort — including indices buried inside array-equality operands
  // (e.g. the `i` in `a = store(b,i,v)`), which the body pass above never read.
  // Scan for them before snapshotting.
  const neededSorts = new Set(arrayEqs.map((e) => e.idxSort))
  if (neededSorts.size) {
    const seenT = new Set<number>()
    const scan = (t: Term): void => {
      if (seenT.has(t.id)) return
      seenT.add(t.id)
      if (neededSorts.has(t.sort)) recordIndex(t)
      for (const x of t.args) scan(x)
    }
    for (const at of collectAtoms(body)) {
      if (at.kind === 'eq') {
        scan(at.a)
        scan(at.b)
      } else if (at.kind === 'pred') {
        scan(at.term)
      } else {
        for (const id of at.lin.coeffs.keys()) {
          const t = tm.arithVars.get(id)
          if (t) scan(t)
        }
      }
    }
    for (const eq of arrayEqs) {
      scan(eq.a)
      scan(eq.b)
    }
  }
  for (const eq of arrayEqs) recordIndex(eq.witness)
  const snapshot = new Map<Sort, Term[]>()
  for (const [s, m] of indexSet) snapshot.set(s, [...m.values()])
  for (const eq of arrayEqs) {
    const P = tm.pred(eq.proxy)
    aux.push(tm.imp(tm.not(P), tm.not(tm.eq(read(eq.a, eq.witness), read(eq.b, eq.witness)))))
    for (const j of snapshot.get(eq.idxSort) ?? []) {
      aux.push(tm.imp(P, tm.eq(read(eq.a, j), read(eq.b, j))))
    }
  }

  return aux.length ? tm.and([body, ...aux]) : body
}
