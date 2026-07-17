// Palettes are baked into a 1-D RGBA texture the shader samples with wrap-repeat,
// so colour cycling is just a texture-coordinate offset. Two kinds are supported:
//
//   * "cosine"  — Inigo Quilez's a + b*cos(2pi*(c*t + d)) formula. Cyclic by
//                 construction, so gradients loop seamlessly during animation.
//   * "stops"   — classic gradient stops (used for the recognisable
//                 Ultra Fractal look), linearly interpolated and wrapped.

export type CosineSpec = {
  kind: 'cosine'
  a: [number, number, number]
  b: [number, number, number]
  c: [number, number, number]
  d: [number, number, number]
}

export type Stop = { pos: number; color: [number, number, number] }
export type StopsSpec = { kind: 'stops'; stops: Stop[] }
export type PaletteSpec = CosineSpec | StopsSpec

export type Palette = { id: string; name: string; spec: PaletteSpec }

const PALETTE_SIZE = 1024

export const PALETTES: Palette[] = [
  {
    id: 'nebula',
    name: 'Nebula',
    spec: {
      kind: 'cosine',
      a: [0.5, 0.5, 0.5],
      b: [0.5, 0.5, 0.5],
      c: [1.0, 1.0, 1.0],
      d: [0.0, 0.15, 0.3],
    },
  },
  {
    id: 'ember',
    name: 'Ember',
    spec: {
      kind: 'cosine',
      a: [0.5, 0.45, 0.35],
      b: [0.5, 0.4, 0.3],
      c: [1.0, 1.0, 1.0],
      d: [0.0, 0.08, 0.18],
    },
  },
  {
    id: 'ice',
    name: 'Ice',
    spec: {
      kind: 'cosine',
      a: [0.45, 0.5, 0.55],
      b: [0.45, 0.45, 0.5],
      c: [1.0, 1.0, 1.0],
      d: [0.55, 0.6, 0.7],
    },
  },
  {
    id: 'solar',
    name: 'Solar',
    spec: {
      kind: 'cosine',
      a: [0.5, 0.5, 0.4],
      b: [0.5, 0.5, 0.5],
      c: [1.0, 1.0, 0.5],
      d: [0.0, 0.1, 0.55],
    },
  },
  {
    id: 'ultra',
    name: 'Ultra',
    spec: {
      kind: 'stops',
      stops: [
        { pos: 0.0, color: [0, 7, 100] },
        { pos: 0.16, color: [32, 107, 203] },
        { pos: 0.42, color: [237, 255, 255] },
        { pos: 0.6425, color: [255, 170, 0] },
        { pos: 0.8575, color: [0, 2, 0] },
        { pos: 1.0, color: [0, 7, 100] },
      ],
    },
  },
  {
    id: 'spectrum',
    name: 'Spectrum',
    spec: {
      kind: 'cosine',
      a: [0.5, 0.5, 0.5],
      b: [0.5, 0.5, 0.5],
      c: [1.0, 1.0, 1.0],
      d: [0.0, 0.3333, 0.6667],
    },
  },
  {
    id: 'mono',
    name: 'Graphite',
    spec: {
      kind: 'cosine',
      a: [0.6, 0.6, 0.62],
      b: [0.4, 0.4, 0.4],
      c: [1.0, 1.0, 1.0],
      d: [0.0, 0.0, 0.05],
    },
  },
  {
    id: 'viridis',
    name: 'Botanic',
    spec: {
      kind: 'stops',
      stops: [
        { pos: 0.0, color: [13, 8, 66] },
        { pos: 0.25, color: [58, 62, 143] },
        { pos: 0.5, color: [33, 145, 140] },
        { pos: 0.75, color: [94, 201, 98] },
        { pos: 1.0, color: [253, 231, 37] },
      ],
    },
  },
]

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const TAU = Math.PI * 2

function cosineAt(spec: CosineSpec, t: number): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    out[i] = clamp01(spec.a[i] + spec.b[i] * Math.cos(TAU * (spec.c[i] * t + spec.d[i])))
  }
  return out
}

function stopsAt(spec: StopsSpec, t: number): [number, number, number] {
  const stops = spec.stops
  let lo = stops[0]
  let hi = stops[stops.length - 1]
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].pos && t <= stops[i + 1].pos) {
      lo = stops[i]
      hi = stops[i + 1]
      break
    }
  }
  const span = hi.pos - lo.pos || 1
  const f = clamp01((t - lo.pos) / span)
  return [
    (lo.color[0] + (hi.color[0] - lo.color[0]) * f) / 255,
    (lo.color[1] + (hi.color[1] - lo.color[1]) * f) / 255,
    (lo.color[2] + (hi.color[2] - lo.color[2]) * f) / 255,
  ]
}

export function sampleSpec(spec: PaletteSpec, t: number): [number, number, number] {
  return spec.kind === 'cosine' ? cosineAt(spec, t) : stopsAt(spec, t)
}

/** Bake a palette into a PALETTE_SIZE-wide RGBA8 array for texImage2D. */
export function buildPaletteTexture(palette: Palette): Uint8Array {
  const data = new Uint8Array(PALETTE_SIZE * 4)
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const t = i / (PALETTE_SIZE - 1)
    const [r, g, b] = sampleSpec(palette.spec, t)
    data[i * 4 + 0] = Math.round(r * 255)
    data[i * 4 + 1] = Math.round(g * 255)
    data[i * 4 + 2] = Math.round(b * 255)
    data[i * 4 + 3] = 255
  }
  return data
}

const BY_ID = new Map(PALETTES.map((p) => [p.id, p]))

export function getPalette(id: string): Palette {
  return BY_ID.get(id) ?? PALETTES[0]
}

/** A CSS linear-gradient string for a palette swatch in the UI. */
export function paletteGradientCss(palette: Palette, steps = 12): string {
  const parts: string[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const [r, g, b] = sampleSpec(palette.spec, t)
    const rgb = `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`
    parts.push(`${rgb} ${Math.round(t * 100)}%`)
  }
  return `linear-gradient(90deg, ${parts.join(', ')})`
}
