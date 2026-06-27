// selftest.ts — an in-app verification harness. Rather than trust the renderer
// by eye, these checks assert the mathematical invariants a correct path tracer
// must satisfy: energy conservation (white-furnace), exact acceleration-vs-brute
// agreement, sampler/pdf consistency, and the analytic Fresnel/Snell laws. They
// run in well under a second and surface as a pass/fail panel in the UI.

import { add, cross, dot, len, normalize, onb, scale, sub, v, reflect, refract, luminance } from './vec3'
import type { Vec3 } from './vec3'
import { Rng } from './rng'
import {
  sampleBSDF,
  pdfBSDF,
  evalBSDF,
  resolveMaterial,
  ggxDirectionalAlbedo,
  ggxAverageAlbedo,
} from './material'
import type { Material, Subsurface } from './material'
import { spectralAt, subsurfacePreset, BSSRDF_MEASUREMENTS, LAMBDA_R, LAMBDA_G, LAMBDA_B } from './subsurface'
import type { MediumName } from './subsurface'
import { planck, blackbody } from './blackbody'
import { agx, agxContrast } from './tonemap'
import { makeSphere, makeTriangle, intersectPrim } from './primitive'
import type { Primitive } from './primitive'
import { buildLightTree } from './lighttree'
import {
  sampleSphereLight,
  sphereDirPdf,
  sphereConeCosMax,
  sphereSolidAngle,
  sphereIrradianceFull,
} from './spherelight'
import type { PrimDef } from './types'
import { Bvh } from './bvh'
import { Scene } from './scene'
import { EnvMap, Distribution2D } from './envmap'
import type { HdriPreset } from './envmap'
import { radiance } from './integrator'
import type { RayStats } from './integrator'
import { Guide, DTree, dirToSquare, squareToDir } from './guiding'
import { radianceBDPT, areaDensity, misPartitionResidual } from './bdpt'
import { Camera, sampleAperture } from './camera'
import {
  applyBloom,
  applyVignette,
  naturalVignetteFactor,
  chromaticAberration,
  applyGrain,
  grainEnvelope,
  postProcessHdr,
  postProcessDisplay,
  POST_OFF,
} from './postprocess'
import { MltState, PssmltSampler } from './pssmlt'
import { renderSPPM, HashGrid } from './sppm'
import type { SceneDef } from './types'
import { evalTexture } from './texture'
import type { Texture } from './texture'
import { cauchyIor, wavelengthWeight, LAMBDA_MIN, LAMBDA_MAX } from './spectrum'
import { icosphere, torus, meshTriangleCount } from './mesh'
import { parseObj, CUBE_OBJ } from './obj'
import { makeSky, skyRadiance } from './sky'
import { hgPhase, sampleHG } from './phase'
import { thinFilmReflectance } from './thinfilm'
import {
  fresnelConductor,
  conductorEta,
  conductorK,
  conductorF0RGB,
  conductorAverageFresnel,
} from './conductor'
import type { ConductorName } from './conductor'
import { radicalInverse } from './qmc'
import { valueNoise3, fbm3 } from './noise'
import { makeDensityField } from './volume'
import type { MediumDef } from './types'

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

// Directional-hemispherical reflectance of a BSDF, estimated by averaging the
// sampler's throughput weight (= f·cosθ/pdf) — exactly the quantity a white
// furnace integrates. Returns the luminance reflectance.
function directionalReflectance(mat: Material, wo: Vec3, seed: number, N = 60000): number {
  const n = v(0, 0, 1)
  const rng = new Rng(seed, 9)
  let sum = 0
  for (let i = 0; i < N; i++) {
    const s = sampleBSDF(mat, wo, n, true, rng)
    if (s) sum += luminance(s.weight)
  }
  return sum / N
}

// 8b — Kulla–Conty energy-compensation tables. The single-scatter directional
// albedo must be ~1 for a smooth lobe, drop with roughness, and stay in (0,1];
// and the hemisphere average must decrease monotonically as roughness rises
// (more energy lost between microfacets).
function testGgxAlbedoTable(): { pass: boolean; detail: string } {
  const smooth = ggxDirectionalAlbedo(0.7, 0.02)
  let inRange = true
  let maxE = 0
  for (let a = 0.05; a <= 1; a += 0.05) {
    for (let mu = 0.05; mu <= 1; mu += 0.05) {
      const e = ggxDirectionalAlbedo(mu, a)
      if (e < 0 || e > 1.001) inRange = false
      maxE = Math.max(maxE, e)
    }
  }
  const eLow = ggxAverageAlbedo(0.1)
  const eHigh = ggxAverageAlbedo(0.9)
  const ok = smooth > 0.97 && inRange && maxE <= 1.001 && eLow > eHigh && eHigh > 0.3
  return {
    pass: ok,
    detail: `E(smooth)=${smooth.toFixed(3)}, Eavg(0.1)=${eLow.toFixed(3)} > Eavg(0.9)=${eHigh.toFixed(3)}, ∈(0,1]=${inRange}`,
  }
}

// 8c — Multiscatter conductor conserves energy. A white rough metal with
// `multiscatter` must reflect ≈1 (the lost inter-microfacet energy restored),
// while the single-scatter lobe at the same roughness reflects noticeably less.
function testMetalMultiscatterEnergy(): { pass: boolean; detail: string } {
  const wo = normalize(v(0.25, 0, 0.97))
  const single = directionalReflectance({ kind: 'metal', albedo: v(1, 1, 1), roughness: 0.6 }, wo, 8)
  const multi = directionalReflectance(
    { kind: 'metal', albedo: v(1, 1, 1), roughness: 0.6, multiscatter: true },
    wo,
    9,
  )
  const ok = multi > 0.96 && multi <= 1.02 && single < multi - 0.02 && single < 0.97
  return {
    pass: ok,
    detail: `single-scatter=${single.toFixed(4)} → multiscatter=${multi.toFixed(4)} (≈1, energy restored)`,
  }
}

// 8d — Anisotropic GGX metal. Reciprocity must hold exactly; the lobe must be
// energy-bounded; and a non-zero anisotropy must make the two in-plane tangent
// directions carry visibly different pdfs (the brushed-metal streak).
function testAnisoMetal(): { pass: boolean; detail: string } {
  const mat: Material = { kind: 'metal', albedo: v(0.95, 0.93, 0.88), roughness: 0.35, aniso: 0.85 }
  const n = v(0, 0, 1)
  const wo = normalize(v(0.15, 0.1, 0.98))
  const wi = normalize(v(-0.4, 0.2, 0.7))
  const a = evalBSDF(mat, wo, wi, n)
  const b = evalBSDF(mat, wi, wo, n)
  const recip = approx(a.x, b.x, 1e-9) && approx(a.y, b.y, 1e-9) && approx(a.z, b.z, 1e-9)
  // Two wi at equal polar angle along the orthogonal tangent axes t and b.
  const { t, b: tb } = onb(n)
  const theta = 0.6
  const st = Math.sin(theta)
  const ct = Math.cos(theta)
  const wiT = add(scale(t, st), scale(n, ct))
  const wiB = add(scale(tb, st), scale(n, ct))
  const woN = v(0, 0, 1)
  const pT = pdfBSDF(mat, woN, wiT, n)
  const pB = pdfBSDF(mat, woN, wiB, n)
  const streak = Math.abs(pT - pB) / Math.max(1e-6, pT + pB) > 0.05
  const refl = directionalReflectance(mat, wo, 14)
  const ok = recip && streak && refl <= 1.0001 && refl > 0.3
  return {
    pass: ok,
    detail: `reciprocal=${recip}, pdf streak |${pT.toFixed(3)}−${pB.toFixed(3)}|, reflectance=${refl.toFixed(4)}`,
  }
}

// 8e — Oren–Nayar rough diffuse. Reciprocity holds; energy is bounded; and a
// rough surface back-scatters more than Lambert at grazing (the B term).
function testOrenNayar(): { pass: boolean; detail: string } {
  const oren: Material = { kind: 'diffuse', albedo: v(0.7, 0.7, 0.7), sigma: 0.6 }
  const lamb: Material = { kind: 'diffuse', albedo: v(0.7, 0.7, 0.7) }
  const n = v(0, 0, 1)
  // A grazing retro-reflection (wi ≈ wo, both near the horizon): the regime
  // where Oren–Nayar's B term lifts it above Lambert.
  const wo = normalize(v(0.92, 0, 0.39))
  const wi = normalize(v(0.88, 0.08, 0.46))
  const a = evalBSDF(oren, wo, wi, n)
  const b = evalBSDF(oren, wi, wo, n)
  const recip = approx(a.x, b.x, 1e-9) && approx(a.y, b.y, 1e-9)
  const fo = evalBSDF(oren, wo, wi, n).x
  const fl = evalBSDF(lamb, wo, wi, n).x
  const rougher = fo > fl
  const refl = directionalReflectance(oren, wo, 17)
  const ok = recip && rougher && refl <= 1.02 && refl > 0.4
  return {
    pass: ok,
    detail: `reciprocal=${recip}, f_oren=${fo.toFixed(4)} > f_lambert=${fl.toFixed(4)}, reflectance=${refl.toFixed(4)}`,
  }
}

// 8f — Clear-coat (layered) diffuse. Reciprocity holds; the layered stack is
// energy-bounded (≤1); and the coat adds a specular highlight not present on the
// bare diffuse base.
function testClearcoat(): { pass: boolean; detail: string } {
  const coated: Material = { kind: 'diffuse', albedo: v(0.6, 0.1, 0.1), coat: { roughness: 0.08, ior: 1.5 } }
  const bare: Material = { kind: 'diffuse', albedo: v(0.6, 0.1, 0.1) }
  const n = v(0, 0, 1)
  const wo = normalize(v(0.3, 0, 0.95))
  // Near the mirror direction of wo, where the coat's gloss lives.
  const wiSpec = normalize(v(-0.3, 0, 0.95))
  const a = evalBSDF(coated, wo, wiSpec, n)
  const b = evalBSDF(coated, wiSpec, wo, n)
  const recip = approx(a.x, b.x, 1e-9) && approx(a.y, b.y, 1e-9)
  const highlight = luminance(evalBSDF(coated, wo, wiSpec, n)) > luminance(evalBSDF(bare, wo, wiSpec, n)) + 1e-3
  const refl = directionalReflectance(coated, wo, 23)
  const ok = recip && highlight && refl <= 1.0 && refl > 0.2
  return {
    pass: ok,
    detail: `reciprocal=${recip}, coat adds gloss=${highlight}, reflectance=${refl.toFixed(4)} (≤1)`,
  }
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

// 16 — Smooth shading normal: a triangle carrying three vertex normals must
// report, at a hit point, the barycentric blend of those normals (unit length,
// oriented to face the ray). This is what turns flat triangles into curves.
function testSmoothNormal(): { pass: boolean; detail: string } {
  const n0 = normalize(v(0, 0, 1))
  const n1 = normalize(v(1, 0, 1))
  const n2 = normalize(v(0, 1, 1))
  const def: SceneDef = {
    name: 'smooth',
    materials: [{ kind: 'diffuse', albedo: v(0.5, 0.5, 0.5) }],
    prims: [{ kind: 'tri', p0: v(0, 0, 0), p1: v(1, 0, 0), p2: v(0, 1, 0), material: 0, n0, n1, n2 }],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 30, aperture: 0, focusDist: 5 },
    env: { kind: 'solid', color: v(0, 0, 0) },
  }
  const scene = new Scene(def)
  // Aim at barycentric (1-u-v, u, v) = (0.5, 0.25, 0.25): the point p0+0.25e1+0.25e2.
  const hit = scene.intersect({ o: v(0.25, 0.25, 5), d: v(0, 0, -1), tMax: Infinity })
  if (!hit) return { pass: false, detail: 'no hit' }
  const expected = normalize(add(add(scale(n0, 0.5), scale(n1, 0.25)), scale(n2, 0.25)))
  const err = len(sub(hit.n, expected))
  const unit = len(hit.n)
  return { pass: err < 1e-6 && approx(unit, 1, 1e-9), detail: `|Δn|=${err.toExponential(1)}, |n|=${unit.toFixed(6)}` }
}

// 17 — Icosphere integrity: vertex normals are radial (a unit sphere's normal is
// its position), every face winds outward, and the closed mesh satisfies Euler's
// V − E + F = 2 (with E = 3F/2 for a triangle mesh).
function testIcosphere(): { pass: boolean; detail: string } {
  const m = icosphere(2)
  const F = meshTriangleCount(m)
  const V = m.positions.length
  const euler = V - (3 * F) / 2 + F // = V - F/2
  let radialOk = true
  for (let i = 0; i < V; i++) {
    if (dot(m.normals[i], normalize(m.positions[i])) < 0.9999) radialOk = false
  }
  let outward = true
  for (let i = 0; i < m.indices.length; i += 3) {
    const a = m.positions[m.indices[i]]
    const b = m.positions[m.indices[i + 1]]
    const c = m.positions[m.indices[i + 2]]
    const fn = cross(sub(b, a), sub(c, a))
    const centroid = scale(add(add(a, b), c), 1 / 3)
    if (dot(fn, centroid) <= 0) outward = false
  }
  const ok = euler === 2 && radialOk && outward
  return { pass: ok, detail: `V=${V}, F=${F}, χ=${euler}, radial=${radialOk}, outward=${outward}` }
}

// 18 — OBJ round-trip: parsing the canonical unit cube must recover 8 vertices
// and 12 triangles, fit to the unit box, and (with no `vn` in the file) recompute
// outward-pointing area-weighted normals.
function testObjCube(): { pass: boolean; detail: string } {
  const r = parseObj(CUBE_OBJ, 1)
  const counts = r.vertexCount === 8 && r.faceCount === 12
  let maxCoord = 0
  for (const p of r.mesh.positions) maxCoord = Math.max(maxCoord, Math.abs(p.x), Math.abs(p.y), Math.abs(p.z))
  let outward = true
  for (let i = 0; i < r.mesh.positions.length; i++) {
    // Each cube corner's smooth normal should point away from the centre.
    if (dot(r.mesh.normals[i], normalize(r.mesh.positions[i])) <= 0) outward = false
  }
  const ok = counts && approx(maxCoord, 1, 1e-9) && outward && !r.hadNormals
  return { pass: ok, detail: `V=${r.vertexCount}, F=${r.faceCount}, fit=${maxCoord.toFixed(3)}, outward=${outward}` }
}

// 19 — Torus normals: every analytic vertex normal is unit length and equal to
// the direction from the local tube centre to the vertex.
function testTorusNormals(): { pass: boolean; detail: string } {
  const R = 1
  const m = torus(R, 0.35, 32, 16)
  let maxUnitErr = 0
  let maxDirErr = 0
  for (let i = 0; i < m.positions.length; i++) {
    const p = m.positions[i]
    maxUnitErr = Math.max(maxUnitErr, Math.abs(len(m.normals[i]) - 1))
    // Tube centre: the closest point on the major-radius circle in the XZ plane.
    const ringLen = Math.hypot(p.x, p.z) || 1
    const tubeCenter = v((p.x / ringLen) * R, 0, (p.z / ringLen) * R)
    const expected = normalize(sub(p, tubeCenter))
    maxDirErr = Math.max(maxDirErr, len(sub(m.normals[i], expected)))
  }
  const ok = maxUnitErr < 1e-9 && maxDirErr < 1e-6
  return { pass: ok, detail: `max|‖n‖−1|=${maxUnitErr.toExponential(1)}, max dir err=${maxDirErr.toExponential(1)}` }
}

// 20 — Preetham sky: radiance is finite and non-negative everywhere, the sky is
// brighter toward the sun than away from it, and the zenith differs from the
// horizon (a real gradient, not a flat fill).
function testSky(): { pass: boolean; detail: string } {
  const sunDir = normalize(v(0.3, 0.5, 0.8))
  const s = makeSky({ sunDir, turbidity: 3, intensity: 1 })
  let finite = true
  let nonNeg = true
  const rng = new Rng(77, 2)
  for (let i = 0; i < 4000; i++) {
    const dir = normalize(v(rng.range(-1, 1), rng.range(0.02, 1), rng.range(-1, 1)))
    const c = skyRadiance(s, dir, false)
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.z)) finite = false
    if (c.x < 0 || c.y < 0 || c.z < 0) nonNeg = false
  }
  // Sample near the sun vs. opposite it (both above the horizon, no disc).
  const nearSun = luminance(skyRadiance(s, normalize(v(0.3, 0.45, 0.8)), false))
  const awaySun = luminance(skyRadiance(s, normalize(v(-0.3, 0.45, -0.8)), false))
  const zenith = luminance(skyRadiance(s, v(0, 1, 0), false))
  const horizon = luminance(skyRadiance(s, normalize(v(1, 0.05, 0)), false))
  const ok = finite && nonNeg && nearSun > awaySun && Math.abs(zenith - horizon) > 1e-4
  return {
    pass: ok,
    detail: `finite=${finite}, ≥0=${nonNeg}, sun=${nearSun.toFixed(2)}>away=${awaySun.toFixed(2)}`,
  }
}

// 21 — Environment-sun sampler ↔ pdf: every direction the env light sampler
// returns lands inside the sun cone, its reported pdf equals envSunPdf for that
// direction, and the mean of 1/pdf recovers the cone's solid angle 2π(1−cos σ).
function testEnvSampler(): { pass: boolean; detail: string } {
  const size = 0.2
  const def: SceneDef = {
    name: 'env',
    materials: [],
    prims: [],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 30, aperture: 0, focusDist: 5 },
    env: { kind: 'gradient', top: v(1, 1, 1), bottom: v(1, 1, 1), sunDir: v(0, 1, 0), sunColor: v(0, 0, 0), sunSize: size },
  }
  const scene = new Scene(def)
  const rng = new Rng(123, 4)
  const cosSize = Math.cos(size)
  let inCone = true
  let maxPdfErr = 0
  let invSum = 0
  const N = 40000
  for (let i = 0; i < N; i++) {
    const ls = scene.sampleLight(v(0, 0, 0), rng)
    if (!ls || ls.primId !== -1) {
      inCone = false
      continue
    }
    if (dot(ls.wi, v(0, 1, 0)) < cosSize - 1e-9) inCone = false
    const p = scene.envSunPdf(ls.wi)
    maxPdfErr = Math.max(maxPdfErr, Math.abs(p - ls.pdf) / Math.max(1e-9, ls.pdf))
    invSum += 1 / ls.pdf
  }
  const measuredOmega = invSum / N
  const expectedOmega = 2 * Math.PI * (1 - cosSize)
  const ok = inCone && maxPdfErr < 1e-9 && approx(measuredOmega, expectedOmega, 5e-3)
  return {
    pass: ok,
    detail: `cone=${inCone}, Δpdf=${maxPdfErr.toExponential(1)}, Ω=${measuredOmega.toFixed(4)} (exp ${expectedOmega.toFixed(4)})`,
  }
}

// 22 — Environment-importance-sampled white furnace: a diffuse sphere of albedo ρ
// inside a uniform unit environment that is *also* sampled as a full-sphere sun
// must still reflect exactly ρ. This proves the env next-event estimator and its
// MIS combination with BSDF sampling are unbiased and energy-conserving.
function testEnvFurnace(): { pass: boolean; detail: string } {
  const rho = 0.8
  const def: SceneDef = {
    name: 'env-furnace',
    materials: [{ kind: 'diffuse', albedo: v(rho, rho, rho) }],
    prims: [{ kind: 'sphere', center: v(0, 0, 0), radius: 1, material: 0 }],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 30, aperture: 0, focusDist: 5 },
    // Uniform radiance 1, with a full-sphere (σ = π) sampled sun, colour 0 so the
    // gradient alone sets the (uniform) radiance.
    env: { kind: 'gradient', top: v(1, 1, 1), bottom: v(1, 1, 1), sunDir: v(0, 1, 0), sunColor: v(0, 0, 0), sunSize: Math.PI },
  }
  const scene = new Scene(def)
  const rng = new Rng(4096, 6)
  const settings = { maxDepth: 16, rrStart: 6, clampIndirect: 0 }
  const stats: RayStats = { rays: 0 }
  const N = 20000
  let sum = 0
  for (let i = 0; i < N; i++) {
    const L = radiance(scene, { o: v(0, 0, 5), d: v(0, 0, -1), tMax: Infinity }, settings, rng, stats)
    sum += luminance(L)
  }
  const measured = sum / N
  return { pass: approx(measured, rho, 1.5e-2), detail: `reflectance=${measured.toFixed(4)}, expected≈${rho.toFixed(3)}` }
}

// 23 — Henyey–Greenstein phase function: it must integrate to 1 over the sphere
// (so it conserves energy at a scattering event), its sampler must report the
// exact analytic pdf for the direction it draws, and the mean cosine of the
// scattered angle must recover the anisotropy parameter (E[cosθ] = −g in the
// wo-convention, since wo points back along the path).
function testPhase(): { pass: boolean; detail: string } {
  const wo = normalize(v(0.3, -0.5, 0.8))
  let worstNorm = 0
  let worstPdf = 0
  let worstMean = 0
  for (const g of [-0.6, 0, 0.4, 0.8]) {
    // Normalisation: E over a uniform sphere of p == 1/(4π), so ∫ p dω == 1.
    const rng = new Rng(101, 1)
    let sum = 0
    const N = 200000
    for (let i = 0; i < N; i++) {
      const z = 1 - 2 * rng.next()
      const r = Math.sqrt(Math.max(0, 1 - z * z))
      const phi = 2 * Math.PI * rng.next()
      const dir = v(r * Math.cos(phi), r * Math.sin(phi), z)
      sum += hgPhase(dot(wo, dir), g)
    }
    worstNorm = Math.max(worstNorm, Math.abs((sum / N) * 4 * Math.PI - 1))
    // Sampler ↔ pdf consistency + mean cosine.
    const rng2 = new Rng(202, 3)
    let cosSum = 0
    const M = 120000
    for (let i = 0; i < M; i++) {
      const s = sampleHG(wo, g, rng2)
      const p = hgPhase(dot(wo, s.wi), g)
      worstPdf = Math.max(worstPdf, Math.abs(p - s.pdf) / Math.max(1e-9, s.pdf))
      cosSum += dot(wo, s.wi)
    }
    worstMean = Math.max(worstMean, Math.abs(cosSum / M - -g))
  }
  const ok = worstNorm < 1e-2 && worstPdf < 1e-9 && worstMean < 1e-2
  return {
    pass: ok,
    detail: `‖∫p−1‖=${worstNorm.toExponential(1)}, Δpdf=${worstPdf.toExponential(1)}, ‖E[cos]+g‖=${worstMean.toExponential(1)}`,
  }
}

// 24 — Homogeneous transmittance: the medium distance sampler must let a ray
// reach a surface at distance L with probability exactly e^(−σ_t·L) (Beer's law
// recovered statistically), the foundation of unbiased volumetric transport.
function testMediumTransmittance(): { pass: boolean; detail: string } {
  const sigmaT = 0.7
  const L = 2
  const def: SceneDef = {
    name: 'tr',
    materials: [],
    prims: [],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 30, aperture: 0, focusDist: 5 },
    env: { kind: 'solid', color: v(0, 0, 0) },
    media: [{ center: v(0, 0, 0), radius: 100, sigmaT, albedo: v(1, 1, 1), g: 0 }],
  }
  const scene = new Scene(def)
  const rng = new Rng(515, 2)
  let reached = 0
  const N = 200000
  for (let i = 0; i < N; i++) {
    const ms = scene.sampleMediumScatter(v(0, 0, 0), v(1, 0, 0), L, rng)
    if (!ms) reached++ // no collision before L ⇒ the ray reaches the surface
  }
  const frac = reached / N
  const expected = Math.exp(-sigmaT * L)
  return { pass: approx(frac, expected, 5e-3), detail: `reach=${frac.toFixed(4)}, e^(−σL)=${expected.toFixed(4)}` }
}

// 25 — Volumetric energy conservation. A *purely scattering* bounded volume
// (albedo 1) immersed in a uniform unit radiance field must remain invisible:
// scattering only redistributes directions, and a uniform field is unchanged by
// that, so a camera ray through the volume still measures exactly 1. Any bias in
// the collision/boundary weights would push this off 1.
function testVolumeScatterEnergy(): { pass: boolean; detail: string } {
  const def: SceneDef = {
    name: 'vol-scatter',
    materials: [],
    prims: [],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 30, aperture: 0, focusDist: 5 },
    env: { kind: 'solid', color: v(1, 1, 1) },
    media: [{ center: v(0, 0, 0), radius: 1, sigmaT: 0.6, albedo: v(1, 1, 1), g: 0.2 }],
  }
  const scene = new Scene(def)
  const rng = new Rng(909, 4)
  const settings = { maxDepth: 64, rrStart: 48, clampIndirect: 0 }
  const stats: RayStats = { rays: 0 }
  const N = 40000
  let sum = 0
  for (let i = 0; i < N; i++) {
    const L = radiance(scene, { o: v(0, 0, 5), d: v(0, 0, -1), tMax: Infinity }, settings, rng, stats)
    sum += luminance(L)
  }
  const measured = sum / N
  return { pass: approx(measured, 1, 1.5e-2), detail: `radiance through scattering volume=${measured.toFixed(4)} (exp 1)` }
}

