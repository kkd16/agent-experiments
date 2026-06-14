// selftest.ts — an in-app verification harness. Rather than trust the renderer
// by eye, these checks assert the mathematical invariants a correct path tracer
// must satisfy: energy conservation (white-furnace), exact acceleration-vs-brute
// agreement, sampler/pdf consistency, and the analytic Fresnel/Snell laws. They
// run in well under a second and surface as a pass/fail panel in the UI.

import { cross, dot, len, normalize, v, reflect, refract, luminance } from './vec3'
import { Rng } from './rng'
import { sampleBSDF, pdfBSDF, evalBSDF, resolveMaterial } from './material'
import type { Material } from './material'
import { makeSphere, intersectPrim } from './primitive'
import type { Primitive } from './primitive'
import { Bvh } from './bvh'
import { Scene } from './scene'
import { radiance } from './integrator'
import type { RayStats } from './integrator'
import type { SceneDef } from './types'
import { evalTexture } from './texture'
import type { Texture } from './texture'
import { cauchyIor, wavelengthWeight, LAMBDA_MIN, LAMBDA_MAX } from './spectrum'

export interface TestResult {
  name: string
  pass: boolean
  detail: string
}

const approx = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol

function test(name: string, fn: () => { pass: boolean; detail: string }): TestResult {
  try {
    const r = fn()
    return { name, pass: r.pass, detail: r.detail }
  } catch (e) {
    return { name, pass: false, detail: `threw: ${(e as Error).message}` }
  }
}

// 1 — Vector algebra identities.
function testVectorMath(): { pass: boolean; detail: string } {
  const a = v(1, 2, 3)
  const b = v(-2, 0.5, 4)
  const c = cross(a, b)
  const orthoA = Math.abs(dot(c, a))
  const orthoB = Math.abs(dot(c, b))
  const unit = len(normalize(v(3, -4, 12)))
  const ok = orthoA < 1e-9 && orthoB < 1e-9 && approx(unit, 1, 1e-9)
  return { pass: ok, detail: `c⊥a=${orthoA.toExponential(1)}, |n̂|=${unit.toFixed(6)}` }
}

// 2 — Reflection and Snell's law of refraction.
function testReflectRefract(): { pass: boolean; detail: string } {
  const n = v(0, 1, 0)
  const d = normalize(v(1, -1, 0)) // 45° incidence
  const r = reflect(d, n)
  const reflOk = approx(r.x, normalize(v(1, 1, 0)).x, 1e-9) && approx(r.y, normalize(v(1, 1, 0)).y, 1e-9)
  // Snell: n1 sinθ1 = n2 sinθ2, going from air(1) into glass(1.5).
  const eta = 1 / 1.5
  const t = refract(d, n, eta)
  let snellOk = false
  let s2 = NaN
  if (t) {
    const cosI = Math.abs(dot(d, n))
    const sinI = Math.sqrt(1 - cosI * cosI)
    const cosT = Math.abs(dot(normalize(t), n))
    const sinT = Math.sqrt(1 - cosT * cosT)
    s2 = sinT
    snellOk = approx(1.0 * sinI, 1.5 * sinT, 1e-6)
  }
  return { pass: reflOk && snellOk, detail: `reflect ok=${reflOk}, sinθt=${s2.toFixed(4)}` }
}

// 3 — RNG statistics: mean ≈ 1/2, variance ≈ 1/12, and reproducibility.
function testRng(): { pass: boolean; detail: string } {
  const N = 200000
  const r = new Rng(12345, 1)
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < N; i++) {
    const x = r.next()
    sum += x
    sumSq += x * x
  }
  const mean = sum / N
  const varc = sumSq / N - mean * mean
  // Determinism: same seed → same first draw.
  const a = new Rng(7, 3).next()
  const b = new Rng(7, 3).next()
  const ok = approx(mean, 0.5, 5e-3) && approx(varc, 1 / 12, 5e-3) && a === b
  return { pass: ok, detail: `mean=${mean.toFixed(4)}, var=${varc.toFixed(4)} (exp .0833), det=${a === b}` }
}

