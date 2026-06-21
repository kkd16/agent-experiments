// Three-dimensional strange attractors — the continuous cousins of the iterated
// 2D maps in `curves.ts`. Where a de Jong map hops discretely, these are *flows*:
// systems of ordinary differential equations dx/dt = f(x, y, z) whose trajectory
// winds forever around a fractal set living in 3-space (the Lorenz butterfly is
// the famous one). This module owns the physics (the vector fields), a 4th-order
// Runge–Kutta integrator that traces the trajectory, and an **orbit camera** that
// projects the 3D orbit onto the 2D model plane the rest of the studio already
// knows how to draw, frame, color and splat. That single projection step is what
// lets a 3D attractor flow through the existing line / density / SVG / GIF
// pipeline unchanged — the renderer never learns it's looking at a 3D object.
//
// The camera is part of the layer's saved params, so spinning it (Live drift /
// the looping exporter advance `yaw`) makes the nebula *orbit* — and because a
// full 2π turn of yaw is the identity, that orbit loops seamlessly for free.

import type { Point } from './harmonograph'
import type { Attractor3DParams, Flow3DKind } from './types'

const rand = (a: number, b: number) => a + Math.random() * (b - a)
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]

export const FLOW3D_KINDS: { value: Flow3DKind; label: string }[] = [
  { value: 'lorenz', label: 'Lorenz' },
  { value: 'rossler', label: 'Rössler' },
  { value: 'aizawa', label: 'Aizawa' },
  { value: 'thomas', label: 'Thomas' },
  { value: 'halvorsen', label: 'Halvorsen' },
  { value: 'chen', label: 'Chen' },
  { value: 'dadras', label: 'Dadras' },
  { value: 'sprott', label: 'Sprott' },
  { value: 'lorenz84', label: 'Lorenz-84' },
]

export const FLOW3D_NOTES: Record<Flow3DKind, string> = {
  lorenz: "Edward Lorenz's 1963 convection model — the original butterfly; a/b/c are σ, ρ, β.",
  rossler: 'Otto Rössler\'s spiral-and-fold — a single scroll that periodically kicks upward.',
  aizawa: 'The Aizawa system — a ribbed sphere pierced by an axial drill-hole; gorgeous in density.',
  thomas: "René Thomas's cyclically-symmetric flow — a labyrinthine 3D lattice; a is the damping.",
  halvorsen: 'Halvorsen\'s symmetric attractor — three intertwined whirls; a sets the coupling.',
  chen: 'The Chen system — a double scroll cousin of Lorenz with a richer fold.',
  dadras: 'The Dadras–Momeni attractor — broad sweeping wings.',
  sprott: 'Sprott–Linz F — one of Sprott\'s minimal chaotic flows; a delicate twisted shell.',
  lorenz84: "Lorenz's 1984 global-circulation toy model — a compact chaotic knot.",
}

// The vector field. As with the 2D maps, the four sliders a/b/c/d reshape each
// system; constants a system doesn't expose are fixed at their canonical values.
type V3 = { x: number; y: number; z: number }

function deriv(type: Flow3DKind, x: number, y: number, z: number, p: Attractor3DParams): V3 {
  const { a, b, c, d } = p
  switch (type) {
    case 'rossler':
      return { x: -y - z, y: x + a * y, z: b + z * (x - c) }
    case 'aizawa': {
      const e = 0.25
      const f = 0.1
      return {
        x: (z - b) * x - d * y,
        y: d * x + (z - b) * y,
        z: c + a * z - (z * z * z) / 3 - (x * x + y * y) * (1 + e * z) + f * z * x * x * x,
      }
    }
    case 'thomas':
      return { x: Math.sin(y) - a * x, y: Math.sin(z) - a * y, z: Math.sin(x) - a * z }
    case 'halvorsen':
      return {
        x: -a * x - 4 * y - 4 * z - y * y,
        y: -a * y - 4 * z - 4 * x - z * z,
        z: -a * z - 4 * x - 4 * y - x * x,
      }
    case 'chen':
      return { x: a * (y - x), y: (c - a) * x - x * z + c * y, z: x * y - b * z }
    case 'dadras': {
      const e = 9
      return { x: y - a * x + b * y * z, y: c * y - x * z + z, z: d * x * y - e * z }
    }
    case 'sprott':
      // Sprott–Linz F: ẋ = y + z, ẏ = −x + a·y, ż = x² − z.
      return { x: y + z, y: -x + a * y, z: x * x - z }
    case 'lorenz84':
      // a = damping, b = coupling, c = forcing F, d = forcing G.
      return {
        x: -y * y - z * z - a * (x - c),
        y: x * y - b * x * z - y + d,
        z: b * x * y + x * z - z,
      }
    case 'lorenz':
    default:
      // a = σ, b = ρ, c = β.
      return { x: a * (y - x), y: x * (b - z) - y, z: x * y - c * z }
  }
}

