// Alternative curve sources. A harmonograph is one of several parametric curve
// families the studio can draw; this module owns the math, default + random
// parameters, the kind dispatcher, and the "breathe" phase-drift used by Live
// mode. Every sampler returns plain model-space points which the shared metric
// pipeline (speed / curvature / angle) and the renderer consume unchanged.

import {
  buildLayerData,
  samplePath,
  type LayerData,
  type Point,
  type SampledCurve,
} from './harmonograph'
import {
  defaultLSystem,
  lsystemById,
  randomLSystem,
  sampleLSystemFull,
} from './lsystem'
import { default3D, random3D, sample3DPolyline } from './attractors3d'
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
  { value: 'attractor3d', label: '3D Attractor' },
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
// point. The first four (de Jong / Clifford / Svensson / Dream) are written so
// the orbit stays bounded for every constant (every term is a bounded sin/cos).
// The last four (Hopalong / Gumowski–Mira / Bedhead / Tinkerbell) are classic
// maps that are *not* bounded by construction — they can throw the occasional
// far-flung iterate — so we frame them with robust percentile bounds (below)
// that clip those outliers instead of letting one of them collapse auto-fit.

const ATTRACTOR_STEPS = 14000

// Maps that are NOT bounded by construction → need robust framing + divergence
// guards. Everything else is mathematically confined to a small box.
const UNBOUNDED_MAPS = new Set<AttractorKind>(['hopalong', 'gumowski', 'bedhead', 'tinkerbell'])

export function attractorBounded(type: AttractorKind): boolean {
  return !UNBOUNDED_MAPS.has(type)
}

// Gumowski–Mira recurrence kernel.
function gmG(x: number, a: number): number {
  return a * x + (2 * (1 - a) * x * x) / (1 + x * x)
}

const sign = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0)

// One iterate of the selected map. Exported so the density renderer can splat
// millions of iterates without materialising a giant point array.
export function stepAttractor(type: AttractorKind, x: number, y: number, p: AttractorParams): Point {
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
    case 'hopalong': {
      // Barry Martin's "Hopalong". Reads a/b/c; the sqrt term sprays a dense
      // spiral of filaments — gorgeous in the density renderer.
      const nx = y - sign(x) * Math.sqrt(Math.abs(p.b * x - p.c))
      return { x: nx, y: p.a - x }
    }
    case 'gumowski': {
      // Gumowski–Mira — `a` shapes the kernel, `b` is the near-conservative gain.
      const nx = p.b * y + gmG(x, p.a)
      return { x: nx, y: -x + gmG(nx, p.a) }
    }
    case 'bedhead': {
      const b = Math.abs(p.b) < 1e-3 ? (p.b < 0 ? -1e-3 : 1e-3) : p.b
      return {
        x: Math.sin((x * y) / b) * y + Math.cos(p.a * x - y),
        y: x + Math.sin(y) / b,
      }
    }
    case 'tinkerbell':
      return {
        x: x * x - y * y + p.a * x + p.b * y,
        y: 2 * x * y + p.c * x + p.d * y,
      }
    case 'dejong':
    default:
      return {
        x: Math.sin(p.a * y) - Math.cos(p.b * x),
        y: Math.sin(p.c * x) - Math.cos(p.d * y),
      }
  }
}

// Iterate the map `count` times, calling `fn` with each iterate. Discards a
// short transient first so the orbit has settled onto the attractor. Diverging
// or non-finite iterates (possible for the unbounded maps) reset the orbit to a
// fixed small seed rather than poisoning the run — deterministic by design.
export function iterateAttractor(
  p: AttractorParams,
  count: number,
  fn: (x: number, y: number) => void,
): void {
  let x = 0.1
  let y = 0.1
  const reset = () => {
    x = 0.0123
    y = 0.0456
  }
  for (let i = 0; i < 100; i++) {
    const n = stepAttractor(p.type, x, y, p)
    if (Number.isFinite(n.x) && Number.isFinite(n.y) && Math.abs(n.x) < 1e6 && Math.abs(n.y) < 1e6) {
      x = n.x
      y = n.y
    } else reset()
  }
  for (let i = 0; i < count; i++) {
    const n = stepAttractor(p.type, x, y, p)
    if (Number.isFinite(n.x) && Number.isFinite(n.y) && Math.abs(n.x) < 1e6 && Math.abs(n.y) < 1e6) {
      x = n.x
      y = n.y
    } else reset()
    fn(x, y)
  }
}

