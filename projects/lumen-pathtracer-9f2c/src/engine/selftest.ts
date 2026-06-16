// selftest.ts — an in-app verification harness. Rather than trust the renderer
// by eye, these checks assert the mathematical invariants a correct path tracer
// must satisfy: energy conservation (white-furnace), exact acceleration-vs-brute
// agreement, sampler/pdf consistency, and the analytic Fresnel/Snell laws. They
// run in well under a second and surface as a pass/fail panel in the UI.

import { add, cross, dot, len, normalize, scale, sub, v, reflect, refract, luminance } from './vec3'
import type { Vec3 } from './vec3'
import { Rng } from './rng'
import { sampleBSDF, pdfBSDF, evalBSDF, resolveMaterial } from './material'
import type { Material } from './material'
import { makeSphere, intersectPrim } from './primitive'
import type { Primitive } from './primitive'
import { Bvh } from './bvh'
import { Scene } from './scene'
import { radiance } from './integrator'
import type { RayStats } from './integrator'
import { radianceBDPT, areaDensity, misPartitionResidual } from './bdpt'
import { Camera } from './camera'
import { MltState, PssmltSampler } from './pssmlt'
import type { SceneDef } from './types'
import { evalTexture } from './texture'
import type { Texture } from './texture'
import { cauchyIor, wavelengthWeight, LAMBDA_MIN, LAMBDA_MAX } from './spectrum'
import { icosphere, torus, meshTriangleCount } from './mesh'
import { parseObj, CUBE_OBJ } from './obj'
import { makeSky, skyRadiance } from './sky'
import { hgPhase, sampleHG } from './phase'
import { thinFilmReflectance } from './thinfilm'
import { radicalInverse } from './qmc'

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
    test('Thin-film R∈[0,1], d→0 Fresnel, iridescent', testThinFilm),
    test('Halton L2 discrepancy < random', testQmcDiscrepancy),
    test('BDPT white furnace — diffuse ρ=0.8', testBdptFurnace),
    test('BDPT ≡ path tracer (diffuse box oracle)', testBdptVsPt),
    test('BDPT MIS weights partition to 1', testBdptMis),
    test('Solid-angle → area density conversion', testAreaDensity),
    test('PSSMLT sampler — uniform large step + determinism', testMltSampler),
    test('PSSMLT white furnace — diffuse ρ=0.8', testMltFurnace),
    test('PSSMLT ≡ path tracer (diffuse box oracle)', testMltVsPt),
  ]
}
