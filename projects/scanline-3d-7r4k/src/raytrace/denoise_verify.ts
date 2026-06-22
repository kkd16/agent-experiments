// Numerical self-tests for the v6 denoiser. Each check re-derives a claim from an
// independent reference and runs headlessly (no DOM) so it is both a browser button
// and a CI-time harness. The unit checks drive the À-Trous filter directly on
// synthetic buffers; the end-to-end checks drive whole path-traced frames through the
// renderer and inspect the raw buffers it produced.
import { Denoiser, DEFAULT_DENOISE } from './denoise.ts'
import type { DenoiseSettings, DenoiseInput } from './denoise.ts'
import { Renderer } from '../engine/renderer.ts'
import type { RenderSettings } from '../engine/renderer.ts'
import { DEFAULT_POST } from '../render/post.ts'
import { DEFAULT_SSFX } from '../render/ssfx.ts'
import { PRESETS } from '../scene/scene.ts'

export interface DenoiseTest {
  name: string
  pass: boolean
  detail: string
}

// A tiny deterministic PRNG so the noise the tests inject is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b

// Build a feature set with sensible flat defaults; the caller overrides what it tests.
function makeInput(W: number, H: number, over: Partial<DenoiseInput> & { settings: DenoiseSettings }): DenoiseInput {
  const n = W * H
  const color = over.color ?? new Float32Array(n * 3)
  const albedo = over.albedo ?? new Float32Array(n * 3).fill(1)
  const normal = over.normal ?? (() => { const a = new Float32Array(n * 3); for (let i = 0; i < n; i++) a[i * 3 + 2] = 1; return a })()
  const pos = over.pos ?? new Float32Array(n * 3)
  const mask = over.mask ?? new Uint8Array(n).fill(1)
  const variance = over.variance ?? new Float32Array(n)
  const out = over.out ?? new Float32Array(n * 3)
  return { W, H, color, albedo, normal, pos, mask, variance, out, settings: over.settings }
}

// Population variance of a slice of luminance values.
function varianceOf(vals: number[]): { mean: number; var: number } {
  let s = 0
  for (const v of vals) s += v
  const mean = s / vals.length
  let v = 0
  for (const x of vals) v += (x - mean) * (x - mean)
  return { mean, var: v / vals.length }
}

const baseRender = (over: Partial<RenderSettings> = {}, rtOver: Partial<RenderSettings['rt']> = {}): RenderSettings => ({
  engine: 'rt',
  mode: 'shaded',
  cullBack: false,
  autoRotate: false,
  showGround: true,
  fog: false,
  ambientBoost: 1,
  lightBoost: 1,
  shadows: true,
  shadingModel: 'pbr',
  environment: true,
  normalMaps: true,
  post: { ...DEFAULT_POST, bloom: false, fxaa: false, vignette: false },
  ssfx: DEFAULT_SSFX,
  transparency: { enabled: false, refraction: 28, thickness: 1.1 },
  rt: {
    mode: 'path', maxBounces: 4, softShadows: true, sunSoftness: 1.5,
    lightRadius: 0.25, aoRadius: 1.5, resolutionScale: 1, compare: false, splitPos: 0.5,
    denoise: DEFAULT_DENOISE, view: 'denoised',
    medium: { enabled: false, preset: 'haze', density: 1, g: 0.55 }, ...rtOver,
  },
  ...over,
})

