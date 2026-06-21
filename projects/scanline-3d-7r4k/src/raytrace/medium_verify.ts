// In-app numerical self-test of the volumetric participating-media layer. Each check
// re-derives a claim from an independent reference: the Henyey–Greenstein phase
// function against its closed form and the requirement ∫p dω = 1, the spectral
// distance sampler and the Woodcock trackers against the analytic Beer–Lambert
// transmittance, and a multiple-scattering FURNACE that proves the whole volumetric
// integrator conserves energy. It runs live in the browser; nothing here touches the
// DOM. (Mirrors raytrace/verify.ts.)
import type { Vec3 } from '../math/vec.ts'
import { Rng, uniformSphere } from './sampling.ts'
import {
  deltaTrackCore, mediumTransmittance, phaseHG, ratioTrackCore,
  sampleHomogeneousDistance, samplePhaseHG, type DistanceSample, type Medium,
} from './medium.ts'
import { RTScene } from './rtscene.ts'
import { BVH } from './bvh.ts'
import { tracePath } from './tracer.ts'
import type { RTContext } from './tracer.ts'

export interface MediumTest {
  name: string
  pass: boolean
  detail: string
}

const PI = Math.PI

// A homogeneous medium filling a box, with a chosen extinction / scattering / g.
function homogeneous(sigmaT: Vec3, sigmaS: Vec3, g: number, half = 4): Medium {
  return {
    minx: -half, miny: -half, minz: -half, maxx: half, maxy: half, maxz: half,
    sigmaT, sigmaS, g, heterogeneous: false,
    sigmaMax: Math.max(sigmaT[0], sigmaT[1], sigmaT[2]),
    albedo: [sigmaS[0] / (sigmaT[0] || 1), sigmaS[1] / (sigmaT[1] || 1), sigmaS[2] / (sigmaT[2] || 1)],
    noiseFreq: 0.4, noiseOctaves: 4, densityFloor: 0.3, edgeFalloff: 0,
  }
}

