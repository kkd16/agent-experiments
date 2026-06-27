// The path tracer. Given the BVH + triangle soup it estimates the radiance along a
// ray with a metallic-roughness BSDF identical to the rasterizer's `pbr.ts`
// (Lambert diffuse + GGX specular), next-event estimation to the scene's punctual
// and emissive-area lights, multi-bounce indirect light, Russian-roulette
// termination and the analytic sky as an infinite emitter. A second, cheaper
// estimator renders pure ambient occlusion. Both share the BVH and accumulate
// across frames in `raytracer.ts`.
import type { Vec3 } from '../math/vec.ts'
import type { Light } from '../render/shading.ts'
import type { Environment } from '../render/environment.ts'
import type { RTScene, RTMaterial } from './rtscene.ts'
import type { BVH, ClosestHit } from './bvh.ts'
import {
  cosineHemisphere, distributionGGX, orthonormalBasis, powerHeuristic,
  sampleGGX, toWorld, uniformCone, uniformSphere, type Rng,
} from './sampling.ts'
import type { Medium, DistanceSample } from './medium.ts'
import {
  mediumTransmittance, phaseHG, raySpan, sampleDeltaTracking,
  sampleHomogeneousDistance, samplePhaseHG,
} from './medium.ts'
import { cauchyIor, fresnelDielectric, reflect, refract, smithG1 } from './dielectric.ts'
import { sampleFilmLUT } from './thinfilm.ts'

const PI = Math.PI
const EPS = 1e-3
const tmpFilm = new Float64Array(3) // scratch for the thin-film reflectance lookup

// The lighting environment the renderer supplies; the RayTracer pairs it with the
// scene + BVH it owns to form the full RTContext below.
export interface RTLighting {
  lights: Light[]
  env: Environment | null
  ambient: Vec3
  sky: (dx: number, dy: number, dz: number) => Vec3 // radiance for a ray that misses
  maxBounces: number
  sunCosHalf: number // cos of the directional-light cone half-angle (1 = hard shadows)
  lightRadius: number // point-light sphere radius for soft shadows
  aoRadius: number // ambient-occlusion ray reach
  medium?: Medium | null // optional participating medium (fog / haze / smoke / nebula)
  mis?: boolean // combine NEE + BSDF sampling by the power heuristic (default on); off ⇒ NEE-only
}

export interface RTContext extends RTLighting {
  scene: RTScene
  bvh: BVH
}

// The shaded surface at a hit, two-sided and normal-mapped, ready for the BSDF.
export interface Surface {
  px: number; py: number; pz: number
  nx: number; ny: number; nz: number // shading normal, facing the viewer
  gx: number; gy: number; gz: number // geometric normal, facing the viewer
  br: number; bg: number; bb: number // albedo after texture modulation
  mat: RTMaterial
  frontFace: boolean // true when the ray struck the outward (entering) side — sets the dielectric IOR ratio
}

// Reconstruct the world-space surface at a barycentric hit. `dx,dy,dz` is the
// incoming ray direction; the shading/geometric normals are flipped to face it so
// planes (ground, walls) are lit from both sides.
export function surfaceAt(scene: RTScene, tri: number, u: number, v: number, dx: number, dy: number, dz: number): Surface {
  const w = 1 - u - v
  const o3 = tri * 3
  const o2 = tri * 2
  const o4 = tri * 4
  const e1x = scene.e1[o3], e1y = scene.e1[o3 + 1], e1z = scene.e1[o3 + 2]
  const e2x = scene.e2[o3], e2y = scene.e2[o3 + 1], e2z = scene.e2[o3 + 2]
  const px = scene.p0[o3] + u * e1x + v * e2x
  const py = scene.p0[o3 + 1] + u * e1y + v * e2y
  const pz = scene.p0[o3 + 2] + u * e1z + v * e2z

  // interpolated (smooth) shading normal
  let nx = w * scene.n0[o3] + u * scene.n1[o3] + v * scene.n2[o3]
  let ny = w * scene.n0[o3 + 1] + u * scene.n1[o3 + 1] + v * scene.n2[o3 + 1]
  let nz = w * scene.n0[o3 + 2] + u * scene.n1[o3 + 2] + v * scene.n2[o3 + 2]
  const nl = Math.hypot(nx, ny, nz) || 1
  nx /= nl; ny /= nl; nz /= nl
  // geometric normal from the edges
  let gx = e1y * e2z - e1z * e2y
  let gy = e1z * e2x - e1x * e2z
  let gz = e1x * e2y - e1y * e2x
  const gl = Math.hypot(gx, gy, gz) || 1
  gx /= gl; gy /= gl; gz /= gl

  // face both normals toward the viewer (two-sided shading). The pre-flip sign tells
  // us which side we hit: vDotG ≥ 0 means the ray met the outward face (entering a
  // solid); < 0 means it met the back face from inside (exiting). The dielectric BSDF
  // needs this to pick the IOR ratio (air→glass vs glass→air).
  const vDotG = -(gx * dx + gy * dy + gz * dz)
  const frontFace = vDotG >= 0
  if (vDotG < 0) { gx = -gx; gy = -gy; gz = -gz }
  const vDotN = -(nx * dx + ny * dy + nz * dz)
  if (vDotN < 0) { nx = -nx; ny = -ny; nz = -nz }

  const mat = scene.materials[scene.matIndex[tri]]
  let br = mat.albedo[0], bg = mat.albedo[1], bb = mat.albedo[2]
  let uu = 0, vv = 0
  const needUV = mat.texture !== null || mat.normalMap !== null
  if (needUV) {
    uu = w * scene.uv0[o2] + u * scene.uv1[o2] + v * scene.uv2[o2]
    vv = w * scene.uv0[o2 + 1] + u * scene.uv1[o2 + 1] + v * scene.uv2[o2 + 1]
  }
  if (mat.texture) {
    const t = mat.texture(uu, vv)
    br *= t[0]; bg *= t[1]; bb *= t[2]
  }
  // tangent-space normal map perturbs the shading normal (after the two-sided flip)
  if (mat.normalMap) {
    let Tx = scene.tan[o4], Ty = scene.tan[o4 + 1], Tz = scene.tan[o4 + 2]
    const handed = scene.tan[o4 + 3]
    // Gram–Schmidt against the (flipped) shading normal
    const tDotN = Tx * nx + Ty * ny + Tz * nz
    Tx -= nx * tDotN; Ty -= ny * tDotN; Tz -= nz * tDotN
    const tl = Math.hypot(Tx, Ty, Tz)
    if (tl > 1e-6) {
      Tx /= tl; Ty /= tl; Tz /= tl
      const Bx = (ny * Tz - nz * Ty) * handed
      const By = (nz * Tx - nx * Tz) * handed
      const Bz = (nx * Ty - ny * Tx) * handed
      const m = mat.normalMap(uu, vv)
      let mx = Tx * m[0] + Bx * m[1] + nx * m[2]
      let my = Ty * m[0] + By * m[1] + ny * m[2]
      let mz = Tz * m[0] + Bz * m[1] + nz * m[2]
      const ml = Math.hypot(mx, my, mz) || 1
      mx /= ml; my /= ml; mz /= ml
      nx = mx; ny = my; nz = mz
    }
  }

  return { px, py, pz, nx, ny, nz, gx, gy, gz, br, bg, bb, mat, frontFace }
}

