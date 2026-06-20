// Scan conversion. Each clipped triangle is divided through by w, mapped to the
// viewport, and filled with an edge-function rasterizer that walks a bounding box
// and steps the three barycentric edge functions incrementally. Attributes are
// interpolated perspective-correctly (×1/w, then ÷ the interpolated 1/w); depth
// is linear in screen space and goes through a z-buffer.
//
// The beauty pass ('shaded') writes *linear* radiance into the HDR buffer so the
// resolve pass can tone-map it; every debug view packs straight into `color`.
import { clamp01 } from '../math/scalar.ts'
import type { Vec2, Vec3, Vec4 } from '../math/vec.ts'
import { cross, dot, length, negate, normalize, scale, sub } from '../math/vec.ts'
import { Framebuffer } from './framebuffer.ts'
import { emptyComponents, gammaEncode, shadeSurface } from './shading.ts'
import type { Material, ShadeComponents, ShadeContext } from './shading.ts'
import type { GBuffer } from './gbuffer.ts'
import type { NormalMap, Texture } from './texture.ts'
import type { FrameStats, PipeVertex, RenderMode } from './types.ts'

export interface Uniforms {
  mode: RenderMode
  material: Material
  texture: Texture | null
  normalMap: NormalMap | null
  shade: ShadeContext
  near: number
  far: number
  wasClipped: boolean
}

interface ScreenVertex {
  x: number
  y: number
  z: number // ndc depth, linear in screen space
  iw: number // 1 / clip.w
  world: Vec3
  normal: Vec3
  tangent: Vec4
  uv: Vec2
}

const project = (v: PipeVertex, w: number, h: number): ScreenVertex => {
  const iw = 1 / v.clip[3]
  const ndcX = v.clip[0] * iw
  const ndcY = v.clip[1] * iw
  const ndcZ = v.clip[2] * iw
  return {
    x: (ndcX * 0.5 + 0.5) * w,
    y: (1 - (ndcY * 0.5 + 0.5)) * h,
    z: ndcZ,
    iw,
    world: v.world,
    normal: v.normal,
    tangent: v.tangent,
    uv: v.uv,
  }
}

// Linearise ndc depth (−1..1) into a 0..1 brightness for the depth view.
const linearDepth = (ndcZ: number, near: number, far: number): number => {
  const z = ndcZ // already −1..1
  const eye = (2 * near * far) / (far + near - z * (far - near))
  return clamp01((eye - near) / (far - near))
}

// Perturb a geometric normal by a tangent-space normal map sample. Builds an
// orthonormal TBN from the interpolated tangent (Gram–Schmidt against n) and the
// handedness in tangent.w.
function perturbNormal(n: Vec3, t: Vec3, handed: number, map: NormalMap, u: number, v: number): Vec3 {
  let T = sub(t, scale(n, dot(n, t)))
  if (length(T) < 1e-6) return n
  T = normalize(T)
  const B = scale(cross(n, T), handed)
  const m = map(u, v)
  return normalize([
    T[0] * m[0] + B[0] * m[1] + n[0] * m[2],
    T[1] * m[0] + B[1] * m[1] + n[1] * m[2],
    T[2] * m[0] + B[2] * m[1] + n[2] * m[2],
  ])
}

const HEAT: Vec3[] = [
  [0.0, 0.0, 0.15], [0.0, 0.3, 0.7], [0.0, 0.8, 0.8],
  [0.2, 0.9, 0.2], [0.95, 0.9, 0.1], [0.95, 0.4, 0.05], [0.9, 0.05, 0.05],
]

