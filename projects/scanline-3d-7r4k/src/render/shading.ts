// Per-fragment lighting. Two interchangeable models share the same light list,
// shadowing and fog: classic Blinn–Phong, and a metallic-roughness Cook–Torrance
// PBR path (see pbr.ts). Both work in linear colour; the resolve pass tone-maps
// and gamma-encodes on the way to the framebuffer.
import { clamp01 } from '../math/scalar.ts'
import type { Vec3 } from '../math/vec.ts'
import { add, dot, length, normalize, scale, sub } from '../math/vec.ts'
import { shadePBR } from './pbr.ts'
import type { Environment } from './environment.ts'

export interface DirLight {
  type: 'dir'
  direction: Vec3 // direction the light travels
  color: Vec3
  intensity: number
}

export interface PointLight {
  type: 'point'
  position: Vec3
  color: Vec3
  intensity: number
  range: number
}

export type Light = DirLight | PointLight

export type ShadingModel = 'phong' | 'pbr'

export interface Material {
  albedo: Vec3
  specular: number
  shininess: number
  rim: number
  // PBR parameters (used by the metallic-roughness path; ignored by Phong).
  metallic?: number // 0 = dielectric, 1 = metal
  roughness?: number // 0 = mirror, 1 = fully rough
  emission?: Vec3 // linear radiance this surface emits (drives the path-traced lights)
  // Dielectric transmission (v8) — drives the path tracer's rough-dielectric BSDF and
  // the rasterizer's order-independent transparency. > 0 makes the surface glass.
  transmission?: number // 0 = opaque, 1 = fully transmissive (refracting)
  ior?: number // index of refraction (1.0 = air, ~1.5 = glass, ~2.4 = diamond)
  attenuation?: Vec3 // Beer–Lambert absorption per world-unit *inside* the body (tint)
  dispersion?: number // 0 = achromatic; > 0 fans the IOR by wavelength (prism rainbow)
  // Thin-film interference (v9) — a dielectric coating of `filmThicknessNm` nanometres and
  // index `filmIor` over this surface. When the thickness is > 0 its spectral interference
  // reflectance (see raytrace/thinfilm.ts) replaces the microfacet Fresnel term, giving the
  // structural ("iridescent") colour of soap films, oil sheens and anodised metals. The
  // substrate index is taken from `ior` (default 1.5). Shared by the path tracer and pbr.ts.
  filmThicknessNm?: number // 0 = no coat; ~100–800 nm spans the visible interference orders
  filmIor?: number // film index of refraction (soap ≈ 1.33, oil ≈ 1.45, TiO₂ ≈ 2.3)
}

export interface ShadowSampler {
  sample: (worldPos: Vec3, ndl: number) => number
  lightIndex: number
}

export interface ShadeContext {
  lights: Light[]
  ambient: Vec3
  eye: Vec3
  fogColor: Vec3
  fogDensity: number
  shadow?: ShadowSampler
  model: ShadingModel
  environment?: Environment // image-based lighting (drives PBR ambient + reflections)
}

// The pre-fog decomposition of a shaded fragment into the three terms the deferred
// screen-space passes modulate independently: `direct` (punctual lights — contact
// shadows darken it), `ambient` (diffuse IBL — SSAO darkens it) and `spec` (the
// specular-IBL probe — SSR replaces it). Emission is intentionally excluded so the
// screen-space passes never touch self-lit surfaces.
export interface ShadeComponents {
  direct: Vec3
  ambient: Vec3
  spec: Vec3
}

export const emptyComponents = (): ShadeComponents => ({ direct: [0, 0, 0], ambient: [0, 0, 0], spec: [0, 0, 0] })

