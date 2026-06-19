// Per-fragment lighting: Blinn–Phong with any number of directional and point
// lights, an ambient term, optional rim light and distance fog. Works in a
// roughly linear colour space; the renderer gamma-encodes on write.
import { clamp01 } from '../math/scalar.ts'
import type { Vec3 } from '../math/vec.ts'
import { add, dot, length, normalize, scale, sub } from '../math/vec.ts'

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

export interface Material {
  albedo: Vec3
  specular: number
  shininess: number
  rim: number
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
}

// `worldPos` and `n` (already normalized) are the fragment's world position and
// normal; `base` is the albedo after texture modulation.
export function shadeFragment(
  base: Vec3,
  worldPos: Vec3,
  n: Vec3,
  mat: Material,
  ctx: ShadeContext,
): Vec3 {
  const viewDir = normalize(sub(ctx.eye, worldPos))
  let r = base[0] * ctx.ambient[0]
  let g = base[1] * ctx.ambient[1]
  let b = base[2] * ctx.ambient[2]

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

  // rim / fresnel-ish edge light
  if (mat.rim > 0) {
    const fres = Math.pow(1 - clamp01(dot(n, viewDir)), 3) * mat.rim
    r += fres
    g += fres
    b += fres
  }

  // exponential distance fog
  if (ctx.fogDensity > 0) {
    const dist = length(sub(worldPos, ctx.eye))
    const f = clamp01(1 - Math.exp(-dist * ctx.fogDensity))
    r = r + (ctx.fogColor[0] - r) * f
    g = g + (ctx.fogColor[1] - g) * f
    b = b + (ctx.fogColor[2] - b) * f
  }

  return [r, g, b]
}

export const gammaEncode = (c: Vec3): Vec3 => [
  Math.pow(clamp01(c[0]), 1 / 2.2),
  Math.pow(clamp01(c[1]), 1 / 2.2),
  Math.pow(clamp01(c[2]), 1 / 2.2),
]
