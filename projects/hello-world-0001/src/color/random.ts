// A seeded RNG plus a "muse": a generator that produces tasteful gradients. The trick is to work
// in Oklch — pick a base hue, lightness and chroma, then offset within sensible perceptual bounds.
// Because Oklch lightness is perceptually uniform, two stops a fixed ΔL apart always read as an
// even step, and hues never collapse into mud the way random sRGB values do.

import { clamp01, oklchToRgb, clampRgb } from './convert'
import type { Gradient, GradientType, InterpSpace, RGBA, Stop } from './types'

/** mulberry32 — tiny, fast, deterministic. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

let idCounter = 0
export function makeStopId(): string {
  idCounter += 1
  return `s${Date.now().toString(36)}${idCounter.toString(36)}`
}

/** A single tasteful color (random hue, mid lightness/chroma) — kept here so component code never
 *  calls the impure Math.random directly. */
export function randomPleasantColor(): RGBA {
  const rgb = clampRgb(oklchToRgb({ L: 0.6, C: 0.13, h: Math.random() * 360 }))
  return { ...rgb, a: 1 }
}

function oklchStop(L: number, C: number, h: number, pos: number): Stop {
  const rgb = clampRgb(oklchToRgb({ L: clamp01(L), C: Math.max(0, C), h }))
  const color: RGBA = { ...rgb, a: 1 }
  return { id: makeStopId(), color, pos: clamp01(pos) }
}

const SPACES: InterpSpace[] = ['oklch', 'oklab', 'oklch', 'oklch', 'lch']
const TYPES: GradientType[] = ['linear', 'linear', 'linear', 'radial', 'conic']

/** A pleasant random gradient. Deterministic in `seed`. */
export function museGradient(seed: number): Gradient {
  const rng = makeRng(seed)
  const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]

  const baseHue = rng() * 360
  // hue spread: sometimes analogous, sometimes a wide sweep
  const spread = pick([20, 40, 60, 90, 140, 200])
  const dir = rng() < 0.5 ? 1 : -1
  const nStops = 2 + Math.floor(rng() * 3) // 2..4
  const baseChroma = 0.08 + rng() * 0.16
  const loL = 0.35 + rng() * 0.2
  const hiL = 0.75 + rng() * 0.2

  const stops: Stop[] = []
  for (let i = 0; i < nStops; i++) {
    const f = nStops === 1 ? 0 : i / (nStops - 1)
    const h = baseHue + dir * spread * f
    const L = loL + (hiL - loL) * f + (rng() - 0.5) * 0.05
    const C = baseChroma * (0.7 + 0.6 * Math.sin(Math.PI * f)) // peak chroma mid-ramp
    stops.push(oklchStop(L, C, h, f))
  }

  return {
    type: pick(TYPES),
    angle: Math.floor(rng() * 360),
    cx: 0.3 + rng() * 0.4,
    cy: 0.3 + rng() * 0.4,
    space: pick(SPACES),
    hue: 'shorter',
    stops,
  }
}
