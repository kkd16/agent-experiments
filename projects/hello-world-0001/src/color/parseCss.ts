// Parse a CSS gradient string back into our editable Gradient model — the inverse of the export.
// Handles linear/radial/conic (and the repeating- variants), angle / "to <side>" / "from <deg>" /
// "at x% y%" configuration, and hex / rgb() / rgba() / hsl() / hsla() / oklch() color stops with
// optional positions. Imported stops are treated as sRGB so the result reproduces the source CSS
// exactly. Returns null if the string isn't a gradient we can read.

import { hslToRgb, oklchToRgb, parseHex, clampRgb } from './convert'
import { makeStopId } from './random'
import type { Gradient, GradientType, RGBA, Stop } from './types'

/** Split on `sep` but only at the top level (commas inside rgb(...) etc. are preserved). */
export function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === sep && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

function pctOrNum(v: string, scale255 = false): number {
  v = v.trim()
  if (v.endsWith('%')) return parseFloat(v) / 100
  const n = parseFloat(v)
  return scale255 ? n / 255 : n
}

/** Parse a single CSS color. Supports hex, rgb(a), hsl(a), oklch. */
export function parseCssColor(input: string): RGBA | null {
  const s = input.trim()
  if (s.startsWith('#')) return parseHex(s)

  const fn = s.match(/^([a-z]+)\((.*)\)$/i)
  if (!fn) return null
  const name = fn[1].toLowerCase()
  // alpha can be given after a slash (modern syntax) or as a 4th comma value
  const slash = fn[2].split('/')
  const main = slash[0]
  const alphaPart = slash[1]
  const parts = splitTopLevel(main, ',').length > 1 ? splitTopLevel(main, ',') : main.trim().split(/\s+/)
  let alpha = alphaPart !== undefined ? pctOrNum(alphaPart) : 1

  if (name === 'rgb' || name === 'rgba') {
    if (parts.length < 3) return null
    if (alphaPart === undefined && parts[3] !== undefined) alpha = pctOrNum(parts[3])
    return { r: pctOrNum(parts[0], true), g: pctOrNum(parts[1], true), b: pctOrNum(parts[2], true), a: clamp01(alpha) }
  }
  if (name === 'hsl' || name === 'hsla') {
    if (parts.length < 3) return null
    if (alphaPart === undefined && parts[3] !== undefined) alpha = pctOrNum(parts[3])
    const rgb = hslToRgb({ h: parseFloat(parts[0]), s: pctOrNum(parts[1]), l: pctOrNum(parts[2]) })
    return { ...clampRgb(rgb), a: clamp01(alpha) }
  }
  if (name === 'oklch') {
    if (parts.length < 3) return null
    const L = pctOrNum(parts[0])
    const C = parseFloat(parts[1])
    const h = parseFloat(parts[2])
    return { ...clampRgb(oklchToRgb({ L, C, h })), a: clamp01(alpha) }
  }
  return null
}

const clamp01 = (x: number) => (Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 1)

const SIDE_ANGLE: Record<string, number> = {
  top: 0,
  right: 90,
  bottom: 180,
  left: 270,
  'top right': 45,
  'right top': 45,
  'bottom right': 135,
  'right bottom': 135,
  'bottom left': 225,
  'left bottom': 225,
  'top left': 315,
  'left top': 315,
}

function looksLikeConfig(token: string): boolean {
  const t = token.toLowerCase()
  return (
    /\d+(\.\d+)?deg/.test(t) ||
    t.startsWith('to ') ||
    t.startsWith('from ') ||
    t.startsWith('at ') ||
    t.startsWith('circle') ||
    t.startsWith('ellipse') ||
    / at /.test(t)
  )
}

export function parseCssGradient(input: string): Gradient | null {
  let s = input.trim().replace(/;$/, '').trim()
  const decl = s.match(/^background(-image)?\s*:\s*(.*)$/i)
  if (decl) s = decl[2].trim()
  s = s.replace(/^repeating-/i, '')

  const m = s.match(/^(linear|radial|conic)-gradient\(([\s\S]*)\)$/i)
  if (!m) return null
  const type = m[1].toLowerCase() as GradientType
  const tokens = splitTopLevel(m[2], ',')
  if (tokens.length === 0) return null

  let angle = type === 'linear' ? 180 : 0
  let cx = 0.5
  let cy = 0.5
  let startIdx = 0

  if (looksLikeConfig(tokens[0])) {
    const cfg = tokens[0].toLowerCase()
    const deg = cfg.match(/(-?\d+(\.\d+)?)deg/)
    if (deg) angle = ((parseFloat(deg[1]) % 360) + 360) % 360
    const to = cfg.match(/to ([a-z ]+?)(?: at|$)/)
    if (to) {
      const key = to[1].trim()
      if (key in SIDE_ANGLE) angle = SIDE_ANGLE[key]
    }
    const at = cfg.match(/at ([\d.]+)%\s+([\d.]+)%/)
    if (at) {
      cx = clamp01(parseFloat(at[1]) / 100)
      cy = clamp01(parseFloat(at[2]) / 100)
    }
    startIdx = 1
  }

  const rawStops = tokens.slice(startIdx)
  const parsed: { color: RGBA; pos: number | null }[] = []
  for (const raw of rawStops) {
    // a bare percentage is a color "hint" — skip it
    if (/^[\d.]+%$/.test(raw.trim())) continue
    // split color from trailing position(s): the color may itself contain spaces (rgb 1 2 3)
    const posMatch = raw.match(/\s+(-?[\d.]+%)(?:\s+-?[\d.]+%)?$/)
    let colorPart = raw
    let pos: number | null = null
    if (posMatch) {
      colorPart = raw.slice(0, posMatch.index).trim()
      pos = parseFloat(posMatch[1]) / 100
    }
    const color = parseCssColor(colorPart)
    if (color) parsed.push({ color, pos })
  }
  if (parsed.length < 2) return null

  // fill missing positions: first→0, last→1, interior linearly between known anchors
  if (parsed[0].pos === null) parsed[0].pos = 0
  if (parsed[parsed.length - 1].pos === null) parsed[parsed.length - 1].pos = 1
  let i = 0
  while (i < parsed.length) {
    if (parsed[i].pos !== null) {
      i++
      continue
    }
    let j = i
    while (j < parsed.length && parsed[j].pos === null) j++
    const before = parsed[i - 1].pos as number
    const after = (parsed[j]?.pos as number) ?? 1
    const span = j - (i - 1)
    for (let k = i; k < j; k++) parsed[k].pos = before + ((after - before) * (k - (i - 1))) / span
    i = j
  }

  const stops: Stop[] = parsed.map((p) => ({ id: makeStopId(), color: p.color, pos: clamp01(p.pos as number) }))
  return { type, angle, cx, cy, space: 'srgb', hue: 'shorter', stops }
}
