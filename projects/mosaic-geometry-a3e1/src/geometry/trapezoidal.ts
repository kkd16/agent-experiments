import type { Point, Rect, Triangle } from './types'
import { orient } from './predicates'
import { bounds } from './vector'

// ─────────────────────────────────────────────────────────────────────────────
// Trapezoidal map + a search DAG — Seidel's randomized incremental point
// location. This is the crown jewel of randomized geometry: given n
// non-crossing segments it builds, in O(n log n) expected time, a *trapezoidal
// decomposition* of the plane (every face refined into vertical-sided
// trapezoids) together with a directed acyclic **search structure** that answers
// "which face contains q?" in O(log n) expected time — an exponential win over
// the O(n) brute-force scan and an asymptotic win over the Θ(√n) jump-and-walk.
//
// Two kinds of internal decision live in the DAG:
//   • an **x-node** holds an endpoint and tests the query's x (a vertical line),
//   • a **y-node** holds a segment and tests whether the query is above/below it,
// and every **leaf** names a trapezoid. Inserting a segment walks the trapezoids
// it crosses, splits/merges them, and grafts a tiny subtree in place of each
// crossed leaf — so old leaves become internal nodes and the structure a DAG.
//
// Robustness. Rather than thread the four neighbour pointers each trapezoid
// carries (the classic source of bugs), the segment walk re-queries the DAG for
// the trapezoid just past each vertical wall — O(k log n) for a k-trapezoid
// crossing, negligible here and far harder to get subtly wrong. Ties in x are
// broken lexicographically (the standard symbolic-shear order, so equal-x
// endpoints — e.g. a grid — are still totally ordered); ties on a segment happen
// only at a shared endpoint and are resolved by the inserted segment's own
// direction. "Above" always means orient(p, q, r) > 0, used identically by the
// y-node router and the face labelling, so the two never disagree.

/** A segment, left endpoint `p` lexicographically before right endpoint `q`. */
export interface Seg {
  p: Point
  q: Point
}

type NodeKind = 'x' | 'y' | 'leaf'

interface DagNode {
  kind: NodeKind
  // x-node: split by endpoint `pt` (query with x < pt → left, else right).
  pt?: Point
  left?: number
  right?: number
  // y-node: split by segment `seg` (above → aboveChild, below → belowChild).
  seg?: number
  above?: number
  below?: number
  // leaf: names a trapezoid.
  trap?: number
}

interface Trap {
  leftp: Point
  rightp: Point
  top: number // bounding segment on the orient>0 ("above") side, or -1 = box
  bottom: number // bounding segment on the orient<0 ("below") side, or -1 = box
  leaf: number // the DAG leaf that currently names this trapezoid
  alive: boolean
}

const EPS = 1e-12

/** Lexicographic (symbolic-shear) order: a strictly before b. */
function ptLess(a: Point, b: Point): boolean {
  if (a.x !== b.x) return a.x < b.x
  return a.y < b.y
}
function ptEq(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y
}

/** Is `r` on the "above" (orient > 0) side of the directed line p→q? */
function aboveLine(s: Seg, r: Point): number {
  return orient(s.p, s.q, r)
}

/** One decision made while descending the search DAG, as a drawable primitive. */
export type PathStep =
  | { kind: 'x'; x: number; goRight: boolean } // tested the query's x against a vertical wall
  | { kind: 'y'; a: Point; b: Point; goAbove: boolean } // tested above/below a segment
  | { kind: 'leaf' }

export interface TrapMap {
  /** Locate the trapezoid + face containing `q`, recording the DAG path. */
  locate(q: Point): { trap: number; face: number; path: number[]; comparisons: number }
  /** The sequence of x-wall / y-segment tests the DAG makes for `q` — the
   *  root→leaf decision path, ready to draw. */
  explain(q: Point): { trap: number; face: number; steps: PathStep[] }
  /** Every (alive) trapezoid as a render-ready polygon + the face it maps to. */
  trapezoids(): { trap: number; polygon: Point[]; face: number; top: number; bottom: number }[]
  /** The list of segments the map was built over. */
  segments: Seg[]
  /** Deepest root→leaf path in the DAG (worst-case query length). */
  depth: number
  /** Node / trapezoid counts (size of the structure). */
  nodeCount: number
  trapCount: number
  /** Sum of leaf depths / number of leaves — the *balance* of the DAG. */
  meanLeafDepth: number
  bbox: Rect
}

