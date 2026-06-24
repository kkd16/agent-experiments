// Metallic-roughness physically based shading: a Cook–Torrance microfacet BRDF
// evaluated per fragment for every punctual light, plus an image-based-lighting
// ambient term (diffuse irradiance + a roughness-blurred specular probe) when an
// environment is present. Everything is in linear colour; the resolve pass owns
// tone mapping and gamma.
//
//   f = kd·albedo/π  +  D·G·F / (4·NoV·NoL)
//
// with D = GGX/Trowbridge–Reitz, G = Smith height-correlated, F = Fresnel–Schlick.
import { clamp01 } from '../math/scalar.ts'
import type { Vec3 } from '../math/vec.ts'
import { add, dot, length, normalize, reflect, scale, sub } from '../math/vec.ts'
import type { ShadeComponents, ShadeContext, Material } from './shading.ts'
import { applyFog } from './shading.ts'
import { getFilmLUT, sampleFilmLUT } from '../raytrace/thinfilm.ts'
import type { FilmLUT } from '../raytrace/thinfilm.ts'

const PI = Math.PI
const DIELECTRIC_F0 = 0.04
const tmpFilm = new Float64Array(3)

// Microfacet Fresnel at cosine `c`: the thin-film interference reflectance when a coat is
// present (its grazing limit is already 1, so Schlick is not layered on), else Schlick.
function microFresnel(c: number, f0: Vec3, film: FilmLUT | null): Vec3 {
  if (film) {
    sampleFilmLUT(film, c, tmpFilm)
    return [tmpFilm[0], tmpFilm[1], tmpFilm[2]]
  }
  return fresnel(c, f0)
}

// GGX normal distribution.
function distributionGGX(noh: number, a: number): number {
  const a2 = a * a
  const d = noh * noh * (a2 - 1) + 1
  return a2 / (PI * d * d + 1e-7)
}

// Smith height-correlated visibility (already folded the 1/(4·NoV·NoL)).
function visibilitySmith(nov: number, nol: number, a: number): number {
  const a2 = a * a
  const ggxV = nol * Math.sqrt(nov * nov * (1 - a2) + a2)
  const ggxL = nov * Math.sqrt(nol * nol * (1 - a2) + a2)
  return 0.5 / (ggxV + ggxL + 1e-7)
}

// Fresnel–Schlick, vectorised over the F0 triple.
function fresnel(cosTheta: number, f0: Vec3): Vec3 {
  const f = Math.pow(clamp01(1 - cosTheta), 5)
  return [f0[0] + (1 - f0[0]) * f, f0[1] + (1 - f0[1]) * f, f0[2] + (1 - f0[2]) * f]
}

// Roughness-aware Fresnel for the ambient/IBL specular term (Karis).
function fresnelRoughness(cosTheta: number, f0: Vec3, rough: number): Vec3 {
  const f = Math.pow(clamp01(1 - cosTheta), 5)
  const m = Math.max(1 - rough, f0[0])
  const my = Math.max(1 - rough, f0[1])
  const mz = Math.max(1 - rough, f0[2])
  return [f0[0] + (m - f0[0]) * f, f0[1] + (my - f0[1]) * f, f0[2] + (mz - f0[2]) * f]
}

