// Thematic overlays — the atlas's data maps. Each recolours the *land* by one field:
// Köppen climate zones, dominant resource, temperature, rainfall, or elevation. Ocean
// keeps the palette's water colour so coastlines still read. The colour logic lives here
// so the canvas renderer and the SVG exporter stay pixel-for-pixel identical.

import type { WorldMap } from '../core/types'
import { KOPPEN, KOPPEN_NONE } from '../core/koppen'
import { RESOURCES, RESOURCE_NONE } from '../core/economy'
import type { Overlay } from '../ui/viewOptions'
import { hexToRgb, ramp } from './palettes'
import type { RGB } from './palettes'

// "coolwarm"-style temperature ramp: cold blue → pale → hot red.
const TEMP_RAMP = [
  [0, hexToRgb('#3b4cc0')],
  [0.25, hexToRgb('#7b9ff9')],
  [0.5, hexToRgb('#e8e6df')],
  [0.72, hexToRgb('#f4a582')],
  [1, hexToRgb('#b40426')],
] as const

// Rainfall ramp: parched tan → grassy green → deep blue.
const PRECIP_RAMP = [
  [0, hexToRgb('#dbc98c')],
  [0.35, hexToRgb('#a9c069')],
  [0.62, hexToRgb('#3f9b6b')],
  [1, hexToRgb('#1f6b8f')],
] as const

// Hypsometric elevation ramp (lowland green → upland brown → snow white).
const ELEV_RAMP = [
  [0, hexToRgb('#3f7d3a')],
  [0.25, hexToRgb('#a6c15a')],
  [0.5, hexToRgb('#e8d78a')],
  [0.72, hexToRgb('#c07a44')],
  [0.9, hexToRgb('#8a5a3c')],
  [1, hexToRgb('#ffffff')],
] as const

// --- Circulation field ramps (Session 5) ---

// Sea-level pressure: diverging around 1013 hPa (low blue → white → high red).
const PRESSURE_RAMP = [
  [0, hexToRgb('#3b5bbf')],
  [0.5, hexToRgb('#eee9dc')],
  [1, hexToRgb('#c23b34')],
] as const

// Wind speed: calm dark → brisk gold (reads over land and sea alike).
const WIND_RAMP = [
  [0, hexToRgb('#1b2536')],
  [0.5, hexToRgb('#4a8ea1')],
  [0.8, hexToRgb('#d8c05a')],
  [1, hexToRgb('#f6f0d8')],
] as const

// Ocean current speed: still deep → swift bright cyan.
const CURRENT_RAMP = [
  [0, hexToRgb('#0a2036')],
  [0.45, hexToRgb('#22698f')],
  [0.75, hexToRgb('#5fc8d8')],
  [1, hexToRgb('#e6fbff')],
] as const

// Sea-surface temperature: cold blue → warm red.
const SST_RAMP = [
  [0, hexToRgb('#23408f')],
  [0.35, hexToRgb('#3b9ad6')],
  [0.6, hexToRgb('#77c9a8')],
  [0.8, hexToRgb('#f2d06b')],
  [1, hexToRgb('#d6452e')],
] as const

const PRESSURE_LO = 995
const PRESSURE_HI = 1030
const SST_LO = -2
const SST_HI = 30

const NEUTRAL: RGB = [150, 150, 150]

/** Overlays that recolour the ocean (and sometimes the land) as a full field, not just land. */
export function isCirculationOverlay(overlay: Overlay): boolean {
  return overlay === 'wind' || overlay === 'current' || overlay === 'pressure' || overlay === 'sst'
}

/**
 * Colour for a cell under a circulation overlay, covering ocean as well as land. Returns null
 * to fall back to the palette's default (e.g. land under a Current/SST overlay stays natural).
 */
export function circulationOverlayColor(
  world: WorldMap,
  r: number,
  overlay: Overlay,
  isOcean: boolean,
): RGB | null {
  const c = world.circulation
  switch (overlay) {
    case 'pressure': {
      const t = (c.pressure[r] - PRESSURE_LO) / (PRESSURE_HI - PRESSURE_LO)
      return ramp(PRESSURE_RAMP, t)
    }
    case 'wind':
      return ramp(WIND_RAMP, world.circulation.windSpeed[r])
    case 'current':
      return isOcean ? ramp(CURRENT_RAMP, world.circulation.curSpeed[r]) : null
    case 'sst': {
      if (!isOcean) return null
      const t = (c.sst[r] - SST_LO) / (SST_HI - SST_LO)
      return ramp(SST_RAMP, t)
    }
    default:
      return null
  }
}

