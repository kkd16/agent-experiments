// An independent reference decision procedure for the quantifier-free theory of
// algebraic datatypes, used ONLY by the test harness to cross-check the
// reduction-based solver. It shares no code with `datatypes.ts`: instead of
// adding term-algebra axioms, it enumerates *honest finite tree models* — every
// datatype value is a real constructor tree, constructors really build trees,
// testers read the real root constructor, and equality is structural. A formula
// is satisfiable iff some finite model makes it true.
//
// Soundness vs. the (infinite) datatype theory rests on the term-algebra
// small-model property: a satisfiable ground datatype formula has a model whose
// every value is a finite tree of depth bounded by the number of datatype terms.
// We size each sort's domain to that bound (the set of all constructor trees up to
// the depth), so finite-SAT ⟺ infinite-SAT. Because trees are finite by
// construction, an impossible cyclic value (`x = cons(h,x)`) is simply never in
// the domain — which is exactly how this oracle independently witnesses
// acyclicity. When the enumeration would be too large we return `null` and the
// harness skips that instance.
//
// Scope (kept deliberately narrow so the oracle stays honest and simple): equality
// over datatype / uninterpreted-leaf sorts, constructor applications, and testers.
// Selectors and arithmetic are out of scope → `null` (those are covered by the
// hand-written and example checks instead).

import { type Atom, type Formula, type Sort, type Term, type TermManager } from './term'
import { collectAtoms, evalFormula } from './reference'

// A finite datatype value: a constructor with its children (datatype children are
// nested Trees, leaf children are small integers).
interface Tree {
  c: string
  ch: (Tree | number)[]
}

const BUILTIN = new Set(['Bool', 'Int', 'Real'])

function treeKey(v: Tree | number): string {
  if (typeof v === 'number') return `#${v}`
  return `${v.c}(${v.ch.map(treeKey).join(',')})`
}

/** Decide a pure datatype formula by finite tree-model enumeration. Returns
 *  true/false, or null if it is out of scope / too large. */
