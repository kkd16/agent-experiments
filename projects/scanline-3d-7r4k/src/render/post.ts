// Post-processing: the bridge from the linear HDR scene buffer to the packed,
// display-ready colour buffer. In order — optional bloom (bright-pass + separable
// Gaussian on a half-res buffer), exposure, vignette, a tone-map operator, gamma,
// then an optional FXAA luma-edge pass. Debug views skip all of this.
import { clamp01 } from '../math/scalar.ts'
import { Framebuffer } from './framebuffer.ts'

export type ToneMap = 'aces' | 'reinhard' | 'filmic' | 'none'

export interface PostSettings {
  exposure: number
  toneMap: ToneMap
  bloom: boolean
  bloomThreshold: number
  bloomIntensity: number
  vignette: boolean
  fxaa: boolean
}

export const DEFAULT_POST: PostSettings = {
  exposure: 1,
  toneMap: 'aces',
  bloom: true,
  bloomThreshold: 1.1,
  bloomIntensity: 0.6,
  vignette: true,
  fxaa: true,
}

// ── tone-map operators (linear in → linear-ish 0..1 out) ─────────────────────
const aces = (x: number): number => {
  // Narkowicz ACES filmic approximation
  const a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14
  return clamp01((x * (a * x + b)) / (x * (c * x + d) + e))
}
const reinhard = (x: number): number => x / (1 + x)
const filmic = (x: number): number => {
  // Hejl–Burgess-Dawson; already includes an approximate gamma, so callers skip
  // the extra gamma step for this one.
  const z = Math.max(0, x - 0.004)
  return (z * (6.2 * z + 0.5)) / (z * (6.2 * z + 1.7) + 0.06)
}

const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.4126 * b

// scratch buffers reused across frames, re-allocated only when the size changes
let scratch: { w: number; h: number; bright: Float32Array; blur: Float32Array; fxaa: Uint32Array } | null = null
function scratchFor(w: number, h: number): NonNullable<typeof scratch> {
  if (!scratch || scratch.w !== w || scratch.h !== h) {
    const hw = Math.max(1, w >> 1)
    const hh = Math.max(1, h >> 1)
    scratch = {
      w, h,
      bright: new Float32Array(hw * hh * 3),
      blur: new Float32Array(hw * hh * 3),
      fxaa: new Uint32Array(w * h),
    }
  }
  return scratch
}

// Bright-pass + downsample the HDR buffer to half-res, blur it separably, and add
// it back to the HDR buffer scaled by intensity. Soft, GPU-style bloom.
function applyBloom(fb: Framebuffer, threshold: number, intensity: number): void {
  const { width: W, height: H, hdr } = fb
  const hw = Math.max(1, W >> 1)
  const hh = Math.max(1, H >> 1)
  const s = scratchFor(W, H)
  const bright = s.bright
  const blur = s.blur

  // bright pass with 2×2 box downsample
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      let r = 0, g = 0, b = 0
      for (let dy = 0; dy < 2; dy++) {
        const sy = Math.min(H - 1, y * 2 + dy)
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(W - 1, x * 2 + dx)
          const o = (sy * W + sx) * 3
          r += hdr[o]; g += hdr[o + 1]; b += hdr[o + 2]
        }
      }
      r *= 0.25; g *= 0.25; b *= 0.25
      const l = luma(r, g, b)
      const k = l > threshold ? (l - threshold) / l : 0
      const o = (y * hw + x) * 3
      bright[o] = r * k
      bright[o + 1] = g * k
      bright[o + 2] = b * k
    }
  }

  // separable 9-tap Gaussian (σ≈2). horizontal: bright → blur
  const K = [0.227, 0.194, 0.121, 0.054, 0.016]
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      let r = 0, g = 0, b = 0
      for (let t = -4; t <= 4; t++) {
        const sx = Math.min(hw - 1, Math.max(0, x + t))
        const w = K[Math.abs(t)]
        const o = (y * hw + sx) * 3
        r += bright[o] * w; g += bright[o + 1] * w; b += bright[o + 2] * w
      }
      const o = (y * hw + x) * 3
      blur[o] = r; blur[o + 1] = g; blur[o + 2] = b
    }
  }
  // vertical: blur → bright
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      let r = 0, g = 0, b = 0
      for (let t = -4; t <= 4; t++) {
        const sy = Math.min(hh - 1, Math.max(0, y + t))
        const w = K[Math.abs(t)]
        const o = (sy * hw + x) * 3
        r += blur[o] * w; g += blur[o + 1] * w; b += blur[o + 2] * w
      }
      const o = (y * hw + x) * 3
      bright[o] = r; bright[o + 1] = g; bright[o + 2] = b
    }
  }

  // upsample (nearest) + additive composite
  for (let y = 0; y < H; y++) {
    const by = y >> 1
    for (let x = 0; x < W; x++) {
      const bx = x >> 1
      const bo = (by * hw + bx) * 3
      const o = (y * W + x) * 3
      hdr[o] += bright[bo] * intensity
      hdr[o + 1] += bright[bo + 1] * intensity
      hdr[o + 2] += bright[bo + 2] * intensity
    }
  }
}

