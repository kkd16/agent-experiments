// The epicycle machine: parametric preset paths, arc-length resampling, and the
// Fourier decomposition of a closed 2D curve into rotating vectors.
//
// A closed path is a sequence of points (x, y). Treating each point as a complex
// number z = x + iy and running an FFT gives a set of complex coefficients. Each
// coefficient becomes an "epicycle": a rotating vector of a fixed frequency,
// amplitude, and starting phase. Summing them (largest first) traces the curve.

import { makeComplex } from './complex'
import { transform, nextPow2 } from './fft'

export interface Point {
  x: number
  y: number
}

export interface Epicycle {
  freq: number // integer rotation frequency (cycles per full loop, can be negative)
  amp: number // radius of this vector
  phase: number // starting angle (radians)
}

// ---------------------------------------------------------------------------
// Preset paths. Each returns points on a unit-ish scale centered at the origin;
// the renderer scales them to the canvas. Parameter u runs 0..1.
// ---------------------------------------------------------------------------

export type PresetName =
  | 'star'
  | 'heart'
  | 'infinity'
  | 'flower'
  | 'gear'
  | 'spiral'
  | 'butterfly'
  | 'treble'

export const PRESETS: { id: PresetName; label: string }[] = [
  { id: 'star', label: 'Star' },
  { id: 'heart', label: 'Heart' },
  { id: 'infinity', label: 'Infinity' },
  { id: 'flower', label: 'Flower' },
  { id: 'gear', label: 'Gear' },
  { id: 'spiral', label: 'Spiral' },
  { id: 'butterfly', label: 'Butterfly' },
  { id: 'treble', label: 'Treble clef' },
]

function samplePreset(name: PresetName, count: number): Point[] {
  const pts: Point[] = []
  for (let i = 0; i < count; i++) {
    const u = i / count
    const a = 2 * Math.PI * u
    let x = 0
    let y = 0
    switch (name) {
      case 'star': {
        const spikes = 5
        const r = 1 + 0.55 * Math.cos(spikes * a)
        x = r * Math.cos(a)
        y = r * Math.sin(a)
        break
      }
      case 'heart': {
        x = 16 * Math.sin(a) ** 3
        y = 13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)
        x /= 16
        y /= 16
        break
      }
      case 'infinity': {
        const s = Math.sin(a)
        const c = Math.cos(a)
        const d = 1 + s * s
        x = (1.4 * c) / d
        y = (1.4 * s * c) / d
        break
      }
      case 'flower': {
        const k = 4
        const r = Math.cos(k * a)
        x = r * Math.cos(a)
        y = r * Math.sin(a)
        break
      }
      case 'gear': {
        const teeth = 12
        const r = 1 + 0.18 * Math.sign(Math.sin(teeth * a))
        x = r * Math.cos(a)
        y = r * Math.sin(a)
        break
      }
      case 'spiral': {
        // A double spiral out and back so the path closes.
        const t = u < 0.5 ? u * 2 : (1 - u) * 2
        const turns = 3
        const ang = 2 * Math.PI * turns * t + (u < 0.5 ? 0 : Math.PI)
        const rr = 0.15 + 0.85 * t
        x = rr * Math.cos(ang)
        y = rr * Math.sin(ang)
        break
      }
      case 'butterfly': {
        const e = Math.exp(Math.cos(a)) - 2 * Math.cos(4 * a) - Math.sin(a / 12) ** 5
        x = Math.sin(a) * e
        y = Math.cos(a) * e
        x /= 3.5
        y /= 3.5
        break
      }
      case 'treble': {
        // A stylized clef-like curve from a couple of superimposed harmonics.
        x = Math.sin(a) + 0.5 * Math.sin(3 * a + 0.4) + 0.2 * Math.cos(2 * a)
        y = 1.4 * Math.cos(a) - 0.5 * Math.cos(2 * a) + 0.3 * Math.sin(3 * a)
        x /= 1.8
        y /= 1.8
        break
      }
    }
    pts.push({ x, y })
  }
  return pts
}

