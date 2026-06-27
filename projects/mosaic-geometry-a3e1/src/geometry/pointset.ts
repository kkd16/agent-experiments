import type { Point } from './types'

// Point-set serialization: human-readable text (paste / copy) and a compact,
// URL-safe binary encoding for shareable links. Coordinates live in the
// normalized [0,1] studio space; the URL form quantizes each axis to 12 bits
// (1/4095 ≈ 0.024% of the frame — finer than a pixel at any sane canvas size)
// and packs the two into three bytes, so a layout costs ~4 base64 chars/point.

const Q = 4095 // 12-bit quantization range

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

// ── Compact URL encoding ─────────────────────────────────────────────────────

function toBase64Url(bytes: number[]): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  // btoa is available in the browser; fall back to a no-op elsewhere (tests).
  const b64 = typeof btoa === 'function' ? btoa(bin) : ''
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): number[] {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  const bin = typeof atob === 'function' ? atob(b64 + pad) : ''
  const bytes: number[] = []
  for (let i = 0; i < bin.length; i++) bytes.push(bin.charCodeAt(i))
  return bytes
}

/** Encode points to a compact base64url token (empty string for no points). */
export function encodePoints(points: Point[]): string {
  const bytes: number[] = []
  for (const p of points) {
    const xi = Math.round(clamp01(p.x) * Q)
    const yi = Math.round(clamp01(p.y) * Q)
    // 24 bits = 12 (x) + 12 (y) → three bytes, big-endian.
    const v = (xi << 12) | yi
    bytes.push((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff)
  }
  return toBase64Url(bytes)
}

/** Decode a base64url token back to points (silently ignores trailing garbage). */
export function decodePoints(token: string): Point[] {
  const bytes = fromBase64Url(token)
  const pts: Point[] = []
  for (let i = 0; i + 2 < bytes.length; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    const xi = (v >> 12) & 0xfff
    const yi = v & 0xfff
    pts.push({ x: xi / Q, y: yi / Q })
  }
  return pts
}

// ── Shareable URL helpers ────────────────────────────────────────────────────

const SHARE_PREFIX = '/studio?p='

/** Build a full shareable URL embedding the current points in the hash. */
export function buildShareUrl(points: Point[]): string {
  const token = encodePoints(points)
  const loc = typeof window !== 'undefined' ? window.location : null
  const base = loc ? `${loc.origin}${loc.pathname}${loc.search}` : ''
  return `${base}#${SHARE_PREFIX}${token}`
}

/** Read shared points from the current location hash, if present. */
export function readSharedPoints(hash: string): Point[] | null {
  const i = hash.indexOf('?p=')
  if (i < 0) return null
  const token = hash.slice(i + 3)
  if (!token) return null
  const pts = decodePoints(token)
  return pts.length > 0 ? pts : null
}

// ── Human-readable text ──────────────────────────────────────────────────────

/** Export points as one `x, y` pair per line, rounded to four decimals. */
export function pointsToText(points: Point[]): string {
  return points.map((p) => `${p.x.toFixed(4)}, ${p.y.toFixed(4)}`).join('\n')
}

/**
 * Parse pasted coordinates. Accepts any delimiters (commas, spaces, newlines,
 * semicolons) and pairs the numbers up in order. If the values stray outside the
 * unit square they are treated as an arbitrary coordinate space and fit — with
 * aspect ratio preserved — into an inset of the frame, so you can paste raw pixel
 * or lat/long-style data and still see it.
 */
export function parsePointsText(text: string): Point[] {
  const nums = (text.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? []).map(Number).filter((n) => Number.isFinite(n))
  const raw: Point[] = []
  for (let i = 0; i + 1 < nums.length; i += 2) raw.push({ x: nums[i], y: nums[i + 1] })
  if (raw.length === 0) return []

  let needsFit = false
  for (const p of raw) {
    if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) {
      needsFit = true
      break
    }
  }
  if (!needsFit) return raw.map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }))

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of raw) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1
  const inset = 0.9 // fit into the central 90% of the frame
  const offX = (1 - ((maxX - minX) / span) * inset) / 2
  const offY = (1 - ((maxY - minY) / span) * inset) / 2
  return raw.map((p) => ({
    x: offX + ((p.x - minX) / span) * inset,
    y: offY + ((p.y - minY) / span) * inset,
  }))
}