// One classical RK4 step of size h. RK4 is well worth its four evaluations here:
// it keeps the trajectory on the true attractor far longer than Euler at the same
// step, so the rendered nebula is sharp rather than smeared by integration error.
function rk4(type: Flow3DKind, s: V3, h: number, p: Attractor3DParams): V3 {
  const k1 = deriv(type, s.x, s.y, s.z, p)
  const k2 = deriv(type, s.x + (h / 2) * k1.x, s.y + (h / 2) * k1.y, s.z + (h / 2) * k1.z, p)
  const k3 = deriv(type, s.x + (h / 2) * k2.x, s.y + (h / 2) * k2.y, s.z + (h / 2) * k2.z, p)
  const k4 = deriv(type, s.x + h * k3.x, s.y + h * k3.y, s.z + h * k3.z, p)
  return {
    x: s.x + (h / 6) * (k1.x + 2 * k2.x + 2 * k3.x + k4.x),
    y: s.y + (h / 6) * (k1.y + 2 * k2.y + 2 * k3.y + k4.y),
    z: s.z + (h / 6) * (k1.z + 2 * k2.z + 2 * k3.z + k4.z),
  }
}

// Seed off every axis-plane: several flows (e.g. Dadras) keep y=z=0 as an
// invariant manifold whose only orbit is a fixed point, so a seed *on* it never
// reaches the attractor. A small asymmetric kick lands in the chaotic basin.
const SEED: V3 = { x: 0.1, y: 0.12, z: 0.08 }
const TRANSIENT = 1500 // steps discarded so the orbit settles onto the attractor

function reseed(): V3 {
  return { x: 0.1, y: 0.12, z: 0.08 }
}

function finite3(s: V3): boolean {
  return (
    Number.isFinite(s.x) &&
    Number.isFinite(s.y) &&
    Number.isFinite(s.z) &&
    Math.abs(s.x) < 1e6 &&
    Math.abs(s.y) < 1e6 &&
    Math.abs(s.z) < 1e6
  )
}

// Integrate the flow `count` steps after discarding the transient, calling `fn`
// with each point on the attractor. A diverging step (only reachable for exotic
// slider values) resets the orbit to the seed rather than poisoning the run —
// deterministic, like the 2D `iterateAttractor`.
export function integrateFlow(
  p: Attractor3DParams,
  count: number,
  fn: (x: number, y: number, z: number) => void,
): void {
  const type = p.type
  const h = p.dt
  let s: V3 = { ...SEED }
  for (let i = 0; i < TRANSIENT; i++) {
    const n = rk4(type, s, h, p)
    s = finite3(n) ? n : reseed()
  }
  for (let i = 0; i < count; i++) {
    const n = rk4(type, s, h, p)
    s = finite3(n) ? n : reseed()
    fn(s.x, s.y, s.z)
  }
}

// ---- orbit camera ---------------------------------------------------------
// The orbit is first centred and scaled into a unit-ish ball (so every system,
// from Aizawa's radius-1.5 to Lorenz's radius-25, sits the same size in front of
// the camera), then rotated by yaw (azimuth) and pitch (elevation) and projected
// with a pinhole perspective. `dn` is the normalised depth toward the camera,
// used by the density renderer for depth-cued brightness and colour.

export interface Projector {
  center: V3
  scale: number
  project: (x: number, y: number, z: number) => { x: number; y: number; dn: number }
}

