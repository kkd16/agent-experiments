// The progressive driver. It owns the BVH + a Float32 accumulation buffer and
// refines the image one budgeted slice of samples per frame, exactly like a
// viewport renderer: the buffer keeps integrating while the camera is still and
// resets the instant anything changes. Camera-ray jitter gives free anti-aliasing;
// the averaged radiance is tone-mapped through the shared HDR resolve so the path
// tracer and the rasterizer share bloom / ACES / vignette / FXAA.
import { Framebuffer } from '../render/framebuffer.ts'
import { resolveHDR } from '../render/post.ts'
import type { PostSettings } from '../render/post.ts'
import { RTScene } from './rtscene.ts'
import type { RTInstance } from './rtscene.ts'
import { BVH } from './bvh.ts'
import { tracePath, traceAO, primaryFeature } from './tracer.ts'
import type { RTContext, RTLighting, PrimaryFeature } from './tracer.ts'
import { traceSpectral, resetSpectralCaches } from './spectral.ts'
import { traceHero } from './hero.ts'
import { sampleWavelength } from './spectrum.ts'
import { Rng, hashSeed } from './sampling.ts'
import type { Vec3 } from '../math/vec.ts'
import { Denoiser } from './denoise.ts'
import type { DenoiseSettings } from './denoise.ts'
import { PhotonMap } from './photonmap.ts'
import type { CausticOptions, PhotonStats } from './photonmap.ts'
import type { Light } from '../render/shading.ts'

export interface RTCamera {
  ex: number; ey: number; ez: number // eye
  fx: number; fy: number; fz: number // forward
  rx: number; ry: number; rz: number // right
  ux: number; uy: number; uz: number // up
  tanHalf: number
  aspect: number
}

export type RTMode = 'path' | 'ao' | 'spectral' | 'hero'

// What the denoiser-aware resolve presents. 'denoised' is the beauty; the rest are
// debug views into the pipeline (the raw average, the feature buffers, the variance
// field), a side-by-side noisy↔denoised wipe, and the isolated caustic layer.
export type RTView = 'denoised' | 'noisy' | 'split' | 'albedo' | 'normal' | 'variance' | 'caustic'

// v12 — photon-mapped caustics config: the emitter/gather options plus an enable flag.
export interface CausticSettings extends CausticOptions {
  enabled: boolean
}

const MAX_SPP = 2048 // stop refining once every pixel has this many samples
// Above this sample count the raw average is already clean: skip the denoiser so a
// converged image stays the exact ground truth and interaction costs nothing. (With
// variance guidance the filter is near-identity here anyway — this just saves the work.)
const DENOISE_MAX_SPP = 512

export class RayTracer {
  W = 0
  H = 0
  private accum = new Float32Array(0)
  private accumSq = new Float32Array(0) // Σ luma² per pixel → Monte-Carlo variance
  private sampleCount = new Uint16Array(0)
  private out: Framebuffer | null = null
  private cursor = 0
  // denoiser + its inputs: the per-pixel mean/variance and the primary feature buffers
  private readonly denoiser = new Denoiser()
  private mean = new Float32Array(0) // resolved average radiance, rgb
  private varBuf = new Float32Array(0) // variance of the mean estimator, per pixel
  private lumaBuf = new Float32Array(0) // mean luminance, for the spatial-variance bootstrap
  private denoised = new Float32Array(0) // filtered beauty, rgb
  private featAlbedo = new Float32Array(0)
  private featNormal = new Float32Array(0)
  private featPos = new Float32Array(0)
  private featMask = new Uint8Array(0)
  private featRecv = new Uint8Array(0) // 1 where the primary hit is a diffuse caustic receiver
  private featuresDirty = true
  private denoiseSig = '' // cache key so the filter only re-runs when its input changes
  // v12 — photon-mapped caustics: the photon map (rebuilt only when scene/lights/opts change),
  // a per-pixel caustic radiance layer (gathered at the primary hit), and their cache keys.
  private readonly photonMap = new PhotonMap()
  private caustic = new Float32Array(0)
  private photonKey = '' // scene + lights + photon options → when to rebuild the map
  private causticGatherKey = '' // + camera/features → when to re-gather the layer
  private causticOn = false
  photonStats: PhotonStats | null = null
  passes = 0 // completed full passes since the last reset
  minSamples = 0 // the least-sampled pixel (drives "converged?" + the HUD)
  private scene: RTScene | null = null
  private bvh: BVH | null = null
  triangles = 0
  nodes = 0
  private geomKey = ''
  private resetKey = ''