// The metallic-roughness BRDF (no cosine term), identical in form to pbr.ts.
// Writes f into `out` (length-3). N, V, L are unit; base is the textured albedo.
function evalBRDF(
  out: Float64Array,
  nx: number, ny: number, nz: number,
  vx: number, vy: number, vz: number,
  lx: number, ly: number, lz: number,
  mat: RTMaterial, br: number, bg: number, bb: number,
): void {
  out[0] = 0; out[1] = 0; out[2] = 0
  const NoL = nx * lx + ny * ly + nz * lz
  const NoV = nx * vx + ny * vy + nz * vz
  if (NoL <= 0 || NoV <= 0) return
  const metallic = mat.metallic
  const a = mat.roughness * mat.roughness
  // half vector
  let hx = vx + lx, hy = vy + ly, hz = vz + lz
  const hl = Math.hypot(hx, hy, hz) || 1
  hx /= hl; hy /= hl; hz /= hl
  const NoH = Math.max(0, nx * hx + ny * hy + nz * hz)
  const VoH = Math.max(0, vx * hx + vy * hy + vz * hz)

  // Microfacet Fresnel. A thin-film coat replaces Schlick with the exact spectral
  // interference reflectance at the half-angle (its angle dependence already runs to 1 at
  // grazing, so no Schlick term is layered on top); otherwise the usual metallic-tinted
  // Schlick over F0 = 0.04 (dielectric) … albedo (metal).
  let Fr: number, Fg: number, Fb: number
  if (mat.filmLut) {
    sampleFilmLUT(mat.filmLut, VoH, tmpFilm)
    Fr = tmpFilm[0]; Fg = tmpFilm[1]; Fb = tmpFilm[2]
  } else {
    const f0r = 0.04 + (br - 0.04) * metallic
    const f0g = 0.04 + (bg - 0.04) * metallic
    const f0b = 0.04 + (bb - 0.04) * metallic
    const fc = Math.pow(Math.max(0, 1 - VoH), 5)
    Fr = f0r + (1 - f0r) * fc
    Fg = f0g + (1 - f0g) * fc
    Fb = f0b + (1 - f0b) * fc
  }

  const D = distributionGGX(NoH, a)
  // height-correlated Smith visibility (folds 1/(4·NoV·NoL))
  const a2 = a * a
  const gv = NoL * Math.sqrt(NoV * NoV * (1 - a2) + a2)
  const gl = NoV * Math.sqrt(NoL * NoL * (1 - a2) + a2)
  const Vis = 0.5 / (gv + gl + 1e-7)
  const specCommon = D * Vis

  const kdr = (1 - Fr) * (1 - metallic)
  const kdg = (1 - Fg) * (1 - metallic)
  const kdb = (1 - Fb) * (1 - metallic)
  out[0] = kdr * br / PI + specCommon * Fr
  out[1] = kdg * bg / PI + specCommon * Fg
  out[2] = kdb * bb / PI + specCommon * Fb
}

