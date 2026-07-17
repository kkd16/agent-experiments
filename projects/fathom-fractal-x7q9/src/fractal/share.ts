import { hpFromString, hpToString } from './hp'
import type { RenderParams, Viewport } from './types'

// Shareable deep links. The whole view — including a 40-digit centre that a
// double could never hold — is packed into the URL hash, so a link drops the
// recipient exactly where the sender was, at any zoom depth.

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x)

/** Encode the current view + the shareable params into a compact hash string. */
export function encodeView(vp: Viewport, p: RenderParams): string {
  // Keep enough digits in the centre to resolve a pixel at this span, plus slack.
  const digits = Math.round(clamp(-Math.log10(vp.span) + 8, 8, 64))
  const parts: string[] = [
    `m=${p.mode === 'julia' ? 'j' : 'm'}`,
    `x=${hpToString(vp.cx, digits)}`,
    `y=${hpToString(vp.cy, digits)}`,
    `s=${vp.span.toExponential(6)}`,
    `p=${encodeURIComponent(p.paletteId)}`,
    `c=${p.colorScale}`,
    `o=${p.colorOffset}`,
    `i=${p.autoIter ? 'auto' : p.maxIter}`,
    `d=${p.de ? 1 : 0}`,
  ]
  if (p.mode === 'julia') {
    parts.push(`jx=${p.juliaX}`, `jy=${p.juliaY}`)
  }
  return parts.join('&')
}

type Decoded = { viewport: Viewport; params: Partial<RenderParams> }

/** Parse a hash string back into a viewport + params, or null if unusable. */
export function decodeView(hash: string): Decoded | null {
  const raw = hash.replace(/^#/, '')
  if (!raw) return null
  const map = new Map<string, string>()
  for (const pair of raw.split('&')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    map.set(pair.slice(0, eq), pair.slice(eq + 1))
  }
  const xs = map.get('x')
  const ys = map.get('y')
  const ss = map.get('s')
  if (xs === undefined || ys === undefined || ss === undefined) return null
  const span = Number(ss)
  if (!Number.isFinite(span) || span <= 0) return null

  const viewport: Viewport = { cx: hpFromString(xs), cy: hpFromString(ys), span }
  const params: Partial<RenderParams> = {}

  const mode = map.get('m')
  if (mode === 'j') params.mode = 'julia'
  else if (mode === 'm') params.mode = 'mandelbrot'

  const pal = map.get('p')
  if (pal) params.paletteId = decodeURIComponent(pal)

  const cs = Number(map.get('c'))
  if (Number.isFinite(cs)) params.colorScale = cs
  const co = Number(map.get('o'))
  if (Number.isFinite(co)) params.colorOffset = co

  const it = map.get('i')
  if (it === 'auto') params.autoIter = true
  else if (it !== undefined) {
    const n = Number(it)
    if (Number.isFinite(n) && n > 0) {
      params.autoIter = false
      params.maxIter = Math.round(n)
    }
  }

  if (map.get('d') === '1') params.de = true
  else if (map.get('d') === '0') params.de = false

  const jx = Number(map.get('jx'))
  if (Number.isFinite(jx)) params.juliaX = jx
  const jy = Number(map.get('jy'))
  if (Number.isFinite(jy)) params.juliaY = jy

  return { viewport, params }
}
