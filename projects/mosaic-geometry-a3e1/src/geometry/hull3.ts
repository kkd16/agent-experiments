import type { Vec3 } from './vector3'
import { sub3, cross3, dot3, dist3sq, len3, bounds3, dist3 } from './vector3'
import { orient3d } from './predicates3'

// The 3-D convex hull — the incremental (beneath-beyond) algorithm, the space
// analogue of the plane's monotone-chain / Quickhull. Seed a non-degenerate
// tetrahedron, then fold in the remaining points one at a time: a new point sees a
// connected cap of "visible" faces (those it lies outside), we find the **horizon**
// (the loop of edges bounding that cap) and replace the cap with a fan of new faces
// coning the horizon to the point. Every face is re-oriented outward against a fixed
// interior point so the winding — and therefore the horizon's twin-edge test — is
// bullet-proof. Faces come out CCW when viewed from outside.

/** A hull face as three point indices, counter-clockwise seen from outside. */
export interface Face3 {
  a: number
  b: number
  c: number
}

export interface Hull3 {
  faces: Face3[]
  /** Unique undirected hull edges as sorted index pairs. */
  edges: [number, number][]
  /** Indices of the input points that lie on the hull. */
  vertices: number[]
  /** Insertion step at which each face was created (parallel to `faces`); for animation. */
  bornAt: number[]
  /** Total number of insertion steps (initial tetra = 0, then one per folded point). */
  steps: number
  /** Centroid of the hull vertices — a strictly interior point. */
  centroid: Vec3
  volume: number
  area: number
  /** True when the points were (near-)degenerate (collinear/coplanar) so no solid formed. */
  degenerate: boolean
}

interface WorkFace {
  a: number
  b: number
  c: number
  born: number
}

const key = (u: number, v: number) => u * 4294967296 + v

/** Farthest-point seed: index of the point maximising a scalar score. */
function argmax(n: number, score: (i: number) => number): number {
  let best = 0
  let bestv = -Infinity
  for (let i = 0; i < n; i++) {
    const s = score(i)
    if (s > bestv) {
      bestv = s
      best = i
    }
  }
  return best
}

/** Pick four affinely-independent seed indices, or null if the cloud is degenerate. */
function seedTetra(pts: Vec3[], eps: number): [number, number, number, number] | null {
  const n = pts.length
  // Two extremal points along x give a stable first edge.
  let i0 = 0
  let i1 = 0
  {
    let minx = Infinity
    let maxx = -Infinity
    for (let i = 0; i < n; i++) {
      if (pts[i].x < minx) { minx = pts[i].x; i0 = i }
      if (pts[i].x > maxx) { maxx = pts[i].x; i1 = i }
    }
    if (i0 === i1) i1 = argmax(n, (i) => dist3sq(pts[i], pts[i0]))
  }
  if (dist3sq(pts[i0], pts[i1]) < eps * eps) return null
  // Third: farthest from the line i0→i1.
  const d01 = sub3(pts[i1], pts[i0])
  const i2 = argmax(n, (i) => len3(cross3(d01, sub3(pts[i], pts[i0]))))
  if (len3(cross3(d01, sub3(pts[i2], pts[i0]))) < eps) return null
  // Fourth: farthest from the plane (i0,i1,i2).
  const i3 = argmax(n, (i) => Math.abs(orient3d(pts[i0], pts[i1], pts[i2], pts[i])))
  if (Math.abs(orient3d(pts[i0], pts[i1], pts[i2], pts[i3])) < eps) return null
  return [i0, i1, i2, i3]
}