// Next-event estimation: direct light from every punctual + emissive-area light,
// each with a shadow ray. Returns the accumulated direct radiance.
function directLight(s: Surface, vx: number, vy: number, vz: number, ctx: RTContext, rng: Rng, f: Float64Array): Vec3 {
  const { bvh } = ctx
  const m = ctx.medium ?? null
  let r = 0, g = 0, b = 0
  // shadow-ray origin nudged off the surface along the geometric normal
  const ogx = s.px + s.gx * EPS
  const ogy = s.py + s.gy * EPS
  const ogz = s.pz + s.gz * EPS

  for (let i = 0; i < ctx.lights.length; i++) {
    const light = ctx.lights[i]
    if (light.type === 'dir') {
      let lx = -light.direction[0], ly = -light.direction[1], lz = -light.direction[2]
      const ll = Math.hypot(lx, ly, lz) || 1
      lx /= ll; ly /= ll; lz /= ll
      if (ctx.sunCosHalf < 0.9999) {
        const local = uniformCone(rng.next(), rng.next(), ctx.sunCosHalf)
        const [t1, t2] = orthonormalBasis([lx, ly, lz])
        const w = toWorld(local, t1, t2, [lx, ly, lz])
        lx = w[0]; ly = w[1]; lz = w[2]
      }
      const NoL = s.nx * lx + s.ny * ly + s.nz * lz
      if (NoL <= 0) continue
      if (bvh.occluded(ogx, ogy, ogz, lx, ly, lz, EPS, 1e30)) continue
      evalBRDF(f, s.nx, s.ny, s.nz, vx, vy, vz, lx, ly, lz, s.mat, s.br, s.bg, s.bb)
      let tr0 = 1, tr1 = 1, tr2 = 1
      if (m) { const tr = mediumTransmittance(m, ogx, ogy, ogz, lx, ly, lz, 1e30, rng); tr0 = tr[0]; tr1 = tr[1]; tr2 = tr[2] }
      const ir = light.color[0] * light.intensity * tr0
      const ig = light.color[1] * light.intensity * tr1
      const ib = light.color[2] * light.intensity * tr2
      r += f[0] * NoL * ir; g += f[1] * NoL * ig; b += f[2] * NoL * ib
    } else {
      let cx = light.position[0], cy = light.position[1], cz = light.position[2]
      if (ctx.lightRadius > 0) {
        const sph = uniformSphere(rng.next(), rng.next())
        cx += sph[0] * ctx.lightRadius; cy += sph[1] * ctx.lightRadius; cz += sph[2] * ctx.lightRadius
      }
      let lx = cx - s.px, ly = cy - s.py, lz = cz - s.pz
      const dist = Math.hypot(lx, ly, lz) || 1
      lx /= dist; ly /= dist; lz /= dist
      const NoL = s.nx * lx + s.ny * ly + s.nz * lz
      if (NoL <= 0) continue
      const fall = 1 - (dist * dist) / (light.range * light.range)
      if (fall <= 0) continue
      const atten = fall * fall
      if (bvh.occluded(ogx, ogy, ogz, lx, ly, lz, EPS, dist - EPS)) continue
      evalBRDF(f, s.nx, s.ny, s.nz, vx, vy, vz, lx, ly, lz, s.mat, s.br, s.bg, s.bb)
      let tr0 = 1, tr1 = 1, tr2 = 1
      if (m) { const tr = mediumTransmittance(m, ogx, ogy, ogz, lx, ly, lz, dist, rng); tr0 = tr[0]; tr1 = tr[1]; tr2 = tr[2] }
      const ir = light.color[0] * light.intensity * atten * tr0
      const ig = light.color[1] * light.intensity * atten * tr1
      const ib = light.color[2] * light.intensity * atten * tr2
      r += f[0] * NoL * ir; g += f[1] * NoL * ig; b += f[2] * NoL * ib
    }
  }

  // emissive-area lights, sampled uniformly by world area
  const scene = ctx.scene
  const nE = scene.emissiveTris.length
  if (nE > 0 && scene.totalEmissiveArea > 1e-9) {
    const target = rng.next() * scene.totalEmissiveArea
    // binary search the cumulative-area table
    let lo = 0, hi = nE - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (scene.emissiveArea[mid] < target) lo = mid + 1
      else hi = mid
    }
    const tri = scene.emissiveTris[lo]
    const o3 = tri * 3
    const e1x = scene.e1[o3], e1y = scene.e1[o3 + 1], e1z = scene.e1[o3 + 2]
    const e2x = scene.e2[o3], e2y = scene.e2[o3 + 1], e2z = scene.e2[o3 + 2]
    // uniform barycentric point on the triangle
    const r1 = rng.next(); const r2 = rng.next()
    const su = Math.sqrt(r1)
    const bu = su * (1 - r2)
    const bv = su * r2
    const yx = scene.p0[o3] + bu * e1x + bv * e2x
    const yy = scene.p0[o3 + 1] + bu * e1y + bv * e2y
    const yz = scene.p0[o3 + 2] + bu * e1z + bv * e2z
    let lx = yx - s.px, ly = yy - s.py, lz = yz - s.pz
    const dist = Math.hypot(lx, ly, lz) || 1
    lx /= dist; ly /= dist; lz /= dist
    const NoL = s.nx * lx + s.ny * ly + s.nz * lz
    if (NoL > 0) {
      // light's geometric normal (two-sided emitter → use |cos|)
      let gx = e1y * e2z - e1z * e2y
      let gy = e1z * e2x - e1x * e2z
      let gz = e1x * e2y - e1y * e2x
      const gnl = Math.hypot(gx, gy, gz) || 1
      gx /= gnl; gy /= gnl; gz /= gnl
      const cosLight = Math.abs(gx * lx + gy * ly + gz * lz)
      if (cosLight > 1e-4 && !bvh.occluded(ogx, ogy, ogz, lx, ly, lz, EPS, dist - EPS)) {
        const mat = scene.materials[scene.matIndex[tri]]
        const G = cosLight / (dist * dist)
        const pdfInv = scene.totalEmissiveArea // 1 / pdfA
        evalBRDF(f, s.nx, s.ny, s.nz, vx, vy, vz, lx, ly, lz, s.mat, s.br, s.bg, s.bb)
        // multiple importance sampling (Veach): weight this light sample down by the chance
        // the BSDF sampler would also have found this same direction, so the two strategies
        // don't double-count the emitter on glossy surfaces. pdfL is the light's solid-angle
        // density (= 1/(G·area)); pdfB is the BSDF's. The matching weight lands on the
        // BSDF-sampled emitter hit in tracePath, and the pair sums to 1.
        const pdfL = 1 / (G * pdfInv)
        const wMIS = ctx.mis === false ? 1 : powerHeuristic(pdfL, bsdfPdf(s, vx, vy, vz, lx, ly, lz))
        const k = NoL * G * pdfInv * wMIS
        let tr0 = 1, tr1 = 1, tr2 = 1
        if (m) { const tr = mediumTransmittance(m, ogx, ogy, ogz, lx, ly, lz, dist, rng); tr0 = tr[0]; tr1 = tr[1]; tr2 = tr[2] }
        r += f[0] * mat.emission[0] * k * tr0
        g += f[1] * mat.emission[1] * k * tr1
        b += f[2] * mat.emission[2] * k * tr2
      }
    }
  }
  return [r, g, b]
}