// 26 — Volumetric absorption. A *purely absorbing* volume (albedo 0, scalar σ_t)
// must transmit the background only along unscattered rays, so a camera ray sees
// the unit field attenuated by e^(−σ_t·chord) through the sphere — the volumetric
// Beer–Lambert law, here arising from stochastic path termination.
function testVolumeAbsorb(): { pass: boolean; detail: string } {
  const sigmaT = 0.8
  const radius = 1
  const def: SceneDef = {
    name: 'vol-absorb',
    materials: [],
    prims: [],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 30, aperture: 0, focusDist: 5 },
    env: { kind: 'solid', color: v(1, 1, 1) },
    media: [{ center: v(0, 0, 0), radius, sigmaT, albedo: v(0, 0, 0), g: 0 }],
  }
  const scene = new Scene(def)
  const rng = new Rng(271, 6)
  const settings = { maxDepth: 8, rrStart: 4, clampIndirect: 0 }
  const stats: RayStats = { rays: 0 }
  const N = 60000
  let sum = 0
  for (let i = 0; i < N; i++) {
    const L = radiance(scene, { o: v(0, 0, 5), d: v(0, 0, -1), tMax: Infinity }, settings, rng, stats)
    sum += luminance(L)
  }
  const measured = sum / N
  const expected = Math.exp(-sigmaT * 2 * radius) // chord through a centred sphere = 2r
  return { pass: approx(measured, expected, 1e-2), detail: `transmitted=${measured.toFixed(4)}, e^(−σ·2r)=${expected.toFixed(4)}` }
}

// 26b — The procedural noise underpinning heterogeneous media is well-behaved:
// the value field and its fBm are bounded in [0,1], continuous (a tiny step in
// position makes a tiny change in value — no creases, which would alias the
// density), deterministic (identical input ⇒ identical output, so a field
// renders the same on every worker), and ≈zero-centred at 0.5 (the corner values
// are uniform, so their interpolation has the right mean — an unbiased density).
function testNoiseField(): { pass: boolean; detail: string } {
  const rng = new Rng(13, 7)
  let lo = Infinity
  let hi = -Infinity
  let sum = 0
  let sumF = 0
  let maxJump = 0
  let detOk = true
  const N = 60000
  for (let i = 0; i < N; i++) {
    const x = (rng.next() - 0.5) * 40
    const y = (rng.next() - 0.5) * 40
    const z = (rng.next() - 0.5) * 40
    const a = valueNoise3(x, y, z, 3)
    lo = Math.min(lo, a)
    hi = Math.max(hi, a)
    sum += a
    sumF += fbm3(x, y, z, 5, 2, 0.5, 3)
    // Continuity: a 1e-3 step must not move the value by much (Lipschitz).
    const b = valueNoise3(x + 1e-3, y, z, 3)
    maxJump = Math.max(maxJump, Math.abs(a - b))
    // Determinism: re-evaluating the same point reproduces the value exactly.
    if (valueNoise3(x, y, z, 3) !== a) detOk = false
  }
  const mean = sum / N
  const meanF = sumF / N
  const bounded = lo >= 0 && hi <= 1
  // fBm value mean should also centre near 0.5 (uniform corners, normalised sum).
  const ok = bounded && detOk && maxJump < 0.05 && approx(mean, 0.5, 2e-2) && approx(meanF, 0.5, 2e-2)
  return {
    pass: ok,
    detail: `range=[${lo.toFixed(3)},${hi.toFixed(3)}], mean=${mean.toFixed(3)}, fbm̄=${meanF.toFixed(3)}, maxΔ(1e-3)=${maxJump.toExponential(1)}, det=${detOk}`,
  }
}

// A constant (≡1) density field: a `layer` whose floor sits far above the medium
// so density saturates to 1 everywhere. Lets the heterogeneous delta-/ratio-
// tracking paths be checked against the *exact* homogeneous Beer–Lambert law.
function constantMedium(sigmaT: number): MediumDef {
  return {
    center: v(0, 0, 0),
    radius: 1000,
    sigmaT,
    albedo: v(1, 1, 1),
    g: 0,
    density: { kind: 'layer', base: 1e9, scaleHeight: 1, noiseAmount: 0 },
  }
}

// 26c — Delta tracking is unbiased: with a constant (=1) density field, the
// null-collision free-flight sampler must reproduce Beer's law exactly — a ray
// reaches distance L with probability e^(−σ_t·L), identical to the homogeneous
// analytic sampler (test 24) but exercising the Woodcock accept/null loop.
function testDeltaTrackConstant(): { pass: boolean; detail: string } {
  const sigmaT = 0.7
  const L = 2
  const scene = new Scene({
    name: 'dt', materials: [], prims: [],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 30, aperture: 0, focusDist: 5 },
    env: { kind: 'solid', color: v(0, 0, 0) },
    media: [constantMedium(sigmaT)],
  })
  const rng = new Rng(424, 9)
  let reached = 0
  const N = 200000
  for (let i = 0; i < N; i++) {
    if (!scene.sampleMediumScatter(v(0, 0, 0), v(1, 0, 0), L, rng)) reached++
  }
  const frac = reached / N
  const expected = Math.exp(-sigmaT * L)
  return { pass: approx(frac, expected, 5e-3), detail: `delta-track reach=${frac.toFixed(4)}, e^(−σL)=${expected.toFixed(4)}` }
}

// 26d — Ratio tracking matches a genuinely *varying* analytic optical depth. A
// downward ray crosses an exponential `layer` fog whose density changes ~14× over
// the segment; the ratio-tracking transmittance estimate, averaged, must equal
// e^(−∫σ_t ds) where the integral is computed by an independent fine quadrature
// of the very same field. This is the unbiasedness proof for the shadow-ray
// estimator on a heterogeneous medium (no closed form assumed).
function testRatioTrackVarying(): { pass: boolean; detail: string } {
  const sigmaT = 0.9
  const med: MediumDef = {
    center: v(0, 0, 0), radius: 1000, sigmaT, albedo: v(1, 1, 1), g: 0,
    density: { kind: 'layer', base: 0, scaleHeight: 3, noiseAmount: 0 },
  }
  const scene = new Scene({
    name: 'rt', materials: [], prims: [],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 30, aperture: 0, focusDist: 5 },
    env: { kind: 'solid', color: v(0, 0, 0) },
    media: [med],
  })
  const o = v(0, 9, 0)
  const d = v(0, -1, 0)
  const dist = 8
  // Reference optical depth: deterministic quadrature of σ_t·density along the ray.
  const field = makeDensityField(med)!
  let tau = 0
  const Q = 200000
  const dt = dist / Q
  for (let i = 0; i < Q; i++) {
    const t = (i + 0.5) * dt
    tau += sigmaT * field.density({ x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t }) * dt
  }
  const expected = Math.exp(-tau)
  // Monte-Carlo ratio-tracking estimate.
  const rng = new Rng(733, 11)
  let sum = 0
  const N = 300000
  for (let i = 0; i < N; i++) sum += scene.mediaTransmittance(o, d, dist, rng)
  const measured = sum / N
  return {
    pass: approx(measured, expected, 6e-3),
    detail: `ratio-track T̂=${measured.toFixed(4)}, e^(−∫σds)=${expected.toFixed(4)} (τ=${tau.toFixed(3)})`,
  }
}

// 26e — Delta tracking on a *varying* field too: the reach-fraction (probability
// of crossing the exponential fog with no real collision) must equal e^(−∫σ_t ds)
// from the same quadrature — the collision sampler, not just the transmittance
// estimator, follows the heterogeneous free-flight law.
function testDeltaTrackVarying(): { pass: boolean; detail: string } {
  const sigmaT = 0.9
  const med: MediumDef = {
    center: v(0, 0, 0), radius: 1000, sigmaT, albedo: v(1, 1, 1), g: 0,
    density: { kind: 'layer', base: 0, scaleHeight: 3, noiseAmount: 0 },
  }
  const scene = new Scene({
    name: 'dtv', materials: [], prims: [],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 30, aperture: 0, focusDist: 5 },
    env: { kind: 'solid', color: v(0, 0, 0) },
    media: [med],
  })
  const o = v(0, 9, 0)
  const d = v(0, -1, 0)
  const dist = 8
  const field = makeDensityField(med)!
  let tau = 0
  const Q = 200000
  const dt = dist / Q
  for (let i = 0; i < Q; i++) {
    const t = (i + 0.5) * dt
    tau += sigmaT * field.density({ x: o.x, y: o.y - t, z: o.z }) * dt
  }
  const expected = Math.exp(-tau)
  const rng = new Rng(9001, 13)
  let reached = 0
  const N = 300000
  for (let i = 0; i < N; i++) {
    if (!scene.sampleMediumScatter(o, d, dist, rng)) reached++
  }
  const frac = reached / N
  return { pass: approx(frac, expected, 6e-3), detail: `delta-track reach=${frac.toFixed(4)}, e^(−∫σds)=${expected.toFixed(4)}` }
}

// 26f — End-to-end oracle for the whole heterogeneous integrator. A *purely
// scattering* (albedo 1) volume with an arbitrary fBm density immersed in a
// uniform unit radiance field must stay invisible — scattering only redistributes
// directions and a uniform field is unchanged by that — so a camera ray through
// the cloud still measures exactly 1. Any bias in the delta-tracking collisions,
// the albedo weight, or the boundary handling would push this off 1.
function testHeteroVolumeEnergy(): { pass: boolean; detail: string } {
  const scene = new Scene({
    name: 'hetero-energy', materials: [], prims: [],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 30, aperture: 0, focusDist: 5 },
    env: { kind: 'solid', color: v(1, 1, 1) },
    media: [
      {
        center: v(0, 0, 0), radius: 1, sigmaT: 2.0, albedo: v(1, 1, 1), g: 0.2,
        density: { kind: 'fbm', frequency: 1.4, octaves: 4, lacunarity: 2, gain: 0.5, coverage: 0.3, edge: 0, warp: 0.6, seed: 4 },
      },
    ],
  })
  const rng = new Rng(8123, 3)
  const settings = { maxDepth: 96, rrStart: 64, clampIndirect: 0 }
  const stats: RayStats = { rays: 0 }
  const N = 60000
  let sum = 0
  for (let i = 0; i < N; i++) {
    const L = radiance(scene, { o: v(0, 0, 5), d: v(0, 0, -1), tMax: Infinity }, settings, rng, stats)
    sum += luminance(L)
  }
  const measured = sum / N
  return { pass: approx(measured, 1, 1.5e-2), detail: `radiance through fBm cloud=${measured.toFixed(4)} (exp 1)` }
}

// 26g — Volumetric emission. A purely *absorbing+emitting* volume (albedo 0,
// emitted radiance Lₑ, extinction σ_t) seen against a black background must glow
// with exactly the emission–absorption law L = (1 − e^(−σ_t·chord))·Lₑ: a camera
// ray contributes Lₑ iff it suffers a collision inside the medium (probability
// 1 − e^(−σ_t·chord)) and nothing otherwise. This pins the (1−albedo)·Lₑ
// collision-emission weight and that the path terminates on absorption.
function testEmissiveVolume(): { pass: boolean; detail: string } {
  const sigmaT = 0.8
  const radius = 1
  const Le = 2.0
  const scene = new Scene({
    name: 'vol-emit', materials: [], prims: [],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 30, aperture: 0, focusDist: 5 },
    env: { kind: 'solid', color: v(0, 0, 0) },
    media: [{ center: v(0, 0, 0), radius, sigmaT, albedo: v(0, 0, 0), g: 0, emission: v(Le, Le, Le) }],
  })
  const rng = new Rng(4242, 8)
  const settings = { maxDepth: 8, rrStart: 6, clampIndirect: 0 }
  const stats: RayStats = { rays: 0 }
  const N = 60000
  let sum = 0
  for (let i = 0; i < N; i++) {
    const L = radiance(scene, { o: v(0, 0, 5), d: v(0, 0, -1), tMax: Infinity }, settings, rng, stats)
    sum += luminance(L)
  }
  const measured = sum / N
  const expected = (1 - Math.exp(-sigmaT * 2 * radius)) * Le // chord = 2r
  return {
    pass: approx(measured, expected, 1.5e-2),
    detail: `emitted L=${measured.toFixed(4)}, (1−e^(−σ·2r))·Lₑ=${expected.toFixed(4)}`,
  }
}

// ---- Chromatic participating media — a wavelength-dependent atmosphere (16.0) -

// Render a bounded medium sphere of radius `radius` head-on in a uniform unit
// environment and return its mean RGB radiance — the media analogue of the
// subsurface furnace, used by the chromatic energy/Beer proofs. The medium carries
// a chromatic extinction, so the integrator commits a hero wavelength and the
// colour reconstructs over many paths' wavelengths.
function chromaticMediumRGB(
  sigmaTSpectral: Vec3,
  albedo: Vec3,
  radius: number,
  settings: { maxDepth: number; rrStart: number; clampIndirect: number },
  N: number,
  seed: number,
): Vec3 {
  const sigmaTMean = (sigmaTSpectral.x + sigmaTSpectral.y + sigmaTSpectral.z) / 3
  const scene = new Scene({
    name: 'chromatic-medium',
    materials: [],
    prims: [],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 30, aperture: 0, focusDist: 5 },
    env: { kind: 'solid', color: v(1, 1, 1) },
    media: [{ center: v(0, 0, 0), radius, sigmaT: sigmaTMean, sigmaTSpectral, albedo, g: 0 }],
  })
  const rng = new Rng(seed, 5)
  const stats: RayStats = { rays: 0 }
  let sx = 0
  let sy = 0
  let sz = 0
  for (let i = 0; i < N; i++) {
    const L = radiance(scene, { o: v(0, 0, 5), d: v(0, 0, -1), tMax: Infinity }, settings, rng, stats)
    sx += L.x
    sy += L.y
    sz += L.z
  }
  return v(sx / N, sy / N, sz / N)
}

// CM-1 — Chromatic homogeneous transmittance is exact, per wavelength. The analytic
// transmittance estimator must return EXACTLY e^(−σ_t(λ)·L) at the path's hero
// wavelength — and because red has the smaller extinction, red transmits more than
// blue (the reddening of a sun seen through haze). A deterministic check at three
// wavelengths, no Monte-Carlo tolerance needed.
function testChromaticMediumTransmittance(): { pass: boolean; detail: string } {
  const sigmaTSpectral = v(0.2, 0.5, 0.9) // R, G, B
  const L = 2.5
  const scene = new Scene({
    name: 'cm-tr',
    materials: [],
    prims: [],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 30, aperture: 0, focusDist: 5 },
    env: { kind: 'solid', color: v(0, 0, 0) },
    media: [{ center: v(0, 0, 0), radius: 100, sigmaT: 0.5, sigmaTSpectral, albedo: v(1, 1, 1), g: 0 }],
  })
  const rng = new Rng(7, 2)
  let worst = 0
  for (const lambda of [LAMBDA_R, LAMBDA_G, LAMBDA_B]) {
    const tr = scene.mediaTransmittance(v(-50, 0, 0), v(1, 0, 0), L, rng, lambda)
    const expected = Math.exp(-spectralAt(sigmaTSpectral, lambda) * L)
    worst = Math.max(worst, Math.abs(tr - expected))
  }
  const trR = scene.mediaTransmittance(v(-50, 0, 0), v(1, 0, 0), L, rng, LAMBDA_R)
  const trB = scene.mediaTransmittance(v(-50, 0, 0), v(1, 0, 0), L, rng, LAMBDA_B)
  return {
    pass: worst < 1e-12 && trR > trB,
    detail: `max|Δ|=${worst.toExponential(1)} (exact), T(red)=${trR.toFixed(3)}>T(blue)=${trB.toFixed(3)}`,
  }
}

// CM-2 — Chromatic ratio tracking is unbiased per wavelength. Through a *constant*
// heterogeneous field (density ≡ 1), the stochastic ratio-tracking transmittance
// must average to e^(−σ_t(λ)·L) at the committed hero wavelength — the chromatic
// generalisation of the heterogeneous transmittance proof, confirming the null-
// collision estimator tracks against the per-wavelength majorant correctly.
function testChromaticRatioTrack(): { pass: boolean; detail: string } {
  const sigmaTSpectral = v(0.3, 0.6, 1.0)
  const L = 2
  const scene = new Scene({
    name: 'cm-ratio',
    materials: [],
    prims: [],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 30, aperture: 0, focusDist: 5 },
    env: { kind: 'solid', color: v(0, 0, 0) },
    media: [
      {
        center: v(0, 0, 0),
        radius: 100,
        sigmaT: 0.6,
        sigmaTSpectral,
        albedo: v(1, 1, 1),
        g: 0,
        // A constant field along the y=0 ray: base far above, no noise ⇒ density ≡ 1.
        density: { kind: 'layer', base: 1e9, scaleHeight: 1, noiseAmount: 0 },
      },
    ],
  })
  const rng = new Rng(8123, 3)
  let worst = 0
  for (const lambda of [LAMBDA_R, LAMBDA_G, LAMBDA_B]) {
    let sum = 0
    const N = 40000
    for (let i = 0; i < N; i++) sum += scene.mediaTransmittance(v(-1, 0, 0), v(1, 0, 0), L, rng, lambda)
    const mean = sum / N
    const expected = Math.exp(-spectralAt(sigmaTSpectral, lambda) * L)
    worst = Math.max(worst, Math.abs(mean - expected))
  }
  return { pass: worst < 6e-3, detail: `worst|E[T̂]−e^(−σ(λ)L)|=${worst.toFixed(4)}` }
}

// CM-3 — Chromatic energy conservation: a purely *scattering* bounded volume
// (albedo 1) is invisible in a unit furnace for ANY chromatic extinction. Even when
// blue is scattered ten times more than red, scattering only redistributes a
// uniform field, so a camera ray still measures 1 per channel — the hero-wavelength
// weight reconstructs to white. The unbiasedness oracle for the wavelength-resolved
// delta-tracking walk (the media analogue of the spectral subsurface furnace).
function testChromaticVolumeEnergy(): { pass: boolean; detail: string } {
  const settings = { maxDepth: 64, rrStart: 48, clampIndirect: 0 }
  const c = chromaticMediumRGB(v(0.25, 0.6, 1.3), v(1, 1, 1), 1, settings, 40000, 5150)
  const worst = Math.max(Math.abs(c.x - 1), Math.abs(c.y - 1), Math.abs(c.z - 1))
  return {
    pass: worst < 2e-2,
    detail: `chromatic furnace=(${c.x.toFixed(4)},${c.y.toFixed(4)},${c.z.toFixed(4)}) worst|Δ|=${worst.toFixed(4)} (exp 1 ∀λ)`,
  }
}

// CM-4 — The headline, rendered: a chromatic *absorbing* haze reddens what it
// transmits. A pure-absorbing medium (albedo 0) passes only the unscattered ray,
// surviving with probability e^(−σ_t(λ)·2r) at its wavelength; averaging the hero-
// wavelength weight over λ, the rendered RGB equals the spectral transmittance
// integral (1/Δλ)∫ w(λ)·e^(−σ_t(λ)·2r) dλ (matched to a fine quadrature), and since
// σ_t,red < σ_t,blue the survivor is reddest: R > G > B. The atmosphere's colour is
// the wavelength dependence of its extinction, end to end.
function testChromaticVolumeReddens(): { pass: boolean; detail: string } {
  const settings = { maxDepth: 8, rrStart: 4, clampIndirect: 0 }
  const sigmaTSpectral = v(0.3, 0.7, 1.3)
  const c = chromaticMediumRGB(sigmaTSpectral, v(0, 0, 0), 1, settings, 80000, 6161)
  const N = 2048
  let qx = 0
  let qy = 0
  let qz = 0
  for (let i = 0; i < N; i++) {
    const lambda = LAMBDA_MIN + ((i + 0.5) / N) * (LAMBDA_MAX - LAMBDA_MIN)
    const w = wavelengthWeight(lambda)
    const T = Math.exp(-spectralAt(sigmaTSpectral, lambda) * 2) // chord = 2r, r = 1
    qx += w.x * T
    qy += w.y * T
    qz += w.z * T
  }
  const ref = v(qx / N, qy / N, qz / N)
  const err = Math.max(Math.abs(c.x - ref.x), Math.abs(c.y - ref.y), Math.abs(c.z - ref.z))
  const ordered = c.x > c.y + 0.01 && c.y > c.z + 0.01
  return {
    pass: err < 1.5e-2 && ordered,
    detail: `rendered=(${c.x.toFixed(3)},${c.y.toFixed(3)},${c.z.toFixed(3)}) quad=(${ref.x.toFixed(3)},${ref.y.toFixed(3)},${ref.z.toFixed(3)}) maxΔ=${err.toFixed(4)}, R>G>B=${ordered}`,
  }
}

// CM-5 — The chromatic medium generalises the scalar one: with an achromatic
// extinction (equal σ_t per channel) it must converge to the same image the scalar
// medium produces. The spectral path still commits a hero wavelength (different RNG
// stream), so this is an unbiasedness *oracle* — and it licenses shipping chromatic
// media as a superset that leaves every scalar-media proof untouched.
function testChromaticReducesToScalar(): { pass: boolean; detail: string } {
  const settings = { maxDepth: 32, rrStart: 16, clampIndirect: 0 }
  const sigmaT = 0.6
  const scalar = new Scene({
    name: 'cm-scalar',
    materials: [],
    prims: [],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 30, aperture: 0, focusDist: 5 },
    env: { kind: 'solid', color: v(1, 1, 1) },
    media: [{ center: v(0, 0, 0), radius: 1, sigmaT, albedo: v(0.6, 0.6, 0.6), g: 0.2 }],
  })
  const rng = new Rng(2718, 4)
  let ss = 0
  const N = 30000
  for (let i = 0; i < N; i++) ss += luminance(radiance(scalar, { o: v(0, 0, 5), d: v(0, 0, -1), tMax: Infinity }, settings, rng, { rays: 0 }))
  const scalarL = ss / N
  const chromaticC = chromaticMediumRGB(v(sigmaT, sigmaT, sigmaT), v(0.6, 0.6, 0.6), 1, settings, 30000, 2719)
  const chromaticL = luminance(chromaticC)
  const rel = Math.abs(chromaticL - scalarL) / scalarL
  return {
    pass: rel < 1.5e-2,
    detail: `scalar=${scalarL.toFixed(4)}, chromatic(achromatic)=${chromaticL.toFixed(4)}, rel.Δ=${(rel * 100).toFixed(2)}% (oracle)`,
  }
}

// 27 — Thin-film reflectance is a physical reflectance: bounded in [0,1] for all
// angles, wavelengths and thicknesses; as the film thickness → 0 it must collapse
// to the bare Fresnel reflectance of the air→substrate interface (the film
// vanishes, independent of its index); and at an interference-active thickness it
// must vary with wavelength (the very iridescence the model exists to produce).
function testThinFilm(): { pass: boolean; detail: string } {
  // Unpolarised dielectric Fresnel for an air(1)→n interface at incidence cosI.
  const fresnel = (cosI: number, n: number): number => {
    const sin2T = (1 / (n * n)) * Math.max(0, 1 - cosI * cosI)
    if (sin2T >= 1) return 1
    const cosT = Math.sqrt(1 - sin2T)
    const rs = (cosI - n * cosT) / (cosI + n * cosT)
    const rp = (n * cosI - cosT) / (n * cosI + cosT)
    return 0.5 * (rs * rs + rp * rp)
  }
  const rng = new Rng(606, 5)
  let inRange = true
  for (let i = 0; i < 20000; i++) {
    const cosI = rng.range(0.02, 1)
    const lam = rng.range(380, 720)
    const d = rng.range(0, 1200)
    const R = thinFilmReflectance(cosI, lam, d, rng.range(1.2, 2.0), rng.range(1.2, 2.6))
    if (R < -1e-9 || R > 1 + 1e-9) inRange = false
  }
  // d → 0 collapse (independent of the film index n1).
  let maxCollapse = 0
  for (const cosI of [1, 0.8, 0.5, 0.2]) {
    for (const n1 of [1.3, 1.6, 2.0]) {
      const R0 = thinFilmReflectance(cosI, 550, 0, n1, 1.5)
      maxCollapse = Math.max(maxCollapse, Math.abs(R0 - fresnel(cosI, 1.5)))
    }
  }
  // Iridescence: across the visible band, an interference-active film must spread
  // its reflectance — high at some wavelengths, low at others — which is what the
  // eye reads as a shifting rainbow sheen.
  let rMin = 1
  let rMax = 0
  for (let lam = 400; lam <= 700; lam += 5) {
    const R = thinFilmReflectance(1, lam, 300, 1.45, 2.4)
    rMin = Math.min(rMin, R)
    rMax = Math.max(rMax, R)
  }
  const iridescent = rMax - rMin
  const ok = inRange && maxCollapse < 1e-9 && iridescent > 0.05
  return {
    pass: ok,
    detail: `R∈[0,1]=${inRange}, d→0 err=${maxCollapse.toExponential(1)}, ΔR(λ)=${iridescent.toFixed(3)}`,
  }
}

