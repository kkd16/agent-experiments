// Curated compositions. Presets are stored as plain data (no layer ids); the
// loader instantiates them into a live Project with fresh ids so loading the
// same preset twice never collides.

import { makeLayer } from './harmonograph'
import { paletteById } from './palettes'
import type {
  AttractorParams,
  BlendMode,
  ColorMode,
  CurveKind,
  HarmonographParams,
  Layer,
  LayerStyle,
  LissajousParams,
  LSystemParams,
  Pendulum,
  Project,
  RoseParams,
  RotaryPendulum,
  SpirographParams,
  SuperformulaParams,
  WidthMode,
} from './types'

const STEPS = 6000

function pend(freq: number, phase: number, amp: number, damp: number): Pendulum {
  return { freq, phase, amp, damp }
}

function noRot(): RotaryPendulum {
  return { enabled: false, freq: 1, phase: 0, amp: 0.8, damp: 0.004 }
}

function rot(freq: number, phase: number, amp: number, damp: number): RotaryPendulum {
  return { enabled: true, freq, phase, amp, damp }
}

interface StyleOpts {
  colorMode?: ColorMode
  lineWidth?: number
  widthMode?: WidthMode
  opacity?: number
  blend?: BlendMode
  glow?: number
  symmetry?: number
  mirror?: boolean
}

function st(paletteId: string, o: StyleOpts = {}): LayerStyle {
  return {
    colors: paletteById(paletteId)?.colors ?? ['#ffffff'],
    colorMode: o.colorMode ?? 'path',
    lineWidth: o.lineWidth ?? 1.1,
    widthMode: o.widthMode ?? 'uniform',
    opacity: o.opacity ?? 1,
    blend: o.blend ?? 'source-over',
    glow: o.glow ?? 0,
    symmetry: o.symmetry ?? 1,
    mirror: o.mirror ?? false,
  }
}

interface PresetLayer {
  name: string
  params: HarmonographParams
  style: LayerStyle
  kind?: CurveKind
  spiro?: SpirographParams
  rose?: RoseParams
  liss?: LissajousParams
  sf?: SuperformulaParams
  attractor?: AttractorParams
  lsystem?: LSystemParams
}

// A harmonograph placeholder for layers whose real source is another kind.
function dummyHarm(): HarmonographParams {
  return {
    x1: pend(2, 0, 1, 0.004),
    x2: pend(3, Math.PI, 0.7, 0.004),
    y1: pend(3, 0, 1, 0.004),
    y2: pend(2, Math.PI, 0.7, 0.004),
    rotary: noRot(),
    duration: 220,
    steps: STEPS,
  }
}

export interface Preset {
  name: string
  background: string
  bg2?: string
  bgMode?: 'solid' | 'linear' | 'radial'
  vignette: number
  layers: PresetLayer[]
}

const PI = Math.PI

