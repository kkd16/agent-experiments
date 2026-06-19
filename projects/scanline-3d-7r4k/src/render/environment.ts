// A fully analytic HDR environment. There is no loaded image: `sky(dir)` returns
// the radiance seen looking along a unit direction, built from a three-band
// gradient (ground → horizon → zenith) plus a sharp sun disk. The same function
// is reused three ways by the shader: as the literal skybox behind the geometry,
// as the diffuse irradiance that lights surfaces ambiently, and as the
// roughness-blurred specular reflection that gives metals their mirror.
import { clamp01 } from '../math/scalar.ts'
import type { Vec3 } from '../math/vec.ts'
import { dot, lerp3, normalize, scale } from '../math/vec.ts'

export interface Environment {
  // HDR radiance along a (normalized) world direction.
  sky: (dir: Vec3) => Vec3
  // Cosine-ish diffuse irradiance arriving at a surface with normal n.
  irradiance: (n: Vec3) => Vec3
  // Pre-filtered specular probe along a reflection vector, blurred by roughness.
  specular: (dir: Vec3, roughness: number) => Vec3
  intensity: number
}

export interface SkyParams {
  zenith: Vec3
  horizon: Vec3
  ground: Vec3
  sunDir: Vec3 // direction *toward* the sun (normalized)
  sunColor: Vec3
  sunIntensity: number
  sunAngularSize: number // smaller = sharper disk
  intensity: number
}

export const DEFAULT_SKY: SkyParams = {
  zenith: [0.18, 0.32, 0.62],
  horizon: [0.62, 0.72, 0.82],
  ground: [0.12, 0.11, 0.1],
  sunDir: normalize([0.5, 0.85, 0.4]),
  sunColor: [1.0, 0.92, 0.78],
  sunIntensity: 9,
  sunAngularSize: 0.024,
  intensity: 1,
}

// Build an environment from sky parameters. The diffuse/specular probes are
// cheap analytic approximations rather than a true convolution: irradiance
// softens the directional sky toward its hemispheric average, and the specular
// probe lerps from a crisp sky lookup (mirror) to that irradiance (rough).
export function makeEnvironment(p: SkyParams): Environment {
  const sunDir = normalize(p.sunDir)
  // cos threshold for the sun disk and a soft falloff band around it
  const cosInner = Math.cos(p.sunAngularSize)
  const cosOuter = Math.cos(p.sunAngularSize * 3)

  const skyGradient = (dir: Vec3): Vec3 => {
    const y = dir[1]
    if (y >= 0) {
      // horizon → zenith, biased so most of the dome reads as sky
      const t = Math.pow(clamp01(y), 0.45)
      return lerp3(p.horizon, p.zenith, t)
    }
    // horizon → ground below
    const t = Math.pow(clamp01(-y), 0.5)
    return lerp3(p.horizon, p.ground, t)
  }

  const sky = (dir: Vec3): Vec3 => {
    const base = skyGradient(dir)
    const c = dot(dir, sunDir)
    if (c <= cosOuter) return base
    // smooth core→halo, plus a tight bright core
    const halo = (c - cosOuter) / (cosInner - cosOuter)
    const h = clamp01(halo)
    const disk = c >= cosInner ? 1 : h * h
    const glow = disk * p.sunIntensity
    return [
      base[0] + p.sunColor[0] * glow,
      base[1] + p.sunColor[1] * glow,
      base[2] + p.sunColor[2] * glow,
    ]
  }

  // Hemispheric average of the dome, used to soften the diffuse probe. A coarse
  // fixed-direction sample is plenty for an ambient term.
  const AVG_DIRS: Vec3[] = [
    [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
    normalize([1, 1, 1]), normalize([-1, 1, -1]), normalize([1, 1, -1]), normalize([-1, 1, 1]),
  ]
  let avg: Vec3 = [0, 0, 0]
  for (const d of AVG_DIRS) avg = [avg[0] + skyGradient(d)[0], avg[1] + skyGradient(d)[1], avg[2] + skyGradient(d)[2]]
  avg = scale(avg, 1 / AVG_DIRS.length)
  // a soft sun contribution to ambient so shadowed-but-skylit areas warm up
  const sunAmbient = scale(p.sunColor, p.sunIntensity * 0.06)

  const irradiance = (n: Vec3): Vec3 => {
    const tinted = skyGradient(n)
    const ndl = Math.max(0, dot(n, sunDir))
    return [
      (tinted[0] * 0.55 + avg[0] * 0.45) + sunAmbient[0] * ndl,
      (tinted[1] * 0.55 + avg[1] * 0.45) + sunAmbient[1] * ndl,
      (tinted[2] * 0.55 + avg[2] * 0.45) + sunAmbient[2] * ndl,
    ]
  }

  const specular = (dir: Vec3, roughness: number): Vec3 => {
    const mirror = sky(dir)
    const blurred = irradiance(dir)
    const t = clamp01(roughness)
    return lerp3(mirror, blurred, t * t)
  }

  return { sky, irradiance, specular, intensity: p.intensity }
}
