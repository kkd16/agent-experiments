// A Mesh is an indexed triangle list with per-vertex position / normal / uv, plus
// a tangent (xyz + handedness in w) used to build the TBN frame for normal maps.
import type { Vec2, Vec3, Vec4 } from '../math/vec.ts'
import { add, cross, dot, length, normalize, scale, sub } from '../math/vec.ts'

export interface Vertex {
  position: Vec3
  normal: Vec3
  uv: Vec2
  tangent?: Vec4 // xyz = tangent, w = ±1 handedness of the bitangent
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

// Compute per-vertex tangents from positions, UVs and normals (Lengyel's
// method): accumulate the per-triangle tangent/bitangent that map the UV axes to
// world space, then Gram–Schmidt-orthonormalize against the vertex normal and
// store the bitangent handedness in w. Meshes with degenerate UVs fall back to
// an arbitrary tangent perpendicular to the normal.
export const computeTangents = (m: Mesh): void => {
  const tan: Vec3[] = m.vertices.map(() => [0, 0, 0])
  const bit: Vec3[] = m.vertices.map(() => [0, 0, 0])
  for (let i = 0; i < m.indices.length; i += 3) {
    const ia = m.indices[i], ib = m.indices[i + 1], ic = m.indices[i + 2]
    const va = m.vertices[ia], vb = m.vertices[ib], vc = m.vertices[ic]
    const e1 = sub(vb.position, va.position)
    const e2 = sub(vc.position, va.position)
    const du1 = vb.uv[0] - va.uv[0], dv1 = vb.uv[1] - va.uv[1]
    const du2 = vc.uv[0] - va.uv[0], dv2 = vc.uv[1] - va.uv[1]
    const det = du1 * dv2 - du2 * dv1
    if (Math.abs(det) < 1e-12) continue
    const f = 1 / det
    const t: Vec3 = [
      f * (dv2 * e1[0] - dv1 * e2[0]),
      f * (dv2 * e1[1] - dv1 * e2[1]),
      f * (dv2 * e1[2] - dv1 * e2[2]),
    ]
    const bvec: Vec3 = [
      f * (du1 * e2[0] - du2 * e1[0]),
      f * (du1 * e2[1] - du2 * e1[1]),
      f * (du1 * e2[2] - du2 * e1[2]),
    ]
    for (const idx of [ia, ib, ic]) {
      tan[idx] = add(tan[idx], t)
      bit[idx] = add(bit[idx], bvec)
    }
  }
  for (let i = 0; i < m.vertices.length; i++) {
    const n = m.vertices[i].normal
    let t = tan[i]
    // Gram–Schmidt: remove the normal component, then renormalize.
    t = sub(t, scale(n, dot(n, t)))
    if (length(t) < 1e-8) {
      // arbitrary perpendicular when UVs gave us nothing usable
      const ref: Vec3 = Math.abs(n[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0]
      t = cross(ref, n)
    }
    t = normalize(t)
    const w = dot(cross(n, t), bit[i]) < 0 ? -1 : 1
    m.vertices[i].tangent = [t[0], t[1], t[2], w]
  }
}

// ── Parametric helpers ──────────────────────────────────────────────────────

// Build a grid over (u, v) ∈ [0,1]² from a surface function. When `f` supplies
// an analytic normal we use it; otherwise the normal is estimated from central
// differences of the position field (∂P/∂u × ∂P/∂v), with the wrap flags
// controlling whether the epsilon samples wrap the seam or clamp the edge.
function parametricSurface(
  name: string,
  uSegments: number,
  vSegments: number,
  f: (u: number, v: number) => { position: Vec3; normal?: Vec3 },
  wrapU: boolean,
  wrapV: boolean,
): Mesh {
  const wrap = (x: number): number => x - Math.floor(x)
  const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
  const posAt = (uu: number, vv: number): Vec3 =>
    f(wrapU ? wrap(uu) : clamp01(uu), wrapV ? wrap(vv) : clamp01(vv)).position
  const e = 1e-3

  const vertices: Vertex[] = []
  const uCount = uSegments + 1
  const vCount = vSegments + 1
  for (let iv = 0; iv < vCount; iv++) {
    const v = iv / vSegments
    for (let iu = 0; iu < uCount; iu++) {
      const u = iu / uSegments
      const s = f(u, v)
      let normal = s.normal
      if (!normal) {
        const du = sub(posAt(u + e, v), posAt(u - e, v))
        const dv = sub(posAt(u, v + e), posAt(u, v - e))
        normal = normalize(cross(du, dv))
      }
      vertices.push({ position: s.position, normal, uv: [u, v] })
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
  return { name, vertices, indices }
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

// An equilateral triangular prism (apex up) extruded along Z, with hard per-face
// normals — the canonical shape for refraction & dispersion: a beam enters one
// slanted face and leaves through another whose non-parallel orientation bends each
// wavelength by a different amount, fanning white light into a spectrum.
export const makePrism = (radius = 0.85, depth = 0.7): Mesh => {
  const vertices: Vertex[] = []
  const indices: number[] = []
  // triangular cross-section in XY: apex at 90°, base corners at 210° / 330°
  const ang = [Math.PI / 2, (7 * Math.PI) / 6, (11 * Math.PI) / 6]
  const tri: Vec2[] = ang.map((a) => [Math.cos(a) * radius, Math.sin(a) * radius])
  const d = depth / 2
  const addFace = (verts: Vec3[], n: Vec3, uvs: Vec2[]): void => {
    const base = vertices.length
    for (let i = 0; i < verts.length; i++) vertices.push({ position: verts[i], normal: n, uv: uvs[i] })
    // fan-triangulate the (3- or 4-vertex) face
    for (let i = 1; i < verts.length - 1; i++) indices.push(base, base + i, base + i + 1)
  }
  // two triangular caps (front +Z, back −Z)
  addFace(tri.map((p) => [p[0], p[1], d] as Vec3), [0, 0, 1], [[0, 0], [1, 0], [0.5, 1]])
  addFace(tri.map((p) => [p[0], p[1], -d] as Vec3).reverse(), [0, 0, -1], [[0, 0], [1, 0], [0.5, 1]])
  // three rectangular side faces, each with the outward edge normal (in the XY plane)
  for (let i = 0; i < 3; i++) {
    const a = tri[i], b = tri[(i + 1) % 3]
    const ex = b[0] - a[0], ey = b[1] - a[1]
    let nx = ey, ny = -ex // perpendicular to the edge in XY
    const nl = Math.hypot(nx, ny) || 1
    nx /= nl; ny /= nl
    // ensure it points away from the centre
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2
    if (nx * mx + ny * my < 0) { nx = -nx; ny = -ny }
    addFace(
      [[a[0], a[1], d], [b[0], b[1], d], [b[0], b[1], -d], [a[0], a[1], -d]],
      [nx, ny, 0],
      [[0, 0], [1, 0], [1, 1], [0, 1]],
    )
  }
  return { name: 'Prism', vertices, indices }
}

// Figure-8 immersion of the Klein bottle — normals come from finite differences.
export const makeKlein = (segU = 128, segV = 64): Mesh =>
  parametricSurface(
    'Klein Bottle',
    segU,
    segV,
    (u, v) => {
      const a = u * TAU
      const b = v * TAU
      const r = 2 + Math.cos(b / 2) * Math.sin(a) - Math.sin(b / 2) * Math.sin(2 * a)
      const x = r * Math.cos(b)
      const y = Math.sin(b / 2) * Math.sin(a) + Math.cos(b / 2) * Math.sin(2 * a)
      const z = r * Math.sin(b)
      return { position: [x * 0.28, y * 0.28, z * 0.28] }
    },
    true,
    true,
  )

// One-sided Möbius band; two-sided shading in the rasterizer handles the twist.
export const makeMobius = (segU = 160, segV = 18, width = 0.55): Mesh =>
  parametricSurface(
    'Möbius Band',
    segU,
    segV,
    (u, v) => {
      const a = u * TAU
      const s = (v - 0.5) * 2 * width
      const r = 1 + (s / 2) * Math.cos(a / 2)
      return {
        position: [r * Math.cos(a), (s / 2) * Math.sin(a / 2), r * Math.sin(a)],
      }
    },
    true,
    false,
  )

// A coiled spring: a circular tube swept along a helix, with analytic normals.
export const makeSpring = (turns = 3.5, segU = 320, segV = 14, R = 0.55, r = 0.15, height = 1.7): Mesh =>
  parametricSurface(
    'Spring',
    segU,
    segV,
    (u, v) => {
      const a = u * TAU * turns
      const center: Vec3 = [R * Math.cos(a), (u - 0.5) * height, R * Math.sin(a)]
      // tangent = d(center)/du
      const tangent = normalize([
        -R * Math.sin(a) * TAU * turns,
        height,
        R * Math.cos(a) * TAU * turns,
      ])
      const up: Vec3 = [0, 1, 0]
      const bitangent = normalize(cross(tangent, up))
      const nrm = normalize(cross(bitangent, tangent))
      const ang = v * TAU
      const ring = add(scale(nrm, Math.cos(ang)), scale(bitangent, Math.sin(ang)))
      return { position: add(center, scale(ring, r)), normal: ring }
    },
    false,
    true,
  )

export type MeshKind =
  | 'sphere' | 'torus' | 'knot' | 'cube' | 'cylinder' | 'klein' | 'mobius' | 'spring' | 'quad' | 'prism' | 'custom'

export const buildMesh = (kind: MeshKind): Mesh => {
  const m = buildMeshRaw(kind)
  computeTangents(m)
  return m
}

const buildMeshRaw = (kind: MeshKind): Mesh => {
  switch (kind) {
    case 'sphere': return makeSphere()
    case 'torus': return makeTorus()
    case 'knot': return makeTorusKnot()
    case 'cube': return makeCube()
    case 'cylinder': return makeCylinder()
    case 'klein': return makeKlein()
    case 'mobius': return makeMobius()
    case 'spring': return makeSpring()
    case 'quad': return makePlane(1, 1) // a unit quad for building walls / area lights
    case 'prism': return makePrism()
    case 'custom': return makeSphere() // placeholder; the renderer supplies the real custom mesh
  }
}
