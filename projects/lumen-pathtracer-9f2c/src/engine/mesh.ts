// mesh.ts — indexed triangle meshes and the procedural generators that build
// them. Everything here is geometry-only: a mesh is a list of vertex positions,
// matching per-vertex normals, and integer triangle indices. `emitMesh` lowers a
// mesh into the renderer's flat `PrimDef` triangle soup, attaching the smooth
// vertex normals so `Scene.intersect` can interpolate them across each face —
// which is what makes a few hundred triangles read as a perfectly curved surface.

import type { Vec3 } from './vec3'
import { add, cross, len, normalize, scale, sub, v } from './vec3'
import type { PrimDef } from './types'

export interface Mesh {
  positions: Vec3[]
  normals: Vec3[]
  indices: number[] // flat triples (i0,i1,i2,…), CCW front faces
}

// Area-weighted vertex normals: each face contributes its (un-normalised) cross
// product — whose length is twice the triangle area — to its three vertices, so
// larger faces dominate the average. Standard and robust for arbitrary meshes.
export function recomputeNormals(positions: Vec3[], indices: number[]): Vec3[] {
  const normals: Vec3[] = positions.map(() => v(0, 0, 0))
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]
    const b = indices[i + 1]
    const c = indices[i + 2]
    const fn = cross(sub(positions[b], positions[a]), sub(positions[c], positions[a]))
    normals[a] = add(normals[a], fn)
    normals[b] = add(normals[b], fn)
    normals[c] = add(normals[c], fn)
  }
  return normals.map((n) => (len(n) > 1e-12 ? normalize(n) : v(0, 1, 0)))
}

// ---------------------------------------------------------------------------
// Generators (all unit-scale around the origin; transform afterwards)
// ---------------------------------------------------------------------------

// A geodesic sphere: subdivide a regular icosahedron and project every vertex to
// the unit sphere. Triangles are near-equilateral (no UV-sphere pole pinching),
// and the exact normal of a unit sphere is just the position.
export function icosphere(subdivisions = 2): Mesh {
  const t = (1 + Math.sqrt(5)) / 2
  let positions: Vec3[] = [
    v(-1, t, 0), v(1, t, 0), v(-1, -t, 0), v(1, -t, 0),
    v(0, -1, t), v(0, 1, t), v(0, -1, -t), v(0, 1, -t),
    v(t, 0, -1), v(t, 0, 1), v(-t, 0, -1), v(-t, 0, 1),
  ].map(normalize)
  let faces: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ]
  for (let s = 0; s < subdivisions; s++) {
    const midCache = new Map<number, number>()
    const next: number[][] = []
    const midpoint = (i: number, j: number): number => {
      const key = i < j ? i * 100000 + j : j * 100000 + i
      const found = midCache.get(key)
      if (found !== undefined) return found
      const m = normalize(scale(add(positions[i], positions[j]), 0.5))
      positions.push(m)
      const idx = positions.length - 1
      midCache.set(key, idx)
      return idx
    }
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b)
      const bc = midpoint(b, c)
      const ca = midpoint(c, a)
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca])
    }
    faces = next
  }
  positions = positions.map(normalize)
  return { positions, normals: positions.map((p) => ({ ...p })), indices: faces.flat() }
}

// A latitude/longitude sphere — fewer triangles than an icosphere for the same
// smoothness, with exact radial normals.
export function uvSphere(rings = 24, segments = 48): Mesh {
  const positions: Vec3[] = []
  const indices: number[] = []
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI // 0..π (north→south)
    const y = Math.cos(phi)
    const r = Math.sin(phi)
    for (let j = 0; j <= segments; j++) {
      const theta = (j / segments) * 2 * Math.PI
      positions.push(v(r * Math.cos(theta), y, r * Math.sin(theta)))
    }
  }
  const stride = segments + 1
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * stride + j
      const b = a + stride
      indices.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }
  return { positions, normals: positions.map((p) => normalize(p)), indices }
}

