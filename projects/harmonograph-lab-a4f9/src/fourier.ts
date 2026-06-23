// The Fourier / epicycle engine — the eighth curve family (v9).
//
// A harmonograph is *synthesis*: pile up a few sinusoids and a figure emerges.
// This module is the other half of the story — *analysis*. Hand it a closed
// shape and a from-scratch complex Discrete Fourier Transform decomposes it into
// a chain of rotating vectors (epicycles): each a signed harmonic frequency `k`,
// an amplitude (the circle's radius) and a starting phase. Summing the first `K`
// of them (sorted by amplitude) is the provably-optimal K-term least-squares
// approximation of the shape — so a "harmonics" slider becomes a live tour of
// Fourier convergence, Gibbs ringing and all.
//
// Everything here is pure and DOM-free: it emits the same plain model-space
// points (`{x, y}`) the rest of the studio's pipeline consumes, so a Fourier
// layer inherits every colour mode, glow, kaleidoscope, Live drift and export
// path for free. The renderer additionally asks for the *chain* of vector tips
// (`chainAt`) to draw the famous nested-circles overlay.

import type { Point } from './harmonograph'
import type { FourierParams } from './types'

const TWO_PI = Math.PI * 2

// The number of samples taken around each shape and, equivalently, the number of
// epicycles the DFT produces. 512 is plenty to resolve the sharp corners (the
// square/triangle Gibbs demos) while keeping the O(N²) transform instant and
// cached.
export const FOURIER_N = 512

// The harmonics slider tops out here — well past the point where even the
// sharp-cornered shapes have visually converged, but bounded so the epicycle
// overlay stays legible and the chain cheap to draw.
export const FOURIER_MAX_HARMONICS = 256

interface Complex {
  re: number
  im: number
}

// One rotating vector. `freq` is the signed harmonic index (…,-2,-1,0,1,2,…);
// `amp` is the vector length in model units; `phase` its angle at draw-param 0.
export interface Epicycle {
  freq: number
  amp: number
  phase: number
}

// ---- shape library --------------------------------------------------------
// Each shape is a closed loop returned as `FOURIER_N` complex samples, walked
// once around at a roughly even parameter and centred on the origin. Smooth
// curves are sampled parametrically; the sharp polygons are authored as a handful
// of corner vertices and resampled uniformly by arc length so the corners (where
// Fourier convergence is most dramatic) land cleanly.

export interface ShapeDef {
  value: string
  label: string
}

export const FOURIER_SHAPES: ShapeDef[] = [
  { value: 'heart', label: 'Heart' },
  { value: 'star', label: 'Star' },
  { value: 'square', label: 'Square' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'pentagon', label: 'Pentagon' },
  { value: 'infinity', label: 'Infinity' },
  { value: 'flower', label: 'Flower' },
  { value: 'gear', label: 'Gear' },
  { value: 'moth', label: 'Moth' },
  { value: 'blob', label: 'Blob' },
]

// Sample a smooth parametric loop `f(t)`, t over [0, 2π), into N points.
function sampleParam(f: (t: number) => Point, n: number): Point[] {
  const pts: Point[] = new Array(n)
  for (let i = 0; i < n; i++) pts[i] = f((i / n) * TWO_PI)
  return pts
}

// Resample a closed polyline (list of corner vertices, implicitly wrapping back
// to the first) into N points spaced uniformly along its perimeter. This is what
// gives the polygons their crisp, evenly-distributed corners.
function resamplePolygon(verts: Point[], n: number): Point[] {
  const m = verts.length
  const seg: number[] = new Array(m) // length of edge i → i+1
  let total = 0
  for (let i = 0; i < m; i++) {
    const a = verts[i]
    const b = verts[(i + 1) % m]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    seg[i] = len
    total += len
  }
  const out: Point[] = new Array(n)
  const step = total / n
  let edge = 0
  let acc = 0 // perimeter distance at the start of the current edge
  for (let i = 0; i < n; i++) {
    const d = i * step
    while (edge < m - 1 && acc + seg[edge] < d) {
      acc += seg[edge]
      edge++
    }
    const a = verts[edge]
    const b = verts[(edge + 1) % m]
    const u = seg[edge] > 1e-12 ? (d - acc) / seg[edge] : 0
    out[i] = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }
  }
  return out
}

