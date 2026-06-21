// Animated gradients. Two portable techniques, each with a live-preview helper and a
// copy-paste CSS export:
//
//   • Hue cycle — rotate every stop's Oklch hue through 360° over the loop. CSS can't tween
//     between two different gradient *images*, so we bake N discrete hue-rotated frames into a
//     stepped @keyframes (the eye fuses them at enough steps). Live preview rotates continuously.
//   • Sweep — slide the (oversized) gradient under the box via `background-position`. One tiny,
//     truly-interpolated @keyframes; the gradient itself is untouched.
//   • Conic spin — rotate a conic gradient's start angle with a registered @property var.

import { rgbToOklch, oklchToRgb, wrapHue, round, rgbaToCss } from './convert'
import { toCSS } from './gradient'
import type { Gradient, RGBA } from './types'

export type AnimKind = 'none' | 'hue' | 'sweep' | 'spin'

export interface Anim {
  kind: AnimKind
  /** loop duration in ms */
  durationMs: number
}

export const ANIM_LABELS: Record<AnimKind, string> = {
  none: 'None',
  hue: 'Hue cycle',
  sweep: 'Sweep',
  spin: 'Conic spin',
}

export const defaultAnim = (): Anim => ({ kind: 'none', durationMs: 6000 })

/** Return a copy of the gradient with every stop's Oklch hue rotated by `deg` degrees. */
export function hueRotated(g: Gradient, deg: number): Gradient {
  return {
    ...g,
    stops: g.stops.map((s) => {
      const lch = rgbToOklch(s.color)
      const rgb = oklchToRgb({ L: lch.L, C: lch.C, h: wrapHue(lch.h + deg) })
      const color: RGBA = { r: clamp01(rgb.r), g: clamp01(rgb.g), b: clamp01(rgb.b), a: s.color.a }
      return { ...s, color }
    }),
  }
}
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

/** The gradient to paint at loop phase `t`∈[0,1) for the given animation (for live preview). */
export function frameAt(g: Gradient, anim: Anim, t: number): Gradient {
  if (anim.kind === 'hue') return hueRotated(g, t * 360)
  if (anim.kind === 'spin') return { ...g, type: 'conic', angle: wrapHue(g.angle + t * 360) }
  return g
}

const KEY = 'gradlab-anim'

/** Stepped hue-cycle @keyframes — N baked hue-rotated frames. */
export function hueKeyframesCss(g: Gradient, durationMs: number, steps = 24): string {
  const frames: string[] = []
  for (let i = 0; i <= steps; i++) {
    const pct = round((i / steps) * 100, 2)
    const css = toCSS(hueRotated(g, (i / steps) * 360))
    frames.push(`  ${pct}% { background: ${css}; }`)
  }
  return [
    `@keyframes ${KEY} {`,
    ...frames,
    `}`,
    `.gradient {`,
    `  animation: ${KEY} ${round(durationMs / 1000, 2)}s steps(${steps}) infinite;`,
    `}`,
  ].join('\n')
}

/** Sweep @keyframes — a single oversized gradient slid via background-position. */
export function sweepKeyframesCss(g: Gradient, durationMs: number): string {
  return [
    `@keyframes ${KEY} {`,
    `  0%   { background-position: 0% 50%; }`,
    `  50%  { background-position: 100% 50%; }`,
    `  100% { background-position: 0% 50%; }`,
    `}`,
    `.gradient {`,
    `  background: ${toCSS(g)};`,
    `  background-size: 200% 200%;`,
    `  animation: ${KEY} ${round(durationMs / 1000, 2)}s ease infinite;`,
    `}`,
  ].join('\n')
}

/** Conic-spin @keyframes via a registered custom property (modern browsers). */
export function spinKeyframesCss(g: Gradient, durationMs: number): string {
  const stops = g.stops
    .slice()
    .sort((a, b) => a.pos - b.pos)
    .map((s) => `${rgbaToCss(s.color)} ${round(s.pos * 100, 2)}%`)
    .join(', ')
  return [
    `@property --gl-angle {`,
    `  syntax: '<angle>'; initial-value: 0deg; inherits: false;`,
    `}`,
    `@keyframes ${KEY} {`,
    `  to { --gl-angle: 360deg; }`,
    `}`,
    `.gradient {`,
    `  background: conic-gradient(from var(--gl-angle) at ${round(g.cx * 100, 1)}% ${round(g.cy * 100, 1)}%, ${stops});`,
    `  animation: ${KEY} ${round(durationMs / 1000, 2)}s linear infinite;`,
    `}`,
  ].join('\n')
}

export function toKeyframesCss(g: Gradient, anim: Anim): string {
  switch (anim.kind) {
    case 'hue':
      return hueKeyframesCss(g, anim.durationMs)
    case 'sweep':
      return sweepKeyframesCss(g, anim.durationMs)
    case 'spin':
      return spinKeyframesCss(g, anim.durationMs)
    case 'none':
      return `.gradient { background: ${toCSS(g)}; }`
  }
}