// In-scattered direct light at a volume scattering vertex: next-event estimation
// using the Henyey–Greenstein phase function in place of a surface BRDF (no cosine
// term — the medium scatters over the full sphere), with each light's contribution
// attenuated by the medium transmittance along its own shadow ray. `dx,dy,dz` is the
// ray's incoming propagation direction (the phase axis).
function mediumDirectLight(
  px: number, py: number, pz: number,
  dx: number, dy: number, dz: number,
  ctx: RTContext, rng: Rng,
): Vec3 {
  const m = ctx.medium
  if (!m) return [0, 0, 0]
  const { bvh } = ctx
  let r = 0, g = 0, b = 0

  for (let i = 0; i < ctx.lights.length; i++) {
    const light = ctx.lights[i]
    if (light.type === 'dir') {
      let lx = -light.direction[0], ly = -light.direction[1], lz = -light.direction[2]
      const ll = Math.hypot(lx, ly, lz) || 1
      lx /= ll; ly /= ll; lz /= ll
      if (ctx.sunCosHalf < 0.9999) {
        const local = uniformCone(rng.next(), rng.next(), ctx.sunCosHalf)
        const [t1, t2] = orthonormalBasis([lx, ly, lz])
        const w = toWorld(local, t1, t2, [lx, ly, lz])
        lx = w[0]; ly = w[1]; lz = w[2]
      }
      if (bvh.occluded(px, py, pz, lx, ly, lz, EPS, 1e30)) continue
      const ph = phaseHG(m.g, dx * lx + dy * ly + dz * lz)
      const tr = mediumTransmittance(m, px, py, pz, lx, ly, lz, 1e30, rng)
      r += ph * tr[0] * light.color[0] * light.intensity
      g += ph * tr[1] * light.color[1] * light.intensity
      b += ph * tr[2] * light.color[2] * light.intensity
    } else {
      let cx = light.position[0], cy = light.position[1], cz = light.position[2]
      if (ctx.lightRadius > 0) {
        const sph = uniformSphere(rng.next(), rng.next())
        cx += sph[0] * ctx.lightRadius; cy += sph[1] * ctx.lightRadius; cz += sph[2] * ctx.lightRadius
      }
      let lx = cx - px, ly = cy - py, lz = cz - pz
      const dist = Math.hypot(lx, ly, lz) || 1
      lx /= dist; ly /= dist; lz /= dist
      const fall = 1 - (dist * dist) / (light.range * light.range)
      if (fall <= 0) continue
      const atten = fall * fall
      if (bvh.occluded(px, py, pz, lx, ly, lz, EPS, dist - EPS)) continue
      const ph = phaseHG(m.g, dx * lx + dy * ly + dz * lz)
      const tr = mediumTransmittance(m, px, py, pz, lx, ly, lz, dist, rng)
      r += ph * atten * tr[0] * light.color[0] * light.intensity
      g += ph * atten * tr[1] * light.color[1] * light.intensity
      b += ph * atten * tr[2] * light.color[2] * light.intensity
    }
  }

  // emissive-area lights, sampled by world area (same scheme as the surface NEE)
  const scene = ctx.scene
  const nE = scene.emissiveTris.length
  if (nE > 0 && scene.totalEmissiveArea > 1e-9) {
    const target = rng.next() * scene.totalEmissiveArea
    let lo = 0, hi = nE - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (scene.emissiveArea[mid] < target) lo = mid + 1
      else hi = mid
    }
    const tri = scene.emissiveTris[lo]
    const o3 = tri * 3
    const e1x = scene.e1[o3], e1y = scene.e1[o3 + 1], e1z = scene.e1[o3 + 2]
    const e2x = scene.e2[o3], e2y = scene.e2[o3 + 1], e2z = scene.e2[o3 + 2]
    const r1 = rng.next(); const r2 = rng.next()
    const su = Math.sqrt(r1)
    const bu = su * (1 - r2)
    const bv = su * r2
    const yx = scene.p0[o3] + bu * e1x + bv * e2x
    const yy = scene.p0[o3 + 1] + bu * e1y + bv * e2y
    const yz = scene.p0[o3 + 2] + bu * e1z + bv * e2z
    let lx = yx - px, ly = yy - py, lz = yz - pz
    const dist = Math.hypot(lx, ly, lz) || 1
    lx /= dist; ly /= dist; lz /= dist
    let gx = e1y * e2z - e1z * e2y
    let gy = e1z * e2x - e1x * e2z
    let gz = e1x * e2y - e1y * e2x
    const gnl = Math.hypot(gx, gy, gz) || 1
    gx /= gnl; gy /= gnl; gz /= gnl
    const cosLight = Math.abs(gx * lx + gy * ly + gz * lz)
    if (cosLight > 1e-4 && !bvh.occluded(px, py, pz, lx, ly, lz, EPS, dist - EPS)) {
      const mat = scene.materials[scene.matIndex[tri]]
      const G = cosLight / (dist * dist)
      const ph = phaseHG(m.g, dx * lx + dy * ly + dz * lz)
      const tr = mediumTransmittance(m, px, py, pz, lx, ly, lz, dist, rng)
      const k = ph * G * scene.totalEmissiveArea
      r += mat.emission[0] * k * tr[0]
      g += mat.emission[1] * k * tr[1]
      b += mat.emission[2] * k * tr[2]
    }
  }
  return [r, g, b]
}