export function runDenoiseSelfTest(): DenoiseTest[] {
  const tests: DenoiseTest[] = []
  const ok = (name: string, pass: boolean, detail: string): void => { tests.push({ name, pass, detail }) }
  const den = new Denoiser()

  // ── 1. Demodulate ∘ modulate is the identity (iterations=0 ⇒ pure round-trip) ──
  {
    const W = 16, H = 16, n = W * H
    const rng = mulberry32(1)
    const color = new Float32Array(n * 3)
    const albedo = new Float32Array(n * 3)
    for (let i = 0; i < n * 3; i++) { color[i] = rng(); albedo[i] = rng() } // albedo incl. < 0.05
    const out = new Float32Array(n * 3)
    den.run(makeInput(W, H, { color, albedo, out, settings: { ...DEFAULT_DENOISE, iterations: 0 } }))
    let mx = 0
    for (let i = 0; i < n * 3; i++) mx = Math.max(mx, Math.abs(out[i] - color[i]))
    ok('Demodulate round-trips', mx < 1e-5, `max |modulate(demodulate(c)) − c| = ${mx.toExponential(1)} over ${n} px`)
  }

  // ── 2. With edge-stopping disabled the filter is the exact B-spline wavelet ──
  {
    const W = 24, H = 24, n = W * H
    const rng = mulberry32(7)
    const color = new Float32Array(n * 3)
    for (let i = 0; i < n * 3; i++) color[i] = rng()
    const out = new Float32Array(n * 3)
    // flat normals/positions + huge σ_color + σ_normal 0 ⇒ every weight is the kernel
    den.run(makeInput(W, H, {
      color, out,
      settings: { ...DEFAULT_DENOISE, iterations: 1, sigmaColor: 1e9, sigmaNormal: 0, sigmaPos: 1e9, demodulate: false, varianceGuided: false },
    }))
    // independent separable [1 4 6 4 1]/16 reference on interior pixels (no border clamp)
    const K = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16]
    let mx = 0
    for (let y = 2; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        for (let c = 0; c < 3; c++) {
          let acc = 0
          for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) {
            acc += K[ox + 2] * K[oy + 2] * color[((y + oy) * W + (x + ox)) * 3 + c]
          }
          mx = Math.max(mx, Math.abs(acc - out[(y * W + x) * 3 + c]))
        }
      }
    }
    ok('À-Trous = B-spline wavelet', mx < 1e-5, `max |filter − reference| = ${mx.toExponential(1)} on interior pixels`)
  }

  // ── 3. On a flat noisy surface the filter cuts variance while preserving the mean ──
  {
    const W = 64, H = 64, n = W * H
    const rng = mulberry32(13)
    const truth = 0.5
    const sigma = 0.25
    const color = new Float32Array(n * 3)
    const variance = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      // box-muller-ish: average a few uniforms for a roughly gaussian noise
      let g = 0; for (let k = 0; k < 4; k++) g += rng()
      const noise = (g - 2) * sigma
      const v = truth + noise
      color[i * 3] = v; color[i * 3 + 1] = v; color[i * 3 + 2] = v
      variance[i] = sigma * sigma * (2 / 3) // matches the 4-uniform-sum variance, the SVGF guide
    }
    const out = new Float32Array(n * 3)
    den.run(makeInput(W, H, {
      color, variance, out,
      settings: { ...DEFAULT_DENOISE, iterations: 5, sigmaColor: 8, demodulate: false, varianceGuided: true },
    }))
    const inVals: number[] = [], outVals: number[] = []
    for (let y = 6; y < H - 6; y++) for (let x = 6; x < W - 6; x++) {
      const i = y * W + x
      inVals.push(luma(color[i * 3], color[i * 3 + 1], color[i * 3 + 2]))
      outVals.push(luma(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]))
    }
    const a = varianceOf(inVals), b = varianceOf(outVals)
    const ratio = a.var / (b.var || 1e-12)
    const biased = Math.abs(b.mean - truth)
    ok('Cuts noise, keeps the mean', ratio > 3 && biased < 0.02,
      `variance ↓ ${ratio.toFixed(1)}× (σ²:${a.var.toExponential(1)}→${b.var.toExponential(1)}), mean drift ${biased.toFixed(4)}`)
  }

  // ── 4. A normal discontinuity is not blurred across (creases survive) ──
  {
    const W = 48, H = 16, n = W * H
    const mid = W >> 1
    const color = new Float32Array(n * 3)
    const normal = new Float32Array(n * 3)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x
      const left = x < mid
      const v = left ? 1 : 0
      color[i * 3] = v; color[i * 3 + 1] = v; color[i * 3 + 2] = v
      // left faces +Z, right faces +X (perpendicular ⇒ dot 0 ⇒ rejected)
      if (left) normal[i * 3 + 2] = 1
      else normal[i * 3] = 1
    }
    const filt = new Float32Array(n * 3)
    den.run(makeInput(W, H, { color, normal, out: filt, settings: { ...DEFAULT_DENOISE, iterations: 5, sigmaColor: 1e9, demodulate: false, varianceGuided: false } }))
    // a genuinely edge-blind blur for comparison: hand it a *uniform* normal field so
    // nothing is rejected — it must then bleed the seam toward the average.
    const flatN = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) flatN[i * 3 + 2] = 1
    const blur = new Float32Array(n * 3)
    den.run(makeInput(W, H, { color: color.slice(), normal: flatN, out: blur, settings: { ...DEFAULT_DENOISE, iterations: 5, sigmaColor: 1e9, sigmaNormal: 0, sigmaPos: 1e9, demodulate: false, varianceGuided: false } }))
    const edge = (mid - 1) + (H >> 1) * W // a left pixel right at the seam
    const kept = filt[edge * 3]
    const bled = blur[edge * 3]
    ok('Creases survive (normal stop)', kept > 0.9 && bled < 0.8,
      `seam pixel: edge-aware ${kept.toFixed(3)} (kept) vs edge-blind ${bled.toFixed(3)} (bled)`)
  }

  // ── 5. A depth/plane discontinuity is not blurred across either ──
  {
    const W = 48, H = 16, n = W * H
    const mid = W >> 1
    const color = new Float32Array(n * 3)
    const normal = new Float32Array(n * 3)
    const pos = new Float32Array(n * 3)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x
      const left = x < mid
      const v = left ? 1 : 0
      color[i * 3] = v; color[i * 3 + 1] = v; color[i * 3 + 2] = v
      normal[i * 3 + 2] = 1 // same normal everywhere…
      pos[i * 3] = x * 0.02
      pos[i * 3 + 1] = y * 0.02
      pos[i * 3 + 2] = left ? 0 : 5 // …but a 5-unit cliff in depth at the seam
    }
    const filt = new Float32Array(n * 3)
    den.run(makeInput(W, H, { color, normal, pos, out: filt, settings: { ...DEFAULT_DENOISE, iterations: 5, sigmaColor: 1e9, sigmaPos: 0.4, demodulate: false, varianceGuided: false } }))
    const edge = (mid - 1) + (H >> 1) * W
    const kept = filt[edge * 3]
    ok('Depth cliffs survive (plane stop)', kept > 0.9, `seam pixel held at ${kept.toFixed(3)} across a 5-unit depth step`)
  }

  // ── 6. End-to-end: a denoised Cornell frame is far smoother than the raw 1-spp
  //       average, yet conserves total energy (no darkening / runaway). ──
  {
    const W = 160, H = 160
    const lum = (c: Uint32Array, i: number): number => (c[i] & 0xff) * 0.299 + ((c[i] >> 8) & 0xff) * 0.587 + ((c[i] >> 16) & 0xff) * 0.114
    const aliasEnergy = (c: Uint32Array): number => {
      let e = 0
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x
        e += Math.abs(4 * lum(c, i) - lum(c, i - 1) - lum(c, i + 1) - lum(c, i - W) - lum(c, i + W))
      }
      return e
    }
    const lumSum = (c: Uint32Array): number => { let s = 0; for (let i = 0; i < c.length; i++) s += lum(c, i); return s }
    const r = new Renderer(W, H, PRESETS.cornell())
    // accumulate a low-sample (still very noisy) estimate at half resolution
    for (let f = 0; f < 8; f++) r.render(0, baseRender({}, { view: 'noisy', resolutionScale: 0.5 }))
    const noisy = r.fb.color.slice()
    r.render(0, baseRender({}, { view: 'denoised', resolutionScale: 0.5 }))
    const clean = r.fb.color.slice()
    const eN = aliasEnergy(noisy), eD = aliasEnergy(clean)
    const drop = 1 - eD / (eN || 1)
    const lN = lumSum(noisy), lD = lumSum(clean)
    const energy = lD / (lN || 1)
    const finite = (() => { for (let i = 0; i < r.fb.hdr.length; i++) if (!Number.isFinite(r.fb.hdr[i])) return false; return true })()
    ok('Denoises a real path-traced frame', eD < eN * 0.6 && energy > 0.8 && energy < 1.2 && finite,
      `noise energy ↓ ${(drop * 100).toFixed(0)}% · brightness ×${energy.toFixed(3)} · ${r.rayTracer.minSamples} spp`)
  }

  // ── 7. NaN-free with the denoiser on across every GI scene + the feature views ──
  {
    const W = 96, H = 96
    const scenes = ['cornell', 'reflections', 'showcase', 'interior']
    const views: RenderSettings['rt']['view'][] = ['denoised', 'noisy', 'split', 'albedo', 'normal', 'variance']
    let clean = true
    const bad: string[] = []
    for (const key of scenes) {
      for (const view of views) {
        const r = new Renderer(W, H, PRESETS[key]())
        r.render(0, baseRender({}, { view }))
        for (let i = 0; i < r.fb.hdr.length; i++) if (!Number.isFinite(r.fb.hdr[i])) { clean = false; if (!bad.includes(key)) bad.push(`${key}/${view}`); break }
      }
    }
    ok('NaN-free across scenes & views', clean, clean ? `${scenes.length} scenes × ${views.length} views resolve with finite radiance` : `NaNs in: ${bad.join(', ')}`)
  }

  return tests
}