// 4 — Fresnel at normal incidence matches the Schlick/closed-form value.
function testFresnel(): { pass: boolean; detail: string } {
  // Use the dielectric BSDF's reflect/transmit split at normal incidence by
  // statistically estimating reflectance.
  const mat: Material = { kind: 'dielectric', ior: 1.5, tint: v(1, 1, 1) }
  const n = v(0, 0, 1)
  const wo = v(0, 0, 1) // normal incidence
  const rng = new Rng(99, 1)
  let reflCount = 0
  const N = 60000
  for (let i = 0; i < N; i++) {
    const s = sampleBSDF(mat, wo, n, true, rng)
    if (s && dot(s.wi, n) > 0) reflCount++ // reflected stays in the +z hemisphere
  }
  const f = reflCount / N
  const expected = ((1.5 - 1) / (1.5 + 1)) ** 2 // = 0.04
  const ok = approx(f, expected, 5e-3)
  return { pass: ok, detail: `F₀ measured=${f.toFixed(4)}, expected=${expected.toFixed(4)}` }
}

// 5 — GGX sampler/pdf consistency: the pdf reported by sampleBSDF must equal the
// analytic pdfBSDF for the very direction it generated.
function testGgxPdf(): { pass: boolean; detail: string } {
  const mat: Material = { kind: 'metal', albedo: v(1, 1, 1), roughness: 0.45 }
  const n = v(0, 0, 1)
  const wo = normalize(v(0.4, 0.1, 0.9))
  const rng = new Rng(2024, 5)
  let maxRel = 0
  const N = 20000
  for (let i = 0; i < N; i++) {
    const s = sampleBSDF(mat, wo, n, true, rng)
    if (!s || s.specular) continue
    const p = pdfBSDF(mat, wo, s.wi, n)
    const rel = Math.abs(p - s.pdf) / Math.max(1e-6, s.pdf)
    if (rel > maxRel) maxRel = rel
  }
  return { pass: maxRel < 1e-5, detail: `max |Δpdf|/pdf = ${maxRel.toExponential(2)}` }
}

// 6 — BVH agrees with brute force on the nearest hit for many random rays.
function testBvh(): { pass: boolean; detail: string } {
  const rng = new Rng(555, 9)
  const prims: Primitive[] = []
  for (let i = 0; i < 120; i++) {
    prims.push(makeSphere(v(rng.range(-5, 5), rng.range(-5, 5), rng.range(-5, 5)), rng.range(0.1, 0.6), 0))
  }
  const bvh = new Bvh(prims)
  let mismatches = 0
  const N = 4000
  for (let i = 0; i < N; i++) {
    const o = v(rng.range(-8, 8), rng.range(-8, 8), rng.range(-8, 8))
    const d = normalize(v(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)))
    // Brute force nearest.
    let bestT = Infinity
    let bestId = -1
    for (let p = 0; p < prims.length; p++) {
      const h = intersectPrim(prims[p], o, d, 1e-4, Infinity)
      if (h && h.t < bestT) {
        bestT = h.t
        bestId = p
      }
    }
    const r = bvh.intersect(o, d, 1e-4, Infinity)
    const gotId = r ? r.primId : -1
    const gotT = r ? r.hit.t : Infinity
    if (gotId !== bestId || (bestId >= 0 && !approx(gotT, bestT, 1e-4))) mismatches++
  }
  return { pass: mismatches === 0, detail: `${N} rays, ${mismatches} mismatch(es) vs brute force` }
}

