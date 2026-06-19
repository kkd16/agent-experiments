// A small but real Wavefront OBJ parser. Handles v / vn / vt, polygon faces with
// fan triangulation, the v, v/vt, v/vt/vn and v//vn index forms, and negative
// (relative) indices. Vertices are de-duplicated by their v/vt/vn key so smooth
// normals survive. Missing normals are recomputed; the result is recentred and
// scaled to roughly unit size so any model drops straight into the scene.
import type { Vec2, Vec3 } from '../math/vec.ts'
import type { Mesh, Vertex } from './mesh.ts'
import { computeTangents, recomputeNormals } from './mesh.ts'

export interface ParseResult {
  mesh: Mesh | null
  error: string | null
  triangles: number
}

export function parseOBJ(text: string, name = 'Custom'): ParseResult {
  const positions: Vec3[] = []
  const normals: Vec3[] = []
  const texcoords: Vec2[] = []
  const vertices: Vertex[] = []
  const indices: number[] = []
  const cache = new Map<string, number>()
  let hadNormals = false

  // resolve a possibly-negative, 1-based index into a 0-based array index
  const resolve = (token: string, len: number): number => {
    const n = parseInt(token, 10)
    if (Number.isNaN(n)) return -1
    return n > 0 ? n - 1 : len + n
  }

  const addVertex = (spec: string): number => {
    const cached = cache.get(spec)
    if (cached !== undefined) return cached
    const parts = spec.split('/')
    const pi = resolve(parts[0], positions.length)
    const ti = parts[1] ? resolve(parts[1], texcoords.length) : -1
    const ni = parts[2] ? resolve(parts[2], normals.length) : -1
    const position: Vec3 = positions[pi] ?? [0, 0, 0]
    const uv: Vec2 = ti >= 0 ? (texcoords[ti] ?? [0, 0]) : [0, 0]
    const normal: Vec3 = ni >= 0 ? (normals[ni] ?? [0, 1, 0]) : [0, 1, 0]
    if (ni >= 0) hadNormals = true
    const index = vertices.length
    vertices.push({ position, normal, uv })
    cache.set(spec, index)
    return index
  }

  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line[0] === '#') continue
    const tok = line.split(/\s+/)
    const key = tok[0]
    if (key === 'v') {
      positions.push([+tok[1], +tok[2], +tok[3]])
    } else if (key === 'vn') {
      normals.push([+tok[1], +tok[2], +tok[3]])
    } else if (key === 'vt') {
      texcoords.push([+tok[1], +(tok[2] ?? 0)])
    } else if (key === 'f') {
      const face = tok.slice(1).filter(Boolean)
      if (face.length < 3) continue
      // fan triangulation of the polygon
      const i0 = addVertex(face[0])
      for (let k = 1; k < face.length - 1; k++) {
        indices.push(i0, addVertex(face[k]), addVertex(face[k + 1]))
      }
    }
  }

  if (positions.length === 0 || indices.length === 0) {
    return { mesh: null, error: 'No triangles found — expected OBJ `v` and `f` lines.', triangles: 0 }
  }

  const mesh: Mesh = { name, vertices, indices }
  if (!hadNormals) recomputeNormals(mesh)
  normalizeMesh(mesh)
  computeTangents(mesh)
  return { mesh, error: null, triangles: indices.length / 3 }
}

// Recentre on the bounding-box centre and scale so the largest extent ≈ 2 units.
function normalizeMesh(mesh: Mesh): void {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (const v of mesh.vertices) {
    const [x, y, z] = v.position
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6)
  const s = 2 / extent
  for (const v of mesh.vertices) {
    v.position = [(v.position[0] - cx) * s, (v.position[1] - cy) * s, (v.position[2] - cz) * s]
  }
}

// A clean icosahedron, shipped as the importer's worked example.
export const SAMPLE_OBJ = `# icosahedron
v -1 1.618 0
v 1 1.618 0
v -1 -1.618 0
v 1 -1.618 0
v 0 -1 1.618
v 0 1 1.618
v 0 -1 -1.618
v 0 1 -1.618
v 1.618 0 -1
v 1.618 0 1
v -1.618 0 -1
v -1.618 0 1
f 1 12 6
f 1 6 2
f 1 2 8
f 1 8 11
f 1 11 12
f 2 6 10
f 6 12 5
f 12 11 3
f 11 8 7
f 8 2 9
f 4 10 5
f 4 5 3
f 4 3 7
f 4 7 9
f 4 9 10
f 5 10 6
f 3 5 12
f 7 3 11
f 9 7 8
f 10 9 2
`
