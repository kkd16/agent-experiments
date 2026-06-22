// Real-time transparency for the rasterizer — the deferred path's answer to the path
// tracer's dielectric glass. Two ideas combine here, both hand-written into the same
// Uint32 framebuffer:
//
//   • Weighted-Blended Order-Independent Transparency (McGuire & Bavoil, JCGT 2013).
//     Sorting transparent triangles back-to-front is the classic correctness headache
//     (and impossible when they interpenetrate). WBOIT sidesteps it: every glass
//     fragment's *own* colour (its Fresnel environment reflection) is accumulated,
//     premultiplied and weighted by a depth heuristic, into one buffer while the
//     transmittance Π(1−αᵢ) accumulates into a second — both commutative, so the
//     result is independent of draw order. One resolve divides and composites.
//
//   • Screen-space refraction. WBOIT blends each layer's colour *over* the background;
//     to make the background actually bend through the glass we record the nearest
//     glass fragment's view-space normal and, at composite time, sample the resolved
//     opaque image at an offset along it — tinting by Beer–Lambert through the body.
//
// It runs entirely *after* the opaque deferred resolve, reading the finished colour +
// depth buffers and compositing on top, so it can never perturb the opaque pipeline.
import type { Mat4 } from '../math/mat4.ts'
import { multiply, normalMatrix, transformMat3, transformPoint, transformVec4 } from '../math/mat4.ts'
import { normalize } from '../math/vec.ts'
import type { Vec3 } from '../math/vec.ts'
import { clamp01 } from '../math/scalar.ts'
import { clipNear } from './clip.ts'
import { Framebuffer } from './framebuffer.ts'
import type { Mesh } from '../geometry/mesh.ts'
import type { Material } from './shading.ts'
import type { Environment } from './environment.ts'
import { fresnelDielectric, reflect } from '../raytrace/dielectric.ts'
import type { PipeVertex } from './types.ts'

export interface TransparencySettings {
  enabled: boolean // composite transmissive objects with WBOIT + screen-space refraction
  refraction: number // screen-space refraction strength (pixels of background offset)
  thickness: number // assumed glass thickness (world units) for Beer–Lambert tinting
}

export const DEFAULT_TRANSPARENCY: TransparencySettings = {
  enabled: true,
  refraction: 28,
  thickness: 1.1,
}

// The WBOIT depth weight (a function of depth + alpha only — never draw order — which
// is exactly what makes the blend order-independent). Nearer, more opaque fragments
// dominate; the form is the bounded heuristic from the paper, in our ndc depth range.
export function oitWeight(ndcZ: number, alpha: number): number {
  const d = clamp01(ndcZ * 0.5 + 0.5) // 0 (near) .. 1 (far)
  const w = 10 / (1e-5 + d * d * d + 0.1)
  return alpha * Math.min(30, Math.max(0.02, w))
}

// The WBOIT resolve for one pixel: blend the order-independent average transparent
// colour `avg` over a background by the transmittance `reveal` = Π(1−αᵢ). Exported so
// the self-test can prove the compositing identities against this exact code.
export function blendWBOIT(
  avgR: number, avgG: number, avgB: number, reveal: number,
  bgR: number, bgG: number, bgB: number, out: number[],
): void {
  const cov = 1 - reveal
  out[0] = avgR * cov + bgR * reveal
  out[1] = avgG * cov + bgG * reveal
  out[2] = avgB * cov + bgB * reveal
}

// LDR-tone-map a linear HDR colour the same gentle way the composite works in 0..1
// (Reinhard + gamma) so the glass's reflection sits in the resolved colour space.
function tonemapGamma(r: number, g: number, b: number, out: number[]): void {
  out[0] = Math.pow(clamp01(r / (1 + r)), 1 / 2.2)
  out[1] = Math.pow(clamp01(g / (1 + g)), 1 / 2.2)
  out[2] = Math.pow(clamp01(b / (1 + b)), 1 / 2.2)
}

const tmpRefl = new Float64Array(3)
const tmpEnv: number[] = [0, 0, 0]
const tmpOut: number[] = [0, 0, 0]

export class Transparency {
  private W = 0
  private H = 0
  // WBOIT: Σ(Cᵢ·αᵢ·wᵢ) and Σ(αᵢ·wᵢ), plus the multiplicative revealage Π(1−αᵢ)
  private accum = new Float32Array(0)
  private accumA = new Float32Array(0)
  private reveal = new Float32Array(0)
  private covered = new Uint8Array(0)
  // screen-space refraction: the nearest glass fragment's offset + Beer tint + its depth
  private offX = new Float32Array(0)
  private offY = new Float32Array(0)
  private tint = new Float32Array(0)
  private frontZ = new Float32Array(0)

  private ensure(w: number, h: number): void {
    if (this.W === w && this.H === h) return
    this.W = w; this.H = h
    const n = w * h
    this.accum = new Float32Array(n * 3)
    this.accumA = new Float32Array(n)
    this.reveal = new Float32Array(n)
    this.covered = new Uint8Array(n)
    this.offX = new Float32Array(n)
    this.offY = new Float32Array(n)
    this.tint = new Float32Array(n * 3)
    this.frontZ = new Float32Array(n)
  }

