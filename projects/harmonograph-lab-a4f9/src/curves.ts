// Alternative curve sources. A harmonograph is one of several parametric curve
// families the studio can draw; this module owns the math, default + random
// parameters, the kind dispatcher, and the "breathe" phase-drift used by Live
// mode. Every sampler returns plain model-space points which the shared metric
// pipeline (speed / curvature / angle) and the renderer consume unchanged.

import { buildLayerData, samplePath, type LayerData, type Point } from './harmonograph'
import { defaultLSystem, lsystemById, randomLSystem, sampleLSystem } from './lsystem'
import type {
  AttractorKind,
  AttractorParams,
  CurveKind,
  Layer,
  LissajousParams,
  RoseParams,
  SpirographParams,
  SuperformulaParams,
} from './types'

const TWO_PI = Math.PI * 2
const rand = (a: number, b: number) => a + Math.random() * (b - a)
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]
const irand = (a: number, b: number) => Math.round(rand(a, b))

export const CURVE_KINDS: { value: CurveKind; label: string }[] = [
  { value: 'harmonograph', label: 'Harmonograph' },
  { value: 'spirograph', label: 'Spirograph' },
  { value: 'rose', label: 'Rose' },
  { value: 'lissajous', label: 'Lissajous' },
  { value: 'superformula', label: 'Superformula' },
  { value: 'attractor', label: 'Attractor' },
  { value: 'lsystem', label: 'L-system' },
]

// ---- spirograph (hypotrochoid / epitrochoid) ------------------------------

export function sampleSpiro(p: SpirographParams): Point[] {
  const n = Math.max(2, p.steps)
  const pts: Point[] = new Array(n + 1)
  const total = p.turns * TWO_PI
  const dt = total / n
  const sign = p.outer ? 1 : -1
  const sum = p.R + sign * p.r // (R - r) hypo, (R + r) epi
  const ratio = sum / p.r
  for (let i = 0; i <= n; i++) {
    const t = i * dt + p.phase
    const k = ratio * t
    // hypo: + d cos(k), - d sin(k); epi: - d cos(k), - d sin(k)
    const x = sum * Math.cos(t) + (p.outer ? -1 : 1) * p.d * Math.cos(k)
    const y = sum * Math.sin(t) - p.d * Math.sin(k)
    const decay = p.decay > 0 ? Math.exp(-p.decay * (i * dt)) : 1
    pts[i] = { x: x * decay, y: y * decay }
  }
  return pts
}

export function defaultSpiro(): SpirographParams {
  return { R: 1, r: 0.32, d: 0.55, outer: false, turns: 8, phase: 0, decay: 0, steps: 6000 }
}

export function randomSpiro(): SpirographParams {
  const outer = Math.random() < 0.4
  const rr = rand(0.18, 0.55)
  return {
    R: 1,
    r: rr,
    d: rand(0.25, 0.95),
    outer,
    turns: irand(5, 13),
    phase: rand(0, TWO_PI),
    decay: Math.random() < 0.35 ? rand(0.002, 0.02) : 0,
    steps: 6000,
  }
}

// ---- rose (rhodonea) ------------------------------------------------------

export function sampleRose(p: RoseParams): Point[] {
  const n = Math.max(2, p.steps)
  const pts: Point[] = new Array(n + 1)
  const total = Math.max(1, p.cycles) * TWO_PI
  const dt = total / n
  const k = p.d === 0 ? p.n : p.n / p.d
  for (let i = 0; i <= n; i++) {
    const th = i * dt
    const r = p.amp * Math.cos(k * th + p.phase) + p.c2 * Math.cos(p.k2 * th)
    pts[i] = { x: r * Math.cos(th), y: r * Math.sin(th) }
  }
  return pts
}

export function defaultRose(): RoseParams {
  return { n: 5, d: 1, amp: 1, c2: 0, k2: 3, phase: 0, cycles: 1, steps: 6000 }
}

export function randomRose(): RoseParams {
  const harmonic = Math.random() < 0.45
  const d = pick([1, 1, 2, 3, 4])
  return {
    n: irand(2, 9),
    d,
    amp: 1,
    c2: harmonic ? rand(0.15, 0.5) : 0,
    k2: irand(2, 11),
    phase: rand(0, Math.PI),
    cycles: d, // a k = n/d rose needs d wraps to close
    steps: 6000,
  }
}