// Regular polygon with `k` vertices, optionally rotated so it sits upright.
function regularPolygon(k: number, radius: number, rot: number): Point[] {
  const verts: Point[] = new Array(k)
  for (let i = 0; i < k; i++) {
    const a = rot + (i / k) * TWO_PI
    verts[i] = { x: radius * Math.cos(a), y: radius * Math.sin(a) }
  }
  return verts
}

// Alternating outer/inner radius star with `k` points.
function starPolygon(k: number, outer: number, inner: number, rot: number): Point[] {
  const verts: Point[] = new Array(k * 2)
  for (let i = 0; i < k * 2; i++) {
    const r = i % 2 === 0 ? outer : inner
    const a = rot + (i / (k * 2)) * TWO_PI
    verts[i] = { x: r * Math.cos(a), y: r * Math.sin(a) }
  }
  return verts
}

function rawShape(id: string): Point[] {
  const n = FOURIER_N
  switch (id) {
    case 'heart':
      // The classic parametric heart, scaled into the model box and y-flipped so
      // it points up in canvas coordinates (y grows downward on a <canvas>).
      return sampleParam((t) => {
        const x = 16 * Math.pow(Math.sin(t), 3)
        const y =
          13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)
        return { x: x / 17, y: -y / 17 }
      }, n)
    case 'star':
      return resamplePolygon(starPolygon(5, 1, 0.42, -Math.PI / 2), n)
    case 'square':
      return resamplePolygon(regularPolygon(4, 1, Math.PI / 4), n)
    case 'triangle':
      return resamplePolygon(regularPolygon(3, 1, -Math.PI / 2), n)
    case 'pentagon':
      return resamplePolygon(regularPolygon(5, 1, -Math.PI / 2), n)
    case 'infinity':
      // Lemniscate of Gerono — a clean figure-eight closed over one period.
      return sampleParam((t) => ({ x: Math.cos(t), y: Math.sin(t) * Math.cos(t) }), n)
    case 'flower':
      // A six-petal rhodonea-style closed bloom (radius never crosses zero, so it
      // stays a single embracing loop rather than discrete petals).
      return sampleParam((t) => {
        const r = 0.62 + 0.38 * Math.cos(6 * t)
        return { x: r * Math.cos(t), y: r * Math.sin(t) }
      }, n)
    case 'gear':
      // A cog: a base circle with smoothed square teeth. The near-discontinuous
      // tooth flanks are a second great Gibbs-ringing demo.
      return sampleParam((t) => {
        const tooth = Math.tanh(3.2 * Math.sin(12 * t))
        const r = 0.78 + 0.16 * tooth
        return { x: r * Math.cos(t), y: r * Math.sin(t) }
      }, n)
    case 'moth':
      // A winged closed curve in the spirit of Fay's butterfly, tamed to close in
      // a single 2π turn.
      return sampleParam((t) => {
        const r = 0.5 + 0.35 * Math.sin(2 * t) * Math.sin(2 * t) + 0.2 * Math.cos(4 * t)
        return { x: r * Math.sin(t), y: -Math.abs(r) * Math.cos(t) * 0.95 }
      }, n)
    case 'blob':
    default:
      // A smooth, asymmetric blob from a few summed low harmonics — a friendly
      // organic default that converges with very few epicycles.
      return sampleParam((t) => {
        const r =
          0.7 +
          0.18 * Math.cos(2 * t + 0.6) +
          0.1 * Math.sin(3 * t) +
          0.06 * Math.cos(5 * t - 1.1)
        return { x: r * Math.cos(t), y: r * Math.sin(t) }
      }, n)
  }
}

// ---- the discrete Fourier transform ---------------------------------------

// Decompose N complex samples into N epicycles. Frequency `k` runs 0..N-1 but is
// re-centred to the signed range (-N/2, N/2] so the nested overlay pairs +k/-k
// circles symmetrically. Amplitude is |X_k|/N (the inverse-DFT normalisation),
// phase is its argument. The result is sorted by amplitude descending, so taking
// the first K entries is the best K-term least-squares approximation.
export function dft(samples: Point[]): Epicycle[] {
  const N = samples.length
  const eps: Epicycle[] = new Array(N)
  for (let k = 0; k < N; k++) {
    const sum: Complex = { re: 0, im: 0 }
    for (let n = 0; n < N; n++) {
      const phi = (-TWO_PI * k * n) / N
      const c = Math.cos(phi)
      const s = Math.sin(phi)
      // (samples[n].x + i·samples[n].y) · (cos φ + i·sin φ)
      sum.re += samples[n].x * c - samples[n].y * s
      sum.im += samples[n].x * s + samples[n].y * c
    }
    const amp = Math.hypot(sum.re, sum.im) / N
    const phase = Math.atan2(sum.im, sum.re)
    const freq = k <= N / 2 ? k : k - N
    eps[k] = { freq, amp, phase }
  }
  eps.sort((a, b) => b.amp - a.amp)
  return eps
}

