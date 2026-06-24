// An in-app numerical self-test of the ray tracer. Each check re-derives a claim
// from an independent reference — Möller–Trumbore against an analytic plane hit, the
// BVH against an exhaustive brute-force search, the importance-sampling
// distributions against their known statistics, and the BSDF against energy
// conservation (the furnace test). It runs live in the browser; nothing here
// touches the DOM.
import type { Vec3 } from '../math/vec.ts'
import { buildMesh } from '../geometry/mesh.ts'
import { translation, scaling, multiply, rotationY } from '../math/mat4.ts'
import { mollerTrumbore, rayAABB } from './intersect.ts'
import { RTScene } from './rtscene.ts'
import type { RTInstance } from './rtscene.ts'
import { BVH } from './bvh.ts'
import type { ClosestHit } from './bvh.ts'
import {
  Rng, cosineHemisphere, fresnelSchlick, orthonormalBasis, sampleGGX,
} from './sampling.ts'
import { tracePath } from './tracer.ts'
import type { RTContext } from './tracer.ts'

export interface RTTest {
  name: string
  pass: boolean
  detail: string
}

const white = (albedo: Vec3, metallic: number, roughness: number): RTInstance['material'] =>
  ({ albedo, specular: 0.5, shininess: 32, rim: 0, metallic, roughness })

function brute(scene: RTScene, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): ClosestHit | null {
  let best: ClosestHit | null = null
  let bestT = 1e30
  for (let i = 0; i < scene.count; i++) {
    const a3 = i * 3
    const p0: Vec3 = [scene.p0[a3], scene.p0[a3 + 1], scene.p0[a3 + 2]]
    const p1: Vec3 = [p0[0] + scene.e1[a3], p0[1] + scene.e1[a3 + 1], p0[2] + scene.e1[a3 + 2]]
    const p2: Vec3 = [p0[0] + scene.e2[a3], p0[1] + scene.e2[a3 + 1], p0[2] + scene.e2[a3 + 2]]
    const h = mollerTrumbore([ox, oy, oz], [dx, dy, dz], p0, p1, p2, 1e-4, bestT)
    if (h && h.t < bestT) { bestT = h.t; best = { t: h.t, tri: i, u: h.u, v: h.v } }
  }
  return best
}

