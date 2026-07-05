import type { Params } from '../types'

export type NumericParamKey =
  | 'cameraDistance'
  | 'inclination'
  | 'azimuth'
  | 'fov'
  | 'spin'
  | 'diskInner'
  | 'diskOuter'
  | 'diskBrightness'
  | 'diskTemperature'
  | 'diskDensity'
  | 'steps'
  | 'stepSize'
  | 'starBrightness'
  | 'exposure'
  | 'bloomStrength'
  | 'bloomThreshold'
  | 'renderScale'

export type ToggleParamKey =
  | 'doppler'
  | 'redshift'
  | 'autoRotate'
  | 'ergosphere'
  | 'iscoTrack'
  | 'bloom'
  | 'adaptiveQuality'

export interface SliderDef {
  key: NumericParamKey
  label: string
  min: number
  max: number
  step: number
  format?: (v: number) => string
  help: string
}

export interface ToggleDef {
  key: ToggleParamKey
  label: string
  help: string
}

export interface ControlGroup {
  title: string
  sliders: SliderDef[]
  toggles?: ToggleDef[]
}

const rs = (v: number) => `${v.toFixed(1)} rs`
const deg = (v: number) => `${v.toFixed(0)}°`

export const CONTROL_GROUPS: ControlGroup[] = [
  {
    title: 'Camera',
    sliders: [
      { key: 'cameraDistance', label: 'Distance', min: 3.5, max: 60, step: 0.1, format: rs, help: 'How far the camera sits from the singularity.' },
      { key: 'inclination', label: 'Inclination', min: -89, max: 89, step: 0.5, format: deg, help: 'Elevation above the disk plane. 0° is edge-on, 90° is straight down the axis.' },
      { key: 'azimuth', label: 'Azimuth', min: -180, max: 180, step: 0.5, format: deg, help: 'Orbital angle of the camera around the hole.' },
      { key: 'fov', label: 'Field of view', min: 25, max: 100, step: 1, format: deg, help: 'Vertical field of view — lower values zoom in.' },
    ],
    toggles: [{ key: 'autoRotate', label: 'Auto-orbit', help: 'Slowly spin the camera around the hole on its own.' }],
  },
  {
    title: 'Black hole',
    sliders: [
      {
        key: 'spin',
        label: 'Spin a/M',
        min: 0,
        max: 0.998,
        step: 0.002,
        format: (v) => v.toFixed(3),
        help: 'Dimensionless spin. 0 is a static Schwarzschild hole; near 1 is a near-extremal Kerr hole with strong frame dragging and a flattened shadow.',
      },
    ],
    toggles: [
      { key: 'ergosphere', label: 'Ergosphere', help: 'Draw the static-limit shell — inside it, frame dragging is so strong that nothing can remain at rest.' },
      { key: 'iscoTrack', label: 'Inner edge → ISCO', help: 'Snap the disk’s inner radius to the prograde innermost stable orbit for the current spin.' },
    ],
  },
  {
    title: 'Accretion disk',
    sliders: [
      { key: 'diskInner', label: 'Inner radius', min: 1.5, max: 8, step: 0.1, format: rs, help: 'Inner edge. The physical innermost stable orbit (ISCO) is 3 rs.' },
      { key: 'diskOuter', label: 'Outer radius', min: 4, max: 24, step: 0.1, format: rs, help: 'Outer edge of the glowing disk.' },
      { key: 'diskBrightness', label: 'Brightness', min: 0, max: 4, step: 0.05, help: 'Overall emission from the disk material.' },
      { key: 'diskTemperature', label: 'Temperature', min: 0.5, max: 1.6, step: 0.01, help: 'Scales the black-body colour ramp — higher is bluer/hotter.' },
      { key: 'diskDensity', label: 'Density', min: 0.2, max: 1.5, step: 0.01, help: 'Opacity of the disk material.' },
    ],
    toggles: [
      { key: 'doppler', label: 'Doppler beaming', help: 'Relativistic brightening + blueshift of the approaching side of the disk.' },
      { key: 'redshift', label: 'Gravitational redshift', help: 'Light climbing out of the well loses energy — dimmer and redder near the hole.' },
    ],
  },
  {
    title: 'Look',
    sliders: [
      { key: 'exposure', label: 'Exposure', min: 0.2, max: 3, step: 0.02, help: 'HDR exposure before the filmic tonemap.' },
      { key: 'starBrightness', label: 'Starfield', min: 0, max: 2.5, step: 0.05, help: 'Brightness of the lensed background stars and nebula.' },
      { key: 'bloomStrength', label: 'Bloom', min: 0, max: 1.5, step: 0.02, help: 'Intensity of the HDR bloom added to the disk highlights.' },
      { key: 'bloomThreshold', label: 'Bloom knee', min: 0.4, max: 3, step: 0.05, help: 'Luminance above which a pixel starts to glow.' },
    ],
    toggles: [{ key: 'bloom', label: 'Bloom', help: 'Multi-pass HDR bloom (float FBO ping-pong) for a photographic glow on bright disk material.' }],
  },
  {
    title: 'Quality',
    sliders: [
      { key: 'steps', label: 'Integration steps', min: 60, max: 700, step: 10, format: (v) => v.toFixed(0), help: 'Steps per photon. More = smoother lensing but slower.' },
      { key: 'stepSize', label: 'Step size', min: 0.05, max: 0.3, step: 0.005, help: 'Base integrator step. Smaller = more accurate near the hole.' },
      { key: 'renderScale', label: 'Render scale', min: 0.35, max: 1, step: 0.05, format: (v) => `${Math.round(v * 100)}%`, help: 'Internal resolution. Drop it if the framerate sags.' },
    ],
    toggles: [{ key: 'adaptiveQuality', label: 'Adaptive quality', help: 'Automatically lower the render scale when the framerate drops, and raise it again when there’s headroom.' }],
  },
]

export const CLAMP: Record<NumericParamKey, [number, number]> = Object.fromEntries(
  CONTROL_GROUPS.flatMap((g) => g.sliders).map((s) => [s.key, [s.min, s.max]]),
) as Record<NumericParamKey, [number, number]>

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function clampParams(p: Params): Params {
  const out = { ...p }
  for (const [key, [lo, hi]] of Object.entries(CLAMP) as [NumericParamKey, [number, number]][]) {
    out[key] = clamp(out[key], lo, hi)
  }
  return out
}
