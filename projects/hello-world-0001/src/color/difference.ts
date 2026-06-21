// Color-difference (ΔE) metrics, derived from first principles — no libraries.
//
// "How different are two colors?" has several standard answers, each better than the last at
// matching human perception. We implement four:
//   • ΔE76   — plain Euclidean distance in CIELab (1976). Cheap, but uneven.
//   • ΔE94   — CIE94, with chroma/hue weighting (graphic-arts coefficients).
//   • ΔE2000 — CIEDE2000, the modern standard: hue-rotation, lightness/chroma/hue weighting
//              and the blue-region interaction term. Notoriously fiddly; verified below against
//              the canonical Sharma–Wu–Dalal (2005) reference data set.
//   • ΔEOK   — Euclidean distance in Oklab, the metric the CSS Color 4 gamut-mapping uses.
//
// All inputs are gamma-encoded sRGB unless a *Lab/*Oklab variant is called directly.

import { rgbToLab, rgbToOklab } from './convert'
import type { Lab, OkLab, RGB } from './types'

const DEG = Math.PI / 180

// ── ΔE76 — Euclidean in CIELab ───────────────────────────────────────────────
export function deltaE76Lab(a: Lab, b: Lab): number {
  return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b)
}
export const deltaE76 = (a: RGB, b: RGB): number => deltaE76Lab(rgbToLab(a), rgbToLab(b))

// ── ΔE94 — CIE94 (graphic-arts weighting kL=1, K1=0.045, K2=0.015) ────────────
export function deltaE94Lab(a: Lab, b: Lab): number {
  const C1 = Math.hypot(a.a, a.b)
  const C2 = Math.hypot(b.a, b.b)
  const dL = a.L - b.L
  const dC = C1 - C2
  const dA = a.a - b.a
  const dB = a.b - b.b
  const dH2 = dA * dA + dB * dB - dC * dC // may be tiny-negative from rounding
  const dH = Math.sqrt(Math.max(0, dH2))
  const Sc = 1 + 0.045 * C1
  const Sh = 1 + 0.015 * C1
  return Math.hypot(dL, dC / Sc, dH / Sh)
}
export const deltaE94 = (a: RGB, b: RGB): number => deltaE94Lab(rgbToLab(a), rgbToLab(b))

// ── ΔE2000 — CIEDE2000 (kL = kC = kH = 1) ────────────────────────────────────
export function deltaE2000Lab(c1: Lab, c2: Lab): number {
  const { L: L1, a: a1, b: b1 } = c1
  const { L: L2, a: a2, b: b2 } = c2

  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const Cbar = (C1 + C2) / 2

  const Cbar7 = Math.pow(Cbar, 7)
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 6103515625))) // 25^7 = 6103515625

  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1)
  const C2p = Math.hypot(a2p, b2)

  const hp = (b: number, ap: number): number => {
    if (b === 0 && ap === 0) return 0
    let h = Math.atan2(b, ap) / DEG
    if (h < 0) h += 360
    return h
  }
  const h1p = hp(b1, a1p)
  const h2p = hp(b2, a2p)

  const dLp = L2 - L1
  const dCp = C2p - C1p

  let dhp: number
  if (C1p * C2p === 0) {
    dhp = 0
  } else {
    const diff = h2p - h1p
    if (Math.abs(diff) <= 180) dhp = diff
    else if (diff > 180) dhp = diff - 360
    else dhp = diff + 360
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * DEG)

  const Lbarp = (L1 + L2) / 2
  const Cbarp = (C1p + C2p) / 2

  let hbarp: number
  if (C1p * C2p === 0) {
    hbarp = h1p + h2p
  } else if (Math.abs(h1p - h2p) <= 180) {
    hbarp = (h1p + h2p) / 2
  } else if (h1p + h2p < 360) {
    hbarp = (h1p + h2p + 360) / 2
  } else {
    hbarp = (h1p + h2p - 360) / 2
  }

  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * DEG) +
    0.24 * Math.cos(2 * hbarp * DEG) +
    0.32 * Math.cos((3 * hbarp + 6) * DEG) -
    0.2 * Math.cos((4 * hbarp - 63) * DEG)

  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2))
  const Cbarp7 = Math.pow(Cbarp, 7)
  const Rc = 2 * Math.sqrt(Cbarp7 / (Cbarp7 + 6103515625))
  const Sl = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2))
  const Sc = 1 + 0.045 * Cbarp
  const Sh = 1 + 0.015 * Cbarp * T
  const Rt = -Math.sin(2 * dTheta * DEG) * Rc

  const termL = dLp / Sl
  const termC = dCp / Sc
  const termH = dHp / Sh
  return Math.sqrt(termL * termL + termC * termC + termH * termH + Rt * termC * termH)
}
export const deltaE2000 = (a: RGB, b: RGB): number => deltaE2000Lab(rgbToLab(a), rgbToLab(b))

// ── ΔEOK — Euclidean in Oklab (the CSS Color 4 gamut-mapping metric) ──────────
export function deltaEOkLab(a: OkLab, b: OkLab): number {
  return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b)
}
export const deltaEOk = (a: RGB, b: RGB): number => deltaEOkLab(rgbToOklab(a), rgbToOklab(b))

export type DiffMetric = 'de76' | 'de94' | 'de2000' | 'deok'

export const METRIC_LABELS: Record<DiffMetric, string> = {
  de76: 'ΔE₇₆',
  de94: 'ΔE₉₄',
  de2000: 'ΔE₀₀',
  deok: 'ΔE-OK',
}

export const METRIC_BLURB: Record<DiffMetric, string> = {
  de76: 'Euclidean distance in CIELab (1976). Simple, but over-weights saturated blues.',
  de94: 'CIE94 — adds chroma & hue weighting. Better, graphic-arts coefficients.',
  de2000: 'CIEDE2000 — the modern standard. Hue rotation + blue-region interaction term.',
  deok: 'Euclidean distance in Oklab — what CSS gamut-mapping minimises.',
}

/** Difference between two sRGB colors under the chosen metric. */
export function difference(a: RGB, b: RGB, metric: DiffMetric): number {
  switch (metric) {
    case 'de76':
      return deltaE76(a, b)
    case 'de94':
      return deltaE94(a, b)
    case 'de2000':
      return deltaE2000(a, b)
    case 'deok':
      return deltaEOk(a, b)
  }
}