export function referenceSatDatatypes(tm: TermManager, f: Formula, sizeCap = 2_000_000): boolean | null {
  const atoms = collectAtoms(f)

  // Gather every subterm; classify sorts; bail on anything out of scope.
  const sub = new Map<number, Term>()
  const subterms = (t: Term): void => {
    if (sub.has(t.id)) return
    sub.set(t.id, t)
    for (const a of t.args) subterms(a)
  }
  const isLeafSort = (s: Sort): boolean =>
    !tm.isDatatypeSort(s) && !BUILTIN.has(s) && !tm.isArraySort(s)

  for (const a of atoms) {
    if (a.kind === 'eq') {
      subterms(a.a)
      subterms(a.b)
      // equalities must be over datatype or uninterpreted-leaf sorts
      if (!(tm.isDatatypeSort(a.a.sort) || isLeafSort(a.a.sort))) return null
    } else if (a.kind === 'pred') {
      // only testers are supported predicates
      if (!a.term.op.startsWith('is-')) return null
      subterms(a.term)
    } else {
      return null // arithmetic out of scope
    }
  }

  // 0-ary constants to assign, by sort; reject selectors (out of scope).
  const dtConsts = new Map<Sort, string[]>()
  const leafConsts = new Map<Sort, string[]>()
  const dtSortsUsed = new Set<Sort>()
  const leafSortsUsed = new Set<Sort>()
  let maxNest = 0
  const nestDepth = (t: Term): number => {
    if (!tm.isDatatypeSort(t.sort)) return 0
    if (t.args.length === 0) return 0
    return 1 + Math.max(0, ...t.args.map(nestDepth))
  }
  for (const t of sub.values()) {
    if (tm.isDatatypeSort(t.sort)) {
      dtSortsUsed.add(t.sort)
      maxNest = Math.max(maxNest, nestDepth(t))
    } else if (isLeafSort(t.sort)) {
      leafSortsUsed.add(t.sort)
    }
    if (t.kind === 'app' && t.args.length === 0) {
      // A nullary *constructor* (nil, zero, red) is a fixed value, not a variable.
      if (tm.isDatatypeSort(t.sort)) {
        if (!isNullaryCtor(tm, t)) push(dtConsts, t.sort, t.op)
      } else if (isLeafSort(t.sort)) push(leafConsts, t.sort, t.op)
    } else if (t.kind === 'app' && t.args.length > 0 && !t.arith) {
      // a constructor application is fine; anything else (a selector) is not
      const dt = tm.getDatatype(t.sort)
      const isCtor = dt && dt.ctors.some((c) => c.name === t.op)
      const isTester = t.op.startsWith('is-')
      if (!isCtor && !isTester) return null
    }
  }

  // Leaf-sort domain sizes: enough distinct values for every leaf constant + slack.
  const leafSize = new Map<Sort, number>()
  for (const s of leafSortsUsed) leafSize.set(s, Math.max(2, (leafConsts.get(s)?.length ?? 0) + 1))

  // Datatype tree depth bound from the small-model property.
  const totalDtConsts = [...dtConsts.values()].reduce((n, xs) => n + xs.length, 0)
  const depth = Math.min(5, Math.max(2, totalDtConsts + maxNest))

  // Build the (mutually-recursive) tree domain for every datatype sort up to
  // `depth`, level by level. Bail to null if any sort's domain blows past the cap.
  const treesCap = 4000
  const domain = new Map<Sort, Tree[]>()
  for (const s of dtSortsUsed) domain.set(s, [])
  const leafValues = (s: Sort): number[] => Array.from({ length: leafSize.get(s) ?? 2 }, (_, i) => i)

  // Cumulative trees of each sort, grown depth by depth. Each level uses a SNAPSHOT
  // of the previous level's domains as the datatype-child pool, so a depth-d tree
  // has children of depth ≤ d-1 (exact depth control across mutual recursion).
  for (let d = 0; d <= depth; d++) {
    const prev = new Map<Sort, Tree[]>()
    for (const s of dtSortsUsed) prev.set(s, [...domain.get(s)!])
    for (const s of dtSortsUsed) {
      const dt = tm.getDatatype(s)!
      const out = domain.get(s)!
      const seen = new Set(out.map(treeKey))
      for (const c of dt.ctors) {
        const usesDt = c.selectors.some((sel) => tm.isDatatypeSort(sel.sort))
        if (d === 0 && usesDt) continue // depth-0 trees have no datatype children
        if (d > 0 && !usesDt) continue // leaf-only constructors are added at depth 0
        const optionLists: (Tree | number)[][] = []
        for (const sel of c.selectors) {
          if (tm.isDatatypeSort(sel.sort)) optionLists.push(prev.get(sel.sort) ?? [])
          else if (isLeafSort(sel.sort)) optionLists.push(leafValues(sel.sort))
          else return null // a non-datatype, non-leaf field (e.g. Int) — out of scope
        }
        for (const combo of product(optionLists)) {
          const tree: Tree = { c: c.name, ch: combo }
          const k = treeKey(tree)
          if (!seen.has(k)) {
            seen.add(k)
            out.push(tree)
            if (out.length > treesCap) return null
          }
        }
      }
    }
  }
  for (const s of dtSortsUsed) if ((domain.get(s)?.length ?? 0) === 0) return null

  // Odometer over: each datatype constant (radix = its sort's domain size), each
  // leaf constant (radix = leaf domain size).
  const slots: { name: string; sort: Sort; dt: boolean; radix: number }[] = []
  for (const [s, names] of dtConsts) for (const n of names) slots.push({ name: n, sort: s, dt: true, radix: domain.get(s)!.length })
  for (const [s, names] of leafConsts) for (const n of names) slots.push({ name: n, sort: s, dt: false, radix: leafSize.get(s)! })
  let total = 1
  for (const sl of slots) {
    total *= sl.radix
    if (total > sizeCap) return null
  }

  const dtVal = new Map<string, Tree>()
  const leafVal = new Map<string, number>()

  const evalTree = (t: Term): Tree => {
    if (t.args.length === 0) {
      if (isNullaryCtor(tm, t)) return { c: t.op, ch: [] } // a constructor value like nil
      return dtVal.get(t.op)! // a datatype variable
    }
    return { c: t.op, ch: t.args.map((a) => (tm.isDatatypeSort(a.sort) ? evalTree(a) : leafEval(a))) }
  }
  const leafEval = (t: Term): number => {
    if (t.args.length === 0) return leafVal.get(t.op)!
    throw new Error('dtref: unexpected leaf application')
  }

  const atomVal = (a: Atom): boolean => {
    if (a.kind === 'pred') {
      const ctor = a.term.op.slice('is-'.length)
      return evalTree(a.term.args[0]).c === ctor
    }
    if (a.kind === 'eq') {
      if (tm.isDatatypeSort(a.a.sort)) return treeKey(evalTree(a.a)) === treeKey(evalTree(a.b))
      return leafEval(a.a) === leafEval(a.b)
    }
    throw new Error('dtref: unexpected atom')
  }

  const digit = new Array(slots.length).fill(0)
  do {
    for (let i = 0; i < slots.length; i++) {
      const sl = slots[i]
      if (sl.dt) dtVal.set(sl.name, domain.get(sl.sort)![digit[i]])
      else leafVal.set(sl.name, digit[i])
    }
    if (evalFormula(f, atomVal)) return true
  } while (inc(digit, slots.map((s) => s.radix)))
  return false
}

/** Is `t` a 0-ary application of one of its datatype sort's constructors (e.g. nil)? */
function isNullaryCtor(tm: TermManager, t: Term): boolean {
  if (t.kind !== 'app' || t.args.length !== 0) return false
  const dt = tm.getDatatype(t.sort)
  return !!dt && dt.ctors.some((c) => c.name === t.op)
}

function push<T>(m: Map<Sort, T[]>, k: Sort, v: T): void {
  const cur = m.get(k)
  if (cur) {
    if (!cur.includes(v)) cur.push(v)
  } else m.set(k, [v])
}

/** Cartesian product of a list of option lists. */
function product<T>(lists: T[][]): T[][] {
  let acc: T[][] = [[]]
  for (const list of lists) {
    const next: T[][] = []
    for (const prefix of acc) for (const x of list) next.push([...prefix, x])
    acc = next
  }
  return acc
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
