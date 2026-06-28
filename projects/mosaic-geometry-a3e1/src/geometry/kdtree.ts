import type { Point, Rect } from './types'
import { dist2 } from './vector'

// A 2-D k-d tree: the workhorse data structure for spatial search. We build a
// balanced tree by recursively splitting the point set at the median along an
// axis that alternates with depth (x at the root, then y, then x, …). Every node
// owns an axis-aligned *region* of the plane (computed top-down from the frame),
// which is what lets queries prune whole subtrees: if a subtree's region cannot
// possibly hold a closer point — or cannot intersect a query window — it is
// skipped entirely. Nearest-neighbour, k-nearest and orthogonal range search all
// fall out of the same skeleton, each pruning on the region in its own way.
//
// Everything is exact and dependency-free; the only arithmetic is comparison and
// squared distance, so there is no floating-point fragility here.

export interface KdNode {
  index: number // index (into the original point array) of the point stored here
  axis: 0 | 1 // split axis: 0 = x, 1 = y
  depth: number
  left: KdNode | null // subtree with coord[axis] ≤ split value
  right: KdNode | null // subtree with coord[axis] ≥ split value
  region: Rect // the slab of the plane this whole subtree covers
}

const coord = (p: Point, axis: 0 | 1): number => (axis === 0 ? p.x : p.y)

function withMax(r: Rect, axis: 0 | 1, v: number): Rect {
  return axis === 0 ? { ...r, maxX: v } : { ...r, maxY: v }
}
function withMin(r: Rect, axis: 0 | 1, v: number): Rect {
  return axis === 0 ? { ...r, minX: v } : { ...r, minY: v }
}

function inRect(p: Point, r: Rect): boolean {
  return p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY
}
function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
}
/** Squared distance from a point to the nearest point of an (axis-aligned) rect. */
function rectDist2(p: Point, r: Rect): number {
  const dx = p.x < r.minX ? r.minX - p.x : p.x > r.maxX ? p.x - r.maxX : 0
  const dy = p.y < r.minY ? r.minY - p.y : p.y > r.maxY ? p.y - r.maxY : 0
  return dx * dx + dy * dy
}

function build(points: Point[], idx: number[], depth: number, region: Rect): KdNode | null {
  if (idx.length === 0) return null
  const axis = (depth % 2) as 0 | 1
  // Median split keeps the tree balanced (depth ≈ ⌈log₂ n⌉).
  idx.sort((a, b) => coord(points[a], axis) - coord(points[b], axis))
  const mid = idx.length >> 1
  const nodeIdx = idx[mid]
  const v = coord(points[nodeIdx], axis)
  return {
    index: nodeIdx,
    axis,
    depth,
    region,
    left: build(points, idx.slice(0, mid), depth + 1, withMax(region, axis, v)),
    right: build(points, idx.slice(mid + 1), depth + 1, withMin(region, axis, v)),
  }
}

/** Build a balanced 2-D k-d tree over `points`, with each node's region clipped
 *  into `frame`. Returns null for an empty set. */
export function buildKdTree(points: Point[], frame: Rect): KdNode | null {
  return build(
    points,
    points.map((_, i) => i),
    0,
    frame,
  )
}

export function kdDepth(node: KdNode | null): number {
  return node ? 1 + Math.max(kdDepth(node.left), kdDepth(node.right)) : 0
}
export function kdSize(node: KdNode | null): number {
  return node ? 1 + kdSize(node.left) + kdSize(node.right) : 0
}

// ── Split segments for rendering the recursive partition ─────────────────────

export interface KdSplit {
  p0: Point
  p1: Point
  axis: 0 | 1
  depth: number
}

/** The partition: one segment per internal node, drawn at its split value across
 *  the perpendicular extent of its region. Leaves (which subdivide nothing) emit
 *  no line, so the picture shows exactly the cuts that separate points. */
