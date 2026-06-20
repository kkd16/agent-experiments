// Screen-space global illumination, resolved in the deferred G-buffer (gbuffer.ts).
// Three passes, all hand-written, all reading the same buffer the forward pass
// filled, all compositing back into the linear HDR buffer before tone mapping:
//
//   • SSAO   — view-space hemisphere-kernel ambient occlusion. Darkens the *diffuse
//              ambient* term in creases and contacts, like the path tracer's AO mode.
//   • SSR    — screen-space reflections. Marches the reflected view ray through the
//              depth buffer and *replaces the IBL probe* by the real on-screen
//              reflection where the ray hits, so surfaces reflect each other.
//   • Contact shadows — a short depth-march toward the key light that recovers the
//              fine contact occlusion the 1024² shadow map is too coarse to resolve.
//
// Everything works in linear light and is energy-aware: each pass modulates exactly
// the lighting term the beauty pass attributed to it (ambient / spec / direct), each
// attenuated by the stored per-pixel fog factor so the maths matches applyFog.
import type { Mat4 } from '../math/mat4.ts'
import type { Vec3 } from '../math/vec.ts'
import { clamp01 } from '../math/scalar.ts'
import type { Framebuffer } from './framebuffer.ts'
import { Framebuffer as FB } from './framebuffer.ts'
import type { GBuffer } from './gbuffer.ts'

export interface SSFXSettings {
  ssao: boolean
  ssaoRadius: number // world units the kernel reaches
  ssaoIntensity: number // occlusion strength
  ssaoPower: number // contrast exponent on the result
  ssr: boolean
  ssrMaxDist: number // world units the reflection ray travels
  ssrThickness: number // view-space depth thickness that still counts as a hit
  ssrRoughnessCutoff: number // surfaces rougher than this skip SSR
  contactShadows: boolean
  contactLength: number // world units the contact ray marches toward the light
  taa: boolean
}

export const DEFAULT_SSFX: SSFXSettings = {
  ssao: true,
  ssaoRadius: 0.55,
  ssaoIntensity: 1.3,
  ssaoPower: 1.6,
  ssr: true,
  ssrMaxDist: 8,
  ssrThickness: 0.4,
  ssrRoughnessCutoff: 0.5,
  contactShadows: true,
  contactLength: 0.35,
  taa: true,
}

const SSAO_SAMPLES = 14
const SSAO_STEPS = SSAO_SAMPLES
const SSR_STEPS = 28
const SSR_REFINE = 6
const NOISE_DIM = 4

// A tiny deterministic RNG so the kernel + noise are stable frame to frame (a
// changing kernel would itself look like noise after the blur).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface SSFXContext {
  view: Mat4
  proj: Mat4
  eye: Vec3
  lightDir: Vec3 | null // direction the key light travels (null = no contact shadows)
}

export class ScreenSpaceFX {
  private W = 0
  private H = 0
  private viewPos = new Float32Array(0) // camera-space position (z<0 in front)
  ao = new Float32Array(0) // 1 = open, 0 = fully occluded
  private aoTmp = new Float32Array(0)
  ssr = new Float32Array(0) // reflected *contribution* colour (already × reflectivity)
  ssrConf = new Float32Array(0) // hit confidence 0..1
  cs = new Float32Array(0) // contact-shadow visibility 1 = lit
  // hemisphere kernel (view-space offsets, unit-ish) + a 4×4 rotation-noise tile
  private kernel: Float32Array
  private noise: Float32Array

  constructor() {
    const rng = mulberry32(0x5eed)
    this.kernel = new Float32Array(SSAO_SAMPLES * 3)
    for (let i = 0; i < SSAO_SAMPLES; i++) {
      let x = rng() * 2 - 1
      let y = rng() * 2 - 1
      let z = rng() // upper hemisphere (tangent space +z)
      const l = Math.hypot(x, y, z) || 1
      x /= l; y /= l; z /= l
      // accelerate the distribution so more samples sit near the origin
      let s = i / SSAO_SAMPLES
      s = 0.1 + 0.9 * s * s
      const r = rng() // jitter the radius too
      this.kernel[i * 3] = x * s * (0.5 + 0.5 * r)
      this.kernel[i * 3 + 1] = y * s * (0.5 + 0.5 * r)
      this.kernel[i * 3 + 2] = z * s * (0.5 + 0.5 * r)
    }
    this.noise = new Float32Array(NOISE_DIM * NOISE_DIM * 2)
    for (let i = 0; i < NOISE_DIM * NOISE_DIM; i++) {
      this.noise[i * 2] = rng() * 2 - 1
      this.noise[i * 2 + 1] = rng() * 2 - 1
    }
  }