// 7 — White-furnace: a diffuse object of albedo ρ in a uniform unit environment
// must reflect exactly ρ (no energy created or destroyed).
function furnace(mat: Material, albedoExpected: number): { pass: boolean; detail: string } {
  const def: SceneDef = {
    name: 'furnace',
    materials: [mat],
    prims: [{ kind: 'sphere', center: v(0, 0, 0), radius: 1, material: 0 }],
    camera: {
      eye: v(0, 0, 5),
      target: v(0, 0, 0),
      up: v(0, 1, 0),
      vfovDeg: 30,
      aperture: 0,
      focusDist: 5,
    },
    env: { kind: 'solid', color: v(1, 1, 1) },
  }
  const scene = new Scene(def)
  const rng = new Rng(31337, 2)
  const settings = { maxDepth: 12, rrStart: 6, clampIndirect: 0 }
  const stats: RayStats = { rays: 0 }
  const N = 20000
  let sum = 0
  for (let i = 0; i < N; i++) {
    // A primary ray straight at the centre of the sphere.
    const ray = { o: v(0, 0, 5), d: v(0, 0, -1), tMax: Infinity }
    const L = radiance(scene, ray, settings, rng, stats)
    sum += luminance(L)
  }
  const measured = sum / N
  const ok = approx(measured, albedoExpected, 1.5e-2)
  return { pass: ok, detail: `reflectance=${measured.toFixed(4)}, expected≈${albedoExpected.toFixed(3)}` }
}

// 8 — Energy bound for a rough metal: single-scatter microfacet loses a little
// energy, so reflectance must lie in (0,1) — never above one.
function testMetalEnergy(): { pass: boolean; detail: string } {
  const mat: Material = { kind: 'metal', albedo: v(1, 1, 1), roughness: 0.5 }
  const n = v(0, 0, 1)
  const wo = normalize(v(0.2, 0.0, 0.98))
  const rng = new Rng(8, 4)
  let sum = 0
  const N = 40000
  for (let i = 0; i < N; i++) {
    const s = sampleBSDF(mat, wo, n, true, rng)
    if (s) sum += luminance(s.weight) // weight = f·cos/pdf, so E[weight]=reflectance
  }
  const refl = sum / N
  return { pass: refl > 0.3 && refl <= 1.0001, detail: `directional reflectance=${refl.toFixed(4)} (≤1)` }
}

// 9 — evalBSDF symmetry for diffuse (Helmholtz reciprocity f(wo,wi)=f(wi,wo)).
function testReciprocity(): { pass: boolean; detail: string } {
  const mat: Material = { kind: 'diffuse', albedo: v(0.6, 0.3, 0.9) }
  const n = v(0, 0, 1)
  const wo = normalize(v(0.3, 0.4, 0.8))
  const wi = normalize(v(-0.5, 0.2, 0.7))
  const a = evalBSDF(mat, wo, wi, n)
  const b = evalBSDF(mat, wi, wo, n)
  const ok = approx(a.x, b.x, 1e-12) && approx(a.y, b.y, 1e-12) && approx(a.z, b.z, 1e-12)
  return { pass: ok, detail: `f(wo,wi)=${a.x.toFixed(4)} vs f(wi,wo)=${b.x.toFixed(4)}` }
}

// 10 — Procedural texture sanity: the checker alternates between its two colours
// on adjacent cells, and marble stays inside its [lo,hi] colour envelope.
function testTexture(): { pass: boolean; detail: string } {
  const checker: Texture = { kind: 'checker', even: v(1, 1, 1), odd: v(0, 0, 0), scale: 1 }
  // Cells (0,0,0) and (1,0,0) differ in parity ⇒ must differ in colour.
  const a = evalTexture(checker, v(0.5, 0.5, 0.5))
  const b = evalTexture(checker, v(1.5, 0.5, 0.5))
  const alternates = a.x !== b.x
  // Marble must remain a convex blend of lo/hi (here [0,1]) at every sample.
  const marble: Texture = { kind: 'marble', lo: v(0, 0, 0), hi: v(1, 1, 1), scale: 1.3, turbulence: 1 }
  let inRange = true
  const rng = new Rng(4242, 1)
  for (let i = 0; i < 5000; i++) {
    const p = v(rng.range(-9, 9), rng.range(-9, 9), rng.range(-9, 9))
    const c = evalTexture(marble, p)
    if (c.x < -1e-6 || c.x > 1 + 1e-6) inRange = false
  }
  return { pass: alternates && inRange, detail: `checker alternates=${alternates}, marble∈[lo,hi]=${inRange}` }
}

