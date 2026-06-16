// An independent reference decision procedure for the quantifier-free theory of
// arrays, used ONLY by the test harness to cross-check the reduction-based
// solver. It shares no code with `arrays.ts`: instead of rewriting away
// select/store, it enumerates *concrete finite models* — every assignment of a
// value to each index/element constant and of a full function (index→element)
// to each array variable — and evaluates select/store with their honest
// set-theoretic meaning (store really builds a new function). A formula is
// satisfiable iff some finite model makes it true.
//
// Soundness vs. the (infinite-sort) solver rests on the array small-model
// property: a satisfiable QF array formula has a model whose index domain is
// bounded by its index terms and whose element domain is bounded by its element
// terms. We size the finite domains to that bound (plus a slot for an
// extensionality witness / a fresh value), so finite-SAT ⟺ infinite-SAT. When
// the resulting enumeration would be too large we report `null` and the harness
// skips that instance — the agreement on the rest is still real evidence.

import { isArraySort, isConstArrayOp, type Atom, type Formula, type Sort, type Term } from './term'
import { collectAtoms, evalFormula } from './reference'

/** Decide a pure (uninterpreted index/element) array formula by finite-model
 *  enumeration. Returns true/false, or null if it is out of scope / too large. */
export function referenceSatArrays(f: Formula, idxSort: Sort, elemSort: Sort, sizeCap = 4_000_000): boolean | null {
  const atoms = collectAtoms(f)
  // Scope check: only equality atoms over the two given sorts are supported.
  for (const a of atoms) {
    if (a.kind !== 'eq') return null
    if (!sortOk(a.a.sort, idxSort, elemSort) || !sortOk(a.b.sort, idxSort, elemSort)) return null
  }

  // Gather subterms and the 0-ary symbols, classified by sort.
  const sub = new Map<number, Term>()
  for (const a of atoms) {
    if (a.kind === 'eq') {
      subterms(a.a, sub)
      subterms(a.b, sub)
    }
  }
  const idxConsts: string[] = []
  const elemConsts: string[] = []
  const arrVars: string[] = []
  let idxTerms = 0
  let elemTerms = 0
  let arrayEqs = 0
  const arrSort = `(Array ${idxSort} ${elemSort})`
  for (const t of sub.values()) {
    if (t.sort === idxSort) idxTerms++
    else if (t.sort === elemSort) elemTerms++
    if (t.args.length === 0 && t.kind === 'app') {
      if (t.sort === idxSort) idxConsts.push(t.op)
      else if (t.sort === elemSort) elemConsts.push(t.op)
      else if (t.sort === arrSort) arrVars.push(t.op)
      else return null // an unexpected sort
    }
  }
  for (const a of atoms) if (a.kind === 'eq' && isArraySort(a.a.sort)) arrayEqs++

  // Small-model domain sizes, guaranteed ≥ the array small-model bound. Each
  // array (dis)equality may need a fresh witness *index* and a pair of differing
  // *element* values, so both domains carry one slot of slack per array-equality
  // atom (and ≥2 elements so two arrays can ever differ at all).
  const dI = Math.max(1, idxTerms + arrayEqs + 1)
  const dE = Math.max(2, elemTerms + arrayEqs + 1)

  // Odometer over: each index const (radix dI), each element const (radix dE),
  // each array variable (dI cells, each radix dE).
  const radices: number[] = []
  for (let k = 0; k < idxConsts.length; k++) radices.push(dI)
  for (let k = 0; k < elemConsts.length; k++) radices.push(dE)
  for (let k = 0; k < arrVars.length; k++) for (let c = 0; c < dI; c++) radices.push(dE)
  let total = 1
  for (const r of radices) {
    total *= r
    if (total > sizeCap) return null
  }

  const digit = new Array(radices.length).fill(0)
  const idxVal = new Map<string, number>()
  const elemVal = new Map<string, number>()
  const arrVal = new Map<string, number[]>()

  const isArr = (s: Sort) => isArraySort(s)
  // evalTerm returns a number for index/element sorts, or number[] for arrays.
  const evalTerm = (t: Term): number | number[] => {
    if (t.args.length === 0) {
      if (t.sort === idxSort) return idxVal.get(t.op)!
      if (t.sort === elemSort) return elemVal.get(t.op)!
      return arrVal.get(t.op)!
    }
    if (t.op === 'select') {
      const fn = evalTerm(t.args[0]) as number[]
      const k = evalTerm(t.args[1]) as number
      return fn[k]
    }
    if (t.op === 'store') {
      const fn = (evalTerm(t.args[0]) as number[]).slice()
      const k = evalTerm(t.args[1]) as number
      fn[k] = evalTerm(t.args[2]) as number
      return fn
    }
    if (isConstArrayOp(t.op)) {
      const val = evalTerm(t.args[0]) as number
      return new Array(dI).fill(val)
    }
    throw new Error(`arrayref: unexpected term ${t.op}`)
  }

  const atomVal = (a: Atom): boolean => {
    if (a.kind !== 'eq') throw new Error('arrayref: unexpected atom')
    const va = evalTerm(a.a)
    const vb = evalTerm(a.b)
    if (isArr(a.a.sort)) {
      const fa = va as number[]
      const fb = vb as number[]
      for (let c = 0; c < dI; c++) if (fa[c] !== fb[c]) return false
      return true
    }
    return va === vb
  }

  do {
    // Decode the odometer into the assignment maps.
    let p = 0
    for (const name of idxConsts) idxVal.set(name, digit[p++])
    for (const name of elemConsts) elemVal.set(name, digit[p++])
    for (const name of arrVars) {
      const cells: number[] = []
      for (let c = 0; c < dI; c++) cells.push(digit[p++])
      arrVal.set(name, cells)
    }
    if (evalFormula(f, atomVal)) return true
  } while (inc(digit, radices))
  return false
}

function sortOk(s: Sort, idxSort: Sort, elemSort: Sort): boolean {
  return s === idxSort || s === elemSort || s === `(Array ${idxSort} ${elemSort})`
}

function subterms(t: Term, out: Map<number, Term>): void {
  if (out.has(t.id)) return
  out.set(t.id, t)
  for (const a of t.args) subterms(a, out)
}

/** Increment a mixed-radix odometer in place; false when it wraps to all-zero. */
function inc(digit: number[], radices: number[]): boolean {
  for (let i = 0; i < digit.length; i++) {
    digit[i]++
    if (digit[i] < radices[i]) return true
    digit[i] = 0
  }
  return false
}