  private ensure(W: number, H: number): void {
    if (W === this.W && H === this.H) return
    this.W = W; this.H = H
    const n = W * H
    this.viewPos = new Float32Array(n * 3)
    this.ao = new Float32Array(n)
    this.aoTmp = new Float32Array(n)
    this.ssr = new Float32Array(n * 3)
    this.ssrConf = new Float32Array(n)
    this.cs = new Float32Array(n)
  }

  // Project a camera-space point to integer pixel coordinates; returns false when
  // it falls behind the eye or off-screen.
  private project(proj: Mat4, x: number, y: number, z: number, out: { sx: number; sy: number }): boolean {
    const cw = proj[3] * x + proj[7] * y + proj[11] * z + proj[15]
    if (cw <= 1e-6) return false
    const cx = proj[0] * x + proj[4] * y + proj[8] * z + proj[12]
    const cy = proj[1] * x + proj[5] * y + proj[9] * z + proj[13]
    const ndcX = cx / cw
    const ndcY = cy / cw
    const sx = (ndcX * 0.5 + 0.5) * this.W
    const sy = (1 - (ndcY * 0.5 + 0.5)) * this.H
    if (sx < 0 || sx >= this.W || sy < 0 || sy >= this.H) return false
    out.sx = sx | 0
    out.sy = sy | 0
    return true
  }

  // Cache each covered pixel's camera-space position — every pass needs depth in
  // view space, and SSAO needs the full position to offset the kernel.
  private buildViewPos(gbuf: GBuffer, view: Mat4): void {
    const { W, H } = this
    const { pos, mask } = gbuf
    const vp = this.viewPos
    for (let i = 0; i < W * H; i++) {
      if (!mask[i]) { vp[i * 3 + 2] = 1; continue } // +z marks "behind eye" = empty
      const wx = pos[i * 3], wy = pos[i * 3 + 1], wz = pos[i * 3 + 2]
      vp[i * 3] = view[0] * wx + view[4] * wy + view[8] * wz + view[12]
      vp[i * 3 + 1] = view[1] * wx + view[5] * wy + view[9] * wz + view[13]
      vp[i * 3 + 2] = view[2] * wx + view[6] * wy + view[10] * wz + view[14]
    }
  }

