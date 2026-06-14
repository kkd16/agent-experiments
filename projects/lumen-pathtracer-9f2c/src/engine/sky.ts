// sky.ts — an analytic physically based daylight model (Preetham et al. 1999),
// the "A Practical Analytic Model for Daylight" that most offline renderers ship
// as their default sky. It gives the radiance of a clear-to-hazy atmosphere for
// any view direction as a closed form of two inputs: the sun's position and the
// turbidity (how much haze/aerosol is in the air — 2 ≈ a crisp alpine sky, 10 ≈
// a muggy summer haze).
//
// The model has two pieces:
//   • the Perez luminance distribution F(θ,γ) — a five-parameter function of the
//     view zenith angle θ and the angle γ between the view ray and the sun, whose
//     coefficients are linear in turbidity; and
//   • absolute zenith values (luminance Yz and chromaticity x_z, y_z) fit to the
//     sun's elevation and turbidity.
// The sky colour at a direction is Yz·F(θ,γ)/F(0,θs) in luminance and the
// analogous ratios in chromaticity, assembled in the CIE xyY space and converted
// to linear RGB. We add an explicit solar disc on top so the sun itself is a hard,
// bright source the path tracer can importance-sample (see scene.ts).

import type { Vec3 } from './vec3'
import { dot, normalize, v } from './vec3'

export interface SkyDef {
  sunDir: Vec3 // unit; points from the scene *toward* the sun
  turbidity: number // 1.7 (clear) … 10 (hazy)
  intensity: number // overall radiance scale for the sky dome
  sunSize?: number // angular radius of the solar disc (radians)
  sunIntensity?: number // radiance scale of the disc relative to the sky
  ground?: Vec3 // radiance for rays pointing below the horizon
}

// Perez coefficients A…E are affine in turbidity T, one row per xyY channel.
function perezCoeffs(T: number): { Y: number[]; x: number[]; y: number[] } {
  return {
    Y: [
      0.1787 * T - 1.463,
      -0.3554 * T + 0.4275,
      -0.0227 * T + 5.3251,
      0.1206 * T - 2.5771,
      -0.067 * T + 0.3703,
    ],
    x: [
      -0.0193 * T - 0.2592,
      -0.0665 * T + 0.0008,
      -0.0004 * T + 0.2125,
      -0.0641 * T - 0.8989,
      -0.0033 * T + 0.0452,
    ],
    y: [
      -0.0167 * T - 0.2608,
      -0.095 * T + 0.0092,
      -0.0079 * T + 0.2102,
      -0.0441 * T - 1.6537,
      -0.0109 * T + 0.0529,
    ],
  }
}

// F(θ,γ) = (1 + A·e^{B/cosθ})·(1 + C·e^{D·γ} + E·cos²γ). cosTheta is clamped a
// little above zero so the horizon term stays finite.
function perez(c: number[], cosTheta: number, cosGamma: number, gamma: number): number {
  const ct = Math.max(cosTheta, 0.01)
  return (1 + c[0] * Math.exp(c[1] / ct)) * (1 + c[2] * Math.exp(c[3] * gamma) + c[4] * cosGamma * cosGamma)
}

// Zenith chromaticity polynomials (Preetham eqs. for x_z, y_z) in the sun's
// zenith angle θs and turbidity T.
function zenithChroma(thetaS: number, T: number): { xz: number; yz: number } {
  const ts = thetaS
  const ts2 = ts * ts
  const ts3 = ts2 * ts
  const T2 = T * T
  const xz =
    T2 * (0.00166 * ts3 - 0.00375 * ts2 + 0.00209 * ts) +
    T * (-0.02903 * ts3 + 0.06377 * ts2 - 0.03202 * ts + 0.00394) +
    (0.11693 * ts3 - 0.21196 * ts2 + 0.06052 * ts + 0.25886)
  const yz =
    T2 * (0.00275 * ts3 - 0.0061 * ts2 + 0.00317 * ts) +
    T * (-0.04214 * ts3 + 0.0897 * ts2 - 0.04153 * ts + 0.00516) +
    (0.15346 * ts3 - 0.26756 * ts2 + 0.0667 * ts + 0.26688)
  return { xz, yz }
}

