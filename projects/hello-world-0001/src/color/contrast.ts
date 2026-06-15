// Contrast metrics. WCAG 2.1 (the legal/AA-AAA standard) plus an APCA-style lightness contrast
// (the newer, perceptually-tuned model used by WCAG 3 drafts). Both from scratch.

import { rgbToLinear } from './convert'
import type { RGB } from './types'

/** WCAG relative luminance: linearize, then weight by the luminous-efficiency coefficients. */
export function relativeLuminance(rgb: RGB): number {
  const { r, g, b } = rgbToLinear(rgb)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.1 contrast ratio, 1..21. */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

export type WcagLevel = 'AAA' | 'AA' | 'AA Large' | 'Fail'

export function wcagLevel(ratio: number): WcagLevel {
  if (ratio >= 7) return 'AAA'
  if (ratio >= 4.5) return 'AA'
  if (ratio >= 3) return 'AA Large'
  return 'Fail'
}

// ── APCA (Accessible Perceptual Contrast Algorithm), 0.1.9-style ──────────────
// Returns a signed Lc value, roughly -108..106. |Lc| ≥ 60 ≈ body text; ≥ 75 ≈ comfortable.
const SA = 0.2126729
const SG = 0.7151522
const SB = 0.072175
const TRC = 2.4

function apcaY(rgb: RGB): number {
  const lin = (c: number) => Math.pow(Math.max(0, c), TRC)
  return SA * lin(rgb.r) + SG * lin(rgb.g) + SB * lin(rgb.b)
}

export function apcaLc(text: RGB, bg: RGB): number {
  const Ytxt0 = apcaY(text)
  const Ybg0 = apcaY(bg)
  // soft black clamp
  const blkThrs = 0.022
  const blkClmp = 1.414
  const clampBlack = (y: number) => (y > blkThrs ? y : y + Math.pow(blkThrs - y, blkClmp))
  const Ytxt = clampBlack(Ytxt0)
  const Ybg = clampBlack(Ybg0)
  if (Math.abs(Ybg - Ytxt) < 0.0005) return 0

  const scaleBoW = 1.14
  const scaleWoB = 1.14
  const loBoWoffset = 0.027
  const loWoBoffset = 0.027
  let outputContrast: number
  if (Ybg > Ytxt) {
    // normal polarity: dark text on light bg
    const C = (Math.pow(Ybg, 0.56) - Math.pow(Ytxt, 0.57)) * scaleBoW
    outputContrast = C < 0.1 ? 0 : C - loBoWoffset
  } else {
    // reverse polarity: light text on dark bg
    const C = (Math.pow(Ybg, 0.65) - Math.pow(Ytxt, 0.62)) * scaleWoB
    outputContrast = C > -0.1 ? 0 : C + loWoBoffset
  }
  return outputContrast * 100
}

export function apcaRating(lc: number): string {
  const a = Math.abs(lc)
  if (a >= 90) return 'Lc 90+ · any text'
  if (a >= 75) return 'Lc 75 · body text'
  if (a >= 60) return 'Lc 60 · large/medium'
  if (a >= 45) return 'Lc 45 · large bold'
  if (a >= 30) return 'Lc 30 · non-text only'
  return 'Lc <30 · insufficient'
}