// A torus of major radius R and tube radius r, with exact analytic normals.
export function torus(R = 1, r = 0.35, ringSegs = 48, tubeSegs = 24): Mesh {
  const positions: Vec3[] = []
  const normals: Vec3[] = []
  const indices: number[] = []
  for (let i = 0; i <= ringSegs; i++) {
    const u = (i / ringSegs) * 2 * Math.PI
    const cu = Math.cos(u)
    const su = Math.sin(u)
    for (let j = 0; j <= tubeSegs; j++) {
      const vv = (j / tubeSegs) * 2 * Math.PI
      const cv = Math.cos(vv)
      const sv = Math.sin(vv)
      positions.push(v((R + r * cv) * cu, r * sv, (R + r * cv) * su))
      normals.push(v(cv * cu, sv, cv * su))
    }
  }
  const stride = tubeSegs + 1
  for (let i = 0; i < ringSegs; i++) {
    for (let j = 0; j < tubeSegs; j++) {
      const a = i * stride + j
      const b = a + stride
      indices.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }
  return { positions, normals, indices }
}

// A surface of revolution: spin a 2-D profile (radius, height) around the Y axis.
// Normals come from the profile's own tangent crossed with the circular tangent,
// so lathed shapes (goblets, vases, chess pieces) shade smoothly along the curve.
export function surfaceOfRevolution(profile: { r: number; y: number }[], segments = 64): Mesh {
  const positions: Vec3[] = []
  const normals: Vec3[] = []
  const indices: number[] = []
  const rows = profile.length
  // 2-D profile normal (pointing outward) at each profile point, from finite
  // differences along the curve, rotated 90°: (dy, -dr) normalised.
  const pn: { nr: number; ny: number }[] = profile.map((_, k) => {
    const a = profile[Math.max(0, k - 1)]
    const b = profile[Math.min(rows - 1, k + 1)]
    const dr = b.r - a.r
    const dy = b.y - a.y
    const l = Math.hypot(dr, dy) || 1
    return { nr: dy / l, ny: -dr / l }
  })
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j <= segments; j++) {
      const theta = (j / segments) * 2 * Math.PI
      const c = Math.cos(theta)
      const s = Math.sin(theta)
      positions.push(v(profile[i].r * c, profile[i].y, profile[i].r * s))
      normals.push(normalize(v(pn[i].nr * c, pn[i].ny, pn[i].nr * s)))
    }
  }
  const stride = segments + 1
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * stride + j
      const b = a + stride
      indices.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }
  return { positions, normals, indices }
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

export interface Transform {
  translate?: Vec3
  scale?: Vec3 | number
  rotate?: { axis: Vec3; angle: number } // radians, right-handed
}

// Build the 3×3 rotation for an axis-angle (Rodrigues), then the per-vertex
// position transform R·S and the normal transform (R·S)^{-T}. For our uses S is
// diagonal so the inverse-transpose is just R·S^{-1} — handled component-wise.
function rotationMatrix(axis: Vec3, angle: number): number[][] {
  const a = normalize(axis)
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const t = 1 - c
  const { x, y, z } = a
  return [
    [c + x * x * t, x * y * t - z * s, x * z * t + y * s],
    [y * x * t + z * s, c + y * y * t, y * z * t - x * s],
    [z * x * t - y * s, z * y * t + x * s, c + z * z * t],
  ]
}

const apply = (m: number[][], p: Vec3): Vec3 => ({
  x: m[0][0] * p.x + m[0][1] * p.y + m[0][2] * p.z,
  y: m[1][0] * p.x + m[1][1] * p.y + m[1][2] * p.z,
  z: m[2][0] * p.x + m[2][1] * p.y + m[2][2] * p.z,
})

export function transformMesh(mesh: Mesh, t: Transform): Mesh {
  const sc = t.scale === undefined ? v(1, 1, 1) : typeof t.scale === 'number' ? v(t.scale, t.scale, t.scale) : t.scale
  const tr = t.translate ?? v(0, 0, 0)
  const R = t.rotate ? rotationMatrix(t.rotate.axis, t.rotate.angle) : [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  const positions = mesh.positions.map((p) => {
    const scaled = v(p.x * sc.x, p.y * sc.y, p.z * sc.z)
    return add(apply(R, scaled), tr)
  })
  // Normal transform: divide by the (diagonal) scale, then rotate, then renormalise.
  const normals = mesh.normals.map((n) => {
    const inv = v(n.x / sc.x, n.y / sc.y, n.z / sc.z)
    return normalize(apply(R, inv))
  })
  return { positions, normals, indices: mesh.indices }
}

// ---------------------------------------------------------------------------
// Lowering to the renderer
// ---------------------------------------------------------------------------

// Emit a mesh as smooth-shaded triangle `PrimDef`s for a given material index.
export function emitMesh(mesh: Mesh, material: number): PrimDef[] {
  const out: PrimDef[] = []
  const idx = mesh.indices
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i]
    const b = idx[i + 1]
    const c = idx[i + 2]
    out.push({
      kind: 'tri',
      p0: mesh.positions[a],
      p1: mesh.positions[b],
      p2: mesh.positions[c],
      material,
      n0: mesh.normals[a],
      n1: mesh.normals[b],
      n2: mesh.normals[c],
    })
  }
  return out
}

export const meshTriangleCount = (mesh: Mesh): number => mesh.indices.length / 3
