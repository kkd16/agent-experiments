// "Surprise me" — generate a whole, aesthetically coordinated composition rather
// than a single random curve. It picks a visual archetype (luminous veils, a
// kaleidoscopic mandala, a clean ink study…) and derives several phase-shifted
// layers that interfere coherently, with matching palettes, blend and glow.

import { cloneParams, defaultParams, makeLayer, randomParams } from './harmonograph'
import {
  random3D,
  random3DHarmonograph,
  randomAttractor,
  randomFourier,
  randomLSystem,
  randomLissajous,
  randomRose,
  randomSpiro,
  randomSuperformula,
} from './curves'
import { PALETTES } from './palettes'
import type {
  BlendMode,
  ColorMode,
  CurveKind,
  HarmonographParams,
  Layer,
  LayerStyle,
  Project,
} from './types'

const rand = (a: number, b: number) => a + Math.random() * (b - a)
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]
const chance = (p: number) => Math.random() < p

const DARK_BG = ['#070b1a', '#0a0a0a', '#0b1220', '#160a1e', '#080612', '#0d0820']

// Phase-shift every pendulum so derived layers weave around the base figure.
function shifted(base: HarmonographParams, d: number): HarmonographParams {
  const p = cloneParams(base)
  for (const k of ['x1', 'x2', 'y1', 'y2'] as const) {
    p[k].phase = (p[k].phase + d) % (Math.PI * 2)
  }
  p.rotary.phase = (p.rotary.phase + d) % (Math.PI * 2)
  return p
}

type Archetype = 'veil' | 'bloom' | 'mandala' | 'ink' | 'clean'

interface Plan {
  background: string
  vignette: number
  count: number
  build: (i: number, total: number) => LayerStyle
}

function planFor(archetype: Archetype): Plan {
  const colorMode = (): ColorMode => pick(['path', 'velocity', 'angle'])
  switch (archetype) {
    case 'veil': {
      const palettes = [pick(PALETTES), pick(PALETTES), pick(PALETTES)]
      return {
        background: pick(DARK_BG),
        vignette: rand(0.45, 0.6),
        count: pick([2, 3, 3]),
        build: (i) => ({
          colors: [...palettes[i % palettes.length].colors],
          colorMode: 'path',
          lineWidth: rand(0.6, 0.85),
          widthMode: 'uniform',
          opacity: rand(0.4, 0.62),
          blend: 'lighter',
          glow: rand(0.4, 0.55),
          symmetry: 1,
          mirror: false,
        }),
      }
    }
    case 'bloom': {
      const palettes = [pick(PALETTES), pick(PALETTES)]
      const mode = colorMode()
      return {
        background: pick(DARK_BG),
        vignette: rand(0.35, 0.5),
        count: pick([1, 2, 2]),
        build: (i) => ({
          colors: [...palettes[i % palettes.length].colors],
          colorMode: mode,
          lineWidth: rand(0.8, 1.2),
          widthMode: chance(0.4) ? 'speed' : 'uniform',
          opacity: rand(0.78, 0.95),
          blend: 'lighter',
          glow: rand(0.3, 0.45),
          symmetry: 1,
          mirror: false,
        }),
      }
    }
    case 'mandala': {
      const palette = pick([
        PALETTES.find((p) => p.id === 'spectrum')!,
        PALETTES.find((p) => p.id === 'plasma')!,
        PALETTES.find((p) => p.id === 'aurora')!,
        pick(PALETTES),
      ])
      const symmetry = pick([3, 4, 5, 6, 8])
      const mirror = chance(0.6)
      return {
        background: pick(DARK_BG),
        vignette: rand(0.45, 0.6),
        count: 1,
        build: () => ({
          colors: [...palette.colors],
          colorMode: chance(0.6) ? 'angle' : 'path',
          lineWidth: rand(0.7, 0.95),
          widthMode: 'uniform',
          opacity: 0.9,
          blend: 'lighter',
          glow: rand(0.3, 0.45),
          symmetry,
          mirror,
        }),
      }
    }
    case 'ink': {
      const palette = pick([
        PALETTES.find((p) => p.id === 'gold-ink')!,
        PALETTES.find((p) => p.id === 'mono-light')!,
        pick(PALETTES),
      ])
      return {
        background: pick(['#efe9dd', '#f5f5f0']),
        vignette: rand(0.15, 0.28),
        count: 1,
        build: () => ({
          colors: [...palette.colors],
          colorMode: chance(0.5) ? 'curvature' : 'path',
          lineWidth: rand(0.7, 0.95),
          widthMode: 'uniform',
          opacity: 1,
          blend: 'source-over',
          glow: 0,
          symmetry: 1,
          mirror: false,
        }),
      }
    }
    case 'clean':
    default: {
      const palettes = [pick(PALETTES), pick(PALETTES)]
      const blend: BlendMode = chance(0.3) ? 'screen' : 'source-over'
      const mode = colorMode()
      return {
        background: pick(DARK_BG),
        vignette: rand(0.3, 0.5),
        count: pick([1, 2]),
        build: (i) => ({
          colors: [...palettes[i % palettes.length].colors],
          colorMode: mode,
          lineWidth: rand(0.9, 1.4),
          widthMode: 'uniform',
          opacity: i === 0 ? 1 : rand(0.7, 0.9),
          blend,
          glow: chance(0.5) ? rand(0.15, 0.3) : 0,
          symmetry: 1,
          mirror: false,
        }),
      }
    }
  }
}