  // Clear the accumulation buffers for a fresh frame.
  begin(w: number, h: number): void {
    this.ensure(w, h)
    this.accum.fill(0)
    this.accumA.fill(0)
    this.reveal.fill(1)
    this.covered.fill(0)
    this.tint.fill(1)
    this.frontZ.fill(Infinity)
  }

  // Accumulate one glass fragment. `ndcZ` is its depth, already known to pass the
  // opaque depth test. Cr/Cg/Cb is the glass's own (reflection) colour in 0..1, alpha
  // its Fresnel opacity, (ox,oy) the screen-space refraction offset and tr/tg/tb the
  // Beer–Lambert transmittance for the body at this pixel.
  private accumulate(
    idx: number, ndcZ: number, alpha: number,
    cr: number, cg: number, cb: number,
    ox: number, oy: number, tr: number, tg: number, tb: number,
  ): void {
    const w = oitWeight(ndcZ, alpha)
    const o = idx * 3
    this.accum[o] += cr * alpha * w
    this.accum[o + 1] += cg * alpha * w
    this.accum[o + 2] += cb * alpha * w
    this.accumA[idx] += alpha * w
    this.reveal[idx] *= (1 - alpha)
    this.covered[idx] = 1
    if (ndcZ < this.frontZ[idx]) {
      this.frontZ[idx] = ndcZ
      this.offX[idx] = ox; this.offY[idx] = oy
      this.tint[o] = tr; this.tint[o + 1] = tg; this.tint[o + 2] = tb
    }
  }

