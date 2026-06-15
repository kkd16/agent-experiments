// First-class JSON for the QueryForge engine — Postgres `jsonb`-style.
//
// A JSON value is a tagged, *plain* object `{ t: 'json', v }` whose payload is
// ordinary JSON data. Like the temporal and decimal values, that shape is
// `JSON.stringify`/`parse`-round-trippable, so a column of JSON serializes to
// localStorage with zero special-casing and — once it's threaded through the
// six central value functions in `types.ts` — indexes, sorts, GROUP BYs,
// DISTINCTs, joins and renders for free.
//
// We adopt `jsonb` semantics (not text-preserving `json`): on the way in, object
// keys are normalized — sorted and de-duplicated, last value winning — so two
// objects that differ only in key order or whitespace share one identity. That
// makes equality a deep structural test, hashing a canonical string, and gives
// every JSON value a place in one total order.

import { SqlError } from './types'
import { isDecimal, toNumber as decToNumber, formatDecimal } from './decimal'
import { isTemporal, formatTemporal } from './temporal'

/** Ordinary JSON data (the payload of a {@link JsonValue}). */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

/** A first-class SQL JSON value. The `t` tag mirrors temporal/decimal. */
export interface JsonValue {
  readonly t: 'json'
  readonly v: Json
}

export function isJson(v: unknown): v is JsonValue {
  return typeof v === 'object' && v !== null && (v as { t?: unknown }).t === 'json'
}

/** Wrap already-normalized JSON data as a value. */
export function makeJson(v: Json): JsonValue {
  return { t: 'json', v }
}

/** Wrap *and normalize* arbitrary JSON data (sorting/dedup'ing object keys). */
export function jsonOf(v: Json): JsonValue {
  return { t: 'json', v: normalize(v) }
}

// --- normalization ----------------------------------------------------------

/** Recursively canonicalize: object keys sorted, duplicates collapsed (last
 *  wins). Arrays keep their order (it's significant); scalars pass through. */
export function normalize(v: Json): Json {
  if (Array.isArray(v)) return v.map(normalize)
  if (v !== null && typeof v === 'object') {
    const out: { [k: string]: Json } = {}
    for (const k of Object.keys(v).sort(keyCmp)) out[k] = normalize(v[k])
    return out
  }
  return v
}

/** Stable key comparator (code-unit order) used for canonical object output. */
function keyCmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// --- parse ------------------------------------------------------------------

/** Strict parse of JSON text into a normalized value, or throw a SqlError. */
export function parseJson(text: string): JsonValue {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new SqlError(`invalid JSON text: ${err instanceof Error ? err.message : String(err)}`, 'json')
  }
  return jsonOf(raw as Json)
}

/** Lenient parse: returns null on invalid input instead of throwing. */
export function tryParseJson(text: string): JsonValue | null {
  try {
    return jsonOf(JSON.parse(text) as Json)
  } catch {
    return null
  }
}

// --- stringify --------------------------------------------------------------

/** Canonical compact serialization (object keys already sorted by normalize).
 *  We emit object keys ourselves so integer-like keys can't be reordered by the
 *  JS engine's property-iteration rules. */
export function stringify(v: Json): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stringify).join(',') + ']'
  const keys = Object.keys(v).sort(keyCmp)
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stringify(v[k])).join(',') + '}'
}

/** Pretty (indented) serialization, à la `jsonb_pretty`. */
export function pretty(v: Json, indent = 0): string {
  const pad = '    '.repeat(indent)
  const pad1 = '    '.repeat(indent + 1)
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    return '[\n' + v.map((e) => pad1 + pretty(e, indent + 1)).join(',\n') + '\n' + pad + ']'
  }
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v).sort(keyCmp)
    if (keys.length === 0) return '{}'
    return (
      '{\n' +
      keys.map((k) => pad1 + JSON.stringify(k) + ': ' + pretty(v[k], indent + 1)).join(',\n') +
      '\n' +
      pad +
      '}'
    )
  }
  return stringify(v)
}

// --- introspection ----------------------------------------------------------

export type JsonType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'

export function jsonTypeof(v: Json): JsonType {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  switch (typeof v) {
    case 'object':
      return 'object'
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    default:
      return 'boolean'
  }
}

/** The text form of a JSON value, as `->>` / `#>>` yield it: a JSON string
 *  becomes its raw contents, scalars their literal text, and a container its
 *  canonical serialization. A JSON `null` becomes SQL NULL (returned here as
 *  the JS `null`). */
