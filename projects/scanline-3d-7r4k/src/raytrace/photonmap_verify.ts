// In-app numerical self-test of the v12 photon-mapped caustics. Each check re-derives a
// claim from an independent reference — the two gather kernels each integrate to 1, the
// spatial-hash grid ≡ a brute-force radius search, a beam on a ⟂ plane reconstructs its
// analytic irradiance, the specular gate deposits nothing without glass, a lens sphere
// concentrates flux into a bright cusp, the estimate converges as √N, and a dispersive
// glass fans violet farther than red — the physics of a rainbow. Pure and DOM-free.
import type { Vec3 } from '../math/vec.ts'
import { buildMesh } from '../geometry/mesh.ts'
import { scaling, multiply, translation } from '../math/mat4.ts'
import { RTScene } from './rtscene.ts'
import type { RTInstance } from './rtscene.ts'
import { BVH } from './bvh.ts'
import { refract } from './dielectric.ts'
import { Rng } from './sampling.ts'
import { PhotonMap, PhotonGrid, kernelWeight, photonIor } from './photonmap.ts'
import type { CausticOptions } from './photonmap.ts'
import type { Light, Material } from '../render/shading.ts'

export interface PhotonTest {
  name: string
  pass: boolean
  detail: string
}

const PI = Math.PI
const white: Material = { albedo: [1, 1, 1], specular: 0.5, shininess: 32, rim: 0, metallic: 0, roughness: 0.9 }
const glassMat = (ior: number, dispersion = 0, glass = ''): Material =>
  ({ albedo: [1, 1, 1], specular: 0.9, shininess: 120, rim: 0, metallic: 0, roughness: 0, transmission: 1, ior, attenuation: [0, 0, 0], dispersion, glass })

const opts = (o: Partial<CausticOptions>): CausticOptions => ({
  photons: 100_000, radius: 0.2, kernel: 'constant', spectral: false,
  maxBounces: 12, depositDirect: false, mirror: false, intensity: 1, ...o,
})

// A large flat diffuse plane at y = 0 (unit quad, +Y normal, scaled out).
const groundPlane = (size: number): RTInstance =>
  ({ mesh: buildMesh('quad'), model: scaling(size, 1, size), material: white, texture: null, normalMap: null })

// A sun straight down, irradiance E⊥ = colour·intensity.
const sun = (intensity: number): Light => ({ type: 'dir', direction: [0, -1, 0], color: [1, 1, 1], intensity })

