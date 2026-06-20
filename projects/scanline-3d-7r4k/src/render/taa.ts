// Temporal anti-aliasing. Each frame the projection is nudged by a sub-pixel
// Halton offset, so over time the rasterizer samples a different point inside every
// pixel. This pass reprojects the previous frame through the *unjittered*
// view-projection (using the G-buffer's world position), clamps that history to the
// 3×3 neighbourhood of the current frame to kill ghosting, and blends. On a still
// camera the single-sampled image converges to a clean supersample in a few frames.
import type { Mat4 } from '../math/mat4.ts'
import { Framebuffer } from './framebuffer.ts'
import type { GBuffer } from './gbuffer.ts'

// Radical-inverse Halton sample in [0,1).
function halton(index: number, base: number): number {
  let f = 1
  let r = 0
  let i = index
  while (i > 0) {
    f /= base
    r += f * (i % base)
    i = Math.floor(i / base)
  }
  return r
}

// Sub-pixel jitter for frame `n`, in [-0.5, 0.5] pixels on each axis.
export function haltonJitter(n: number): [number, number] {
  return [halton(n + 1, 2) - 0.5, halton(n + 1, 3) - 0.5]
}

// Return a copy of `proj` shifted by (jx, jy) pixels in screen space. The shift is
// proportional to clip.w, so it is a pure sub-pixel translation after the divide.
export function jitterProjection(proj: Mat4, jx: number, jy: number, W: number, H: number): Mat4 {
  const m = proj.slice()
  m[8] -= (jx * 2) / W
  m[9] -= (jy * 2) / H
  return m
}

export class TAA {
  private W = 0
  private H = 0
  private histA = new Float32Array(0)
  private histB = new Float32Array(0)
  private cur = 0 // which buffer holds the latest history
  private valid = false
  private prevVP: Mat4 | null = null
  alpha = 0.9 // history weight when reprojection succeeds

  reset(): void {
    this.valid = false
    this.prevVP = null
  }

  private ensure(W: number, H: number): void {
    if (W === this.W && H === this.H) return
    this.W = W; this.H = H
    this.histA = new Float32Array(W * H * 3)
    this.histB = new Float32Array(W * H * 3)
    this.valid = false
    this.prevVP = null
  }

  // Bilinearly sample a history buffer at fractional pixel (fx, fy).
  private sample(buf: Float32Array, fx: number, fy: number, out: [number, number, number]): void {
    const { W, H } = this
    const x0 = Math.min(W - 1, Math.max(0, Math.floor(fx)))
    const y0 = Math.min(H - 1, Math.max(0, Math.floor(fy)))
    const x1 = Math.min(W - 1, x0 + 1)
    const y1 = Math.min(H - 1, y0 + 1)
    const tx = fx - x0
    const ty = fy - y0
    const i00 = (y0 * W + x0) * 3, i10 = (y0 * W + x1) * 3
    const i01 = (y1 * W + x0) * 3, i11 = (y1 * W + x1) * 3
    for (let c = 0; c < 3; c++) {
      const a = buf[i00 + c] + (buf[i10 + c] - buf[i00 + c]) * tx
      const b = buf[i01 + c] + (buf[i11 + c] - buf[i01 + c]) * tx
      out[c] = a + (b - a) * ty
    }
  }

  // `vp` is the current frame's *unjittered* view-projection (world → clip).
  resolve(fb: Framebuffer, gbuf: GBuffer, vp: Mat4): void {
    this.ensure(fb.width, fb.height)
    const { W, H } = this
    const { color } = fb
    const { pos, mask } = gbuf
    const histPrev = this.cur === 0 ? this.histA : this.histB
    const histNext = this.cur === 0 ? this.histB : this.histA

    const unpack = (p: number, o: [number, number, number]): void => {
      o[0] = (p & 0xff) / 255
      o[1] = ((p >> 8) & 0xff) / 255
      o[2] = ((p >> 16) & 0xff) / 255
    }

    const cur: [number, number, number] = [0, 0, 0]
    const hist: [number, number, number] = [0, 0, 0]
    const nb: [number, number, number] = [0, 0, 0]
    const prevVP = this.prevVP

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        unpack(color[i], cur)

        if (!this.valid || !prevVP) {
          const o = i * 3
          histNext[o] = cur[0]; histNext[o + 1] = cur[1]; histNext[o + 2] = cur[2]
          continue
        }

        // 3×3 neighbourhood colour box (AABB clamp target)
        let mnR = cur[0], mnG = cur[1], mnB = cur[2]
        let mxR = cur[0], mxG = cur[1], mxB = cur[2]
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= H) continue
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx
            if (xx < 0 || xx >= W) continue
            unpack(color[yy * W + xx], nb)
            if (nb[0] < mnR) mnR = nb[0]; if (nb[0] > mxR) mxR = nb[0]
            if (nb[1] < mnG) mnG = nb[1]; if (nb[1] > mxG) mxG = nb[1]
            if (nb[2] < mnB) mnB = nb[2]; if (nb[2] > mxB) mxB = nb[2]
          }
        }

        // reproject into the previous frame
        let fx = x + 0.5
        let fy = y + 0.5
        let reproject = false
        if (mask[i]) {
          const wx = pos[i * 3], wy = pos[i * 3 + 1], wz = pos[i * 3 + 2]
          const cw = prevVP[3] * wx + prevVP[7] * wy + prevVP[11] * wz + prevVP[15]
          if (cw > 1e-6) {
            const cx = prevVP[0] * wx + prevVP[4] * wy + prevVP[8] * wz + prevVP[12]
            const cy = prevVP[1] * wx + prevVP[5] * wy + prevVP[9] * wz + prevVP[13]
            const nx = cx / cw, ny = cy / cw
            fx = (nx * 0.5 + 0.5) * W
            fy = (1 - (ny * 0.5 + 0.5)) * H
            reproject = fx >= 0 && fx < W && fy >= 0 && fy < H
          }
        } else {
          reproject = true // static background: same pixel
        }

        let out0 = cur[0], out1 = cur[1], out2 = cur[2]
        if (reproject) {
          this.sample(histPrev, fx - 0.5, fy - 0.5, hist)
          // clamp history into the current neighbourhood to suppress ghosting
          const h0 = Math.min(mxR, Math.max(mnR, hist[0]))
          const h1 = Math.min(mxG, Math.max(mnG, hist[1]))
          const h2 = Math.min(mxB, Math.max(mnB, hist[2]))
          const a = this.alpha
          out0 = cur[0] + (h0 - cur[0]) * a
          out1 = cur[1] + (h1 - cur[1]) * a
          out2 = cur[2] + (h2 - cur[2]) * a
        }
        const o = i * 3
        histNext[o] = out0; histNext[o + 1] = out1; histNext[o + 2] = out2
        color[i] = Framebuffer.pack(out0, out1, out2)
      }
    }

    this.cur = this.cur === 0 ? 1 : 0
    this.prevVP = vp
    this.valid = true
  }
}
