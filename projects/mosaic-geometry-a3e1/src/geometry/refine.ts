import type { Edge, Point, Triangle } from './types'
import { convexHull } from './convexHull'
import { delaunay } from './delaunay'
import { circumcenter } from './predicates'
import { dist2 } from './vector'

// Ruppert's Delaunay refinement — turn a raw point cloud into a *quality* mesh in
// which no triangle is too skinny (every angle exceeds a chosen bound). The domain
// is the convex hull; its edges form the boundary segments (a PSLG). Two moves,
// applied until the mesh is clean or a Steiner-point budget runs out:
//
//   • A boundary segment is "encroached" when some vertex sits inside its
//     diametral circle (the circle with that segment as diameter). Split it at its
//     midpoint — this protects the boundary and is always safe.
//   • Otherwise pick the skinniest triangle (smallest angle below the bound) and
//     insert its circumcenter. A circumcenter that would encroach a boundary
//     segment is rejected; we split that segment instead. (For a convex domain an
//     out-of-domain circumcenter always encroaches a boundary segment, so this
//     keeps every inserted point inside the mesh.)
//
// Ruppert proved this terminates for angle bounds up to ~20.7°; we still cap the
// Steiner-point count so an aggressive bound can't run away in the browser.

export interface RefineResult {
  points: Point[] // original points followed by inserted Steiner points
  triangles: Triangle[]
  steinerStart: number // points[steinerStart..] are the inserted vertices
  segments: Edge[] // boundary segments after refinement (index pairs into points)
  minAngleBefore: number // smallest triangle angle (degrees) of the input mesh
  minAngleAfter: number
  iterations: number
  hitCap: boolean
}

export interface RefineOptions {
  minAngleDeg: number // quality target — refine until every angle exceeds this
  maxSteiner: number // safety budget on inserted points
}

const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`)

/** Smallest interior angle (degrees) of triangle ABC. */
function triMinAngle(A: Point, B: Point, C: Point): number {
  const a2 = dist2(B, C)
  const b2 = dist2(A, C)
  const c2 = dist2(A, B)
  const a = Math.sqrt(a2)
  const b = Math.sqrt(b2)
  const c = Math.sqrt(c2)
  if (a < 1e-12 || b < 1e-12 || c < 1e-12) return 0
  const angA = Math.acos(clamp((b2 + c2 - a2) / (2 * b * c), -1, 1))
  const angB = Math.acos(clamp((a2 + c2 - b2) / (2 * a * c), -1, 1))
  const angC = Math.PI - angA - angB
  return (Math.min(angA, angB, angC) * 180) / Math.PI
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Smallest angle over a whole triangulation, in degrees (90 for an empty mesh). */
export function minMeshAngle(pts: Point[], tris: Triangle[]): number {
  let m = 180
  for (const t of tris) m = Math.min(m, triMinAngle(pts[t.a], pts[t.b], pts[t.c]))
  return tris.length ? m : 90
}

/** Is point w strictly inside the diametral circle of segment (u,v)? */
function encroaches(u: Point, v: Point, w: Point): boolean {
  // Inside the diametral circle ⇔ angle u-w-v is obtuse ⇔ (u−w)·(v−w) < 0.
  return (u.x - w.x) * (v.x - w.x) + (u.y - w.y) * (v.y - w.y) < -1e-12
}

export function refineDelaunay(input: Point[], opts: RefineOptions): RefineResult {
  const pts: Point[] = input.map((p) => ({ ...p }))
  const steinerStart = pts.length
  const minAngleBefore = minMeshAngle(pts, pts.length >= 3 ? delaunay(pts) : [])

  // Boundary PSLG: the convex-hull edges.
  let segments: Edge[] = []
  if (pts.length >= 3) {
    const hull = convexHull(pts)
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i]
      const b = hull[(i + 1) % hull.length]
      segments.push({ a: Math.min(a, b), b: Math.max(a, b) })
    }
  }

  const target = opts.minAngleDeg
  let tris: Triangle[] = pts.length >= 3 ? delaunay(pts) : []
  let iterations = 0
  let hitCap = false
  const maxIters = opts.maxSteiner + segments.length + 50

  const splitSegment = (seg: Edge): boolean => {
    if (pts.length - steinerStart >= opts.maxSteiner) {
      hitCap = true
      return false
    }
    const m = { x: (pts[seg.a].x + pts[seg.b].x) / 2, y: (pts[seg.a].y + pts[seg.b].y) / 2 }
    const mi = pts.length
    pts.push(m)
    segments = segments.filter((s) => edgeKey(s.a, s.b) !== edgeKey(seg.a, seg.b))
    segments.push({ a: Math.min(seg.a, mi), b: Math.max(seg.a, mi) })
    segments.push({ a: Math.min(seg.b, mi), b: Math.max(seg.b, mi) })
    return true
  }

  while (iterations < maxIters && pts.length >= 3) {
    iterations++

    // 1) Split any boundary segment encroached by a (non-endpoint) vertex.
    let didSplit = false
    for (const seg of [...segments]) {
      const u = pts[seg.a]
      const v = pts[seg.b]
      for (let w = 0; w < pts.length; w++) {
        if (w === seg.a || w === seg.b) continue
        if (encroaches(u, v, pts[w])) {
          if (splitSegment(seg)) didSplit = true
          break
        }
      }
      if (hitCap) break
    }
    if (didSplit) {
      tris = delaunay(pts)
      if (hitCap) break
      continue
    }

    // 2) Find the skinniest triangle below the angle bound.
    let worst = target
    let worstTri: Triangle | null = null
    for (const t of tris) {
      const ang = triMinAngle(pts[t.a], pts[t.b], pts[t.c])
      if (ang < worst) {
        worst = ang
        worstTri = t
      }
    }
    if (!worstTri) break // quality target met

    const c = circumcenter(pts[worstTri.a], pts[worstTri.b], pts[worstTri.c])
    if (!c) {
      break // degenerate triangle — nothing useful to insert
    }

    // 3) If the circumcenter encroaches boundary segments, split those instead.
    const encroached = segments.filter((s) => encroaches(pts[s.a], pts[s.b], c))
    if (encroached.length > 0) {
      let any = false
      for (const s of encroached) {
        if (splitSegment(s)) any = true
        if (hitCap) break
      }
      tris = delaunay(pts)
      if (hitCap) break
      if (any) continue
      break
    }

    // 4) Otherwise insert the circumcenter as a Steiner point.
    if (pts.length - steinerStart >= opts.maxSteiner) {
      hitCap = true
      break
    }
    pts.push(c)
    tris = delaunay(pts)
  }

  return {
    points: pts,
    triangles: tris,
    steinerStart,
    segments,
    minAngleBefore,
    minAngleAfter: minMeshAngle(pts, tris),
    iterations,
    hitCap,
  }
}
