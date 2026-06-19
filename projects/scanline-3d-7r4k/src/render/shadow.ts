// Shadow mapping. Before the main pass we render scene depth from the primary
// directional light's point of view (an orthographic frustum) into a square
// depth texture. During shading each fragment is reprojected into that light
// space and its depth compared against the stored nearest occluder — with a
// slope-scaled bias to kill acne and a 3×3 PCF kernel for soft edges.
import type { Mat4 } from '../math/mat4.ts'
import { lookAt, multiply, orthographic, transformPoint, transformVec4 } from '../math/mat4.ts'
import type { Vec3, Vec4 } from '../math/vec.ts'
import { add, normalize, scale, sub } from '../math/vec.ts'
import type { Mesh } from '../geometry/mesh.ts'

export class ShadowMap {
  readonly size: number
  readonly depth: Float32Array
  lightVP: Mat4

  constructor(size = 1024) {
    this.size = size
    this.depth = new Float32Array(size * size)
    this.lightVP = []
  }

  // Aim an orthographic light frustum at `center` covering a sphere of `radius`.
  setLight(direction: Vec3, center: Vec3, radius: number): void {
    const dir = normalize(direction)
    const dist = radius * 2.5
    const eye = sub(center, scale(dir, dist))
    const up: Vec3 = Math.abs(dir[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0]
    const view = lookAt(eye, center, up)
    const proj = orthographic(-radius, radius, -radius, radius, 0.05, dist + radius * 2)
    this.lightVP = multiply(proj, view)
  }

  clear(): void {
    this.depth.fill(Infinity)
  }

  // Depth-only rasterization of one mesh into the shadow map.
  renderMesh(mesh: Mesh, model: Mat4): void {
    const mvp = multiply(this.lightVP, model)
    const verts = mesh.vertices
    const clip: Vec4[] = new Array(verts.length)
    for (let i = 0; i < verts.length; i++) {
      const p = verts[i].position
      clip[i] = transformVec4(mvp, [p[0], p[1], p[2], 1])
    }
    const idx = mesh.indices
    for (let t = 0; t < idx.length; t += 3) {
      const poly = clipNearVec4([clip[idx[t]], clip[idx[t + 1]], clip[idx[t + 2]]])
      for (let f = 1; f < poly.length - 1; f++) {
        this.rasterDepth(poly[0], poly[f], poly[f + 1])
      }
    }
  }

  private rasterDepth(a: Vec4, b: Vec4, c: Vec4): void {
    const S = this.size
    const ax = this.sx(a), ay = this.sy(a), az = a[2] / a[3]
    const bx = this.sx(b), by = this.sy(b), bz = b[2] / b[3]
    const cx = this.sx(c), cy = this.sy(c), cz = c[2] / c[3]
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (area === 0) return
    const inv = 1 / area
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)))
    const maxX = Math.min(S - 1, Math.ceil(Math.max(ax, bx, cx)))
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)))
    const maxY = Math.min(S - 1, Math.ceil(Math.max(ay, by, cy)))
    const sign = area > 0 ? 1 : -1
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5
        const wA = ((cx - bx) * (py - by) - (cy - by) * (px - bx)) * inv
        const wB = ((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) * inv
        const wC = 1 - wA - wB
        if (wA * sign >= 0 && wB * sign >= 0 && wC * sign >= 0) {
          const z = wA * az + wB * bz + wC * cz
          const di = y * S + x
          if (z < this.depth[di]) this.depth[di] = z
        }
      }
    }
  }

  private sx(v: Vec4): number {
    return (v[0] / v[3] * 0.5 + 0.5) * this.size
  }
  private sy(v: Vec4): number {
    return (1 - (v[1] / v[3] * 0.5 + 0.5)) * this.size
  }

  // Returns lit fraction in [0,1] for a world-space point (1 = fully lit).
  sample(worldPos: Vec3, ndl: number): number {
    const lp = transformVec4(this.lightVP, [worldPos[0], worldPos[1], worldPos[2], 1])
    const nx = lp[0] / lp[3]
    const ny = lp[1] / lp[3]
    const nz = lp[2] / lp[3]
    if (nx < -1 || nx > 1 || ny < -1 || ny > 1 || nz > 1) return 1
    const u = (nx * 0.5 + 0.5) * this.size
    const v = (1 - (ny * 0.5 + 0.5)) * this.size
    // slope-scaled bias: steeper angles need more
    const bias = Math.max(0.0008, 0.004 * (1 - ndl))
    const S = this.size
    const x0 = Math.floor(u)
    const y0 = Math.floor(v)
    let lit = 0
    let count = 0
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const sxp = x0 + ox
        const syp = y0 + oy
        if (sxp < 0 || sxp >= S || syp < 0 || syp >= S) { lit++; count++; continue }
        const stored = this.depth[syp * S + sxp]
        lit += nz - bias <= stored ? 1 : 0
        count++
      }
    }
    return lit / count
  }
}

// Clip a polygon of clip-space Vec4 against the near plane (z + w ≥ 0).
function clipNearVec4(poly: Vec4[]): Vec4[] {
  const out: Vec4[] = []
  const n = poly.length
  const d = (v: Vec4): number => v[2] + v[3]
  for (let i = 0; i < n; i++) {
    const cur = poly[i]
    const nxt = poly[(i + 1) % n]
    const dc = d(cur)
    const dn = d(nxt)
    const cin = dc >= 0
    const nin = dn >= 0
    if (cin) out.push(cur)
    if (cin !== nin) {
      const t = dc / (dc - dn)
      out.push([
        cur[0] + (nxt[0] - cur[0]) * t,
        cur[1] + (nxt[1] - cur[1]) * t,
        cur[2] + (nxt[2] - cur[2]) * t,
        cur[3] + (nxt[3] - cur[3]) * t,
      ])
    }
  }
  return out
}

// Estimate a bounding sphere (center + radius) for a set of world-space points.
export const boundsOf = (points: Vec3[]): { center: Vec3; radius: number } => {
  if (points.length === 0) return { center: [0, 0, 0], radius: 1 }
  let c: Vec3 = [0, 0, 0]
  for (const p of points) c = add(c, p)
  c = scale(c, 1 / points.length)
  let r = 0
  for (const p of points) r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]))
  return { center: c, radius: Math.max(1, r) }
}

export const transformedCenter = (model: Mat4): Vec3 => transformPoint(model, [0, 0, 0])