// 28 — Low-discrepancy sampling: the Halton (2,3) point set must cover the unit
// square more evenly than white noise, i.e. have a strictly lower L2 star
// discrepancy (Warnock's closed form). This is what makes anti-aliasing and the
// lens converge faster than pseudo-random jitter.
function testQmcDiscrepancy(): { pass: boolean; detail: string } {
  const N = 400
  // Warnock's L2 star discrepancy for a 2D point set.
  const l2star = (pts: { x: number; y: number }[]): number => {
    const n = pts.length
    let s1 = 0
    for (const p of pts) s1 += (1 - p.x * p.x) * (1 - p.y * p.y)
    let s2 = 0
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        s2 += (1 - Math.max(pts[i].x, pts[j].x)) * (1 - Math.max(pts[i].y, pts[j].y))
      }
    }
    const d2 = 1 / 9 - (0.5 / n) * s1 + (1 / (n * n)) * s2
    return Math.sqrt(Math.max(0, d2))
  }
  const halton: { x: number; y: number }[] = []
  const random: { x: number; y: number }[] = []
  const rng = new Rng(4242, 9)
  for (let i = 0; i < N; i++) {
    halton.push({ x: radicalInverse(2, i + 1), y: radicalInverse(3, i + 1) })
    random.push({ x: rng.next(), y: rng.next() })
  }
  const dH = l2star(halton)
  const dR = l2star(random)
  return { pass: dH < dR, detail: `Halton D*=${dH.toExponential(2)} < random D*=${dR.toExponential(2)}` }
}

// ---------------------------------------------------------------------------
// Bidirectional path tracing (BDPT)
// ---------------------------------------------------------------------------

// A small, closed, all-diffuse box with a one-sided ceiling light — a clean
// oracle: no specular, no environment, so the unidirectional and bidirectional
// integrators must converge to the same image.
function diffuseBox(): SceneDef {
  const L = 5
  const q = (p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, m: number): SceneDef['prims'] => [
    { kind: 'tri', p0, p1, p2, material: m },
    { kind: 'tri', p0, p1: p2, p2: p3, material: m },
  ]
  const prims: SceneDef['prims'] = []
  prims.push(...q(v(0, 0, 0), v(L, 0, 0), v(L, 0, L), v(0, 0, L), 0)) // floor
  prims.push(...q(v(0, L, 0), v(0, L, L), v(L, L, L), v(L, L, 0), 0)) // ceiling
  prims.push(...q(v(0, 0, L), v(L, 0, L), v(L, L, L), v(0, L, L), 0)) // back
  prims.push(...q(v(0, 0, 0), v(0, 0, L), v(0, L, L), v(0, L, 0), 1)) // red
  prims.push(...q(v(L, 0, 0), v(L, L, 0), v(L, L, L), v(L, 0, L), 2)) // green
  // Down-facing ceiling light.
  prims.push(...q(v(1.5, L - 0.02, 1.5), v(3.5, L - 0.02, 1.5), v(3.5, L - 0.02, 3.5), v(1.5, L - 0.02, 3.5), 3))
  prims.push({ kind: 'sphere', center: v(1.7, 0.9, 2.2), radius: 0.9, material: 0 })
  return {
    name: 'oracle-box',
    materials: [
      { kind: 'diffuse', albedo: v(0.72, 0.72, 0.72) },
      { kind: 'diffuse', albedo: v(0.63, 0.07, 0.05) },
      { kind: 'diffuse', albedo: v(0.14, 0.45, 0.09) },
      { kind: 'emissive', emission: v(16, 13, 9) },
    ],
    prims,
    camera: { eye: v(2.5, 2.5, -3), target: v(2.5, 2.4, 2.5), up: v(0, 1, 0), vfovDeg: 55, aperture: 0, focusDist: 5 },
    env: { kind: 'solid', color: v(0, 0, 0) },
  }
}

// Mean image luminance from a fixed grid of primary rays, traced by either
// integrator. Deterministic (fixed seed) so the comparison is reproducible.
function meanLuminance(def: SceneDef, bdpt: boolean, W: number, H: number, spp: number, seed: number): number {
  const scene = new Scene(def)
  const c = def.camera
  // A minimal pinhole camera basis (aperture 0).
  const fwd = normalize(sub(c.target, c.eye))
  const right = normalize(cross(fwd, c.up))
  const upv = cross(right, fwd)
  const halfH = Math.tan((c.vfovDeg * Math.PI) / 180 / 2)
  const halfW = halfH * (W / H)
  const rng = new Rng(seed, 5)
  const settings = { maxDepth: 6, rrStart: 100, clampIndirect: 0, integrator: (bdpt ? 'bdpt' : 'pt') as 'bdpt' | 'pt' }
  const stats: RayStats = { rays: 0 }
  let sum = 0
  for (let s = 0; s < spp; s++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const px = ((x + rng.next()) / W) * 2 - 1
        const py = 1 - ((y + rng.next()) / H) * 2
        const dir = normalize(
          add(add(scale(fwd, 1), scale(right, px * halfW)), scale(upv, py * halfH)),
        )
        const ray = { o: c.eye, d: dir, tMax: Infinity }
        const Lr = bdpt
          ? radianceBDPT(scene, ray, settings, rng, stats)
          : radiance(scene, ray, settings, rng, stats)
        sum += luminance(Lr)
      }
    }
  }
  return sum / (spp * W * H)
}

// 30 — BDPT energy: a diffuse sphere in a white furnace re-radiates exactly its
// albedo (no triangle lights, so transport is the camera walk + env on escape).
function testBdptFurnace(): { pass: boolean; detail: string } {
  const def: SceneDef = {
    name: 'furnace',
    materials: [{ kind: 'diffuse', albedo: v(0.8, 0.8, 0.8) }],
    prims: [{ kind: 'sphere', center: v(0, 0, 0), radius: 1, material: 0 }],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 30, aperture: 0, focusDist: 5 },
    env: { kind: 'solid', color: v(1, 1, 1) },
  }
  const scene = new Scene(def)
  const rng = new Rng(4242, 6)
  const settings = { maxDepth: 16, rrStart: 100, clampIndirect: 0, integrator: 'bdpt' as const }
  const stats: RayStats = { rays: 0 }
  let sum = 0
  const N = 20000
  for (let i = 0; i < N; i++) {
    const L = radianceBDPT(scene, { o: v(0, 0, 5), d: v(0, 0, -1), tMax: Infinity }, settings, rng, stats)
    sum += luminance(L)
  }
  const measured = sum / N
  const ok = approx(measured, 0.8, 2e-2)
  return { pass: ok, detail: `reflectance=${measured.toFixed(4)}, expected≈0.800` }
}

// 31 — The oracle: BDPT and the path tracer must agree on the same image. We
// render a diffuse box with both and compare mean luminance; disagreement beyond
// Monte-Carlo error would expose a bias in the bidirectional estimator.
function testBdptVsPt(): { pass: boolean; detail: string } {
  const def = diffuseBox()
  const W = 12,
    H = 9,
    spp = 280
  const pt = meanLuminance(def, false, W, H, spp, 1234)
  const bd = meanLuminance(def, true, W, H, spp, 5678)
  const rel = Math.abs(pt - bd) / pt
  return { pass: rel < 0.04, detail: `PT=${pt.toFixed(4)} BDPT=${bd.toFixed(4)} rel diff=${(rel * 100).toFixed(2)}% (<4%)` }
}

// 31b — The new material system is MIS-consistent: a closed box whose surfaces
// are a clear-coated floor, Oren–Nayar walls, a multiscatter conductor and an
// anisotropic conductor must converge to the *same* image under the path tracer
// and BDPT. Because both estimators reach these BSDFs only through the shared
// sample/eval/pdf contract, agreement proves the new lobes' pdfs (and therefore
// every NEE/BDPT MIS weight that uses them) are correct and unbiased.
function testMaterialLabVsPt(): { pass: boolean; detail: string } {
  const V = (x: number, y: number, z: number): Vec3 => v(x, y, z)
  const m: Material[] = [
    { kind: 'diffuse', albedo: V(0.7, 0.6, 0.5), coat: { roughness: 0.12, ior: 1.5 } },
    { kind: 'diffuse', albedo: V(0.6, 0.6, 0.65), sigma: 0.7 },
    { kind: 'emissive', emission: V(12, 12, 12) },
    { kind: 'metal', albedo: V(1, 0.8, 0.4), roughness: 0.5, multiscatter: true },
    { kind: 'metal', albedo: V(0.9, 0.9, 0.95), roughness: 0.3, aniso: 0.8 },
  ]
  const prims: SceneDef['prims'] = []
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3, mat: number): void => {
    prims.push({ kind: 'tri', p0: a, p1: b, p2: c, material: mat })
    prims.push({ kind: 'tri', p0: a, p1: c, p2: d, material: mat })
  }
  quad(V(-3, 0, -3), V(3, 0, -3), V(3, 0, 3), V(-3, 0, 3), 0) // coated floor
  quad(V(-3, 6, -3), V(-3, 6, 3), V(3, 6, 3), V(3, 6, -3), 1) // ceiling (Oren–Nayar)
  quad(V(-3, 0, -3), V(-3, 6, -3), V(3, 6, -3), V(3, 0, -3), 1) // back wall
  quad(V(-1.3, 5.98, -1.3), V(1.3, 5.98, -1.3), V(1.3, 5.98, 1.3), V(-1.3, 5.98, 1.3), 2) // light
  prims.push({ kind: 'sphere', center: V(-1.2, 1, 0), radius: 1, material: 3 })
  prims.push({ kind: 'sphere', center: V(1.2, 1, 0), radius: 1, material: 4 })
  const def: SceneDef = {
    name: 'material-lab',
    materials: m,
    prims,
    camera: { eye: V(0, 3, 8), target: V(0, 2, 0), up: V(0, 1, 0), vfovDeg: 45, aperture: 0, focusDist: 8 },
    env: { kind: 'solid', color: V(0, 0, 0) },
  }
  const W = 14,
    H = 11,
    spp = 420
  const pt = meanLuminance(def, false, W, H, spp, 4242)
  const bd = meanLuminance(def, true, W, H, spp, 2718)
  const rel = Math.abs(pt - bd) / pt
  return { pass: rel < 0.05, detail: `PT=${pt.toFixed(4)} BDPT=${bd.toFixed(4)} rel diff=${(rel * 100).toFixed(2)}% (<5%)` }
}

// 32 — MIS partition of unity: for a fixed transport path the weights of every
// strategy that can sample it sum to 1 — the exact property that makes the
// bidirectional estimator unbiased. A deterministic, noise-free proof.
function testBdptMis(): { pass: boolean; detail: string } {
  // A scene whose last material is the emitter and whose lights[0] is a triangle
  // covering the test path's light vertex.
  const def: SceneDef = {
    name: 'mis',
    materials: [
      { kind: 'diffuse', albedo: v(0.5, 0.5, 0.5) },
      { kind: 'emissive', emission: v(10, 10, 10) },
    ],
    prims: [
      { kind: 'tri', p0: v(-1, 3, -1), p1: v(1, 3, -1), p2: v(1, 3, 1), material: 1 },
      { kind: 'tri', p0: v(-1, 3, -1), p1: v(1, 3, 1), p2: v(-1, 3, 1), material: 1 },
    ],
    camera: { eye: v(0, 1, -3), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 40, aperture: 0, focusDist: 3 },
    env: { kind: 'solid', color: v(0, 0, 0) },
  }
  const scene = new Scene(def)
  const residual = misPartitionResidual(scene)
  return { pass: residual < 1e-9, detail: `|Σ w(s,t) − 1| = ${residual.toExponential(2)}` }
}

// 33 — Solid-angle → area density conversion (pdf_A = pdf_ω·|cosθ|/d²) that the
// BDPT MIS recurrence relies on, checked against a hand-derived value.
function testAreaDensity(): { pass: boolean; detail: string } {
  // Source at origin, target 2 units away with its normal tilted 60° off the
  // connecting direction: |cos| = 0.5, d² = 4, so pdf_A = 0.3·0.5/4 = 0.0375.
  const toNg = normalize(v(Math.sin(Math.PI / 3), 0, -Math.cos(Math.PI / 3))) // 60° from −z
  const got = areaDensity(0.3, v(0, 0, 0), v(0, 0, 2), toNg)
  const expected = (0.3 * 0.5) / 4
  const ok = approx(got, expected, 1e-9)
  return { pass: ok, detail: `pdf_A=${got.toFixed(6)}, expected=${expected.toFixed(6)}` }
}

// ---------------------------------------------------------------------------
// Primary-Sample-Space Metropolis Light Transport (PSSMLT)
// ---------------------------------------------------------------------------

// Render a scene to an HDR image with the path tracer, using the exact same
// `Camera` and `radiance` the Metropolis contribution function uses — so a PT
// reference and a PSSMLT result are directly comparable pixel for pixel.
function renderImagePT(def: SceneDef, W: number, H: number, spp: number, seed: number): Float32Array {
  const scene = new Scene(def)
  const camera = new Camera(def.camera, W / H)
  const rng = new Rng(seed, 7)
  const settings = { maxDepth: 6, rrStart: 100, clampIndirect: 0 }
  const stats: RayStats = { rays: 0 }
  const img = new Float32Array(W * H * 3)
  for (let s = 0; s < spp; s++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = (x + rng.next()) / W
        const t = 1 - (y + rng.next()) / H
        const ray = camera.generateRay(u, t, rng)
        const L = radiance(scene, ray, settings, rng, stats)
        const i = (y * W + x) * 3
        img[i] += L.x
        img[i + 1] += L.y
        img[i + 2] += L.z
      }
    }
  }
  for (let i = 0; i < img.length; i++) img[i] /= spp
  return img
}

// Mean luminance overall and across the top vs. bottom image halves. The
// top/bottom *ratio* is independent of the absolute scale b, so it isolates
// whether the chain reproduces the spatial light distribution.
function imageBlocks(img: Float32Array, W: number, H: number): { all: number; top: number; bot: number } {
  let all = 0
  let top = 0
  let bot = 0
  let nt = 0
  let nb = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      const l = luminance(v(img[i], img[i + 1], img[i + 2]))
      all += l
      if (y < H / 2) {
        top += l
        nt++
      } else {
        bot += l
        nb++
      }
    }
  }
  return { all: all / (W * H), top: top / Math.max(1, nt), bot: bot / Math.max(1, nb) }
}

function renderImageMLT(def: SceneDef, W: number, H: number, mpp: number, seed: number, nBootstrap: number): { img: Float32Array; b: number } {
  const scene = new Scene(def)
  const camera = new Camera(def.camera, W / H)
  const settings = { maxDepth: 6, rrStart: 100, clampIndirect: 0 }
  const state = new MltState(scene, camera, settings, W, H, seed, {
    nChains: 8,
    nBootstrap,
    largeStepProb: 0.3,
    sigma: 0.02,
  })
  state.step(Math.round(mpp * W * H))
  return { img: state.image(), b: state.brightness }
}

// 34 — The Metropolis sampler must be a *valid sampler*: a coordinate produced by
// a (forced) large step is a fresh uniform — mean ½, variance 1/12 — and the
// stream is deterministic for a fixed seed (so renders are reproducible).
function testMltSampler(): { pass: boolean; detail: string } {
  const N = 200000
  const smp = new PssmltSampler(42, 1, 1.0, 0.02) // largeStepProb = 1 ⇒ every step uniform
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < N; i++) {
    smp.startIteration()
    const x = smp.next()
    sum += x
    sumSq += x * x
    smp.accept()
  }
  const mean = sum / N
  const varc = sumSq / N - mean * mean
  // Determinism: two samplers with the same seed agree on their first draw.
  const a = new PssmltSampler(7, 3)
  a.startIteration()
  const b = new PssmltSampler(7, 3)
  b.startIteration()
  const det = a.next() === b.next()
  const ok = approx(mean, 0.5, 5e-3) && approx(varc, 1 / 12, 5e-3) && det
  return { pass: ok, detail: `mean=${mean.toFixed(4)}, var=${varc.toFixed(4)} (exp .0833), det=${det}` }
}

// 35 — PSSMLT energy: a diffuse sphere in a white furnace, rendered by the
// Metropolis estimator, must carry the same total light as the path tracer. The
// brightness constant b *is* the mean image luminance, so PT mean ≈ b proves the
// bootstrap normalisation is unbiased on a scene with a known analytic answer.
function testMltFurnace(): { pass: boolean; detail: string } {
  const def: SceneDef = {
    name: 'mlt-furnace',
    materials: [{ kind: 'diffuse', albedo: v(0.8, 0.8, 0.8) }],
    prims: [{ kind: 'sphere', center: v(0, 0, 0), radius: 1, material: 0 }],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 30, aperture: 0, focusDist: 5 },
    env: { kind: 'solid', color: v(1, 1, 1) },
  }
  const W = 12
  const H = 9
  const pt = imageBlocks(renderImagePT(def, W, H, 1200, 4321), W, H)
  const { img, b } = renderImageMLT(def, W, H, 400, 20011, 16000)
  const mlt = imageBlocks(img, W, H)
  const rel = Math.abs(pt.all - mlt.all) / pt.all
  const ok = rel < 0.03 && mlt.all > 0
  return { pass: ok, detail: `PT=${pt.all.toFixed(4)} MLT=${mlt.all.toFixed(4)} (b=${b.toFixed(4)}) rel=${(rel * 100).toFixed(2)}% (<3%)` }
}

// 36 — The oracle, now three-way: PSSMLT must converge to the *same image* as the
// path tracer (and therefore BDPT) on the diffuse Cornell box. We check both the
// global brightness (absolute scale) and the top/bottom luminance ratio (the
// spatial distribution, independent of scale) — a bias in the Markov chain, the
// expected-value splat, or the normalisation would break one or the other.
function testMltVsPt(): { pass: boolean; detail: string } {
  const def = diffuseBox()
  const W = 12
  const H = 9
  const pt = imageBlocks(renderImagePT(def, W, H, 1500, 1234), W, H)
  const mlt = imageBlocks(renderImageMLT(def, W, H, 500, 38299, 24000).img, W, H)
  const relAll = Math.abs(pt.all - mlt.all) / pt.all
  const ratPT = pt.top / pt.bot
  const ratM = mlt.top / mlt.bot
  const relRatio = Math.abs(ratPT - ratM) / ratPT
  const ok = relAll < 0.03 && relRatio < 0.05
  return {
    pass: ok,
    detail: `relAll=${(relAll * 100).toFixed(2)}% (<3%), top/bot PT=${ratPT.toFixed(2)} MLT=${ratM.toFixed(2)} relRatio=${(relRatio * 100).toFixed(2)}% (<5%)`,
  }
}

// ---------------------------------------------------------------------------
// Stochastic Progressive Photon Mapping (SPPM)
// ---------------------------------------------------------------------------

// 37 — The oracle, now four-way: SPPM must converge to the *same image* as the
// path tracer (and therefore BDPT and PSSMLT) on the diffuse Cornell box. SPPM
// solves the rendering equation by an entirely different mechanism — photons
// shot from the lights, gathered with a shrinking radius — so agreement on both
// the global brightness (absolute scale, which pins the photon-power
// normalisation) and the top/bottom luminance ratio (the spatial distribution)
// is a stringent, independent check of the whole pipeline.
function testSppmVsPt(): { pass: boolean; detail: string } {
  const def = diffuseBox()
  const W = 12
  const H = 9
  const pt = imageBlocks(renderImagePT(def, W, H, 600, 1234), W, H)
  const scene = new Scene(def)
  const camera = new Camera(def.camera, W / H)
  const settings = { maxDepth: 6, rrStart: 100, clampIndirect: 0 }
  const img = renderSPPM(scene, camera, settings, W, H, 16, 999, {
    photonsPerPass: 24000,
    alpha: 0.7,
    initialRadiusFrac: 0.06,
  })
  const sp = imageBlocks(img, W, H)
  const relAll = Math.abs(pt.all - sp.all) / pt.all
  const ratPT = pt.top / pt.bot
  const ratS = sp.top / sp.bot
  const relRatio = Math.abs(ratPT - ratS) / ratPT
  const ok = relAll < 0.04 && relRatio < 0.08 && sp.all > 0
  return {
    pass: ok,
    detail: `relAll=${(relAll * 100).toFixed(2)}% (<4%), top/bot PT=${ratPT.toFixed(2)} SPPM=${ratS.toFixed(2)} relRatio=${(relRatio * 100).toFixed(2)}% (<8%)`,
  }
}

// A glass sphere acting as a lens above a diffuse floor in an enclosed box lit by
// a small bright ceiling panel: the floor under the sphere catches a focused
// caustic — a light→specular→diffuse path that next-event estimation cannot
// sample (a shadow ray to the light does not refract through the glass), so it is
// exactly what photon mapping exists to resolve.
function causticBox(): SceneDef {
  const q = (p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, m: number): SceneDef['prims'] => [
    { kind: 'tri', p0, p1, p2, material: m },
    { kind: 'tri', p0, p1: p2, p2: p3, material: m },
  ]
  const X = 6
  const Y = 8
  const Z = 6
  const prims: SceneDef['prims'] = []
  prims.push(...q(v(-X, 0, -Z), v(X, 0, -Z), v(X, 0, Z), v(-X, 0, Z), 0)) // floor
  prims.push(...q(v(-X, Y, -Z), v(-X, Y, Z), v(X, Y, Z), v(X, Y, -Z), 0)) // ceiling
  prims.push(...q(v(-X, 0, Z), v(X, 0, Z), v(X, Y, Z), v(-X, Y, Z), 0)) // back
  prims.push(...q(v(-X, 0, -Z), v(-X, 0, Z), v(-X, Y, Z), v(-X, Y, -Z), 0)) // left
  prims.push(...q(v(X, 0, -Z), v(X, Y, -Z), v(X, Y, Z), v(X, 0, Z), 0)) // right
  const lh = Y - 0.02
  prims.push(...q(v(-0.8, lh, -0.8), v(0.8, lh, -0.8), v(0.8, lh, 0.8), v(-0.8, lh, 0.8), 1)) // light
  prims.push({ kind: 'sphere', center: v(0, 2.2, 0), radius: 1.3, material: 2 }) // glass lens
  return {
    name: 'caustic-box',
    materials: [
      { kind: 'diffuse', albedo: v(0.8, 0.8, 0.8) },
      { kind: 'emissive', emission: v(120, 110, 95) },
      { kind: 'dielectric', ior: 1.5, tint: v(1, 1, 1) },
    ],
    prims,
    camera: { eye: v(0, 5.5, -9), target: v(0, 1.0, 0), up: v(0, 1, 0), vfovDeg: 45, aperture: 0, focusDist: 9 },
    env: { kind: 'solid', color: v(0, 0, 0) },
  }
}

// 38 — SPPM resolves a caustic. Photons emitted from the ceiling light refract
// through the glass sphere and concentrate on the floor beneath it; the render
// must be finite everywhere, carry real energy in the caustic region, and be
// measurably brighter there than on the unfocused floor near the corners — the
// focusing that defines a caustic, and the transport the other integrators miss.
function testSppmCaustic(): { pass: boolean; detail: string } {
  const def = causticBox()
  const W = 20
  const H = 15
  const scene = new Scene(def)
  const camera = new Camera(def.camera, W / H)
  const settings = { maxDepth: 12, rrStart: 100, clampIndirect: 0 }
  const img = renderSPPM(scene, camera, settings, W, H, 16, 555, {
    photonsPerPass: 36000,
    alpha: 0.7,
    initialRadiusFrac: 0.035,
  })
  let finite = true
  for (let i = 0; i < img.length; i++) if (!Number.isFinite(img[i])) finite = false
  // Caustic region: floor directly under the lens (image bottom-centre).
  let cl = 0
  let cn = 0
  for (let y = Math.floor(H * 0.6); y < H; y++)
    for (let x = Math.floor(W * 0.38); x < Math.floor(W * 0.62); x++) {
      const i = (y * W + x) * 3
      cl += luminance(v(img[i], img[i + 1], img[i + 2]))
      cn++
    }
  // Control region: floor near a lower corner (lit, but not focused).
  let kl = 0
  let kn = 0
  for (let y = Math.floor(H * 0.6); y < H; y++)
    for (let x = 0; x < Math.floor(W * 0.14); x++) {
      const i = (y * W + x) * 3
      kl += luminance(v(img[i], img[i + 1], img[i + 2]))
      kn++
    }
  const caustic = cl / Math.max(1, cn)
  const control = kl / Math.max(1, kn)
  const ratio = caustic / Math.max(1e-6, control)
  const ok = finite && caustic > 0.5 && ratio > 1.1
  return {
    pass: ok,
    detail: `caustic L=${caustic.toFixed(3)} > control L=${control.toFixed(3)} (×${ratio.toFixed(2)}), finite=${finite}`,
  }
}

