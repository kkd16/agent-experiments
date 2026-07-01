import type { Edge, Point, Rect } from './types'
import { dist } from './vector'

// The **Well-Separated Pair Decomposition** (Callahan & Kosaraju, 1995): a set of
// O(s²·n) pairs of point clusters (A_i, B_i) such that *every* one of the n(n−1)/2
// point pairs is "represented" by exactly one cluster pair, and each cluster pair
// is **s-well-separated** — the two clusters are far apart relative to their size.
//
// It is the Swiss-army knife of proximity problems: from one WSPD you read off a
// linear-size t-spanner, an approximate nearest-neighbour / closest-pair, k-nearest
// neighbours, the Euclidean minimum spanning tree, and n-body approximations — all
// by iterating over the O(n) pairs instead of the Θ(n²) point pairs.
//
// Built here from scratch on a **fair-split tree**: a binary hierarchy that, at
// each node, cuts the bounding box across its *longest* side at the midpoint, so
// boxes stay well-proportioned (unlike an arbitrary k-d split). Two distinct leaf
// boxes are then always well-separated, which is what makes the recursion halt.
//
// Well-separation test (ball model): enclose each cluster's bounding box in a ball
// of radius = half its diagonal. Clusters are s-well-separated when the gap between
// the two balls is at least s times the larger radius:
//     dist(centers) − r_A − r_B  ≥  s · max(r_A, r_B).

export interface SplitNode {
  box: Rect // tight bounding box of this node's points
  points: number[] // original indices in this node (leaf: exactly one)
  rep: number // a representative point index (used by the spanner)
  left: SplitNode | null
  right: SplitNode | null
}

function boxOf(points: Point[], idx: number[]): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const i of idx) {
    const p = points[i]
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

const boxCenter = (b: Rect): Point => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 })
/** Enclosing-ball radius = half the box diagonal. */
const boxRadius = (b: Rect): number => 0.5 * Math.hypot(b.maxX - b.minX, b.maxY - b.minY)
const boxLongest = (b: Rect): number => Math.max(b.maxX - b.minX, b.maxY - b.minY)

/** Build the fair-split tree: recursively cut the longest side at its midpoint. */
export function buildSplitTree(points: Point[], indices?: number[]): SplitNode | null {
  const idx = indices ?? points.map((_, i) => i)
  if (idx.length === 0) return null
  const box = boxOf(points, idx)
  if (idx.length === 1) {
    return { box, points: idx, rep: idx[0], left: null, right: null }
  }
  // Split across the longer side at its midpoint (the "fair" split).
  const spanX = box.maxX - box.minX
  const spanY = box.maxY - box.minY
  const axisX = spanX >= spanY
  const mid = axisX ? (box.minX + box.maxX) / 2 : (box.minY + box.maxY) / 2
  let leftIdx = idx.filter((i) => (axisX ? points[i].x : points[i].y) <= mid)
  let rightIdx = idx.filter((i) => (axisX ? points[i].x : points[i].y) > mid)
  // Degenerate guard: many coincident coordinates can leave one side empty even
  // though span > 0 only from ties; fall back to a median split so we always make
  // progress (the recursion must strictly shrink each side).
  if (leftIdx.length === 0 || rightIdx.length === 0) {
    const sorted = [...idx].sort((a, b) =>
      axisX ? points[a].x - points[b].x || a - b : points[a].y - points[b].y || a - b,
    )
    const half = sorted.length >> 1
    leftIdx = sorted.slice(0, half)
    rightIdx = sorted.slice(half)
  }
  const left = buildSplitTree(points, leftIdx)
  const right = buildSplitTree(points, rightIdx)
  return { box, points: idx, rep: idx[0], left, right }
}

export interface WsPair {
  a: SplitNode
  b: SplitNode
}

/** True when nodes u and v are s-well-separated under the enclosing-ball model. */
export function wellSeparated(u: SplitNode, v: SplitNode, s: number): boolean {
  const cu = boxCenter(u.box)
  const cv = boxCenter(v.box)
  const ru = boxRadius(u.box)
  const rv = boxRadius(v.box)
  const gap = dist(cu, cv) - ru - rv
  return gap >= s * Math.max(ru, rv)
}

/** The WSPD: all s-well-separated cluster pairs covering every point pair once. */
export function wspd(points: Point[], s: number): WsPair[] {
  const root = buildSplitTree(points)
  const pairs: WsPair[] = []
  if (!root) return pairs

  const wsPairs = (a: SplitNode, b: SplitNode) => {
    if (wellSeparated(a, b, s)) {
      pairs.push({ a, b })
      return
    }
    // Split the node with the longer bounding-box side (guarantees termination:
    // the split side strictly shrinks and leaves are always well-separated).
    let u = a
    let v = b
    if (boxLongest(u.box) < boxLongest(v.box)) {
      u = b
      v = a
    }
    // u is the larger; recurse it against both halves of… wait: split u.
    if (u.left && u.right) {
      wsPairs(u.left, v)
      wsPairs(u.right, v)
    } else {
      // u is a leaf but not well-separated from v ⇒ v must be splittable.
      if (v.left && v.right) {
        wsPairs(u, v.left)
        wsPairs(u, v.right)
      }
      // else both leaves: distinct singletons are always well-separated, so this
      // branch is unreachable for distinct points; guard against exact duplicates.
    }
  }

  const rec = (node: SplitNode) => {
    if (!node.left || !node.right) return
    wsPairs(node.left, node.right)
    rec(node.left)
    rec(node.right)
  }
  rec(root)
  return pairs
}

/** Total point pairs covered: Σ |A_i|·|B_i|. A correct WSPD covers every one of
 *  the n(n−1)/2 unordered pairs exactly once, so this must equal n(n−1)/2. */
export function coveredPairCount(pairs: WsPair[]): number {
  let total = 0
  for (const { a, b } of pairs) total += a.points.length * b.points.length
  return total
}

// ── The WSPD-spanner ─────────────────────────────────────────────────────────

/** Linear-size **t-spanner** from the WSPD: one edge between the representatives
 *  of each well-separated pair. With separation s > 4 and t = (s + 4)/(s − 4),
 *  the graph is a t-spanner using only O(s²·n) = O(n) edges. */
export function wspdSpanner(points: Point[], s: number): Edge[] {
  const pairs = wspd(points, s)
  const seen = new Set<string>()
  const edges: Edge[] = []
  for (const { a, b } of pairs) {
    const u = a.rep
    const v = b.rep
    if (u === v) continue
    const lo = Math.min(u, v)
    const hi = Math.max(u, v)
    const key = `${lo}_${hi}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ a: lo, b: hi })
  }
  return edges
}

/** Theoretical stretch guarantee of the WSPD-spanner (∞ when s ≤ 4). */
export function wspdSpannerBound(s: number): number {
  return s > 4 ? (s + 4) / (s - 4) : Infinity
}

/** Leaves of the split tree, as boxes — for drawing the hierarchy. */
export function splitTreeLeaves(root: SplitNode | null): Rect[] {
  const out: Rect[] = []
  const walk = (n: SplitNode | null) => {
    if (!n) return
    if (!n.left && !n.right) out.push(n.box)
    walk(n.left)
    walk(n.right)
  }
  walk(root)
  return out
}