// ---- Lissajous ------------------------------------------------------------

export function sampleLissajous(p: LissajousParams): Point[] {
  const n = Math.max(2, p.steps)
  const pts: Point[] = new Array(n + 1)
  const total = Math.max(1, p.cycles) * TWO_PI
  const dt = total / n
  for (let i = 0; i <= n; i++) {
    const t = i * dt
    const decay = p.decay > 0 ? Math.exp(-p.decay * t) : 1
    pts[i] = {
      x: p.ampX * Math.sin(p.a * t + p.delta) * decay,
      y: p.ampY * Math.sin(p.b * t) * decay,
    }
  }
  return pts
}

export function defaultLiss(): LissajousParams {
  return { a: 3, b: 2, delta: Math.PI / 2, ampX: 1, ampY: 1, decay: 0, cycles: 1, steps: 6000 }
}

export function randomLissajous(): LissajousParams {
  return {
    a: irand(2, 7),
    b: irand(2, 7),
    delta: rand(0, Math.PI),
    ampX: rand(0.85, 1),
    ampY: rand(0.85, 1),
    decay: Math.random() < 0.3 ? rand(0.01, 0.06) : 0,
    cycles: pick([1, 1, 2]),
    steps: 6000,
  }
}

// ---- Gielis superformula --------------------------------------------------

function superRadius(p: SuperformulaParams, phi: number): number {
  const t1 = Math.pow(Math.abs(Math.cos((p.m * phi) / 4) / p.a), p.n2)
  const t2 = Math.pow(Math.abs(Math.sin((p.m * phi) / 4) / p.b), p.n3)
  const denom = Math.pow(t1 + t2, 1 / p.n1)
  if (!Number.isFinite(denom) || denom === 0) return 0
  return 1 / denom
}

export function sampleSuperformula(p: SuperformulaParams): Point[] {
  const n = Math.max(2, p.steps)
  const pts: Point[] = new Array(n + 1)
  const total = Math.max(1, p.cycles) * TWO_PI
  const dt = total / n
  for (let i = 0; i <= n; i++) {
    const phi = i * dt
    const r = p.amp * superRadius(p, phi)
    const ang = phi + p.twist * (phi / TWO_PI)
    pts[i] = { x: r * Math.cos(ang), y: r * Math.sin(ang) }
  }
  return pts
}

export function defaultSf(): SuperformulaParams {
  return { m: 6, n1: 0.3, n2: 0.3, n3: 0.3, a: 1, b: 1, amp: 1, cycles: 1, twist: 0, steps: 6000 }
}

export function randomSuperformula(): SuperformulaParams {
  const multi = Math.random() < 0.5
  return {
    m: irand(3, 14),
    n1: rand(0.2, 2.2),
    n2: rand(0.3, 3),
    n3: rand(0.3, 3),
    a: 1,
    b: 1,
    amp: 1,
    cycles: multi ? irand(2, 7) : 1,
    twist: multi ? rand(0.2, 2.4) : 0,
    steps: 6000,
  }
}

// ---- strange attractors ---------------------------------------------------
// Each map takes the current point (x, y) and the four constants to the next
// point. They are deliberately written so the orbit stays bounded for every
// constant (every term is a bounded sin/cos), which keeps auto-fit framing sane
// and lets the Live "breathe" mode morph the constants without the figure ever
// blowing up.

function attractorStep(type: AttractorKind, x: number, y: number, p: AttractorParams): Point {
  switch (type) {
    case 'clifford':
      return {
        x: Math.sin(p.a * y) + p.c * Math.cos(p.a * x),
        y: Math.sin(p.b * x) + p.d * Math.cos(p.b * y),
      }
    case 'svensson':
      return {
        x: p.d * Math.sin(p.a * x) - Math.sin(p.b * y),
        y: p.c * Math.cos(p.a * x) + Math.cos(p.b * y),
      }
    case 'fractaldream':
      // Clifford Pickover's "Fractal Dream" — like de Jong but with a self-term
      // weighted by c/d. Every term is a bounded sine, so the orbit can't escape.
      return {
        x: Math.sin(p.b * y) + p.c * Math.sin(p.b * x),
        y: Math.sin(p.a * x) + p.d * Math.sin(p.a * y),
      }
    case 'dejong':
    default:
      return {
        x: Math.sin(p.a * y) - Math.cos(p.b * x),
        y: Math.sin(p.c * x) - Math.cos(p.d * y),
      }
  }
}