export function convexHull3(points: Vec3[]): Hull3 {
  const n = points.length
  const bb = bounds3(points)
  const scale = Math.max(1e-9, dist3(bb.min, bb.max))
  const eps = 1e-9 * scale
  const volEps = eps * scale * scale

  const empty = (degenerate: boolean): Hull3 => ({
    faces: [], edges: [], vertices: points.map((_, i) => i), bornAt: [], steps: 0,
    centroid: { x: (bb.min.x + bb.max.x) / 2, y: (bb.min.y + bb.max.y) / 2, z: (bb.min.z + bb.max.z) / 2 },
    volume: 0, area: 0, degenerate,
  })

  if (n < 4) return empty(true)
  const seed = seedTetra(points, eps)
  if (!seed) return empty(true)
  const [i0, i1, i2, i3] = seed

  // A fixed strictly-interior reference: the centroid of the seed tetra. It stays
  // interior as the hull only ever grows outward, so every face can be oriented so
  // that this point lies on the *negative* (inner) side of its plane.
  const interior: Vec3 = {
    x: (points[i0].x + points[i1].x + points[i2].x + points[i3].x) / 4,
    y: (points[i0].y + points[i1].y + points[i2].y + points[i3].y) / 4,
    z: (points[i0].z + points[i1].z + points[i2].z + points[i3].z) / 4,
  }

  const orientedFace = (a: number, b: number, c: number, born: number): WorkFace => {
    // Interior must be on the negative side; if not, flip the winding.
    if (orient3d(points[a], points[b], points[c], interior) > 0) return { a, b: c, c: b, born }
    return { a, b, c, born }
  }

  // Seed the four faces of the tetra (each a leave-one-out triple), oriented outward.
  let faces: WorkFace[] = [
    orientedFace(i1, i2, i3, 0),
    orientedFace(i0, i3, i2, 0),
    orientedFace(i0, i1, i3, 0),
    orientedFace(i0, i2, i1, 0),
  ]

  const seedSet = new Set([i0, i1, i2, i3])
  const order = [] // remaining indices
  for (let i = 0; i < n; i++) if (!seedSet.has(i)) order.push(i)

  const visibleFrom = (f: WorkFace, p: Vec3): boolean =>
    orient3d(points[f.a], points[f.b], points[f.c], p) > eps

  let step = 0
  for (const p of order) {
    step++
    const P = points[p]
    // Faces the new point can "see" (lies outside of).
    const visible: WorkFace[] = []
    const hidden: WorkFace[] = []
    for (const f of faces) (visibleFrom(f, P) ? visible : hidden).push(f)
    if (visible.length === 0) continue // P is inside the current hull

    // Directed edges of the visible cap. A cap edge (u→v) is on the **horizon**
    // when its twin (v→u) is not also a visible directed edge — i.e. the face on
    // the other side is hidden.
    const dir = new Set<number>()
    for (const f of visible) {
      dir.add(key(f.a, f.b))
      dir.add(key(f.b, f.c))
      dir.add(key(f.c, f.a))
    }
    const horizon: [number, number][] = []
    for (const f of visible) {
      const es: [number, number][] = [[f.a, f.b], [f.b, f.c], [f.c, f.a]]
      for (const [u, v] of es) if (!dir.has(key(v, u))) horizon.push([u, v])
    }

    // Replace the visible cap with a fan coning the horizon to P.
    faces = hidden
    for (const [u, v] of horizon) faces.push(orientedFace(u, v, p, step))
  }

  // ── Collect outputs ─────────────────────────────────────────────────────────
  const outFaces: Face3[] = faces.map((f) => ({ a: f.a, b: f.b, c: f.c }))
  const bornAt = faces.map((f) => f.born)

  const vertSet = new Set<number>()
  const edgeSet = new Set<number>()
  const edges: [number, number][] = []
  let volume = 0
  let area = 0
  for (const f of outFaces) {
    vertSet.add(f.a); vertSet.add(f.b); vertSet.add(f.c)
    const pa = points[f.a], pb = points[f.b], pc = points[f.c]
    // Signed volume of tetra (origin, pa, pb, pc); outward faces make the sum the hull volume.
    volume += dot3(pa, cross3(pb, pc)) / 6
    area += len3(cross3(sub3(pb, pa), sub3(pc, pa))) / 2
    const eput = (u: number, v: number) => {
      const lo = Math.min(u, v), hi = Math.max(u, v)
      const k = key(lo, hi)
      if (!edgeSet.has(k)) { edgeSet.add(k); edges.push([lo, hi]) }
    }
    eput(f.a, f.b); eput(f.b, f.c); eput(f.c, f.a)
  }
  volume = Math.abs(volume)
  if (volume < volEps) return empty(true)

  const vertices = [...vertSet].sort((a, b) => a - b)
  let cx = 0, cy = 0, cz = 0
  for (const i of vertices) { cx += points[i].x; cy += points[i].y; cz += points[i].z }
  const m = vertices.length || 1
  const centroid = { x: cx / m, y: cy / m, z: cz / m }

  return { faces: outFaces, edges, vertices, bornAt, steps: step, centroid, volume, area, degenerate: false }
}

/** Outward unit normal of a hull face (for shading). */
export function faceNormal(points: Vec3[], f: Face3): Vec3 {
  const nx = cross3(sub3(points[f.b], points[f.a]), sub3(points[f.c], points[f.a]))
  const l = len3(nx)
  return l < 1e-15 ? { x: 0, y: 0, z: 1 } : { x: nx.x / l, y: nx.y / l, z: nx.z / l }
}
