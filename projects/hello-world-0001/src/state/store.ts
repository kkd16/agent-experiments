// Persistence + sharing. A gradient round-trips through a compact, URL-safe string (so a whole
// design lives in the address bar) and the gallery is mirrored into localStorage. Every storage /
// atob call is wrapped — the catalog renders thumbnails in a sandboxed iframe where those throw,
// and the app must still paint there.

import { parseHex, rgbaToHex } from '../color/convert'
import { makeStopId, museGradient } from '../color/random'
import type { Gradient, GradientType, HueMode, InterpSpace, Stop } from '../color/types'

export function defaultGradient(): Gradient {
  const stops: Stop[] = [
    { id: makeStopId(), color: parseHex('#0b1026')!, pos: 0 },
    { id: makeStopId(), color: parseHex('#6d28d9')!, pos: 0.45 },
    { id: makeStopId(), color: parseHex('#f97316')!, pos: 1 },
  ]
  return { type: 'linear', angle: 120, cx: 0.5, cy: 0.5, space: 'oklch', hue: 'shorter', stops }
}

interface Wire {
  t: GradientType
  a: number
  c: [number, number]
  s: InterpSpace
  h: HueMode
  st: [string, number][]
}

function toWire(g: Gradient): Wire {
  return {
    t: g.type,
    a: Math.round(g.angle * 10) / 10,
    c: [Math.round(g.cx * 1000) / 1000, Math.round(g.cy * 1000) / 1000],
    s: g.space,
    h: g.hue,
    st: g.stops.map((s) => [rgbaToHex(s.color), Math.round(s.pos * 1000) / 1000]),
  }
}

const SPACES: InterpSpace[] = ['srgb', 'linear', 'oklab', 'oklch', 'lab', 'lch', 'hsl']
const HUES: HueMode[] = ['shorter', 'longer', 'increasing', 'decreasing']
const TYPES: GradientType[] = ['linear', 'radial', 'conic']

function fromWire(w: Wire): Gradient | null {
  try {
    if (!Array.isArray(w.st) || w.st.length < 1) return null
    const stops: Stop[] = w.st.map(([hex, pos]) => {
      const color = parseHex(hex) ?? { r: 0, g: 0, b: 0, a: 1 }
      return { id: makeStopId(), color, pos: clamp01(pos) }
    })
    return {
      type: TYPES.includes(w.t) ? w.t : 'linear',
      angle: Number.isFinite(w.a) ? w.a : 90,
      cx: clamp01(w.c?.[0] ?? 0.5),
      cy: clamp01(w.c?.[1] ?? 0.5),
      space: SPACES.includes(w.s) ? w.s : 'oklch',
      hue: HUES.includes(w.h) ? w.h : 'shorter',
      stops,
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