export function jsonToText(v: Json): string | null {
  if (v === null) return null
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return String(v)
  return stringify(v)
}

// --- navigation -------------------------------------------------------------

/** One step of access: an object key, or an array index (negative counts from
 *  the end). Returns `undefined` when the step doesn't apply / is out of range. */
export function jsonGet(v: Json, key: string | number): Json | undefined {
  if (Array.isArray(v)) {
    let i = typeof key === 'number' ? key : asArrayIndex(key)
    if (i === null) return undefined
    if (i < 0) i += v.length
    return i >= 0 && i < v.length ? v[i] : undefined
  }
  if (v !== null && typeof v === 'object') {
    const k = String(key)
    return Object.prototype.hasOwnProperty.call(v, k) ? v[k] : undefined
  }
  return undefined
}

/** Follow a path of keys/indices, returning `undefined` if any step misses. */
export function jsonGetPath(v: Json, path: (string | number)[]): Json | undefined {
  let cur: Json | undefined = v
  for (const step of path) {
    if (cur === undefined) return undefined
    cur = jsonGet(cur, step)
  }
  return cur
}

/** Parse a string into an array index, or null if it isn't an integer. */
function asArrayIndex(s: string): number | null {
  return /^-?\d+$/.test(s.trim()) ? Number(s.trim()) : null
}

/** Parse a Postgres text path: `'{a,1,b}'` (curly array literal) or `'a,1,b'`. */
export function parseTextPath(s: string): string[] {
  let body = s.trim()
  if (body.startsWith('{') && body.endsWith('}')) body = body.slice(1, -1)
  if (body.trim() === '') return []
  return body.split(',').map((p) => p.trim())
}

// --- equality / order / hash ------------------------------------------------

export function deepEqual(a: Json, b: Json): boolean {
  return jsonOrder(a, b) === 0
}

/** Total order over JSON values (used for ORDER BY, MIN/MAX, indexing). Mirrors
 *  jsonb's type-rank ordering: null < boolean < number < string < array <
 *  object, then structural within a type. */
export function jsonOrder(a: Json, b: Json): number {
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return ra < rb ? -1 : 1
  switch (ra) {
    case 0: // null
      return 0
    case 1: // boolean
      return (a ? 1 : 0) - (b ? 1 : 0)
    case 2: // number
      return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0
    case 3: // string
      return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0
    case 4: {
      // array: length first (jsonb compares element counts before contents),
      // then element-wise.
      const aa = a as Json[]
      const bb = b as Json[]
      if (aa.length !== bb.length) return aa.length < bb.length ? -1 : 1
      for (let i = 0; i < aa.length; i++) {
        const c = jsonOrder(aa[i], bb[i])
        if (c !== 0) return c
      }
      return 0
    }
    default: {
      // object: key count, then (key, value) pairs in canonical key order.
      const ao = a as { [k: string]: Json }
      const bo = b as { [k: string]: Json }
      const ak = Object.keys(ao).sort(keyCmp)
      const bk = Object.keys(bo).sort(keyCmp)
      if (ak.length !== bk.length) return ak.length < bk.length ? -1 : 1
      for (let i = 0; i < ak.length; i++) {
        if (ak[i] !== bk[i]) return ak[i] < bk[i] ? -1 : 1
        const c = jsonOrder(ao[ak[i]], bo[bk[i]])
        if (c !== 0) return c
      }
      return 0
    }
  }
}

function rank(v: Json): number {
  if (v === null) return 0
  if (typeof v === 'boolean') return 1
  if (typeof v === 'number') return 2
  if (typeof v === 'string') return 3
  if (Array.isArray(v)) return 4
  return 5
}

/** Canonical string identity, for hashing into joins / DISTINCT / GROUP BY. */
export function jsonHash(j: JsonValue): string {
  return stringify(j.v)
}

// --- containment / existence ------------------------------------------------

/** `a @> b` — does `a` contain `b` (jsonb semantics)? */
export function contains(a: Json, b: Json): boolean {
  // Objects: every key/value pair of b must appear (and recursively contain) in a.
  if (a !== null && typeof a === 'object' && !Array.isArray(a) && b !== null && typeof b === 'object' && !Array.isArray(b)) {
    for (const k of Object.keys(b)) {
      if (!Object.prototype.hasOwnProperty.call(a, k)) return false
      if (!contains(a[k], b[k])) return false
    }
    return true
  }
  // Arrays: every element of b must be contained by some element of a. A scalar
  // b may also be contained by an array a if a has an equal element.
  if (Array.isArray(a)) {
    if (Array.isArray(b)) {
      return b.every((be) => a.some((ae) => contains(ae, be)))
    }
    return a.some((ae) => deepEqual(ae, b))
  }
  // Scalars (and array-vs-object mismatches): equality.
  return deepEqual(a, b)
}

