// controlConfig.ts — shared control-panel constants and types, kept out of the
// component module so React Fast Refresh stays happy (component files should
// only export components).

import type { ToneMapping } from '../../engine/types'

export interface ResPreset {
  label: string
  w: number
  h: number
}

export const RES_PRESETS: ResPreset[] = [
  { label: '320×240', w: 320, h: 240 },
  { label: '480×360', w: 480, h: 360 },
  { label: '640×480', w: 640, h: 480 },
  { label: '800×600', w: 800, h: 600 },
]

export interface ControlState {
  sceneId: string
  resIndex: number
  integrator: 'pt' | 'bdpt' | 'pssmlt' | 'sppm' | 'guided' // light-transport algorithm
  spp: number
  maxDepth: number
  rrStart: number
  clampIndirect: number
  aperture: number
  adaptive: boolean
  adaptiveThreshold: number
  exposure: number
  tonemap: ToneMapping
  denoiseEnabled: boolean
  denoiseIterations: number
  denoiseSigma: number
  showNoise: boolean
  // Sky scenes only: interactive sun position + atmospheric turbidity.
  sunAzimuth: number // degrees
  sunElevation: number // degrees above horizon
  turbidity: number
  // Volumetric scenes only: a multiplier on the scene's medium extinction.
  fogDensity: number
  // Heterogeneous-cloud scenes only: an offset to the fBm coverage threshold
  // (− puffs the cloud up / fills it in, + breaks it into scattered billows).
  cloudCoverage: number
  // (14.0) Importance-sample which light to next-event-estimate via the light BVH
  // (power/distance/orientation) instead of uniformly — a large variance win for
  // many-light scenes. Affects the path tracer's NEE (pt / guided / pssmlt) and is
  // unbiased either way (it only reshapes the variance, never the mean).
  manyLights: boolean
  // (20.0) Next-event-estimate emissive *spheres* by the solid angle they subtend
  // (uniform-cone sampling) rather than leaving them to BSDF sampling alone — the
  // difference between a firefly storm and a clean sphere-lit room. Unbiased.
  sphereLights: boolean
  // (21.0) HDRI scenes only: spin the equirectangular environment about the
  // vertical axis (degrees) and scale its radiance. Rotation only re-orients the
  // panorama (the importance distribution rotates with it); intensity is a pure
  // radiance multiplier that leaves the sampling pdf unchanged.
  envRotation: number
  envIntensity: number
  // (22.0) Aperture *shape* (depth-of-field bokeh): number of iris blades. 0 (or
  // < 3) is a circular aperture (the historical concentric-disk sampler); 5–8
  // gives the pentagonal/hexagonal/octagonal bokeh balls of a real lens. A render
  // setting (it changes how camera rays are sampled), unbiased either way.
  apertureBlades: number
  // (22.0) Physically based image-formation pipeline (applied live, no
  // re-render). Each is a [0,1] strength; all-zero is a bit-exact identity.
  bloomStrength: number // veiling-glare bloom (energy-conserving multi-scale PSF)
  bloomRadius: number // base glare radius in pixels
  vignette: number // natural cos⁴θ lens falloff
  chromAberration: number // lateral chromatic aberration (colour fringing)
  filmGrain: number // photographic film grain (midtone-peaked, zero-mean)
  // Custom-OBJ scene only: the pasted model text.
  objText: string
}
