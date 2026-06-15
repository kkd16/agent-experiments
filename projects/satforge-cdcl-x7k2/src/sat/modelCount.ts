// Exact propositional model counting (#SAT), from scratch.
//
// Deciding satisfiability tells you *whether* a formula has a solution; #SAT tells
// you *how many*. This is a strictly harder problem (#P-complete), and the engine
// that answers it is different from CDCL: a DPLL-style recursion that
//
//   • unit-propagates forced assignments (a forced variable multiplies the count by 1),
//   • counts "free" variables — ones that drop out of every remaining clause — as a
//     factor of 2 each (each may independently be true or false),
//   • decomposes the residual formula into CONNECTED COMPONENTS (sub-formulas sharing
//     no variables): the total count is the *product* of the component counts, and
//   • CACHES component counts (Cachet-style "formula caching") keyed by the canonical
//     clause set, so a sub-formula that recurs across the search is counted once.
//
// All arithmetic is BigInt, so the exact count never overflows even when it is
// astronomically large (e.g. millions of N-Queens placements).

import type { CNF } from './cnf'

export interface CountResult {
  /** Exact number of satisfying assignments over all `numVars` variables, or null if aborted. */
  count: bigint | null
  /** False when the node budget was exhausted before finishing. */
  exact: boolean
  /** DPLL recursion nodes explored. */
  nodes: number
  /** Component-cache hits (sub-formulas counted from the cache). */
  cacheHits: number
  /** Distinct sub-formulas stored in the cache. */
  cacheSize: number
  timeMs: number
}

export interface CountOptions {
  /** Abort (returns count: null, exact: false) after this many recursion nodes. */
  budget?: number
}

/** A connected component: a set of clauses plus the variables they span. */
interface Component {
  clauses: number[][]
  vars: Set<number>
}