// Outlier-resistant min/max: drop the most extreme `q` fraction on each side so
// a few runaway iterates don't blow up framing. Used for the unbounded maps.
function robustBounds(vals: number[], q = 0.004): { lo: number; hi: number } {
  const fin = vals.filter((v) => Number.isFinite(v))
  if (fin.length === 0) return { lo: -1, hi: 1 }
  fin.sort((a, b) => a - b)
  const lo = fin[Math.floor(q * (fin.length - 1))]
  const hi = fin[Math.ceil((1 - q) * (fin.length - 1))]
  if (hi - lo < 1e-9) return { lo: lo - 1, hi: hi + 1 }
  return { lo, hi }
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

export function sampleAttractor(p: AttractorParams): Point[] {
  const n = Math.max(2, p.steps)
  const xs = new Array<number>(n + 1)
  const ys = new Array<number>(n + 1)
  let k = 0
  iterateAttractor(p, n + 1, (x, y) => {
    if (k <= n) {
      xs[k] = x
      ys[k] = y
      k++
    }
  })
  const pts: Point[] = new Array(n + 1)
  if (attractorBounded(p.type)) {
    for (let i = 0; i <= n; i++) pts[i] = { x: xs[i], y: ys[i] }
    return pts
  }
  // Unbounded map: frame on robust bounds and clip the outliers into the box so
  // auto-fit sees a sane extent (the clipped points are a negligible fraction).
  const bx = robustBounds(xs)
  const by = robustBounds(ys)
  for (let i = 0; i <= n; i++) {
    pts[i] = { x: clamp(xs[i], bx.lo, bx.hi), y: clamp(ys[i], by.lo, by.hi) }
  }
  return pts
}

export const ATTRACTOR_KINDS: { value: AttractorKind; label: string }[] = [
  { value: 'dejong', label: 'de Jong' },
  { value: 'clifford', label: 'Clifford' },
  { value: 'svensson', label: 'Svensson' },
  { value: 'fractaldream', label: 'Dream' },
  { value: 'hopalong', label: 'Hopalong' },
  { value: 'gumowski', label: 'Gumowski' },
  { value: 'bedhead', label: 'Bedhead' },
  { value: 'tinkerbell', label: 'Tinkerbell' },
]

// A good-looking constant set for each map — used both as the default and when
// the user switches map type in the UI (so a de Jong's constants don't get
// reinterpreted as, say, a diverging Tinkerbell).
export function defaultsForAttractor(type: AttractorKind): AttractorParams {
  const base = { type, steps: ATTRACTOR_STEPS }
  switch (type) {
    case 'clifford':
      return { ...base, a: -1.4, b: 1.6, c: 1.0, d: 0.7 }
    case 'svensson':
      return { ...base, a: 1.5, b: -1.8, c: 1.6, d: 0.9 }
    case 'fractaldream':
      return { ...base, a: -0.966, b: 2.879, c: 0.765, d: 0.744 }
    case 'hopalong':
      return { ...base, a: 7.7, b: 0.64, c: 1.6, d: 0 }
    case 'gumowski':
      return { ...base, a: -0.48, b: 0.93, c: 0, d: 0 }
    case 'bedhead':
      return { ...base, a: -0.81, b: -0.92, c: 0, d: 0 }
    case 'tinkerbell':
      return { ...base, a: 0.9, b: -0.6013, c: 2.0, d: 0.5 }
    case 'dejong':
    default:
      return { ...base, a: 1.4, b: -2.3, c: 2.4, d: -2.1 }
  }
}

export function defaultAttractor(): AttractorParams {
  return defaultsForAttractor('dejong')
}

export function randomAttractor(): AttractorParams {
  const type = pick<AttractorKind>([
    'dejong',
    'clifford',
    'svensson',
    'fractaldream',
    'hopalong',
    'gumowski',
    'bedhead',
    'tinkerbell',
  ])
  const base = { type, steps: ATTRACTOR_STEPS }
  switch (type) {
    case 'clifford':
    case 'fractaldream':
      // c/d are multipliers here, kept moderate; a/b are angular frequencies.
      return { ...base, a: rand(-2.4, 2.4), b: rand(-2.4, 2.4), c: rand(-1.2, 1.2), d: rand(-1.2, 1.2) }
    case 'hopalong':
      return { ...base, a: rand(-8, 8), b: rand(0.2, 1.6), c: rand(0, 2), d: 0 }
    case 'gumowski':
      return { ...base, a: rand(-0.6, -0.2), b: rand(0.9, 0.97), c: 0, d: 0 }
    case 'bedhead': {
      const b = rand(0.3, 1) * pick([1, -1])
      return { ...base, a: rand(-1, 1), b, c: 0, d: 0 }
    }
    case 'tinkerbell':
      return { ...base, a: rand(0.7, 0.95), b: rand(-0.7, -0.3), c: rand(1.5, 2.2), d: rand(0.2, 0.6) }
    case 'dejong':
    case 'svensson':
    default:
      return { ...base, a: rand(-2.6, 2.6), b: rand(-2.6, 2.6), c: rand(-2.6, 2.6), d: rand(-2.6, 2.6) }
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
    case 'attractor3d':
      return (layer.a3d ??= default3D())
    case 'lsystem':
      return (layer.lsystem ??= defaultLSystem())
    case 'harmonograph':
    default:
      return layer.params
  }
}

export function sampleLayer(layer: Layer): SampledCurve {
  switch (layer.kind) {
    case 'spirograph':
      return { points: sampleSpiro(layer.spiro ?? defaultSpiro()) }
    case 'rose':
      return { points: sampleRose(layer.rose ?? defaultRose()) }
    case 'lissajous':
      return { points: sampleLissajous(layer.liss ?? defaultLiss()) }
    case 'superformula':
      return { points: sampleSuperformula(layer.sf ?? defaultSf()) }
    case 'attractor':
      return { points: sampleAttractor(layer.attractor ?? defaultAttractor()) }
    case 'attractor3d':
      return { points: sample3DPolyline(layer.a3d ?? default3D()) }
    case 'lsystem':
      // L-systems may branch (plants/trees), so this carries pen-up `breaks`.
      return sampleLSystemFull(layer.lsystem ?? defaultLSystem())
    case 'harmonograph':
    default:
      return { points: samplePath(layer.params) }
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
    case 'attractor3d': {
      // Orbit the camera: advance yaw monotonically (a full 2π turn is the
      // identity, so the nebula simply spins) and gently bob the pitch. Only the
      // cheap projection re-runs — the geometry pass is cached by flow shape.
      const s = layer.a3d ?? default3D()
      return {
        ...layer,
        a3d: { ...s, yaw: s.yaw + a * s.spin, pitch: s.pitch + 0.12 * Math.sin(a * 0.31) },
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

// ---- seamless loop drift (for looping GIF/WebM capture) -------------------
// `breatheLayer` advances phases *linearly*, which is great for an open-ended
// Live view but seams when you cut it into a finite, repeating clip. `loopLayer`
// instead oscillates every parameter by amp·sin(k·phase) with integer k: every
// term is exactly zero at phase 0 and phase 2π, so a capture that sweeps phase
// 0→2π returns precisely to its start — a flawless loop for every curve family.
export function loopLayer(layer: Layer, phase: number): Layer {
  const rate = layer.drift?.rate ?? 1
  const osc = (k: number, amp: number) => amp * rate * Math.sin(k * phase)
  switch (layer.kind) {
    case 'spirograph': {
      const s = layer.spiro ?? defaultSpiro()
      return { ...layer, spiro: { ...s, phase: s.phase + osc(1, 0.8) } }
    }
    case 'rose': {
      const s = layer.rose ?? defaultRose()
      return { ...layer, rose: { ...s, phase: s.phase + osc(1, 1.0) } }
    }
    case 'lissajous': {
      const s = layer.liss ?? defaultLiss()
      return { ...layer, liss: { ...s, delta: s.delta + osc(1, 0.9) } }
    }
    case 'superformula': {
      const s = layer.sf ?? defaultSf()
      return { ...layer, sf: { ...s, twist: s.twist + osc(1, 0.6) } }
    }
    case 'attractor': {
      const s = layer.attractor ?? defaultAttractor()
      return { ...layer, attractor: { ...s, a: s.a + osc(1, 0.12), c: s.c + osc(2, 0.12) } }
    }
    case 'attractor3d': {
      // A full revolution per loop: yaw advances 0→2π as phase does, so the last
      // frame is byte-for-byte the first — a flawless orbiting-camera loop.
      const s = layer.a3d ?? default3D()
      return { ...layer, a3d: { ...s, yaw: s.yaw + phase } }
    }
    case 'lsystem': {
      const s = layer.lsystem ?? defaultLSystem()
      return { ...layer, lsystem: { ...s, angle: s.angle + osc(1, 0.35) } }
    }
    case 'harmonograph':
    default: {
      const p = layer.params
      return {
        ...layer,
        params: {
          ...p,
          x1: { ...p.x1, phase: p.x1.phase + osc(1, 0.9) },
          x2: { ...p.x2, phase: p.x2.phase + osc(2, 0.7) },
          y1: { ...p.y1, phase: p.y1.phase + osc(1, 0.8) },
          y2: { ...p.y2, phase: p.y2.phase + osc(3, 0.6) },
          rotary: { ...p.rotary, phase: p.rotary.phase + osc(1, 0.5) },
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
    const sc = sampleLayer(layer)
    d = buildLayerData(sc.points, sc.breaks)
    dataCache.set(key, d)
  }
  return d
}

// Uncached: used by Live mode, which generates a fresh drifted layer per frame.
export function computeLayerData(layer: Layer): LayerData {
  const sc = sampleLayer(layer)
  return buildLayerData(sc.points, sc.breaks)
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
    case 'attractor3d':
      return { a3d: random3D() }
    case 'lsystem':
      return { lsystem: randomLSystem() }
    case 'harmonograph':
    default:
      return {}
  }
}

// Re-export so consumers can pull the L-system catalog helpers from `curves`.
export { defaultLSystem, lsystemById, randomLSystem }
// …and the 3D-flow helpers, so the app + editors import them from one place.
export { default3D, defaultsFor3D, random3D, FLOW3D_KINDS, ranges3D } from './attractors3d'