// Importance-sample the BSDF for the next bounce. Returns the new direction, the
// throughput multiplier (f·cosθ / pdf), the solid-angle pdf of the sampled direction (for
// multiple importance sampling against next-event estimation), whether the bounce is a
// Dirac-delta specular one (a glass interface — MIS-exempt, counts emitters at weight 1),
// and whether it transmitted. Returns false if the sample is invalid.
interface BSDFSample { wx: number; wy: number; wz: number; wr: number; wg: number; wb: number; pdf: number; specular: boolean; transmitted: boolean }

const SMOOTH_DIELECTRIC = 0.04 // roughness ≤ this is treated as a perfectly smooth interface
const tmpRefract = new Float64Array(3)

// Importance-sample a rough-dielectric (glass) interface following Walter et al. (2007):
// pick a GGX microfacet normal `m` (the shading normal itself when smooth), evaluate the
// exact unpolarised Fresnel reflectance there, then stochastically *reflect* (prob F) or
// *refract* (prob 1−F) about `m` via Snell — total internal reflection falls back to a
// reflection. Selecting the lobe by Fresnel cancels F against the lobe weight, so a smooth
// interface carries throughput 1 (energy-exact: R+T=1); the rough lobe is shadowed by the
// Smith G1 masking term so frosted glass loses energy at grazing rather than gaining it.
// `dispersion` fans the IOR per RGB channel: one hero channel is chosen and reweighted ×3
// so the estimate stays unbiased, which is what bends a prism's beam into a spectrum.
function sampleDielectric(s: Surface, vx: number, vy: number, vz: number, rng: Rng, out: BSDFSample): boolean {
  const mat = s.mat
  const nx = s.nx, ny = s.ny, nz = s.nz // shading normal, already facing the viewer (incident side)
  const rough = mat.roughness
  const a = rough * rough
  const smooth = rough <= SMOOTH_DIELECTRIC

  // wavelength-dependent IOR (dispersion): pick a hero channel, reweight ×3 to stay unbiased
  let tintR = 1, tintG = 1, tintB = 1
  let ior = mat.ior
  if (mat.dispersion > 0) {
    const ch = (rng.next() * 3) | 0
    const c = ch > 2 ? 2 : ch
    ior = cauchyIor(mat.ior, mat.dispersion, c)
    tintR = c === 0 ? 3 : 0; tintG = c === 1 ? 3 : 0; tintB = c === 2 ? 3 : 0
  }
  const etaI = s.frontFace ? 1.0 : ior
  const etaT = s.frontFace ? ior : 1.0

  // microfacet normal m around n (m = n when smooth)
  let mx = nx, my = ny, mz = nz
  if (!smooth) {
    const [t1, t2] = orthonormalBasis([nx, ny, nz])
    const mm = sampleGGX(rng.next(), rng.next(), a)
    const mw = toWorld(mm, t1, t2, [nx, ny, nz])
    mx = mw[0]; my = mw[1]; mz = mw[2]
  }
  let VoH = vx * mx + vy * my + vz * mz
  if (VoH < 0) { mx = -mx; my = -my; mz = -mz; VoH = -VoH }
  if (VoH <= 1e-5) return false

  const F = fresnelDielectric(VoH, etaI, etaT)
  // incident propagation direction I = −V
  const ix = -vx, iy = -vy, iz = -vz
  let wx: number, wy: number, wz: number
  let transmitted: boolean

  if (rng.next() < F) {
    // reflection lobe
    reflect(ix, iy, iz, mx, my, mz, tmpRefract)
    wx = tmpRefract[0]; wy = tmpRefract[1]; wz = tmpRefract[2]
    transmitted = false
  } else {
    // refraction lobe (Snell about m); TIR can't happen here (F would have been 1)
    const eta = etaI / etaT
    if (!refract(ix, iy, iz, mx, my, mz, eta, tmpRefract)) {
      reflect(ix, iy, iz, mx, my, mz, tmpRefract)
      wx = tmpRefract[0]; wy = tmpRefract[1]; wz = tmpRefract[2]
      transmitted = false
    } else {
      wx = tmpRefract[0]; wy = tmpRefract[1]; wz = tmpRefract[2]
      transmitted = true
    }
  }

  // smooth → throughput 1; rough → Smith G1 masking on the outgoing direction (≤ 1)
  const w = smooth ? 1 : smithG1(nx * wx + ny * wy + nz * wz, a)
  out.wx = wx; out.wy = wy; out.wz = wz
  out.wr = tintR * w; out.wg = tintG * w; out.wb = tintB * w
  out.pdf = 0 // Dirac-delta lobe — no density to share with NEE (handled at weight 1)
  out.specular = true // a dielectric bounce is specular (or near it) — counts emitters directly
  out.transmitted = transmitted
  return true
}

