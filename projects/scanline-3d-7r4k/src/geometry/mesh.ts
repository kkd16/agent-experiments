// A Mesh is an indexed triangle list with per-vertex position / normal / uv.
import type { Vec2, Vec3 } from '../math/vec.ts'
import { add, cross, normalize, scale, sub } from '../math/vec.ts'

export interface Vertex {
  position: Vec3
  normal: Vec3
  uv: Vec2
}

export interface Mesh {
  name: string
  vertices: Vertex[]
  indices: number[] // triples → triangles
}

export const triangleCount = (m: Mesh): number => m.indices.length / 3

// Recompute smooth vertex normals by area-weighted face-normal accumulation.
export const recomputeNormals = (m: Mesh): void => {
  const acc: Vec3[] = m.vertices.map(() => [0, 0, 0])
  for (let i = 0; i < m.indices.length; i += 3) {
    const ia = m.indices[i], ib = m.indices[i + 1], ic = m.indices[i + 2]
    const a = m.vertices[ia].position
    const b = m.vertices[ib].position
    const c = m.vertices[ic].position
    const n = cross(sub(b, a), sub(c, a)) // length ∝ 2·area, so area-weighted
    acc[ia] = add(acc[ia], n)
    acc[ib] = add(acc[ib], n)
    acc[ic] = add(acc[ic], n)
  }
  for (let i = 0; i < m.vertices.length; i++) m.vertices[i].normal = normalize(acc[i])
}

// ── Parametric helpers ──────────────────────────────────────────────────────

// Build a grid over (u, v) ∈ [0,1]² from a surface function that returns a
// position and (optionally) an analytic normal. Wraps seams when asked.
function parametricSurface(
  name: string,
  uSegments: number,
  vSegments: number,
  f: (u: number, v: number) => { position: Vec3; normal?: Vec3 },
  wrapU: boolean,
  wrapV: boolean,
): Mesh {
  const vertices: Vertex[] = []
  const uCount = uSegments + 1
  const vCount = vSegments + 1
  for (let iv = 0; iv < vCount; iv++) {
    const v = iv / vSegments
    for (let iu = 0; iu < uCount; iu++) {
      const u = iu / uSegments
      const s = f(u, v)
      vertices.push({ position: s.position, normal: s.normal ?? [0, 0, 0], uv: [u, v] })
    }
  }
  const indices: number[] = []
  for (let iv = 0; iv < vSegments; iv++) {
    for (let iu = 0; iu < uSegments; iu++) {
      const i0 = iv * uCount + iu
      const i1 = i0 + 1
      const i2 = i0 + uCount
      const i3 = i2 + 1
      indices.push(i0, i2, i1, i1, i2, i3)
    }
  }
  const mesh: Mesh = { name, vertices, indices }
  if (wrapU || wrapV) {
    // analytic normals already correct; nothing to weld for shading purposes.
  }
  return mesh
}

const TAU = Math.PI * 2

export const makeSphere = (radius = 1, seg = 48): Mesh =>
  parametricSurface(
    'Sphere',
    seg,
    seg / 2,
    (u, v) => {
      const theta = v * Math.PI // polar
      const phi = u * TAU // azimuth
      const sinT = Math.sin(theta)
      const n: Vec3 = [sinT * Math.cos(phi), Math.cos(theta), sinT * Math.sin(phi)]
      return { position: scale(n, radius), normal: n }
    },
    true,
    false,
  )

export const makeTorus = (R = 0.7, r = 0.3, segU = 64, segV = 32): Mesh =>
  parametricSurface(
    'Torus',
    segU,
    segV,
    (u, v) => {
      const a = u * TAU
      const b = v * TAU
      const ca = Math.cos(a), sa = Math.sin(a)
      const cb = Math.cos(b), sb = Math.sin(b)
      const position: Vec3 = [(R + r * cb) * ca, r * sb, (R + r * cb) * sa]
      const normal: Vec3 = [cb * ca, sb, cb * sa]
      return { position, normal }
    },
    true,
    true,
  )