// `out`, when supplied, receives the *pre-fog* decomposition of the radiance into
// its direct, diffuse-IBL (ambient) and specular-IBL parts — the deferred G-buffer
// and the screen-space passes (SSAO darkens `ambient`, SSR replaces `spec`, contact
// shadows darken `direct`) all read it, so there is a single source of truth.
export function shadePBR(
  base: Vec3,
  worldPos: Vec3,
  n: Vec3,
  mat: Material,
  ctx: ShadeContext,
  out?: ShadeComponents,
): Vec3 {
  const metallic = clamp01(mat.metallic ?? 0)
  // clamp roughness away from 0 so the specular lobe stays finite
  const rough = Math.min(1, Math.max(0.04, mat.roughness ?? 0.5))
  const a = rough * rough

  const V = normalize(sub(ctx.eye, worldPos))
  const nov = Math.max(1e-4, dot(n, V))

  // dielectrics reflect a flat 4%; metals tint their specular by the albedo
  const f0: Vec3 = [
    DIELECTRIC_F0 + (base[0] - DIELECTRIC_F0) * metallic,
    DIELECTRIC_F0 + (base[1] - DIELECTRIC_F0) * metallic,
    DIELECTRIC_F0 + (base[2] - DIELECTRIC_F0) * metallic,
  ]
  const diffuseColor: Vec3 = [base[0] * (1 - metallic), base[1] * (1 - metallic), base[2] * (1 - metallic)]

  // thin-film coat (v9): its baked reflectance LUT replaces the microfacet Fresnel below.
  const film: FilmLUT | null = (mat.filmThicknessNm ?? 0) > 0
    ? getFilmLUT(mat.filmThicknessNm as number, mat.filmIor ?? 1.33, mat.ior ?? 1.5)
    : null

  let r = 0
  let g = 0
  let b = 0

  for (let li = 0; li < ctx.lights.length; li++) {
    const light = ctx.lights[li]
    let L: Vec3
    let atten = 1
    let radiance: Vec3
    if (light.type === 'dir') {
      L = normalize(scale(light.direction, -1))
      radiance = scale(light.color, light.intensity)
    } else {
      const toLight = sub(light.position, worldPos)
      const d = length(toLight)
      L = d > 1e-6 ? scale(toLight, 1 / d) : [0, 1, 0]
      const f = clamp01(1 - (d * d) / (light.range * light.range))
      atten = f * f
      radiance = scale(light.color, light.intensity)
    }

    const nol = dot(n, L)
    if (nol <= 0 || atten <= 0) continue

    const shadow = ctx.shadow && ctx.shadow.lightIndex === li ? ctx.shadow.sample(worldPos, nol) : 1
    if (shadow <= 0) continue

    const H = normalize(add(L, V))
    const noh = Math.max(0, dot(n, H))
    const voh = Math.max(0, dot(V, H))

    const D = distributionGGX(noh, a)
    const Vis = visibilitySmith(nov, nol, a)
    const F = microFresnel(voh, f0, film)

    // specular = D·Vis·F  (Vis already carries 1/(4·NoV·NoL))
    const specR = D * Vis * F[0]
    const specG = D * Vis * F[1]
    const specB = D * Vis * F[2]

    // energy left for diffuse after the Fresnel reflection (metals: none)
    const kdR = (1 - F[0]) * (1 - metallic)
    const kdG = (1 - F[1]) * (1 - metallic)
    const kdB = (1 - F[2]) * (1 - metallic)

    const w = nol * atten * shadow
    r += (kdR * diffuseColor[0] / PI + specR) * radiance[0] * w
    g += (kdG * diffuseColor[1] / PI + specG) * radiance[1] * w
    b += (kdB * diffuseColor[2] / PI + specB) * radiance[2] * w
  }

  // r,g,b now hold the *direct* lighting; the indirect terms accumulate separately
  // so the screen-space passes can isolate them.
  let adr: number, adg: number, adb: number // diffuse IBL (ambient) — set in both branches
  let asr = 0, asg = 0, asb = 0 // specular IBL (probe reflection) — only when an env is present

  // ── ambient: image-based lighting if available, else a flat ambient term ──
  if (ctx.environment) {
    const env = ctx.environment
    // film coat tints the IBL reflection by its structural colour at the view angle
    const ks = film ? microFresnel(nov, f0, film) : fresnelRoughness(nov, f0, rough)
    const irr = env.irradiance(n)
    // diffuse IBL
    const kdR = (1 - ks[0]) * (1 - metallic)
    const kdG = (1 - ks[1]) * (1 - metallic)
    const kdB = (1 - ks[2]) * (1 - metallic)
    adr = irr[0] * diffuseColor[0] * kdR * env.intensity
    adg = irr[1] * diffuseColor[1] * kdG * env.intensity
    adb = irr[2] * diffuseColor[2] * kdB * env.intensity
    // specular IBL: reflect the view vector, sample the roughness-blurred probe.
    // A cheap analytic BRDF-LUT fit scales the probe by the Fresnel reflectance.
    const refl = reflect(scale(V, -1), n)
    const probe = env.specular(refl, rough)
    const ab = 1 - rough // crude environment-BRDF bias term
    asr = probe[0] * (ks[0] * ab + 0.04 * (1 - ab)) * env.intensity
    asg = probe[1] * (ks[1] * ab + 0.04 * (1 - ab)) * env.intensity
    asb = probe[2] * (ks[2] * ab + 0.04 * (1 - ab)) * env.intensity
  } else {
    adr = diffuseColor[0] * ctx.ambient[0]
    adg = diffuseColor[1] * ctx.ambient[1]
    adb = diffuseColor[2] * ctx.ambient[2]
  }

  if (out) {
    out.direct = [r, g, b]
    out.ambient = [adr, adg, adb]
    out.spec = [asr, asg, asb]
  }

  r += adr + asr
  g += adg + asg
  b += adb + asb

  if (mat.emission) {
    r += mat.emission[0]
    g += mat.emission[1]
    b += mat.emission[2]
  }

  return applyFog([r, g, b], worldPos, ctx)
}