// The probability the opaque sampler spends on the specular lobe (vs cosine diffuse). A
// single source of truth shared by `sampleBSDF` (which draws from it) and `bsdfPdf` (which
// must reproduce the exact same mixture density for MIS) — a thin-film coat reflects far
// more than the 0.04 dielectric base, so it pulls the specular lobe up.
function specProb(s: Surface, vx: number, vy: number, vz: number): number {
  const mat = s.mat
  const metallic = mat.metallic
  const diffR = s.br * (1 - metallic), diffG = s.bg * (1 - metallic), diffB = s.bb * (1 - metallic)
  let f0 = 0.04 + (Math.max(s.br, s.bg, s.bb) - 0.04) * metallic
  if (mat.filmLut) {
    const NoV = s.nx * vx + s.ny * vy + s.nz * vz
    sampleFilmLUT(mat.filmLut, NoV, tmpFilm)
    f0 = Math.max(tmpFilm[0], tmpFilm[1], tmpFilm[2])
  }
  const maxDiff = Math.max(diffR, diffG, diffB)
  let pSpec = maxDiff <= 1e-4 ? 1 : f0 / (f0 + maxDiff)
  if (pSpec < 0.15) pSpec = 0.15
  if (pSpec > 0.95) pSpec = 0.95
  return pSpec
}

// Solid-angle pdf of `sampleBSDF` for the opaque BRDF producing direction (wx,wy,wz) — the
// same pSpec·pdfSpec + (1−pSpec)·pdfDiff mixture the sampler draws from. Used by MIS to
// weight a next-event light sample by the chance the BSDF sampler would have found it.
function bsdfPdf(s: Surface, vx: number, vy: number, vz: number, wx: number, wy: number, wz: number): number {
  const nx = s.nx, ny = s.ny, nz = s.nz
  const NoL = nx * wx + ny * wy + nz * wz
  if (NoL <= 0) return 0
  const a = s.mat.roughness * s.mat.roughness
  const pSpec = specProb(s, vx, vy, vz)
  let hx = vx + wx, hy = vy + wy, hz = vz + wz
  const hl = Math.hypot(hx, hy, hz) || 1
  hx /= hl; hy /= hl; hz /= hl
  const NoH = Math.max(0, nx * hx + ny * hy + nz * hz)
  const VoH = Math.max(0, vx * hx + vy * hy + vz * hz)
  const pdfDiff = NoL / PI
  const pdfSpec = VoH > 1e-6 ? (distributionGGX(NoH, a) * NoH) / (4 * VoH) : 0
  return pSpec * pdfSpec + (1 - pSpec) * pdfDiff
}

function sampleBSDF(s: Surface, vx: number, vy: number, vz: number, rng: Rng, f: Float64Array, out: BSDFSample): boolean {
  if (s.mat.transmission > 0) return sampleDielectric(s, vx, vy, vz, rng, out)
  out.transmitted = false
  const mat = s.mat
  const rough = mat.roughness
  const a = rough * rough
  const nx = s.nx, ny = s.ny, nz = s.nz
  const pSpec = specProb(s, vx, vy, vz)

  const [t1, t2] = orthonormalBasis([nx, ny, nz])
  let wx: number, wy: number, wz: number
  const chooseSpec = rng.next() < pSpec
  if (chooseSpec) {
    const m = sampleGGX(rng.next(), rng.next(), a)
    const mw = toWorld(m, t1, t2, [nx, ny, nz])
    // reflect V about the microfacet normal m: wi = 2(V·m)m − V
    const vDotM = vx * mw[0] + vy * mw[1] + vz * mw[2]
    wx = 2 * vDotM * mw[0] - vx
    wy = 2 * vDotM * mw[1] - vy
    wz = 2 * vDotM * mw[2] - vz
  } else {
    const l = cosineHemisphere(rng.next(), rng.next())
    const lw = toWorld(l, t1, t2, [nx, ny, nz])
    wx = lw[0]; wy = lw[1]; wz = lw[2]
  }
  const NoL = nx * wx + ny * wy + nz * wz
  if (NoL <= 0) return false

  // combined pdf (single-sample, balance-style) for the chosen direction
  let hx = vx + wx, hy = vy + wy, hz = vz + wz
  const hl = Math.hypot(hx, hy, hz) || 1
  hx /= hl; hy /= hl; hz /= hl
  const NoH = Math.max(0, nx * hx + ny * hy + nz * hz)
  const VoH = Math.max(0, vx * hx + vy * hy + vz * hz)
  const pdfDiff = NoL / PI
  const pdfSpec = VoH > 1e-6 ? (distributionGGX(NoH, a) * NoH) / (4 * VoH) : 0
  const pdf = pSpec * pdfSpec + (1 - pSpec) * pdfDiff
  if (pdf <= 1e-8) return false

  evalBRDF(f, nx, ny, nz, vx, vy, vz, wx, wy, wz, mat, s.br, s.bg, s.bb)
  const inv = NoL / pdf
  out.wx = wx; out.wy = wy; out.wz = wz
  out.wr = f[0] * inv; out.wg = f[1] * inv; out.wb = f[2] * inv
  out.pdf = pdf // finite density → emitter hits are MIS-weighted against NEE
  out.specular = false // opaque lobes are never Dirac; a near-mirror's huge pdf wins MIS on its own
  return true
}

