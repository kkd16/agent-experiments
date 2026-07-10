import type { SketchData, Entity, Constraint } from './types'

// Serialisation for Datum sketches: a stable JSON shape used for file
// save/load, one-click shareable URLs, and localStorage autosave. The format is
// exactly the model's `SketchData` (points, lines, circles, constraints) wrapped
// with a version tag so older links keep working as the schema grows.

export const SKETCH_FORMAT = 'datum-sketch'
export const SKETCH_VERSION = 1

export type SketchFile = {
  format: typeof SKETCH_FORMAT
  version: number
  data: SketchData
}

const CONSTRAINT_KINDS = new Set([
  'coincident', 'horizontal', 'vertical', 'parallel', 'perpendicular', 'equalLength',
  'equalRadius', 'distance', 'pointOnLine', 'pointOnCircle', 'radius', 'diameter',
  'tangentLineCircle', 'tangentCircles', 'concentric', 'angle', 'midpoint', 'symmetric',
  'colinear', 'splineTangentLine', 'splineTangentSpline', 'splineTangentArc',
])

// Structural validation — enough to reject a malformed or hostile blob before it
// reaches the solver, without trusting anything from a URL or a dropped file.
function isEntity(e: unknown): e is Entity {
  if (!e || typeof e !== 'object') return false
  const o = e as Record<string, unknown>
  if (typeof o.id !== 'number') return false
  if (o.kind === 'point') return typeof o.x === 'number' && typeof o.y === 'number' && typeof o.fixed === 'boolean'
  if (o.kind === 'line') return typeof o.p1 === 'number' && typeof o.p2 === 'number'
  if (o.kind === 'circle') return typeof o.c === 'number' && typeof o.r === 'number'
  if (o.kind === 'arc')
    return typeof o.c === 'number' && typeof o.p1 === 'number' && typeof o.p2 === 'number' && typeof o.r === 'number'
  if (o.kind === 'spline')
    return (
      typeof o.p0 === 'number' && typeof o.c0 === 'number' && typeof o.c1 === 'number' && typeof o.p1 === 'number'
    )
  return false
}

function isConstraint(c: unknown): c is Constraint {
  if (!c || typeof c !== 'object') return false
  const o = c as Record<string, unknown>
  return (
    typeof o.id === 'number' &&
    typeof o.kind === 'string' &&
    CONSTRAINT_KINDS.has(o.kind) &&
    Array.isArray(o.entities) &&
    o.entities.every((x) => typeof x === 'number') &&
    (o.value === undefined || typeof o.value === 'number')
  )
}

export function validateSketchData(d: unknown): d is SketchData {
  if (!d || typeof d !== 'object') return false
  const o = d as Record<string, unknown>
  return (
    Array.isArray(o.entities) &&
    o.entities.every(isEntity) &&
    Array.isArray(o.constraints) &&
    o.constraints.every(isConstraint) &&
    typeof o.nextId === 'number'
  )
}

export function toFile(data: SketchData): SketchFile {
  return { format: SKETCH_FORMAT, version: SKETCH_VERSION, data }
}

export function toJSONString(data: SketchData): string {
  return JSON.stringify(toFile(data), null, 2)
}

// Parse a saved file (from disk or a text blob). Accepts both the wrapped
// {format,version,data} shape and a bare SketchData for forward tolerance.
export function fromJSONString(text: string): SketchData | null {
  try {
    const parsed = JSON.parse(text) as unknown
    const maybe = parsed as Record<string, unknown>
    const data = maybe && maybe.format === SKETCH_FORMAT ? maybe.data : parsed
    return validateSketchData(data) ? (data as SketchData) : null
  } catch {
    return null
  }
}

// --- shareable URL hash -----------------------------------------------------
// The whole sketch is packed into the URL fragment as base64 so a link fully
// reconstructs it — no server, no storage. Fragments never leave the browser.

function toBase64(s: string): string {
  // Percent-encode first so any non-Latin1 codepoint survives btoa.
  const b64 = btoa(encodeURIComponent(s))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return decodeURIComponent(atob(b64))
}

export function encodeHash(data: SketchData): string {
  return toBase64(JSON.stringify(toFile(data)))
}

export function decodeHash(hash: string): SketchData | null {
  try {
    const raw = hash.startsWith('#') ? hash.slice(1) : hash
    const marker = 's='
    const payload = raw.startsWith(marker) ? raw.slice(marker.length) : raw
    if (!payload) return null
    return fromJSONString(fromBase64(payload))
  } catch {
    return null
  }
}
