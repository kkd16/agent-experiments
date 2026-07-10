import type { Params, Preset } from './types'

export const DEFAULT_PARAMS: Params = {
  cameraDistance: 14,
  inclination: 9,
  azimuth: 0,
  fov: 55,
  freeFall: false,

  spin: 0.0,
  ergosphere: false,
  iscoTrack: false,

  diskInner: 3.0,
  diskOuter: 12.0,
  diskBrightness: 1.3,
  diskTemperature: 1.0,
  diskDensity: 1.0,
  volumetric: false,
  diskThickness: 0.4,

  steps: 320,
  stepSize: 0.14,

  doppler: true,
  redshift: true,

  starBrightness: 1.0,
  exposure: 1.0,

  ringHighlight: false,

  bloom: true,
  bloomStrength: 0.55,
  bloomThreshold: 1.1,

  renderScale: 1.0,
  adaptiveQuality: true,
  autoRotate: true,
}

// Physical constants in our rs = 1 unit system.
export const RS = 1.0
export const M = 0.5 // rs / 2
export const PHOTON_SPHERE = 1.5 // 1.5 rs
export const ISCO = 3.0 // 6M = 3 rs
export const B_CRIT = 3 * Math.sqrt(3) * M // ≈ 2.598, critical impact parameter

// --- Kerr helpers ----------------------------------------------------------
// `spin` throughout the app is the dimensionless a* = a/M ∈ [0, 1). The physical spin in our
// units is a = spin · M. These formulas are the textbook Kerr results, evaluated in rs units.

/** Radius of the outer event horizon r₊ = M + √(M² − a²), in rs units. */
export function kerrHorizon(spin: number): number {
  const s = Math.min(Math.abs(spin), 0.99999)
  return M * (1 + Math.sqrt(1 - s * s))
}

/** Radius of the ergosphere (static limit) at polar angle θ, in rs units. */
export function kerrErgosphere(spin: number, theta: number): number {
  const s = Math.min(Math.abs(spin), 0.99999)
  const c = Math.cos(theta)
  return M * (1 + Math.sqrt(Math.max(1 - s * s * c * c, 0)))
}

/**
 * Prograde ISCO radius for spin a* (Bardeen–Press–Teukolsky), in rs units.
 * 6M at a*=0, marching down toward M as a*→1.
 */
export function kerrISCO(spin: number): number {
  const a = Math.min(Math.max(spin, 0), 0.99999) // a* = a/M
  const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a))
  const z2 = Math.sqrt(3 * a * a + z1 * z1)
  const rIscoOverM = 3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2)) // prograde branch
  return rIscoOverM * M
}

/** The disk inner radius actually used for a render — snaps to the ISCO when tracking is on. */
export function effectiveDiskInner(p: Params): number {
  if (!p.iscoTrack) return p.diskInner
  return Math.max(kerrISCO(p.spin), kerrHorizon(p.spin) + 0.05)
}

/** Prograde equatorial orbital angular velocity Ω (coordinate) at radius r, in rs units. */
export function kerrOmega(spin: number, r: number): number {
  const a = spin * M
  return Math.sqrt(M) / (Math.pow(r, 1.5) + a * Math.sqrt(M))
}

/**
 * Radius of an equatorial *circular photon orbit* for spin a* (Bardeen), in rs units.
 * The closed form r/M = 2·[1 + cos(⅔·arccos(∓a*))] gives the prograde (−, tighter) and
 * retrograde (+, wider) light rings; both collapse to the 1.5 rs photon sphere at a* = 0.
 */
export function kerrPhotonOrbit(spin: number, prograde: boolean): number {
  const aStar = Math.min(Math.max(spin, 0), 0.99999)
  const sign = prograde ? -1 : 1
  const rOverM = 2 * (1 + Math.cos((2 / 3) * Math.acos(sign * aStar)))
  return rOverM * M
}

