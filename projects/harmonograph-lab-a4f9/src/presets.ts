// Curated compositions. Presets are stored as plain data (no layer ids); the
// loader instantiates them into a live Project with fresh ids so loading the
// same preset twice never collides.

import { makeLayer } from './harmonograph'
import { paletteById } from './palettes'
import type {
  BlendMode,
  ColorMode,
  HarmonographParams,
  LayerStyle,
  Pendulum,
  Project,
  RotaryPendulum,
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
  }
}

interface PresetLayer {
  name: string
  params: HarmonographParams
  style: LayerStyle
}

export interface Preset {
  name: string
  background: string
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
]

export function loadPreset(preset: Preset): Project {
  return {
    background: preset.background,
    vignette: preset.vignette,
    layers: preset.layers.map((l) =>
      makeLayer(l.name, structuredClone(l.params), structuredClone(l.style)),
    ),
  }
}
