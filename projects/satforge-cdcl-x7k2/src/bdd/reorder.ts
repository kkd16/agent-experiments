// Variable reordering — why a BDD is small or astronomically large.
//
// The *order* in which variables are tested is the single biggest lever on a
// BDD's size. The textbook example is the bit-comparison function
//   (a1 ∧ b1) ∨ (a2 ∧ b2) ∨ … ∨ (an ∧ bn):
// interleave the variables a1 b1 a2 b2 … and the diagram is linear (2n+2 nodes);
// keep the two groups apart a1 a2 … b1 b2 … and it explodes to 2^n. Same
// function, same engine — only the order changed.
//
// We reorder by *reconstruction*: a BDD is rebuilt under a target order by
// Shannon-expanding the original function on whichever variable is topmost in
// the NEW order, taking cofactors in the source diagram. This is provably
// function-preserving (a cofactor identity), so the rebuilt diagram is the same
// Boolean function — only smaller or larger. `sift` then greedily searches each
// variable's best level (Rudell's sifting strategy) to shrink the diagram.

import { Bdd, BDD_FALSE, BDD_TRUE } from './bdd'
import type { NodeId } from './bdd'

export interface Reordered {
  bdd: Bdd
  root: NodeId
}

/**
 * Rebuild the function `(src, root)` under `newOrder` (a permutation of
 * 0..numVars-1, level → variable). Returns a fresh manager and the new root.
 */
export function reorder(src: Bdd, root: NodeId, newOrder: number[]): Reordered {
  const dest = new Bdd(src.numVars, newOrder)

  // Memoized support: the set of variables each source node depends on.
  const suppCache = new Map<NodeId, Set<number>>()
  const supportSet = (n: NodeId): Set<number> => {
    if (n < 2) return EMPTY
    const hit = suppCache.get(n)
    if (hit) return hit
    const s = new Set<number>(supportSet(src.low(n)))
    for (const v of supportSet(src.high(n))) s.add(v)
    s.add(src.varOf(n))
    suppCache.set(n, s)
    return s
  }

  const memo = new Map<NodeId, NodeId>()
  const rebuild = (f: NodeId): NodeId => {
    if (f < 2) return f
    const hit = memo.get(f)
    if (hit !== undefined) return hit
    // New-top variable: the one in support(f) sitting highest in the target order.
    let v = -1
    let bestLvl = Infinity
    for (const u of supportSet(f)) {
      const lvl = dest.pos[u]
      if (lvl < bestLvl) {
        bestLvl = lvl
        v = u
      }
    }
    const f0 = src.restrict(f, v, false)
    const f1 = src.restrict(f, v, true)
    const r = dest.mk(v, rebuild(f0), rebuild(f1))
    memo.set(f, r)
    return r
  }

  const newRoot = root < 2 ? root : rebuild(root)
  return { bdd: dest, root: newRoot }
}

const EMPTY: Set<number> = new Set()

/** Move variable `v` to level `target`, shifting the rest along. */
export function moveVar(order: number[], v: number, target: number): number[] {
  const without = order.filter((u) => u !== v)
  const clamped = Math.max(0, Math.min(target, without.length))
  without.splice(clamped, 0, v)
  return without
}

export interface SiftResult {
  bdd: Bdd
  root: NodeId
  order: number[]
  sizeBefore: number
  sizeAfter: number
  /** Best size seen after processing each variable — a shrink curve for the UI. */
  history: number[]
}

/**
 * Rudell sifting: take each variable in turn and slide it through every level,
 * keeping the position that yields the smallest diagram, then move on. A greedy
 * local search that routinely finds orders within a few percent of optimal.
 */
export function sift(src: Bdd, root: NodeId): SiftResult {
  const n = src.numVars
  let bestOrder = src.order.slice()
  let best = reorder(src, root, bestOrder)
  let bestSize = best.bdd.size(best.root)
  const sizeBefore = bestSize
  const history: number[] = []

  // Process variables most-constraining-first (largest current "span") — here we
  // simply walk variables by index; for the demo sizes this is plenty.
  for (let i = 0; i < n; i++) {
    const v = i
    let localBestOrder = bestOrder
    let localBestSize = bestSize
    let localBest = best
    for (let target = 0; target < n; target++) {
      const cand = moveVar(bestOrder, v, target)
      if (sameOrder(cand, bestOrder)) continue
      const r = reorder(src, root, cand)
      const s = r.bdd.size(r.root)
      if (s < localBestSize) {
        localBestSize = s
        localBestOrder = cand
        localBest = r
      }
    }
    bestOrder = localBestOrder
    bestSize = localBestSize
    best = localBest
    history.push(bestSize)
  }

  return { bdd: best.bdd, root: best.root, order: bestOrder, sizeBefore, sizeAfter: bestSize, history }
}

function sameOrder(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Reverse the current variable order — the classic way to blow a diagram up. */
export function reverseOrder(order: number[]): number[] {
  return order.slice().reverse()
}

/** Interleave two equal-length variable groups (e.g. a's and b's): a0 b0 a1 b1 … */
export function interleave(groupA: number[], groupB: number[]): number[] {
  const out: number[] = []
  const m = Math.max(groupA.length, groupB.length)
  for (let i = 0; i < m; i++) {
    if (i < groupA.length) out.push(groupA[i])
    if (i < groupB.length) out.push(groupB[i])
  }
  return out
}

/** A seeded random permutation, so "shuffle the order" is reproducible. */
export function randomOrder(n: number, seed: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i)
  let s = seed >>> 0 || 1
  const rng = () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4294967296
  }
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const t = a[i]
    a[i] = a[j]
    a[j] = t
  }
  return a
}

// Re-export terminals so consumers of this module need only one import site.
export { BDD_FALSE, BDD_TRUE }