// 39 — The photon-gather acceleration structure is exact. SPPM's spatial hash
// inserts each measurement point into every cell its gather sphere overlaps, so a
// photon need only probe its own cell; this proves that probe returns *exactly*
// the points within radius — no false positives, no misses — against brute force
// over 2000 random photon positions (hash collisions only add distance tests).
function testSppmGrid(): { pass: boolean; detail: string } {
  const rng = new Rng(20260616, 1)
  const N = 400
  const px = new Float64Array(N)
  const py = new Float64Array(N)
  const pz = new Float64Array(N)
  const r2 = new Float64Array(N)
  const alive = new Uint8Array(N)
  for (let i = 0; i < N; i++) {
    px[i] = rng.range(-5, 5)
    py[i] = rng.range(-5, 5)
    pz[i] = rng.range(-5, 5)
    const r = rng.range(0.1, 0.8)
    r2[i] = r * r
    alive[i] = 1
  }
  const grid = new HashGrid()
  grid.build(N, alive, px, py, pz, r2)
  let mismatches = 0
  let incidences = 0
  for (let qq = 0; qq < 2000; qq++) {
    const qx = rng.range(-5, 5)
    const qy = rng.range(-5, 5)
    const qz = rng.range(-5, 5)
    const brute = new Set<number>()
    for (let i = 0; i < N; i++) {
      const dx = px[i] - qx
      const dy = py[i] - qy
      const dz = pz[i] - qz
      if (dx * dx + dy * dy + dz * dz <= r2[i]) brute.add(i)
    }
    const found = new Set<number>()
    grid.forEachNear(qx, qy, qz, (i) => {
      const dx = px[i] - qx
      const dy = py[i] - qy
      const dz = pz[i] - qz
      if (dx * dx + dy * dy + dz * dz <= r2[i]) found.add(i)
    })
    incidences += brute.size
    for (const i of brute) if (!found.has(i)) mismatches++
    for (const i of found) if (!brute.has(i)) mismatches++
  }
  return { pass: mismatches === 0, detail: `${incidences} in-radius incidences, ${mismatches} mismatch(es) vs brute force` }
}

// ---------------------------------------------------------------------------
// Lumen 8.0 — spectral photons & environment-sun photon emission
// ---------------------------------------------------------------------------

// The caustic box, but the glass lens is *dispersive* (a Cauchy B coefficient),
// so spectral photons fan the caustic into colour. The camera sees the floor
// directly (no glass on the eye path), so the caustic's colour comes entirely
// from the photon side.
function dispersiveCausticBox(cauchyB: number): SceneDef {
  const q = (p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, m: number): SceneDef['prims'] => [
    { kind: 'tri', p0, p1, p2, material: m },
    { kind: 'tri', p0, p1: p2, p2: p3, material: m },
  ]
  const X = 6
  const Y = 8
  const Z = 6
  const prims: SceneDef['prims'] = []
  prims.push(...q(v(-X, 0, -Z), v(X, 0, -Z), v(X, 0, Z), v(-X, 0, Z), 0))
  prims.push(...q(v(-X, Y, -Z), v(-X, Y, Z), v(X, Y, Z), v(X, Y, -Z), 0))
  prims.push(...q(v(-X, 0, Z), v(X, 0, Z), v(X, Y, Z), v(-X, Y, Z), 0))
  prims.push(...q(v(-X, 0, -Z), v(-X, 0, Z), v(-X, Y, Z), v(-X, Y, -Z), 0))
  prims.push(...q(v(X, 0, -Z), v(X, Y, -Z), v(X, Y, Z), v(X, 0, Z), 0))
  const lh = Y - 0.02
  prims.push(...q(v(-0.8, lh, -0.8), v(0.8, lh, -0.8), v(0.8, lh, 0.8), v(-0.8, lh, 0.8), 1))
  prims.push({ kind: 'sphere', center: v(0, 2.2, 0), radius: 1.3, material: 2 })
  const glass: Material =
    cauchyB > 0
      ? { kind: 'dielectric', ior: 1.5, tint: v(1, 1, 1), cauchyB }
      : { kind: 'dielectric', ior: 1.5, tint: v(1, 1, 1) }
  return {
    name: 'dispersive-caustic',
    materials: [{ kind: 'diffuse', albedo: v(0.8, 0.8, 0.8) }, { kind: 'emissive', emission: v(120, 110, 95) }, glass],
    prims,
    camera: { eye: v(0, 5.5, -9), target: v(0, 1.0, 0), up: v(0, 1, 0), vfovDeg: 45, aperture: 0, focusDist: 9 },
    env: { kind: 'solid', color: v(0, 0, 0) },
  }
}

const sumLuminance = (img: Float32Array, W: number, H: number): number => {
  let s = 0
  for (let i = 0; i < W * H; i++) s += luminance(v(img[i * 3], img[i * 3 + 1], img[i * 3 + 2]))
  return s
}

// 40 — Spectral photons conserve energy. Dispersion only *redistributes* the
// caustic's energy across colour (and therefore space) — it must not create or
// destroy any, because the per-wavelength RGB weight averages to (1,1,1). So the
// total image energy with spectral photons ON must match the achromatic render
// of the same dispersive scene. This is the white-point/normalisation oracle for
// the hero-wavelength photon walk: a wrong weight would change total brightness.
function testSpectralPhotonEnergy(): { pass: boolean; detail: string } {
  const W = 24
  const H = 18
  const settings = { maxDepth: 12, rrStart: 100, clampIndirect: 0 }
  const opts = { photonsPerPass: 60000, alpha: 0.7, initialRadiusFrac: 0.035 }
  const sceneA = new Scene(dispersiveCausticBox(0.05))
  const camA = new Camera(dispersiveCausticBox(0.05).camera, W / H)
  const achroma = renderSPPM(sceneA, camA, settings, W, H, 20, 7, { ...opts, spectralPhotons: false })
  const sceneB = new Scene(dispersiveCausticBox(0.05))
  const camB = new Camera(dispersiveCausticBox(0.05).camera, W / H)
  const spectral = renderSPPM(sceneB, camB, settings, W, H, 20, 7, { ...opts, spectralPhotons: true })
  const ea = sumLuminance(achroma, W, H)
  const es = sumLuminance(spectral, W, H)
  let finite = true
  for (let i = 0; i < spectral.length; i++) if (!Number.isFinite(spectral[i])) finite = false
  const rel = Math.abs(ea - es) / ea
  return {
    pass: finite && rel < 0.03 && ea > 0,
    detail: `total energy achromatic=${ea.toFixed(1)} spectral=${es.toFixed(1)} rel=${(rel * 100).toFixed(2)}% (<3%)`,
  }
}

// 41 — Spectral photons actually produce colour. The caustic from a dispersive
// lens must carry a measurable *chromatic spread* (some patches red-leaning,
// others blue-leaning) — the rainbow fringe — whereas the achromatic render of
// the same scene is perfectly grey. Measured as the range of (R−B)/luminance over
// the caustic region.
function testSpectralCausticColour(): { pass: boolean; detail: string } {
  const W = 24
  const H = 18
  const settings = { maxDepth: 12, rrStart: 100, clampIndirect: 0 }
  const opts = { photonsPerPass: 60000, alpha: 0.7, initialRadiusFrac: 0.035 }
  const spread = (img: Float32Array): number => {
    let lo = Infinity
    let hi = -Infinity
    for (let y = Math.floor(H * 0.55); y < H; y++)
      for (let x = Math.floor(W * 0.35); x < Math.floor(W * 0.65); x++) {
        const i = (y * W + x) * 3
        const L = luminance(v(img[i], img[i + 1], img[i + 2]))
        if (L < 0.3) continue
        const rb = (img[i] - img[i + 2]) / L
        if (rb < lo) lo = rb
        if (rb > hi) hi = rb
      }
    return hi > lo ? hi - lo : 0
  }
  const sceneA = new Scene(dispersiveCausticBox(0.05))
  const camA = new Camera(dispersiveCausticBox(0.05).camera, W / H)
  const achroma = renderSPPM(sceneA, camA, settings, W, H, 20, 7, { ...opts, spectralPhotons: false })
  const sceneB = new Scene(dispersiveCausticBox(0.05))
  const camB = new Camera(dispersiveCausticBox(0.05).camera, W / H)
  const spectral = renderSPPM(sceneB, camB, settings, W, H, 20, 7, { ...opts, spectralPhotons: true })
  const sp = spread(spectral)
  const ac = spread(achroma)
  return {
    pass: sp > 0.2 && ac < 0.02,
    detail: `chromatic spread spectral=${sp.toFixed(3)} (>0.2), achromatic=${ac.toFixed(3)} (<0.02)`,
  }
}

// A sunlit diffuse courtyard (floor + three walls, open to the sky) lit *only*
// by the environment sun against a black sky. The path tracer reaches the sun by
// next-event estimation; SPPM reaches it by emitting photons from the sun disc.
function sunCourtyard(): SceneDef {
  const q = (p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, m: number): SceneDef['prims'] => [
    { kind: 'tri', p0, p1, p2, material: m },
    { kind: 'tri', p0, p1: p2, p2: p3, material: m },
  ]
  const X = 3
  const Z = 3
  const Yc = 3
  const prims: SceneDef['prims'] = []
  prims.push(...q(v(-X, 0, -Z), v(X, 0, -Z), v(X, 0, Z), v(-X, 0, Z), 0))
  prims.push(...q(v(-X, 0, Z), v(X, 0, Z), v(X, Yc, Z), v(-X, Yc, Z), 0))
  prims.push(...q(v(-X, 0, -Z), v(-X, 0, Z), v(-X, Yc, Z), v(-X, Yc, -Z), 0))
  prims.push(...q(v(X, 0, -Z), v(X, Yc, -Z), v(X, Yc, Z), v(X, 0, Z), 0))
  return {
    name: 'sun-courtyard',
    materials: [{ kind: 'diffuse', albedo: v(0.7, 0.7, 0.7) }],
    prims,
    camera: { eye: v(0, 4.5, -6), target: v(0, 0.4, 0), up: v(0, 1, 0), vfovDeg: 50, aperture: 0, focusDist: 7 },
    env: { kind: 'gradient', top: v(0, 0, 0), bottom: v(0, 0, 0), sunDir: v(0.25, 1, 0.2), sunColor: v(7, 7, 7), sunSize: 0.06 },
  }
}

// 42 — Environment-sun photons reproduce the path tracer. Photon mapping of a
// distant light is unbiased only if the per-photon flux is normalised correctly
// for the sun-disc area (πR²) and solid angle (Ω). The oracle: the mean
// brightness of the sunlit courtyard under SPPM (sun photons) must match the path
// tracer (sun NEE). Both sample envRadiance over the same cone, so they share an
// expectation — agreement pins the sun-disc flux S = L·ΣW/lum(L_rep).
function testEnvPhotonOracle(): { pass: boolean; detail: string } {
  const W = 14
  const H = 11
  const def = sunCourtyard()
  const pt = imageBlocks(renderImagePT(def, W, H, 800, 1234), W, H)
  const scene = new Scene(def)
  const camera = new Camera(def.camera, W / H)
  const settings = { maxDepth: 6, rrStart: 100, clampIndirect: 0 }
  const sp = imageBlocks(renderSPPM(scene, camera, settings, W, H, 24, 999, { photonsPerPass: 40000, alpha: 0.7, initialRadiusFrac: 0.05 }), W, H)
  const rel = Math.abs(pt.all - sp.all) / pt.all
  return {
    pass: rel < 0.06 && sp.all > 0,
    detail: `mean brightness PT=${pt.all.toFixed(4)} SPPM=${sp.all.toFixed(4)} rel=${(rel * 100).toFixed(2)}% (<6%)`,
  }
}

// A glass sphere over a white floor under the sun: the sun's parallel beam
// refracts through the sphere and focuses to a bright caustic spot on the floor —
// the daylight caustic that only environment photons can resolve.
function sunCausticScene(): SceneDef {
  const q = (p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, m: number): SceneDef['prims'] => [
    { kind: 'tri', p0, p1, p2, material: m },
    { kind: 'tri', p0, p1: p2, p2: p3, material: m },
  ]
  const X = 5
  const Z = 5
  const Yc = 6
  const prims: SceneDef['prims'] = []
  prims.push(...q(v(-X, 0, -Z), v(X, 0, -Z), v(X, 0, Z), v(-X, 0, Z), 0))
  prims.push(...q(v(-X, 0, Z), v(X, 0, Z), v(X, Yc, Z), v(-X, Yc, Z), 1))
  prims.push({ kind: 'sphere', center: v(0, 1.8, 0), radius: 1.3, material: 2 })
  return {
    name: 'sun-caustic',
    materials: [{ kind: 'diffuse', albedo: v(0.85, 0.85, 0.85) }, { kind: 'diffuse', albedo: v(0.1, 0.1, 0.12) }, { kind: 'dielectric', ior: 1.5, tint: v(1, 1, 1) }],
    prims,
    camera: { eye: v(0, 5.0, -8.5), target: v(0, 0.2, 0), up: v(0, 1, 0), vfovDeg: 50, aperture: 0, focusDist: 9 },
    env: { kind: 'gradient', top: v(0, 0, 0), bottom: v(0, 0, 0), sunDir: v(0.12, 1, 0.05), sunColor: v(80, 80, 80), sunSize: 0.04 },
  }
}

// 43 — Environment photons resolve a daylight caustic. The sun, refracted by the
// glass sphere, must focus a bright spot on the floor — measurably brighter than
// the directly-lit floor away from it. This is a light→specular→diffuse path from
// a *distant* light, which next-event estimation cannot sample (a shadow ray to
// the sun does not refract through the glass), so it is exactly the daylight
// transport environment photons exist to capture.
function testEnvPhotonCaustic(): { pass: boolean; detail: string } {
  const def = sunCausticScene()
  const W = 28
  const H = 22
  const scene = new Scene(def)
  const camera = new Camera(def.camera, W / H)
  const settings = { maxDepth: 10, rrStart: 100, clampIndirect: 0 }
  const img = renderSPPM(scene, camera, settings, W, H, 28, 3, { photonsPerPass: 90000, alpha: 0.7, initialRadiusFrac: 0.028 })
  let finite = true
  for (let i = 0; i < img.length; i++) if (!Number.isFinite(img[i])) finite = false
  let peak = 0
  for (let y = Math.floor(H * 0.5); y < H; y++)
    for (let x = Math.floor(W * 0.35); x < Math.floor(W * 0.7); x++) {
      const i = (y * W + x) * 3
      peak = Math.max(peak, luminance(v(img[i], img[i + 1], img[i + 2])))
    }
  let kl = 0
  let kn = 0
  for (let y = Math.floor(H * 0.5); y < H; y++)
    for (let x = 0; x < Math.floor(W * 0.12); x++) {
      const i = (y * W + x) * 3
      kl += luminance(v(img[i], img[i + 1], img[i + 2]))
      kn++
    }
  const control = kl / Math.max(1, kn)
  const ratio = peak / Math.max(1e-6, control)
  return {
    pass: finite && ratio > 2 && control > 0,
    detail: `caustic peak L=${peak.toFixed(3)} vs lit-floor L=${control.toFixed(3)} (×${ratio.toFixed(2)} > 2), finite=${finite}`,
  }
}

// 11.0-a — Complex-IOR conductor Fresnel is a physical reflectance: it stays in
// [0,1] for every metal at every wavelength and angle, and rises to ≈1 at grazing
// incidence (the universal Fresnel limit — even a dark metal turns mirror-bright
// at the horizon).
function testConductorFresnelRange(): { pass: boolean; detail: string } {
  const names: ConductorName[] = ['gold', 'silver', 'copper', 'aluminium', 'iron', 'chromium']
  let inRange = true
  let minGraze = 1
  for (const name of names) {
    for (let lam = 400; lam <= 700; lam += 20) {
      const eta = conductorEta(name, lam)
      const k = conductorK(name, lam)
      for (let mi = 0; mi <= 40; mi++) {
        const mu = mi / 40
        const r = fresnelConductor(mu, eta, k)
        if (r < -1e-9 || r > 1 + 1e-9) inRange = false
      }
      minGraze = Math.min(minGraze, fresnelConductor(0.001, eta, k))
    }
  }
  // Every conductor's reflectance → 1 at grazing; high-index metals only reach it
  // very close to 90° (a pseudo-Brewster dip in p-polarisation lingers below that).
  const ok = inRange && minGraze > 0.97
  return { pass: ok, detail: `R∈[0,1]=${inRange}, min grazing R(89.9°)=${minGraze.toFixed(3)} (→1)` }
}

// 11.0-b — The conductor Fresnel reduces *exactly* to the dielectric Fresnel when
// the absorption k→0 (a transparent "metal" is just a dielectric). This pins the
// complex formula against the real-valued one we already trust.
function testConductorDielectricLimit(): { pass: boolean; detail: string } {
  let maxErr = 0
  for (const eta of [1.2, 1.5, 2.0, 2.4]) {
    for (let mi = 1; mi <= 20; mi++) {
      const cos = mi / 20
      const cond = fresnelConductor(cos, eta, 0)
      // Exact unpolarised dielectric Fresnel for a 1→eta interface.
      const e = 1 / eta
      const sin2T = e * e * (1 - cos * cos)
      const cosT = Math.sqrt(Math.max(0, 1 - sin2T))
      const rp = (e * cos - cosT) / (e * cos + cosT)
      const rs = (cos - e * cosT) / (cos + e * cosT)
      const diel = 0.5 * (rp * rp + rs * rs)
      maxErr = Math.max(maxErr, Math.abs(cond - diel))
    }
  }
  return { pass: maxErr < 1e-9, detail: `max |R_conductor(k=0) − R_dielectric| = ${maxErr.toExponential(2)}` }
}

// 11.0-c — The measured spectra reproduce the textbook metal colours: gold and
// copper are warm (R₀ ramps low-blue → high-red), silver and aluminium are bright
// and near-neutral, iron and chromium are a flat mid grey. This guards the η/k
// tables against transcription errors that would still pass the energy proofs.
function testMetalColours(): { pass: boolean; detail: string } {
  const au = conductorF0RGB('gold')
  const ag = conductorF0RGB('silver')
  const cu = conductorF0RGB('copper')
  const al = conductorF0RGB('aluminium')
  const fe = conductorF0RGB('iron')
  const goldWarm = au.x > au.y && au.y > au.z && au.x - au.z > 0.25
  const copperRed = cu.x > cu.y && cu.y > cu.z && cu.x - cu.z > 0.15
  const silverBright = Math.min(ag.x, ag.y, ag.z) > 0.85 && Math.max(ag.x, ag.y, ag.z) - Math.min(ag.x, ag.y, ag.z) < 0.1
  const alumBright = Math.min(al.x, al.y, al.z) > 0.85 && al.z >= al.x // faint blue lean
  const ironGrey = luminance(fe) > 0.45 && luminance(fe) < 0.65 && Math.max(fe.x, fe.y, fe.z) - Math.min(fe.x, fe.y, fe.z) < 0.06
  const ok = goldWarm && copperRed && silverBright && alumBright && ironGrey
  return {
    pass: ok,
    detail: `gold=(${au.x.toFixed(2)},${au.y.toFixed(2)},${au.z.toFixed(2)}) warm=${goldWarm}, copper red=${copperRed}, silver/alu bright=${silverBright && alumBright}, iron grey=${ironGrey}`,
  }
}

// 11.0-d — The headline oracle: a *smooth* spectral metal, rendered with the
// hero-wavelength path tracer in a white furnace, must reconstruct the metal's
// measured RGB reflectance. The head-on ray reflects with R(λ, μ=1) and escapes
// to the unit environment, so its expected colour over wavelengths is exactly
// conductorF0RGB(name) — the white-point proof for the whole spectral-conductor
// pipeline (η/k tables → hero wavelength → wavelengthWeight → image).
function testSpectralMetalReconstructsColour(): { pass: boolean; detail: string } {
  const expected = conductorF0RGB('gold')
  const def: SceneDef = {
    name: 'metal-furnace',
    materials: [{ kind: 'metal', albedo: expected, roughness: 0, spectrum: 'gold' }],
    prims: [{ kind: 'sphere', center: v(0, 0, 0), radius: 1, material: 0 }],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 30, aperture: 0, focusDist: 5 },
    env: { kind: 'solid', color: v(1, 1, 1) },
  }
  const scene = new Scene(def)
  const rng = new Rng(770077, 2)
  const settings = { maxDepth: 4, rrStart: 3, clampIndirect: 0 }
  const stats: RayStats = { rays: 0 }
  const N = 120000
  let sx = 0
  let sy = 0
  let sz = 0
  for (let i = 0; i < N; i++) {
    const L = radiance(scene, { o: v(0, 0, 5), d: v(0, 0, -1), tMax: Infinity }, settings, rng, stats)
    sx += L.x
    sy += L.y
    sz += L.z
  }
  const r = v(sx / N, sy / N, sz / N)
  const ex = Math.abs(r.x - expected.x)
  const ey = Math.abs(r.y - expected.y)
  const ez = Math.abs(r.z - expected.z)
  const ok = ex < 0.02 && ey < 0.02 && ez < 0.02 && r.x > r.y && r.y > r.z
  return {
    pass: ok,
    detail: `rendered=(${r.x.toFixed(3)},${r.y.toFixed(3)},${r.z.toFixed(3)}) vs F0=(${expected.x.toFixed(3)},${expected.y.toFixed(3)},${expected.z.toFixed(3)})`,
  }
}

// 11.0-e — MIS-consistency of the spectral-conductor lobe. After resolveMaterial
// bakes (η,k) at a hero wavelength, the rough metal's sampler must report the same
// pdf as the analytic pdfBSDF, and its throughput weight must equal f·cosθ/pdf —
// the in-lockstep invariant that keeps next-event estimation and BDPT unbiased.
// Checked for the plain GGX conductor *and* the Kulla–Conty multiscatter one.
function testSpectralMetalConsistency(): { pass: boolean; detail: string } {
  const n = v(0, 0, 1)
  const wo = normalize(v(0.35, 0.12, 0.9))
  let maxPdf = 0
  let maxWeight = 0
  for (const multiscatter of [false, true]) {
    const base: Material = { kind: 'metal', albedo: v(0.86, 0.7, 0.42), roughness: 0.4, spectrum: 'gold', multiscatter }
    const mat = resolveMaterial(base, v(0, 0, 0), 580) // bake (η,k) at 580 nm
    const rng = new Rng(424242, 5)
    for (let i = 0; i < 30000; i++) {
      const s = sampleBSDF(mat, wo, n, true, rng)
      if (!s || s.specular) continue
      const p = pdfBSDF(mat, wo, s.wi, n)
      maxPdf = Math.max(maxPdf, Math.abs(p - s.pdf) / Math.max(1e-6, s.pdf))
      const f = evalBSDF(mat, wo, s.wi, n)
      const cos = Math.max(0, dot(s.wi, n))
      // weight should equal f·cos/pdf (compare on luminance to avoid 0/0 channels).
      const wRef = luminance(f) * cos / Math.max(1e-9, s.pdf)
      const wGot = luminance(s.weight)
      maxWeight = Math.max(maxWeight, Math.abs(wRef - wGot) / Math.max(1e-6, wGot))
    }
  }
  const ok = maxPdf < 1e-5 && maxWeight < 1e-4
  return { pass: ok, detail: `max |Δpdf|/pdf=${maxPdf.toExponential(2)}, max |Δweight|/weight=${maxWeight.toExponential(2)}` }
}

// 11.0-f — Kulla–Conty multiscatter still restores energy for a *spectral* metal:
// a rough gold lobe with multiscatter compensation reflects measurably more than
// the single-scatter lobe at the same roughness, and never exceeds its physical
// hemispherical-average reflectance F̄ (energy is restored, not invented).
function testSpectralMetalMultiscatter(): { pass: boolean; detail: string } {
  const wo = normalize(v(0.25, 0, 0.97))
  const lam = 600
  const favg = conductorAverageFresnel(conductorEta('gold', lam), conductorK('gold', lam))
  const single = directionalReflectance(
    resolveMaterial({ kind: 'metal', albedo: v(0.86, 0.7, 0.42), roughness: 0.6, spectrum: 'gold' }, v(0, 0, 0), lam),
    wo,
    31,
  )
  const multi = directionalReflectance(
    resolveMaterial(
      { kind: 'metal', albedo: v(0.86, 0.7, 0.42), roughness: 0.6, spectrum: 'gold', multiscatter: true },
      v(0, 0, 0),
      lam,
    ),
    wo,
    32,
  )
  const ok = multi > single + 0.005 && multi <= favg + 0.02 && single < multi
  return {
    pass: ok,
    detail: `single=${single.toFixed(4)} → multi=${multi.toFixed(4)} ≤ F̄=${favg.toFixed(4)} (energy restored, bounded)`,
  }
}

// ---- Subsurface scattering (Lumen 12.0) -------------------------------------