export const PRESETS: Preset[] = [
  {
    name: 'Cinematic',
    blurb: 'A gentle three-quarter view — the classic hero shot.',
    params: { cameraDistance: 14, inclination: 9, fov: 55, diskInner: 3, diskOuter: 12, diskBrightness: 1.5 },
  },
  {
    name: 'Edge-On',
    blurb: 'Camera in the disk plane. The far side of the disk arches over the top from lensing.',
    params: { cameraDistance: 16, inclination: 1.5, fov: 48, diskInner: 3, diskOuter: 13, diskBrightness: 1.7 },
  },
  {
    name: 'Top-Down',
    blurb: 'Looking straight down the axis — a clean ring with the shadow dead centre.',
    params: { cameraDistance: 18, inclination: 88, fov: 42, diskInner: 3, diskOuter: 14, diskBrightness: 1.3 },
  },
  {
    name: 'Photon Ring',
    blurb: 'Close and bright, tuned to show the thin photon ring hugging the shadow.',
    params: { cameraDistance: 9, inclination: 12, fov: 62, diskInner: 3, diskOuter: 9, diskBrightness: 2.2, exposure: 1.2 },
  },
  {
    name: 'Interstellar',
    blurb: 'Nearly edge-on, hot and huge — the look most people picture.',
    params: { cameraDistance: 20, inclination: 4, fov: 50, diskInner: 3, diskOuter: 16, diskBrightness: 1.9, diskTemperature: 1.15, spin: 0 },
  },
  {
    name: 'Maximal Spin',
    blurb: 'Near-extremal Kerr (a/M = 0.98). The shadow flattens on the prograde side and the ISCO plunges inward.',
    params: { spin: 0.98, iscoTrack: true, cameraDistance: 12, inclination: 12, fov: 58, diskOuter: 12, diskBrightness: 1.9, exposure: 1.15 },
  },
  {
    name: 'Frame Dragging',
    blurb: 'Edge-on and fast-spinning — watch the whole image shear as spacetime is dragged around the hole.',
    params: { spin: 0.9, iscoTrack: true, cameraDistance: 15, inclination: 3, fov: 50, diskOuter: 13, diskBrightness: 2.0 },
  },
  {
    name: 'Ergosphere',
    blurb: 'The static-limit shell switched on, so you can see the region where nothing can stand still.',
    params: { spin: 0.95, ergosphere: true, iscoTrack: true, cameraDistance: 9, inclination: 22, fov: 62, diskInner: 2, diskOuter: 9, diskBrightness: 1.7, exposure: 1.2 },
  },
  {
    name: 'Volumetric',
    blurb: 'The disk as a thick, self-shadowing slab of gas — you can see its far side glowing through the near side.',
    params: { spin: 0.6, iscoTrack: true, volumetric: true, diskThickness: 0.32, cameraDistance: 16, inclination: 20, fov: 50, diskOuter: 13, diskBrightness: 1.3, diskDensity: 1.2, exposure: 1.0 },
  },
  {
    name: 'Plunge',
    blurb: 'Ride an infalling raindrop toward the horizon — hit F (or the Plunge button) to dive and watch the sky compress ahead of you.',
    params: { freeFall: true, spin: 0, cameraDistance: 8, inclination: 14, fov: 68, diskInner: 3, diskOuter: 11, diskBrightness: 2.0, exposure: 1.15 },
  },
  {
    name: 'Light Echo',
    blurb: 'The photon ring lit up: higher-order lensing images — light that looped the hole — tinted cyan/gold/magenta by order, hugging the shadow’s edge.',
    params: { ringHighlight: true, spin: 0.6, iscoTrack: true, cameraDistance: 9, inclination: 10, fov: 60, diskInner: 3, diskOuter: 10, diskBrightness: 2.0, exposure: 1.2 },
  },
  {
    name: 'Probe',
    blurb: 'A clean three-quarter view for the photon probe — click anywhere on the render to trace that pixel’s geodesic and read off its conserved E, L, Q.',
    params: { spin: 0.7, iscoTrack: true, cameraDistance: 13, inclination: 16, fov: 55, diskInner: 3, diskOuter: 12, diskBrightness: 1.6, exposure: 1.1 },
  },
]
