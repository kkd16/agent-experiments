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
import { Rng, hashSeed } from './sampling.ts'
import { Denoiser } from './denoise.ts'
import type { DenoiseSettings } from './denoise.ts'

export interface RTCamera {
  ex: number; ey: number; ez: number // eye
  fx: number; fy: number; fz: number // forward
  rx: number; ry: number; rz: number // right
  ux: number; uy: number; uz: number // up
  tanHalf: number
  aspect: number
}

export type RTMode = 'path' | 'ao'

// What the denoiser-aware resolve presents. 'denoised' is the beauty; the rest are
// debug views into the pipeline (the raw average, the feature buffers, the variance
// field) and a side-by-side noisy↔denoised wipe.
export type RTView = 'denoised' | 'noisy' | 'split' | 'albedo' | 'normal' | 'variance'

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
  private featuresDirty = true
  private denoiseSig = '' // cache key so the filter only re-runs when its input changes
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
    this.bvh = new BVH(this.scene)
    this.triangles = this.scene.count
    this.nodes = this.bvh.nodeTotal
    this.resetAccum()
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
  }

  // Refine the image for up to `budgetMs`, then tone-map it. The accumulation
  // resets whenever `resetKey` (camera + tracer settings) changes.
  step(
    cam: RTCamera, light: RTLighting, mode: RTMode, post: PostSettings,
    w: number, h: number, budgetMs: number, resetKey: string,
    den: DenoiseSettings, view: RTView, splitPos: number,
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
      const c = mode === 'ao'
        ? traceAO(cam.ex, cam.ey, cam.ez, dx, dy, dz, ctx, rng)
        : tracePath(cam.ex, cam.ey, cam.ez, dx, dy, dz, ctx, rng)
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
    const feat: PrimaryFeature = { hit: false, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0, ar: 1, ag: 1, ab: 1 }
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
          this.featPos[o] = feat.px; this.featPos[o + 1] = feat.py; this.featPos[o + 2] = feat.pz
          this.featNormal[o] = feat.nx; this.featNormal[o + 1] = feat.ny; this.featNormal[o + 2] = feat.nz
          this.featAlbedo[o] = feat.ar; this.featAlbedo[o + 1] = feat.ag; this.featAlbedo[o + 2] = feat.ab
        } else {
          this.featMask[p] = 0
          this.featPos[o] = 0; this.featPos[o + 1] = 0; this.featPos[o + 2] = 0
          this.featNormal[o] = 0; this.featNormal[o + 1] = 0; this.featNormal[o + 2] = 0
          this.featAlbedo[o] = 1; this.featAlbedo[o + 1] = 1; this.featAlbedo[o + 2] = 1
        }
      }
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
    if (view === 'split') {
      const splitX = Math.round(Math.min(0.95, Math.max(0.05, splitPos)) * W)
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const p = y * W + x
          const o = p * 3
          const src = x < splitX ? mean : beauty
          hdr[o] = src[o]; hdr[o + 1] = src[o + 1]; hdr[o + 2] = src[o + 2]
        }
      }
      return
    }
    const src = view === 'noisy' ? mean : beauty
    hdr.set(src.subarray(0, n * 3))
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