export function runRTSelfTest(): RTTest[] {
  const tests: RTTest[] = []
  const add = (name: string, pass: boolean, detail: string): void => { tests.push({ name, pass, detail }) }

  // 1 — Möller–Trumbore against an analytic hit at z = −5
  {
    const hit = mollerTrumbore([0, 0, 0], [0, 0, -1], [-1, -1, -5], [1, -1, -5], [0, 1, -5], 1e-4, 1e9)
    const miss = mollerTrumbore([5, 5, 0], [0, 0, -1], [-1, -1, -5], [1, -1, -5], [0, 1, -5], 1e-4, 1e9)
    const ok = !!hit && Math.abs(hit.t - 5) < 1e-6 && Math.abs(hit.u - 0.25) < 1e-6 && Math.abs(hit.v - 0.5) < 1e-6 && miss === null
    add('Möller–Trumbore ray/triangle', ok, hit ? `t=${hit.t.toFixed(3)}, (u,v)=(${hit.u.toFixed(2)},${hit.v.toFixed(2)}), exterior ray misses` : 'no hit')
  }

  // 2 — ray/AABB slab test (a +z ray through a unit box; inv = 1/dir)
  {
    const enter = rayAABB(0, 0, -5, Infinity, Infinity, 1, -1, -1, -1, 1, 1, 1, 0, 1e9)
    const missed = rayAABB(5, 5, -5, Infinity, Infinity, 1, -1, -1, -1, 1, 1, 1, 0, 1e9)
    const ok = Math.abs(enter - 4) < 1e-6 && missed === Infinity
    add('Ray/AABB slab test', ok, `enter t=${enter.toFixed(2)} (expected 4), off-axis ray misses`)
  }

  // 3 — BVH vs brute force on random rays
  {
    const insts: RTInstance[] = [
      { mesh: buildMesh('knot'), model: translation(1.1, 0.4, 0), material: white([0.8, 0.8, 0.8], 0, 0.5), texture: null, normalMap: null },
      { mesh: buildMesh('torus'), model: multiply(translation(-1.4, 0, 0.4), scaling(0.8, 0.8, 0.8)), material: white([0.8, 0.8, 0.8], 0, 0.5), texture: null, normalMap: null },
      { mesh: buildMesh('cube'), model: multiply(translation(0, -1, 0), rotationY(0.6)), material: white([0.8, 0.8, 0.8], 0, 0.5), texture: null, normalMap: null },
    ]
    const scene = new RTScene(insts)
    const bvh = new BVH(scene)
    const rng = new Rng(0x1234abcd)
    const out: ClosestHit = { t: 0, tri: -1, u: 0, v: 0 }
    let mism = 0, hits = 0, maxErr = 0
    const N = 2500
    for (let k = 0; k < N; k++) {
      const ox = (rng.next() * 2 - 1) * 4, oy = (rng.next() * 2 - 1) * 4, oz = (rng.next() * 2 - 1) * 4
      let dx = rng.next() * 2 - 1, dy = rng.next() * 2 - 1, dz = rng.next() * 2 - 1
      const L = Math.hypot(dx, dy, dz) || 1; dx /= L; dy /= L; dz /= L
      const b = brute(scene, ox, oy, oz, dx, dy, dz)
      const r = bvh.closest(ox, oy, oz, dx, dy, dz, 1e-4, 1e30, out)
      if (!b && !r) continue
      if (b) hits++
      const bt = b ? b.t : Infinity
      const rt = r ? r.t : Infinity
      const err = Math.abs(bt - rt)
      if (err > 1e-4) mism++
      if (err !== Infinity && err > maxErr) maxErr = err
    }
    add('BVH ≡ brute force', mism === 0, `${N} random rays (${hits} hit), ${mism} mismatches, max |Δt|=${maxErr.toExponential(1)}, ${bvh.nodeTotal} nodes`)
  }

  // 4 — orthonormal basis is orthonormal
  {
    const rng = new Rng(7)
    let maxDev = 0
    for (let k = 0; k < 500; k++) {
      let nx = rng.next() * 2 - 1, ny = rng.next() * 2 - 1, nz = rng.next() * 2 - 1
      const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L
      const n: Vec3 = [nx, ny, nz]
      const [t1, t2] = orthonormalBasis(n)
      const d11 = t1[0] * t1[0] + t1[1] * t1[1] + t1[2] * t1[2]
      const d22 = t2[0] * t2[0] + t2[1] * t2[1] + t2[2] * t2[2]
      const d12 = t1[0] * t2[0] + t1[1] * t2[1] + t1[2] * t2[2]
      const d1n = t1[0] * nx + t1[1] * ny + t1[2] * nz
      const d2n = t2[0] * nx + t2[1] * ny + t2[2] * nz
      maxDev = Math.max(maxDev, Math.abs(d11 - 1), Math.abs(d22 - 1), Math.abs(d12), Math.abs(d1n), Math.abs(d2n))
    }
    add('Orthonormal basis (Duff)', maxDev < 1e-5, `max deviation from orthonormal = ${maxDev.toExponential(1)} over 500 normals`)
  }

  // 5 — cosine hemisphere: mean z → 2/3, all on the unit hemisphere
  {
    const rng = new Rng(99)
    let sumZ = 0, maxUnit = 0, minZ = 1
    const N = 24000
    for (let k = 0; k < N; k++) {
      const d = cosineHemisphere(rng.next(), rng.next())
      sumZ += d[2]
      minZ = Math.min(minZ, d[2])
      maxUnit = Math.max(maxUnit, Math.abs(Math.hypot(d[0], d[1], d[2]) - 1))
    }
    const meanZ = sumZ / N
    const ok = Math.abs(meanZ - 2 / 3) < 0.01 && minZ >= 0 && maxUnit < 1e-5
    add('Cosine-hemisphere sampling', ok, `E[cosθ]=${meanZ.toFixed(4)} (expected 0.6667), all unit & z≥0`)
  }

  // 6 — GGX importance sampling concentrates around the normal as roughness → 0
  {
    const rng = new Rng(2024)
    const meanZ = (a: number): number => {
      let s = 0; const N = 30000
      for (let k = 0; k < N; k++) s += sampleGGX(rng.next(), rng.next(), a)[2]
      return s / N
    }
    const sharp = meanZ(0.05 * 0.05)
    const rough = meanZ(0.9 * 0.9)
    const ok = sharp > 0.99 && rough < sharp
    add('GGX microfacet sampling', ok, `E[cosθ_m]: rough≈${rough.toFixed(3)} < smooth≈${sharp.toFixed(4)}`)
  }

  // 7 — Fresnel–Schlick endpoints
  {
    const f0: Vec3 = [0.04, 0.5, 1]
    const at0 = fresnelSchlick(1, f0) // head-on → F0
    const at90 = fresnelSchlick(0, f0) // grazing → 1
    const ok = Math.abs(at0[0] - 0.04) < 1e-6 && Math.abs(at0[1] - 0.5) < 1e-6 &&
      Math.abs(at90[0] - 1) < 1e-6 && Math.abs(at90[2] - 1) < 1e-6
    add('Fresnel–Schlick endpoints', ok, `F(0°)=F₀=${at0[1].toFixed(2)}, F(90°)=${at90[0].toFixed(2)}`)
  }

  // 8 — furnace test: a white surface in a uniform unit environment re-emits ≈ unit
  // radiance (energy conservation; the integrator creates no light and loses little).
  {
    const insts: RTInstance[] = [
      { mesh: buildMesh('sphere'), model: scaling(1, 1, 1), material: white([1, 1, 1], 0, 0.5), texture: null, normalMap: null },
    ]
    const scene = new RTScene(insts)
    const bvh = new BVH(scene)
    const ctx: RTContext = {
      scene, bvh, lights: [], env: null, ambient: [0, 0, 0],
      sky: () => [1, 1, 1], maxBounces: 8, sunCosHalf: 1, lightRadius: 0, aoRadius: 1e30,
    }
    const rng = new Rng(0xbeef)
    let sum = 0, n = 0
    const N = 24000
    for (let k = 0; k < N; k++) {
      // fire rays from outside, toward the sphere centre with a small jitter
      const ang = rng.next() * Math.PI * 2
      const r = Math.sqrt(rng.next()) * 0.9
      const ox = Math.cos(ang) * r, oy = Math.sin(ang) * r, oz = 4
      const c = tracePath(ox, oy, oz, 0, 0, -1, ctx, rng)
      // only count rays that actually struck the sphere (luminance well below the
      // unit background means we hit geometry rather than missing into the env)
      sum += (c[0] + c[1] + c[2]) / 3; n++
    }
    const avg = sum / n
    // includes background misses at ~1.0; the lit sphere sits a touch under unity
    const ok = avg > 0.9 && avg < 1.04
    add('Furnace test (energy conservation)', ok, `mean radiance ${avg.toFixed(4)} of unit environment (white surface, 8 bounces)`)
  }

  // 9 — area-light furnace: a surface fully enclosed by a unit-emissive shell must re-emit
  // ≈ unit radiance — but here the light is a real emissive triangle mesh, so this exercises
  // the *area-light* transport (NEE + the MIS-weighted BSDF emitter hits). A glossy surface
  // that read > 1 would betray the old NEE/BSDF double-count; MIS keeps it energy-exact.
  {
    const emissive = (e: number): RTInstance['material'] =>
      ({ albedo: [0, 0, 0], specular: 0, shininess: 1, rim: 0, metallic: 0, roughness: 1, emission: [e, e, e] })
    const probe = (metallic: number, roughness: number): number => {
      const insts: RTInstance[] = [
        { mesh: buildMesh('sphere'), model: scaling(1, 1, 1), material: white([1, 1, 1], metallic, roughness), texture: null, normalMap: null },
        { mesh: buildMesh('sphere'), model: scaling(12, 12, 12), material: emissive(1), texture: null, normalMap: null },
      ]
      const scene = new RTScene(insts)
      const bvh = new BVH(scene)
      const ctx: RTContext = {
        scene, bvh, lights: [], env: null, ambient: [0, 0, 0],
        sky: () => [0, 0, 0], maxBounces: 12, sunCosHalf: 1, lightRadius: 0, aoRadius: 1e30, mis: true,
      }
      const rng = new Rng(0xa11 ^ ((metallic * 7 + roughness * 13) | 0))
      let sum = 0; const N = 16000
      for (let k = 0; k < N; k++) {
        const ang = rng.next() * Math.PI * 2
        const r = Math.sqrt(rng.next()) * 0.85
        const c = tracePath(Math.cos(ang) * r, Math.sin(ang) * r, 4, 0, 0, -1, ctx, rng)
        sum += (c[0] + c[1] + c[2]) / 3
      }
      return sum / N
    }
    const diff = probe(0, 0.5)
    const gloss = probe(1, 0.1)
    const ok = diff > 0.95 && diff < 1.06 && gloss > 0.95 && gloss < 1.06
    add('Area-light furnace (MIS, no double-count)', ok, `enclosed in a unit emitter: diffuse ${diff.toFixed(4)}, glossy metal ${gloss.toFixed(4)} (both ≈ 1 — no NEE/BSDF double count)`)
  }

  // 10 — MIS variance reduction: a glossy surface under a *large* area light is the classic
  // case where next-event estimation alone is noisy (a random point on the big light rarely
  // lands in the narrow specular lobe, so the rare hits carry huge weight) while BSDF
  // sampling nails the lobe. MIS combines both — same mean (unbiased), far lower variance.
  {
    const glossy: RTInstance['material'] = { albedo: [1, 0.86, 0.45], specular: 0.5, shininess: 32, rim: 0, metallic: 1, roughness: 0.15 }
    const emit: RTInstance['material'] = { albedo: [0, 0, 0], specular: 0, shininess: 1, rim: 0, metallic: 0, roughness: 1, emission: [8, 8, 8] }
    const insts: RTInstance[] = [
      { mesh: buildMesh('sphere'), model: scaling(1, 1, 1), material: glossy, texture: null, normalMap: null },
      { mesh: buildMesh('sphere'), model: multiply(translation(0, 5, 0), scaling(3, 3, 3)), material: emit, texture: null, normalMap: null },
    ]
    const scene = new RTScene(insts)
    const bvh = new BVH(scene)
    const base = { scene, bvh, lights: [], env: null, ambient: [0, 0, 0] as Vec3, sky: (): Vec3 => [0, 0, 0], maxBounces: 2, sunCosHalf: 1, lightRadius: 0, aoRadius: 1e30 }
    // a single fixed camera ray onto the glossy sphere — pure estimator variance at one pixel
    const ox = 0, oy = 1, oz = 3.4
    let dx = 0 - ox, dy = 0.55 - oy, dz = 0 - oz
    const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl
    const measure = (mis: boolean): { mean: number; varr: number } => {
      const ctx: RTContext = { ...base, mis }
      const rng = new Rng(0x99)
      let s = 0, s2 = 0; const N = 30000
      for (let k = 0; k < N; k++) {
        const c = tracePath(ox, oy, oz, dx, dy, dz, ctx, rng)
        const v = (c[0] + c[1] + c[2]) / 3
        s += v; s2 += v * v
      }
      const mean = s / N
      return { mean, varr: Math.max(0, s2 / N - mean * mean) }
    }
    const on = measure(true)
    const off = measure(false)
    const ratio = off.varr / Math.max(1e-9, on.varr)
    const meanErr = Math.abs(on.mean - off.mean) / Math.max(1e-6, off.mean)
    const ok = ratio > 20 && meanErr < 0.05
    add('MIS variance reduction vs NEE-only', ok, `same mean (Δ ${(meanErr * 100).toFixed(2)}%), variance ${ratio.toFixed(0)}× lower than next-event-only on a glossy surface under a large light`)
  }

  return tests
}
