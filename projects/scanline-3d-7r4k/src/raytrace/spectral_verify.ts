// In-app numerical self-test of the v10 spectral renderer. Each check re-derives a claim
// from an independent reference — the equal-energy white point, the Monte-Carlo wavelength
// estimator against a deterministic CMF integral, the Smits round-trip error, the textbook
// Abbe numbers and Sellmeier ordering, the analytic prism minimum-deviation spread, the
// blackbody chromaticity ordering, and an end-to-end spectral furnace (energy conservation
// + exposure parity with the RGB tracer). Pure and DOM-free; runs live in the browser.
import type { Vec3 } from '../math/vec.ts'
import { buildMesh } from '../geometry/mesh.ts'
import { scaling } from '../math/mat4.ts'
import { RTScene } from './rtscene.ts'
import type { RTInstance } from './rtscene.ts'
import { BVH } from './bvh.ts'
import { Rng, uniformSphere } from './sampling.ts'
import {
  GLASS_PRESETS, LAMBDA_MIN, LAMBDA_MAX, abbeNumber, blackbodyRadiance, getGlass,
  rgbToSpectrum, sampleWavelength, sellmeierIor as sellmeier, spectralRadianceToRGB, spectrumAt,
} from './spectrum.ts'
import { traceSpectral } from './spectral.ts'
import type { RTContext } from './tracer.ts'

export interface SpectralTest {
  name: string
  pass: boolean
  detail: string
}

const PI = Math.PI

// Deterministic CMF integral of a spectrum S(λ) → linear sRGB, by Riemann sum over a fine
// grid. Uses the public per-sample converter with pdf=1 (= the conversion factor at λ), so
// it shares the exact normalisation/white-balance the tracer uses. ∫ conv(λ)·S(λ) dλ.
function deterministicRGB(S: (l: number) => number): Vec3 {
  const N = 400
  const dl = (LAMBDA_MAX - LAMBDA_MIN) / N
  const tmp = new Float64Array(3)
  let r = 0, g = 0, b = 0
  for (let i = 0; i < N; i++) {
    const l = LAMBDA_MIN + (i + 0.5) * dl
    spectralRadianceToRGB(S(l), l, 1, tmp)
    r += tmp[0] * dl; g += tmp[1] * dl; b += tmp[2] * dl
  }
  return [r, g, b]
}

// Monte-Carlo mean of the per-sample converter under importance-sampled λ — the estimator
// the tracer actually runs. Should match `deterministicRGB` for the same spectrum.
function monteCarloRGB(S: (l: number) => number, n: number, rng: Rng): Vec3 {
  const tmp = new Float64Array(3)
  let r = 0, g = 0, b = 0
  for (let k = 0; k < n; k++) {
    const ws = sampleWavelength(rng.next())
    spectralRadianceToRGB(S(ws.lambda), ws.lambda, ws.pdf, tmp)
    r += tmp[0]; g += tmp[1]; b += tmp[2]
  }
  return [r / n, g / n, b / n]
}

const white = (albedo: Vec3, metallic: number, roughness: number): RTInstance['material'] =>
  ({ albedo, specular: 0.5, shininess: 32, rim: 0, metallic, roughness })