// Render a translucent dielectric sphere of radius 1 head-on in a uniform unit
// environment and return its mean RGB radiance — the workhorse for the subsurface
// energy/colour proofs (the SSS analogue of the diffuse white furnace).
function subsurfaceFurnaceRGB(
  interior: Subsurface,
  ior: number,
  settings: { maxDepth: number; rrStart: number; clampIndirect: number },
  N: number,
  seed: number,
): Vec3 {
  const def: SceneDef = {
    name: 'sss-furnace',
    materials: [{ kind: 'dielectric', ior, tint: v(1, 1, 1), interior }],
    prims: [{ kind: 'sphere', center: v(0, 0, 0), radius: 1, material: 0 }],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 30, aperture: 0, focusDist: 5 },
    env: { kind: 'solid', color: v(1, 1, 1) },
  }
  const scene = new Scene(def)
  const rng = new Rng(seed, 5)
  const stats: RayStats = { rays: 0 }
  let sx = 0
  let sy = 0
  let sz = 0
  for (let i = 0; i < N; i++) {
    const L = radiance(scene, { o: v(0, 0, 5), d: v(0, 0, -1), tMax: Infinity }, settings, rng, stats)
    sx += L.x
    sy += L.y
    sz += L.z
  }
  return v(sx / N, sy / N, sz / N)
}

// SSS-1 — Subsurface furnace: a purely *scattering* interior (albedo 1) inside an
// index-matched boundary (ior 1, so the surface neither reflects nor bends) must
// leave a uniform field exactly unchanged — scattering only redistributes
// directions, and a uniform field is invariant under that. This must hold for ANY
// phase anisotropy g, so it doubles as the unbiasedness proof for the interior
// Henyey–Greenstein random walk. (Exercises the SSS code path, not the global
// participating-media one — the medium here is bounded by the actual surface.)
function testSubsurfaceFurnace(): { pass: boolean; detail: string } {
  const settings = { maxDepth: 64, rrStart: 48, clampIndirect: 0 }
  let worst = 0
  let detail = ''
  for (const g of [0, 0.8, -0.6]) {
    const c = subsurfaceFurnaceRGB({ sigmaT: 0.6, albedo: v(1, 1, 1), g }, 1, settings, 20000, 9001 + Math.round(g * 100))
    const m = luminance(c)
    worst = Math.max(worst, Math.abs(m - 1))
    detail += `g=${g}:${m.toFixed(4)} `
  }
  return { pass: worst < 1.5e-2, detail: `${detail}(worst|Δ|=${worst.toFixed(4)})` }
}

// SSS-2 — Beer's law from the interior free-flight: a purely *absorbing* interior
// (albedo 0, index-matched ior 1) kills the path at its first collision, so the
// only radiance reaching the camera is the unscattered ray straight through the
// sphere — transmitted with probability e^(−σ_t·chord). For a centred sphere the
// axial chord is the diameter 2r, so the measured radiance must equal e^(−σ_t·2r).
// This proves the interior distance sampler is exactly Beer's law (and that
// 1−albedo absorbs correctly).
function testSubsurfaceBeer(): { pass: boolean; detail: string } {
  const sigmaT = 0.8
  const settings = { maxDepth: 8, rrStart: 4, clampIndirect: 0 }
  const c = subsurfaceFurnaceRGB({ sigmaT, albedo: v(0, 0, 0), g: 0 }, 1, settings, 60000, 2024)
  const measured = luminance(c)
  const expected = Math.exp(-sigmaT * 2) // chord = 2r, r = 1
  return { pass: approx(measured, expected, 1e-2), detail: `transmitted=${measured.toFixed(4)}, e^(−σ·2r)=${expected.toFixed(4)}` }
}

// SSS-3 — The *whole translucent object* conserves energy. With a real Fresnel
// boundary (ior 1.5) and a lossless scattering interior (albedo 1), a furnace must
// still return ≈1: every photon is either reflected at the interface, or refracts
// in, scatters losslessly (with total-internal-reflection trapping it through many
// internal bounces), and refracts back out — none created, none destroyed. This is
// the strongest SSS invariant: it couples the dielectric interface, TIR, and the
// multiple-scattering walk into one energy balance.
function testSubsurfaceInterfaceEnergy(): { pass: boolean; detail: string } {
  const settings = { maxDepth: 64, rrStart: 48, clampIndirect: 0 }
  const c = subsurfaceFurnaceRGB({ sigmaT: 0.6, albedo: v(1, 1, 1), g: 0.3 }, 1.5, settings, 30000, 7777)
  const measured = luminance(c)
  return { pass: measured > 0.98 && measured <= 1.02, detail: `translucent furnace=${measured.toFixed(4)} (Fresnel + TIR + scatter, exp 1)` }
}

// SSS-4 — Per-channel albedo tints subsurface transport. With a real boundary
// (ior 1.5) and an interior albedo (0.9, 0.5, 0.2), the lightly-absorbed red must
// exit brighter than green than blue (R > G > B), and every channel stays ≤ 1
// (energy bounded). This is the mechanism behind the colour of marble, jade and
// skin — a spectral absorption that deepens with the distance light travels
// inside, not a surface pigment.
function testSubsurfaceColour(): { pass: boolean; detail: string } {
  const settings = { maxDepth: 32, rrStart: 16, clampIndirect: 0 }
  const c = subsurfaceFurnaceRGB({ sigmaT: 1.2, albedo: v(0.9, 0.5, 0.2), g: 0.4 }, 1.5, settings, 24000, 13337)
  const ordered = c.x > c.y + 0.01 && c.y > c.z + 0.01
  const bounded = c.x <= 1.01 && c.z >= 0
  return {
    pass: ordered && bounded,
    detail: `rendered=(${c.x.toFixed(3)},${c.y.toFixed(3)},${c.z.toFixed(3)}) R>G>B=${ordered}, ≤1=${bounded}`,
  }
}

// SSS-5 — Subsurface reflectance is strictly monotonic in the interior albedo.
// With a fixed Fresnel boundary (ior 1.5) and extinction, raising the
// single-scattering albedo (less absorbed per collision) must make a translucent
// object reflect *more* of a uniform field — and never exceed it. A monotone
// rising sequence (0.3 → 0.6 → 0.9), all bounded ≤1, proves the per-collision
// absorption β ×= albedo behaves physically across the whole range, not just at
// the lossless (=1) and fully-absorbing (=0) endpoints the other proofs pin down.
function testSubsurfaceAlbedoMonotone(): { pass: boolean; detail: string } {
  const settings = { maxDepth: 48, rrStart: 24, clampIndirect: 0 }
  const r: number[] = []
  for (const a of [0.3, 0.6, 0.9]) {
    const c = subsurfaceFurnaceRGB({ sigmaT: 1.0, albedo: v(a, a, a), g: 0.4 }, 1.5, settings, 18000, 555 + Math.round(a * 100))
    r.push(luminance(c))
  }
  const rising = r[1] > r[0] + 0.01 && r[2] > r[1] + 0.01
  const bounded = r[2] <= 1.01
  return {
    pass: rising && bounded,
    detail: `reflectance: a=0.3→${r[0].toFixed(3)}, 0.6→${r[1].toFixed(3)}, 0.9→${r[2].toFixed(3)} (rising=${rising}, ≤1=${bounded})`,
  }
}

// ---- Spectral subsurface scattering — chromatic mean free path (Lumen 15.0) --

// SSS-6 — The RGB→wavelength upsampling `spectralAt` is the contract every
// chromatic-SSS proof rests on, so pin its three defining properties directly:
// (a) it reproduces each channel exactly at that channel's representative
// wavelength (B@450, G@550, R@650 nm); (b) it never leaves the [min,max] envelope
// of the three channels (so positivity and an upper bound are inherited from the
// inputs — the precondition for a valid extinction and a valid albedo ≤ 1); and
// (c) it is *constant* across the band for an achromatic (equal-channel) triple,
// which is exactly what makes a chromatic medium with equal σ_t collapse onto the
// scalar 12.0 walk (proved end-to-end in SSS-10).
function testSpectralUpsampling(): { pass: boolean; detail: string } {
  const c = v(0.2, 0.5, 0.9) // R, G, B
  const atB = spectralAt(c, LAMBDA_B)
  const atG = spectralAt(c, LAMBDA_G)
  const atR = spectralAt(c, LAMBDA_R)
  const reproduces = approx(atB, c.z, 1e-9) && approx(atG, c.y, 1e-9) && approx(atR, c.x, 1e-9)
  const lo = Math.min(c.x, c.y, c.z)
  const hi = Math.max(c.x, c.y, c.z)
  let envelope = true
  for (let i = 0; i <= 80; i++) {
    const lambda = 380 + (i / 80) * (720 - 380)
    const s = spectralAt(c, lambda)
    if (s < lo - 1e-9 || s > hi + 1e-9) envelope = false
  }
  // Below 450 nm holds blue; above 650 nm holds red (no extrapolation blow-up).
  const clampedEnds = approx(spectralAt(c, 380), c.z, 1e-9) && approx(spectralAt(c, 720), c.x, 1e-9)
  // Achromatic ⇒ flat spectrum at every wavelength.
  const flat = v(0.6, 0.6, 0.6)
  let constant = true
  for (let i = 0; i <= 40; i++) {
    const lambda = 380 + (i / 40) * (720 - 380)
    if (!approx(spectralAt(flat, lambda), 0.6, 1e-12)) constant = false
  }
  const pass = reproduces && envelope && clampedEnds && constant
  return {
    pass,
    detail: `reproduce@RGB=${reproduces}, in[${lo},${hi}]=${envelope}, ends-held=${clampedEnds}, achromatic-flat=${constant}`,
  }
}

// SSS-7 — The measured BSSRDF library (Jensen et al. 2001) decodes to physically
// sane media. For every preset: the per-channel extinction σ_t = σ_s′/(1−g)+σ_a is
// strictly positive, and the single-scattering albedo ϖ = σ_s/σ_t lies in [0,1]
// (it *is* a survival probability, so a value outside [0,1] would be a transcription
// or conversion bug the energy tests can't localise). For the organic media whose
// look is defined by red translucency (skin/marble/milk), red must have the
// *smallest* extinction — the longest mean free path, the mechanism behind their
// glow. And `scale` must act linearly on σ_t (a 3× scale triples every channel's
// extinction) while leaving the albedo — a ratio — invariant.
function testBssrdfPresets(): { pass: boolean; detail: string } {
  const names = Object.keys(BSSRDF_MEASUREMENTS) as MediumName[]
  let positive = true
  let albedoOk = true
  for (const n of names) {
    const s = subsurfacePreset(n, 1)
    const st = s.sigmaTSpectral!
    const a = s.albedoSpectral!
    if (!(st.x > 0 && st.y > 0 && st.z > 0)) positive = false
    if (a.x < 0 || a.x > 1 || a.y < 0 || a.y > 1 || a.z < 0 || a.z > 1) albedoOk = false
  }
  // Red penetrates furthest (lowest σ_t) for the red-translucent media.
  let redDeepest = true
  for (const n of ['skin1', 'skin2', 'marble'] as MediumName[]) {
    const st = subsurfacePreset(n, 1).sigmaTSpectral!
    if (!(st.x < st.y && st.y < st.z)) redDeepest = false
  }
  // Scale is linear in σ_t; albedo (a ratio) is scale-invariant.
  const s1 = subsurfacePreset('marble', 1)
  const s3 = subsurfacePreset('marble', 3)
  const scaleLinear =
    approx(s3.sigmaTSpectral!.x, 3 * s1.sigmaTSpectral!.x, 1e-9) &&
    approx(s3.sigmaTSpectral!.z, 3 * s1.sigmaTSpectral!.z, 1e-9) &&
    approx(s3.albedoSpectral!.x, s1.albedoSpectral!.x, 1e-9)
  const pass = positive && albedoOk && redDeepest && scaleLinear
  return {
    pass,
    detail: `${names.length} media: σ_t>0=${positive}, ϖ∈[0,1]=${albedoOk}, red-deepest(skin/marble)=${redDeepest}, scale-linear=${scaleLinear}`,
  }
}

// SSS-8 — Spectral furnace: energy conservation is independent of the chromatic
// mean free path. A purely *scattering* interior (albedo 1 at every wavelength)
// behind an index-matched boundary must leave a uniform unit field unchanged — even
// when the per-channel extinction is wildly chromatic (here red flies through, blue
// is dense). Scattering only redistributes directions; the hero-wavelength weight
// reconstructs to white (E_λ[w]=1). This is the chromatic generalisation of SSS-1
// and the unbiasedness proof for the wavelength-resolved interior walk.
function testSpectralSubsurfaceFurnace(): { pass: boolean; detail: string } {
  const settings = { maxDepth: 64, rrStart: 48, clampIndirect: 0 }
  const interior: Subsurface = {
    sigmaT: 0.93,
    albedo: v(1, 1, 1),
    g: 0.2,
    sigmaTSpectral: v(0.4, 0.9, 1.6), // chromatic: red deep, blue shallow
    albedoSpectral: v(1, 1, 1),
  }
  const c = subsurfaceFurnaceRGB(interior, 1, settings, 30000, 4242)
  const worst = Math.max(Math.abs(c.x - 1), Math.abs(c.y - 1), Math.abs(c.z - 1))
  return {
    pass: worst < 2e-2,
    detail: `spectral furnace=(${c.x.toFixed(4)},${c.y.toFixed(4)},${c.z.toFixed(4)}) worst|Δ|=${worst.toFixed(4)} (exp 1 ∀λ)`,
  }
}

// SSS-9 — Spectral Beer's law: the hero-wavelength walk reconstructs the *spectral*
// transmittance integral, not a naive RGB Beer law. A purely *absorbing* interior
// (albedo 0, index-matched) kills the path at its first collision, so only the
// unscattered ray survives — with probability e^(−σ_t(λ)·2r) at the path's
// wavelength. Averaging the committed wavelengthWeight over uniformly-sampled λ, the
// rendered RGB equals (1/Δλ)∫ w(λ)·e^(−σ_t(λ)·2r) dλ — which we evaluate by fine
// deterministic quadrature as the ground truth (mirroring the heterogeneous
// ratio-tracking proof). And because σ_t,red < σ_t,green < σ_t,blue, the survivor
// is reddest: R > G > B — chromatic penetration, rendered.
function testSpectralSubsurfaceBeer(): { pass: boolean; detail: string } {
  const settings = { maxDepth: 8, rrStart: 4, clampIndirect: 0 }
  const sigmaTSpectral = v(0.35, 0.8, 1.5) // red travels far, blue is absorbed near the surface
  const interior: Subsurface = { sigmaT: 0.88, albedo: v(0, 0, 0), g: 0, sigmaTSpectral, albedoSpectral: v(0, 0, 0) }
  const c = subsurfaceFurnaceRGB(interior, 1, settings, 80000, 9090)
  // Deterministic spectral quadrature of the same estimator's expectation.
  const N = 2048
  let qx = 0
  let qy = 0
  let qz = 0
  for (let i = 0; i < N; i++) {
    const lambda = LAMBDA_MIN + ((i + 0.5) / N) * (LAMBDA_MAX - LAMBDA_MIN)
    const w = wavelengthWeight(lambda)
    const T = Math.exp(-spectralAt(sigmaTSpectral, lambda) * 2) // chord = 2r, r = 1
    qx += w.x * T
    qy += w.y * T
    qz += w.z * T
  }
  const ref = v(qx / N, qy / N, qz / N)
  const err = Math.max(Math.abs(c.x - ref.x), Math.abs(c.y - ref.y), Math.abs(c.z - ref.z))
  const ordered = c.x > c.y + 0.01 && c.y > c.z + 0.01
  return {
    pass: err < 1.5e-2 && ordered,
    detail: `rendered=(${c.x.toFixed(3)},${c.y.toFixed(3)},${c.z.toFixed(3)}) quad=(${ref.x.toFixed(3)},${ref.y.toFixed(3)},${ref.z.toFixed(3)}) maxΔ=${err.toFixed(4)}, R>G>B=${ordered}`,
  }
}

// SSS-10 — The chromatic walk *generalises* the scalar 12.0 walk: feed it an
// achromatic medium (equal σ_t and equal albedo per channel, behind a real Fresnel
// ior=1.5 boundary) and it must converge to the same image the scalar walk produces
// — same Fresnel reflection, same TIR, same multiple scattering. The spectral path
// still commits a hero wavelength and runs monochromatically, so the RNG streams
// differ; the agreement is therefore an unbiasedness *oracle* (means match), exactly
// like the metal k→0 and BDPT≡PT proofs. This is what licenses shipping the spectral
// path as a superset without touching the scalar one.
function testSpectralReducesToScalar(): { pass: boolean; detail: string } {
  const settings = { maxDepth: 48, rrStart: 24, clampIndirect: 0 }
  const sigmaT = 0.7
  const albedo = v(0.6, 0.6, 0.6)
  const scalarC = subsurfaceFurnaceRGB({ sigmaT, albedo, g: 0.3 }, 1.5, settings, 30000, 31337)
  const spectral: Subsurface = { sigmaT, albedo, g: 0.3, sigmaTSpectral: v(sigmaT, sigmaT, sigmaT), albedoSpectral: albedo }
  const spectralC = subsurfaceFurnaceRGB(spectral, 1.5, settings, 30000, 31338)
  const ms = luminance(scalarC)
  const mp = luminance(spectralC)
  const rel = Math.abs(mp - ms) / ms
  return {
    pass: rel < 1.5e-2,
    detail: `scalar=${ms.toFixed(4)}, spectral(achromatic)=${mp.toFixed(4)}, rel.Δ=${(rel * 100).toFixed(2)}% (oracle)`,
  }
}

// SSS-11 — The headline, rendered from *measured* data: a real medium from the
// Jensen library, behind a real Fresnel boundary and scattering (not just
// absorbing), produces red-biased translucency. `skin2`'s measured chromatic
// extinction alone (no hand-tuned pigment) makes the back-lit slab exit reddest —
// the look the whole version is for, and a guard that the measured table flows
// correctly through the conversion, the spectral walk and the boundary into pixels.
function testMeasuredMediumGlow(): { pass: boolean; detail: string } {
  const settings = { maxDepth: 48, rrStart: 24, clampIndirect: 0 }
  const interior = subsurfacePreset('skin2', 1.1, 0.0)
  const c = subsurfaceFurnaceRGB(interior, 1.4, settings, 30000, 246813)
  const ordered = c.x > c.y + 0.01 && c.y > c.z + 0.01
  const bounded = c.x <= 1.01 && c.z >= 0
  return {
    pass: ordered && bounded,
    detail: `skin2 rendered=(${c.x.toFixed(3)},${c.y.toFixed(3)},${c.z.toFixed(3)}) R>G>B=${ordered}, bounded=${bounded}`,
  }
}

// ---- Path guiding (the SD-tree, Müller et al. 2017) -------------------------

// 62 — The learned directional quadtree is a valid probability density: its
// solid-angle pdf must integrate to 1 over the whole sphere. We train a DTree on
// a concentrated lobe + a dim background, refine it, then Monte-Carlo-integrate
// ∫ pdf(ω) dω by sampling the sphere uniformly (density 1/4π) — the mean pdf must
// be 1/4π, i.e. ∫ = mean·4π = 1. A density that integrates to 1 is exactly what
// keeps the guided estimator unbiased for any learned distribution.
function testGuideDensityNormalised(): { pass: boolean; detail: string } {
  const dt = new DTree()
  const rng = new Rng(99, 1)
  for (let i = 0; i < 60000; i++) dt.record(0.9 + rng.next() * 0.08, rng.next(), 5)
  for (let i = 0; i < 20000; i++) dt.record(rng.next(), rng.next(), 0.2)
  dt.build()
  let sum = 0
  const N = 300000
  for (let i = 0; i < N; i++) {
    const z = 2 * rng.next() - 1
    const phi = 2 * Math.PI * rng.next()
    const r = Math.sqrt(Math.max(0, 1 - z * z))
    const sq = dirToSquare(v(r * Math.cos(phi), z, r * Math.sin(phi)))
    sum += dt.pdf(sq.u, sq.v)
  }
  const integral = (sum / N) * 4 * Math.PI
  return { pass: approx(integral, 1, 0.02), detail: `∫pdf dω=${integral.toFixed(4)} (target 1)` }
}

// 63 — Sampler ↔ pdf consistency: the density `sample()` reports for a drawn
// direction must equal what `pdf()` independently computes for it — the invariant
// every MIS weight in the guided integrator leans on. Must hold to machine ε.
function testGuideSamplerPdf(): { pass: boolean; detail: string } {
  const dt = new DTree()
  const rng = new Rng(123, 1)
  for (let i = 0; i < 40000; i++) dt.record(0.3 + 0.3 * rng.next(), 0.5 + 0.3 * rng.next(), 3)
  dt.build()
  let maxRel = 0
  for (let i = 0; i < 40000; i++) {
    const s = dt.sample(rng)
    const p = dt.pdf(s.u, s.v)
    maxRel = Math.max(maxRel, Math.abs(p - s.pdf) / (s.pdf + 1e-12))
    // The sampled (u,v) and its round-tripped direction must agree too.
    const d = squareToDir(s.u, s.v)
    const back = dirToSquare(d)
    maxRel = Math.max(maxRel, Math.abs(back.u - s.u), Math.abs(back.v - s.v))
  }
  return { pass: maxRel < 1e-6, detail: `max rel error=${maxRel.toExponential(2)} (<1e-6)` }
}

// 64 — Importance sampling provably cuts variance. Integrate a concentrated
// "light" lobe two ways — uniformly vs. from a DTree trained on it over several
// refine iterations — at equal sample counts. The means must agree (unbiased)
// while the guided variance collapses (this is the entire point of guiding).
function testGuideVarianceReduction(): { pass: boolean; detail: string } {
  const rng = new Rng(5, 1)
  const target = (d: Vec3) => (d.x > 0.95 ? 60 : 0) + 0.02
  const dt = new DTree()
  for (let iter = 0; iter < 8; iter++) {
    for (let i = 0; i < 120000; i++) {
      const z = 2 * rng.next() - 1
      const phi = 2 * Math.PI * rng.next()
      const r = Math.sqrt(Math.max(0, 1 - z * z))
      const d = v(r * Math.cos(phi), z, r * Math.sin(phi))
      const sq = dirToSquare(d)
      dt.record(sq.u, sq.v, target(d))
    }
    dt.build()
  }
  const M = 150000
  let su = 0,
    su2 = 0
  for (let i = 0; i < M; i++) {
    const z = 2 * rng.next() - 1
    const phi = 2 * Math.PI * rng.next()
    const r = Math.sqrt(Math.max(0, 1 - z * z))
    const f = target(v(r * Math.cos(phi), z, r * Math.sin(phi))) * 4 * Math.PI
    su += f
    su2 += f * f
  }
  const meanU = su / M
  const varU = su2 / M - meanU * meanU
  let sg = 0,
    sg2 = 0
  for (let i = 0; i < M; i++) {
    const s = dt.sample(rng)
    const f = target(squareToDir(s.u, s.v)) / s.pdf
    sg += f
    sg2 += f * f
  }
  const meanG = sg / M
  const varG = sg2 / M - meanG * meanG
  const sameMean = Math.abs(meanU - meanG) / meanU < 0.02
  const ratio = varG / varU
  return {
    pass: sameMean && ratio < 0.3,
    detail: `mean U=${meanU.toFixed(3)} G=${meanG.toFixed(3)}; var ratio G/U=${ratio.toExponential(2)} (<0.3)`,
  }
}

// Mean image luminance of the diffuse box rendered by the *guided* path tracer,
// driving the SD-tree's iteration refinement at power-of-two sample boundaries
// exactly as the renderer does. Deterministic for a fixed seed.
function meanLuminanceGuided(def: SceneDef, W: number, H: number, spp: number, seed: number): number {
  const scene = new Scene(def)
  const c = def.camera
  const fwd = normalize(sub(c.target, c.eye))
  const right = normalize(cross(fwd, c.up))
  const upv = cross(right, fwd)
  const halfH = Math.tan((c.vfovDeg * Math.PI) / 180 / 2)
  const halfW = halfH * (W / H)
  const rng = new Rng(seed, 5)
  const settings = { maxDepth: 6, rrStart: 100, clampIndirect: 0, integrator: 'guided' as const }
  const stats: RayStats = { rays: 0 }
  const guide = new Guide(scene.bounds)
  let sum = 0
  for (let s = 0; s < spp; s++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const px = ((x + rng.next()) / W) * 2 - 1
        const py = 1 - ((y + rng.next()) / H) * 2
        const dir = normalize(add(add(scale(fwd, 1), scale(right, px * halfW)), scale(upv, py * halfH)))
        const Lr = radiance(scene, { o: c.eye, d: dir, tMax: Infinity }, settings, rng, stats, undefined, guide)
        sum += luminance(Lr)
      }
    }
    if ((s + 1 & s) === 0) guide.endIteration() // power-of-two boundary
  }
  return sum / (spp * W * H)
}