const tmpHit: ClosestHit = { t: 0, tri: -1, u: 0, v: 0 }
const tmpF = new Float64Array(3)
const tmpSample: BSDFSample = { wx: 0, wy: 0, wz: 0, wr: 0, wg: 0, wb: 0, pdf: 0, specular: false, transmitted: false }
const tmpSpan = { t0: 0, t1: 0 }
const tmpDist: DistanceSample = { scatter: false, t: 0, wr: 1, wg: 1, wb: 1 }
const MAX_PATH = 256 // absolute interaction guard (volume multiple-scattering safety net)

// Estimate radiance along one camera ray with a unidirectional volumetric path
// tracer. Each segment is first tested against the participating medium (if any):
// the ray may *scatter* inside it — turning by the phase function, with in-scattered
// direct light from NEE — or pass through, attenuated by transmittance, to the
// surface (or sky) the segment ends on. Surface interactions are unchanged.
export function tracePath(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  ctx: RTContext, rng: Rng,
): Vec3 {
  let Lr = 0, Lg = 0, Lb = 0
  let br = 1, bg = 1, bb = 1
  let countEmis = true
  // BSDF-sampling density of the bounce that produced the current ray, for MIS against NEE
  // when this ray lands on an emitter. ≤ 0 means "count at weight 1" — the camera ray and
  // Dirac-delta (glass) bounces, which next-event estimation cannot sample.
  let misPdfB = -1
  const m = ctx.medium ?? null
  let surfaceBounces = 0
  // Beer–Lambert absorption of the glass body the ray is currently *inside* (0 = outside).
  let absR = 0, absG = 0, absB = 0
  for (let iter = 0; iter < MAX_PATH; iter++) {
    const hit = ctx.bvh.closest(ox, oy, oz, dx, dy, dz, 1e-4, 1e30, tmpHit)
    const tMax = hit ? tmpHit.t : 1e30

    // attenuate by the absorbing body we are travelling through (this segment's length)
    if ((absR > 0 || absG > 0 || absB > 0) && tMax < 1e29) {
      br *= Math.exp(-absR * tMax); bg *= Math.exp(-absG * tMax); bb *= Math.exp(-absB * tMax)
    }

    // ── participating medium over the open segment [0, tMax] ──────────────────
    let scattered = false
    if (m && raySpan(m, ox, oy, oz, dx, dy, dz, 1e-4, tMax, tmpSpan)) {
      const t0 = tmpSpan.t0, t1 = tmpSpan.t1
      const span = t1 - t0
      if (span > 1e-6) {
        let st = -1
        if (m.heterogeneous) {
          const td = sampleDeltaTracking(m, ox, oy, oz, dx, dy, dz, t0, t1, rng)
          if (td >= 0) { st = td; br *= m.albedo[0]; bg *= m.albedo[1]; bb *= m.albedo[2] }
        } else {
          sampleHomogeneousDistance(m.sigmaT, m.sigmaS, span, rng, tmpDist)
          br *= tmpDist.wr; bg *= tmpDist.wg; bb *= tmpDist.wb // scatter albedo, or transmittance-to-end
          if (tmpDist.scatter) st = t0 + tmpDist.t
        }
        if (st >= 0) {
          const sx = ox + dx * st, sy = oy + dy * st, sz = oz + dz * st
          const dl = mediumDirectLight(sx, sy, sz, dx, dy, dz, ctx, rng)
          Lr += br * dl[0]; Lg += bg * dl[1]; Lb += bb * dl[2]
          const nd = samplePhaseHG(m.g, dx, dy, dz, rng.next(), rng.next())
          ox = sx; oy = sy; oz = sz; dx = nd[0]; dy = nd[1]; dz = nd[2]
          countEmis = false // direct light already counted via NEE
          scattered = true
        }
      }
    }

    if (scattered) {
      // Russian roulette (shared with surface paths): bounds dense/multiple scattering.
      if (iter >= 2) {
        let q = Math.max(br, bg, bb)
        if (q > 0.95) q = 0.95
        if (q < 0.05) q = 0.05
        if (rng.next() >= q) break
        br /= q; bg /= q; bb /= q
      }
      continue
    }

    // ── no scatter: the segment reaches the surface (or the sky) ──────────────
    if (!hit) {
      const sky = ctx.sky(dx, dy, dz)
      Lr += br * sky[0]; Lg += bg * sky[1]; Lb += bb * sky[2]
      break
    }
    const s = surfaceAt(ctx.scene, tmpHit.tri, tmpHit.u, tmpHit.v, dx, dy, dz)
    const vx = -dx, vy = -dy, vz = -dz
    const em = s.mat.emission
    if (countEmis && (em[0] + em[1] + em[2]) > 0) {
      // MIS for the BSDF-sampling strategy: an emitter we reached by BSDF sampling is
      // weighted by how unlikely NEE was to have sampled this same direction. The matching
      // light-side weight lives in directLight; together they sum to 1 (no double count).
      let wMIS = 1
      if (misPdfB > 0 && ctx.scene.totalEmissiveArea > 1e-9) {
        const cosLight = Math.abs(s.gx * dx + s.gy * dy + s.gz * dz)
        if (cosLight > 1e-6) {
          const pdfL = (tmpHit.t * tmpHit.t) / (cosLight * ctx.scene.totalEmissiveArea)
          wMIS = powerHeuristic(misPdfB, pdfL)
        }
      }
      Lr += br * em[0] * wMIS; Lg += bg * em[1] * wMIS; Lb += bb * em[2] * wMIS
    }
    // Next-event estimation only makes sense for the opaque (diffuse+glossy) BRDF; a
    // specular dielectric is lit purely through BSDF sampling + the emitter/sky it ends
    // on, so NEE against it would add a spurious diffuse term and double-count.
    const isGlass = s.mat.transmission > 0
    if (!isGlass) {
      const dl = directLight(s, vx, vy, vz, ctx, rng, tmpF)
      Lr += br * dl[0]; Lg += bg * dl[1]; Lb += bb * dl[2]
    }

    if (surfaceBounces >= ctx.maxBounces) break
    surfaceBounces++
    if (!sampleBSDF(s, vx, vy, vz, rng, tmpF, tmpSample)) break
    br *= tmpSample.wr; bg *= tmpSample.wg; bb *= tmpSample.wb
    // How the next emitter this ray reaches is counted depends on the bounce. A Dirac glass
    // bounce (specular) is weight 1 — NEE cannot sample it. An opaque bounce carries its
    // sampling density for MIS against the emitter's light-sampling pdf; with MIS off it is
    // instead dropped, leaving the emitter to next-event estimation alone (the classic
    // NEE-only estimator the A/B toggle compares against).
    if (tmpSample.specular) { countEmis = true; misPdfB = -1 }
    else if (ctx.mis === false) { countEmis = false }
    else { countEmis = true; misPdfB = tmpSample.pdf }

    // A refraction that crosses the interface flips which body we are inside: entering a
    // glass body (front face) turns on its Beer–Lambert absorption; exiting clears it.
    if (tmpSample.transmitted) {
      if (s.frontFace) {
        absR = s.mat.attenuation[0]; absG = s.mat.attenuation[1]; absB = s.mat.attenuation[2]
      } else {
        absR = 0; absG = 0; absB = 0
      }
    }

    // Russian roulette after a couple of bounces
    if (iter >= 2) {
      let q = Math.max(br, bg, bb)
      if (q > 0.95) q = 0.95
      if (q < 0.05) q = 0.05
      if (rng.next() >= q) break
      br /= q; bg /= q; bb /= q
    }

    // step the ray off the surface along the geometric normal toward the new dir
    const wx = tmpSample.wx, wy = tmpSample.wy, wz = tmpSample.wz
    const side = (s.gx * wx + s.gy * wy + s.gz * wz) >= 0 ? 1 : -1
    ox = s.px + s.gx * EPS * side
    oy = s.py + s.gy * EPS * side
    oz = s.pz + s.gz * EPS * side
    dx = wx; dy = wy; dz = wz
  }
  return [Lr, Lg, Lb]
}

