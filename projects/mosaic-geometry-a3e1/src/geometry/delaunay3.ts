import type { Vec3 } from './vector3'
import { sub3, cross3, dot3, len3, dist3sq, bounds3, dist3, centroid3, add3, scale3, normalize3 } from './vector3'
import type { Face3 } from './hull3'
import { circumsphere } from './predicates3'

// 3-D Delaunay tetrahedralization by **Bowyer–Watson in space** — the exact analogue
// of the plane's `delaunay.ts`. Enclose every site in a big super-tetrahedron, then
// insert points one at a time: the tetrahedra whose **circumsphere** contains the new
// point form a star-shaped cavity; delete them and re-cone the cavity's boundary
// faces to the point. Strip the super-tetra at the end. The predicates (circumsphere /
// insphere) are order-independent, so no tetra winding needs tracking.
//
// The **dual** is the 3-D Voronoi diagram: a Voronoi vertex sits at every Delaunay
// tetra's circumcentre, and a Voronoi edge crosses every face shared by two tetra —
// the "foam" skeleton. Boundary faces send a Voronoi ray outward, clipped to a box.

export interface Tetra {
  a: number
  b: number
  c: number
  d: number
}

export interface Delaunay3 {
  /** Delaunay tetrahedra over the original point indices. */
  tetra: Tetra[]
  /** Circumcentre of each tetra (parallel to `tetra`) — the Voronoi vertices. */
  circumcenters: Vec3[]
  /** Circumradius of each tetra (parallel to `tetra`). */
  circumradii: number[]
  /** All distinct triangular faces of the mesh (index triples). */
  faces: Face3[]
  /** Faces on the mesh boundary (belong to one tetra) — the convex-hull surface. */
  hullFaces: Face3[]
  /** Voronoi edges: a segment between the circumcentres of every two face-adjacent tetra. */
  voronoiEdges: [Vec3, Vec3][]
  /** Voronoi rays: boundary faces' unbounded dual edges, clipped to a modest length. */
  voronoiRays: [Vec3, Vec3][]
  degenerate: boolean
}

// A tetra during construction may reference the four super-vertices (indices n..n+3).
interface WorkTetra {
  a: number
  b: number
  c: number
  d: number
}

const faceKey = (u: number, v: number, w: number): string => {
  let a = u, b = v, c = w
  if (a > b) { const t = a; a = b; b = t }
  if (b > c) { const t = b; b = c; c = t }
  if (a > b) { const t = a; a = b; b = t }
  return `${a},${b},${c}`
}

/** Four vertices of a regular tetrahedron enclosing the cloud with huge margin. */
function superTetra(points: Vec3[]): Vec3[] {
  const c = centroid3(points)
  let r = 1
  for (const p of points) r = Math.max(r, dist3(p, c))
  const M = (r + 1) * 60 // large enough that the super-vertices don't disturb the interior Delaunay
  const dirs: Vec3[] = [
    { x: 1, y: 1, z: 1 },
    { x: 1, y: -1, z: -1 },
    { x: -1, y: 1, z: -1 },
    { x: -1, y: -1, z: 1 },
  ]
  return dirs.map((d) => add3(c, scale3(normalize3(d), M)))
}