// The centre + radius of a flow depend only on its shape (type + constants + dt),
// never the camera — so cache them by that signature. This keeps a spinning
// camera (Live / looping export builds a fresh params object every frame) from
// re-running the geometry pass each time.
interface Geometry {
  center: V3
  scale: number
}
const geomCache = new Map<string, Geometry>()

function geomSig(p: Attractor3DParams): string {
  return `${p.type}|${p.a}|${p.b}|${p.c}|${p.d}|${p.dt}`
}

function computeGeometry(p: Attractor3DParams): Geometry {
  let sx = 0
  let sy = 0
  let sz = 0
  let n = 0
  integrateFlow(p, 9000, (x, y, z) => {
    sx += x
    sy += y
    sz += z
    n++
  })
  const center: V3 = n > 0 ? { x: sx / n, y: sy / n, z: sz / n } : { x: 0, y: 0, z: 0 }
  let maxR = 1e-6
  integrateFlow(p, 9000, (x, y, z) => {
    const dx = x - center.x
    const dy = y - center.y
    const dz = z - center.z
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (r > maxR) maxR = r
  })
  return { center, scale: 1 / (maxR * 1.04) }
}

function getGeometry(p: Attractor3DParams): Geometry {
  const sig = geomSig(p)
  let g = geomCache.get(sig)
  if (!g) {
    g = computeGeometry(p)
    geomCache.set(sig, g)
  }
  return g
}

export function buildProjector(p: Attractor3DParams): Projector {
  const { center, scale } = getGeometry(p)
  const cy = Math.cos(p.yaw)
  const sy = Math.sin(p.yaw)
  const cp = Math.cos(p.pitch)
  const sp = Math.sin(p.pitch)
  const f = 1 / Math.tan(Math.max(0.2, Math.min(2.8, p.fov)) / 2)
  const dist = Math.max(1.6, p.dist)
  const project = (x: number, y: number, z: number) => {
    const nx = (x - center.x) * scale
    const ny = (y - center.y) * scale
    const nz = (z - center.z) * scale
    // yaw about the world up-axis (y), then pitch about the camera's right (x).
    const x1 = nx * cy + nz * sy
    const z1 = -nx * sy + nz * cy
    const y1 = ny
    const y2 = y1 * cp - z1 * sp
    const z2 = y1 * sp + z1 * cp
    let viewZ = dist - z2
    if (viewZ < 0.1) viewZ = 0.1
    const px = (x1 * f) / viewZ
    const py = (-y2 * f) / viewZ
    // z2 ∈ ~[-1, 1] (unit ball); map to [0,1] with 1 = nearest the camera.
    let dn = (z2 + 1) / 2
    dn = dn < 0 ? 0 : dn > 1 ? 1 : dn
    return { x: px, y: py, dn }
  }
  return { center, scale, project }
}

// Trace the flow into a projected 2D polyline — the `line` render style and the
// auto-fit framing both consume this. Connecting consecutive points is genuinely
// meaningful here (unlike the chaotic *maps*, whose successive iterates are far
// apart): the result is a smooth 3D ribbon of the trajectory.
export function sample3DPolyline(p: Attractor3DParams): Point[] {
  const proj = buildProjector(p)
  const n = Math.max(2, p.steps)
  const pts: Point[] = new Array(n)
  let i = 0
  integrateFlow(p, n, (x, y, z) => {
    const pr = proj.project(x, y, z)
    pts[i++] = { x: pr.x, y: pr.y }
  })
  return pts
}

// ---- defaults / randomisers ----------------------------------------------
// Each flow keeps its own canonical constants *and* a stable integration step:
// the stiffer systems (Chen, Lorenz) need a smaller `dt` than the gentle ones
// (Thomas, Aizawa) to stay on the attractor.

const CAMERA = { yaw: 0.7, pitch: 0.42, dist: 2.6, fov: 1.0, depthCue: true, spin: 0.6 }