export const PRESETS: Preset[] = [
  {
    name: 'Rosette',
    background: '#070b1a',
    vignette: 0.35,
    layers: [
      {
        name: 'Rosette',
        params: {
          x1: pend(2, 0, 1, 0.0032),
          x2: pend(4, PI / 2, 0.5, 0.0032),
          y1: pend(3, 0, 1, 0.0032),
          y2: pend(5, PI / 3, 0.5, 0.0032),
          rotary: noRot(),
          duration: 260,
          steps: STEPS,
        },
        style: st('aurora', { glow: 0.25, lineWidth: 1.1 }),
      },
    ],
  },
  {
    name: 'Knot',
    background: '#160a1e',
    vignette: 0.4,
    layers: [
      {
        name: 'Knot',
        params: {
          x1: pend(3, PI / 4, 1, 0.0045),
          x2: pend(2, 0, 0.8, 0.0045),
          y1: pend(2, PI / 2, 1, 0.0045),
          y2: pend(3, 0, 0.8, 0.0045),
          rotary: noRot(),
          duration: 220,
          steps: STEPS,
        },
        style: st('sunset', { colorMode: 'angle', lineWidth: 1.2 }),
      },
    ],
  },
  {
    name: 'Spiral',
    background: '#1a0f0a',
    vignette: 0.45,
    layers: [
      {
        name: 'Spiral',
        params: {
          x1: pend(1, 0, 1, 0.012),
          x2: pend(5, PI / 2, 0.35, 0.004),
          y1: pend(1, PI / 2, 1, 0.012),
          y2: pend(5, 0, 0.35, 0.004),
          rotary: noRot(),
          duration: 300,
          steps: STEPS,
        },
        style: st('ember', { colorMode: 'velocity', glow: 0.3, lineWidth: 1.2 }),
      },
    ],
  },
  {
    name: 'Lattice',
    background: '#03140f',
    vignette: 0.3,
    layers: [
      {
        name: 'Lattice',
        params: {
          x1: pend(4, 0, 1, 0.0018),
          x2: pend(5, PI / 6, 0.6, 0.0018),
          y1: pend(5, 0, 1, 0.0018),
          y2: pend(4, PI / 4, 0.6, 0.0018),
          rotary: noRot(),
          duration: 340,
          steps: STEPS,
        },
        style: st('viridis', { lineWidth: 0.9 }),
      },
    ],
  },
  {
    name: 'Twin Bloom',
    background: '#070b1a',
    vignette: 0.4,
    layers: [
      {
        name: 'Bloom A',
        params: {
          x1: pend(2, 0, 1, 0.0028),
          x2: pend(3, PI / 2, 0.6, 0.0028),
          y1: pend(3, 0, 1, 0.0028),
          y2: pend(2, PI / 5, 0.6, 0.0028),
          rotary: noRot(),
          duration: 280,
          steps: STEPS,
        },
        style: st('aurora', { blend: 'lighter', glow: 0.4, opacity: 0.85, lineWidth: 0.9 }),
      },
      {
        name: 'Bloom B',
        params: {
          x1: pend(2, PI / 3, 0.95, 0.0028),
          x2: pend(3, PI / 2 + 0.3, 0.6, 0.0028),
          y1: pend(3, 0.2, 0.95, 0.0028),
          y2: pend(2, PI / 5 + 0.4, 0.6, 0.0028),
          rotary: noRot(),
          duration: 280,
          steps: STEPS,
        },
        style: st('neon', { blend: 'lighter', glow: 0.4, opacity: 0.75, lineWidth: 0.8 }),
      },
    ],
  },
  {
    name: 'Rotary Mandala',
    background: '#0a0a0a',
    vignette: 0.5,
    layers: [
      {
        name: 'Mandala',
        params: {
          x1: pend(3, 0, 1, 0.0016),
          x2: pend(2, PI / 2, 0.7, 0.0016),
          y1: pend(3, PI / 2, 1, 0.0016),
          y2: pend(2, 0, 0.7, 0.0016),
          rotary: rot(1, 0, 0.9, 0.0016),
          duration: 360,
          steps: STEPS,
        },
        style: st('spectrum', { colorMode: 'angle', glow: 0.3, lineWidth: 0.9 }),
      },
    ],
  },
  {
    name: 'Aurora Veil',
    background: '#070b1a',
    vignette: 0.55,
    layers: [
      {
        name: 'Veil 1',
        params: {
          x1: pend(2, 0, 1, 0.002),
          x2: pend(3, PI / 2, 0.5, 0.002),
          y1: pend(3, 0, 1, 0.002),
          y2: pend(2, PI / 4, 0.5, 0.002),
          rotary: noRot(),
          duration: 320,
          steps: STEPS,
        },
        style: st('ice', { blend: 'lighter', opacity: 0.55, glow: 0.5, lineWidth: 0.7 }),
      },
      {
        name: 'Veil 2',
        params: {
          x1: pend(2, 0.5, 1, 0.002),
          x2: pend(3, PI / 2 + 0.6, 0.5, 0.002),
          y1: pend(3, 0.3, 1, 0.002),
          y2: pend(2, PI / 4 + 0.5, 0.5, 0.002),
          rotary: noRot(),
          duration: 320,
          steps: STEPS,
        },
        style: st('aurora', { blend: 'lighter', opacity: 0.5, glow: 0.5, lineWidth: 0.7 }),
      },
      {
        name: 'Veil 3',
        params: {
          x1: pend(2, 1.1, 0.95, 0.002),
          x2: pend(3, PI / 2 + 1.2, 0.5, 0.002),
          y1: pend(3, 0.7, 0.95, 0.002),
          y2: pend(2, PI / 4 + 1, 0.5, 0.002),
          rotary: noRot(),
          duration: 320,
          steps: STEPS,
        },
        style: st('sunset', { blend: 'lighter', opacity: 0.45, glow: 0.5, lineWidth: 0.7 }),
      },
    ],
  },
  {
    name: 'Ink Study',
    background: '#efe9dd',
    vignette: 0.2,
    layers: [
      {
        name: 'Study',
        params: {
          x1: pend(3, 0, 1, 0.0026),
          x2: pend(5, PI / 3, 0.45, 0.0026),
          y1: pend(2, PI / 2, 1, 0.0026),
          y2: pend(4, 0, 0.45, 0.0026),
          rotary: noRot(),
          duration: 300,
          steps: STEPS,
        },
        style: st('gold-ink', { colorMode: 'curvature', lineWidth: 0.8 }),
      },
    ],
  },
  {
    name: 'Kaleidoscope',
    background: '#080612',
    vignette: 0.5,
    layers: [
      {
        name: 'Wedge',
        params: {
          x1: pend(2, 0, 1, 0.0022),
          x2: pend(5, PI / 3, 0.4, 0.0022),
          y1: pend(3, PI / 2, 1, 0.0022),
          y2: pend(4, 0, 0.4, 0.0022),
          rotary: noRot(),
          duration: 300,
          steps: STEPS,
        },
        style: st('spectrum', {
          colorMode: 'angle',
          glow: 0.35,
          lineWidth: 0.8,
          symmetry: 6,
          mirror: true,
          blend: 'lighter',
          opacity: 0.9,
        }),
      },
    ],
  },
  {
    name: 'Velocity Field',
    background: '#0d0820',
    vignette: 0.45,
    layers: [
      {
        name: 'Field',
        params: {
          x1: pend(4, 0, 1, 0.0014),
          x2: pend(6, PI / 2, 0.4, 0.0014),
          y1: pend(5, 0, 1, 0.0014),
          y2: pend(3, PI / 4, 0.4, 0.0014),
          rotary: noRot(),
          duration: 380,
          steps: STEPS,
        },
        style: st('plasma', {
          colorMode: 'velocity',
          widthMode: 'speed',
          glow: 0.35,
          lineWidth: 1.4,
        }),
      },
    ],
  },
  {
    name: 'Spiro Gear',
    background: '#0a0a0a',
    vignette: 0.4,
    layers: [
      {
        name: 'Gear',
        kind: 'spirograph',
        params: dummyHarm(),
        spiro: { R: 1, r: 0.27, d: 0.78, outer: false, turns: 27, phase: 0, decay: 0, steps: STEPS },
        style: st('neon', { colorMode: 'angle', glow: 0.3, lineWidth: 0.8, blend: 'lighter' }),
      },
    ],
  },
  {
    name: 'Spiro Spiral',
    background: '#0b1220',
    vignette: 0.45,
    layers: [
      {
        name: 'Inward',
        kind: 'spirograph',
        params: dummyHarm(),
        spiro: { R: 1, r: 0.41, d: 0.62, outer: false, turns: 22, phase: 0, decay: 0.012, steps: STEPS },
        style: st('ice', { colorMode: 'path', glow: 0.4, lineWidth: 0.9, blend: 'lighter', opacity: 0.9 }),
      },
    ],
  },
  {
    name: 'Twelve-Rose',
    background: '#080612',
    vignette: 0.5,
    layers: [
      {
        name: 'Rose',
        kind: 'rose',
        params: dummyHarm(),
        rose: { n: 7, d: 4, amp: 1, c2: 0.22, k2: 12, phase: 0, cycles: 4, steps: STEPS },
        style: st('spectrum', { colorMode: 'angle', glow: 0.32, lineWidth: 0.9, blend: 'lighter' }),
      },
    ],
  },
  {
    name: 'Lissajous Weave',
    background: '#070b1a',
    vignette: 0.4,
    layers: [
      {
        name: 'Weave A',
        kind: 'lissajous',
        params: dummyHarm(),
        liss: { a: 5, b: 4, delta: Math.PI / 2, ampX: 1, ampY: 1, decay: 0, cycles: 1, steps: STEPS },
        style: st('aurora', { glow: 0.35, lineWidth: 1, blend: 'lighter', opacity: 0.85 }),
      },
      {
        name: 'Weave B',
        kind: 'lissajous',
        params: dummyHarm(),
        liss: { a: 4, b: 5, delta: Math.PI / 3, ampX: 1, ampY: 1, decay: 0, cycles: 1, steps: STEPS },
        style: st('sunset', { glow: 0.35, lineWidth: 1, blend: 'lighter', opacity: 0.75 }),
      },
    ],
  },
  {
    name: 'Superflora',
    background: '#0d0820',
    bg2: '#1a0a2e',
    bgMode: 'radial',
    vignette: 0.5,
    layers: [
      {
        name: 'Flora',
        kind: 'superformula',
        params: dummyHarm(),
        sf: { m: 10, n1: 0.4, n2: 0.6, n3: 0.6, a: 1, b: 1, amp: 1, cycles: 5, twist: 1.4, steps: STEPS },
        style: st('plasma', { colorMode: 'path', glow: 0.3, lineWidth: 0.85, blend: 'lighter', opacity: 0.9 }),
      },
    ],
  },
  {
    name: 'Starfish',
    background: '#03140f',
    vignette: 0.42,
    layers: [
      {
        name: 'Bloom',
        kind: 'superformula',
        params: dummyHarm(),
        sf: { m: 5, n1: 0.3, n2: 0.3, n3: 0.3, a: 1, b: 1, amp: 1, cycles: 7, twist: 0.9, steps: STEPS },
        style: st('jade', { colorMode: 'angle', glow: 0.28, lineWidth: 0.9, blend: 'lighter' }),
      },
    ],
  },
  {
    name: 'de Jong Web',
    background: '#06060d',
    bg2: '#140a22',
    bgMode: 'radial',
    vignette: 0.5,
    layers: [
      {
        name: 'Orbit',
        kind: 'attractor',
        params: dummyHarm(),
        attractor: { type: 'dejong', a: 1.4, b: -2.3, c: 2.4, d: -2.1, steps: 16000 },
        style: st('plasma', { colorMode: 'path', glow: 0.3, lineWidth: 0.55, blend: 'lighter', opacity: 0.85 }),
      },
    ],
  },
  {
    name: 'Clifford Drift',
    background: '#070b1a',
    vignette: 0.45,
    layers: [
      {
        name: 'Orbit',
        kind: 'attractor',
        params: dummyHarm(),
        attractor: { type: 'clifford', a: -1.4, b: 1.6, c: 1.0, d: 0.7, steps: 16000 },
        style: st('aurora', { colorMode: 'velocity', glow: 0.32, lineWidth: 0.55, blend: 'lighter', opacity: 0.85 }),
      },
    ],
  },
  {
    name: 'Svensson Bloom',
    background: '#0a0512',
    vignette: 0.48,
    layers: [
      {
        name: 'Orbit',
        kind: 'attractor',
        params: dummyHarm(),
        attractor: { type: 'svensson', a: 1.5, b: -1.8, c: 1.6, d: 1.4, steps: 16000 },
        style: st('neon', { colorMode: 'path', glow: 0.3, lineWidth: 0.6, blend: 'lighter', opacity: 0.85 }),
      },
    ],
  },
  {
    name: 'Supershape Morph',
    background: '#0d0820',
    bg2: '#06030f',
    bgMode: 'radial',
    vignette: 0.5,
    layers: [
      {
        name: 'Morph',
        kind: 'superformula',
        params: dummyHarm(),
        sf: { m: 7, n1: 0.3, n2: 0.5, n3: 0.5, a: 1, b: 1, amp: 1, cycles: 9, twist: 1.7, steps: STEPS },
        style: st('spectrum', { colorMode: 'angle', glow: 0.34, lineWidth: 0.75, blend: 'lighter', opacity: 0.9 }),
      },
    ],
  },
  {
    name: 'Fractal Dream',
    background: '#05060f',
    bg2: '#120a22',
    bgMode: 'radial',
    vignette: 0.5,
    layers: [
      {
        name: 'Dream',
        kind: 'attractor',
        params: dummyHarm(),
        attractor: { type: 'fractaldream', a: -2.0, b: -2.34, c: 0.2, d: -0.65, steps: 16000 },
        style: st('aurora', { colorMode: 'path', glow: 0.3, lineWidth: 0.55, blend: 'lighter', opacity: 0.85 }),
      },
    ],
  },
  {
    name: 'Dragon Fold',
    background: '#070b1a',
    vignette: 0.42,
    layers: [
      {
        name: 'Dragon',
        kind: 'lsystem',
        params: dummyHarm(),
        lsystem: { system: 'dragon', iterations: 13, angle: PI / 2 },
        style: st('plasma', { colorMode: 'path', glow: 0.28, lineWidth: 1.1, blend: 'lighter', opacity: 0.92 }),
      },
    ],
  },
  {
    name: 'Hilbert Weave',
    background: '#03140f',
    vignette: 0.34,
    layers: [
      {
        name: 'Hilbert',
        kind: 'lsystem',
        params: dummyHarm(),
        lsystem: { system: 'hilbert', iterations: 6, angle: PI / 2 },
        style: st('viridis', { colorMode: 'path', lineWidth: 1.2, glow: 0.18 }),
      },
    ],
  },
  {
    name: 'Gosper Snow',
    background: '#06060d',
    vignette: 0.4,
    layers: [
      {
        name: 'Flowsnake',
        kind: 'lsystem',
        params: dummyHarm(),
        lsystem: { system: 'gosper', iterations: 4, angle: PI / 3 },
        style: st('ice', { colorMode: 'angle', glow: 0.3, lineWidth: 1, blend: 'lighter', opacity: 0.9 }),
      },
    ],
  },
  {
    name: 'Koch Crown',
    background: '#0a0512',
    vignette: 0.46,
    layers: [
      {
        name: 'Snowflake',
        kind: 'lsystem',
        params: dummyHarm(),
        lsystem: { system: 'snowflake', iterations: 4, angle: PI / 3 },
        style: st('rose-gold', { colorMode: 'path', glow: 0.26, lineWidth: 1.1, blend: 'lighter', opacity: 0.9 }),
      },
    ],
  },
  {
    name: 'Arrowhead Mandala',
    background: '#0d0820',
    bg2: '#06030f',
    bgMode: 'radial',
    vignette: 0.52,
    layers: [
      {
        name: 'Gasket',
        kind: 'lsystem',
        params: dummyHarm(),
        lsystem: { system: 'arrowhead', iterations: 7, angle: PI / 3 },
        style: st('spectrum', {
          colorMode: 'path',
          glow: 0.3,
          lineWidth: 0.85,
          blend: 'lighter',
          opacity: 0.9,
          symmetry: 3,
          mirror: true,
        }),
      },
    ],
  },
]

export function loadPreset(preset: Preset): Project {
  return {
    background: preset.background,
    bg2: preset.bg2,
    bgMode: preset.bgMode,
    vignette: preset.vignette,
    layers: preset.layers.map((l) => {
      const extra: Partial<Layer> = { kind: l.kind ?? 'harmonograph' }
      if (l.spiro) extra.spiro = structuredClone(l.spiro)
      if (l.rose) extra.rose = structuredClone(l.rose)
      if (l.liss) extra.liss = structuredClone(l.liss)
      if (l.sf) extra.sf = structuredClone(l.sf)
      if (l.attractor) extra.attractor = structuredClone(l.attractor)
      if (l.lsystem) extra.lsystem = structuredClone(l.lsystem)
      return makeLayer(l.name, structuredClone(l.params), structuredClone(l.style), extra)
    }),
  }
}