// Epicycle sets are pure functions of the shape id → memoise them (the O(N²)
// transform then runs at most once per shape for the whole session).
const epicycleCache = new Map<string, Epicycle[]>()

// The N centred samples of a shape — mean-subtracted so the DC (k = 0) term is
// ~0, which makes a global phase offset a clean rigid rotation about the origin
// (every coefficient × e^{iδ}). Exposed so the self-tests can prove the inverse
// DFT reproduces exactly these samples.
export function shapeSamples(id: string): Point[] {
  const raw = rawShape(id)
  let mx = 0
  let my = 0
  for (const p of raw) {
    mx += p.x
    my += p.y
  }
  mx /= raw.length
  my /= raw.length
  return raw.map((p) => ({ x: p.x - mx, y: p.y - my }))
}

export function epicyclesForShape(id: string): Epicycle[] {
  let eps = epicycleCache.get(id)
  if (!eps) {
    eps = dft(shapeSamples(id))
    epicycleCache.set(id, eps)
  }
  return eps
}

// The inverse DFT, evaluated at draw-parameter `u ∈ [0, 1)`, summing the first
// `k` epicycles. `delta` is a global phase added to every term — i.e. a rigid
// rotation of the whole figure by `delta` radians (used by Live / looping drift).
export function reconstructAt(eps: Epicycle[], k: number, u: number, delta: number): Point {
  const lim = Math.min(k, eps.length)
  let x = 0
  let y = 0
  for (let i = 0; i < lim; i++) {
    const e = eps[i]
    const ang = TWO_PI * e.freq * u + e.phase + delta
    x += e.amp * Math.cos(ang)
    y += e.amp * Math.sin(ang)
  }
  return { x, y }
}

// The chain of vector tips for the nested-circles overlay: start at the origin,
// then add each used epicycle in order of |freq| (the classic nested look — the
// sum is order-independent so this never changes the traced point). Returns
// `lim + 1` points; the last is the pen tip and equals `reconstructAt`.
export function chainAt(eps: Epicycle[], k: number, u: number, delta: number): Point[] {
  const lim = Math.min(k, eps.length)
  const used = eps.slice(0, lim).sort((a, b) => Math.abs(a.freq) - Math.abs(b.freq))
  const out: Point[] = new Array(lim + 1)
  let x = 0
  let y = 0
  out[0] = { x, y }
  for (let i = 0; i < lim; i++) {
    const e = used[i]
    const ang = TWO_PI * e.freq * u + e.phase + delta
    x += e.amp * Math.cos(ang)
    y += e.amp * Math.sin(ang)
    out[i + 1] = { x, y }
  }
  return out
}

// ---- the curve-family sampler ---------------------------------------------

export function sampleFourier(p: FourierParams): Point[] {
  const eps = epicyclesForShape(p.shape)
  const k = Math.max(1, Math.min(Math.round(p.harmonics), eps.length))
  const n = Math.max(2, p.steps)
  const pts: Point[] = new Array(n + 1)
  for (let i = 0; i <= n; i++) {
    pts[i] = reconstructAt(eps, k, i / n, p.phase)
  }
  return pts
}

export function defaultFourier(): FourierParams {
  return { shape: 'heart', harmonics: 48, phase: 0, epicycles: true, steps: 4000 }
}

const SHAPE_IDS = FOURIER_SHAPES.map((s) => s.value)

export function randomFourier(): FourierParams {
  const shape = SHAPE_IDS[Math.floor(Math.random() * SHAPE_IDS.length)]
  // Bias toward modest harmonic counts so the random piece reads as a recognisable
  // (slightly soft) Fourier sketch rather than a pixel-perfect outline.
  const harmonics = 6 + Math.floor(Math.random() * 60)
  return { shape, harmonics, phase: Math.random() * TWO_PI, epicycles: true, steps: 4000 }
}
