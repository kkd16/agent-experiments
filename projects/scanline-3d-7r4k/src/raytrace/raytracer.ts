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
import { tracePath, traceAO } from './tracer.ts'
import type { RTContext, RTLighting } from './tracer.ts'
import { Rng, hashSeed } from './sampling.ts'

export interface RTCamera {
  ex: number; ey: number; ez: number // eye
  fx: number; fy: number; fz: number // forward
  rx: number; ry: number; rz: number // right
  ux: number; uy: number; uz: number // up
  tanHalf: number
  aspect: number
}

export type RTMode = 'path' | 'ao'

const MAX_SPP = 2048 // stop refining once every pixel has this many samples

export class RayTracer {
  W = 0
  H = 0
  private accum = new Float32Array(0)
  private sampleCount = new Uint16Array(0)
  private out: Framebuffer | null = null
  private cursor = 0
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
    this.accum = new Float32Array(w * h * 3)
    this.sampleCount = new Uint16Array(w * h)
    this.out = new Framebuffer(w, h)
    this.resetAccum()
  }

  resetAccum(): void {
    this.accum.fill(0)
    this.sampleCount.fill(0)
    this.cursor = 0
    this.passes = 0
    this.minSamples = 0
  }

  // Refine the image for up to `budgetMs`, then tone-map it. The accumulation
  // resets whenever `resetKey` (camera + tracer settings) changes.
  step(
    cam: RTCamera, light: RTLighting, mode: RTMode, post: PostSettings,
    w: number, h: number, budgetMs: number, resetKey: string,
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
    if (this.minSamples >= MAX_SPP) {
      this.resolve(post)
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
    this.resolve(post)
  }

  // Average the accumulation buffer into the HDR buffer, then tone-map it.
  private resolve(post: PostSettings): void {
    const out = this.out
    if (!out) return
    const hdr = out.hdr
    const accum = this.accum
    const counts = this.sampleCount
    const n = this.W * this.H
    for (let p = 0; p < n; p++) {
      const c = counts[p]
      const inv = c > 0 ? 1 / c : 0
      const o = p * 3
      hdr[o] = accum[o] * inv
      hdr[o + 1] = accum[o + 1] * inv
      hdr[o + 2] = accum[o + 2] * inv
    }
    resolveHDR(out, post)
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