// (p, q) torus knot threaded through a tube.
export const makeTorusKnot = (p = 2, q = 3, segU = 256, segV = 16, tube = 0.18): Mesh => {
  const curve = (t: number): Vec3 => {
    const a = t * TAU
    const r = 2 + Math.cos(q * a)
    return [Math.cos(p * a) * r, Math.sin(q * a), Math.sin(p * a) * r]
  }
  return parametricSurface(
    'Torus Knot',
    segU,
    segV,
    (u, v) => {
      const t = u
      const eps = 1e-4
      const c = curve(t)
      const cN = curve(t + eps)
      const tangent = normalize(sub(cN, c))
      // a stable-ish frame: bitangent from tangent × up, normal from the two.
      const up: Vec3 = Math.abs(tangent[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0]
      const bitangent = normalize(cross(tangent, up))
      const normalCurve = normalize(cross(bitangent, tangent))
      const angle = v * TAU
      const ring = add(scale(normalCurve, Math.cos(angle)), scale(bitangent, Math.sin(angle)))
      const position = add(scale(c, 0.35), scale(ring, tube))
      return { position, normal: ring }
    },
    true,
    true,
  )
}

export const makeCylinder = (radius = 0.6, height = 1.4, seg = 48): Mesh => {
  const vertices: Vertex[] = []
  const indices: number[] = []
  const h = height / 2
  // side wall
  for (let iy = 0; iy <= 1; iy++) {
    for (let i = 0; i <= seg; i++) {
      const u = i / seg
      const a = u * TAU
      const n: Vec3 = [Math.cos(a), 0, Math.sin(a)]
      vertices.push({ position: [n[0] * radius, iy ? h : -h, n[2] * radius], normal: n, uv: [u, iy] })
    }
  }
  const row = seg + 1
  for (let i = 0; i < seg; i++) {
    const a = i, b = i + 1, c = i + row, d = i + 1 + row
    indices.push(a, c, b, b, c, d)
  }
  // caps
  const capCenter = (y: number, ny: number): void => {
    const center = vertices.length
    vertices.push({ position: [0, y, 0], normal: [0, ny, 0], uv: [0.5, 0.5] })
    const start = vertices.length
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * TAU
      vertices.push({
        position: [Math.cos(a) * radius, y, Math.sin(a) * radius],
        normal: [0, ny, 0],
        uv: [0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5],
      })
    }
    for (let i = 0; i < seg; i++) {
      if (ny > 0) indices.push(center, start + i, start + i + 1)
      else indices.push(center, start + i + 1, start + i)
    }
  }
  capCenter(h, 1)
  capCenter(-h, -1)
  return { name: 'Cylinder', vertices, indices }
}

export const makePlane = (size = 8, seg = 1): Mesh =>
  parametricSurface(
    'Ground',
    seg,
    seg,
    (u, v) => ({
      position: [(u - 0.5) * size, 0, (v - 0.5) * size],
      normal: [0, 1, 0],
    }),
    false,
    false,
  )

// A cube with hard per-face normals and per-face UVs.
export const makeCube = (s = 0.9): Mesh => {
  const vertices: Vertex[] = []
  const indices: number[] = []
  const faces: { n: Vec3; t: Vec3; b: Vec3 }[] = [
    { n: [0, 0, 1], t: [1, 0, 0], b: [0, 1, 0] },
    { n: [0, 0, -1], t: [-1, 0, 0], b: [0, 1, 0] },
    { n: [1, 0, 0], t: [0, 0, -1], b: [0, 1, 0] },
    { n: [-1, 0, 0], t: [0, 0, 1], b: [0, 1, 0] },
    { n: [0, 1, 0], t: [1, 0, 0], b: [0, 0, -1] },
    { n: [0, -1, 0], t: [1, 0, 0], b: [0, 0, 1] },
  ]
  for (const f of faces) {
    const base = vertices.length
    const corners: Vec2[] = [[0, 0], [1, 0], [1, 1], [0, 1]]
    for (const [cu, cv] of corners) {
      const pos = add(
        add(scale(f.n, s), scale(f.t, (cu - 0.5) * 2 * s)),
        scale(f.b, (cv - 0.5) * 2 * s),
      )
      vertices.push({ position: pos, normal: f.n, uv: [cu, cv] })
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  return { name: 'Cube', vertices, indices }
}

export type MeshKind = 'sphere' | 'torus' | 'knot' | 'cube' | 'cylinder'

export const buildMesh = (kind: MeshKind): Mesh => {
  switch (kind) {
    case 'sphere': return makeSphere()
    case 'torus': return makeTorus()
    case 'knot': return makeTorusKnot()
    case 'cube': return makeCube()
    case 'cylinder': return makeCylinder()
  }
}