// 11 — Spectral white point: a flat (equal-energy) spectrum must integrate back
// to neutral white, i.e. E_λ[wavelengthWeight] ≈ (1,1,1). This is what keeps
// dispersive glass colour-neutral overall while tinting each refracted ray.
function testSpectralWhitePoint(): { pass: boolean; detail: string } {
  const rng = new Rng(909, 3)
  let sx = 0
  let sy = 0
  let sz = 0
  const N = 200000
  for (let i = 0; i < N; i++) {
    const lambda = LAMBDA_MIN + rng.next() * (LAMBDA_MAX - LAMBDA_MIN)
    const w = wavelengthWeight(lambda)
    sx += w.x
    sy += w.y
    sz += w.z
  }
  const mx = sx / N
  const my = sy / N
  const mz = sz / N
  const ok = approx(mx, 1, 1e-2) && approx(my, 1, 1e-2) && approx(mz, 1, 1e-2)
  return { pass: ok, detail: `mean weight=(${mx.toFixed(3)}, ${my.toFixed(3)}, ${mz.toFixed(3)})` }
}

// 12 — Cauchy dispersion: blue light (450 nm) must refract more strongly than red
// (650 nm), i.e. carry a higher index of refraction, and n(589 nm) = base.
function testDispersion(): { pass: boolean; detail: string } {
  const base = 1.5
  const b = 0.012
  const nBlue = cauchyIor(base, b, 450)
  const nRed = cauchyIor(base, b, 650)
  const nD = cauchyIor(base, b, 589)
  const ok = nBlue > nRed && approx(nD, base, 1e-6)
  return { pass: ok, detail: `n(450)=${nBlue.toFixed(4)} > n(650)=${nRed.toFixed(4)}, n(589)=${nD.toFixed(4)}` }
}

// 13 — Rough dielectric energy conservation (white furnace). A *clear* frosted
// glass sphere (no absorption) in a uniform unit environment must return ≈ 1: the
// per-bounce radiance scaling (1/eta² entering, eta² leaving) cancels round-trip,
// so the only deficit is the small single-scatter microfacet loss — never a gain.
function testRoughDielectricEnergy(): { pass: boolean; detail: string } {
  const def: SceneDef = {
    name: 'rough-furnace',
    materials: [{ kind: 'dielectric', ior: 1.5, tint: v(1, 1, 1), roughness: 0.3 }],
    prims: [{ kind: 'sphere', center: v(0, 0, 0), radius: 1, material: 0 }],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 30, aperture: 0, focusDist: 5 },
    env: { kind: 'solid', color: v(1, 1, 1) },
  }
  const scene = new Scene(def)
  const rng = new Rng(13, 7)
  const settings = { maxDepth: 24, rrStart: 10, clampIndirect: 0 }
  const stats: RayStats = { rays: 0 }
  const N = 30000
  let sum = 0
  for (let i = 0; i < N; i++) {
    const L = radiance(scene, { o: v(0, 0, 5), d: v(0, 0, -1), tMax: Infinity }, settings, rng, stats)
    sum += luminance(L)
  }
  const measured = sum / N
  // Single-scatter microfacet loses a little energy; gains are forbidden.
  return { pass: measured > 0.85 && measured <= 1.01, detail: `furnace reflectance=${measured.toFixed(4)} (≤1)` }
}