/** Public: sample a preset to the requested resolution and normalize its scale. */
export function presetPath(name: PresetName, count = 512): Point[] {
  return normalizePath(samplePreset(name, count))
}

// ---------------------------------------------------------------------------
// Path processing.
// ---------------------------------------------------------------------------

/** Center a path on its centroid and scale so its max extent is ~1. */
export function normalizePath(pts: Point[]): Point[] {
  if (pts.length === 0) return pts
  let cx = 0
  let cy = 0
  for (const p of pts) {
    cx += p.x
    cy += p.y
  }
  cx /= pts.length
  cy /= pts.length
  let max = 1e-9
  for (const p of pts) {
    max = Math.max(max, Math.abs(p.x - cx), Math.abs(p.y - cy))
  }
  return pts.map((p) => ({ x: (p.x - cx) / max, y: (p.y - cy) / max }))
}

/**
 * Resample a path to exactly `count` points evenly spaced by arc length. This
 * makes the Fourier coefficients depend on the shape, not on how fast the pen
 * moved while drawing it.
 */
export function resamplePath(pts: Point[], count: number): Point[] {
  if (pts.length < 2) return pts.slice()
  // Cumulative arc length (closing the loop).
  const closed = [...pts, pts[0]]
  const cum: number[] = [0]
  for (let i = 1; i < closed.length; i++) {
    const dx = closed[i].x - closed[i - 1].x
    const dy = closed[i].y - closed[i - 1].y
    cum.push(cum[i - 1] + Math.hypot(dx, dy))
  }
  const total = cum[cum.length - 1]
  if (total < 1e-9) return pts.slice(0, 1)
  const out: Point[] = []
  let seg = 0
  for (let i = 0; i < count; i++) {
    const target = (i / count) * total
    while (seg < cum.length - 2 && cum[seg + 1] < target) seg++
    const segLen = cum[seg + 1] - cum[seg] || 1e-9
    const f = (target - cum[seg]) / segLen
    out.push({
      x: closed[seg].x + (closed[seg + 1].x - closed[seg].x) * f,
      y: closed[seg].y + (closed[seg + 1].y - closed[seg].y) * f,
    })
  }
  return out
}

/**
 * Fourier-decompose a closed path into epicycles, sorted by amplitude (largest
 * first). The path is arc-length resampled to a power of two so the fast FFT can
 * do the work.
 */
export function computeEpicycles(pts: Point[]): Epicycle[] {
  if (pts.length < 2) return []
  const n = Math.min(1024, Math.max(64, nextPow2(pts.length)))
  const rs = resamplePath(pts, n)
  const z = makeComplex(n)
  for (let i = 0; i < n; i++) {
    z.re[i] = rs[i].x
    z.im[i] = rs[i].y
  }
  const spec = transform(z, false)
  const cycles: Epicycle[] = []
  for (let k = 0; k < n; k++) {
    const re = spec.re[k] / n
    const im = spec.im[k] / n
    // Map bin index to a signed frequency so vectors spin the natural way.
    const freq = k <= n / 2 ? k : k - n
    cycles.push({ freq, amp: Math.hypot(re, im), phase: Math.atan2(im, re) })
  }
  cycles.sort((a, b) => b.amp - a.amp)
  return cycles
}

/**
 * Evaluate the epicycle chain at parameter t in [0, 1), returning both the final
 * traced point and every intermediate vector tip (for drawing the chain of
 * circles). Only the first `count` epicycles are used.
 */
export function epicyclePositions(
  cycles: Epicycle[],
  t: number,
  count: number,
): { tips: Point[]; end: Point } {
  const tips: Point[] = []
  let x = 0
  let y = 0
  const n = Math.min(count, cycles.length)
  for (let i = 0; i < n; i++) {
    const c = cycles[i]
    const angle = 2 * Math.PI * c.freq * t + c.phase
    x += c.amp * Math.cos(angle)
    y += c.amp * Math.sin(angle)
    tips.push({ x, y })
  }
  return { tips, end: { x, y } }
}
