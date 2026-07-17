// Encode/decode the full parameter set into the URL hash so a tuned scene is a shareable link.
//
// The hash is `#/<view>?<query>`, e.g. `#/render?sp=0.9&in=4&db=2`. View routing (in App) reads
// the part before `?`; the query carries the scene. Keys are short two-letter codes to keep links
// compact; unknown keys are ignored so links stay forward-compatible.

import type { Params } from '../types'
import { DEFAULT_PARAMS } from '../state'
import { clampParams } from './controls-config'

type Codec = { code: string; kind: 'num' | 'bool'; prec?: number }

const FIELDS: Record<keyof Params, Codec> = {
  cameraDistance: { code: 'cd', kind: 'num', prec: 2 },
  inclination: { code: 'in', kind: 'num', prec: 1 },
  azimuth: { code: 'az', kind: 'num', prec: 1 },
  fov: { code: 'fv', kind: 'num', prec: 0 },
  freeFall: { code: 'ff', kind: 'bool' },
  spin: { code: 'sp', kind: 'num', prec: 3 },
  charge: { code: 'qc', kind: 'num', prec: 3 },
  ergosphere: { code: 'eg', kind: 'bool' },
  iscoTrack: { code: 'it', kind: 'bool' },
  diskInner: { code: 'di', kind: 'num', prec: 2 },
  diskOuter: { code: 'do', kind: 'num', prec: 2 },
  diskBrightness: { code: 'db', kind: 'num', prec: 2 },
  diskTemperature: { code: 'dt', kind: 'num', prec: 2 },
  diskDensity: { code: 'dd', kind: 'num', prec: 2 },
  volumetric: { code: 'vo', kind: 'bool' },
  diskThickness: { code: 'th', kind: 'num', prec: 2 },
  ringHighlight: { code: 'rh', kind: 'bool' },
  steps: { code: 'st', kind: 'num', prec: 0 },
  stepSize: { code: 'ss', kind: 'num', prec: 3 },
  doppler: { code: 'dp', kind: 'bool' },
  redshift: { code: 'rs', kind: 'bool' },
  starBrightness: { code: 'sb', kind: 'num', prec: 2 },
  exposure: { code: 'ex', kind: 'num', prec: 2 },
  bloom: { code: 'bl', kind: 'bool' },
  bloomStrength: { code: 'bs', kind: 'num', prec: 2 },
  bloomThreshold: { code: 'bt', kind: 'num', prec: 2 },
  renderScale: { code: 'rc', kind: 'num', prec: 2 },
  adaptiveQuality: { code: 'aq', kind: 'bool' },
  autoRotate: { code: 'ar', kind: 'bool' },
}

const ENTRIES = Object.entries(FIELDS) as [keyof Params, Codec][]

/** Serialise only the params that differ from the defaults, to keep links short. */
export function encodeParams(params: Params): string {
  const q = new URLSearchParams()
  for (const [key, codec] of ENTRIES) {
    const v = params[key]
    const dv = DEFAULT_PARAMS[key]
    if (v === dv) continue
    if (codec.kind === 'bool') {
      q.set(codec.code, (v as boolean) ? '1' : '0')
    } else {
      q.set(codec.code, Number(v).toFixed(codec.prec ?? 2).replace(/\.?0+$/, ''))
    }
  }
  return q.toString()
}

/** Parse a query string into a full, clamped Params (missing keys fall back to defaults). */
export function decodeParams(query: string): Params {
  const q = new URLSearchParams(query)
  const out: Params = { ...DEFAULT_PARAMS }
  for (const [key, codec] of ENTRIES) {
    const raw = q.get(codec.code)
    if (raw === null) continue
    if (codec.kind === 'bool') {
      out[key] = (raw === '1' || raw === 'true') as never
    } else {
      const n = Number(raw)
      if (Number.isFinite(n)) out[key] = n as never
    }
  }
  return clampParams(out)
}