// 65 — The unbiasedness oracle: the guided path tracer must converge to the SAME
// image as the plain path tracer on a real indirect-lit box. Agreement to within
// Monte-Carlo error proves the mixture-density weighting (α·p_bsdf+(1−α)·p_guide)
// and the radiance recording introduce no bias — guiding only reshapes variance.
function testGuideVsPt(): { pass: boolean; detail: string } {
  const def = diffuseBox()
  const W = 12,
    H = 9,
    spp = 320
  const pt = meanLuminance(def, false, W, H, spp, 1234)
  const g = meanLuminanceGuided(def, W, H, spp, 4321)
  const rel = Math.abs(pt - g) / pt
  return { pass: rel < 0.04, detail: `PT=${pt.toFixed(4)} Guided=${g.toFixed(4)} rel diff=${(rel * 100).toFixed(2)}% (<4%)` }
}

// ---- 14.0 Importance sampling of many lights — the light BVH ----------------

// A reproducible bag of N small emissive triangles scattered through a box, with
// assorted positions and colours, used to exercise the light tree's selection math.
function lightTriangles(N: number, seed: number): { primId: number; tri: ReturnType<typeof makeTriangle>; emission: Vec3 }[] {
  const rng = new Rng(seed, 1)
  const out: { primId: number; tri: ReturnType<typeof makeTriangle>; emission: Vec3 }[] = []
  for (let i = 0; i < N; i++) {
    const cx = rng.range(-3, 3)
    const cy = rng.range(1, 4)
    const cz = rng.range(-3, 3)
    const s = 0.05
    const tri = makeTriangle(v(cx - s, cy, cz - s), v(cx + s, cy, cz - s), v(cx - s, cy, cz + s), 0)
    out.push({ primId: i, tri, emission: v(rng.range(0.2, 1), rng.range(0.2, 1), rng.range(0.2, 1)) })
  }
  return out
}

// 66 — The selection pdf is a proper distribution: at any shade point the per-light
// probabilities the tree assigns must sum to exactly 1 (it is a probability tree,
// normalised at every split). This is the structural precondition for the MIS pdf
// to be valid — if the masses did not sum to 1 the estimator would be biased.
function testLightTreeNormalised(): { pass: boolean; detail: string } {
  const N = 150
  const tree = buildLightTree(lightTriangles(N, 7))
  const rng = new Rng(31, 2)
  let maxErr = 0
  for (let t = 0; t < 300; t++) {
    const p = v(rng.range(-5, 5), rng.range(-2, 3), rng.range(-5, 5))
    let s = 0
    for (let i = 0; i < N; i++) s += tree.prob(p, i)
    maxErr = Math.max(maxErr, Math.abs(s - 1))
  }
  return { pass: maxErr < 1e-9, detail: `max|Σₗ p(l)−1|=${maxErr.toExponential(1)} over 300 points (<1e-9)` }
}

// 67 — Positivity ⇒ unbiasedness: every light must keep a *strictly positive*
// selection probability from every shade point, so no contributing light is ever
// excluded (the floored orientation term + clamped distance guarantee it). A zero
// anywhere would make NEE blind to that light and bias the result.
function testLightTreePositive(): { pass: boolean; detail: string } {
  const N = 150
  const tree = buildLightTree(lightTriangles(N, 7))
  const rng = new Rng(42, 2)
  let minP = Infinity
  for (let t = 0; t < 60; t++) {
    const p = v(rng.range(-6, 6), rng.range(-3, 4), rng.range(-6, 6))
    for (let i = 0; i < N; i++) minP = Math.min(minP, tree.prob(p, i))
  }
  return { pass: minP > 0, detail: `min selection prob=${minP.toExponential(2)} (>0 ⇒ every light reachable ⇒ unbiased)` }
}

// 68 — Sampler ↔ pdf consistency: the stochastic root→leaf descent must realise the
// exact distribution that prob() reports, so the MIS weight is correct. The
// empirical selection frequencies over many draws match tree.prob to Monte-Carlo
// precision (the same proof shape as the GGX and SD-tree sampler↔pdf checks).
function testLightTreeSamplerPdf(): { pass: boolean; detail: string } {
  const N = 80
  const tree = buildLightTree(lightTriangles(N, 9))
  const p = v(0.5, 0.2, -0.3)
  const rng = new Rng(77, 2)
  const M = 300000
  const counts = new Float64Array(N)
  for (let i = 0; i < M; i++) counts[tree.sample(p, rng).primId]++
  let maxErr = 0
  for (let i = 0; i < N; i++) maxErr = Math.max(maxErr, Math.abs(counts[i] / M - tree.prob(p, i)))
  return { pass: maxErr < 6e-3, detail: `max|freq−pdf|=${maxErr.toExponential(2)} over ${N} lights, ${(M / 1000) | 0}k draws (<6e-3)` }
}

// 69 — Reduction to the uniform sampler: when the clusters carry equal importance
// the tree must degrade gracefully to the 1/N selection it generalises. Coincident
// equal-power lights collapse every box to one point, so the only thing left to
// weight by is power — equal — and each light is selected exactly 1/N.
function testLightTreeReducesToUniform(): { pass: boolean; detail: string } {
  const K = 8
  const prims = []
  for (let i = 0; i < K; i++) {
    prims.push({
      primId: i,
      tri: makeTriangle(v(-0.05, 2, -0.05), v(0.05, 2, -0.05), v(-0.05, 2, 0.05), 0),
      emission: v(0.6, 0.6, 0.6),
    })
  }
  const tree = buildLightTree(prims)
  const rng = new Rng(5, 2)
  let maxErr = 0
  for (let t = 0; t < 40; t++) {
    const p = v(rng.range(-3, 3), rng.range(-3, 3), rng.range(-3, 3))
    for (let i = 0; i < K; i++) maxErr = Math.max(maxErr, Math.abs(tree.prob(p, i) - 1 / K))
  }
  return { pass: maxErr < 1e-12, detail: `coincident equal-power ⇒ max|p−1/N|=${maxErr.toExponential(1)} (exact uniform reduction)` }
}

// 70 — The headline payoff (and the unbiasedness oracle): on a many-lights scene —
// one bright NEAR light over a diffuse point, drowned out by 60 dim FAR ones —
// the tree-sampled and uniform NEE estimators must agree in the *mean* (so the tree
// is unbiased) while the tree's per-sample *variance* is far lower (so it is a real
// win). The means are checked to agree within a few combined standard errors; the
// variance ratio must be a clear improvement.
function testManyLightsVariance(): { pass: boolean; detail: string } {
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.7, 0.7, 0.7) },
    { kind: 'emissive', emission: v(12, 12, 12) },
    { kind: 'emissive', emission: v(4, 4, 4) },
  ]
  const prims: PrimDef[] = [
    { kind: 'tri', p0: v(-50, 0, -50), p1: v(50, 0, -50), p2: v(-50, 0, 50), material: 0 },
    { kind: 'tri', p0: v(50, 0, -50), p1: v(50, 0, 50), p2: v(-50, 0, 50), material: 0 },
  ]
  const down = (cx: number, cy: number, cz: number, s: number, m: number): PrimDef => ({
    kind: 'tri',
    p0: v(cx - s, cy, cz - s),
    p1: v(cx + s, cy, cz - s),
    p2: v(cx - s, cy, cz + s),
    material: m,
  })
  prims.push(down(0, 2, 0, 0.25, 1)) // the bright near light
  const r0 = new Rng(11, 1)
  for (let i = 0; i < 60; i++) prims.push(down(r0.range(-12, 12), r0.range(4, 9), -12, 0.3, 2)) // dim far wall
  const scene = new Scene({
    name: 'many-lights',
    materials,
    prims,
    camera: { eye: v(0, 2, 6), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 40, aperture: 0, focusDist: 6 },
    env: { kind: 'solid', color: v(0, 0, 0) },
  })
  const x = v(0, 0.001, 0)
  const n = v(0, 1, 0)
  const rho = 0.7
  // One unbiased direct-lighting NEE sample at the floor point (Lambert BRDF).
  const estimate = (rng: Rng, useTree: boolean): number => {
    const ls = scene.sampleLight(x, rng, useTree)
    if (!ls || ls.pdf <= 0) return 0
    const cosX = Math.max(0, dot(n, ls.wi))
    if (cosX <= 0) return 0
    if (scene.occluded(x, ls.wi, 1e-4, ls.dist - 1e-3)) return 0
    return ((rho / Math.PI) * luminance(ls.radiance) * cosX) / ls.pdf
  }
  const run = (useTree: boolean, seed: number) => {
    const rng = new Rng(seed, useTree ? 2 : 3)
    const M = 30000
    let s = 0
    let s2 = 0
    for (let i = 0; i < M; i++) {
      const e = estimate(rng, useTree)
      s += e
      s2 += e * e
    }
    const mean = s / M
    const varr = Math.max(0, s2 / M - mean * mean)
    return { mean, varr, se: Math.sqrt(varr / M) }
  }
  const u = run(false, 123)
  const t = run(true, 456)
  const z = Math.abs(u.mean - t.mean) / Math.sqrt(u.se * u.se + t.se * t.se)
  const ratio = u.varr / Math.max(t.varr, 1e-30)
  return {
    pass: z < 4 && ratio > 3,
    detail: `mean U=${u.mean.toFixed(4)} tree=${t.mean.toFixed(4)} (Δ=${z.toFixed(1)} SE ⇒ unbiased); variance U/tree=${ratio.toFixed(0)}× (>3)`,
  }
}

// ---- 17.0 Light tree: receiver-aware importance + SAH splitting -------------

// LT-1 — Receiver-aware selection is still a proper distribution. Folding the shade
// point's normal into the cluster importance changes *which* light is favoured, but
// it must not break normalisation: at any point, for any surface normal, the
// per-light selection probabilities must still sum to exactly 1 (the tree is
// renormalised at every split regardless of the importance values fed in). This is
// the structural precondition that keeps the receiver-aware MIS pdf valid/unbiased.
function testLightTreeReceiverNormalised(): { pass: boolean; detail: string } {
  const N = 150
  const tree = buildLightTree(lightTriangles(N, 7))
  const rng = new Rng(31, 2)
  let maxErr = 0
  for (let t = 0; t < 300; t++) {
    const p = v(rng.range(-5, 5), rng.range(-2, 3), rng.range(-5, 5))
    const nRecv = normalize(v(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)))
    let s = 0
    for (let i = 0; i < N; i++) s += tree.prob(p, i, nRecv)
    maxErr = Math.max(maxErr, Math.abs(s - 1))
  }
  return { pass: maxErr < 1e-9, detail: `max|Σₗ p(l|n)−1|=${maxErr.toExponential(1)} over 300 (point,normal) (<1e-9)` }
}

// LT-2 — Receiver-aware sampler ↔ pdf consistency. The stochastic descent, when
// given the receiver normal, must realise exactly the distribution prob() reports
// with that same normal — otherwise the MIS weight on a BSDF-sampled emitter hit
// (which recomputes prob with the stored vertex normal) would be inconsistent and
// bias the estimate. Empirical frequencies match prob to Monte-Carlo precision.
function testLightTreeReceiverSamplerPdf(): { pass: boolean; detail: string } {
  const N = 80
  const tree = buildLightTree(lightTriangles(N, 9))
  const p = v(0.5, 0.2, -0.3)
  const nRecv = normalize(v(0.2, 1, -0.1))
  const rng = new Rng(77, 2)
  const M = 300000
  const counts = new Float64Array(N)
  for (let i = 0; i < M; i++) counts[tree.sample(p, rng, nRecv).primId]++
  let maxErr = 0
  for (let i = 0; i < N; i++) maxErr = Math.max(maxErr, Math.abs(counts[i] / M - tree.prob(p, i, nRecv)))
  return { pass: maxErr < 6e-3, detail: `max|freq−pdf|=${maxErr.toExponential(2)} with receiver normal (<6e-3)` }
}

// LT-3 — The receiver term actually steers samples to the lit hemisphere. With a
// cluster of lights *in front* of the surface (above the normal) and an equal
// cluster *behind* it (below the horizon, where they can only contribute zero), the
// receiver-aware sampler must spend far more of its selection mass on the front
// cluster than the receiver-agnostic one does — while both still sum to 1 and keep
// every light strictly positive (so the estimator remains unbiased). This is the win.
function testLightTreeReceiverDownweight(): { pass: boolean; detail: string } {
  const lights: { primId: number; tri: ReturnType<typeof makeTriangle>; emission: Vec3 }[] = []
  const s = 0.1
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2
    const fx = 2 * Math.cos(a)
    const fz = 2 * Math.sin(a)
    // Front cluster: above the receiver (+y), facing DOWN (normal −y) toward it.
    lights.push({ primId: i, tri: makeTriangle(v(fx - s, 4, fz - s), v(fx + s, 4, fz - s), v(fx - s, 4, fz + s), 0), emission: v(0.7, 0.7, 0.7) })
    // Back cluster: below the receiver (−y), facing UP (normal +y, swapped winding)
    // *also* toward it — so both clusters are equally well-oriented and equally far,
    // and ONLY the receiver normal distinguishes them (isolating the new term).
    lights.push({ primId: 100 + i, tri: makeTriangle(v(fx - s, -4, fz - s), v(fx - s, -4, fz + s), v(fx + s, -4, fz - s), 0), emission: v(0.7, 0.7, 0.7) })
  }
  const tree = buildLightTree(lights)
  const p = v(0, 0, 0)
  const nRecv = v(0, 1, 0) // surface faces straight up: the −y cluster is behind it
  let frontAware = 0
  let frontAgnostic = 0
  let minP = Infinity
  let sumAware = 0
  for (let i = 0; i < 20; i++) {
    const pa = tree.prob(p, i, nRecv)
    const pback = tree.prob(p, 100 + i, nRecv)
    frontAware += pa
    frontAgnostic += tree.prob(p, i)
    sumAware += pa + pback
    minP = Math.min(minP, pa, pback)
  }
  // Receiver-aware should put much more mass on the front; agnostic is ~symmetric (½).
  const ok = frontAware > 0.8 && Math.abs(frontAgnostic - 0.5) < 0.08 && minP > 0 && Math.abs(sumAware - 1) < 1e-9
  return {
    pass: ok,
    detail: `front mass: aware=${frontAware.toFixed(3)} vs agnostic=${frontAgnostic.toFixed(3)}; minP=${minP.toExponential(1)}>0; Σ=${sumAware.toFixed(6)}`,
  }
}

// LT-4 — The headline payoff (and unbiasedness oracle): a direct-lighting NEE
// estimator over a sphere of lights half of which sit *behind* the receiver (they
// contribute zero through the cosine term). The receiver-aware tree and the
// receiver-agnostic tree must agree in the *mean* (both unbiased — same true direct
// illumination) while the receiver-aware sampler's per-sample *variance* is clearly
// lower, because it stops wasting samples on the dark back hemisphere.
function testLightTreeReceiverVariance(): { pass: boolean; detail: string } {
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.7, 0.7, 0.7) },
    { kind: 'emissive', emission: v(8, 8, 8) },
  ]
  const prims: PrimDef[] = []
  const up = (cx: number, cy: number, cz: number, sz: number): PrimDef => ({
    kind: 'tri', p0: v(cx - sz, cy, cz - sz), p1: v(cx - sz, cy, cz + sz), p2: v(cx + sz, cy, cz - sz), material: 1,
  })
  const dn = (cx: number, cy: number, cz: number, sz: number): PrimDef => ({
    kind: 'tri', p0: v(cx - sz, cy, cz - sz), p1: v(cx + sz, cy, cz - sz), p2: v(cx - sz, cy, cz + sz), material: 1,
  })
  const r0 = new Rng(17, 1)
  // 40 useful lights above the receiver (facing down), 40 useless ones below it.
  for (let i = 0; i < 40; i++) prims.push(dn(r0.range(-3, 3), r0.range(3, 6), r0.range(-3, 3), 0.18))
  for (let i = 0; i < 40; i++) prims.push(up(r0.range(-3, 3), r0.range(-6, -3), r0.range(-3, 3), 0.18))
  const scene = new Scene({
    name: 'recv-variance',
    materials,
    prims,
    camera: { eye: v(0, 0, 8), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 40, aperture: 0, focusDist: 8 },
    env: { kind: 'solid', color: v(0, 0, 0) },
  })
  const x = v(0, 0, 0)
  const n = v(0, 1, 0)
  const rho = 0.7
  const estimate = (rng: Rng, aware: boolean): number => {
    const ls = scene.sampleLight(x, rng, true, aware ? n : undefined)
    if (!ls || ls.pdf <= 0) return 0
    const cosX = Math.max(0, dot(n, ls.wi))
    if (cosX <= 0) return 0
    return ((rho / Math.PI) * luminance(ls.radiance) * cosX) / ls.pdf
  }
  const run = (aware: boolean, seed: number) => {
    const rng = new Rng(seed, aware ? 2 : 3)
    const M = 40000
    let s = 0
    let s2 = 0
    for (let i = 0; i < M; i++) {
      const e = estimate(rng, aware)
      s += e
      s2 += e * e
    }
    const mean = s / M
    const varr = Math.max(0, s2 / M - mean * mean)
    return { mean, varr, se: Math.sqrt(varr / M) }
  }
  const ag = run(false, 321)
  const aw = run(true, 654)
  const z = Math.abs(ag.mean - aw.mean) / Math.sqrt(ag.se * ag.se + aw.se * aw.se)
  const ratio = ag.varr / Math.max(aw.varr, 1e-30)
  return {
    pass: z < 4 && ratio > 1.5,
    detail: `mean agnostic=${ag.mean.toFixed(4)} aware=${aw.mean.toFixed(4)} (Δ=${z.toFixed(1)} SE ⇒ unbiased); variance agnostic/aware=${ratio.toFixed(1)}× (>1.5)`,
  }
}

// ---- 20.0 Sphere-light NEE: subtended-cone (solid-angle) sampling ----------

// Uniform direction over the hemisphere about `n` (pdf = 1/2π), for the naive
// baseline estimator the cone sampler is compared against.
function uniformHemisphere(n: Vec3, rng: Rng): Vec3 {
  const u1 = rng.next()
  const u2 = rng.next()
  const cosT = u1 // uniform in cosθ over [0,1]
  const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT))
  const phi = 2 * Math.PI * u2
  const { t, b } = onb(n)
  return normalize(
    add(add(scale(t, Math.cos(phi) * sinT), scale(b, Math.sin(phi) * sinT)), scale(n, cosT)),
  )
}

// SL-1 — The subtended-cone solid angle, and its inverse-square (point-light)
// limit. The directions from a point that strike a sphere of radius R a distance
// d away form a cone of half-angle θ_max with cosθ_max=√(1−R²/d²); its solid
// angle is Ω=2π(1−cosθ_max). As R/d→0 the cone must shrink to the projected solid
// angle of a flat disc of area πR² at distance d — Ω→πR²/d² — which is exactly the
// 1/d² falloff a point light obeys. Both are checked against closed forms.
function testSphereSolidAngle(): { pass: boolean; detail: string } {
  let worst = 0
  for (const [d, R] of [[5, 0.8], [2, 0.5], [10, 2], [3, 0.05]] as const) {
    const cosMax = sphereConeCosMax(d * d, R * R)!
    const expectCos = Math.sqrt(1 - (R * R) / (d * d))
    const omega = sphereSolidAngle(cosMax)
    const expectOmega = 2 * Math.PI * (1 - expectCos)
    worst = Math.max(worst, Math.abs(cosMax - expectCos), Math.abs(omega - expectOmega))
  }
  // Inverse-square / projected-area limit: Ω·d²/(πR²) → 1 as R/d → 0.
  const d = 1
  const R = 1e-3
  const omega = sphereSolidAngle(sphereConeCosMax(d * d, R * R)!)
  const ratio = (omega * d * d) / (Math.PI * R * R)
  return {
    pass: worst < 1e-12 && Math.abs(ratio - 1) < 1e-4,
    detail: `max|Ω−2π(1−cosθmax)|=${worst.toExponential(1)}; inverse-square limit Ω·d²/(πR²)=${ratio.toFixed(6)}→1`,
  }
}

// SL-2 — The cone sampler ↔ its pdf. Drawing N directions uniformly in the cone,
// (1) the Monte-Carlo estimate of ∫_cone 1 dω = E[1/pdf] must equal the analytic
// Ω; (2) every sampled direction must actually intersect the sphere (it lies in
// the cone by construction) and its reported point must sit on the surface
// (|p−c|=R); and (3) sphereDirPdf must return that same constant 1/Ω for each —
// the precondition for a consistent MIS weight on a BSDF-sampled hit.
function testSphereSamplerPdf(): { pass: boolean; detail: string } {
  const ref = v(0, 0, 0)
  const c = v(1.4, 2.2, 0.7)
  const R = 0.75
  const sph = makeSphere(c, R, 0)
  const rng = new Rng(9001, 2)
  const cosMax = sphereConeCosMax(distance2(c, ref), R * R)!
  const omega = sphereSolidAngle(cosMax)
  const M = 200000
  let invPdfSum = 0
  let maxOnSurface = 0
  let maxPdfErr = 0
  let allHit = true
  for (let i = 0; i < M; i++) {
    const s = sampleSphereLight(ref, c, R, rng)!
    invPdfSum += 1 / s.pdf
    maxPdfErr = Math.max(maxPdfErr, Math.abs(s.pdf - 1 / omega))
    const onSurf = Math.abs(len(sub(s.n, v(0, 0, 0))) - 1) // |n| should be 1
    maxOnSurface = Math.max(maxOnSurface, onSurf)
    if (!intersectPrim(sph, ref, s.wi, 1e-4, 1e9)) allHit = false
  }
  const omegaMC = invPdfSum / M
  const relOmega = Math.abs(omegaMC - omega) / omega
  return {
    pass: relOmega < 3e-3 && maxPdfErr < 1e-12 && maxOnSurface < 1e-9 && allHit,
    detail: `∫_cone dω MC=${omegaMC.toFixed(5)} vs Ω=${omega.toFixed(5)} (rel ${(relOmega * 100).toFixed(2)}%); pdf≡1/Ω err=${maxPdfErr.toExponential(1)}; all rays hit=${allHit}`,
  }
}

// SL-3 — The directional pdf integrates to 1 over the whole sphere of directions.
// Sampling directions UNIFORMLY over the full sphere (pdf 1/4π) and averaging the
// sphere-light pdf (which is 1/Ω inside the subtended cone, 0 outside) must give
// ∫ p(ω) dω = 4π·E[p] = 1 — the structural guarantee that the NEE sampler is a
// genuine probability distribution (and hence unbiased).
function testSpherePdfIntegratesToOne(): { pass: boolean; detail: string } {
  const ref = v(0, 0, 0)
  const c = v(0.6, 1.8, -0.4)
  const R = 0.9
  const cosMax = sphereConeCosMax(distance2(c, ref), R * R)!
  const omega = sphereSolidAngle(cosMax)
  const w = normalize(sub(c, ref))
  const rng = new Rng(4242, 3)
  const M = 400000
  let acc = 0
  for (let i = 0; i < M; i++) {
    // Uniform direction over the full sphere.
    const z = 1 - 2 * rng.next()
    const r = Math.sqrt(Math.max(0, 1 - z * z))
    const phi = 2 * Math.PI * rng.next()
    const dir = v(r * Math.cos(phi), r * Math.sin(phi), z)
    const p = dot(dir, w) >= cosMax ? 1 / omega : 0 // in cone ⇒ constant 1/Ω
    acc += p
  }
  const integral = 4 * Math.PI * (acc / M)
  return {
    pass: Math.abs(integral - 1) < 5e-3,
    detail: `∫_S² p(ω)dω = 4π·E[p] = ${integral.toFixed(5)} (→ 1; the cone covers Ω=${omega.toFixed(4)})`,
  }
}

