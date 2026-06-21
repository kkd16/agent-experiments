// Persistence + sharing. A gradient round-trips through a compact, URL-safe string (so a whole
// design lives in the address bar) and the gallery is mirrored into localStorage. Every storage /
// atob call is wrapped — the catalog renders thumbnails in a sandboxed iframe where those throw,
// and the app must still paint there.

import { parseHex, rgbaToHex } from '../color/convert'
import { EASINGS } from '../color/easing'
import { makeStopId, museGradient } from '../color/random'
import type { Easing, GamutMode, Gradient, GradientType, HueMode, InterpSpace, Stop } from '../color/types'

export function defaultGradient(): Gradient {
  const stops: Stop[] = [
    { id: makeStopId(), color: parseHex('#0b1026')!, pos: 0 },
    { id: makeStopId(), color: parseHex('#6d28d9')!, pos: 0.45 },
    { id: makeStopId(), color: parseHex('#f97316')!, pos: 1 },
  ]
  return { type: 'linear', angle: 120, cx: 0.5, cy: 0.5, space: 'oklch', hue: 'shorter', stops }
}

// Stop wire form: [hex, pos] or [hex, pos, easingIndex] (the index is omitted for plain linear,
// so legacy links stay byte-identical and still decode).
type WireStop = [string, number] | [string, number, number]

interface Wire {
  t: GradientType
  a: number
  c: [number, number]
  s: InterpSpace
  h: HueMode
  st: WireStop[]
  /** gamut mode — only present when non-default ('map'). */
  gm?: GamutMode
}

function toWire(g: Gradient): Wire {
  const w: Wire = {
    t: g.type,
    a: Math.round(g.angle * 10) / 10,
    c: [Math.round(g.cx * 1000) / 1000, Math.round(g.cy * 1000) / 1000],
    s: g.space,
    h: g.hue,
    st: g.stops.map((s): WireStop => {
      const hex = rgbaToHex(s.color)
      const pos = Math.round(s.pos * 1000) / 1000
      const ei = s.easing ? EASINGS.indexOf(s.easing) : 0
      return ei > 0 ? [hex, pos, ei] : [hex, pos]
    }),
  }
  if (g.gamut === 'map') w.gm = 'map'
  return w
}

const SPACES: InterpSpace[] = ['srgb', 'linear', 'oklab', 'oklch', 'lab', 'lch', 'hsl']
const HUES: HueMode[] = ['shorter', 'longer', 'increasing', 'decreasing']
const TYPES: GradientType[] = ['linear', 'radial', 'conic']

function fromWire(w: Wire): Gradient | null {
  try {
    if (!Array.isArray(w.st) || w.st.length < 1) return null
    const stops: Stop[] = w.st.map((entry) => {
      const [hex, pos, ei] = entry
      const color = parseHex(hex) ?? { r: 0, g: 0, b: 0, a: 1 }
      const easing: Easing | undefined =
        typeof ei === 'number' && ei > 0 && ei < EASINGS.length ? EASINGS[ei] : undefined
      const s: Stop = { id: makeStopId(), color, pos: clamp01(pos) }
      if (easing) s.easing = easing
      return s
    })
    return {
      type: TYPES.includes(w.t) ? w.t : 'linear',
      angle: Number.isFinite(w.a) ? w.a : 90,
      cx: clamp01(w.c?.[0] ?? 0.5),
      cy: clamp01(w.c?.[1] ?? 0.5),
      space: SPACES.includes(w.s) ? w.s : 'oklch',
      hue: HUES.includes(w.h) ? w.h : 'shorter',
      stops,
      gamut: w.gm === 'map' ? 'map' : 'clip',
    }
  } catch {
    return null
  }
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

function b64urlEncode(s: string): string {
  try {
    return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  } catch {
    return ''
  }
}
function b64urlDecode(s: string): string {
  try {
    const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : ''
    return decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad)))
  } catch {
    return ''
  }
}

export function encodeGradient(g: Gradient): string {
  return b64urlEncode(JSON.stringify(toWire(g)))
}
export function decodeGradient(code: string): Gradient | null {
  const json = b64urlDecode(code)
  if (!json) return null
  try {
    return fromWire(JSON.parse(json) as Wire)
  } catch {
    return null
  }
}

// ── gallery (localStorage) ────────────────────────────────────────────────────
export interface SavedItem {
  id: string
  code: string
  createdAt: number
}
const GALLERY_KEY = 'gradient-lab/gallery/v1'

export function loadGallery(): SavedItem[] {
  try {
    const raw = localStorage.getItem(GALLERY_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as SavedItem[]
    return Array.isArray(arr) ? arr.filter((x) => x && typeof x.code === 'string') : []
  } catch {
    return []
  }
}
export function saveGallery(items: SavedItem[]): void {
  try {
    localStorage.setItem(GALLERY_KEY, JSON.stringify(items.slice(0, 60)))
  } catch {
    /* sandboxed / full — ignore */
  }
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0
}

export { museGradient }