export function runPhotonSelfTest(): PhotonTest[] {
  const tests: PhotonTest[] = []
  const add = (name: string, pass: boolean, detail: string): void => { tests.push({ name, pass, detail }) }

  // 1 — both reconstruction kernels integrate to 1 over the gather disc (∫₀^r K·2πd dd = 1),
  // the property that makes the density estimate an unbiased irradiance.
  {
    const r = 0.3
    const integ = (kernel: 'constant' | 'cone'): number => {
      let s = 0; const N = 6000; const dd = r / N
      for (let i = 0; i < N; i++) { const d = (i + 0.5) * dd; s += kernelWeight(kernel, d, r) * 2 * PI * d * dd }
      return s
    }
    const ic = integ('constant'), ik = integ('cone')
    const ok = Math.abs(ic - 1) < 2e-3 && Math.abs(ik - 1) < 2e-3
    add('Gather kernels integrate to 1', ok, `∫ constant = ${ic.toFixed(4)}, ∫ cone = ${ik.toFixed(4)} (both = 1 ⇒ unbiased density estimate)`)
  }

  // 2 — the spatial-hash grid returns exactly the brute-force radius search. Random photons
  // on one plane (shared normal so the gate always passes); compare the gathered flux sum.
  {
    const r = 0.25
    const grid = new PhotonGrid(5000, r)
    const rng = new Rng(0x51c0ffee)
    const n: Vec3 = [0, 1, 0]
    for (let i = 0; i < 4000; i++) {
      const x = (rng.next() * 2 - 1) * 3, z = (rng.next() * 2 - 1) * 3
      grid.add(x, 0, z, rng.next(), rng.next(), rng.next(), n[0], n[1], n[2])
    }
    grid.finalize()
    const out = new Float64Array(3)
    let maxErr = 0
    for (let q = 0; q < 300; q++) {
      const qx = (rng.next() * 2 - 1) * 3, qz = (rng.next() * 2 - 1) * 3
      grid.gather(qx, 0, qz, 0, 1, 0, r, 'constant', out)
      // brute-force reference over the same photon arrays, same kernel + gate
      let br = 0, bg = 0, bb = 0
      for (let p = 0; p < grid.count; p++) {
        const dx = grid.px[p] - qx, dz = grid.pz[p] - qz
        const d = Math.hypot(dx, grid.py[p] - 0, dz)
        if (d > r) continue
        const w = kernelWeight('constant', d, r)
        br += grid.fr[p] * w; bg += grid.fg[p] * w; bb += grid.fb[p] * w
      }
      maxErr = Math.max(maxErr, Math.abs(out[0] - br), Math.abs(out[1] - bg), Math.abs(out[2] - bb))
    }
    add('Grid gather ≡ brute-force radius search', maxErr < 1e-9, `4000 photons, 300 queries, max |Δflux| = ${maxErr.toExponential(1)}`)
  }

  // 3 — irradiance reproduction: a beam of irradiance E⊥ on a plane ⟂ to it reconstructs E⊥
  // (the estimate carries the beam's foreshortening in the photon density, so no cosine is
  // applied by hand). depositDirect deposits the L→D photons this global test needs.
  {
    const scene = new RTScene([groundPlane(6)])
    const bvh = new BVH(scene)
    const pm = new PhotonMap()
    const E = 2
    pm.build(scene, bvh, [sun(E)], opts({ photons: 220_000, radius: 0.3, depositDirect: true }))
    const out = new Float64Array(3)
    // albedo = π cancels the /π in the estimate, so `out` is the raw irradiance E
    pm.estimate(0, 0, 0, 0, 1, 0, PI, PI, PI, out)
    const err = Math.abs(out[1] - E) / E
    add('Irradiance reproduction (beam ⟂ plane)', err < 0.02, `E_est = ${out[1].toFixed(4)} vs E⊥ = ${E} (${(err * 100).toFixed(2)}% error, ${pm.stats.stored.toLocaleString()} photons)`)
  }

  // 4 — the specular gate: a glass-free scene deposits ZERO caustic photons (direct L→D is
  // the path tracer's job); adding a glass sphere deposits many, every one flagged specular.
  {
    const bare = new RTScene([groundPlane(8)])
    const pmA = new PhotonMap()
    pmA.build(bare, new BVH(bare), [sun(2)], opts({ photons: 60_000, radius: 0.12, kernel: 'cone' }))
    const withGlass = new RTScene([
      groundPlane(8),
      { mesh: buildMesh('sphere'), model: multiply(translation(0, 1.4, 0), scaling(0.8, 0.8, 0.8)), material: glassMat(1.5), texture: null, normalMap: null },
    ])
    const pmB = new PhotonMap()
    pmB.build(withGlass, new BVH(withGlass), [sun(2)], opts({ photons: 200_000, radius: 0.08, maxBounces: 16 }))
    const ok = pmA.stats.stored === 0 && pmB.stats.stored > 1000 && pmB.stats.specularHits === pmB.stats.stored
    add('Specular gate (only L(S⁺)D deposited)', ok, `no glass → ${pmA.stats.stored} photons; glass sphere → ${pmB.stats.stored.toLocaleString()} (all ${pmB.stats.specularHits === pmB.stats.stored ? 'specular' : 'MIXED'})`)
  }

  // 5 — flux concentration: a glass sphere is a lens; it gathers the beam into a bright caustic
  // cusp, so the peak irradiance on the floor is many times the mean over the lit region (a
  // uniform illuminant would give peak ≈ mean). This is the signature that light is *focused*.
  {
    const scene = new RTScene([
      groundPlane(10),
      { mesh: buildMesh('sphere'), model: multiply(translation(0, 1.4, 0), scaling(0.8, 0.8, 0.8)), material: glassMat(1.5), texture: null, normalMap: null },
    ])
    const pm = new PhotonMap()
    pm.build(scene, new BVH(scene), [sun(2)], opts({ photons: 300_000, radius: 0.08, maxBounces: 16 }))
    const out = new Float64Array(3)
    let peak = 0, sum = 0, cnt = 0
    for (let x = -2; x <= 2; x += 0.05) {
      for (let z = -2; z <= 2; z += 0.05) {
        pm.estimate(x, 0, z, 0, 1, 0, PI, PI, PI, out)
        const e = out[1]
        if (e > peak) peak = e
        if (e > 1e-4) { sum += e; cnt++ }
      }
    }
    const meanLit = sum / Math.max(1, cnt)
    const ratio = peak / Math.max(1e-6, meanLit)
    add('Flux concentration (a sphere focuses)', ratio > 3, `peak irradiance ${peak.toFixed(3)} = ${ratio.toFixed(1)}× the mean over the lit region (a caustic cusp; uniform light ⇒ ≈1×)`)
  }

  // 6 — √N convergence: 4× the photons ≈ halves the estimate's noise. On a uniformly-lit plane
  // the true irradiance is flat, so the spatial standard deviation of E is pure estimator
  // noise; it should scale ∝ 1/√N (a 2× drop for 4× the photons).
  {
    const scene = new RTScene([groundPlane(8)])
    const bvh = new BVH(scene)
    const relNoise = (n: number): number => {
      const pm = new PhotonMap()
      pm.build(scene, bvh, [sun(2)], opts({ photons: n, radius: 0.25, depositDirect: true, maxBounces: 8 }))
      const out = new Float64Array(3)
      let s = 0, s2 = 0, c = 0
      for (let x = -1.5; x <= 1.5; x += 0.1) {
        for (let z = -1.5; z <= 1.5; z += 0.1) {
          pm.estimate(x, 0, z, 0, 1, 0, PI, PI, PI, out)
          const e = out[1]; s += e; s2 += e * e; c++
        }
      }
      const m = s / c; const v = Math.max(0, s2 / c - m * m)
      return Math.sqrt(v) / m
    }
    const n1 = relNoise(60_000), n4 = relNoise(240_000)
    const ratio = n1 / Math.max(1e-9, n4)
    add('√N convergence (4× photons ⇒ ½ noise)', ratio > 1.5, `relative noise ${n1.toFixed(4)} → ${n4.toFixed(4)} for 4× photons (${ratio.toFixed(2)}×, ideal 2×)`)
  }

  // 7 — spectral dispersion: the caustic pass bends violet more than red. First the physics —
  // SF10's Sellmeier index is higher at 440 nm than 650 nm, so a violet photon deviates more at
  // a glass facet. Then end-to-end — a dispersive glass sphere in spectral mode deposits photons
  // of genuinely varied hue (a rainbow spread), which a wavelength-independent pass cannot make.
  {
    const dsc = new RTScene([{ mesh: buildMesh('sphere'), model: scaling(1, 1, 1), material: glassMat(1.62, 1.6, 'sf10'), texture: null, normalMap: null }])
    const mat = dsc.materials[0]
    const nR = photonIor(mat, 650, true), nV = photonIor(mat, 440, true)
    const N: Vec3 = [Math.sin(0.5), Math.cos(0.5), 0] // a tilted facet
    const I: Vec3 = [0, -1, 0]
    const oR = new Float64Array(3), oV = new Float64Array(3)
    refract(I[0], I[1], I[2], N[0], N[1], N[2], 1 / nR, oR)
    refract(I[0], I[1], I[2], N[0], N[1], N[2], 1 / nV, oV)
    const dev = (o: Float64Array): number => Math.acos(Math.max(-1, Math.min(1, o[0] * I[0] + o[1] * I[1] + o[2] * I[2])))
    const devR = dev(oR), devV = dev(oV)
    // end-to-end hue spread on a receiver
    const scene = new RTScene([
      groundPlane(10),
      { mesh: buildMesh('sphere'), model: multiply(translation(0, 1.4, 0), scaling(0.8, 0.8, 0.8)), material: glassMat(1.62, 1.6, 'sf10'), texture: null, normalMap: null },
    ])
    const pm = new PhotonMap()
    pm.build(scene, new BVH(scene), [sun(2)], opts({ photons: 300_000, radius: 0.08, spectral: true, maxBounces: 16 }))
    // count photons whose deposited flux is red-dominant vs blue-dominant
    const store = pm.photons()
    let redN = 0, blueN = 0
    for (let p = 0; store && p < store.count; p++) {
      const r = store.fr[p], b = store.fb[p]
      if (r > b * 1.15) redN++
      else if (b > r * 1.15) blueN++
    }
    const hueSpread = redN > 50 && blueN > 50
    const ok = nV > nR && devV > devR && hueSpread
    add('Spectral dispersion (violet bends past red)', ok, `n(440)=${nV.toFixed(4)} > n(650)=${nR.toFixed(4)}; deviation ${devV.toFixed(4)} > ${devR.toFixed(4)}; deposits span hue (${redN.toLocaleString()} red / ${blueN.toLocaleString()} blue)`)
  }

  return tests
}