  // ── SSAO ────────────────────────────────────────────────────────────────────
  computeSSAO(gbuf: GBuffer, view: Mat4, proj: Mat4, s: SSFXSettings): void {
    const { W, H } = this
    const { normal, mask } = gbuf
    const vp = this.viewPos
    const ao = this.aoTmp
    const radius = s.ssaoRadius
    const bias = 0.02 + radius * 0.04
    const hit = { sx: 0, sy: 0 }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (!mask[i]) { ao[i] = 1; continue }
        const px = vp[i * 3], py = vp[i * 3 + 1], pz = vp[i * 3 + 2]
        // world normal → view space (rigid view: rotation block only)
        const nx = normal[i * 3], ny = normal[i * 3 + 1], nz = normal[i * 3 + 2]
        let vnx = view[0] * nx + view[4] * ny + view[8] * nz
        let vny = view[1] * nx + view[5] * ny + view[9] * nz
        let vnz = view[2] * nx + view[6] * ny + view[10] * nz
        const nl = Math.hypot(vnx, vny, vnz) || 1
        vnx /= nl; vny /= nl; vnz /= nl
        // random tangent (Gram–Schmidt against the normal) from the noise tile
        const ni = ((y % NOISE_DIM) * NOISE_DIM + (x % NOISE_DIM)) * 2
        const rx = this.noise[ni], ry = this.noise[ni + 1]
        let tx = rx - vnx * (rx * vnx + ry * vny)
        let ty = ry - vny * (rx * vnx + ry * vny)
        let tz = 0 - vnz * (rx * vnx + ry * vny)
        const tl = Math.hypot(tx, ty, tz) || 1
        tx /= tl; ty /= tl; tz /= tl
        // bitangent = n × t
        const bx = vny * tz - vnz * ty
        const by = vnz * tx - vnx * tz
        const bz = vnx * ty - vny * tx

        let occ = 0
        for (let k = 0; k < SSAO_STEPS; k++) {
          const kx = this.kernel[k * 3], ky = this.kernel[k * 3 + 1], kz = this.kernel[k * 3 + 2]
          // tangent→view space, then offset the fragment by radius
          const sxv = px + (tx * kx + bx * ky + vnx * kz) * radius
          const syv = py + (ty * kx + by * ky + vny * kz) * radius
          const szv = pz + (tz * kx + bz * ky + vnz * kz) * radius
          if (!this.project(proj, sxv, syv, szv, hit)) continue
          const j = hit.sy * W + hit.sx
          if (!mask[j]) continue
          const geomZ = vp[j * 3 + 2] // camera-space depth of the geometry there
          // occluded when the geometry sits closer to the camera than the sample
          if (geomZ >= szv + bias) {
            const range = radius / (Math.abs(pz - geomZ) + 1e-4)
            occ += range > 1 ? 1 : range * range
          }
        }
        let a = 1 - (occ / SSAO_STEPS) * s.ssaoIntensity
        a = Math.pow(clamp01(a), s.ssaoPower)
        ao[i] = a
      }
    }
    // depth-aware 4×4 box blur to dissolve the noise pattern
    const out = this.ao
    const R = NOISE_DIM >> 1
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (!mask[i]) { out[i] = 1; continue }
        const cz = vp[i * 3 + 2]
        let sum = 0, wsum = 0
        for (let dy = -R; dy <= R; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= H) continue
          for (let dx = -R; dx <= R; dx++) {
            const xx = x + dx
            if (xx < 0 || xx >= W) continue
            const j = yy * W + xx
            if (!mask[j]) continue
            // reject samples across a depth discontinuity (keeps AO off silhouettes)
            if (Math.abs(vp[j * 3 + 2] - cz) > radius) continue
            sum += ao[j]; wsum++
          }
        }
        out[i] = wsum > 0 ? sum / wsum : ao[i]
      }
    }
  }

  // ── Screen-space reflections ──────────────────────────────────────────────────
  computeSSR(gbuf: GBuffer, fb: Framebuffer, view: Mat4, proj: Mat4, eye: Vec3, s: SSFXSettings): void {
    const { W, H } = this
    const { pos, normal, albedo, rough, metal, mask } = gbuf
    const vp = this.viewPos
    const hdr = fb.hdr
    const out = this.ssr
    const conf = this.ssrConf
    const cutoff = s.ssrRoughnessCutoff
    const maxDist = s.ssrMaxDist
    const thickness = s.ssrThickness
    const edgeFadePx = Math.max(4, Math.min(W, H) * 0.08)
    const hit = { sx: 0, sy: 0 }

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        conf[i] = 0
        if (!mask[i]) continue
        const rg = rough[i]
        if (rg > cutoff) continue
        const mt = metal[i]

        const Px = pos[i * 3], Py = pos[i * 3 + 1], Pz = pos[i * 3 + 2]
        let Nx = normal[i * 3], Ny = normal[i * 3 + 1], Nz = normal[i * 3 + 2]
        // view dir (surface → eye)
        let Vx = eye[0] - Px, Vy = eye[1] - Py, Vz = eye[2] - Pz
        const vl = Math.hypot(Vx, Vy, Vz) || 1
        Vx /= vl; Vy /= vl; Vz /= vl
        const nv = Nx * Vx + Ny * Vy + Nz * Vz
        if (nv < 0) { Nx = -Nx; Ny = -Ny; Nz = -Nz }
        const nov = Math.max(1e-3, Nx * Vx + Ny * Vy + Nz * Vz)
        // reflect the incoming ray (-V) about N
        const idotn = -Vx * Nx - Vy * Ny - Vz * Nz
        const Rx = -Vx - 2 * idotn * Nx
        const Ry = -Vy - 2 * idotn * Ny
        const Rz = -Vz - 2 * idotn * Nz

        // reflectivity that produced the stored spec term (mirrors pbr.ts)
        const f0r = 0.04 + (albedo[i * 3] - 0.04) * mt
        const f0g = 0.04 + (albedo[i * 3 + 1] - 0.04) * mt
        const f0b = 0.04 + (albedo[i * 3 + 2] - 0.04) * mt
        const fr = Math.pow(clamp01(1 - nov), 5)
        const ksR = f0r + (Math.max(1 - rg, f0r) - f0r) * fr
        const ksG = f0g + (Math.max(1 - rg, f0g) - f0g) * fr
        const ksB = f0b + (Math.max(1 - rg, f0b) - f0b) * fr
        const ab = 1 - rg
        const wR = ksR * ab + 0.04 * (1 - ab)
        const wG = ksG * ab + 0.04 * (1 - ab)
        const wB = ksB * ab + 0.04 * (1 - ab)

        // march in world space, comparing the ray's view-space depth against the
        // stored geometry depth at each step's screen location
        const stepLen = maxDist / SSR_STEPS
        let tHit = -1
        let prevValid = false
        let prevT = 0
        for (let step = 1; step <= SSR_STEPS; step++) {
          const t = step * stepLen
          const wx = Px + Rx * t, wy = Py + Ry * t, wz = Pz + Rz * t
          const vx = view[0] * wx + view[4] * wy + view[8] * wz + view[12]
          const vy = view[1] * wx + view[5] * wy + view[9] * wz + view[13]
          const vz = view[2] * wx + view[6] * wy + view[10] * wz + view[14]
          if (!this.project(proj, vx, vy, vz, hit)) { break }
          const j = hit.sy * W + hit.sx
          if (!mask[j]) { prevValid = true; prevT = t; continue }
          const geomZ = vp[j * 3 + 2]
          // hit when the ray has gone *behind* the surface (more negative z) within
          // a thickness shell — and only after at least one in-front step
          if (vz < geomZ - 1e-4 && geomZ - vz < thickness) {
            tHit = prevValid ? this.refine(view, proj, Px, Py, Pz, Rx, Ry, Rz, prevT, t) : t
            break
          }
          prevValid = true; prevT = t
        }
        if (tHit < 0) continue

        const wx = Px + Rx * tHit, wy = Py + Ry * tHit, wz = Pz + Rz * tHit
        const vx = view[0] * wx + view[4] * wy + view[8] * wz + view[12]
        const vy = view[1] * wx + view[5] * wy + view[9] * wz + view[13]
        const vz = view[2] * wx + view[6] * wy + view[10] * wz + view[14]
        if (!this.project(proj, vx, vy, vz, hit)) continue
        const j = hit.sy * W + hit.sx
        if (!mask[j]) continue
        // fade near the screen edges and with march distance, and by glossiness
        const edge = Math.min(hit.sx, hit.sy, W - 1 - hit.sx, H - 1 - hit.sy)
        const edgeFade = clamp01(edge / edgeFadePx)
        const distFade = clamp01(1 - tHit / maxDist)
        const gloss = clamp01(1 - rg / cutoff)
        const c = edgeFade * distFade * gloss
        conf[i] = c
        out[i * 3] = hdr[j * 3] * wR
        out[i * 3 + 1] = hdr[j * 3 + 1] * wG
        out[i * 3 + 2] = hdr[j * 3 + 2] * wB
      }
    }
  }

  // Binary-search the exact crossing between an in-front step (t0) and a behind
  // step (t1) so reflections land on the right pixel instead of the step grid.
  private refine(
    view: Mat4, proj: Mat4,
    Px: number, Py: number, Pz: number, Rx: number, Ry: number, Rz: number,
    t0: number, t1: number,
  ): number {
    const hit = { sx: 0, sy: 0 }
    let lo = t0, hi = t1
    for (let k = 0; k < SSR_REFINE; k++) {
      const mid = (lo + hi) * 0.5
      const wx = Px + Rx * mid, wy = Py + Ry * mid, wz = Pz + Rz * mid
      const vx = view[0] * wx + view[4] * wy + view[8] * wz + view[12]
      const vy = view[1] * wx + view[5] * wy + view[9] * wz + view[13]
      const vz = view[2] * wx + view[6] * wy + view[10] * wz + view[14]
      if (!this.project(proj, vx, vy, vz, hit)) { hi = mid; continue }
      const j = hit.sy * this.W + hit.sx
      const geomZ = this.viewPos[j * 3 + 2]
      if (vz < geomZ - 1e-4) hi = mid // behind → pull back
      else lo = mid // in front → push forward
    }
    return (lo + hi) * 0.5
  }

  // ── Contact shadows ───────────────────────────────────────────────────────────
  computeContact(gbuf: GBuffer, view: Mat4, proj: Mat4, lightDir: Vec3, s: SSFXSettings): void {
    const { W, H } = this
    const { pos, normal, mask } = gbuf
    const vp = this.viewPos
    const cs = this.cs
    const STEPS = 12
    const len = s.contactLength
    // toward the light = opposite the direction it travels
    let Lx = -lightDir[0], Ly = -lightDir[1], Lz = -lightDir[2]
    const ll = Math.hypot(Lx, Ly, Lz) || 1
    Lx /= ll; Ly /= ll; Lz /= ll
    const hit = { sx: 0, sy: 0 }
    const bias = len * 0.08
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (!mask[i]) { cs[i] = 1; continue }
        const ndl = normal[i * 3] * Lx + normal[i * 3 + 1] * Ly + normal[i * 3 + 2] * Lz
        if (ndl <= 0.02) { cs[i] = 1; continue } // back-facing the light: shadow map owns it
        const Px = pos[i * 3], Py = pos[i * 3 + 1], Pz = pos[i * 3 + 2]
        let occluded = 0
        const step = len / STEPS
        for (let k = 1; k <= STEPS; k++) {
          const t = k * step
          const wx = Px + Lx * t, wy = Py + Ly * t, wz = Pz + Lz * t
          const vx = view[0] * wx + view[4] * wy + view[8] * wz + view[12]
          const vy = view[1] * wx + view[5] * wy + view[9] * wz + view[13]
          const vz = view[2] * wx + view[6] * wy + view[10] * wz + view[14]
          if (!this.project(proj, vx, vy, vz, hit)) break
          const j = hit.sy * W + hit.sx
          if (!mask[j]) continue
          const geomZ = vp[j * 3 + 2]
          if (geomZ > vz + bias) { occluded = 1; break } // something nearer blocks the light
        }
        cs[i] = occluded ? 0 : 1
      }
    }
  }

  // Composite every enabled pass into the linear HDR buffer (call before resolve).
  run(fb: Framebuffer, gbuf: GBuffer, ctx: SSFXContext, s: SSFXSettings, forceAO = false, forceSSR = false): void {
    this.ensure(fb.width, fb.height)
    this.buildViewPos(gbuf, ctx.view)
    const doAO = s.ssao || forceAO
    const doSSR = s.ssr || forceSSR
    if (doAO) this.computeSSAO(gbuf, ctx.view, ctx.proj, s)
    if (s.contactShadows && ctx.lightDir) this.computeContact(gbuf, ctx.view, ctx.proj, ctx.lightDir, s)
    if (doSSR) this.computeSSR(gbuf, fb, ctx.view, ctx.proj, ctx.eye, s)

    const { width: W, height: H } = fb
    const hdr = fb.hdr
    const { mask, ambient, direct, spec, fog } = gbuf
    for (let i = 0; i < W * H; i++) {
      if (!mask[i]) continue
      const keep = 1 - fog[i]
      const o = i * 3
      // SSAO: remove the occluded fraction of the diffuse ambient
      if (s.ssao) {
        const occ = (1 - this.ao[i]) * keep
        hdr[o] -= ambient[o] * occ
        hdr[o + 1] -= ambient[o + 1] * occ
        hdr[o + 2] -= ambient[o + 2] * occ
      }
      // Contact shadows: remove the occluded fraction of the direct light
      if (s.contactShadows && ctx.lightDir) {
        const occ = (1 - this.cs[i]) * keep
        if (occ > 0) {
          hdr[o] -= direct[o] * occ
          hdr[o + 1] -= direct[o + 1] * occ
          hdr[o + 2] -= direct[o + 2] * occ
        }
      }
      // SSR: replace the IBL probe term by the on-screen reflection, by confidence
      if (s.ssr) {
        const c = this.ssrConf[i] * keep
        if (c > 0) {
          hdr[o] += (this.ssr[o] - spec[o]) * c
          hdr[o + 1] += (this.ssr[o + 1] - spec[o + 1]) * c
          hdr[o + 2] += (this.ssr[o + 2] - spec[o + 2]) * c
        }
      }
      if (hdr[o] < 0) hdr[o] = 0
      if (hdr[o + 1] < 0) hdr[o + 1] = 0
      if (hdr[o + 2] < 0) hdr[o + 2] = 0
    }
  }

  // Pack a G-buffer / screen-space channel straight into the colour buffer for the
  // deferred debug views.
  presentChannel(fb: Framebuffer, gbuf: GBuffer, mode: 'position' | 'roughness' | 'ao' | 'reflections'): void {
    const { width: W, height: H, color } = fb
    const { pos, rough, mask } = gbuf
    for (let i = 0; i < W * H; i++) {
      if (!mask[i]) { color[i] = FB.pack(0.02, 0.02, 0.03); continue }
      if (mode === 'roughness') {
        const r = rough[i]
        color[i] = FB.pack(r, r, r)
      } else if (mode === 'ao') {
        const a = this.ao[i]
        color[i] = FB.pack(a, a, a)
      } else if (mode === 'reflections') {
        const c = this.ssrConf[i]
        color[i] = FB.pack(this.ssr[i * 3] * 2, this.ssr[i * 3 + 1] * 2, this.ssr[i * 3 + 2] * 2, 255)
        if (c <= 0) color[i] = FB.pack(0.03, 0.03, 0.04)
      } else {
        // position: wrap world coords into colour
        const wrap = (v: number): number => v - Math.floor(v)
        color[i] = FB.pack(wrap(pos[i * 3] * 0.25 + 0.5), wrap(pos[i * 3 + 1] * 0.25 + 0.5), wrap(pos[i * 3 + 2] * 0.25 + 0.5))
      }
    }
  }
}