// Dispatch to the active lighting model. `base` is the albedo after texture
// modulation; `n` is the (possibly normal-mapped) shading normal. When `out` is
// passed it is filled with the pre-fog direct/ambient/spec decomposition.
export function shadeSurface(
  base: Vec3,
  worldPos: Vec3,
  n: Vec3,
  mat: Material,
  ctx: ShadeContext,
  out?: ShadeComponents,
): Vec3 {
  return ctx.model === 'pbr'
    ? shadePBR(base, worldPos, n, mat, ctx, out)
    : shadeFragment(base, worldPos, n, mat, ctx, out)
}

// Apply distance fog to an already-shaded linear colour. Shared by both models.
export function applyFog(c: Vec3, worldPos: Vec3, ctx: ShadeContext): Vec3 {
  if (ctx.fogDensity <= 0) return c
  const dist = length(sub(worldPos, ctx.eye))
  const f = clamp01(1 - Math.exp(-dist * ctx.fogDensity))
  return [
    c[0] + (ctx.fogColor[0] - c[0]) * f,
    c[1] + (ctx.fogColor[1] - c[1]) * f,
    c[2] + (ctx.fogColor[2] - c[2]) * f,
  ]
}

// `worldPos` and `n` (already normalized) are the fragment's world position and
// normal; `base` is the albedo after texture modulation.
export function shadeFragment(
  base: Vec3,
  worldPos: Vec3,
  n: Vec3,
  mat: Material,
  ctx: ShadeContext,
  out?: ShadeComponents,
): Vec3 {
  const viewDir = normalize(sub(ctx.eye, worldPos))
  // ambient: image-based irradiance when an environment is present, else flat
  let ar = ctx.ambient[0], ag = ctx.ambient[1], ab = ctx.ambient[2]
  if (ctx.environment) {
    const irr = ctx.environment.irradiance(n)
    const k = ctx.environment.intensity
    ar = irr[0] * k; ag = irr[1] * k; ab = irr[2] * k
  }
  const ambR = base[0] * ar, ambG = base[1] * ag, ambB = base[2] * ab
  // r,g,b accumulate the *direct* (punctual) lighting only; ambient is tracked apart
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
      // smooth inverse-square-ish falloff clamped by range
      const f = clamp01(1 - (d * d) / (light.range * light.range))
      atten = f * f
      radiance = scale(light.color, light.intensity)
    }

    const ndl = Math.max(0, dot(n, L))
    if (ndl <= 0) continue

    // shadowing only applies to the designated shadow-casting light
    const shadow = ctx.shadow && ctx.shadow.lightIndex === li ? ctx.shadow.sample(worldPos, ndl) : 1

    // diffuse
    const diff = ndl * atten * shadow
    r += base[0] * radiance[0] * diff
    g += base[1] * radiance[1] * diff
    b += base[2] * radiance[2] * diff

    // Blinn–Phong specular
    if (mat.specular > 0 && ndl > 0) {
      const half = normalize(add(L, viewDir))
      const ndh = Math.max(0, dot(n, half))
      const spec = Math.pow(ndh, mat.shininess) * mat.specular * atten * shadow
      r += radiance[0] * spec
      g += radiance[1] * spec
      b += radiance[2] * spec
    }
  }

  // rim / fresnel-ish edge light (counts as direct)
  if (mat.rim > 0) {
    const fres = Math.pow(1 - clamp01(dot(n, viewDir)), 3) * mat.rim
    r += fres
    g += fres
    b += fres
  }

  if (out) {
    out.direct = [r, g, b]
    out.ambient = [ambR, ambG, ambB]
    out.spec = [0, 0, 0] // Blinn–Phong has no separate image-based specular term
  }

  r += ambR
  g += ambG
  b += ambB

  if (mat.emission) {
    r += mat.emission[0]
    g += mat.emission[1]
    b += mat.emission[2]
  }

  return applyFog([r, g, b], worldPos, ctx)
}

export const gammaEncode = (c: Vec3): Vec3 => [
  Math.pow(clamp01(c[0]), 1 / 2.2),
  Math.pow(clamp01(c[1]), 1 / 2.2),
  Math.pow(clamp01(c[2]), 1 / 2.2),
]
