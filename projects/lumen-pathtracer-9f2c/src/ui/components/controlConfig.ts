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
  spp: number
  maxDepth: number
  rrStart: number
  clampIndirect: number
  aperture: number
  exposure: number
  tonemap: ToneMapping
  denoiseEnabled: boolean
  denoiseIterations: number
  denoiseSigma: number
}