export function countModels(cnf: CNF, opts: CountOptions = {}): CountResult {
  const budget = opts.budget ?? 400000
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

  // Normalize: drop tautologies and duplicate literals; an empty clause => 0 models.
  const clauses: number[][] = []
  for (const c of cnf.clauses) {
    const seen = new Set<number>()
    let taut = false
    const lits: number[] = []
    for (const l of c) {
      if (l === 0) continue
      if (seen.has(-l)) {
        taut = true
        break
      }
      if (seen.has(l)) continue
      seen.add(l)
      lits.push(l)
    }
    if (taut) continue
    if (lits.length === 0) {
      return { count: 0n, exact: true, nodes: 0, cacheHits: 0, cacheSize: 0, timeMs: now() - start }
    }
    clauses.push(lits)
  }

  const allVars = new Set<number>()
  for (let v = 1; v <= cnf.numVars; v++) allVars.add(v)

  let nodes = 0
  let cacheHits = 0
  let aborted = false
  const cache = new Map<string, bigint>()
  const pow2 = (n: number): bigint => 1n << BigInt(n)

  // Count satisfying assignments over `vars` for `clauses` (every variable mentioned
  // in `clauses` is in `vars`). Variables in `vars` that vanish become free factors.
  function count(clauses: number[][], vars: Set<number>): bigint {
    if (aborted) return 0n
    if (++nodes > budget) {
      aborted = true
      return 0n
    }

    // ---- unit propagation to a fixpoint ----
    const assign = new Map<number, boolean>()
    let work = clauses
    let conflict = false
    for (;;) {
      const simp: number[][] = []
      const units: number[] = []
      for (const cl of work) {
        let sat = false
        const rem: number[] = []
        for (const l of cl) {
          const v = Math.abs(l)
          if (assign.has(v)) {
            if (assign.get(v)! === l > 0) {
              sat = true
              break
            }
            // literal is false under `assign` — drop it
          } else rem.push(l)
        }
        if (sat) continue
        if (rem.length === 0) {
          conflict = true
          break
        }
        if (rem.length === 1) units.push(rem[0])
        simp.push(rem)
      }
      if (conflict) break
      work = simp
      if (units.length === 0) break // fixpoint: no more forced literals
      let progressed = false
      for (const u of units) {
        const v = Math.abs(u)
        const val = u > 0
        if (assign.has(v)) {
          if (assign.get(v)! !== val) {
            conflict = true
            break
          }
        } else {
          assign.set(v, val)
          progressed = true
        }
      }
      if (conflict) break
      if (!progressed) break
    }
    if (conflict) return 0n

    // `work` now has only clauses of width >= 2, simplified under `assign`.
    const usedVars = new Set<number>()
    for (const cl of work) for (const l of cl) usedVars.add(Math.abs(l))

    // Variables in scope that are neither forced nor used are free (factor 2 each).
    let freeCount = 0
    for (const v of vars) if (!assign.has(v) && !usedVars.has(v)) freeCount++

    if (work.length === 0) return pow2(freeCount)

    let total = pow2(freeCount)
    for (const comp of connectedComponents(work, usedVars)) {
      total *= countComponent(comp)
      if (aborted) return 0n
    }
    return total
  }

  // Count one connected component (all clauses width >= 2, every var in `comp.vars`
  // appears). Memoized on the canonical clause set, then branched on a busy variable.
  function countComponent(comp: Component): bigint {
    const key = canonicalKey(comp.clauses)
    const hit = cache.get(key)
    if (hit !== undefined) {
      cacheHits++
      return hit
    }
    // Pick the most frequently occurring variable to branch on.
    const freq = new Map<number, number>()
    for (const cl of comp.clauses)
      for (const l of cl) {
        const v = Math.abs(l)
        freq.set(v, (freq.get(v) ?? 0) + 1)
      }
    let branch = -1
    let best = -1
    for (const [v, f] of freq)
      if (f > best) {
        best = f
        branch = v
      }
    const withTrue = comp.clauses.concat([[branch]])
    const withFalse = comp.clauses.concat([[-branch]])
    const result = count(withTrue, comp.vars) + count(withFalse, comp.vars)
    if (!aborted) cache.set(key, result)
    return result
  }

  const result = count(clauses, allVars)
  if (aborted)
    return { count: null, exact: false, nodes, cacheHits, cacheSize: cache.size, timeMs: now() - start }
  return { count: result, exact: true, nodes, cacheHits, cacheSize: cache.size, timeMs: now() - start }
}

/** Split a clause set into connected components by shared variables (union-find). */
function connectedComponents(clauses: number[][], vars: Set<number>): Component[] {
  const parent = new Map<number, number>()
  for (const v of vars) parent.set(v, v)
  const find = (x: number): number => {
    let r = x
    while (parent.get(r)! !== r) r = parent.get(r)!
    while (parent.get(x)! !== r) {
      const nx = parent.get(x)!
      parent.set(x, r)
      x = nx
    }
    return r
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const cl of clauses) {
    const v0 = Math.abs(cl[0])
    for (let i = 1; i < cl.length; i++) union(v0, Math.abs(cl[i]))
  }
  const byRoot = new Map<number, Component>()
  for (const cl of clauses) {
    const root = find(Math.abs(cl[0]))
    let comp = byRoot.get(root)
    if (!comp) {
      comp = { clauses: [], vars: new Set() }
      byRoot.set(root, comp)
    }
    comp.clauses.push(cl)
    for (const l of cl) comp.vars.add(Math.abs(l))
  }
  return [...byRoot.values()]
}

// A canonical, order-independent signature of a clause set. Literals are sorted
// within each clause and the clauses are sorted lexicographically, so two identical
// sub-formulas presented in any order share a cache entry. (Variable identities are
// preserved — sound because components live in a shared variable space.)
function canonicalKey(clauses: number[][]): string {
  const rows = clauses.map((c) => {
    const s = c.slice().sort((a, b) => a - b)
    return s.join(',')
  })
  rows.sort()
  return rows.join(';')
}
