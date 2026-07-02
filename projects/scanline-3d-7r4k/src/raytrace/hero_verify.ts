// In-app numerical self-test of the v11 hero-wavelength spectral integrator. Every check
// re-derives a claim from an independent reference or from the single-wavelength renderer it
// must agree with — the stratified tuple's coverage and pdf normalisation, the tristimulus
// reconstruction identity (C=1 is bit-identical to `spectralRadianceToRGB`), an unbiased white
// furnace, EXPOSURE PARITY with the single-wavelength tracer on a non-dispersive scene, the
// headline VARIANCE REDUCTION a multi-wavelength path buys, and — the subtle one — that a
// DISPERSIVE glass scene stays unbiased even though the tuple terminates its secondaries at the
// refraction. Pure and DOM-free; runs live in the browser.
import type { Vec3 } from '../math/vec.ts'
import { buildMesh } from '../geometry/mesh.ts'
import { scaling } from '../math/mat4.ts'
import { RTScene } from './rtscene.ts'
import type { RTInstance } from './rtscene.ts'
import { BVH } from './bvh.ts'
import { Rng, uniformSphere } from './sampling.ts'
import {
  cieX, cieY, cieZ, sampleWavelength, spectralRadianceToRGB, wavelengthPdf, xyzToBalancedRgb,
} from './spectrum.ts'
import { traceSpectral } from './spectral.ts'
import { traceHero, heroWavelengths } from './hero.ts'
import type { RTContext } from './tracer.ts'

export interface HeroTest {
  name: string
  pass: boolean
  detail: string
}

const material = (albedo: Vec3, extra: Record<string, unknown> = {}): RTInstance['material'] =>
  ({ albedo, specular: 0.5, shininess: 32, rim: 0, metallic: 0, roughness: 0.6, ...extra })

// A furnace: fire K single-sample camera rays inward at a scene and collect each sample's
// linear-sRGB result, then report the mean and the total per-sample variance (trace of the
// colour covariance) — the quantity hero-wavelength sampling is designed to shrink.
function furnaceStats(
  ctx: RTContext, C: number, K: number, seed: number,
): { mean: Vec3; totalVar: number } {
  const rng = new Rng(seed)
  let mr = 0, mg = 0, mb = 0, sr = 0, sg = 0, sb = 0
  for (let k = 0; k < K; k++) {
    const p = uniformSphere(rng.next(), rng.next())
    const ox = p[0] * 3, oy = p[1] * 3, oz = p[2] * 3
    let dx = -p[0], dy = -p[1], dz = -p[2]
    const dl = Math.hypot(dx, dy, dz) || 1
    dx /= dl; dy /= dl; dz /= dl
    let c: Vec3
    if (C === 1) {
      const ws = sampleWavelength(rng.next())
      c = traceSpectral(ox, oy, oz, dx, dy, dz, ctx, rng, ws.lambda, ws.pdf)
    } else {
      c = traceHero(ox, oy, oz, dx, dy, dz, ctx, rng, rng.next(), C)
    }
    mr += c[0]; mg += c[1]; mb += c[2]
    sr += c[0] * c[0]; sg += c[1] * c[1]; sb += c[2] * c[2]
  }
  mr /= K; mg /= K; mb /= K
  const vr = Math.max(0, sr / K - mr * mr)
  const vg = Math.max(0, sg / K - mg * mg)
  const vb = Math.max(0, sb / K - mb * mb)
  return { mean: [mr, mg, mb], totalVar: vr + vg + vb }
}