export function rasterizeTriangle(
  fb: Framebuffer,
  tri: [PipeVertex, PipeVertex, PipeVertex],
  uni: Uniforms,
  stats: FrameStats,
  cullBack: boolean,
  gbuf: GBuffer | null = null,
): void {
  const { width: W, height: H, color, depth, overdraw, hdr } = fb
  // scratch decomposition reused across this triangle's fragments (deferred capture)
  const comps: ShadeComponents | null = gbuf ? emptyComponents() : null
  const a = project(tri[0], W, H)
  const b = project(tri[1], W, H)
  const c = project(tri[2], W, H)

  // signed area (×2). Front faces are CCW-in-camera → negative after the y flip.
  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
  if (area === 0) return
  if (cullBack && area > 0) {
    stats.trianglesCulled++
    return
  }
  stats.trianglesDrawn++

  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)))
  const maxX = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x, c.x)))
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)))
  const maxY = Math.min(H - 1, Math.ceil(Math.max(a.y, b.y, c.y)))
  if (minX > maxX || minY > maxY) return

  const invArea = 1 / area
  // edge function steps (see header comment in clip.ts for the derivation)
  const sx0 = a.y - b.y, sy0 = b.x - a.x // edge a→b  → weight of c (w2-ish)
  const sx1 = b.y - c.y, sy1 = c.x - b.x // edge b→c  → weight of a
  const sx2 = c.y - a.y, sy2 = a.x - c.x // edge c→a  → weight of b

  const px = minX + 0.5
  const py = minY + 0.5
  // wA is the weight of vertex a = edge(b, c, P)
  let rowA = (c.x - b.x) * (py - b.y) - (c.y - b.y) * (px - b.x)
  let rowB = (a.x - c.x) * (py - c.y) - (a.y - c.y) * (px - c.x)
  let rowC = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x)

  const mode = uni.mode
  const insideSign = area > 0 ? 1 : -1
  const needNormalMap = uni.normalMap !== null && (mode === 'shaded' || mode === 'normals')

  for (let y = minY; y <= maxY; y++) {
    let wA = rowA
    let wB = rowB
    let wC = rowC
    const rowOff = y * W
    for (let x = minX; x <= maxX; x++) {
      // inside test (inclusive → no cracks); sign follows the winding
      if (wA * insideSign >= 0 && wB * insideSign >= 0 && wC * insideSign >= 0) {
        const l0 = wA * invArea
        const l1 = wB * invArea
        const l2 = wC * invArea
        const idx = rowOff + x
        overdraw[idx]++

        if (mode === 'overdraw') {
          // colour applied in a post-pass; just count here.
          wA += sx1; wB += sx2; wC += sx0
          continue
        }

        const z = l0 * a.z + l1 * b.z + l2 * c.z
        if (z < depth[idx]) {
          const iw = l0 * a.iw + l1 * b.iw + l2 * c.iw
          const inv = 1 / iw
          // perspective-correct attributes
          const u = (l0 * a.uv[0] * a.iw + l1 * b.uv[0] * b.iw + l2 * c.uv[0] * c.iw) * inv
          const v = (l0 * a.uv[1] * a.iw + l1 * b.uv[1] * b.iw + l2 * c.uv[1] * c.iw) * inv

          if (mode === 'depth') {
            const d = 1 - linearDepth(z, uni.near, uni.far)
            color[idx] = Framebuffer.pack(d, d, d)
          } else {
            const nx = (l0 * a.normal[0] * a.iw + l1 * b.normal[0] * b.iw + l2 * c.normal[0] * c.iw) * inv
            const ny = (l0 * a.normal[1] * a.iw + l1 * b.normal[1] * b.iw + l2 * c.normal[1] * c.iw) * inv
            const nz = (l0 * a.normal[2] * a.iw + l1 * b.normal[2] * b.iw + l2 * c.normal[2] * c.iw) * inv

            if (mode === 'uv') {
              color[idx] = Framebuffer.pack(u, v, 0.4)
            } else {
              const wx = (l0 * a.world[0] * a.iw + l1 * b.world[0] * b.iw + l2 * c.world[0] * c.iw) * inv
              const wy = (l0 * a.world[1] * a.iw + l1 * b.world[1] * b.iw + l2 * c.world[1] * c.iw) * inv
              const wz = (l0 * a.world[2] * a.iw + l1 * b.world[2] * b.iw + l2 * c.world[2] * c.iw) * inv
              const world: Vec3 = [wx, wy, wz]
              let n = normalize([nx, ny, nz])
              // two-sided shading: face the geometric normal toward the camera
              if (dot(n, sub(uni.shade.eye, world)) < 0) n = negate(n)

              if (needNormalMap) {
                const tx = (l0 * a.tangent[0] * a.iw + l1 * b.tangent[0] * b.iw + l2 * c.tangent[0] * c.iw) * inv
                const ty = (l0 * a.tangent[1] * a.iw + l1 * b.tangent[1] * b.iw + l2 * c.tangent[1] * c.iw) * inv
                const tz = (l0 * a.tangent[2] * a.iw + l1 * b.tangent[2] * b.iw + l2 * c.tangent[2] * c.iw) * inv
                n = perturbNormal(n, [tx, ty, tz], a.tangent[3], uni.normalMap!, u, v)
              }

              if (mode === 'normals') {
                color[idx] = Framebuffer.pack(n[0] * 0.5 + 0.5, n[1] * 0.5 + 0.5, n[2] * 0.5 + 0.5)
              } else {
                let base = uni.material.albedo
                if (uni.texture) {
                  const t = uni.texture(u, v)
                  base = [base[0] * t[0], base[1] * t[1], base[2] * t[2]]
                }
                if (mode === 'shaded') {
                  // linear radiance → HDR buffer (resolve pass tone-maps it)
                  const lit = shadeSurface(base, world, n, uni.material, uni.shade, comps ?? undefined)
                  const o = idx * 3
                  hdr[o] = lit[0]
                  hdr[o + 1] = lit[1]
                  hdr[o + 2] = lit[2]
                  if (gbuf && comps) captureGBuffer(gbuf, idx, world, n, base, uni.material, uni.shade, comps)
                } else {
                  // albedo / clip debug views pack straight to color
                  let lit: Vec3
                  if (mode === 'albedo') {
                    lit = base
                  } else {
                    const shadeAmt = clamp01(dot(n, normalize(sub(uni.shade.eye, world)))) * 0.7 + 0.3
                    lit = uni.wasClipped
                      ? [shadeAmt, shadeAmt * 0.3, shadeAmt * 0.3]
                      : [shadeAmt * 0.4, shadeAmt * 0.5, shadeAmt * 0.6]
                  }
                  const g = gammaEncode(lit)
                  color[idx] = Framebuffer.pack(g[0], g[1], g[2])
                }
              }
            }
          }
          depth[idx] = z
          stats.pixelsFilled++
        }
      }
      wA += sx1
      wB += sx2
      wC += sx0
    }
    rowA += sy1
    rowB += sy2
    rowC += sy0
  }
}