export function defaultsFor3D(type: Flow3DKind): Attractor3DParams {
  const cam = { ...CAMERA }
  switch (type) {
    case 'rossler':
      return { type, a: 0.2, b: 0.2, c: 5.7, d: 0, dt: 0.02, steps: 18000, ...cam }
    case 'aizawa':
      return { type, a: 0.95, b: 0.7, c: 0.6, d: 3.5, dt: 0.01, steps: 20000, ...cam }
    case 'thomas':
      return { type, a: 0.208, b: 0, c: 0, d: 0, dt: 0.025, steps: 20000, ...cam }
    case 'halvorsen':
      return { type, a: 1.4, b: 0, c: 0, d: 0, dt: 0.005, steps: 18000, ...cam }
    case 'chen':
      return { type, a: 35, b: 3, c: 28, d: 0, dt: 0.003, steps: 18000, ...cam }
    case 'dadras':
      return { type, a: 3, b: 2.7, c: 1.7, d: 2, dt: 0.01, steps: 18000, ...cam }
    case 'sprott':
      return { type, a: 0.5, b: 0, c: 0, d: 0, dt: 0.02, steps: 20000, ...cam }
    case 'lorenz84':
      return { type, a: 0.25, b: 4, c: 8, d: 1, dt: 0.01, steps: 20000, ...cam }
    case 'lorenz':
    default:
      return { type, a: 10, b: 28, c: 2.667, d: 0, dt: 0.006, steps: 18000, ...cam }
  }
}

export function default3D(): Attractor3DParams {
  return defaultsFor3D('lorenz')
}

export function random3D(): Attractor3DParams {
  const type = pick<Flow3DKind>(FLOW3D_KINDS.map((k) => k.value))
  const base = defaultsFor3D(type)
  // Jitter the constants gently around their canonical values — enough to reshape
  // the wings without knocking the system off chaos into a fixed point/limit cycle.
  const jit = (v: number, frac: number) => v + rand(-frac, frac) * (Math.abs(v) + 0.4)
  return {
    ...base,
    a: jit(base.a, 0.06),
    b: jit(base.b, 0.06),
    c: jit(base.c, 0.06),
    d: jit(base.d, 0.06),
    yaw: rand(0, Math.PI * 2),
    pitch: rand(0.15, 0.7),
    depthCue: true,
  }
}

// Slider ranges per flow — tight windows around the canonical constants so the
// system stays chaotic and on-screen rather than collapsing or diverging.
export function ranges3D(type: Flow3DKind): {
  a: [number, number]
  b: [number, number]
  c: [number, number]
  d: [number, number]
  used: { a: boolean; b: boolean; c: boolean; d: boolean }
} {
  switch (type) {
    case 'rossler':
      return { a: [0.1, 0.4], b: [0.1, 0.4], c: [3, 9], d: [0, 0], used: u(1, 1, 1, 0) }
    case 'aizawa':
      return { a: [0.7, 1.1], b: [0.4, 1], c: [0.4, 0.9], d: [3, 4], used: u(1, 1, 1, 1) }
    case 'thomas':
      return { a: [0.1, 0.33], b: [0, 0], c: [0, 0], d: [0, 0], used: u(1, 0, 0, 0) }
    case 'halvorsen':
      return { a: [1.1, 1.7], b: [0, 0], c: [0, 0], d: [0, 0], used: u(1, 0, 0, 0) }
    case 'chen':
      return { a: [30, 40], b: [2, 4], c: [22, 30], d: [0, 0], used: u(1, 1, 1, 0) }
    case 'dadras':
      return { a: [2, 4], b: [2, 3.5], c: [1.2, 2.2], d: [1.5, 2.5], used: u(1, 1, 1, 1) }
    case 'sprott':
      return { a: [0.3, 0.7], b: [0, 0], c: [0, 0], d: [0, 0], used: u(1, 0, 0, 0) }
    case 'lorenz84':
      return { a: [0.15, 0.4], b: [3, 5], c: [6, 10], d: [0.5, 1.5], used: u(1, 1, 1, 1) }
    case 'lorenz':
    default:
      return { a: [6, 16], b: [22, 34], c: [1.5, 4], d: [0, 0], used: u(1, 1, 1, 0) }
  }
}

function u(a: number, b: number, c: number, d: number) {
  return { a: !!a, b: !!b, c: !!c, d: !!d }
}