// CIE xyY → linear sRGB. Y is treated as the (relative) luminance.
function xyYToRGB(x: number, y: number, Y: number): Vec3 {
  if (y <= 1e-5) return v(0, 0, 0)
  const X = (x / y) * Y
  const Z = ((1 - x - y) / y) * Y
  // CIE XYZ (D65) → linear sRGB.
  const r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z
  const g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z
  const b = 0.0557 * X - 0.204 * Y + 1.057 * Z
  return v(Math.max(0, r), Math.max(0, g), Math.max(0, b))
}

// Precompute everything that depends only on the sun + turbidity, so the per-ray
// `skyRadiance` is just two Perez evaluations and a colour convert.
export interface SkyState {
  def: Required<Omit<SkyDef, 'ground'>> & { ground: Vec3 }
  coeffs: ReturnType<typeof perezCoeffs>
  thetaS: number
  cosThetaS: number
  Yz: number
  xz: number
  yz: number
  denomY: number
  denomx: number
  denomy: number
  sunRadiance: Vec3 // radiance of the solar disc
  cosSunSize: number
}

export function makeSky(def: SkyDef): SkyState {
  const sunDir = normalize(def.sunDir)
  const turbidity = Math.max(1.7, def.turbidity)
  const intensity = def.intensity
  const sunSize = def.sunSize ?? 0.035
  const sunIntensity = def.sunIntensity ?? 22
  const ground = def.ground ?? v(0.12, 0.1, 0.085)
  const cosThetaS = Math.max(-1, Math.min(1, sunDir.y))
  const thetaS = Math.acos(Math.max(0, cosThetaS)) // sun zenith angle (0 = overhead)
  const coeffs = perezCoeffs(turbidity)
  // Absolute zenith luminance (Preetham, kcd/m²) and chromaticity.
  const chi = (4 / 9 - turbidity / 120) * (Math.PI - 2 * thetaS)
  const Yz = (4.0453 * turbidity - 4.971) * Math.tan(chi) - 0.2155 * turbidity + 2.4192
  const { xz, yz } = zenithChroma(thetaS, turbidity)
  // F(0, θs): the zenith reference each ratio is normalised by (γ=θs at zenith).
  const denomY = perez(coeffs.Y, 1, cosThetaS, thetaS)
  const denomx = perez(coeffs.x, 1, cosThetaS, thetaS)
  const denomy = perez(coeffs.y, 1, cosThetaS, thetaS)
  // The solar disc's radiance: scale the zenith luminance by the (warm) sun colour.
  const sunRadiance = {
    x: intensity * sunIntensity * Math.max(0, Yz) * 1.0,
    y: intensity * sunIntensity * Math.max(0, Yz) * 0.95,
    z: intensity * sunIntensity * Math.max(0, Yz) * 0.85,
  }
  return {
    def: { sunDir, turbidity, intensity, sunSize, sunIntensity, ground },
    coeffs,
    thetaS,
    cosThetaS,
    Yz: Math.max(0, Yz),
    xz,
    yz,
    denomY,
    denomx,
    denomy,
    sunRadiance,
    cosSunSize: Math.cos(sunSize),
  }
}

// Radiance of the sky dome for a unit direction `dir`. `withSun` adds the solar
// disc; the NEE light sampler turns it off so the disc is only counted once.
export function skyRadiance(s: SkyState, dir: Vec3, withSun = true): Vec3 {
  if (dir.y <= 0) return s.def.ground
  const cosTheta = Math.max(dir.y, 1e-3)
  const cosGamma = Math.max(-1, Math.min(1, dot(dir, s.def.sunDir)))
  const gamma = Math.acos(cosGamma)
  const fY = perez(s.coeffs.Y, cosTheta, cosGamma, gamma)
  const fx = perez(s.coeffs.x, cosTheta, cosGamma, gamma)
  const fy = perez(s.coeffs.y, cosTheta, cosGamma, gamma)
  const Y = s.Yz * (fY / s.denomY)
  const x = s.xz * (fx / s.denomx)
  const y = s.yz * (fy / s.denomy)
  // The 0.06 brings the model's kcd/m² zenith into a renderer-friendly range.
  let col = xyYToRGB(x, y, Math.max(0, Y) * s.def.intensity * 0.06)
  if (withSun && cosGamma >= s.cosSunSize) {
    col = { x: col.x + s.sunRadiance.x, y: col.y + s.sunRadiance.y, z: col.z + s.sunRadiance.z }
  }
  return col
}