export function sampleAttractor(p: AttractorParams): Point[] {
  const n = Math.max(2, p.steps)
  const pts: Point[] = new Array(n + 1)
  let x = 0.1
  let y = 0.1
  // Discard a short transient so the orbit settles onto the attractor before we
  // start recording it.
  for (let i = 0; i < 80; i++) {
    const next = attractorStep(p.type, x, y, p)
    x = next.x
    y = next.y
  }
  for (let i = 0; i <= n; i++) {
    pts[i] = { x, y }
    const next = attractorStep(p.type, x, y, p)
    // Bounded maps shouldn't diverge, but guard anyway: a non-finite step resets
    // the orbit to the seed instead of poisoning the whole point array.
    if (Number.isFinite(next.x) && Number.isFinite(next.y)) {
      x = next.x
      y = next.y
    } else {
      x = 0.1
      y = 0.1
    }
  }
  return pts
}

export const ATTRACTOR_KINDS: { value: AttractorKind; label: string }[] = [
  { value: 'dejong', label: 'de Jong' },
  { value: 'clifford', label: 'Clifford' },
  { value: 'svensson', label: 'Svensson' },
  { value: 'fractaldream', label: 'Dream' },
]

export function defaultAttractor(): AttractorParams {
  // A classic, well-behaved de Jong attractor.
  return { type: 'dejong', a: 1.4, b: -2.3, c: 2.4, d: -2.1, steps: 14000 }
}

export function randomAttractor(): AttractorParams {
  const type = pick<AttractorKind>(['dejong', 'clifford', 'svensson', 'fractaldream'])
  // Clifford / Dream read c/d as multipliers (kept moderate); the others read
  // their four constants as angular frequencies, where a wider range stays
  // interesting. a/b are always frequencies.
  if (type === 'clifford' || type === 'fractaldream') {
    return {
      type,
      a: rand(-2.4, 2.4),
      b: rand(-2.4, 2.4),
      c: rand(-1.2, 1.2),
      d: rand(-1.2, 1.2),
      steps: 14000,
    }
  }
  return {
    type,
    a: rand(-2.6, 2.6),
    b: rand(-2.6, 2.6),
    c: rand(-2.6, 2.6),
    d: rand(-2.6, 2.6),
    steps: 14000,
  }
}

// ---- dispatch -------------------------------------------------------------

// The source param object for a layer's active kind — also the WeakMap cache
// key, so a style edit (which preserves these objects) never recomputes points.
export function sourceParams(layer: Layer): object {
  switch (layer.kind) {
    case 'spirograph':
      return (layer.spiro ??= defaultSpiro())
    case 'rose':
      return (layer.rose ??= defaultRose())
    case 'lissajous':
      return (layer.liss ??= defaultLiss())
    case 'superformula':
      return (layer.sf ??= defaultSf())
    case 'attractor':
      return (layer.attractor ??= defaultAttractor())
    case 'lsystem':
      return (layer.lsystem ??= defaultLSystem())
    case 'harmonograph':
    default:
      return layer.params
  }
}

export function sampleLayer(layer: Layer): Point[] {
  switch (layer.kind) {
    case 'spirograph':
      return sampleSpiro(layer.spiro ?? defaultSpiro())
    case 'rose':
      return sampleRose(layer.rose ?? defaultRose())
    case 'lissajous':
      return sampleLissajous(layer.liss ?? defaultLiss())
    case 'superformula':
      return sampleSuperformula(layer.sf ?? defaultSf())
    case 'attractor':
      return sampleAttractor(layer.attractor ?? defaultAttractor())
    case 'lsystem':
      return sampleLSystem(layer.lsystem ?? defaultLSystem())
    case 'harmonograph':
    default:
      return samplePath(layer.params)
  }
}