export function kdSplits(tree: KdNode | null, points: Point[]): KdSplit[] {
  const out: KdSplit[] = []
  const walk = (node: KdNode | null) => {
    if (!node) return
    if (node.left || node.right) {
      const v = coord(points[node.index], node.axis)
      const r = node.region
      out.push(
        node.axis === 0
          ? { p0: { x: v, y: r.minY }, p1: { x: v, y: r.maxY }, axis: 0, depth: node.depth }
          : { p0: { x: r.minX, y: v }, p1: { x: r.maxX, y: v }, axis: 1, depth: node.depth },
      )
    }
    walk(node.left)
    walk(node.right)
  }
  walk(tree)
  return out
}

// ── Nearest-neighbour query (branch-and-bound with region pruning) ───────────

export interface NnResult {
  index: number
  dist: number
  visited: number // nodes touched — the win over the O(n) brute-force scan
}

export function kdNearest(tree: KdNode | null, points: Point[], q: Point): NnResult {
  let best = -1
  let bestD2 = Infinity
  let visited = 0
  const go = (node: KdNode | null) => {
    if (!node) return
    visited++
    const d2 = dist2(points[node.index], q)
    if (d2 < bestD2) {
      bestD2 = d2
      best = node.index
    }
    const diff = coord(q, node.axis) - coord(points[node.index], node.axis)
    const near = diff <= 0 ? node.left : node.right
    const far = diff <= 0 ? node.right : node.left
    go(near)
    // Only descend the far side if a closer point could possibly live there.
    if (diff * diff < bestD2) go(far)
  }
  go(tree)
  return { index: best, dist: Math.sqrt(bestD2), visited }
}

// ── k-nearest-neighbour query ────────────────────────────────────────────────

export interface KnnHit {
  index: number
  dist: number
}

export function kdKNearest(tree: KdNode | null, points: Point[], q: Point, k: number): KnnHit[] {
  // A short sorted list (ascending by distance) of the best k seen so far. k is
  // small in practice, so insertion-sort beats a heap on constant factors.
  const best: { index: number; d2: number }[] = []
  const worst = () => (best.length < k ? Infinity : best[best.length - 1].d2)
  const add = (index: number, d2: number) => {
    if (best.length >= k && d2 >= worst()) return
    let i = best.length - 1
    best.push({ index, d2 })
    while (i >= 0 && best[i].d2 > d2) {
      best[i + 1] = best[i]
      i--
    }
    best[i + 1] = { index, d2 }
    if (best.length > k) best.pop()
  }
  const go = (node: KdNode | null) => {
    if (!node) return
    add(node.index, dist2(points[node.index], q))
    const diff = coord(q, node.axis) - coord(points[node.index], node.axis)
    const near = diff <= 0 ? node.left : node.right
    const far = diff <= 0 ? node.right : node.left
    go(near)
    if (diff * diff < worst()) go(far)
  }
  go(tree)
  return best.map((b) => ({ index: b.index, dist: Math.sqrt(b.d2) }))
}

// ── Orthogonal range query ───────────────────────────────────────────────────

export interface RangeResult {
  indices: number[]
  visited: number
}

/** Report every point inside the axis-aligned `window`, pruning any subtree whose
 *  region misses the window entirely. */
export function kdRange(tree: KdNode | null, points: Point[], window: Rect): RangeResult {
  const indices: number[] = []
  let visited = 0
  const go = (node: KdNode | null) => {
    if (!node || !rectsIntersect(node.region, window)) return
    visited++
    if (inRect(points[node.index], window)) indices.push(node.index)
    go(node.left)
    go(node.right)
  }
  go(tree)
  return { indices, visited }
}

// ── Build step-trace (level-order) for the Algorithms visualizer ─────────────

export interface KdBuildStep {
  region: Rect // the region of the node placed at this step
  pivot: number // the median point chosen here
  axis: 0 | 1
  split: KdSplit | null // the cut introduced (null at a leaf)
  placed: KdSplit[] // every cut committed so far (cumulative)
  depth: number
  note: string
}