/**
 * Build a trapezoidal map + search DAG over `segments` (assumed non-crossing,
 * meeting only at shared endpoints), inserted in a seeded random order.
 *
 * `faceAbove[i]` / `faceBelow[i]` (if given) label segment i with the id of the
 * region immediately on its orient>0 / orient<0 side; a located trapezoid then
 * resolves to a face via its bounding segments. With no labels the map is a pure
 * decomposition and `face` is always -1.
 */
export function buildTrapezoidalMap(
  segments: Seg[],
  opts: {
    points?: Point[]
    faceAbove?: number[]
    faceBelow?: number[]
    seed?: number
  } = {},
): TrapMap {
  // Bounding box with a margin, from the segment endpoints (+ any extra points).
  const pts: Point[] = []
  for (const s of segments) {
    pts.push(s.p, s.q)
  }
  if (opts.points) pts.push(...opts.points)
  const b = pts.length ? bounds(pts) : { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  const w = Math.max(b.maxX - b.minX, 1e-6)
  const h = Math.max(b.maxY - b.minY, 1e-6)
  const bbox: Rect = {
    minX: b.minX - w * 0.05,
    minY: b.minY - h * 0.05,
    maxX: b.maxX + w * 0.05,
    maxY: b.maxY + h * 0.05,
  }

  const nodes: DagNode[] = []
  const traps: Trap[] = []
  const faceAbove = opts.faceAbove
  const faceBelow = opts.faceBelow

  const newNode = (n: DagNode): number => {
    nodes.push(n)
    return nodes.length - 1
  }
  const newTrap = (leftp: Point, rightp: Point, top: number, bottom: number): number => {
    const idx = traps.length
    const leaf = newNode({ kind: 'leaf', trap: idx })
    traps.push({ leftp, rightp, top, bottom, leaf, alive: true })
    return idx
  }

  // Initial map: one trapezoid = the whole bounding box.
  const boxLeft: Point = { x: bbox.minX, y: (bbox.minY + bbox.maxY) / 2 }
  const boxRight: Point = { x: bbox.maxX, y: (bbox.minY + bbox.maxY) / 2 }
  newTrap(boxLeft, boxRight, -1, -1)

  // Smallest gap between distinct endpoint x-coordinates. The segment walk steps
  // a fraction of this past each vertical wall so its probe lands *strictly*
  // inside the next trapezoid instead of on the wall (where the x-tie is
  // ambiguous). Endpoints of the mesh have distinct x for jittered/random inputs.
  let minGap = Infinity
  {
    const xs = Array.from(new Set(pts.map((p) => p.x))).sort((a, z) => a - z)
    for (let i = 1; i < xs.length; i++) minGap = Math.min(minGap, xs[i] - xs[i - 1])
    if (!isFinite(minGap) || minGap <= 0) minGap = Math.max(w, 1e-6) * 1e-6
  }
  const nudge = minGap * 0.25

  // Descend the DAG to the trapezoid containing `point`. `dir` (a segment being
  // inserted) disambiguates when `point` lands exactly on an x-endpoint or on a
  // segment: we then step toward where `dir` goes (its right endpoint's side).
  function descend(point: Point, dir: Seg | null): { trap: number; path: number[]; comparisons: number } {
    let n = 0
    const path: number[] = [0]
    let comparisons = 0
    for (let guard = 0; guard < nodes.length + 4; guard++) {
      const node = nodes[n]
      if (node.kind === 'leaf') return { trap: node.trap!, path, comparisons }
      comparisons++
      if (node.kind === 'x') {
        const pt = node.pt!
        // Left iff point strictly before pt; a query *equal* to pt (a shared
        // endpoint being reinserted) belongs to the right region where dir lives.
        n = ptLess(point, pt) ? node.left! : node.right!
      } else {
        const s = segments[node.seg!]
        let o = aboveLine(s, point)
        if (Math.abs(o) <= EPS) {
          // `point` is on segment s — only happens at a shared endpoint. Break
          // the tie by the inserted segment's other end (its direction).
          if (dir) o = aboveLine(s, ptEq(point, dir.p) ? dir.q : dir.p)
          if (Math.abs(o) <= EPS) o = -1 // fully degenerate: pick a side deterministically
        }
        n = o > 0 ? node.above! : node.below!
      }
      path.push(n)
    }
    // Unreachable in a consistent DAG; return the last leaf-ish node's trap.
    return { trap: traps.length - 1, path, comparisons }
  }

  // The point on segment s at abscissa x (used to re-query the next trapezoid).
  const onSegAtX = (s: Seg, x: number): Point => {
    const dx = s.q.x - s.p.x
    const t = Math.abs(dx) < EPS ? 0 : (x - s.p.x) / dx
    return { x, y: s.p.y + (s.q.y - s.p.y) * t }
  }

  // The trapezoids segment `s` crosses, left to right, found by re-querying the
  // DAG just past each right wall (no neighbour pointers needed).
  function followSegment(s: Seg): number[] {
    const first = descend(s.p, s).trap
    const crossed = [first]
    let cur = first
    let guard = 0
    while (ptLess(traps[cur].rightp, s.q) && guard++ < traps.length + 4) {
      const wallX = traps[cur].rightp.x
      // A point on s strictly *past* the wall lands in the next trapezoid: step a
      // safe fraction of the min endpoint gap to clear the wall's x-node without
      // reaching the next wall (or s's own right end). y-nodes then route to the
      // side of s, reproducing the upper/lower-right neighbour choice.
      const probeX = wallX + Math.min(nudge, (s.q.x - wallX) * 0.5)
      const probe = onSegAtX(s, probeX)
      const nxt = descend(probe, s).trap
      if (nxt === cur) break // safety: no progress
      crossed.push(nxt)
      cur = nxt
    }
    return crossed
  }

  function insert(si: number) {
    const s = segments[si]
    const crossed = followSegment(s)

    if (crossed.length === 1) {
      insertSingle(si, crossed[0])
    } else {
      insertMultiple(si, crossed)
    }
  }

  // s lies entirely within one trapezoid `d`: up to four pieces (left, right,
  // above, below), grafted as x(p) → x(q) → y(s).
  function insertSingle(si: number, d: number) {
    const s = segments[si]
    const old = { ...traps[d] }
    traps[d].alive = false

    const hasLeft = ptLess(old.leftp, s.p)
    const hasRight = ptLess(s.q, old.rightp)

    const above = newTrap(s.p, s.q, old.top, si)
    const below = newTrap(s.p, s.q, si, old.bottom)
    const yNode = newNode({ kind: 'y', seg: si, above: traps[above].leaf, below: traps[below].leaf })

    let rightRoot = yNode
    if (hasRight) {
      const R = newTrap(s.q, old.rightp, old.top, old.bottom)
      rightRoot = newNode({ kind: 'x', pt: s.q, left: yNode, right: traps[R].leaf })
    }

    // Reuse the old leaf's slot as the new subtree root, so parents follow.
    if (hasLeft) {
      const L = newTrap(old.leftp, s.p, old.top, old.bottom)
      nodes[old.leaf] = { kind: 'x', pt: s.p, left: traps[L].leaf, right: rightRoot }
    } else {
      nodes[old.leaf] = { ...nodes[rightRoot] }
    }
  }

  // s crosses ≥2 trapezoids: split each into an above- and below-piece, merging
  // consecutive pieces that stay on the same side of the walls, then cap the
  // first/last with left/right remnants.
  function insertMultiple(si: number, crossed: number[]) {
    const s = segments[si]
    const k = crossed.length - 1
    const old = crossed.map((d) => ({ ...traps[d] }))
    for (const d of crossed) traps[d].alive = false

    const aboveTrap: number[] = new Array(k + 1)
    const belowTrap: number[] = new Array(k + 1)
    let curAbove = -1
    let curBelow = -1

    for (let i = 0; i <= k; i++) {
      const leftX = i === 0 ? s.p : old[i].leftp
      const rightX = i === k ? s.q : old[i].rightp
      // Did we cross from i-1 to i under s (rightp of i-1 above s) or over it?
      const sepAbove = i > 0 && aboveLine(s, old[i - 1].rightp) > 0

      // Above-piece: continues (merge) when the shared wall's vertex is *below* s.
      if (i > 0 && !sepAbove && curAbove >= 0 && traps[curAbove].top === old[i].top) {
        traps[curAbove].rightp = rightX
        aboveTrap[i] = curAbove
      } else {
        curAbove = newTrap(leftX, rightX, old[i].top, si)
        aboveTrap[i] = curAbove
      }
      // Below-piece: continues when the shared wall's vertex is *above* s.
      if (i > 0 && sepAbove && curBelow >= 0 && traps[curBelow].bottom === old[i].bottom) {
        traps[curBelow].rightp = rightX
        belowTrap[i] = curBelow
      } else {
        curBelow = newTrap(leftX, rightX, si, old[i].bottom)
        belowTrap[i] = curBelow
      }
    }

    for (let i = 0; i <= k; i++) {
      const yNode = newNode({
        kind: 'y',
        seg: si,
        above: traps[aboveTrap[i]].leaf,
        below: traps[belowTrap[i]].leaf,
      })
      let root = yNode
      if (i === 0 && ptLess(old[0].leftp, s.p)) {
        const L = newTrap(old[0].leftp, s.p, old[0].top, old[0].bottom)
        root = newNode({ kind: 'x', pt: s.p, left: traps[L].leaf, right: yNode })
      } else if (i === k && ptLess(s.q, old[k].rightp)) {
        const R = newTrap(s.q, old[k].rightp, old[k].top, old[k].bottom)
        root = newNode({ kind: 'x', pt: s.q, left: yNode, right: traps[R].leaf })
      }
      nodes[old[i].leaf] = { ...nodes[root] }
    }
  }

  // ── Insert every segment in a seeded random order ──────────────────────────
  const order = segments.map((_, i) => i)
  let seed = (opts.seed ?? 0x9e3779b9) >>> 0
  const rand = () => {
    // mulberry32
    seed = (seed + 0x6d2b79f5) >>> 0
    let t = seed
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  for (const si of order) insert(si)

  // ── Face resolution ────────────────────────────────────────────────────────
  const faceOf = (trap: number): number => {
    const t = traps[trap]
    if (t.bottom < 0 || t.top < 0) return -1 // touches the box → outside every face
    if (!faceAbove || !faceBelow) return -1
    const fa = faceAbove[t.bottom] // region just above the bottom segment
    const fb = faceBelow[t.top] // region just below the top segment
    if (fa >= 0 && fa === fb) return fa
    return -1
  }

  // ── DAG metrics (depth + mean leaf depth), computed once ───────────────────
  let depth = 0
  let leafDepthSum = 0
  let leafCount = 0
  {
    const stack: { n: number; d: number }[] = [{ n: 0, d: 0 }]
    const seen = new Map<number, number>() // memoize shared subtrees
    while (stack.length) {
      const { n, d } = stack.pop()!
      const prev = seen.get(n)
      if (prev !== undefined && prev >= d) continue
      seen.set(n, d)
      const node = nodes[n]
      if (node.kind === 'leaf') {
        depth = Math.max(depth, d)
        leafDepthSum += d
        leafCount++
        continue
      }
      if (node.kind === 'x') {
        stack.push({ n: node.left!, d: d + 1 }, { n: node.right!, d: d + 1 })
      } else {
        stack.push({ n: node.above!, d: d + 1 }, { n: node.below!, d: d + 1 })
      }
    }
  }

  const segY = (seg: number, x: number, aboveSide: boolean): number => {
    if (seg < 0) return aboveSide ? bbox.maxY : bbox.minY
    return onSegAtX(segments[seg], x).y
  }

  return {
    locate(q: Point) {
      const { trap, path, comparisons } = descend(q, null)
      return { trap, face: faceOf(trap), path, comparisons }
    },
    explain(q: Point) {
      const steps: PathStep[] = []
      let n = 0
      for (let guard = 0; guard < nodes.length + 4; guard++) {
        const node = nodes[n]
        if (node.kind === 'leaf') {
          steps.push({ kind: 'leaf' })
          return { trap: node.trap!, face: faceOf(node.trap!), steps }
        }
        if (node.kind === 'x') {
          const goRight = !ptLess(q, node.pt!)
          steps.push({ kind: 'x', x: node.pt!.x, goRight })
          n = goRight ? node.right! : node.left!
        } else {
          const s = segments[node.seg!]
          const goAbove = aboveLine(s, q) > 0
          steps.push({ kind: 'y', a: s.p, b: s.q, goAbove })
          n = goAbove ? node.above! : node.below!
        }
      }
      return { trap: -1, face: -1, steps }
    },
    trapezoids() {
      const out: { trap: number; polygon: Point[]; face: number; top: number; bottom: number }[] = []
      for (let i = 0; i < traps.length; i++) {
        const t = traps[i]
        if (!t.alive) continue
        const xL = t.leftp.x
        const xR = t.rightp.x
        if (xR - xL < EPS) continue
        // "top" = orient>0 side = larger y (lower on a y-down canvas), "bottom"
        // = orient<0 side; the polygon is the quad between the two boundaries.
        const yTopL = segY(t.top, xL, true)
        const yTopR = segY(t.top, xR, true)
        const yBotL = segY(t.bottom, xL, false)
        const yBotR = segY(t.bottom, xR, false)
        out.push({
          trap: i,
          polygon: [
            { x: xL, y: yBotL },
            { x: xR, y: yBotR },
            { x: xR, y: yTopR },
            { x: xL, y: yTopL },
          ],
          face: faceOf(i),
          top: t.top,
          bottom: t.bottom,
        })
      }
      return out
    },
    segments,
    depth,
    nodeCount: nodes.length,
    trapCount: traps.filter((t) => t.alive).length,
    meanLeafDepth: leafCount ? leafDepthSum / leafCount : 0,
    bbox,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Triangulation adapter — build the map over a Delaunay mesh's edges so a point
// query resolves to a *triangle*, cross-checkable against the brute-force scan.

const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`)

export interface TriTrapMap extends TrapMap {
  /** Locate the triangle index containing `q`, or -1 if outside the hull. */
  locateTriangle(q: Point): { triangle: number; path: number[]; comparisons: number }
}

/**
 * Build a trapezoidal map over the edges of a triangulation. Each undirected
 * edge becomes a segment labelled with the triangle on each side, so a located
 * trapezoid names the containing triangle directly.
 */
export function trapezoidalFromTriangulation(
  points: Point[],
  tris: Triangle[],
  seed = 1,
): TriTrapMap {
  const segs: Seg[] = []
  const faceAbove: number[] = []
  const faceBelow: number[] = []
  const segIndex = new Map<string, number>()

  const ensureSeg = (u: number, v: number): number => {
    const key = edgeKey(u, v)
    let idx = segIndex.get(key)
    if (idx === undefined) {
      let a = points[u]
      let b = points[v]
      if (ptLess(b, a)) [a, b] = [b, a] // canonical left→right endpoints
      idx = segs.length
      segs.push({ p: a, q: b })
      faceAbove.push(-1)
      faceBelow.push(-1)
      segIndex.set(key, idx)
    }
    return idx
  }

  tris.forEach((tri, t) => {
    const verts = [tri.a, tri.b, tri.c]
    for (let e = 0; e < 3; e++) {
      const u = verts[e]
      const v = verts[(e + 1) % 3]
      const w = verts[(e + 2) % 3] // the third vertex, marks which side is inside
      const si = ensureSeg(u, v)
      const s = segs[si]
      if (aboveLine(s, points[w]) > 0) faceAbove[si] = t
      else faceBelow[si] = t
    }
  })

  const map = buildTrapezoidalMap(segs, { points, faceAbove, faceBelow, seed })
  return {
    ...map,
    locateTriangle(q: Point) {
      const r = map.locate(q)
      return { triangle: r.face, path: r.path, comparisons: r.comparisons }
    },
  }
}
