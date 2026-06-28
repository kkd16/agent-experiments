import type { Point, Rect } from './types'

// A point-region quadtree: the other classic spatial hierarchy. Where the k-d
// tree splits at the data (the median point), the quadtree splits at *space* —
// every node is a square that, once it holds more than `capacity` points, divides
// into four equal quadrants. The result is a recursive grid that is fine where
// points cluster and coarse where they are sparse. Range queries prune any
// quadrant that misses the window, exactly like the k-d tree prunes on its slab.
//
// Children are ordered [NW, NE, SW, SE] by the (x ≥ mid, y ≥ mid) quadrant index
// `(x≥midX) + 2·(y≥midY)`, so a point's quadrant is one cheap comparison pair.

export interface QuadNode {
  bounds: Rect
  depth: number
  points: number[] // indices held here (non-empty only at leaves)
  children: QuadNode[] | null // [Q0, Q1, Q2, Q3] or null at a leaf
}

export interface QuadOptions {
  capacity: number // points a leaf holds before it subdivides
  maxDepth: number // hard recursion cap (coincident points can't split forever)
}

const DEFAULTS: QuadOptions = { capacity: 1, maxDepth: 12 }

function leaf(bounds: Rect, depth: number): QuadNode {
  return { bounds, depth, points: [], children: null }
}

function quadrantIndex(node: QuadNode, p: Point): number {
  const mx = (node.bounds.minX + node.bounds.maxX) / 2
  const my = (node.bounds.minY + node.bounds.maxY) / 2
  return (p.x >= mx ? 1 : 0) + (p.y >= my ? 2 : 0)
}

function subdivide(node: QuadNode): void {
  const { minX, minY, maxX, maxY } = node.bounds
  const mx = (minX + maxX) / 2
  const my = (minY + maxY) / 2
  const d = node.depth + 1
  node.children = [
    leaf({ minX, minY, maxX: mx, maxY: my }, d),
    leaf({ minX: mx, minY, maxX, maxY: my }, d),
    leaf({ minX, minY: my, maxX: mx, maxY }, d),
    leaf({ minX: mx, minY: my, maxX, maxY }, d),
  ]
}

function insert(node: QuadNode, i: number, points: Point[], opts: QuadOptions): void {
  if (node.children) {
    insert(node.children[quadrantIndex(node, points[i])], i, points, opts)
    return
  }
  node.points.push(i)
  if (node.points.length > opts.capacity && node.depth < opts.maxDepth) {
    const held = node.points
    node.points = []
    subdivide(node)
    for (const j of held) {
      insert(node.children![quadrantIndex(node, points[j])], j, points, opts)
    }
  }
}

/** Build a point-region quadtree over `points` within `frame`. */
export function buildQuadtree(points: Point[], frame: Rect, opts: Partial<QuadOptions> = {}): QuadNode {
  const o = { ...DEFAULTS, ...opts }
  const root = leaf(frame, 0)
  for (let i = 0; i < points.length; i++) insert(root, i, points, o)
  return root
}

export interface QuadCell {
  bounds: Rect
  depth: number
  count: number // points held in this leaf
}

/** Every leaf cell — together they tile the frame, giving the quadtree grid. */
export function quadLeaves(root: QuadNode): QuadCell[] {
  const out: QuadCell[] = []
  const walk = (node: QuadNode) => {
    if (node.children) node.children.forEach(walk)
    else out.push({ bounds: node.bounds, depth: node.depth, count: node.points.length })
  }
  walk(root)
  return out
}

export interface QuadStats {
  nodes: number
  leaves: number
  maxDepth: number
  maxBucket: number // fullest leaf (1 unless points coincide / hit the depth cap)
}

export function quadStats(root: QuadNode): QuadStats {
  let nodes = 0
  let leaves = 0
  let maxDepth = 0
  let maxBucket = 0
  const walk = (node: QuadNode) => {
    nodes++
    maxDepth = Math.max(maxDepth, node.depth)
    if (node.children) node.children.forEach(walk)
    else {
      leaves++
      maxBucket = Math.max(maxBucket, node.points.length)
    }
  }
  walk(root)
  return { nodes, leaves, maxDepth, maxBucket }
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
}
function inRect(p: Point, r: Rect): boolean {
  return p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY
}

export interface QuadRangeResult {
  indices: number[]
  visited: number // nodes touched
}

/** Orthogonal range query: report points inside `window`, skipping quadrants the
 *  window does not reach. */
export function quadRange(root: QuadNode, points: Point[], window: Rect): QuadRangeResult {
  const indices: number[] = []
  let visited = 0
  const walk = (node: QuadNode) => {
    if (!rectsIntersect(node.bounds, window)) return
    visited++
    if (node.children) {
      node.children.forEach(walk)
    } else {
      for (const i of node.points) if (inRect(points[i], window)) indices.push(i)
    }
  }
  walk(root)
  return { indices, visited }
}

// ── Build step-trace for the Algorithms visualizer ───────────────────────────

export interface QuadBuildStep {
  cells: QuadCell[] // the grid after this insertion
  inserted: number // the point index just placed
  subdivided: Rect | null // the cell that split open at this step (if any)
  note: string
}

export function quadBuildSteps(points: Point[], frame: Rect, opts: Partial<QuadOptions> = {}): QuadBuildStep[] {
  const o = { ...DEFAULTS, ...opts }
  const root = leaf(frame, 0)
  const steps: QuadBuildStep[] = []
  for (let i = 0; i < points.length; i++) {
    const before = quadStats(root).leaves
    // Track which leaf the point lands in so we can report a split if it happens.
    let landed: Rect | null = null
    const find = (node: QuadNode): void => {
      if (node.children) find(node.children[quadrantIndex(node, points[i])])
      else landed = node.bounds
    }
    find(root)
    insert(root, i, points, o)
    const after = quadStats(root).leaves
    steps.push({
      cells: quadLeaves(root),
      inserted: i,
      subdivided: after > before ? landed : null,
      note:
        after > before
          ? `Insert point ${i}: its cell was full, so it subdivides into four quadrants.`
          : `Insert point ${i} into its (empty) cell.`,
    })
  }
  if (steps.length === 0) {
    steps.push({ cells: quadLeaves(root), inserted: -1, subdivided: null, note: 'Add points to build a quadtree.' })
  }
  return steps
}