export function runHeroSelfTest(): HeroTest[] {
  const tests: HeroTest[] = []
  const add = (name: string, pass: boolean, detail: string): void => { tests.push({ name, pass, detail }) }

  // 1 — the stratified tuple: C wavelengths per hero seed, one per CDF quantile, each keeping
  // its own importance pdf, and the reconstruction weight is exactly 1/(pdf·C).
  {
    const C = 4
    const lam = new Float64Array(8), inv = new Float64Array(8)
    let ok = true, worstQuant = 0, worstInv = 0
    const rng = new Rng(0x11e0)
    for (let t = 0; t < 200; t++) {
      const u = rng.next()
      heroWavelengths(u, C, lam, inv)
      const sorted = Array.from({ length: C }, (_, i) => lam[i]).sort((a, b) => a - b)
      for (let i = 0; i < C; i++) {
        const wantInv = 1 / (wavelengthPdf(lam[i]) * C)
        worstInv = Math.max(worstInv, Math.abs(inv[i] - wantInv))
      }
      // distinctness: the four sorted wavelengths are strictly increasing and span the band
      for (let i = 1; i < C; i++) if (!(sorted[i] > sorted[i - 1])) ok = false
      worstQuant = Math.max(worstQuant, sorted[C - 1] - sorted[0])
    }
    add('Stratified tuple: distinct λ, pdf/C weights', ok && worstInv < 1e-9,
      `4 distinct λ per seed, max band span seen ${worstQuant.toFixed(0)} nm, |Δ(1/pdf·C)|≤${worstInv.toExponential(1)}`)
  }

  // 2 — reconstruction identity: accumulating tristimulus X=Σ x̄(λ)·L/(pdf·C) and finalising
  // through `xyzToBalancedRgb` reproduces the single-wavelength converter exactly at C=1, and
  // its C-sample average at C>1. This is what makes the hero image a superset of the 1λ image.
  {
    const L = 0.7, lambda = 555, pdf = wavelengthPdf(lambda)
    const ref = new Float64Array(3)
    spectralRadianceToRGB(L, lambda, pdf, ref)
    // C=1 reconstruction, by hand
    const out1 = new Float64Array(3)
    const w = L / (pdf * 1)
    xyzToBalancedRgb(cieX(lambda) * w, cieY(lambda) * w, cieZ(lambda) * w, out1)
    const e1 = Math.max(Math.abs(out1[0] - ref[0]), Math.abs(out1[1] - ref[1]), Math.abs(out1[2] - ref[2]))
    // C=4 average of four identical single-wavelength contributions equals the same value
    const C = 4
    let ax = 0, ay = 0, az = 0
    const lams = [455, 510, 560, 640]
    let refAvgR = 0, refAvgG = 0, refAvgB = 0
    const t = new Float64Array(3)
    for (const l of lams) {
      const p = wavelengthPdf(l)
      const ww = L / (p * C)
      ax += cieX(l) * ww; ay += cieY(l) * ww; az += cieZ(l) * ww
      spectralRadianceToRGB(L, l, p, t); refAvgR += t[0] / C; refAvgG += t[1] / C; refAvgB += t[2] / C
    }
    const out4 = new Float64Array(3)
    xyzToBalancedRgb(ax, ay, az, out4)
    const e4 = Math.max(Math.abs(out4[0] - refAvgR), Math.abs(out4[1] - refAvgG), Math.abs(out4[2] - refAvgB))
    add('Reconstruction identity (C=1 exact, C=N average)', e1 < 1e-12 && e4 < 1e-12,
      `C=1 |Δ|=${e1.toExponential(1)} vs 1λ converter; C=4 |Δ|=${e4.toExponential(1)} vs its 4-sample mean`)
  }

  // 3 — hero white furnace: an empty scene under a uniform unit sky returns radiance 1 at every
  // wavelength, so the reconstructed C=4 image is exactly white (1,1,1) — the reconstruction is
  // unbiased and correctly exposed with no dispersive termination in play.
  {
    const scene = new RTScene([])
    const bvh = new BVH(scene)
    const ctx: RTContext = {
      scene, bvh, lights: [], env: null, ambient: [0, 0, 0],
      sky: () => [1, 1, 1], maxBounces: 0, sunCosHalf: 1, lightRadius: 0, aoRadius: 1e30, heroCount: 4,
    }
    const s = furnaceStats(ctx, 4, 60000, 0xfa11)
    const err = Math.max(Math.abs(s.mean[0] - 1), Math.abs(s.mean[1] - 1), Math.abs(s.mean[2] - 1))
    add('Hero white furnace = (1,1,1)', err < 0.02,
      `C=4 mean (${s.mean[0].toFixed(3)}, ${s.mean[1].toFixed(3)}, ${s.mean[2].toFixed(3)}), max|Δ|=${err.toFixed(3)}`)
  }

  // 4 — exposure parity + variance reduction on a NON-dispersive coloured furnace: a diffuse
  // sphere under an amber sky. Hero (C=4) must reproduce the single-wavelength MEAN (unbiased)
  // AND carry markedly less per-sample colour variance (the whole point of the method).
  {
    const inst: RTInstance = { mesh: buildMesh('sphere'), model: scaling(1, 1, 1), material: material([0.75, 0.75, 0.75]), texture: null, normalMap: null }
    const scene = new RTScene([inst])
    const bvh = new BVH(scene)
    const sky: Vec3 = [0.95, 0.55, 0.18] // amber → strong per-wavelength (chroma) signal
    const ctx: RTContext = {
      scene, bvh, lights: [], env: null, ambient: [0, 0, 0],
      sky: () => sky, maxBounces: 4, sunCosHalf: 1, lightRadius: 0, aoRadius: 1e30, mis: true, heroCount: 4,
    }
    const one = furnaceStats(ctx, 1, 40000, 0xa11)
    const four = furnaceStats(ctx, 4, 40000, 0xa11)
    const dMean = Math.max(
      Math.abs(one.mean[0] - four.mean[0]), Math.abs(one.mean[1] - four.mean[1]), Math.abs(one.mean[2] - four.mean[2]))
    const ratio = four.totalVar / Math.max(1e-9, one.totalVar)
    add('Exposure parity + variance reduction vs 1λ', dMean < 0.02 && ratio < 0.85,
      `means agree to ${dMean.toFixed(4)}; per-sample colour variance ×${ratio.toFixed(2)} of 1λ (${(1 / ratio).toFixed(1)}× fewer samples for equal noise)`)
  }

  // 5 — DISPERSIVE parity: a dense-flint (SF10) glass sphere over a coloured sky. Here the hero
  // tuple TERMINATES its secondaries at the refraction and the hero's reconstruction pdf is
  // rescaled (÷C). If that bookkeeping is right, the converged C=4 mean still equals the
  // single-wavelength mean — dispersion is unbiased, just noisier there.
  {
    const glass = material([1, 1, 1], { roughness: 0.02, metallic: 0, transmission: 1, ior: 1.62, glass: 'sf10', attenuation: [0, 0, 0] })
    const inst: RTInstance = { mesh: buildMesh('sphere'), model: scaling(1, 1, 1), material: glass, texture: null, normalMap: null }
    const scene = new RTScene([inst])
    const bvh = new BVH(scene)
    const sky = (dx: number, dy: number, dz: number): Vec3 => [0.6 + 0.4 * dx, 0.6 + 0.4 * dy, 0.6 + 0.4 * dz]
    const ctx: RTContext = {
      scene, bvh, lights: [], env: null, ambient: [0, 0, 0],
      sky, maxBounces: 6, sunCosHalf: 1, lightRadius: 0, aoRadius: 1e30, mis: true, heroCount: 4,
    }
    const one = furnaceStats(ctx, 1, 90000, 0x9a55)
    const four = furnaceStats(ctx, 4, 90000, 0x9a55)
    const dMean = Math.max(
      Math.abs(one.mean[0] - four.mean[0]), Math.abs(one.mean[1] - four.mean[1]), Math.abs(one.mean[2] - four.mean[2]))
    add('Dispersive glass parity (secondary termination unbiased)', dMean < 0.02,
      `SF10 sphere: C=4 mean (${four.mean[0].toFixed(3)},${four.mean[1].toFixed(3)},${four.mean[2].toFixed(3)}) vs 1λ (${one.mean[0].toFixed(3)},${one.mean[1].toFixed(3)},${one.mean[2].toFixed(3)}), max|Δ|=${dMean.toFixed(4)}`)
  }

  return tests
}
