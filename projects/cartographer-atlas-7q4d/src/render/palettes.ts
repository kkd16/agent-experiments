// Visual themes. Each palette maps the engine's fields (biome, elevation above
// sea, depth below sea, moisture) to colours, and carries the accent colours the
// renderer uses for water, coastline, borders and labels.

import { BIOMES } from '../core/biomes'

export type RGB = [number, number, number]

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

export function rgbToCss(c: RGB): string {
  return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`
}

export function lerpRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** Sample a multi-stop colour ramp at t ∈ [0,1]. */
export function ramp(stops: ReadonlyArray<readonly [number, RGB]>, t: number): RGB {
  const x = t < 0 ? 0 : t > 1 ? 1 : t
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [p0, c0] = stops[i - 1]
      const [p1, c1] = stops[i]
      const f = (x - p0) / (p1 - p0 || 1)
      return lerpRgb(c0, c1, f)
    }
  }
  return stops[stops.length - 1][1] as RGB
}

export interface Palette {
  key: string
  name: string
  background: string
  water: string
  coast: string
  border: string
  labelFill: string
  labelStroke: string
  /** Paper-grain strength 0..1. */
  grain: number
  /** Hillshade strength 0..1. */
  hillshade: number
  /** Ocean colour by depth (0 shallow .. 1 deep). */
  ocean(depth: number): RGB
  /** Land colour from biome id, elevation above sea (0..1), moisture (0..1). */
  land(biome: number, elevAbove: number, moisture: number): RGB

  // --- Atlas furniture & the civilisation layer ---
  /** Lake / inland-sea water colour (falls back to shallow ocean). */
  lake?: RGB
  /** River + open-water line colour is `water`; these tint the extras. */
  road: string
  roadCasing: string
  city: string
  cityStroke: string
  cityLabel: string
  cityLabelStroke: string
  contour: string
  provinceLine: string
  /** HSL lightness/saturation the province tint fills settle around. */
  provinceLum: number
  provinceSat: number
  provinceAlpha: number
  graticule: string
  scaleInk: string
  frame: string
  compass: string
}

const BIOME_RGB: RGB[] = BIOMES.map((b) => hexToRgb(b.color))

// --- Terra: natural, satellite-like ---
const TERRA: Palette = {
  key: 'terra',
  name: 'Terra',
  background: '#0e1826',
  water: '#2f6f9e',
  coast: '#173049',
  border: 'rgba(20,30,40,0.10)',
  labelFill: '#f5efe0',
  labelStroke: 'rgba(20,28,38,0.85)',
  grain: 0.05,
  hillshade: 1,
  ocean(depth) {
    return ramp(
      [
        [0, hexToRgb('#5a95bd')],
        [0.5, hexToRgb('#2f6088')],
        [1, hexToRgb('#132f4c')],
      ],
      depth,
    )
  },
  land(biome, elevAbove) {
    const base = BIOME_RGB[biome]
    // Gently deepen colour with altitude for a touch of relief before hillshade.
    return lerpRgb(base, [base[0] * 0.78, base[1] * 0.78, base[2] * 0.78], elevAbove * 0.35)
  },
  lake: hexToRgb('#3f7fae'),
  road: 'rgba(233,214,170,0.9)',
  roadCasing: 'rgba(20,28,38,0.55)',
  city: '#f6e7c4',
  cityStroke: '#12202f',
  cityLabel: '#f7efdd',
  cityLabelStroke: 'rgba(10,18,28,0.9)',
  contour: 'rgba(20,30,42,0.28)',
  provinceLine: 'rgba(245,238,220,0.5)',
  provinceLum: 62,
  provinceSat: 40,
  provinceAlpha: 0.16,
  graticule: 'rgba(210,225,240,0.12)',
  scaleInk: '#e7ecf4',
  frame: 'rgba(210,225,240,0.35)',
  compass: 'rgba(230,238,248,0.75)',
}

// --- Parchment: aged-paper fantasy atlas ---
const SEPIA_LAND = [
  [0, hexToRgb('#e9d9b0')],
  [0.35, hexToRgb('#dcc596')],
  [0.7, hexToRgb('#c2a473')],
  [1, hexToRgb('#9c7b4e')],
] as const

const PARCHMENT: Palette = {
  key: 'parchment',
  name: 'Parchment',
  background: '#e9dcbb',
  water: '#7b8f86',
  coast: '#5c4a30',
  border: 'rgba(92,74,48,0.10)',
  labelFill: '#4a3820',
  labelStroke: 'rgba(233,220,187,0.7)',
  grain: 0.16,
  hillshade: 0.55,
  ocean(depth) {
    return ramp(
      [
        [0, hexToRgb('#d9cca0')],
        [0.5, hexToRgb('#c3b487')],
        [1, hexToRgb('#a99a6f')],
      ],
      depth,
    )
  },
  land(_biome, elevAbove, moisture) {
    const sepia = ramp(SEPIA_LAND, elevAbove)
    // Nudge wet, forested lowlands slightly greener for a hand-tinted feel.
    const green = hexToRgb('#9aa76a')
    return lerpRgb(sepia, green, Math.min(0.28, moisture * (1 - elevAbove) * 0.4))
  },
  lake: hexToRgb('#8fa79a'),
  road: 'rgba(120,64,40,0.85)',
  roadCasing: 'rgba(233,220,187,0.6)',
  city: '#7a2f22',
  cityStroke: '#e9dcbb',
  cityLabel: '#43301a',
  cityLabelStroke: 'rgba(233,220,187,0.85)',
  contour: 'rgba(120,96,60,0.35)',
  provinceLine: 'rgba(92,74,48,0.5)',
  provinceLum: 55,
  provinceSat: 32,
  provinceAlpha: 0.14,
  graticule: 'rgba(92,74,48,0.14)',
  scaleInk: '#4a3820',
  frame: 'rgba(92,74,48,0.55)',
  compass: 'rgba(74,56,32,0.8)',
}

// --- Bathymetric: scientific hypsometric relief ---
const HYPSO = [
  [0.0, hexToRgb('#276419')],
  [0.18, hexToRgb('#4c9a2a')],
  [0.38, hexToRgb('#a6d96a')],
  [0.52, hexToRgb('#ffffbf')],
  [0.68, hexToRgb('#fdae61')],
  [0.82, hexToRgb('#c65a2e')],
  [0.93, hexToRgb('#8c5a3c')],
  [1.0, hexToRgb('#ffffff')],
] as const

const BATHY: Palette = {
  key: 'bathymetric',
  name: 'Bathymetric',
  background: '#04121f',
  water: '#2b6cb0',
  coast: '#0b2438',
  border: 'rgba(255,255,255,0.05)',
  labelFill: '#eef6ff',
  labelStroke: 'rgba(6,20,32,0.85)',
  grain: 0.03,
  hillshade: 1,
  ocean(depth) {
    return ramp(
      [
        [0, hexToRgb('#9ecae1')],
        [0.35, hexToRgb('#4292c6')],
        [0.7, hexToRgb('#2171b5')],
        [1, hexToRgb('#08306b')],
      ],
      depth,
    )
  },
  land(_biome, elevAbove) {
    return ramp(HYPSO, elevAbove)
  },
  lake: hexToRgb('#63b3ed'),
  road: 'rgba(255,255,255,0.7)',
  roadCasing: 'rgba(6,20,32,0.6)',
  city: '#fff2c9',
  cityStroke: '#06121f',
  cityLabel: '#eef6ff',
  cityLabelStroke: 'rgba(6,20,32,0.9)',
  contour: 'rgba(255,255,255,0.16)',
  provinceLine: 'rgba(238,246,255,0.5)',
  provinceLum: 60,
  provinceSat: 38,
  provinceAlpha: 0.14,
  graticule: 'rgba(158,202,225,0.16)',
  scaleInk: '#eef6ff',
  frame: 'rgba(158,202,225,0.4)',
  compass: 'rgba(220,238,255,0.7)',
}

// --- Imperial: political parchment tuned for provinces, roads & cities ---
const IMPERIAL: Palette = {
  key: 'imperial',
  name: 'Imperial',
  background: '#efe4c6',
  water: '#89a0a6',
  coast: '#4a3a26',
  border: 'rgba(74,58,38,0.10)',
  labelFill: '#3c2c17',
  labelStroke: 'rgba(239,228,198,0.7)',
  grain: 0.12,
  hillshade: 0.35,
  ocean(depth) {
    return ramp(
      [
        [0, hexToRgb('#c9cdba')],
        [0.5, hexToRgb('#adb49f')],
        [1, hexToRgb('#8f9a86')],
      ],
      depth,
    )
  },
  land(_biome, elevAbove, moisture) {
    // A muted, near-uniform vellum so province tints and ink read clearly on top.
    const vellum = ramp(
      [
        [0, hexToRgb('#efe7cc')],
        [0.5, hexToRgb('#e2d4ac')],
        [1, hexToRgb('#c9b382')],
      ],
      elevAbove,
    )
    const green = hexToRgb('#b7bd88')
    return lerpRgb(vellum, green, Math.min(0.18, moisture * (1 - elevAbove) * 0.3))
  },
  lake: hexToRgb('#9db4b8'),
  road: 'rgba(102,44,28,0.9)',
  roadCasing: 'rgba(239,228,198,0.7)',
  city: '#6d1f16',
  cityStroke: '#efe4c6',
  cityLabel: '#3a2413',
  cityLabelStroke: 'rgba(239,228,198,0.9)',
  contour: 'rgba(120,96,60,0.22)',
  provinceLine: 'rgba(74,50,30,0.6)',
  provinceLum: 58,
  provinceSat: 45,
  provinceAlpha: 0.26,
  graticule: 'rgba(74,58,38,0.16)',
  scaleInk: '#3c2c17',
  frame: 'rgba(74,50,30,0.65)',
  compass: 'rgba(74,44,26,0.82)',
}

export const PALETTES: readonly Palette[] = [TERRA, PARCHMENT, BATHY, IMPERIAL]

export function paletteByKey(key: string): Palette {
  return PALETTES.find((p) => p.key === key) ?? TERRA
}
