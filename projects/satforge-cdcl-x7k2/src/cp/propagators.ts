// The propagators — the executable form of each constraint. Every factory here
// returns a `Propagator` (see store.ts) that narrows domains toward a fixpoint.
//
// Soundness contract: a propagator may only remove a value that CANNOT belong
// to any solution of *its own* constraint given the current domains. It never
// needs to be "complete" on its own — the fixpoint loop and search fill the
// gaps — but it must never delete a value that a full solution uses.

import {
  contains,
  keepOnly,
  max,
  min,
  removeAbove,
  removeBelow,
  removeInterval,
  removeValue,
} from './domain.ts'
import type { Propagator, Store } from './store.ts'
import { bipartiteMatching, stronglyConnectedComponents } from './graph.ts'

// ---- exact integer floor/ceil division (avoids all float rounding) --------

/** ⌊a / b⌋ for integer a and non-zero integer b, exact. */
export function floordiv(a: number, b: number): number {
  const q = Math.trunc(a / b)
  const r = a - q * b
  return r !== 0 && r < 0 !== b < 0 ? q - 1 : q
}

/** ⌈a / b⌉ for integer a and non-zero integer b, exact. */
export function ceildiv(a: number, b: number): number {
  return -floordiv(-a, b)
}

// ---- linear: Σ coeffs[i]·vars[i] ≤ c --------------------------------------

/**
 * Bounds-consistent propagator for `Σ aᵢ·xᵢ ≤ c`. Zero coefficients should be
 * dropped by the caller. This is the workhorse: `=`, `≥`, `<`, `>` and plain
 * arithmetic all lower to one or two of these (see model.ts).
 */
export function linearLe(coeffs: number[], vars: number[], c: number): Propagator {
  const label = formatLinear(coeffs, vars, '≤', c)
  return {
    scope: vars,
    label,
    propagate(store: Store) {
      const ds = vars.map((v) => store.doms[v])
      // Minimum possible value of the left-hand side, per term.
      const contribMin: number[] = new Array(vars.length)
      let minSum = 0
      for (let i = 0; i < vars.length; i++) {
        const a = coeffs[i]
        const cm = a >= 0 ? a * min(ds[i]) : a * max(ds[i])
        contribMin[i] = cm
        minSum += cm
      }
      if (minSum > c) {
        store.signalFail()
        return
      }
      // For each term: aᵢ·xᵢ ≤ slackᵢ where slackᵢ = c − (minSum − contribMinᵢ).
      for (let i = 0; i < vars.length; i++) {
        const a = coeffs[i]
        const slack = c - (minSum - contribMin[i])
        if (a > 0) {
          const ub = floordiv(slack, a)
          store.narrow(vars[i], removeAbove(store.doms[vars[i]], ub))
        } else {
          const lb = ceildiv(slack, a)
          store.narrow(vars[i], removeBelow(store.doms[vars[i]], lb))
        }
        if (store.failed) return
      }
    },
  }
}

// ---- x ≠ y + k -------------------------------------------------------------

/** `a ≠ b + k`. Prunes only when one side is fixed (arc consistency on ≠). */
export function notEqual(a: number, b: number, k = 0): Propagator {
  return {
    scope: [a, b],
    label: k === 0 ? `x${a} ≠ x${b}` : `x${a} ≠ x${b}${k >= 0 ? '+' + k : k}`,
    propagate(store: Store) {
      const da = store.doms[a]
      const db = store.doms[b]
      if (da.length === 1) store.narrow(b, removeValue(db, da[0] - k))
      const db2 = store.doms[b]
      const da2 = store.doms[a]
      if (db2.length === 1) store.narrow(a, removeValue(da2, db2[0] + k))
    },
  }
}

// ---- element: y = arr[idx] (constant array) --------------------------------

