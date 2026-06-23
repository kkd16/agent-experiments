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
  // Custom-OBJ scene only: the pasted model text.
  objText: string
}
