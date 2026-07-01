import type { Point, Rect } from './types'

// A 2-D **range tree with fractional cascading** — the classic data structure for
// orthogonal range *reporting* in O(log n + k) time (k = points reported), which
// beats a k-d tree's Θ(√n + k) worst case for this specific query.
//
// The layout:
//   • Primary tree: a balanced BST on the x-sorted points. A subtree covers a
//     contiguous x-interval; a query rectangle decomposes into O(log n) *canonical*
//     subtrees whose x-interval lies wholly inside [xmin, xmax].
//   • Associated arrays: every node stores its subtree's points sorted by y. A
//     naive range tree binary-searches y at each canonical node → O(log² n).
//   • Fractional cascading removes the extra log: each entry of a node's y-array
//     carries a pointer to the first ≥-y entry of *each child's* array. Binary-search
//     y **once** at the root of the query path, then follow pointers downward for
//     free. Reporting a canonical node then costs O(1 + kᵥ), for O(log n + k) total.
//
// Everything is integer index arithmetic and comparisons — no floating-point
// fragility. A non-cascaded reference query (`rangeQueryNaive`) is kept so the
// cascaded path can be cross-checked against it (and both against brute force).

export interface RangeNode {
  lo: number // inclusive index into the x-sorted order this subtree covers …
  hi: number // … inclusive upper bound (so it owns x-sorted [lo, hi])
  xMin: number // actual x-extent of the covered points (for the window test)
  xMax: number
  left: RangeNode | null
  right: RangeNode | null
  // Associated structure: subtree points sorted by y.
  ys: number[] // y-coordinates, ascending
  idx: number[] // original point index parallel to ys
  // Fractional-cascading pointers (length ys.length + 1; the last is a sentinel):
  // lptr[i] = first position in left.ys whose y ≥ ys[i]; rptr[i] likewise for right.
  lptr: number[]
  rptr: number[]
}

export interface RangeTree {
  root: RangeNode | null
  points: Point[]
}

/** First index i in a sorted-ascending array with `arr[i] ≥ v` (else arr.length). */
function lowerBound(arr: number[], v: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] < v) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Build cascade pointers from a parent's y-array into one child's y-array. Both
 *  are sorted ascending, so a single monotone sweep suffices. Position `len`
 *  (the sentinel) always maps to the child's length. */
function buildPointers(parentYs: number[], childYs: number[]): number[] {
  const ptr = new Array<number>(parentYs.length + 1)
  let j = 0
  for (let i = 0; i < parentYs.length; i++) {
    while (j < childYs.length && childYs[j] < parentYs[i]) j++
    ptr[i] = j
  }
  ptr[parentYs.length] = childYs.length
  return ptr
}

/** Merge two ascending (ys, idx) arrays into one, preserving the y order. */
function mergeByY(
  aYs: number[],
  aIdx: number[],
  bYs: number[],
  bIdx: number[],
): { ys: number[]; idx: number[] } {
  const ys: number[] = []
  const idx: number[] = []
  let i = 0
  let j = 0
  while (i < aYs.length && j < bYs.length) {
    if (aYs[i] <= bYs[j]) {
      ys.push(aYs[i])
      idx.push(aIdx[i])
      i++
    } else {
      ys.push(bYs[j])
      idx.push(bIdx[j])
      j++
    }
  }
  while (i < aYs.length) {
    ys.push(aYs[i])
    idx.push(aIdx[i])
    i++
  }
  while (j < bYs.length) {
    ys.push(bYs[j])
    idx.push(bIdx[j])
    j++
  }
  return { ys, idx }
}

/** Build the range tree. Points are sorted by (x, then y, then index) so the
 *  x-decomposition is well-defined even with repeated x-coordinates. */
export function buildRangeTree(points: Point[]): RangeTree {
  if (points.length === 0) return { root: null, points }
  const orderX = points.map((_, i) => i)
  orderX.sort((a, b) => points[a].x - points[b].x || points[a].y - points[b].y || a - b)

  const build = (lo: number, hi: number): RangeNode => {
    if (lo === hi) {
      const pi = orderX[lo]
      const node: RangeNode = {
        lo,
        hi,
        xMin: points[pi].x,
        xMax: points[pi].x,
        left: null,
        right: null,
        ys: [points[pi].y],
        idx: [pi],
        lptr: [0, 0],
        rptr: [0, 0],
      }
      return node
    }
    const mid = (lo + hi) >> 1
    const left = build(lo, mid)
    const right = build(mid + 1, hi)
    const merged = mergeByY(left.ys, left.idx, right.ys, right.idx)
    return {
      lo,
      hi,
      xMin: left.xMin,
      xMax: right.xMax,
      left,
      right,
      ys: merged.ys,
      idx: merged.idx,
      lptr: buildPointers(merged.ys, left.ys),
      rptr: buildPointers(merged.ys, right.ys),
    }
  }
  return { root: build(0, orderX.length - 1), points }
}

export interface RangeQueryResult {
  indices: number[]
  canonical: number // canonical subtrees whose whole y-array was scanned
  visited: number // internal nodes touched on the search paths
}

/** Cascaded range query: O(log n + k). Binary-searches y **once** at the root,
 *  then follows fractional-cascading pointers as it descends. */
export function rangeQuery(tree: RangeTree, window: Rect): RangeQueryResult {
  const indices: number[] = []
  let canonical = 0
  let visited = 0
  const root = tree.root
  if (!root) return { indices, canonical, visited }

  // Report a canonical node from the already-maintained position `pos` (= first
  // entry with y ≥ ymin), walking up while y ≤ ymax.
  const report = (node: RangeNode, pos: number) => {
    canonical++
    for (let i = pos; i < node.ys.length && node.ys[i] <= window.maxY; i++) {
      indices.push(node.idx[i])
    }
  }

  const go = (node: RangeNode | null, pos: number) => {
    if (!node) return
    // Disjoint in x ⇒ nothing here.
    if (node.xMax < window.minX || node.xMin > window.maxX) return
    // Wholly inside the x-window ⇒ canonical: report via the maintained pos.
    if (node.xMin >= window.minX && node.xMax <= window.maxX) {
      report(node, pos)
      return
    }
    // Straddles the boundary: descend, threading pos through the cascade pointers.
    visited++
    go(node.left, node.lptr[pos])
    go(node.right, node.rptr[pos])
  }

  const startPos = lowerBound(root.ys, window.minY)
  go(root, startPos)
  return { indices, canonical, visited }
}

/** Reference query without cascading: binary-search y at every canonical node
 *  (O(log² n + k)). Used to validate the cascaded path in the self-tests. */
export function rangeQueryNaive(tree: RangeTree, window: Rect): number[] {
  const indices: number[] = []
  const root = tree.root
  if (!root) return indices
  const go = (node: RangeNode | null) => {
    if (!node) return
    if (node.xMax < window.minX || node.xMin > window.maxX) return
    if (node.xMin >= window.minX && node.xMax <= window.maxX) {
      const start = lowerBound(node.ys, window.minY)
      for (let i = start; i < node.ys.length && node.ys[i] <= window.maxY; i++) {
        indices.push(node.idx[i])
      }
      return
    }
    go(node.left)
    go(node.right)
  }
  go(root)
  return indices
}

export function rangeTreeSize(node: RangeNode | null): number {
  return node ? 1 + rangeTreeSize(node.left) + rangeTreeSize(node.right) : 0
}
export function rangeTreeDepth(node: RangeNode | null): number {
  return node ? 1 + Math.max(rangeTreeDepth(node.left), rangeTreeDepth(node.right)) : 0
}