/** Domain-consistent `y = arr[idx]` for a constant array `arr`. */
export function element(y: number, idx: number, arr: number[]): Propagator {
  return {
    scope: [y, idx],
    label: `x${y} = arr[x${idx}]`,
    propagate(store: Store) {
      const dy0 = store.doms[y]
      const di = store.doms[idx]
      // Restrict idx to positions i with 0≤i<arr.length and arr[i] ∈ dom(y).
      const okIdx = new Set<number>()
      const possibleY = new Set<number>()
      for (const i of di) {
        if (i >= 0 && i < arr.length && contains(dy0, arr[i])) {
          okIdx.add(i)
          possibleY.add(arr[i])
        }
      }
      store.narrow(idx, keepOnly(di, okIdx))
      store.narrow(y, keepOnly(store.doms[y], possibleY))
    },
  }
}

// ---- positive table: (x₀,…,x_{k-1}) ∈ tuples -------------------------------

/** Domain-consistent positive table constraint (GAC by support counting). */
export function table(vars: number[], tuples: number[][]): Propagator {
  return {
    scope: vars,
    label: `table(${vars.map((v) => 'x' + v).join(',')}; ${tuples.length} tuples)`,
    propagate(store: Store) {
      const ds = vars.map((v) => store.doms[v])
      const support: Array<Set<number>> = vars.map(() => new Set<number>())
      for (const t of tuples) {
        let valid = true
        for (let p = 0; p < vars.length; p++) {
          if (!contains(ds[p], t[p])) {
            valid = false
            break
          }
        }
        if (!valid) continue
        for (let p = 0; p < vars.length; p++) support[p].add(t[p])
      }
      for (let p = 0; p < vars.length; p++) {
        store.narrow(vars[p], keepOnly(store.doms[vars[p]], support[p]))
        if (store.failed) return
      }
    },
  }
}

// ---- all-different ---------------------------------------------------------

export type AllDiffLevel = 'value' | 'bounds' | 'domain'

/**
 * `all-different(vars)` at one of three filtering strengths:
 *   - 'value':  forward checking — when a var is fixed, its value is removed
 *               from the others (arc consistency on the ≠ decomposition).
 *   - 'bounds': Hall-interval bounds consistency (López-Ortiz et al. 2003) —
 *               tightens the endpoints using unavoidable "Hall intervals".
 *   - 'domain': Régin's domain consistency (GAC) — removes every value that
 *               cannot be part of any all-different assignment, via a maximum
 *               matching + SCC / free-vertex reachability analysis.
 */
export function allDifferent(vars: number[], level: AllDiffLevel = 'domain'): Propagator {
  const label = `allDiff(${vars.map((v) => 'x' + v).join(',')}) · ${level}`
  return {
    scope: vars,
    label,
    propagate(store: Store) {
      if (level === 'value') propagateValue(store, vars)
      else if (level === 'bounds') propagateBounds(store, vars)
      else propagateRegin(store, vars)
    },
  }
}

function propagateValue(store: Store, vars: number[]): void {
  for (let i = 0; i < vars.length; i++) {
    const d = store.doms[vars[i]]
    if (d.length !== 1) continue
    const v = d[0]
    for (let j = 0; j < vars.length; j++) {
      if (j === i) continue
      store.narrow(vars[j], removeValue(store.doms[vars[j]], v))
      if (store.failed) return
    }
  }
}

// Hall-interval reasoning (interval / bounds consistency). A "Hall set" is a set
// H of variables whose domains all lie inside an interval [a,b] with
// |H| = b−a+1: those variables must occupy *every* integer of [a,b], so no other
// variable may take any value in [a,b]. We detect Hall intervals directly over
// the O(n²) intervals defined by the variables' current endpoints — simple and
// manifestly correct at studio scale — and prune the interval from the other
// variables. Also fails fast when some interval is over-subscribed (a pigeonhole
// contradiction stronger than the whole-scope one).
function propagateBounds(store: Store, vars: number[]): void {
  const n = vars.length
  if (n === 0) return
  const endpoints: number[] = []
  for (const v of vars) {
    endpoints.push(min(store.doms[v]), max(store.doms[v]))
  }
  const uniq = [...new Set(endpoints)].sort((x, y) => x - y)

  for (let ai = 0; ai < uniq.length; ai++) {
    for (let bi = ai; bi < uniq.length; bi++) {
      const a = uniq[ai]
      const b = uniq[bi]
      const width = b - a + 1
      // Variables whose whole domain sits inside [a,b].
      const inside: number[] = []
      for (const v of vars) {
        const d = store.doms[v]
        if (min(d) >= a && max(d) <= b) inside.push(v)
      }
      if (inside.length > width) {
        store.signalFail()
        return
      }
      if (inside.length === width && width > 0) {
        // Hall set: remove [a,b] from every variable NOT in it.
        const insideSet = new Set(inside)
        for (const v of vars) {
          if (insideSet.has(v)) continue
          store.narrow(v, removeInterval(store.doms[v], a, b))
          if (store.failed) return
        }
      }
    }
  }
}