// SL-4 — The headline payoff (and the unbiasedness oracle). A Lambertian point lit
// only by an emissive sphere fully above its horizon has a CLOSED-FORM reflected
// radiance ρ·L·sin²θ_max·cosθ_c (the sphere's exact form factor). The cone-sampled
// NEE estimator must converge to that analytic value (so it is exactly unbiased),
// and its per-sample variance must be FAR below the naive estimator that samples
// the hemisphere uniformly and hopes to hit the sphere — the firefly-storm regime
// the whole feature removes. Both estimators are unbiased (same mean); only the
// cone sampler is usable.
function testSphereNeeOracle(): { pass: boolean; detail: string } {
  const p = v(0, 0, 0)
  const n = v(0, 1, 0)
  const rho = 0.8
  const L = 5
  const c = v(1.5, 5, 1.0) // high enough that the whole cone clears the horizon
  const R = 0.8
  const sph = makeSphere(c, R, 0)
  const E = sphereIrradianceFull(p, n, c, R, L)
  const analytic = (rho / Math.PI) * E // Lambert reflected radiance (view-independent)

  const cone = (rng: Rng): number => {
    const s = sampleSphereLight(p, c, R, rng)!
    const cosX = dot(n, s.wi)
    if (cosX <= 0) return 0
    return ((rho / Math.PI) * L * cosX) / s.pdf
  }
  const uniform = (rng: Rng): number => {
    const wi = uniformHemisphere(n, rng)
    if (!intersectPrim(sph, p, wi, 1e-4, 1e9)) return 0
    const cosX = dot(n, wi)
    if (cosX <= 0) return 0
    return (rho / Math.PI) * L * cosX * (2 * Math.PI) // /(1/2π)
  }
  const run = (fn: (r: Rng) => number, seed: number) => {
    const rng = new Rng(seed, 2)
    const M = 60000
    let s = 0
    let s2 = 0
    for (let i = 0; i < M; i++) {
      const e = fn(rng)
      s += e
      s2 += e * e
    }
    const mean = s / M
    const varr = Math.max(0, s2 / M - mean * mean)
    return { mean, varr, se: Math.sqrt(varr / M) }
  }
  const a = run(cone, 7)
  const b = run(uniform, 99)
  const zCone = Math.abs(a.mean - analytic) / Math.max(a.se, 1e-12)
  const zUnif = Math.abs(b.mean - analytic) / Math.max(b.se, 1e-12)
  const ratio = b.varr / Math.max(a.varr, 1e-30)
  return {
    pass: zCone < 4 && zUnif < 4 && ratio > 20,
    detail: `analytic=${analytic.toFixed(4)}; cone=${a.mean.toFixed(4)} (${zCone.toFixed(1)}SE) uniform=${b.mean.toFixed(4)} (${zUnif.toFixed(1)}SE); variance uniform/cone=${ratio.toFixed(0)}× (>20)`,
  }
}

// SL-5 — NEE ↔ MIS consistency through the Scene. The pdf the cone sampler reports
// for a drawn direction must EXACTLY equal the pdf scene.lightPdf reconstructs for
// that same direction (the value the integrator's power heuristic uses when a BSDF
// ray instead lands on the sphere). Any mismatch would mis-weight the two
// estimators and bias the image; here it agrees to machine precision. The reported
// hit distance must also match the true sphere intersection, and the radiance the
// emitter's emission.
function testSphereNeeMisConsistency(): { pass: boolean; detail: string } {
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.5, 0.5, 0.5) },
    { kind: 'emissive', emission: v(6, 5, 4) },
  ]
  const prims: PrimDef[] = [{ kind: 'sphere', center: v(2, 3, 1), radius: 0.8, material: 1 }]
  const scene = new Scene({
    name: 'sphere-nee',
    materials,
    prims,
    camera: { eye: v(0, 0, -6), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 40, aperture: 0, focusDist: 6 },
    env: { kind: 'solid', color: v(0, 0, 0) },
  })
  const ref = v(0, 0, 0)
  const sph = makeSphere(v(2, 3, 1), 0.8, 1)
  const rng = new Rng(1337, 2)
  let maxPdfErr = 0
  let maxDistErr = 0
  let radOk = true
  const M = 50000
  for (let i = 0; i < M; i++) {
    const ls = scene.sampleLight(ref, rng, false, undefined, true)
    if (!ls) continue
    const lp = scene.lightPdf(ref, ls.wi, ls.primId, ls.dist, false, undefined, true)
    maxPdfErr = Math.max(maxPdfErr, Math.abs(ls.pdf - lp))
    const ph = intersectPrim(sph, ref, ls.wi, 1e-4, 1e9)
    if (ph) maxDistErr = Math.max(maxDistErr, Math.abs(ph.t - ls.dist))
    if (Math.abs(ls.radiance.x - 6) > 1e-9) radOk = false
  }
  return {
    pass: maxPdfErr < 1e-12 && maxDistErr < 1e-6 && radOk,
    detail: `max|pdf_sample − lightPdf|=${maxPdfErr.toExponential(1)} (MIS-consistent); max|dist−hit|=${maxDistErr.toExponential(1)}; radiance ok=${radOk}`,
  }
}

// SL-6 — The sampler respects geometry: a sphere entirely BELOW the surface's
// horizon contributes ~nothing (every cone direction is back-facing, killed by the
// cosine term), and a shade point INSIDE the sphere is declined (no subtending
// cone) so the surrounding BSDF sampling carries it unbiasedly. Both are the
// guards that keep the estimator from leaking light or dividing by a degenerate Ω.
function testSphereNeeHorizonAndInside(): { pass: boolean; detail: string } {
  const p = v(0, 0, 0)
  const n = v(0, 1, 0)
  const cBelow = v(1, -5, 1) // fully under the floor
  const R = 0.5
  const rng = new Rng(555, 2)
  let belowSum = 0
  const M = 20000
  for (let i = 0; i < M; i++) {
    const s = sampleSphereLight(p, cBelow, R, rng)
    if (!s) continue
    const cosX = dot(n, s.wi)
    if (cosX > 0) belowSum += cosX / s.pdf // would-be (unclamped) contribution
  }
  const belowMean = belowSum / M
  // Inside the sphere: the sampler and the directional pdf both decline.
  const cIn = v(0.1, 0.1, 0.1)
  const inside = sampleSphereLight(p, cIn, 1.0, rng)
  const insidePdf = sphereDirPdf(p, cIn, 1.0)
  const irr = sphereIrradianceFull(p, n, cBelow, R, 5)
  return {
    pass: belowMean < 1e-9 && inside === null && insidePdf === 0 && irr === 0,
    detail: `below-horizon contribution=${belowMean.toExponential(1)} (→0); inside ⇒ sample=${inside === null ? 'null' : 'set'}, pdf=${insidePdf}; analytic E=${irr}`,
  }
}

// Squared distance helper for the sphere-light proofs.
function distance2(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return dx * dx + dy * dy + dz * dz
}

// ---- 18.0 Physically based light colour: blackbody emitters ----------------

// BB-1 — Planck's law obeys Wien's displacement law. The spectral radiance is
// strictly positive everywhere, and the wavelength at which it peaks scales as
// λ_max = b/T with Wien's constant b ≈ 2.8978e6 nm·K. We find the peak by a fine
// search over a wide band (well past the visible, since hot/cold bodies peak in
// UV/IR) and check λ_max·T against b for several temperatures — the physics that
// makes the whole locus correct, pinned independently of the colour pipeline.
function testPlanckWien(): { pass: boolean; detail: string } {
  const b = 2.8977719e6 // nm·K
  let worstRel = 0
  let positive = true
  let detail = ''
  for (const T of [3000, 5000, 6500, 9000]) {
    let peakL = 0
    let peakV = -Infinity
    for (let l = 100; l <= 12000; l += 2) {
      const p = planck(l, T)
      if (p <= 0) positive = false
      if (p > peakV) {
        peakV = p
        peakL = l
      }
    }
    const rel = Math.abs(peakL * T - b) / b
    worstRel = Math.max(worstRel, rel)
    detail += `T=${T}:λ=${peakL}nm `
  }
  return { pass: positive && worstRel < 0.01, detail: `${detail}(worst |λ·T−b|/b=${(worstRel * 100).toFixed(2)}%, +ve=${positive})` }
}

// BB-2 — Planck's law obeys the Stefan–Boltzmann law: the band-integrated radiance
// scales as T⁴ (∫₀^∞ B dλ ∝ T⁴), so doubling the temperature multiplies the total
// emitted power by 2⁴ = 16. We integrate over a wide band at T and 2T and check the
// ratio is 16 — the energetic counterpart to Wien's spectral check.
function testPlanckStefanBoltzmann(): { pass: boolean; detail: string } {
  const integrate = (T: number): number => {
    let s = 0
    for (let l = 50; l <= 40000; l += 5) s += planck(l, T) * 5
    return s
  }
  const T = 2000
  const ratio = integrate(2 * T) / integrate(T)
  return { pass: Math.abs(ratio - 16) / 16 < 0.02, detail: `∫B(2T)/∫B(T)=${ratio.toFixed(3)} (Stefan–Boltzmann T⁴ ⇒ 16)` }
}

// BB-3 — The Planckian locus runs warm→neutral→cool. A cool-burning body (3000 K,
// tungsten) must be red-dominant, a hot one (10000 K, clear north sky) blue-dominant,
// and the red-to-blue ratio must fall *monotonically* with temperature across the
// whole range — the colour-temperature sweep, computed from Planck + the CIE CMFs,
// not tabulated. Every hue stays in [0,1] with a unit peak channel.
function testBlackbodyLocus(): { pass: boolean; detail: string } {
  const temps = [2000, 3000, 4000, 5000, 6500, 8000, 10000, 12000]
  const ratios: number[] = []
  let bounded = true
  for (const T of temps) {
    const c = blackbody(T)
    if (c.x < 0 || c.y < 0 || c.z < 0 || c.x > 1.0001 || c.y > 1.0001 || c.z > 1.0001) bounded = false
    if (Math.abs(Math.max(c.x, c.y, c.z) - 1) > 1e-6) bounded = false
    ratios.push(c.x / Math.max(c.z, 1e-6)) // R/B
  }
  let monotone = true
  for (let i = 1; i < ratios.length; i++) if (ratios[i] >= ratios[i - 1]) monotone = false
  const warm = blackbody(3000)
  const cool = blackbody(10000)
  const warmRed = warm.x > warm.z + 0.2
  const coolBlue = cool.z > cool.x + 0.2
  return {
    pass: bounded && monotone && warmRed && coolBlue,
    detail: `warm3000=(${warm.x.toFixed(2)},${warm.y.toFixed(2)},${warm.z.toFixed(2)}) cool10000=(${cool.x.toFixed(2)},${cool.y.toFixed(2)},${cool.z.toFixed(2)}) R/B↓=${monotone}, bounded=${bounded}`,
  }
}

// BB-4 — Near 6500 K (the D65 daylight white point the sRGB primaries are defined
// against) a blackbody is close to neutral white: no channel is strongly starved.
// This is the anchor that the Planck→CMF→XYZ→sRGB pipeline is calibrated correctly
// (a transcription slip in the matrix or the CMFs would tint the white point).
function testBlackbodyWhitePoint(): { pass: boolean; detail: string } {
  const c = blackbody(6500)
  const lo = Math.min(c.x, c.y, c.z)
  // All channels reasonably balanced (the warm/cool extremes drive one channel to ~0).
  return { pass: lo > 0.6, detail: `6500K=(${c.x.toFixed(3)},${c.y.toFixed(3)},${c.z.toFixed(3)}), min channel=${lo.toFixed(3)} (>0.6 ⇒ ~neutral)` }
}

// ---- 19.0 AgX tone mapping --------------------------------------------------

// AGX-1 — The AgX contrast curve is a well-behaved sigmoid: strictly increasing on
// [0,1] (so it never inverts tones) and bounded into ≈[0,1] (it maps the log-encoded
// black point to ~0 and the white point to ~1). A non-monotone tone curve would
// produce banding/inversions; this pins the curve's shape independent of the matrices.
function testAgxContrastCurve(): { pass: boolean; detail: string } {
  let monotone = true
  let prev = -Infinity
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i <= 200; i++) {
    const x = i / 200
    const y = agxContrast(x)
    if (y < prev - 1e-9) monotone = false
    prev = y
    lo = Math.min(lo, y)
    hi = Math.max(hi, y)
  }
  const ends = agxContrast(0) < 0.02 && agxContrast(1) > 0.98
  return {
    pass: monotone && ends && lo > -0.02 && hi < 1.02,
    detail: `monotone=${monotone}, curve(0)=${agxContrast(0).toFixed(3)}, curve(1)=${agxContrast(1).toFixed(3)}, range=[${lo.toFixed(3)},${hi.toFixed(3)}]`,
  }
}

// AGX-2 — Neutral stays neutral. AgX rotates colour through its inset/outset spaces,
// but a grey input (R=G=B) must come out grey — otherwise the transform would tint
// the whole image. This is the calibration check on the inset/outset matrix pair.
function testAgxNeutral(): { pass: boolean; detail: string } {
  let worst = 0
  for (const x of [0.02, 0.1, 0.18, 0.5, 1, 4, 20]) {
    const [r, g, b] = agx(x, x, x)
    worst = Math.max(worst, Math.abs(r - g), Math.abs(g - b), Math.abs(r - b))
  }
  return { pass: worst < 5e-3, detail: `worst grey channel spread=${worst.toExponential(2)} over 7 levels (<5e-3)` }
}

// AGX-3 — Black maps to black and brightness is monotone: agx(0)→0 per channel, and
// scaling a colour up never darkens its tonemapped luminance. Outputs stay finite and
// non-negative for a wide HDR range (the display transform must not emit NaN/<0).
function testAgxBlackMonotone(): { pass: boolean; detail: string } {
  const [br, bg, bb] = agx(0, 0, 0)
  const blackOk = br < 1e-3 && bg < 1e-3 && bb < 1e-3
  let monoLum = true
  let finite = true
  let prevLum = -1
  for (const s of [0.001, 0.01, 0.1, 0.5, 1, 2, 8, 64]) {
    const [r, g, b] = agx(0.8 * s, 0.9 * s, 1.0 * s)
    if (!Number.isFinite(r + g + b) || r < 0 || g < 0 || b < 0) finite = false
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    if (lum < prevLum - 1e-6) monoLum = false
    prevLum = lum
  }
  return { pass: blackOk && monoLum && finite, detail: `black→0=${blackOk}, luminance↑ with exposure=${monoLum}, finite&≥0=${finite}` }
}

// AGX-4 — The headline behaviour: AgX *desaturates highlights* toward white instead
// of clipping to a primary. A very bright, highly-saturated input (deep blue, tiny
// red/green) must come out markedly less saturated than a naive per-channel clamp
// would leave it — i.e. its min/max channel ratio rises well above the input's. This
// is exactly the "notorious six"/bright-light hue-preservation AgX exists for.
function testAgxHighlightDesaturation(): { pass: boolean; detail: string } {
  const inR = 0.2
  const inG = 0.2
  const inB = 30 // a blinding blue
  const inRatio = Math.min(inR, inG, inB) / Math.max(inR, inG, inB) // ≈ 0.0067
  const [r, g, b] = agx(inR, inG, inB)
  const outRatio = Math.min(r, g, b) / Math.max(r, g, b)
  return {
    pass: outRatio > inRatio + 0.2 && r > 0 && g > 0,
    detail: `min/max: in=${inRatio.toFixed(3)} → out=${outRatio.toFixed(3)} (desaturated toward white)`,
  }
}

// ---- (21.0) Image-based lighting (HDRI environment importance sampling) -----

// A uniform direction on the sphere from two deviates (for the directional pdf
// integral and the uniform-baseline variance comparison).
function uniformSphereDir(u1: number, u2: number): Vec3 {
  const z = 1 - 2 * u1
  const r = Math.sqrt(Math.max(0, 1 - z * z))
  const phi = 2 * Math.PI * u2
  return v(r * Math.cos(phi), z, r * Math.sin(phi))
}

// (1) The piecewise-constant 2D distribution is a genuine probability density:
// its Riemann sum over the unit square is EXACTLY 1, and — recovered through the
// equirectangular Jacobian dω=2π²sinθ du dv — the directional pdf integrates to 1
// over the whole sphere of directions (a Monte-Carlo confirmation that pdf(dir),
// which re-derives (u,v) from a world direction, is consistent). This is the
// precondition for an unbiased estimator: a sampler whose density does not sum
// to one cannot reproduce the rendering equation.
function testEnvDistributionNormalised(): { pass: boolean; detail: string } {
  // Direct: a Distribution2D over an arbitrary positive function sums to 1.
  const W = 64
  const H = 32
  const func = new Float64Array(W * H)
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) func[j * W + i] = 0.1 + Math.abs(Math.sin(i * 0.7) * Math.cos(j * 0.5))
  }
  const d2 = new Distribution2D(func, W, H)
  let grid = 0
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) grid += d2.pdf((i + 0.5) / W, (j + 0.5) / H)
  grid /= W * H
  // Directional integral over S² for a real HDRI via uniform-sphere MC.
  const em = new EnvMap('sunset', 1, 0)
  const rng = new Rng(20260621, 3)
  let s = 0
  const N = 300000
  for (let i = 0; i < N; i++) s += em.pdf(uniformSphereDir(rng.next(), rng.next()))
  const sphereInt = (s / N) * 4 * Math.PI
  const ok = approx(grid, 1, 1e-9) && approx(sphereInt, 1, 0.04)
  return { pass: ok, detail: `∫∫p du dv=${grid.toFixed(9)}, ∫_S² p dω=${sphereInt.toFixed(4)}` }
}

// (2) Sampler ↔ pdf consistency: every direction the importance sampler draws is
// a unit vector with strictly positive density, and the pdf the sampler reports
// equals pdf(wi) recomputed from that direction to MACHINE PRECISION — the
// MIS no-double-count guarantee, checked across all three panoramas.
function testEnvSamplerPdf(): { pass: boolean; detail: string } {
  const presets: HdriPreset[] = ['studio', 'sunset', 'twilight']
  let maxRel = 0
  let allUnit = true
  let allPos = true
  for (const preset of presets) {
    const em = new EnvMap(preset, 1, 0.5)
    const rng = new Rng(424242, 9)
    for (let i = 0; i < 12000; i++) {
      const r = em.sample(rng.next(), rng.next())
      if (!r) continue
      const len = Math.sqrt(r.wi.x * r.wi.x + r.wi.y * r.wi.y + r.wi.z * r.wi.z)
      if (Math.abs(len - 1) > 1e-9) allUnit = false
      if (!(r.pdf > 0)) allPos = false
      const p2 = em.pdf(r.wi)
      const rel = Math.abs(p2 - r.pdf) / (r.pdf + 1e-30)
      if (rel > maxRel) maxRel = rel
    }
  }
  const ok = allUnit && allPos && maxRel < 1e-9
  return { pass: ok, detail: `unit=${allUnit} pos=${allPos} max|Δpdf|/pdf=${maxRel.toExponential(2)}` }
}

// (3) Reduces to uniform: a CONSTANT-radiance environment (so its importance
// weights are exactly sinθ — the lat-long area element) importance-samples
// UNIFORMLY over the sphere. The directional density collapses to 1/(2π²·⟨sinθ⟩)
// for every row, which equals 1/(4π) to the grid's discretisation — the exact
// analogue of the light-tree's "coincident lights ⇒ 1/N" oracle, and a direct
// check of the equatorial-area Jacobian baked into sample()/pdf().
function testEnvReducesToUniform(): { pass: boolean; detail: string } {
  const W = 256
  const H = 128
  const func = new Float64Array(W * H)
  let meanS = 0
  for (let j = 0; j < H; j++) {
    const s = Math.sin(((j + 0.5) / H) * Math.PI)
    for (let i = 0; i < W; i++) {
      func[j * W + i] = s
      meanS += s
    }
  }
  meanS /= W * H
  const d2 = new Distribution2D(func, W, H)
  const target = 1 / (2 * Math.PI * Math.PI * meanS)
  let maxRowDev = 0 // every row's directional pdf equals the same constant
  for (const j of [4, 32, 64, 96, 124]) {
    const theta = ((j + 0.5) / H) * Math.PI
    const sinT = Math.sin(theta)
    const pw = d2.pdf(0.5, (j + 0.5) / H) / (2 * Math.PI * Math.PI * sinT)
    const dev = Math.abs(pw - target) / target
    if (dev > maxRowDev) maxRowDev = dev
  }
  const uniformDev = Math.abs(target - 1 / (4 * Math.PI)) / (1 / (4 * Math.PI))
  const ok = maxRowDev < 1e-9 && uniformDev < 0.01
  return {
    pass: ok,
    detail: `p(ω)=${target.toFixed(6)} (1/4π=${(1 / (4 * Math.PI)).toFixed(6)}), row dev=${maxRowDev.toExponential(1)}, vs 1/4π=${(uniformDev * 100).toFixed(3)}%`,
  }
}

// (4) MIS consistency through the Scene: for an HDRI scene the explicit env-light
// pdf the integrator uses to weight an escaped BSDF ray (scene.envSunPdf) equals
// the map's importance density folded by the 1/numLights selection probability,
// AND the pdf the NEE sampler (scene.sampleLight) actually returns for an env
// sample matches envSunPdf for that very direction — so the BSDF-hit and
// next-event estimators never double-count and the estimate stays unbiased.
function testEnvMisConsistency(): { pass: boolean; detail: string } {
  const sd: SceneDef = {
    name: 'ibl-test',
    materials: [{ kind: 'diffuse', albedo: v(0.5, 0.5, 0.5) }],
    prims: [{ kind: 'sphere', center: v(0, 0, 0), radius: 1, material: 0 }],
    camera: { eye: v(0, 0, 5), target: v(0, 0, 0), up: v(0, 1, 0), vfovDeg: 40, aperture: 0, focusDist: 5 },
    env: { kind: 'hdri', preset: 'sunset', intensity: 1.3, rotation: 0.4 },
  }
  const scene = new Scene(sd)
  const nL = scene.numLights // env only ⇒ 1
  const em = scene.envMap!
  const rng = new Rng(7777, 5)
  let maxPdfDev = 0
  // (a) envSunPdf == envMap.pdf / numLights for arbitrary directions.
  for (let i = 0; i < 4000; i++) {
    const d = uniformSphereDir(rng.next(), rng.next())
    const expected = em.pdf(d) / nL
    const got = scene.envSunPdf(d)
    const dev = Math.abs(got - expected) / (expected + 1e-30)
    if (dev > maxPdfDev) maxPdfDev = dev
  }
  // (b) the NEE sampler's returned pdf matches envSunPdf for the sampled dir.
  let maxSampleDev = 0
  const ref = v(0, 2, 0)
  let nEnv = 0
  for (let i = 0; i < 4000; i++) {
    const ls = scene.sampleLight(ref, rng)
    if (!ls || ls.primId !== -1) continue
    nEnv++
    const ep = scene.envSunPdf(ls.wi)
    const dev = Math.abs(ls.pdf - ep) / (ep + 1e-30)
    if (dev > maxSampleDev) maxSampleDev = dev
  }
  const ok = nL === 1 && maxPdfDev < 1e-9 && maxSampleDev < 1e-9 && nEnv > 0
  return {
    pass: ok,
    detail: `numLights=${nL}, max|Δ(envSunPdf−p/N)|=${maxPdfDev.toExponential(1)}, sampler↔envSunPdf=${maxSampleDev.toExponential(1)} (${nEnv} env samples)`,
  }
}

// (5) Importance sampling is UNBIASED with far lower variance. Estimate the
// up-facing hemisphere's red irradiance ∫ Lᵣ(ω)cosθ dω under the sunset HDRI two
// ways at equal samples: drawing ω uniformly on the hemisphere vs drawing ω from
// the environment's importance distribution. The means agree (same integral —
// the unbiasedness oracle), while the importance estimator's per-sample variance
// is many times smaller — the whole point: the blinding sun is sampled directly
// instead of stumbled upon.
function testEnvImportanceVariance(): { pass: boolean; detail: string } {
  const em = new EnvMap('sunset', 1, 0)
  const N = 120000
  // Uniform hemisphere baseline (pdf = 1/2π over the upper hemisphere).
  const ru = new Rng(31337, 2)
  let mu = 0
  let m2u = 0
  for (let i = 0; i < N; i++) {
    const u1 = ru.next()
    const u2 = ru.next()
    const z = u1 // cosθ ∈ [0,1]
    const r = Math.sqrt(Math.max(0, 1 - z * z))
    const phi = 2 * Math.PI * u2
    const d = v(r * Math.cos(phi), z, r * Math.sin(phi))
    const est = em.radiance(d).x * d.y * (2 * Math.PI) // /(1/2π)
    mu += est
    m2u += est * est
  }
  mu /= N
  const varU = m2u / N - mu * mu
  // Environment importance sampling (full sphere; up-hemisphere contributes).
  const ri = new Rng(31337, 8)
  let mi = 0
  let m2i = 0
  for (let i = 0; i < N; i++) {
    const s = em.sample(ri.next(), ri.next())
    let est = 0
    if (s && s.wi.y > 0 && s.pdf > 0) est = (em.radiance(s.wi).x * s.wi.y) / s.pdf
    mi += est
    m2i += est * est
  }
  mi /= N
  const varI = m2i / N - mi * mi
  const meanRel = Math.abs(mu - mi) / (mu + 1e-9)
  const ratio = varI > 0 ? varU / varI : Infinity
  const ok = meanRel < 0.05 && ratio > 3 && mu > 0
  return {
    pass: ok,
    detail: `E[uniform]=${mu.toFixed(3)} E[importance]=${mi.toFixed(3)} (Δ=${(meanRel * 100).toFixed(1)}%), var ratio=${ratio.toFixed(1)}×`,
  }
}