export function delaunay3(points: Vec3[]): Delaunay3 {
  const n = points.length
  const emptyResult = (degenerate: boolean): Delaunay3 => ({
    tetra: [], circumcenters: [], circumradii: [], faces: [], hullFaces: [], voronoiEdges: [], voronoiRays: [], degenerate,
  })
  if (n < 4) return emptyResult(true)

  const st = superTetra(points)
  // Extended point array: originals then the four super-vertices n..n+3.
  const pts: Vec3[] = points.concat(st)
  const S0 = n, S1 = n + 1, S2 = n + 2, S3 = n + 3

  let tets: WorkTetra[] = [{ a: S0, b: S1, c: S2, d: S3 }]

  const bb = bounds3(points)
  const scale = Math.max(1e-9, dist3(bb.min, bb.max))
  const eps = 1e-9 * scale * scale // tolerance on r² − dist² (units of length²)

  for (let ip = 0; ip < n; ip++) {
    const p = pts[ip]
    // Find the tetrahedra whose circumsphere strictly contains p.
    const bad: WorkTetra[] = []
    const good: WorkTetra[] = []
    for (const t of tets) {
      const s = circumsphere(pts[t.a], pts[t.b], pts[t.c], pts[t.d])
      if (s && s.r2 - dist3sq(p, s.center) > eps) bad.push(t)
      else good.push(t)
    }
    if (bad.length === 0) continue // numerically outside every sphere — leave as is

    // Cavity boundary = faces of bad tets not shared with another bad tet.
    const count = new Map<string, number>()
    const rep = new Map<string, [number, number, number]>()
    const bump = (u: number, v: number, w: number) => {
      const k = faceKey(u, v, w)
      count.set(k, (count.get(k) ?? 0) + 1)
      if (!rep.has(k)) rep.set(k, [u, v, w])
    }
    for (const t of bad) {
      bump(t.a, t.b, t.c)
      bump(t.a, t.b, t.d)
      bump(t.a, t.c, t.d)
      bump(t.b, t.c, t.d)
    }
    tets = good
    for (const [k, c] of count) {
      if (c !== 1) continue
      const [u, v, w] = rep.get(k)!
      tets.push({ a: u, b: v, c: w, d: ip })
    }
  }

  // Drop tetrahedra touching any super-vertex.
  const isSuper = (i: number) => i >= n
  const finalTets: Tetra[] = []
  for (const t of tets) {
    if (isSuper(t.a) || isSuper(t.b) || isSuper(t.c) || isSuper(t.d)) continue
    finalTets.push({ a: t.a, b: t.b, c: t.c, d: t.d })
  }
  if (finalTets.length === 0) return emptyResult(true)

  // Circumcentres / radii (Voronoi vertices).
  const circumcenters: Vec3[] = []
  const circumradii: number[] = []
  for (const t of finalTets) {
    const s = circumsphere(points[t.a], points[t.b], points[t.c], points[t.d])
    if (s) { circumcenters.push(s.center); circumradii.push(Math.sqrt(s.r2)) }
    else { circumcenters.push({ x: 0, y: 0, z: 0 }); circumradii.push(0) }
  }

  // Faces → owning tetra list (for mesh faces, hull surface, and the Voronoi dual).
  const owners = new Map<string, number[]>()
  const faceRep = new Map<string, [number, number, number]>()
  const addFace = (u: number, v: number, w: number, ti: number) => {
    const k = faceKey(u, v, w)
    const arr = owners.get(k)
    if (arr) arr.push(ti)
    else { owners.set(k, [ti]); faceRep.set(k, [u, v, w]) }
  }
  finalTets.forEach((t, ti) => {
    addFace(t.a, t.b, t.c, ti)
    addFace(t.a, t.b, t.d, ti)
    addFace(t.a, t.c, t.d, ti)
    addFace(t.b, t.c, t.d, ti)
  })

  const faces: Face3[] = []
  const hullFaces: Face3[] = []
  const voronoiEdges: [Vec3, Vec3][] = []
  const voronoiRays: [Vec3, Vec3][] = []
  const rayLen = dist3(bb.min, bb.max) * 0.32 + scale * 0.1
  for (const [k, tis] of owners) {
    const [u, v, w] = faceRep.get(k)!
    faces.push({ a: u, b: v, c: w })
    if (tis.length === 2) {
      voronoiEdges.push([circumcenters[tis[0]], circumcenters[tis[1]]])
    } else {
      hullFaces.push({ a: u, b: v, c: w })
      // Boundary face → Voronoi ray from the circumcentre outward, clipped to a modest length.
      const ti = tis[0]
      const nrm = cross3(sub3(points[v], points[u]), sub3(points[w], points[u]))
      const l = len3(nrm)
      if (l > 1e-15) {
        let dir = { x: nrm.x / l, y: nrm.y / l, z: nrm.z / l }
        // Point the ray away from the tetra's apex (the vertex not on this face).
        const t = finalTets[ti]
        const apex = [t.a, t.b, t.c, t.d].find((x) => x !== u && x !== v && x !== w)!
        if (dot3(dir, sub3(points[apex], points[u])) > 0) dir = { x: -dir.x, y: -dir.y, z: -dir.z }
        const cc = circumcenters[ti]
        voronoiRays.push([cc, add3(cc, scale3(dir, rayLen))])
      }
    }
  }

  return { tetra: finalTets, circumcenters, circumradii, faces, hullFaces, voronoiEdges, voronoiRays, degenerate: false }
}