// The primary-hit feature record the denoiser's edge-stopping functions read from:
// world position + shading normal (both facing the camera) and the textured albedo.
// Filled by a single, shading-free primary ray per pixel — cheap, deterministic.
export interface PrimaryFeature {
  hit: boolean
  px: number; py: number; pz: number
  nx: number; ny: number; nz: number
  ar: number; ag: number; ab: number
}

// Trace one primary ray and read the surface it hits (no lighting). Returns the
// G-buffer-style feature the denoiser needs; `hit=false` for a ray that escapes.
export function primaryFeature(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  ctx: RTContext, out: PrimaryFeature,
): void {
  const hit = ctx.bvh.closest(ox, oy, oz, dx, dy, dz, 1e-4, 1e30, tmpHit)
  if (!hit) { out.hit = false; return }
  const s = surfaceAt(ctx.scene, hit.tri, hit.u, hit.v, dx, dy, dz)
  out.hit = true
  out.px = s.px; out.py = s.py; out.pz = s.pz
  out.nx = s.nx; out.ny = s.ny; out.nz = s.nz
  out.ar = s.br; out.ag = s.bg; out.ab = s.bb
}

// Pure ambient occlusion: one cosine-weighted hemisphere ray per call (accumulated
// across frames). Returns white where unoccluded, darkening in creases.
export function traceAO(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  ctx: RTContext, rng: Rng,
): Vec3 {
  const hit = ctx.bvh.closest(ox, oy, oz, dx, dy, dz, 1e-4, 1e30, tmpHit)
  if (!hit) return [1, 1, 1]
  const s = surfaceAt(ctx.scene, hit.tri, hit.u, hit.v, dx, dy, dz)
  const l = cosineHemisphere(rng.next(), rng.next())
  const [t1, t2] = orthonormalBasis([s.nx, s.ny, s.nz])
  const w = toWorld(l, t1, t2, [s.nx, s.ny, s.nz])
  const ogx = s.px + s.gx * EPS, ogy = s.py + s.gy * EPS, ogz = s.pz + s.gz * EPS
  const occ = ctx.bvh.occluded(ogx, ogy, ogz, w[0], w[1], w[2], EPS, ctx.aoRadius)
  const a = occ ? 0.05 : 1
  return [a, a, a]
}