  // (Re)build the BVH from the scene's triangle instances. `key` identifies the
  // geometry so we only pay the build when the scene actually changes.
  setGeometry(instances: RTInstance[], key: string): void {
    if (key === this.geomKey && this.scene) return
    this.geomKey = key
    this.scene = new RTScene(instances)
    resetSpectralCaches() // new materials → drop stale per-material spectra
    this.bvh = new BVH(this.scene)
    this.triangles = this.scene.count
    this.nodes = this.bvh.nodeTotal
    this.resetAccum()
  }

  // World-space AABB of the current scene geometry (for fitting a medium box), or null.
  sceneBounds(): { minx: number; miny: number; minz: number; maxx: number; maxy: number; maxz: number } | null {
    return this.bvh ? this.bvh.worldBounds() : null
  }

  private ensureBuffers(w: number, h: number): void {
    if (this.W === w && this.H === h && this.out) return
    this.W = w
    this.H = h
    const n3 = w * h * 3
    const n1 = w * h
    this.accum = new Float32Array(n3)
    this.accumSq = new Float32Array(n1)
    this.sampleCount = new Uint16Array(n1)
    this.mean = new Float32Array(n3)
    this.varBuf = new Float32Array(n1)
    this.lumaBuf = new Float32Array(n1)
    this.denoised = new Float32Array(n3)
    this.featAlbedo = new Float32Array(n3)
    this.featNormal = new Float32Array(n3)
    this.featPos = new Float32Array(n3)
    this.featMask = new Uint8Array(n1)
    this.featRecv = new Uint8Array(n1)
    this.caustic = new Float32Array(n3)
    this.out = new Framebuffer(w, h)
    this.resetAccum()
  }

  resetAccum(): void {
    this.accum.fill(0)
    this.accumSq.fill(0)
    this.sampleCount.fill(0)
    this.cursor = 0
    this.passes = 0
    this.minSamples = 0
    this.featuresDirty = true
    this.denoiseSig = ''
    this.causticGatherKey = '' // features changed → re-gather the caustic layer
  }