// Record one front-most fragment into the deferred G-buffer. Runs only for the
// nearest surface at a pixel (it sits inside the depth test), so the buffer holds
// exactly what the screen-space passes should see.
function captureGBuffer(
  gbuf: GBuffer,
  idx: number,
  world: Vec3,
  n: Vec3,
  base: Vec3,
  mat: Material,
  shade: ShadeContext,
  comps: ShadeComponents,
): void {
  const i3 = idx * 3
  gbuf.pos[i3] = world[0]; gbuf.pos[i3 + 1] = world[1]; gbuf.pos[i3 + 2] = world[2]
  gbuf.normal[i3] = n[0]; gbuf.normal[i3 + 1] = n[1]; gbuf.normal[i3 + 2] = n[2]
  gbuf.albedo[i3] = base[0]; gbuf.albedo[i3 + 1] = base[1]; gbuf.albedo[i3 + 2] = base[2]
  gbuf.direct[i3] = comps.direct[0]; gbuf.direct[i3 + 1] = comps.direct[1]; gbuf.direct[i3 + 2] = comps.direct[2]
  gbuf.ambient[i3] = comps.ambient[0]; gbuf.ambient[i3 + 1] = comps.ambient[1]; gbuf.ambient[i3 + 2] = comps.ambient[2]
  gbuf.spec[i3] = comps.spec[0]; gbuf.spec[i3 + 1] = comps.spec[1]; gbuf.spec[i3 + 2] = comps.spec[2]
  gbuf.rough[idx] = Math.min(1, Math.max(0.04, mat.roughness ?? 0.5))
  gbuf.metal[idx] = clamp01(mat.metallic ?? 0)
  // fog factor matches shading.applyFog so the screen-space passes attenuate the
  // indirect terms by the same amount the beauty pass already did
  let f = 0
  if (shade.fogDensity > 0) {
    const dist = length(sub(world, shade.eye))
    f = clamp01(1 - Math.exp(-dist * shade.fogDensity))
  }
  gbuf.fog[idx] = f
  gbuf.mask[idx] = 1
}

// Map the overdraw counters to a heatmap after all triangles are drawn.
export function presentOverdraw(fb: Framebuffer): void {
  const { color, overdraw } = fb
  for (let i = 0; i < color.length; i++) {
    const n = overdraw[i]
    if (n === 0) continue
    const t = Math.min(1, Math.log2(n + 1) / 4) // 0..1 over ~16 layers
    const f = t * (HEAT.length - 1)
    const lo = Math.floor(f)
    const hi = Math.min(HEAT.length - 1, lo + 1)
    const k = f - lo
    const c0 = HEAT[lo], c1 = HEAT[hi]
    color[i] = Framebuffer.pack(
      c0[0] + (c1[0] - c0[0]) * k,
      c0[1] + (c1[1] - c0[1]) * k,
      c0[2] + (c1[2] - c0[2]) * k,
    )
  }
}

// Bresenham line for wireframe overlays.
export function drawLine(fb: Framebuffer, x0: number, y0: number, x1: number, y1: number, packed: number): void {
  const { width: W, height: H, color } = fb
  let xa = Math.round(x0), ya = Math.round(y0)
  const xb = Math.round(x1), yb = Math.round(y1)
  const dx = Math.abs(xb - xa), dy = -Math.abs(yb - ya)
  const sx = xa < xb ? 1 : -1, sy = ya < yb ? 1 : -1
  let err = dx + dy
  for (;;) {
    if (xa >= 0 && xa < W && ya >= 0 && ya < H) color[ya * W + xa] = packed
    if (xa === xb && ya === yb) break
    const e2 = 2 * err
    if (e2 >= dy) { err += dy; xa += sx }
    if (e2 <= dx) { err += dx; ya += sy }
  }
}

export const screenOf = (v: PipeVertex, w: number, h: number): Vec2 => {
  const iw = 1 / v.clip[3]
  return [(v.clip[0] * iw * 0.5 + 0.5) * w, (1 - (v.clip[1] * iw * 0.5 + 0.5)) * h]
}