export function runMediumSelfTest(): MediumTest[] {
  const tests: MediumTest[] = []
  const add = (name: string, pass: boolean, detail: string): void => { tests.push({ name, pass, detail }) }

  // 1 — Henyey–Greenstein phase function integrates to 1 over the sphere (∫p dω = 1).
  // Monte-Carlo: E_uniform[p]·4π = 1, for forward, isotropic and backward anisotropy.
  {
    const rng = new Rng(0xa11ce)
    const gs = [0, 0.4, -0.6, 0.85]
    let worst = 0
    for (const g of gs) {
      let sum = 0
      const N = 60000
      for (let k = 0; k < N; k++) {
        const d = uniformSphere(rng.next(), rng.next())
        sum += phaseHG(g, d[2]) // cosθ to the +Z axis
      }
      const integral = (sum / N) * 4 * PI
      worst = Math.max(worst, Math.abs(integral - 1))
    }
    add('HG phase normalises (∫p dω = 1)', worst < 0.02, `max |∫−1| = ${worst.toExponential(1)} over g∈{0,0.4,−0.6,0.85}`)
  }

  // 2 — at g=0 the phase is exactly isotropic (1/4π); g>0 peaks forward, g<0 backward.
  {
    const iso = 1 / (4 * PI)
    const flat = Math.abs(phaseHG(0, 0.3) - iso) < 1e-12 && Math.abs(phaseHG(0, -0.7) - iso) < 1e-12
    const fwd = phaseHG(0.6, 1) > phaseHG(0.6, -1)
    const back = phaseHG(-0.6, -1) > phaseHG(-0.6, 1)
    add('HG isotropy & forward/back peak', flat && fwd && back,
      `p(g=0)=1/4π=${iso.toFixed(4)} (exact); forward g>0 ✓; backward g<0 ✓`)
  }

  // 3 — HG importance sampling reproduces the mean cosine E[cosθ] = g (the asymmetry
  // parameter's defining property) and every sample is a unit vector.
  {
    const rng = new Rng(0x5eed)
    const gs = [0, 0.3, -0.5, 0.8]
    let worst = 0, maxUnit = 0
    for (const g of gs) {
      let sum = 0
      const N = 40000
      for (let k = 0; k < N; k++) {
        const d = samplePhaseHG(g, 0, 0, 1, rng.next(), rng.next()) // forward axis = +Z
        sum += d[2] // cosθ to +Z
        maxUnit = Math.max(maxUnit, Math.abs(Math.hypot(d[0], d[1], d[2]) - 1))
      }
      worst = Math.max(worst, Math.abs(sum / N - g))
    }
    add('HG sampling: E[cosθ] = g', worst < 0.01 && maxUnit < 1e-6,
      `max |E[cosθ]−g| = ${worst.toFixed(4)}, all unit (Δ=${maxUnit.toExponential(1)})`)
  }

  // 4 — homogeneous transmittance is analytic Beer–Lambert and multiplicative across a
  // split: T(L) = exp(−σ_t·L) and T(L) = T(L/2)². (Deterministic — no sampling.)
  {
    const m = homogeneous([0.5, 0.5, 0.5], [0.25, 0.25, 0.25], 0)
    const rng = new Rng(1)
    // ray along +x from x=−4 (box edge) for length L=8 → full span 8
    const T = mediumTransmittance(m, -4, 0, 0, 1, 0, 0, 8, rng)
    const expected = Math.exp(-0.5 * 8)
    const beer = Math.abs(T[0] - expected) < 1e-9
    // multiplicativity: cross half (length 4 → enters box at t=0, spans 4) squared
    const Th = mediumTransmittance(m, 0, 0, 0, 1, 0, 0, 4, rng) // from centre to +x face
    const mult = Math.abs(Th[0] * Th[0] - Math.exp(-0.5 * 8)) < 1e-9
    add('Homogeneous Beer–Lambert + multiplicative', beer && mult,
      `T(8)=${T[0].toFixed(5)} vs e^−4=${expected.toFixed(5)}; T(4)²=${(Th[0] * Th[0]).toFixed(5)}`)
  }

  // 5 — the spectral (per-RGB) distance sampler is UNBIASED: the mean transmittance it
  // reports on escape reproduces exp(−σ_t·L) independently in every colour channel
  // (this is what lets fog be coloured without bias).
  {
    const sigmaT: Vec3 = [0.3, 0.8, 1.5]
    const sigmaS: Vec3 = [0.2, 0.5, 1.0]
    const L = 1.6
    const rng = new Rng(0xc0ffee)
    const out: DistanceSample = { scatter: false, t: 0, wr: 1, wg: 1, wb: 1 }
    let er = 0, eg = 0, eb = 0
    const N = 400000
    for (let k = 0; k < N; k++) {
      sampleHomogeneousDistance(sigmaT, sigmaS, L, rng, out)
      if (!out.scatter) { er += out.wr; eg += out.wg; eb += out.wb } // escape carries the transmittance weight
    }
    er /= N; eg /= N; eb /= N
    const tr: Vec3 = [Math.exp(-sigmaT[0] * L), Math.exp(-sigmaT[1] * L), Math.exp(-sigmaT[2] * L)]
    const worst = Math.max(Math.abs(er - tr[0]), Math.abs(eg - tr[1]), Math.abs(eb - tr[2]))
    add('Spectral distance sampling unbiased', worst < 0.005,
      `E[T]=(${er.toFixed(3)},${eg.toFixed(3)},${eb.toFixed(3)}) vs analytic (${tr[0].toFixed(3)},${tr[1].toFixed(3)},${tr[2].toFixed(3)})`)
  }

  // 6 — Woodcock DELTA tracking is unbiased: with a constant density field the
  // probability of escaping a span equals exp(−σ_max·d·L) exactly.
  {
    const sigmaMax = 2.0, d = 0.6, L = 1.5
    const rng = new Rng(0xdada)
    const density = (): number => d
    let escapes = 0
    const N = 400000
    for (let k = 0; k < N; k++) if (deltaTrackCore(sigmaMax, density, 0, L, rng) < 0) escapes++
    const p = escapes / N
    const expected = Math.exp(-sigmaMax * d * L)
    add('Delta-tracking escape = e^(−σ_t·L)', Math.abs(p - expected) < 0.005,
      `P(escape)=${p.toFixed(4)} vs analytic ${expected.toFixed(4)} (σ_t=${(sigmaMax * d).toFixed(2)}, L=${L})`)
  }

  // 7 — Woodcock RATIO tracking is unbiased AND lower-variance: its mean reproduces the
  // same exp(−σ_t·L), with markedly smaller variance than the 0/1 delta estimator.
  {
    const sigmaMax = 2.0, d = 0.6, L = 1.5
    const rng = new Rng(0xfeed)
    const density = (): number => d
    let sum = 0, sumSq = 0
    const N = 200000
    for (let k = 0; k < N; k++) {
      const t = ratioTrackCore(sigmaMax, density, 0, L, rng)
      sum += t; sumSq += t * t
    }
    const mean = sum / N
    const varRatio = sumSq / N - mean * mean
    const expected = Math.exp(-sigmaMax * d * L)
    // delta tracking is a Bernoulli(p) estimator → variance p(1−p)
    const varDelta = expected * (1 - expected)
    const unbiased = Math.abs(mean - expected) < 0.005
    add('Ratio-tracking unbiased + low variance', unbiased && varRatio < varDelta,
      `E[T]=${mean.toFixed(4)} vs ${expected.toFixed(4)}; var ${varRatio.toFixed(4)} < delta var ${varDelta.toFixed(4)}`)
  }

  // 8 — volumetric FURNACE (energy conservation): a purely-scattering medium (albedo
  // σ_s/σ_t = 1, no absorption) inside a uniform unit sky and no geometry must
  // re-radiate ≈ unit radiance — multiple scattering creates and destroys no light.
  {
    const scene = new RTScene([]) // no surfaces — only the medium + sky
    const bvh = new BVH(scene)
    const sigma = 0.8
    const m = homogeneous([sigma, sigma, sigma], [sigma, sigma, sigma], 0.3, 3)
    const ctx: RTContext = {
      scene, bvh, lights: [], env: null, ambient: [0, 0, 0],
      sky: () => [1, 1, 1], maxBounces: 0, sunCosHalf: 1, lightRadius: 0, aoRadius: 1e30,
      medium: m,
    }
    const rng = new Rng(0xbada55)
    let sum = 0
    const N = 60000
    for (let k = 0; k < N; k++) {
      // fire from the box centre in a random direction; it should integrate to ~1
      const dir = uniformSphere(rng.next(), rng.next())
      const c = tracePath(0, 0, 0, dir[0], dir[1], dir[2], ctx, rng)
      sum += (c[0] + c[1] + c[2]) / 3
    }
    const avg = sum / N
    add('Volumetric furnace (energy conservation)', avg > 0.97 && avg < 1.03,
      `mean radiance ${avg.toFixed(4)} of unit sky (albedo-1 medium, multiple scattering)`)
  }

  return tests
}