  // Refine the image for up to `budgetMs`, then tone-map it. The accumulation
  // resets whenever `resetKey` (camera + tracer settings) changes.
  step(
    cam: RTCamera, light: RTLighting, mode: RTMode, post: PostSettings,
    w: number, h: number, budgetMs: number, resetKey: string,
    den: DenoiseSettings, view: RTView, splitPos: number,
    caustics: CausticSettings | null, geomKey: string,
  ): void {
    this.ensureBuffers(w, h)
    if (resetKey !== this.resetKey) {
      this.resetKey = resetKey
      this.resetAccum()
    }
    const bvh = this.bvh
    const scene = this.scene
    if (!bvh || !scene || scene.count === 0) {
      // nothing to trace — just clear the output to the sky so the view isn't black
      this.resolveSky(cam, light, post)
      return
    }
    const ctx: RTContext = { scene, bvh, ...light }
    // Fill the primary feature buffers (albedo/normal/position/mask) once per reset —
    // they are a pure function of the camera + geometry, which the reset key tracks.
    if (this.featuresDirty) {
      this.computeFeatures(cam, ctx)
      this.featuresDirty = false
    }
    // v12 — the photon-mapped caustic layer. The map depends only on geometry + lights +
    // options (not the camera), so orbiting reuses it and only re-gathers; the gather depends
    // on the camera through the feature buffers. Both are cached by their own keys.
    this.updateCaustics(caustics, light.lights, geomKey)
    if (this.minSamples >= MAX_SPP) {
      this.resolve(post, mode, den, view, splitPos)
      return
    }

    const W = this.W, H = this.H
    const total = W * H
    const accum = this.accum
    const counts = this.sampleCount
    const start = performance.now()
    // Always finish the very first full pass before showing anything (no black
    // holes); after that, respect the per-frame time budget.
    const firstPass = this.passes === 0
    let traced = 0
    while (traced < total * 8) {
      const p = this.cursor
      const x = p % W
      const y = (p / W) | 0
      const rng = new Rng(hashSeed(x, y, counts[p] + 1))
      // jitter inside the pixel for anti-aliasing
      const ndcX = (2 * (x + rng.next())) / W - 1
      const ndcY = 1 - (2 * (y + rng.next())) / H
      const sx = ndcX * cam.aspect * cam.tanHalf
      const sy = ndcY * cam.tanHalf
      let dx = cam.fx + cam.rx * sx + cam.ux * sy
      let dy = cam.fy + cam.ry * sx + cam.uy * sy
      let dz = cam.fz + cam.rz * sx + cam.uz * sy
      const dl = Math.hypot(dx, dy, dz) || 1
      dx /= dl; dy /= dl; dz /= dl
      let c: Vec3
      if (mode === 'spectral') {
        // Stratify the hero wavelength across this pixel's samples with a golden-ratio
        // (Kronecker) sequence offset by a per-pixel hash, so successive samples sweep the
        // spectrum evenly and colour converges fast despite one wavelength per ray.
        const off = (hashSeed(x, y, 0) >>> 8) / 0x01000000
        let uL = counts[p] * 0.6180339887498949 + off
        uL -= Math.floor(uL)
        const ws = sampleWavelength(uL)
        c = traceSpectral(cam.ex, cam.ey, cam.ez, dx, dy, dz, ctx, rng, ws.lambda, ws.pdf)
      } else if (mode === 'hero') {
        // Same stratified hero seed as the single-wavelength path, but `traceHero` fans it into
        // a whole tuple of wavelengths carried down one shared path (hero-wavelength sampling).
        const off = (hashSeed(x, y, 0) >>> 8) / 0x01000000
        let uL = counts[p] * 0.6180339887498949 + off
        uL -= Math.floor(uL)
        c = traceHero(cam.ex, cam.ey, cam.ez, dx, dy, dz, ctx, rng, uL, ctx.heroCount ?? 4)
      } else if (mode === 'ao') {
        c = traceAO(cam.ex, cam.ey, cam.ez, dx, dy, dz, ctx, rng)
      } else {
        c = tracePath(cam.ex, cam.ey, cam.ez, dx, dy, dz, ctx, rng)
      }
      const o = p * 3
      // guard against the rare NaN/Inf so one bad sample can't poison a pixel
      if (c[0] === c[0] && c[1] === c[1] && c[2] === c[2]) {
        accum[o] += c[0]; accum[o + 1] += c[1]; accum[o + 2] += c[2]
        // second moment of luminance → per-pixel Monte-Carlo variance for the denoiser
        const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
        this.accumSq[p] += L * L
        if (counts[p] < 0xffff) counts[p]++
      }
      this.cursor++
      traced++
      if (this.cursor >= total) {
        this.cursor = 0
        this.passes++
        this.minSamples = this.passes
        if (firstPass) break // first complete pass done
      }
      if (!firstPass && (traced & 1023) === 0 && performance.now() - start > budgetMs) break
    }
    this.resolve(post, mode, den, view, splitPos)
  }

