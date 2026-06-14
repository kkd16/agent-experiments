// obj.ts — a small, dependency-free Wavefront OBJ parser. It understands the
// subset that matters for rendering geometry: `v` vertex positions, `vn` vertex
// normals, and `f` faces in any of the `v`, `v/vt`, `v//vn`, `v/vt/vn` forms
// (with positive or negative/relative indices). Polygons are triangulated as a
// fan, normals are recovered area-weighted when the file omits them, and the
// model is recentred and scaled to a unit box so any pasted mesh lands sensibly
// in a scene regardless of its authoring units.

import type { Vec3 } from './vec3'
import { v } from './vec3'
import type { Mesh } from './mesh'
import { recomputeNormals } from './mesh'

export interface ObjResult {
  mesh: Mesh
  vertexCount: number
  faceCount: number
  hadNormals: boolean
  warnings: string[]
}

// Resolve a 1-based (or negative/relative) OBJ index against a list length.
function resolve(i: number, len: number): number {
  return i > 0 ? i - 1 : len + i
}

export function parseObj(text: string, fitRadius = 1): ObjResult {
  const positions: Vec3[] = []
  const fileNormals: Vec3[] = []
  // Each face vertex records a position index and (optionally) a normal index.
  const faces: { vi: number; ni: number }[][] = []
  const warnings: string[] = []

  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0 || line[0] === '#') continue
    const parts = line.split(/\s+/)
    const tag = parts[0]
    if (tag === 'v') {
      positions.push(v(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])))
    } else if (tag === 'vn') {
      fileNormals.push(v(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])))
    } else if (tag === 'f') {
      const verts: { vi: number; ni: number }[] = []
      for (let k = 1; k < parts.length; k++) {
        const comps = parts[k].split('/')
        const vi = resolve(parseInt(comps[0], 10), positions.length)
        const ni = comps.length >= 3 && comps[2] !== '' ? resolve(parseInt(comps[2], 10), fileNormals.length) : -1
        verts.push({ vi, ni })
      }
      if (verts.length >= 3) faces.push(verts)
    }
  }

  if (positions.length === 0 || faces.length === 0) {
    throw new Error('No geometry found (need at least `v` vertices and `f` faces).')
  }

  // Fit to a unit box: centre on the bbox midpoint and scale so the largest
  // half-extent becomes `fitRadius`.
  let lo = v(Infinity, Infinity, Infinity)
  let hi = v(-Infinity, -Infinity, -Infinity)
  for (const p of positions) {
    lo = v(Math.min(lo.x, p.x), Math.min(lo.y, p.y), Math.min(lo.z, p.z))
    hi = v(Math.max(hi.x, p.x), Math.max(hi.y, p.y), Math.max(hi.z, p.z))
  }
  const center = v((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2)
  const half = Math.max(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z) / 2 || 1
  const k = fitRadius / half
  const fitted = positions.map((p) => v((p.x - center.x) * k, (p.y - center.y) * k, (p.z - center.z) * k))

  const useFileNormals = fileNormals.length > 0 && faces.every((f) => f.every((c) => c.ni >= 0))

  let mesh: Mesh
  let faceCount = 0
  if (useFileNormals) {
    // Expand each face vertex so its authored normal is preserved exactly.
    const outPos: Vec3[] = []
    const outNor: Vec3[] = []
    const indices: number[] = []
    for (const f of faces) {
      const base = outPos.length
      for (const c of f) {
        outPos.push(fitted[c.vi])
        outNor.push(fileNormals[c.ni])
      }
      for (let t = 1; t + 1 < f.length; t++) {
        indices.push(base, base + t, base + t + 1)
        faceCount++
      }
    }
    mesh = { positions: outPos, normals: outNor, indices }
  } else {
    // Share positions and recover smooth normals area-weighted.
    if (fileNormals.length > 0) warnings.push('Some faces lacked normals — recomputed them.')
    const indices: number[] = []
    for (const f of faces) {
      for (let t = 1; t + 1 < f.length; t++) {
        indices.push(f[0].vi, f[t].vi, f[t + 1].vi)
        faceCount++
      }
    }
    mesh = { positions: fitted, normals: recomputeNormals(fitted, indices), indices }
  }

  return {
    mesh,
    vertexCount: positions.length,
    faceCount,
    hadNormals: useFileNormals,
    warnings,
  }
}

// A unit cube as OBJ text — used by the verification suite and as a fallback so
// the Custom-OBJ scene always has something to show.
export const CUBE_OBJ = `# unit cube (CCW faces ⇒ outward normals)
v -1 -1 -1
v  1 -1 -1
v  1  1 -1
v -1  1 -1
v -1 -1  1
v  1 -1  1
v  1  1  1
v -1  1  1
f 1 4 3 2
f 5 6 7 8
f 1 5 8 4
f 2 3 7 6
f 1 2 6 5
f 4 8 7 3
`