// ---- Live "breathe" — drift the active source's phases by `t` -------------
// Returns a *new* layer (shallow, with a fresh source object) whose phases have
// advanced; the rest of the figure is untouched so framing stays stable.

export function breatheLayer(layer: Layer, t: number): Layer {
  const rate = layer.drift?.rate ?? 1
  const a = t * rate
  switch (layer.kind) {
    case 'spirograph': {
      const s = layer.spiro ?? defaultSpiro()
      return { ...layer, spiro: { ...s, phase: s.phase + a * 0.6 } }
    }
    case 'rose': {
      const s = layer.rose ?? defaultRose()
      return { ...layer, rose: { ...s, phase: s.phase + a * 0.8 } }
    }
    case 'lissajous': {
      const s = layer.liss ?? defaultLiss()
      return { ...layer, liss: { ...s, delta: s.delta + a * 0.7 } }
    }
    case 'superformula': {
      const s = layer.sf ?? defaultSf()
      return { ...layer, sf: { ...s, twist: s.twist + a * 0.5 } }
    }
    case 'attractor': {
      // Gently oscillate two constants around their current values so the orbit
      // morphs through nearby attractors and back, rather than wandering off
      // into a dead region the way unbounded linear drift would.
      const s = layer.attractor ?? defaultAttractor()
      return {
        ...layer,
        attractor: {
          ...s,
          a: s.a + 0.12 * Math.sin(a * 0.45),
          c: s.c + 0.12 * Math.cos(a * 0.37),
        },
      }
    }
    case 'lsystem': {
      // Sweep the fold angle around its set value. Because the expanded string
      // doesn't depend on the angle, this only re-runs the cheap turtle pass — so
      // a Hilbert curve ripples and a dragon unfolds and refolds in real time.
      const s = layer.lsystem ?? defaultLSystem()
      return { ...layer, lsystem: { ...s, angle: s.angle + 0.32 * Math.sin(a * 0.5) } }
    }
    case 'harmonograph':
    default: {
      const p = layer.params
      // advance each pendulum phase at a slightly different rate so the
      // interference pattern slowly evolves rather than rigidly rotating.
      return {
        ...layer,
        params: {
          ...p,
          x1: { ...p.x1, phase: p.x1.phase + a * 1.0 },
          x2: { ...p.x2, phase: p.x2.phase + a * 0.83 },
          y1: { ...p.y1, phase: p.y1.phase + a * 0.67 },
          y2: { ...p.y2, phase: p.y2.phase + a * 0.91 },
          rotary: { ...p.rotary, phase: p.rotary.phase + a * 0.5 },
        },
      }
    }
  }
}

// Memoise the (relatively costly) sampling by source-params identity. Editing a
// layer's *style* keeps its source object reference, so this returns instantly
// then; only an actual params change recomputes. A WeakMap lets layers GC.
const dataCache = new WeakMap<object, LayerData>()

export function getLayerData(layer: Layer): LayerData {
  const key = sourceParams(layer)
  let d = dataCache.get(key)
  if (!d) {
    d = buildLayerData(sampleLayer(layer))
    dataCache.set(key, d)
  }
  return d
}

// Uncached: used by Live mode, which generates a fresh drifted layer per frame.
export function computeLayerData(layer: Layer): LayerData {
  return buildLayerData(sampleLayer(layer))
}

// Make a fresh random source of the given kind (for randomize / kind switches).
export function randomSourceFor(kind: CurveKind): Partial<Layer> {
  switch (kind) {
    case 'spirograph':
      return { spiro: randomSpiro() }
    case 'rose':
      return { rose: randomRose() }
    case 'lissajous':
      return { liss: randomLissajous() }
    case 'superformula':
      return { sf: randomSuperformula() }
    case 'attractor':
      return { attractor: randomAttractor() }
    case 'lsystem':
      return { lsystem: randomLSystem() }
    case 'harmonograph':
    default:
      return {}
  }
}

// Re-export so consumers can pull the L-system catalog helpers from `curves`.
export { defaultLSystem, lsystemById, randomLSystem }