  // Vertex-stage + near-clip + scan-convert one transmissive mesh into the buffers.
  drawObject(
    fb: Framebuffer, view: Mat4, proj: Mat4, mesh: Mesh, model: Mat4,
    material: Material, env: Environment | null, eye: Vec3, settings: TransparencySettings,
  ): void {
    const mvp = multiply(proj, multiply(view, model))
    const nrm = normalMatrix(model)
    const verts = mesh.vertices
    const idxs = mesh.indices
    const clip = new Array<PipeVertex>(verts.length)
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i]
      clip[i] = {
        clip: transformVec4(mvp, [v.position[0], v.position[1], v.position[2], 1]),
        world: transformPoint(model, v.position),
        normal: normalize(transformMat3(nrm, v.normal)),
        tangent: [1, 0, 0, 1],
        uv: v.uv,
      }
    }
    for (let t = 0; t < idxs.length; t += 3) {
      const tri = [clip[idxs[t]], clip[idxs[t + 1]], clip[idxs[t + 2]]]
      const clipped = clipNear(tri)
      for (let f = 1; f < clipped.length - 1; f++) {
        this.rasterize(fb, view, [clipped[0], clipped[f], clipped[f + 1]], material, env, eye, settings)
      }
    }
  }

  // Edge-function scan conversion of a single clipped glass triangle. Mirrors the
  // opaque rasterizer's perspective-correct interpolation, but the depth test reads
  // the opaque z-buffer *without writing it*, and each fragment is accumulated.
  private rasterize(
    fb: Framebuffer, view: Mat4, tri: [PipeVertex, PipeVertex, PipeVertex],
    material: Material, env: Environment | null, eye: Vec3, settings: TransparencySettings,
  ): void {
    const W = this.W, H = this.H
    const depth = fb.depth
    const ior = material.ior ?? 1.5
    const att = material.attenuation ?? [0, 0, 0]
    const thick = settings.thickness
    const tintR = Math.exp(-att[0] * thick), tintG = Math.exp(-att[1] * thick), tintB = Math.exp(-att[2] * thick)

    const proj = (v: PipeVertex): { x: number; y: number; z: number; iw: number; wx: number; wy: number; wz: number; nx: number; ny: number; nz: number } => {
      const iw = 1 / v.clip[3]
      return {
        x: (v.clip[0] * iw * 0.5 + 0.5) * W,
        y: (1 - (v.clip[1] * iw * 0.5 + 0.5)) * H,
        z: v.clip[2] * iw, iw,
        wx: v.world[0], wy: v.world[1], wz: v.world[2],
        nx: v.normal[0], ny: v.normal[1], nz: v.normal[2],
      }
    }
    const a = proj(tri[0]), b = proj(tri[1]), c = proj(tri[2])
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
    if (area === 0) return
    const invArea = 1 / area
    const sign = area > 0 ? 1 : -1

    const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)))
    const maxX = Math.min(W - 1, Math.ceil(Math.max(a.x, b.x, c.x)))
    const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)))
    const maxY = Math.min(H - 1, Math.ceil(Math.max(a.y, b.y, c.y)))
    if (minX > maxX || minY > maxY) return

    const refrScale = settings.refraction * (ior - 1)

    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5
        const wA = (c.x - b.x) * (py - b.y) - (c.y - b.y) * (px - b.x)
        const wB = (a.x - c.x) * (py - c.y) - (a.y - c.y) * (px - c.x)
        const wC = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x)
        if (wA * sign < 0 || wB * sign < 0 || wC * sign < 0) continue
        const l0 = wA * invArea, l1 = wB * invArea, l2 = wC * invArea
        const idx = y * W + x
        const z = l0 * a.z + l1 * b.z + l2 * c.z
        if (z >= depth[idx]) continue // behind an opaque surface — hidden

        const iw = l0 * a.iw + l1 * b.iw + l2 * c.iw
        const inv = 1 / iw
        let nx = (l0 * a.nx * a.iw + l1 * b.nx * b.iw + l2 * c.nx * c.iw) * inv
        let ny = (l0 * a.ny * a.iw + l1 * b.ny * b.iw + l2 * c.ny * c.iw) * inv
        let nz = (l0 * a.nz * a.iw + l1 * b.nz * b.iw + l2 * c.nz * c.iw) * inv
        const nl = Math.hypot(nx, ny, nz) || 1
        nx /= nl; ny /= nl; nz /= nl
        const wx = (l0 * a.wx * a.iw + l1 * b.wx * b.iw + l2 * c.wx * c.iw) * inv
        const wy = (l0 * a.wy * a.iw + l1 * b.wy * b.iw + l2 * c.wy * c.iw) * inv
        const wz = (l0 * a.wz * a.iw + l1 * b.wz * b.iw + l2 * c.wz * c.iw) * inv
        // view direction, two-sided normal
        let vx = eye[0] - wx, vy = eye[1] - wy, vz = eye[2] - wz
        const vlen = Math.hypot(vx, vy, vz) || 1
        vx /= vlen; vy /= vlen; vz /= vlen
        if (nx * vx + ny * vy + nz * vz < 0) { nx = -nx; ny = -ny; nz = -nz }
        const NoV = clamp01(nx * vx + ny * vy + nz * vz)

        // Fresnel reflectance + the environment colour it reflects
        const F = fresnelDielectric(NoV, 1, ior)
        let cr = 0, cg = 0, cb = 0
        if (env) {
          reflect(-vx, -vy, -vz, nx, ny, nz, tmpRefl)
          const e = env.sky([tmpRefl[0], tmpRefl[1], tmpRefl[2]])
          tonemapGamma(e[0] * env.intensity, e[1] * env.intensity, e[2] * env.intensity, tmpEnv)
          cr = tmpEnv[0]; cg = tmpEnv[1]; cb = tmpEnv[2]
        }
        // screen-space refraction offset from the view-space normal (background bends
        // most where the glass faces away from the camera — its silhouette)
        const vnx = view[0] * nx + view[4] * ny + view[8] * nz
        const vny = view[1] * nx + view[5] * ny + view[9] * nz
        const ox = vnx * refrScale
        const oy = -vny * refrScale

        const alpha = clamp01(0.08 + 0.92 * F) // a little body even head-on, mirror at grazing
        this.accumulate(idx, z, alpha, cr, cg, cb, ox, oy, tintR, tintG, tintB)
      }
    }
  }

  // Composite the accumulated glass over the resolved opaque colour buffer in place:
  //   out = (Σ Cᵢαᵢwᵢ / Σ αᵢwᵢ)·(1−R) + refractedBackground·R
  // where R = Π(1−αᵢ) is the transmittance and the background is the opaque image
  // sampled at the nearest layer's refraction offset, tinted by Beer–Lambert.
  composite(fb: Framebuffer): void {
    const W = this.W, H = this.H
    const color = fb.color
    const accum = this.accum, accumA = this.accumA, reveal = this.reveal
    const covered = this.covered, offX = this.offX, offY = this.offY, tint = this.tint
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const idx = y * W + x
        if (!covered[idx]) continue
        const o = idx * 3
        const A = accumA[idx]
        const R = reveal[idx]
        // averaged glass reflection colour (premultiplied → divide by Σαw)
        const inv = A > 1e-6 ? 1 / A : 0
        const avgR = accum[o] * inv, avgG = accum[o + 1] * inv, avgB = accum[o + 2] * inv
        // refracted + tinted background
        const sxr = Math.min(W - 1, Math.max(0, (x + offX[idx]) | 0))
        const syr = Math.min(H - 1, Math.max(0, (y + offY[idx]) | 0))
        const bg = color[syr * W + sxr] >>> 0
        const br = (bg & 255) / 255, bgc = ((bg >> 8) & 255) / 255, bb = ((bg >> 16) & 255) / 255
        const tr = br * tint[o], tg = bgc * tint[o + 1], tb = bb * tint[o + 2]
        blendWBOIT(avgR, avgG, avgB, R, tr, tg, tb, tmpOut)
        color[idx] = Framebuffer.pack(tmpOut[0], tmpOut[1], tmpOut[2])
      }
    }
  }
}