// ---- Régin's domain-consistent all-different (GAC) -------------------------

function propagateRegin(store: Store, vars: number[]): void {
  const n = vars.length
  const ds = vars.map((v) => store.doms[v])

  // Map every value that appears to a dense index.
  const valueIndex = new Map<number, number>()
  const valuesList: number[] = []
  for (const d of ds) {
    for (const val of d) {
      if (!valueIndex.has(val)) {
        valueIndex.set(val, valuesList.length)
        valuesList.push(val)
      }
    }
  }
  const m = valuesList.length
  if (m < n) {
    // Fewer distinct values than variables ⇒ pigeonhole ⇒ infeasible.
    store.signalFail()
    return
  }

  // Variable → value-index adjacency.
  const adj: number[][] = ds.map((d) => d.map((val) => valueIndex.get(val)!))

  // Maximum matching (variables on the left, values on the right).
  const { matchLeft, matchRight, size: msize } = bipartiteMatching(n, m, adj)
  if (msize < n) {
    // No system of distinct representatives ⇒ infeasible.
    store.signalFail()
    return
  }

  // Build the oriented residual graph on nodes: variable i → node i,
  // value k → node n+k. Matching edges var→val; non-matching edges val→var.
  const N = n + m
  const g: number[][] = Array.from({ length: N }, () => [])
  for (let i = 0; i < n; i++) {
    for (const k of adj[i]) {
      if (matchLeft[i] === k) g[i].push(n + k)
      else g[n + k].push(i)
    }
  }

  // Reachability from free (unmatched) values: those value nodes are the
  // starting points of even alternating paths.
  const reach = new Uint8Array(N)
  const stack: number[] = []
  for (let k = 0; k < m; k++) {
    if (matchRight[k] === -1) {
      const node = n + k
      if (!reach[node]) {
        reach[node] = 1
        stack.push(node)
      }
    }
  }
  while (stack.length > 0) {
    const u = stack.pop()!
    for (const w of g[u]) {
      if (!reach[w]) {
        reach[w] = 1
        stack.push(w)
      }
    }
  }

  // Strongly-connected components: an edge inside an SCC lies on an alternating
  // cycle and so is part of some maximum matching.
  const comp = stronglyConnectedComponents(g)

  // Prune: a non-matching edge (value k → variable i) is removable unless its
  // endpoints share an SCC or the value is reachable from a free value.
  for (let i = 0; i < n; i++) {
    let d = store.doms[vars[i]]
    for (const k of adj[i]) {
      if (matchLeft[i] === k) continue // matching edge: always kept
      const keep = comp[n + k] === comp[i] || reach[n + k] === 1
      if (!keep) d = removeValue(d, valuesList[k])
    }
    store.narrow(vars[i], d)
    if (store.failed) return
  }
}

// ---- formatting ------------------------------------------------------------

function formatLinear(coeffs: number[], vars: number[], op: string, c: number): string {
  const terms = coeffs.map((a, i) => {
    const name = `x${vars[i]}`
    if (a === 1) return `+${name}`
    if (a === -1) return `−${name}`
    return `${a >= 0 ? '+' : '−'}${Math.abs(a)}${name}`
  })
  let s = terms.join(' ').replace(/^\+/, '')
  if (s.length > 48) s = s.slice(0, 45) + '…'
  return `${s} ${op} ${c}`
}