// 14 — Beer–Lambert absorption: a clear glass sphere in a white furnace tints the
// transmitted light by the medium's absorption. Absorbing blue must leave the
// exiting radiance redder (B < R), and stronger absorption must darken it.
function testBeerLambert(): { pass: boolean; detail: string } {
  const make = (absorption: ReturnType<typeof v> | undefined): SceneDef => ({
    name: 'beer',
    materials: [{ kind: 'dielectric', ior: 1.5, tint: v(1, 1, 1), absorption }],
    prims: [{ kind: 'sphere', center: v(0, 0, 0), radius: 1, material: 0 }],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 30, aperture: 0, focusDist: 5 },
    env: { kind: 'solid', color: v(1, 1, 1) },
  })
  const settings = { maxDepth: 16, rrStart: 8, clampIndirect: 0 }
  const measure = (absorption: ReturnType<typeof v> | undefined): ReturnType<typeof v> => {
    const scene = new Scene(make(absorption))
    const rng = new Rng(2718, 5)
    const stats: RayStats = { rays: 0 }
    let r = 0
    let g = 0
    let bb = 0
    const N = 8000
    for (let i = 0; i < N; i++) {
      const L = radiance(scene, { o: v(0, 0, 5), d: v(0, 0, -1), tMax: Infinity }, settings, rng, stats)
      r += L.x
      g += L.y
      bb += L.z
    }
    return v(r / N, g / N, bb / N)
  }
  const clear = measure(undefined)
  const blueAbsorbed = measure(v(0, 0, 3)) // strongly absorb the blue channel
  // Clear glass in a unit furnace transmits ≈ white; absorbing blue reddens it
  // and lowers its blue below the clear reference.
  const reddened = blueAbsorbed.z < blueAbsorbed.x - 0.05
  const darkenedBlue = blueAbsorbed.z < clear.z - 0.05
  const ok = reddened && darkenedBlue && clear.x > 0.5
  return {
    pass: ok,
    detail: `clear.z=${clear.z.toFixed(3)}, absorbed.z=${blueAbsorbed.z.toFixed(3)}, absorbed.x=${blueAbsorbed.x.toFixed(3)}`,
  }
}

// 15 — resolveMaterial bakes a texture into a flat albedo at the hit point, so
// the BSDF never sees the texture. Two points in opposite checker cells resolve
// to the two checker colours.
function testResolveTexture(): { pass: boolean; detail: string } {
  const tex: Texture = { kind: 'checker', even: v(0.9, 0.1, 0.1), odd: v(0.1, 0.1, 0.9), scale: 1 }
  const mat: Material = { kind: 'diffuse', albedo: v(0, 0, 0), tex }
  const r0 = resolveMaterial(mat, v(0.5, 0.5, 0.5), 0)
  const r1 = resolveMaterial(mat, v(1.5, 0.5, 0.5), 0)
  const ok =
    r0.kind === 'diffuse' &&
    r1.kind === 'diffuse' &&
    r0.tex === undefined &&
    r0.albedo.x !== r1.albedo.x
  return { pass: ok, detail: `cell0.r=${(r0 as { albedo: { x: number } }).albedo.x}, cell1.r=${(r1 as { albedo: { x: number } }).albedo.x}` }
}

export function runSelfTests(): TestResult[] {
  return [
    test('Vector algebra identities', testVectorMath),
    test('Reflection & Snell refraction', testReflectRefract),
    test('RNG mean / variance / determinism', testRng),
    test('Fresnel reflectance at normal incidence', testFresnel),
    test('GGX sampler ↔ analytic pdf', testGgxPdf),
    test('BVH vs brute-force nearest hit', testBvh),
    test('White furnace — diffuse ρ=0.8', () => furnace({ kind: 'diffuse', albedo: v(0.8, 0.8, 0.8) }, 0.8)),
    test('White furnace — mirror ρ=1', () => furnace({ kind: 'metal', albedo: v(1, 1, 1), roughness: 0 }, 1)),
    test('Rough-metal energy ≤ 1', testMetalEnergy),
    test('Diffuse Helmholtz reciprocity', testReciprocity),
    test('Procedural texture parity & range', testTexture),
    test('Spectral white point E_λ[w]=1', testSpectralWhitePoint),
    test('Cauchy dispersion n(blue) > n(red)', testDispersion),
    test('Rough dielectric energy ≤ 1', testRoughDielectricEnergy),
    test('Beer–Lambert absorption tints glass', testBeerLambert),
    test('resolveMaterial bakes texture albedo', testResolveTexture),
  ]
}