// Resolve the HDR buffer into the packed colour buffer with the full chain.
export function resolveHDR(fb: Framebuffer, post: PostSettings): void {
  if (post.bloom && post.bloomIntensity > 0) applyBloom(fb, post.bloomThreshold, post.bloomIntensity)

  const { width: W, height: H, hdr, color } = fb
  const exposure = post.exposure
  const tm = post.toneMap
  const useVignette = post.vignette
  const cx = (W - 1) / 2
  const cy = (H - 1) / 2
  const invMaxR2 = 1 / (cx * cx + cy * cy + 1e-6)
  // filmic already bakes in gamma; the others need an explicit encode
  const skipGamma = tm === 'filmic'
  const invG = 1 / 2.2

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const o = i * 3
      let r = hdr[o] * exposure
      let g = hdr[o + 1] * exposure
      let b = hdr[o + 2] * exposure

      if (useVignette) {
        const dx = x - cx
        const dy = y - cy
        const r2 = (dx * dx + dy * dy) * invMaxR2
        const vig = 1 - 0.35 * r2 * r2
        r *= vig; g *= vig; b *= vig
      }

      switch (tm) {
        case 'aces': r = aces(r); g = aces(g); b = aces(b); break
        case 'reinhard': r = reinhard(r); g = reinhard(g); b = reinhard(b); break
        case 'filmic': r = filmic(r); g = filmic(g); b = filmic(b); break
        case 'none': r = clamp01(r); g = clamp01(g); b = clamp01(b); break
      }

      if (!skipGamma) {
        r = Math.pow(clamp01(r), invG)
        g = Math.pow(clamp01(g), invG)
        b = Math.pow(clamp01(b), invG)
      }
      color[i] = Framebuffer.pack(r, g, b)
    }
  }

  if (post.fxaa) fxaa(fb)
}

// A compact FXAA: detect a luma edge from the 4-neighbourhood and blend the
// centre toward the neighbours across the steeper gradient. Works on the packed
// sRGB bytes (luma in display space, which is what FXAA expects).
export function fxaa(fb: Framebuffer): void {
  const { width: W, height: H, color } = fb
  const s = scratchFor(W, H)
  const src = s.fxaa
  src.set(color)

  const lumaAt = (i: number): number => {
    const p = src[i]
    const r = p & 0xff
    const g = (p >> 8) & 0xff
    const b = (p >> 16) & 0xff
    return (r * 0.299 + g * 0.587 + b * 0.114) / 255
  }

  const EDGE_MIN = 0.04
  const EDGE_THRESH = 0.125
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      const lM = lumaAt(i)
      const lN = lumaAt(i - W)
      const lS = lumaAt(i + W)
      const lE = lumaAt(i + 1)
      const lW = lumaAt(i - 1)
      const lMin = Math.min(lM, lN, lS, lE, lW)
      const lMax = Math.max(lM, lN, lS, lE, lW)
      const range = lMax - lMin
      if (range < Math.max(EDGE_MIN, lMax * EDGE_THRESH)) continue

      // pick the axis with the larger luma difference and blend across it
      const gradH = Math.abs(lW - lE)
      const gradV = Math.abs(lN - lS)
      let n1: number, n2: number
      if (gradV >= gradH) { n1 = i - W; n2 = i + W } else { n1 = i - 1; n2 = i + 1 }
      const p0 = src[i], p1 = src[n1], p2 = src[n2]
      const blend = Math.min(0.5, range)
      const mix = (shift: number): number => {
        const c0 = (p0 >> shift) & 0xff
        const c1 = (p1 >> shift) & 0xff
        const c2 = (p2 >> shift) & 0xff
        const avg = (c1 + c2) * 0.5
        return (c0 + (avg - c0) * blend) & 0xff
      }
      const r = mix(0)
      const g = mix(8)
      const b = mix(16)
      color[i] = ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0
    }
  }
}