  // Estimate per-pixel luminance variance from a 5×5 normal-gated spatial window —
  // SVGF's fallback for pixels with fewer than 4 samples (where temporal variance is
  // unavailable). Only touches low-sample surface pixels; converged pixels keep their
  // (more accurate) temporal estimate.
  private spatialVarianceBootstrap(): void {
    const W = this.W, H = this.H
    const luma = this.lumaBuf, mask = this.featMask, normal = this.featNormal
    const counts = this.sampleCount, varBuf = this.varBuf
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const p = y * W + x
        if (!mask[p] || counts[p] >= 4) continue
        const po = p * 3
        const nx = normal[po], ny = normal[po + 1], nz = normal[po + 2]
        let w = 0, ms = 0, m2 = 0
        for (let oy = -2; oy <= 2; oy++) {
          const yy = y + oy
          if (yy < 0 || yy >= H) continue
          for (let ox = -2; ox <= 2; ox++) {
            const xx = x + ox
            if (xx < 0 || xx >= W) continue
            const q = yy * W + xx
            if (!mask[q]) continue
            const qo = q * 3
            const dn = nx * normal[qo] + ny * normal[qo + 1] + nz * normal[qo + 2]
            if (dn < 0.8) continue // gate to the same surface so real edges don't inflate it
            const l = luma[q]
            w += 1; ms += l; m2 += l * l
          }
        }
        if (w > 1) {
          const mean = ms / w
          let v = m2 / w - mean * mean
          if (v < 0) v = 0
          varBuf[p] = v
        }
      }
    }
  }

  // Trace one shading-free primary ray per pixel and store the surface it hits into
  // the feature buffers the denoiser's edge-stopping functions read. Background rays
  // get mask=0 (and a neutral albedo so the demodulate divide is well-defined).
  private computeFeatures(cam: RTCamera, ctx: RTContext): void {
    const W = this.W, H = this.H
    const feat: PrimaryFeature = { hit: false, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0, ar: 1, ag: 1, ab: 1, receiver: false }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ndcX = (2 * (x + 0.5)) / W - 1
        const ndcY = 1 - (2 * (y + 0.5)) / H
        const sx = ndcX * cam.aspect * cam.tanHalf
        const sy = ndcY * cam.tanHalf
        let dx = cam.fx + cam.rx * sx + cam.ux * sy
        let dy = cam.fy + cam.ry * sx + cam.uy * sy
        let dz = cam.fz + cam.rz * sx + cam.uz * sy
        const dl = Math.hypot(dx, dy, dz) || 1
        dx /= dl; dy /= dl; dz /= dl
        primaryFeature(cam.ex, cam.ey, cam.ez, dx, dy, dz, ctx, feat)
        const p = y * W + x
        const o = p * 3
        if (feat.hit) {
          this.featMask[p] = 1
          this.featRecv[p] = feat.receiver ? 1 : 0
          this.featPos[o] = feat.px; this.featPos[o + 1] = feat.py; this.featPos[o + 2] = feat.pz
          this.featNormal[o] = feat.nx; this.featNormal[o + 1] = feat.ny; this.featNormal[o + 2] = feat.nz
          this.featAlbedo[o] = feat.ar; this.featAlbedo[o + 1] = feat.ag; this.featAlbedo[o + 2] = feat.ab
        } else {
          this.featMask[p] = 0
          this.featRecv[p] = 0
          this.featPos[o] = 0; this.featPos[o + 1] = 0; this.featPos[o + 2] = 0
          this.featNormal[o] = 0; this.featNormal[o + 1] = 0; this.featNormal[o + 2] = 0
          this.featAlbedo[o] = 1; this.featAlbedo[o + 1] = 1; this.featAlbedo[o + 2] = 1
        }
      }
    }
  }

  // Build the photon-mapped caustic layer. The photon map is a function of geometry +
  // lights + options only, so it is rebuilt on `photonKey` (no camera) and reused while the
  // camera orbits; the per-pixel gather additionally depends on the camera through the
  // feature buffers, so it re-runs on `causticGatherKey` (which folds in the reset key).
  private updateCaustics(caustics: CausticSettings | null, lights: Light[], geomKey: string): void {
    this.causticOn = !!caustics && caustics.enabled
    if (!this.causticOn || !this.scene || !this.bvh) {
      if (!this.causticOn) { this.photonKey = ''; this.photonStats = null }
      return
    }
    const c = caustics as CausticSettings
    // a compact, stable signature of the lights that cast caustics
    let lightSig = ''
    for (const l of lights) {
      lightSig += l.type === 'dir'
        ? `d${l.direction.map((x) => x.toFixed(2)).join(',')}`
        : `p${l.position.map((x) => x.toFixed(2)).join(',')}`
      lightSig += `:${l.color.map((x) => x.toFixed(2)).join(',')}:${l.intensity.toFixed(2)};`
    }
    // intensity is only a gather multiplier, not a photon-position input — keep it out of the
    // build key (it lives in the gather key below) so dragging it never rebuilds the map.
    const optKey = `${c.photons}|${c.radius}|${c.kernel}|${c.spectral ? 1 : 0}|${c.maxBounces}|${c.mirror ? 1 : 0}`
    const photonKey = `${geomKey}||${lightSig}||${optKey}`
    if (photonKey !== this.photonKey) {
      this.photonMap.build(this.scene, this.bvh, lights, c)
      this.photonStats = this.photonMap.stats
      this.photonKey = photonKey
      this.causticGatherKey = '' // a fresh map forces a re-gather
    }
    // re-gather when the map or the camera/features changed (resetAccum clears the key)
    const gatherKey = `${photonKey}||${this.resetKey}||${this.W}x${this.H}||${c.intensity}`
    if (gatherKey === this.causticGatherKey) return
    this.causticGatherKey = gatherKey
    this.gatherCaustics()
  }

  // Gather the caustic irradiance at each visible receiver point (the primary hit the
  // feature pass recorded) and write the outgoing radiance into `this.caustic`.
  private gatherCaustics(): void {
    const n = this.W * this.H
    const out = new Float64Array(3)
    if (!this.photonMap.hasPhotons()) { this.caustic.fill(0); return }
    for (let p = 0; p < n; p++) {
      const o = p * 3
      if (!this.featMask[p] || !this.featRecv[p]) {
        this.caustic[o] = 0; this.caustic[o + 1] = 0; this.caustic[o + 2] = 0
        continue
      }
      this.photonMap.estimate(
        this.featPos[o], this.featPos[o + 1], this.featPos[o + 2],
        this.featNormal[o], this.featNormal[o + 1], this.featNormal[o + 2],
        this.featAlbedo[o], this.featAlbedo[o + 1], this.featAlbedo[o + 2],
        out,
      )
      this.caustic[o] = out[0]; this.caustic[o + 1] = out[1]; this.caustic[o + 2] = out[2]
    }
  }

  // Average the accumulation buffer into `mean` + estimate the per-pixel variance,
  // optionally denoise, then write the requested view into the HDR buffer and tone-map.
  private resolve(post: PostSettings, mode: RTMode, den: DenoiseSettings, view: RTView, splitPos: number): void {
    const out = this.out
    if (!out) return
    const accum = this.accum, accumSq = this.accumSq, counts = this.sampleCount
    const mean = this.mean, varBuf = this.varBuf
    const n = this.W * this.H
    for (let p = 0; p < n; p++) {
      const c = counts[p]
      const o = p * 3
      if (c > 0) {
        const inv = 1 / c
        const mr = accum[o] * inv, mg = accum[o + 1] * inv, mb = accum[o + 2] * inv
        mean[o] = mr; mean[o + 1] = mg; mean[o + 2] = mb
        // sample variance of luminance, then variance of the mean estimator (÷ n)
        const Lmean = 0.2126 * mr + 0.7152 * mg + 0.0722 * mb
        this.lumaBuf[p] = Lmean
        const E2 = accumSq[p] * inv
        let vs = E2 - Lmean * Lmean
        if (vs < 0) vs = 0
        varBuf[p] = vs * inv
      } else {
        mean[o] = 0; mean[o + 1] = 0; mean[o + 2] = 0
        this.lumaBuf[p] = 0
        varBuf[p] = 0
      }
    }
    // SVGF spatial-variance bootstrap: with too few samples the temporal variance is
    // ~0 (one sample has no spread), so estimate it from a small normal-gated spatial
    // neighbourhood instead — this is what lets the filter clean up the very first
    // frames (1–4 spp), exactly when the path tracer is noisiest.
    if (this.minSamples < 4) this.spatialVarianceBootstrap()

    // Demodulation only makes sense for the radiance estimate (path), not the AO field.
    const demod = den.demodulate && mode === 'path'
    let beauty = mean
    if (den.enabled && this.minSamples <= DENOISE_MAX_SPP) {
      const sig = [
        this.passes, den.iterations, den.sigmaColor, den.sigmaNormal, den.sigmaPos,
        demod ? 1 : 0, den.varianceGuided ? 1 : 0,
      ].join('|')
      if (sig !== this.denoiseSig) {
        this.denoiser.run({
          W: this.W, H: this.H, color: mean, variance: varBuf,
          albedo: this.featAlbedo, pos: this.featPos, normal: this.featNormal, mask: this.featMask,
          out: this.denoised,
          settings: { ...den, demodulate: demod },
        })
        this.denoiseSig = sig
      }
      beauty = this.denoised
    }

    this.writeView(out.hdr, mean, beauty, view, splitPos)
    resolveHDR(out, post)
  }

  // Compose the HDR buffer for the selected view: the denoised beauty, the raw
  // average, the feature buffers, the variance field, or a noisy↔denoised wipe.
  private writeView(hdr: Float32Array, mean: Float32Array, beauty: Float32Array, view: RTView, splitPos: number): void {
    const W = this.W, H = this.H, n = W * H
    if (view === 'albedo') {
      hdr.set(this.featAlbedo.subarray(0, n * 3))
      return
    }
    // the isolated caustic layer, on black — what the photon map alone contributes
    if (view === 'caustic') {
      const cst = this.caustic
      if (this.causticOn) hdr.set(cst.subarray(0, n * 3))
      else hdr.fill(0, 0, n * 3)
      return
    }
    if (view === 'normal') {
      for (let p = 0; p < n; p++) {
        const o = p * 3
        hdr[o] = this.featNormal[o] * 0.5 + 0.5
        hdr[o + 1] = this.featNormal[o + 1] * 0.5 + 0.5
        hdr[o + 2] = this.featNormal[o + 2] * 0.5 + 0.5
      }
      return
    }
    if (view === 'variance') {
      // self-scaling heat: √(var) normalised by the field's max, blue→red.
      let mx = 0
      for (let p = 0; p < n; p++) if (this.varBuf[p] > mx) mx = this.varBuf[p]
      const inv = mx > 0 ? 1 / mx : 0
      for (let p = 0; p < n; p++) {
        const t = Math.sqrt(this.varBuf[p] * inv)
        const o = p * 3
        hdr[o] = t * t // red rises fastest
        hdr[o + 1] = t * (1 - t) * 2
        hdr[o + 2] = (1 - t) * (1 - t)
      }
      return
    }
    // the caustic layer is added in linear HDR on top of the (denoised) beauty, so the
    // low-noise photon contribution is never smeared by the denoiser.
    const cOn = this.causticOn
    const cst = this.caustic
    if (view === 'split') {
      const splitX = Math.round(Math.min(0.95, Math.max(0.05, splitPos)) * W)
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const p = y * W + x
          const o = p * 3
          const src = x < splitX ? mean : beauty
          if (cOn) {
            hdr[o] = src[o] + cst[o]; hdr[o + 1] = src[o + 1] + cst[o + 1]; hdr[o + 2] = src[o + 2] + cst[o + 2]
          } else {
            hdr[o] = src[o]; hdr[o + 1] = src[o + 1]; hdr[o + 2] = src[o + 2]
          }
        }
      }
      return
    }
    const src = view === 'noisy' ? mean : beauty
    if (cOn) {
      for (let i = 0; i < n * 3; i++) hdr[i] = src[i] + cst[i]
    } else {
      hdr.set(src.subarray(0, n * 3))
    }
  }

  // Used when there is no geometry: paint the sky so the viewport isn't blank.
  private resolveSky(cam: RTCamera, light: RTLighting, post: PostSettings): void {
    const out = this.out
    if (!out) return
    const hdr = out.hdr
    const W = this.W, H = this.H
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const ndcX = (2 * (x + 0.5)) / W - 1
        const ndcY = 1 - (2 * (y + 0.5)) / H
        const sx = ndcX * cam.aspect * cam.tanHalf
        const sy = ndcY * cam.tanHalf
        let dx = cam.fx + cam.rx * sx + cam.ux * sy
        let dy = cam.fy + cam.ry * sx + cam.uy * sy
        let dz = cam.fz + cam.rz * sx + cam.uz * sy
        const dl = Math.hypot(dx, dy, dz) || 1
        dx /= dl; dy /= dl; dz /= dl
        const c = light.sky(dx, dy, dz)
        const o = (y * W + x) * 3
        hdr[o] = c[0]; hdr[o + 1] = c[1]; hdr[o + 2] = c[2]
      }
    }
    resolveHDR(out, post)
  }

  // Blit the (possibly lower-res) RT output into a region of the destination
  // colour buffer with nearest-neighbour upscaling. x0..x1 are destination columns.
  blit(dst: Uint32Array, dstW: number, dstH: number, x0: number, x1: number): void {
    const out = this.out
    if (!out) return
    const src = out.color
    const W = this.W, H = this.H
    const sxScale = W / dstW
    const syScale = H / dstH
    const lo = Math.max(0, x0 | 0)
    const hi = Math.min(dstW, x1 | 0)
    for (let y = 0; y < dstH; y++) {
      const sy = Math.min(H - 1, (y * syScale) | 0)
      const srow = sy * W
      const drow = y * dstW
      for (let x = lo; x < hi; x++) {
        const sx = Math.min(W - 1, (x * sxScale) | 0)
        dst[drow + x] = src[srow + sx]
      }
    }
  }
}