export function kdBuildSteps(tree: KdNode | null, points: Point[]): KdBuildStep[] {
  const steps: KdBuildStep[] = []
  const placed: KdSplit[] = []
  let level: (KdNode | null)[] = [tree]
  while (level.some(Boolean)) {
    const next: (KdNode | null)[] = []
    for (const node of level) {
      if (!node) continue
      const isInternal = !!(node.left || node.right)
      const v = coord(points[node.index], node.axis)
      const r = node.region
      const split: KdSplit | null = isInternal
        ? node.axis === 0
          ? { p0: { x: v, y: r.minY }, p1: { x: v, y: r.maxY }, axis: 0, depth: node.depth }
          : { p0: { x: r.minX, y: v }, p1: { x: r.maxX, y: v }, axis: 1, depth: node.depth }
        : null
      if (split) placed.push(split)
      steps.push({
        region: node.region,
        pivot: node.index,
        axis: node.axis,
        split,
        placed: [...placed],
        depth: node.depth,
        note: isInternal
          ? `Depth ${node.depth}: split on ${node.axis === 0 ? 'x' : 'y'} at the median point, dividing its region in two.`
          : `Depth ${node.depth}: a leaf — its region holds a single point, nothing left to split.`,
      })
      next.push(node.left, node.right)
    }
    level = next
  }
  if (steps.length === 0) {
    steps.push({
      region: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      pivot: -1,
      axis: 0,
      split: null,
      placed: [],
      depth: 0,
      note: 'Add points to build a k-d tree.',
    })
  }
  return steps
}

// ── Nearest-neighbour query step-trace for the visualizer ────────────────────

export interface KdQueryStep {
  current: number // node index visited at this step (-1 = decision/finish)
  region: Rect | null // region of the node visited
  best: number // current best point index
  bestDist: number
  pruned: Rect | null // a subtree region just skipped by the bound
  visited: number
  note: string
}

export function kdNearestSteps(tree: KdNode | null, points: Point[], q: Point): KdQueryStep[] {
  const steps: KdQueryStep[] = []
  let best = -1
  let bestD2 = Infinity
  let visited = 0
  const go = (node: KdNode | null) => {
    if (!node) return
    visited++
    const d2 = dist2(points[node.index], q)
    const improved = d2 < bestD2
    if (improved) {
      bestD2 = d2
      best = node.index
    }
    steps.push({
      current: node.index,
      region: node.region,
      best,
      bestDist: Math.sqrt(bestD2),
      pruned: null,
      visited,
      note: improved
        ? `Visit node ${node.index} — new closest so far (distance ${Math.sqrt(bestD2).toFixed(3)}).`
        : `Visit node ${node.index}; current best stays at ${Math.sqrt(bestD2).toFixed(3)}.`,
    })
    const diff = coord(q, node.axis) - coord(points[node.index], node.axis)
    const near = diff <= 0 ? node.left : node.right
    const far = diff <= 0 ? node.right : node.left
    go(near)
    if (far && diff * diff >= bestD2) {
      steps.push({
        current: -1,
        region: null,
        best,
        bestDist: Math.sqrt(bestD2),
        pruned: far.region,
        visited,
        note: `Prune the far subtree — its slab is ${Math.sqrt(diff * diff).toFixed(3)} away, beyond the best ${Math.sqrt(bestD2).toFixed(3)}.`,
      })
    } else {
      go(far)
    }
  }
  go(tree)
  steps.push({
    current: best,
    region: null,
    best,
    bestDist: Math.sqrt(bestD2),
    pruned: null,
    visited,
    note: `Done: nearest is point ${best} at distance ${Math.sqrt(bestD2).toFixed(3)} — only ${visited} of ${points.length} nodes touched.`,
  })
  return steps
}

export { rectDist2, inRect, rectsIntersect }