// ---- alternative-source compositions --------------------------------------
// A coordinated piece built from spirograph / rose / Lissajous / superformula
// layers, with palette + glow chosen to suit the family.

const DARK_ALT = ['#070b1a', '#0a0a0a', '#0b1220', '#160a1e', '#0d0820', '#03140f']

function altStyle(palette: string[], glow: number, opacity: number, mode: ColorMode): LayerStyle {
  return {
    colors: palette,
    colorMode: mode,
    lineWidth: rand(0.75, 1.05),
    widthMode: 'uniform',
    opacity,
    blend: 'lighter',
    glow,
    symmetry: 1,
    mirror: false,
  }
}

function altLayer(kind: CurveKind, name: string, style: LayerStyle): Layer {
  const extra: Partial<Layer> = { kind }
  if (kind === 'spirograph') extra.spiro = randomSpiro()
  else if (kind === 'rose') extra.rose = randomRose()
  else if (kind === 'lissajous') extra.liss = randomLissajous()
  else if (kind === 'superformula') extra.sf = randomSuperformula()
  else if (kind === 'attractor') extra.attractor = randomAttractor()
  else if (kind === 'attractor3d') extra.a3d = random3D()
  else if (kind === 'harmonograph3d') extra.h3d = random3DHarmonograph()
  else if (kind === 'lsystem') extra.lsystem = randomLSystem()
  else if (kind === 'fourier') extra.fourier = randomFourier()
  return makeLayer(name, defaultParams(), style, extra)
}

function generateAltProject(): Project {
  const kind = pick<CurveKind>([
    'spirograph',
    'rose',
    'lissajous',
    'superformula',
    'attractor',
    'attractor3d',
    'harmonograph3d',
    'lsystem',
    'fourier',
  ])
  const is3d = kind === 'attractor3d' || kind === 'harmonograph3d'
  const background = pick(DARK_ALT)
  const vignette = rand(0.38, 0.55)
  const palettes = [pick(PALETTES), pick(PALETTES)]
  // L-systems have no meaningful velocity (uniform unit steps), so colour them
  // along the path or by direction instead.
  const mode: ColorMode =
    kind === 'lsystem' ? pick(['path', 'angle']) : pick(['path', 'angle', 'velocity'])
  // Attractors, 3D figures and L-systems are dense single figures — one reads
  // best alone; the smooth families layer nicely as one or two interleaved copies.
  const count =
    kind === 'attractor' || is3d || kind === 'lsystem' || kind === 'fourier'
      ? 1
      : kind === 'lissajous'
        ? pick([1, 2, 2])
        : pick([1, 1, 2])
  const layers: Layer[] = []
  for (let i = 0; i < count; i++) {
    const style = altStyle(
      [...palettes[i % palettes.length].colors],
      rand(0.28, 0.46),
      i === 0 ? rand(0.85, 0.95) : rand(0.6, 0.8),
      mode,
    )
    if (kind === 'attractor') style.lineWidth = rand(0.5, 0.65)
    if (kind === 'attractor3d') style.lineWidth = rand(0.5, 0.7)
    if (kind === 'harmonograph3d') style.lineWidth = rand(0.7, 1)
    if (kind === 'lsystem') style.lineWidth = rand(0.9, 1.3)
    // Most generated attractors look best as a luminous density nebula rather
    // than a polyline — splat the orbit instead of connecting it. The 3D flows
    // are *always* shown as a depth-cued nebula (that's where they shine); the
    // spatial harmonograph reads beautifully both ways, so split the difference.
    if (
      (kind === 'attractor' && chance(0.7)) ||
      kind === 'attractor3d' ||
      (kind === 'harmonograph3d' && chance(0.5))
    ) {
      style.renderStyle = 'density'
      style.density = {
        iterations: Math.round(rand(700, 1000)),
        exposure: rand(1.1, 1.6),
        gamma: rand(0.45, 0.58),
      }
      style.blend = 'lighter'
      style.opacity = 1
    }
    layers.push(altLayer(kind, ['Base', 'Echo'][i] ?? `Layer ${i + 1}`, style))
  }
  // 3D scenes occasionally pop into a red-cyan anaglyph for genuine depth.
  const stereo = is3d && chance(0.25) ? { stereo: 'anaglyph' as const, stereoBaseline: 0.08 } : {}
  // Occasionally deepen the scene with a radial gradient background.
  if (chance(0.4)) {
    return { background, bg2: pick(DARK_ALT), bgMode: 'radial', vignette, layers, ...stereo }
  }
  return { background, vignette, layers, ...stereo }
}

export function generateProject(): Project {
  // ~40% of the time, surprise with a non-harmonograph curve family.
  if (Math.random() < 0.4) return generateAltProject()
  const archetype = pick<Archetype>(['veil', 'bloom', 'mandala', 'ink', 'clean'])
  const plan = planFor(archetype)
  const base = randomParams()
  // Mandalas read best with low damping (the figure fills the wedge).
  if (archetype === 'mandala') {
    for (const k of ['x1', 'x2', 'y1', 'y2'] as const) base[k].damp = rand(0.0014, 0.003)
  }
  const names = ['Base', 'Weave', 'Veil', 'Echo']
  const layers = []
  for (let i = 0; i < plan.count; i++) {
    const params = i === 0 ? base : shifted(base, i * rand(0.3, 0.6))
    layers.push(makeLayer(names[i] ?? `Layer ${i + 1}`, params, plan.build(i, plan.count)))
  }
  return { background: plan.background, vignette: plan.vignette, layers }
}