/** Land colour for a cell under the given overlay (caller guarantees a land cell). */
export function overlayLandColor(world: WorldMap, r: number, overlay: Overlay): RGB {
  switch (overlay) {
    case 'koppen': {
      const k = world.koppen[r]
      return k === KOPPEN_NONE ? NEUTRAL : hexToRgb(KOPPEN[k].color)
    }
    case 'resource': {
      const res = world.resource[r]
      return res === RESOURCE_NONE ? [206, 200, 182] : hexToRgb(RESOURCES[res].color)
    }
    case 'temperature':
      return ramp(TEMP_RAMP, world.temperature[r])
    case 'precip':
      return ramp(PRECIP_RAMP, world.precip[r])
    case 'elevation': {
      const denom = 1 - world.params.seaLevel || 1
      const above = Math.max(0, world.elevation[r] - world.params.seaLevel) / denom
      return ramp(ELEV_RAMP, above)
    }
    default:
      return NEUTRAL
  }
}

/** A legend descriptor for the active overlay, for the on-map legend. */
export interface OverlayLegend {
  title: string
  /** Discrete swatches (Köppen, resources) — only the entries actually present. */
  swatches?: { color: string; label: string }[]
  /** Or a continuous gradient with end labels. */
  gradient?: { stops: string[]; lo: string; hi: string }
}

export function overlayLegend(world: WorldMap, overlay: Overlay): OverlayLegend | null {
  switch (overlay) {
    case 'koppen': {
      const present = new Set<number>()
      for (let r = 0; r < world.mesh.numSolid; r++) {
        const k = world.koppen[r]
        if (k !== KOPPEN_NONE) present.add(k)
      }
      const swatches = [...present]
        .sort((a, b) => a - b)
        .map((k) => ({ color: KOPPEN[k].color, label: `${KOPPEN[k].code} · ${KOPPEN[k].name}` }))
      return { title: 'Köppen climate', swatches }
    }
    case 'resource': {
      const present = new Set<number>()
      for (let r = 0; r < world.mesh.numSolid; r++) {
        const res = world.resource[r]
        if (res !== RESOURCE_NONE) present.add(res)
      }
      const swatches = [...present]
        .sort((a, b) => a - b)
        .map((i) => ({ color: RESOURCES[i].color, label: RESOURCES[i].name }))
      return { title: 'Resources', swatches }
    }
    case 'temperature':
      return {
        title: 'Mean temperature',
        gradient: { stops: TEMP_RAMP.map((s) => rgbCss(s[1])), lo: 'cold', hi: 'hot' },
      }
    case 'precip':
      return {
        title: 'Annual rainfall',
        gradient: { stops: PRECIP_RAMP.map((s) => rgbCss(s[1])), lo: 'arid', hi: 'wet' },
      }
    case 'elevation':
      return {
        title: 'Elevation',
        gradient: { stops: ELEV_RAMP.map((s) => rgbCss(s[1])), lo: 'sea', hi: 'peak' },
      }
    case 'pressure':
      return {
        title: 'Sea-level pressure',
        gradient: { stops: PRESSURE_RAMP.map((s) => rgbCss(s[1])), lo: 'low', hi: 'high' },
      }
    case 'wind':
      return {
        title: 'Wind speed',
        gradient: { stops: WIND_RAMP.map((s) => rgbCss(s[1])), lo: 'calm', hi: 'gale' },
      }
    case 'current':
      return {
        title: 'Ocean current',
        gradient: { stops: CURRENT_RAMP.map((s) => rgbCss(s[1])), lo: 'still', hi: 'swift' },
      }
    case 'sst':
      return {
        title: 'Sea-surface temp',
        gradient: { stops: SST_RAMP.map((s) => rgbCss(s[1])), lo: 'cold', hi: 'warm' },
      }
    default:
      return null
  }
}

function rgbCss(c: RGB): string {
  return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`
}