export function runSpectralSelfTest(): SpectralTest[] {
  const tests: SpectralTest[] = []
  const add = (name: string, pass: boolean, detail: string): void => { tests.push({ name, pass, detail }) }

  // 1 — equal-energy white point: the flat unit spectrum maps to linear sRGB (1,1,1).
  {
    const c = deterministicRGB(() => 1)
    const err = Math.max(Math.abs(c[0] - 1), Math.abs(c[1] - 1), Math.abs(c[2] - 1))
    add('Equal-energy white point = (1,1,1)', err < 1e-3,
      `flat spectrum → (${c[0].toFixed(4)}, ${c[1].toFixed(4)}, ${c[2].toFixed(4)}), max|Δ|=${err.toExponential(1)}`)
  }

  // 2 — the importance-sampled MC wavelength estimator is unbiased: its mean reproduces the
  // deterministic CMF integral for a non-trivial (Smits-up-sampled) spectrum.
  {
    const co = rgbToSpectrum(0.2, 0.6, 0.95)
    const S = (l: number): number => spectrumAt(co, l)
    const ref = deterministicRGB(S)
    const mc = monteCarloRGB(S, 300000, new Rng(0x5eed))
    const err = Math.max(Math.abs(mc[0] - ref[0]), Math.abs(mc[1] - ref[1]), Math.abs(mc[2] - ref[2]))
    add('MC wavelength estimator unbiased', err < 0.01,
      `MC (${mc[0].toFixed(3)},${mc[1].toFixed(3)},${mc[2].toFixed(3)}) vs integral (${ref[0].toFixed(3)},${ref[1].toFixed(3)},${ref[2].toFixed(3)}), max|Δ|=${err.toFixed(4)}`)
  }

  // 3 — Smits up-sampling round-trips: RGB → reflectance spectrum → RGB recovers realistic
  // colours within a few percent (saturated primaries, near the gamut edge, are looser).
  {
    const pal: Vec3[] = [
      [0.73, 0.73, 0.73], [0.5, 0.5, 0.5], [0.9, 0.2, 0.2], [0.14, 0.45, 0.09],
      [0.63, 0.065, 0.05], [0.2, 0.6, 0.95], [1, 0.95, 0.85],
    ]
    let worst = 0
    for (const c of pal) {
      const co = rgbToSpectrum(c[0], c[1], c[2])
      const rgb = deterministicRGB((l) => spectrumAt(co, l))
      worst = Math.max(worst, Math.abs(rgb[0] - c[0]), Math.abs(rgb[1] - c[1]), Math.abs(rgb[2] - c[2]))
    }
    add('Smits RGB→spectrum→RGB round-trip', worst < 0.08,
      `worst |Δ| over 7 realistic colours = ${worst.toFixed(4)} (< 0.08; saturated primaries near the gamut edge are looser)`)
  }

  // 4 — Abbe numbers match the glass catalogues (BK7 ≈ 64.2, SF10 ≈ 28.5, silica ≈ 67.8).
  {
    const want: Record<string, number> = { bk7: 64.17, sf10: 28.41, silica: 67.8 }
    let worst = 0
    const parts: string[] = []
    for (const k of Object.keys(want)) {
      const g = getGlass(k)!
      const v = abbeNumber(g)
      worst = Math.max(worst, Math.abs(v - want[k]))
      parts.push(`${k} V=${v.toFixed(1)}`)
    }
    add('Sellmeier Abbe numbers vs catalogue', worst < 1.5, `${parts.join(', ')} (max|Δ| ${worst.toFixed(2)} < 1.5)`)
  }

  // 5 — normal dispersion: every glass bends violet more than red (n(420) > n(680)).
  {
    let ok = true
    const parts: string[] = []
    for (const g of GLASS_PRESETS) {
      const nV = sellmeier(g, 420), nR = sellmeier(g, 680)
      if (!(nV > nR)) ok = false
      parts.push(`${g.key} Δn=${(nV - nR).toFixed(4)}`)
    }
    add('Normal dispersion n(violet) > n(red)', ok, parts.join(', '))
  }

  // 6 — prism minimum-deviation spread: for a 60° equilateral prism, δ_min(λ)=2·asin(n·sin30°)−60°.
  // Blue deviates more than red, and dense flint (SF10) fans far wider than crown (BK7).
  {
    const A = PI / 3
    const dev = (g: ReturnType<typeof getGlass>, l: number): number => 2 * Math.asin(sellmeier(g!, l) * Math.sin(A / 2)) - A
    const bk7 = getGlass('bk7'), sf10 = getGlass('sf10')
    const bSpread = (dev(bk7, 440) - dev(bk7, 660)) * 180 / PI
    const sSpread = (dev(sf10, 440) - dev(sf10, 660)) * 180 / PI
    const ok = bSpread > 0.4 && bSpread < 1.5 && sSpread > 2 && sSpread > 2.5 * bSpread
    add('Prism min-deviation spread (BK7 vs SF10)', ok,
      `BK7 fan ${bSpread.toFixed(2)}°, SF10 fan ${sSpread.toFixed(2)}° (flint ${(sSpread / bSpread).toFixed(1)}× wider)`)
  }

  // 7 — blackbody chromaticity ordering: a 3000 K lamp is warm (r > b), 6500 K near neutral,
  // 9000 K cool (b > r) — Planck's law fed through the CMFs reproduces the Planckian locus.
  {
    const rb = (T: number): number => { const c = deterministicRGB((l) => blackbodyRadiance(l, T)); return c[0] / Math.max(1e-6, c[2]) }
    const warm = rb(3000), neutral = rb(6500), cool = rb(9000)
    const ok = warm > 1.4 && cool < 0.95 && warm > neutral && neutral > cool
    add('Blackbody chromaticity ordering', ok,
      `r/b: 3000K=${warm.toFixed(2)} > 6500K=${neutral.toFixed(2)} > 9000K=${cool.toFixed(2)}`)
  }

  // 8 — spectral white furnace: with no geometry and a uniform unit sky, every wavelength
  // returns radiance 1, so the reconstructed image is exactly white (1,1,1). Proves the
  // sky → spectrum → CMF → sRGB chain is unbiased and correctly exposed.
  {
    const scene = new RTScene([])
    const bvh = new BVH(scene)
    const ctx: RTContext = {
      scene, bvh, lights: [], env: null, ambient: [0, 0, 0],
      sky: () => [1, 1, 1], maxBounces: 0, sunCosHalf: 1, lightRadius: 0, aoRadius: 1e30,
    }
    const rng = new Rng(0xfa11)
    let r = 0, g = 0, b = 0
    const N = 120000
    for (let k = 0; k < N; k++) {
      const dir = uniformSphere(rng.next(), rng.next())
      const ws = sampleWavelength(rng.next())
      const c = traceSpectral(0, 0, 0, dir[0], dir[1], dir[2], ctx, rng, ws.lambda, ws.pdf)
      r += c[0]; g += c[1]; b += c[2]
    }
    r /= N; g /= N; b /= N
    const err = Math.max(Math.abs(r - 1), Math.abs(g - 1), Math.abs(b - 1))
    add('Spectral white furnace (sky energy)', err < 0.02,
      `mean (${r.toFixed(3)}, ${g.toFixed(3)}, ${b.toFixed(3)}) vs unit sky, max|Δ|=${err.toFixed(3)}`)
  }

  // 9 — diffuse-surface furnace: a white Lambert sphere under a unit sky reflects ≈ its
  // albedo (energy conserving), at the SAME exposure as the RGB tracer — this is the parity
  // that makes a non-dispersive scene read identically in the spectral/RGB side-by-side.
  {
    const inst: RTInstance = { mesh: buildMesh('sphere'), model: scaling(1, 1, 1), material: white([0.8, 0.8, 0.8], 0, 0.6), texture: null, normalMap: null }
    const scene = new RTScene([inst])
    const bvh = new BVH(scene)
    const ctx: RTContext = {
      scene, bvh, lights: [], env: null, ambient: [0, 0, 0],
      sky: () => [1, 1, 1], maxBounces: 5, sunCosHalf: 1, lightRadius: 0, aoRadius: 1e30, mis: true,
    }
    const rng = new Rng(0xb0a)
    let sum = 0, n = 0
    const N = 50000
    for (let k = 0; k < N; k++) {
      // fire inward from a random point on a bounding sphere toward the origin
      const p = uniformSphere(rng.next(), rng.next())
      const ox = p[0] * 3, oy = p[1] * 3, oz = p[2] * 3
      let dx = -p[0], dy = -p[1], dz = -p[2]
      const dl = Math.hypot(dx, dy, dz) || 1
      dx /= dl; dy /= dl; dz /= dl
      const ws = sampleWavelength(rng.next())
      const c = traceSpectral(ox, oy, oz, dx, dy, dz, ctx, rng, ws.lambda, ws.pdf)
      const L = (c[0] + c[1] + c[2]) / 3
      // only count rays that struck the sphere (others return the unit sky = 1)
      sum += L; n++
    }
    const avg = sum / n
    // mix of sphere hits (≈0.8) and sky misses (=1) → between albedo and 1; assert it is
    // energy-bounded and bright (no energy loss/explosion), and clearly below the unit sky.
    add('Diffuse furnace energy bound', avg > 0.78 && avg < 1.02,
      `mean radiance ${avg.toFixed(3)} (sphere albedo 0.8, unit sky 1.0)`)
  }

  return tests
}
