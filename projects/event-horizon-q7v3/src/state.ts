import type { Params, Preset } from './types'

export const DEFAULT_PARAMS: Params = {
  cameraDistance: 14,
  inclination: 9,
  azimuth: 0,
  fov: 55,

  diskInner: 3.0,
  diskOuter: 12.0,
  diskBrightness: 1.3,
  diskTemperature: 1.0,
  diskDensity: 1.0,

  steps: 320,
  stepSize: 0.14,

  doppler: true,
  redshift: true,

  starBrightness: 1.0,
  exposure: 1.0,

  renderScale: 1.0,
  autoRotate: true,
}

// Physical constants in our rs = 1 unit system.
export const RS = 1.0
export const M = 0.5 // rs / 2
export const PHOTON_SPHERE = 1.5 // 1.5 rs
export const ISCO = 3.0 // 6M = 3 rs
export const B_CRIT = 3 * Math.sqrt(3) * M // ≈ 2.598, critical impact parameter

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
    params: { cameraDistance: 20, inclination: 4, fov: 50, diskInner: 3, diskOuter: 16, diskBrightness: 1.9, diskTemperature: 1.15 },
  },
]