// (6) Rotation is a measure-preserving symmetry. Spinning the panorama about the
// vertical axis by φ relabels directions (azimuth shifts by φ) but changes
// neither the radiance carried along a relabelled ray nor its sampling density —
// so the same random deviates produce identical radiance and identical pdf, with
// the sampled direction's azimuth advanced by exactly φ. The importance
// distribution rides with the image, as it must for the live rotation control.
function testEnvRotationInvariant(): { pass: boolean; detail: string } {
  const phi = 1.0
  const em0 = new EnvMap('twilight', 1, 0)
  const emR = new EnvMap('twilight', 1, phi)
  const r0 = new Rng(2025, 11)
  const rR = new Rng(2025, 11)
  let maxRad = 0
  let maxPdf = 0
  let maxAz = 0
  let n = 0
  for (let i = 0; i < 8000; i++) {
    const a = r0.next()
    const b = r0.next()
    const s0 = em0.sample(a, b)
    rR.next()
    rR.next()
    const sR = emR.sample(a, b)
    if (!s0 || !sR) continue
    n++
    const dr = Math.abs(s0.radiance.x - sR.radiance.x) + Math.abs(s0.radiance.y - sR.radiance.y) + Math.abs(s0.radiance.z - sR.radiance.z)
    const rad = dr / (s0.radiance.x + s0.radiance.y + s0.radiance.z + 1e-9)
    if (rad > maxRad) maxRad = rad
    const pd = Math.abs(s0.pdf - sR.pdf) / (s0.pdf + 1e-30)
    if (pd > maxPdf) maxPdf = pd
    let dAz = Math.atan2(sR.wi.z, sR.wi.x) - Math.atan2(s0.wi.z, s0.wi.x) - phi
    dAz = Math.atan2(Math.sin(dAz), Math.cos(dAz)) // wrap to (−π,π]
    if (Math.abs(dAz) > maxAz) maxAz = Math.abs(dAz)
  }
  const ok = n > 0 && maxRad < 1e-9 && maxPdf < 1e-9 && maxAz < 1e-6
  return { pass: ok, detail: `Δradiance=${maxRad.toExponential(1)}, Δpdf=${maxPdf.toExponential(1)}, |azimuth−φ|=${maxAz.toExponential(1)}` }
}

// ---- 22.0 — physically based image formation --------------------------------

// Aperture (1): the polygonal bokeh sampler is area-uniform, lies inside the unit
// disk, and is zero-mean (so depth of field stays unbiased — no image shift).
function testAperturePolygon(): { pass: boolean; detail: string } {
  const blades = 6
  const rot = 0.37
  const N = 300000
  const r = new Rng(20240622, 7)
  let sx = 0
  let sy = 0
  let inscribed = 0
  let maxR = 0
  const apothem = Math.cos(Math.PI / blades) // inscribed-circle radius
  for (let i = 0; i < N; i++) {
    const p = sampleAperture(blades, rot, r.next(), r.next())
    sx += p.x
    sy += p.y
    const rad = Math.hypot(p.x, p.y)
    if (rad > maxR) maxR = rad
    if (rad <= apothem) inscribed++
  }
  const meanMag = Math.hypot(sx / N, sy / N)
  // Analytic: P(inside inscribed circle) = (π·apothem²) / area(n-gon),
  // area(n-gon inscribed in unit circle) = (n/2)·sin(2π/n).
  const polyArea = (blades / 2) * Math.sin((2 * Math.PI) / blades)
  const expectFrac = (Math.PI * apothem * apothem) / polyArea
  const frac = inscribed / N
  const ok =
    maxR <= 1 + 1e-9 && // every sample is inside the unit disk (polygon ⊂ disk)
    meanMag < 5e-3 && // zero-mean ⇒ unbiased depth of field
    approx(frac, expectFrac, 6e-3) // area-uniform
  return {
    pass: ok,
    detail: `|mean|=${meanMag.toExponential(1)}, maxR=${maxR.toFixed(4)}, inscribed=${frac.toFixed(4)} (exp ${expectFrac.toFixed(4)})`,
  }
}

// Aperture (2): blades < 3 reduces to the circular concentric-disk sampler
// bit-for-bit, and as blades→∞ the polygon fills the disk (the inscribed-circle
// fraction → 1).
function testApertureDiskLimit(): { pass: boolean; detail: string } {
  // Reduction: blades 0/2 must equal the concentric-disk sampler exactly.
  const r = new Rng(99, 1)
  let reduces = true
  for (let i = 0; i < 5000; i++) {
    const u1 = r.next()
    const u2 = r.next()
    const poly = sampleAperture(2, 0, u1, u2)
    const disk = concentricDiskFromTest(u1, u2)
    if (Math.abs(poly.x - disk.x) > 1e-12 || Math.abs(poly.y - disk.y) > 1e-12) {
      reduces = false
      break
    }
  }
  // Disk limit: a 64-gon nearly fills the unit disk.
  const blades = 64
  const N = 200000
  const r2 = new Rng(7, 3)
  const apothem = Math.cos(Math.PI / blades)
  let inscribed = 0
  for (let i = 0; i < N; i++) {
    const p = sampleAperture(blades, 0, r2.next(), r2.next())
    if (Math.hypot(p.x, p.y) <= apothem) inscribed++
  }
  const frac = inscribed / N
  const ok = reduces && frac > 0.99
  return { pass: ok, detail: `reduces=${reduces}, 64-gon inscribed frac=${frac.toFixed(4)}` }
}

// A tiny local copy of the concentric-disk map so the reduction test does not
// depend on rng.ts internals — it mirrors `concentricDiskFrom` exactly.
function concentricDiskFromTest(u1: number, u2: number): { x: number; y: number } {
  const a = 2 * u1 - 1
  const b = 2 * u2 - 1
  if (a === 0 && b === 0) return { x: 0, y: 0 }
  let r: number
  let phi: number
  if (a * a > b * b) {
    r = a
    phi = (Math.PI / 4) * (b / a)
  } else {
    r = b
    phi = Math.PI / 2 - (Math.PI / 4) * (a / b)
  }
  return { x: r * Math.cos(phi), y: r * Math.sin(phi) }
}

// Bloom (1): veiling glare is energy-conserving (a centred highlight keeps its
// total energy through the PSF), and strength 0 is a bit-exact identity.
function testBloomEnergy(): { pass: boolean; detail: string } {
  const w = 128
  const h = 128
  const src = new Float32Array(w * h * 3)
  // A small bright blob at the centre, far from every border.
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const i = ((64 + dy) * w + (64 + dx)) * 3
      src[i] = 12
      src[i + 1] = 7
      src[i + 2] = 3
    }
  }
  let sin = 0
  for (let i = 0; i < src.length; i++) sin += src[i]
  const bloomed = applyBloom(src, w, h, 1, 2) // full glare, base radius 2
  let sout = 0
  for (let i = 0; i < bloomed.length; i++) sout += bloomed[i]
  const energyErr = Math.abs(sout - sin) / sin
  // Identity at strength 0.
  const id = applyBloom(src, w, h, 0, 2)
  let idMax = 0
  for (let i = 0; i < src.length; i++) idMax = Math.max(idMax, Math.abs(id[i] - src[i]))
  const ok = energyErr < 1e-4 && idMax < 1e-6
  return { pass: ok, detail: `ΔE/E=${energyErr.toExponential(2)}, identity max|Δ|=${idMax.toExponential(1)}` }
}

// Bloom (2): an impulse spreads into a monotone-falloff halo — the peak drops,
// the neighbourhood lifts, and the glare decreases with distance from the source.
function testBloomHalo(): { pass: boolean; detail: string } {
  const w = 64
  const h = 64
  const src = new Float32Array(w * h * 3)
  const ci = (32 * w + 32) * 3
  src[ci] = 100
  src[ci + 1] = 100
  src[ci + 2] = 100
  const out = applyBloom(src, w, h, 1, 2)
  const peak = out[ci]
  const near = out[((32 * w + 34) * 3) | 0] // 2 px away
  const far = out[((32 * w + 40) * 3) | 0] // 8 px away
  const ok = peak < 100 && near > 0 && near > far && far >= 0
  return { pass: ok, detail: `peak=${peak.toFixed(3)} (<100), near=${near.toFixed(4)} > far=${far.toFixed(4)}` }
}

// Vignette: the falloff is exactly cos⁴θ — unattenuated at the optical centre,
// monotone-decreasing with field angle, bounded in (0,1] — and strength 0 is an
// identity while strength 1 darkens the corners.
function testVignette(): { pass: boolean; detail: string } {
  const centre = naturalVignetteFactor(0, 0)
  // tanθ = 1 ⇒ θ = 45°, cos⁴45° = 0.25.
  const at45 = naturalVignetteFactor(1, 0)
  const cos4_45 = Math.pow(Math.cos(Math.atan(1)), 4)
  const mono = naturalVignetteFactor(0.3, 0) > naturalVignetteFactor(0.9, 0)
  const bounded = at45 > 0 && at45 <= 1 && naturalVignetteFactor(2, 1.5) > 0
  // Applied: a flat field, strength 0 unchanged; strength 1 darkens a corner.
  const w = 9
  const h = 9
  const flat = () => {
    const b = new Float32Array(w * h * 3)
    b.fill(1)
    return b
  }
  const off = flat()
  applyVignette(off, w, h, 0, 50)
  let offMax = 0
  for (let i = 0; i < off.length; i++) offMax = Math.max(offMax, Math.abs(off[i] - 1))
  const on = flat()
  applyVignette(on, w, h, 1, 50)
  const centrePix = on[(4 * w + 4) * 3] // middle pixel ≈ axis
  const cornerPix = on[(0 * w + 0) * 3]
  const ok =
    approx(centre, 1, 1e-12) &&
    approx(at45, 0.25, 1e-9) &&
    approx(at45, cos4_45, 1e-9) &&
    mono &&
    bounded &&
    offMax < 1e-9 &&
    cornerPix < centrePix
  return {
    pass: ok,
    detail: `centre=${centre}, cos⁴45°=${at45.toFixed(4)}, off|Δ|=${offMax.toExponential(1)}, corner ${cornerPix.toFixed(3)} < centre ${centrePix.toFixed(3)}`,
  }
}

// Chromatic aberration: identity at magnitude 0 and at the optical centre, green
// is the untouched reference channel, and red is radially displaced (magnified —
// so right of centre it samples from nearer the centre).
function testChromaticAberration(): { pass: boolean; detail: string } {
  const w = 65 // odd ⇒ an exact centre pixel exists
  const h = 65
  const src = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      src[o] = (x / (w - 1)) * 255 // R ramps left→right
      src[o + 1] = (y / (h - 1)) * 255 // G ramps top→bottom
      src[o + 2] = 128
      src[o + 3] = 255
    }
  }
  // Identity at k = 0.
  const id = chromaticAberration(src, w, h, 0)
  let idMax = 0
  for (let i = 0; i < src.length; i++) idMax = Math.max(idMax, Math.abs(id[i] - src[i]))
  // k > 0: green untouched everywhere; centre a fixed point; red pulled inward.
  const ca = chromaticAberration(src, w, h, 0.05)
  let greenMax = 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      greenMax = Math.max(greenMax, Math.abs(ca[o + 1] - src[o + 1]))
    }
  const cIdx = (32 * w + 32) * 4 // centre pixel
  const centreOk = ca[cIdx] === src[cIdx] && ca[cIdx + 2] === src[cIdx + 2]
  const rightIdx = (32 * w + 56) * 4 // right of centre: red magnified ⇒ samples smaller x ⇒ lower R
  const redInward = ca[rightIdx] < src[rightIdx]
  const ok = idMax === 0 && greenMax === 0 && centreOk && redInward
  return {
    pass: ok,
    detail: `id|Δ|=${idMax}, greenΔ=${greenMax}, centre fixed=${centreOk}, red inward=${redInward}`,
  }
}

// Film grain: zero-mean (preserves the image mean), vanishes at pure black and
// pure white (the envelope is 0 there), strength 0 is identity, and the variance
// grows with strength.
function testFilmGrain(): { pass: boolean; detail: string } {
  const envOk = grainEnvelope(0) === 0 && grainEnvelope(1) === 0 && approx(grainEnvelope(0.5), 1, 1e-12)
  const w = 200
  const h = 200
  const n = w * h
  const mk = (val: number) => {
    const b = new Uint8ClampedArray(n * 4)
    for (let i = 0; i < n; i++) {
      b[i * 4] = val
      b[i * 4 + 1] = val
      b[i * 4 + 2] = val
      b[i * 4 + 3] = 255
    }
    return b
  }
  // Endpoints fixed.
  const black = mk(0)
  applyGrain(black, w, h, 1)
  const white = mk(255)
  applyGrain(white, w, h, 1)
  let blackMax = 0
  let whiteMin = 255
  for (let i = 0; i < n; i++) {
    blackMax = Math.max(blackMax, black[i * 4])
    whiteMin = Math.min(whiteMin, white[i * 4])
  }
  // Identity at strength 0.
  const id = mk(128)
  applyGrain(id, w, h, 0)
  let idMax = 0
  for (let i = 0; i < n; i++) idMax = Math.max(idMax, Math.abs(id[i * 4] - 128))
  // Zero-mean + variance grows with strength on a midtone field.
  const meanVar = (strength: number): { mean: number; varc: number } => {
    const g = mk(128)
    applyGrain(g, w, h, strength)
    let s = 0
    let s2 = 0
    for (let i = 0; i < n; i++) {
      const x = g[i * 4]
      s += x
      s2 += x * x
    }
    const mean = s / n
    return { mean, varc: s2 / n - mean * mean }
  }
  const lo = meanVar(0.1)
  const hi = meanVar(0.6)
  const ok =
    envOk &&
    blackMax === 0 &&
    whiteMin === 255 &&
    idMax === 0 &&
    Math.abs(hi.mean - 128) < 0.5 &&
    hi.varc > lo.varc &&
    lo.varc > 0
  return {
    pass: ok,
    detail: `env✓=${envOk}, black=${blackMax}, white=${whiteMin}, mean=${hi.mean.toFixed(3)}, var ${lo.varc.toFixed(2)}→${hi.varc.toFixed(2)}`,
  }
}

// The whole pipeline with every knob at 0 is a bit-exact identity — the headline
// safety guarantee (the default render, and all prior proofs, are unchanged).
function testPostIdentity(): { pass: boolean; detail: string } {
  const w = 16
  const h = 12
  const hdr = new Float32Array(w * h * 3)
  for (let i = 0; i < hdr.length; i++) hdr[i] = Math.sin(i * 0.7) * 0.5 + 0.6
  const outHdr = postProcessHdr(hdr, w, h, POST_OFF)
  let hdrMax = 0
  for (let i = 0; i < hdr.length; i++) hdrMax = Math.max(hdrMax, Math.abs(outHdr[i] - hdr[i]))
  const bytes = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) & 255
  const copy = bytes.slice()
  postProcessDisplay(bytes, w, h, POST_OFF)
  let byteMax = 0
  for (let i = 0; i < bytes.length; i++) byteMax = Math.max(byteMax, Math.abs(bytes[i] - copy[i]))
  const ok = hdrMax < 1e-12 && byteMax === 0
  return { pass: ok, detail: `HDR max|Δ|=${hdrMax.toExponential(1)}, byte max|Δ|=${byteMax}` }
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
    test('GGX albedo table — E∈(0,1], Eavg↓ with roughness', testGgxAlbedoTable),
    test('Multiscatter metal restores energy (≈1)', testMetalMultiscatterEnergy),
    test('Anisotropic GGX — reciprocal, bounded, streaked', testAnisoMetal),
    test('Oren–Nayar diffuse — reciprocal, rough > Lambert', testOrenNayar),
    test('Clear-coat diffuse — reciprocal, glossy, energy ≤ 1', testClearcoat),
    test('Diffuse Helmholtz reciprocity', testReciprocity),
    test('Procedural texture parity & range', testTexture),
    test('Spectral white point E_λ[w]=1', testSpectralWhitePoint),
    test('Cauchy dispersion n(blue) > n(red)', testDispersion),
    test('Rough dielectric energy ≤ 1', testRoughDielectricEnergy),
    test('Beer–Lambert absorption tints glass', testBeerLambert),
    test('resolveMaterial bakes texture albedo', testResolveTexture),
    test('Smooth normal barycentric interpolation', testSmoothNormal),
    test('Icosphere radial normals + Euler χ=2', testIcosphere),
    test('OBJ cube parse + auto-fit + normals', testObjCube),
    test('Torus analytic normals', testTorusNormals),
    test('Preetham sky positivity & ordering', testSky),
    test('Env-sun sampler ↔ pdf + solid angle', testEnvSampler),
    test('Env-sampled white furnace ρ=0.8', testEnvFurnace),
    test('Henyey–Greenstein phase (∫=1, pdf, mean cos)', testPhase),
    test('Homogeneous medium transmittance e^(−σL)', testMediumTransmittance),
    test('Scattering volume conserves energy (=1)', testVolumeScatterEnergy),
    test('Absorbing volume e^(−σ·chord)', testVolumeAbsorb),
    test('Procedural noise — bounded, continuous, det, mean½', testNoiseField),
    test('Delta tracking ≡ e^(−σL) (constant field)', testDeltaTrackConstant),
    test('Ratio tracking ≡ e^(−∫σds) (varying layer)', testRatioTrackVarying),
    test('Delta tracking ≡ e^(−∫σds) (varying layer)', testDeltaTrackVarying),
    test('Heterogeneous scattering volume conserves energy (=1)', testHeteroVolumeEnergy),
    test('Emissive volume (1−e^(−σ·chord))·Lₑ', testEmissiveVolume),
    test('Chromatic media — homogeneous transmittance exact ∀λ', testChromaticMediumTransmittance),
    test('Chromatic media — ratio tracking unbiased ∀λ', testChromaticRatioTrack),
    test('Chromatic media — scattering furnace ≡ 1 (energy ∀λ)', testChromaticVolumeEnergy),
    test('Chromatic media — absorbing haze reddens (∫w·e^−σ(λ)L)', testChromaticVolumeReddens),
    test('Chromatic media — achromatic ≡ scalar medium (oracle)', testChromaticReducesToScalar),
    test('Thin-film R∈[0,1], d→0 Fresnel, iridescent', testThinFilm),
    test('Halton L2 discrepancy < random', testQmcDiscrepancy),
    test('BDPT white furnace — diffuse ρ=0.8', testBdptFurnace),
    test('BDPT ≡ path tracer (diffuse box oracle)', testBdptVsPt),
    test('BDPT ≡ PT (coat/Oren–Nayar/multiscatter/aniso lab)', testMaterialLabVsPt),
    test('BDPT MIS weights partition to 1', testBdptMis),
    test('Solid-angle → area density conversion', testAreaDensity),
    test('PSSMLT sampler — uniform large step + determinism', testMltSampler),
    test('PSSMLT white furnace — diffuse ρ=0.8', testMltFurnace),
    test('PSSMLT ≡ path tracer (diffuse box oracle)', testMltVsPt),
    test('SPPM ≡ path tracer (diffuse box oracle)', testSppmVsPt),
    test('SPPM resolves a caustic (focused & finite)', testSppmCaustic),
    test('SPPM photon-gather grid exact vs brute force', testSppmGrid),
    test('Spectral photons conserve energy (E_λ[w]=1)', testSpectralPhotonEnergy),
    test('Spectral caustic is coloured, achromatic is grey', testSpectralCausticColour),
    test('Env-sun photons ≡ path tracer (daylight oracle)', testEnvPhotonOracle),
    test('Env photons resolve a daylight caustic (focused)', testEnvPhotonCaustic),
    test('Conductor Fresnel R∈[0,1], grazing→1', testConductorFresnelRange),
    test('Conductor Fresnel k→0 ≡ dielectric Fresnel', testConductorDielectricLimit),
    test('Measured metal colours (Au/Cu warm, Ag/Al bright, Fe grey)', testMetalColours),
    test('Spectral metal reconstructs measured RGB (furnace oracle)', testSpectralMetalReconstructsColour),
    test('Spectral conductor lobe — sampler ↔ pdf ↔ weight', testSpectralMetalConsistency),
    test('Spectral multiscatter metal restores energy (≤ F̄)', testSpectralMetalMultiscatter),
    test('Subsurface furnace — pure scatter ≡ 1 (any g)', testSubsurfaceFurnace),
    test('Subsurface Beer — pure absorb ≡ e^(−σ·2r)', testSubsurfaceBeer),
    test('Subsurface interface energy ≡ 1 (Fresnel+TIR+scatter)', testSubsurfaceInterfaceEnergy),
    test('Subsurface colour — per-channel albedo tints (R>G>B)', testSubsurfaceColour),
    test('Subsurface reflectance monotone in albedo (≤1)', testSubsurfaceAlbedoMonotone),
    test('Spectral SSS — RGB→λ upsampling reproduces & bounds', testSpectralUpsampling),
    test('Spectral SSS — measured BSSRDF media sane (red-deepest)', testBssrdfPresets),
    test('Spectral SSS — chromatic furnace ≡ 1 (energy ∀λ)', testSpectralSubsurfaceFurnace),
    test('Spectral SSS — Beer ≡ ∫w(λ)e^(−σ(λ)·2r), R>G>B', testSpectralSubsurfaceBeer),
    test('Spectral SSS — achromatic ≡ scalar walk (oracle)', testSpectralReducesToScalar),
    test('Spectral SSS — measured skin glows red (library→render)', testMeasuredMediumGlow),
    test('Path guiding — DTree density integrates to 1', testGuideDensityNormalised),
    test('Path guiding — sampler ↔ pdf consistent', testGuideSamplerPdf),
    test('Path guiding — importance sampling cuts variance', testGuideVarianceReduction),
    test('Path guiding ≡ path tracer (diffuse box oracle)', testGuideVsPt),
    test('Many lights — selection pdf sums to 1', testLightTreeNormalised),
    test('Many lights — every light has positive prob (unbiased)', testLightTreePositive),
    test('Many lights — light-tree sampler ↔ pdf', testLightTreeSamplerPdf),
    test('Many lights — reduces to uniform (coincident lights)', testLightTreeReducesToUniform),
    test('Many lights — same mean, far lower variance (light BVH)', testManyLightsVariance),
    test('Light tree — receiver-aware pdf sums to 1 ∀ normal', testLightTreeReceiverNormalised),
    test('Light tree — receiver-aware sampler ↔ pdf', testLightTreeReceiverSamplerPdf),
    test('Light tree — receiver term steers to lit hemisphere', testLightTreeReceiverDownweight),
    test('Light tree — receiver-aware same mean, lower variance', testLightTreeReceiverVariance),
    test('Sphere light — subtended-cone Ω + inverse-square limit', testSphereSolidAngle),
    test('Sphere light — cone sampler ↔ pdf (∫_cone dω=Ω, all hit)', testSphereSamplerPdf),
    test('Sphere light — directional pdf integrates to 1 over S²', testSpherePdfIntegratesToOne),
    test('Sphere light — analytic form-factor oracle + variance win', testSphereNeeOracle),
    test('Sphere light — NEE sampler ↔ lightPdf (MIS-consistent)', testSphereNeeMisConsistency),
    test('Sphere light — respects horizon + declines inside', testSphereNeeHorizonAndInside),
    test('Blackbody — Planck positivity + Wien displacement λ·T=b', testPlanckWien),
    test('Blackbody — Stefan–Boltzmann ∫B ∝ T⁴', testPlanckStefanBoltzmann),
    test('Blackbody — Planckian locus warm→cool, R/B↓ monotone', testBlackbodyLocus),
    test('Blackbody — 6500 K ≈ neutral white point', testBlackbodyWhitePoint),
    test('AgX — contrast curve monotone, bounded [0,1]', testAgxContrastCurve),
    test('AgX — neutral stays neutral (grey in ⇒ grey out)', testAgxNeutral),
    test('AgX — black→black, luminance monotone in exposure', testAgxBlackMonotone),
    test('AgX — highlights desaturate toward white', testAgxHighlightDesaturation),
    test('IBL — env distribution normalised (∫∫=1, ∫_S² p dω=1)', testEnvDistributionNormalised),
    test('IBL — importance sampler ↔ pdf (machine ε, all unit)', testEnvSamplerPdf),
    test('IBL — constant env reduces to uniform (1/4π)', testEnvReducesToUniform),
    test('IBL — env NEE MIS-consistent (envSunPdf ≡ p/N ≡ sampler)', testEnvMisConsistency),
    test('IBL — importance unbiased, far lower variance than uniform', testEnvImportanceVariance),
    test('IBL — env rotation is a measure-preserving symmetry', testEnvRotationInvariant),
    test('Bokeh — polygon aperture area-uniform, in-disk, zero-mean', testAperturePolygon),
    test('Bokeh — reduces to disk sampler + fills disk as blades→∞', testApertureDiskLimit),
    test('Glare — energy-conserving (centred) + identity off', testBloomEnergy),
    test('Glare — impulse spreads to a monotone-falloff halo', testBloomHalo),
    test('Vignette — exactly cos⁴θ, centre=1, monotone, identity off', testVignette),
    test('Chromatic aberration — centre/off identity, green fixed, red shifts', testChromaticAberration),
    test('Film grain — zero-mean, black/white fixed, variance↑ with strength', testFilmGrain),
    test('Image-formation pipeline — all-zero is a bit-exact identity', testPostIdentity),
  ]
}