/** `j ? key` — top-level key existence (object key, or array string element). */
export function existsKey(j: Json, key: string): boolean {
  if (j !== null && typeof j === 'object' && !Array.isArray(j)) {
    return Object.prototype.hasOwnProperty.call(j, key)
  }
  if (Array.isArray(j)) return j.some((e) => typeof e === 'string' && e === key)
  return typeof j === 'string' && j === key
}

// --- transforms -------------------------------------------------------------

/** `||` — concatenate/merge two JSON values (jsonb rules): array||array
 *  concatenates, object||object merges (right wins), and any non-array gets
 *  wrapped so e.g. `obj || scalar` produces a 2-element array per Postgres. */
export function concat(a: Json, b: Json): Json {
  const aArr = Array.isArray(a)
  const bArr = Array.isArray(b)
  if (aArr && bArr) return [...(a as Json[]), ...(b as Json[])]
  const aObj = a !== null && typeof a === 'object' && !aArr
  const bObj = b !== null && typeof b === 'object' && !bArr
  if (aObj && bObj) {
    const out: { [k: string]: Json } = { ...(a as { [k: string]: Json }) }
    for (const k of Object.keys(b as { [k: string]: Json })) out[k] = (b as { [k: string]: Json })[k]
    return normalize(out)
  }
  // Mixed: coerce each side to an array (objects/scalars wrapped) and concat.
  const left = aArr ? (a as Json[]) : [a]
  const right = bArr ? (b as Json[]) : [b]
  return [...left, ...right]
}

/** `jsonb_set(target, path, value, create_missing)` — return a copy of target
 *  with the element at `path` replaced by `value`. */
export function setPath(target: Json, path: string[], value: Json, createMissing = true): Json {
  if (path.length === 0) return value
  const [head, ...rest] = path
  if (Array.isArray(target)) {
    const idx0 = asArrayIndex(head)
    if (idx0 === null) return target
    let idx = idx0
    if (idx < 0) idx += target.length
    const copy = target.slice()
    if (idx < 0 || idx >= copy.length) {
      if (!createMissing) return target
      // Append at either end, matching jsonb_set's clamp behaviour.
      const child = setPath(undefined as unknown as Json, rest, value, createMissing)
      if (idx0 < 0) copy.unshift(child)
      else copy.push(child)
      return copy
    }
    copy[idx] = setPath(copy[idx], rest, value, createMissing)
    return copy
  }
  if (target !== null && typeof target === 'object') {
    const copy: { [k: string]: Json } = { ...(target as { [k: string]: Json }) }
    if (!Object.prototype.hasOwnProperty.call(copy, head)) {
      if (!createMissing) return target
      copy[head] = setPath(undefined as unknown as Json, rest, value, createMissing)
    } else {
      copy[head] = setPath(copy[head], rest, value, createMissing)
    }
    return normalize(copy)
  }
  // Path runs past a scalar: build a fresh object/array branch if allowed.
  if (target === undefined) {
    return rest.length === 0 ? value : { [head]: setPath(undefined as unknown as Json, rest, value, createMissing) }
  }
  return target
}

/** `json_strip_nulls` — recursively drop object members whose value is JSON null. */
export function stripNulls(v: Json): Json {
  if (Array.isArray(v)) return v.map(stripNulls)
  if (v !== null && typeof v === 'object') {
    const out: { [k: string]: Json } = {}
    for (const k of Object.keys(v)) {
      if (v[k] === null) continue
      out[k] = stripNulls(v[k])
    }
    return out
  }
  return v
}

// --- conversion from SQL values ---------------------------------------------

/** Convert any SQL value into JSON data (`to_json`): scalars map directly,
 *  decimals to numbers, temporals to their text form, and an existing JSON
 *  value unwraps to its payload. */
export function toJson(v: unknown): Json {
  if (v === null || v === undefined) return null
  if (isJson(v)) return v.v
  if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') return v
  if (isDecimal(v)) {
    const n = decToNumber(v)
    return Number.isFinite(n) ? n : formatDecimal(v)
  }
  if (isTemporal(v)) return formatTemporal(v)
  return String(v)
}
