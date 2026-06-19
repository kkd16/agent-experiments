// First-class ARRAY values for the QueryForge engine — Postgres-style.
//
// An array is a tagged, *plain* object `{ t: 'array', el, items }` whose payload
// is an ordinary JS array of `SqlValue`s. Like the JSON / temporal / decimal
// values, that shape is `JSON.stringify`/`parse`-round-trippable, so a column of
// arrays serializes to localStorage with zero special-casing and — once it is
// threaded through the central value functions in `types.ts` — indexes, sorts,
// GROUP BYs, DISTINCTs, joins and renders for free.
//
// Elements may themselves be arrays, so nested (multi-dimensional) arrays are
// representable: `ARRAY[ARRAY[1,2], ARRAY[3,4]]` is an array whose two elements
// are arrays. `el` records the declared/inferred element-type tag (the inner
// type for the column declaration `INTEGER[]`), or `null` when unknown / empty /
// heterogeneous. It is advisory: identity, ordering and hashing all come from the
// element *values*, never from `el`.
//
// This module is deliberately dependency-light: the value-level operations that
// need to compare / hash / format arbitrary `SqlValue`s take those as callbacks,
// so `array.ts` never has to import the comparison machinery back out of
// `types.ts` (which would create an initialization cycle). `types.ts` wires the
// callbacks in one place.

import { SqlError } from './types'
import type { ColumnType, SqlValue } from './types'

/** A first-class SQL array value. The `t` tag mirrors json/temporal/decimal. */
export interface ArrayValue {
  readonly t: 'array'
  /** Declared/inferred element-type tag, or null when unknown. Advisory only. */
  readonly el: ColumnType | null
  readonly items: SqlValue[]
}

export function isArray(v: unknown): v is ArrayValue {
  return typeof v === 'object' && v !== null && (v as { t?: unknown }).t === 'array'
}

/** Wrap a list of elements as an array value. */
export function makeArray(items: SqlValue[], el: ColumnType | null = null): ArrayValue {
  return { t: 'array', el, items }
}

// --- ordering / equality (value-level callbacks supplied by types.ts) --------

export type Cmp = (a: SqlValue, b: SqlValue) => number
export type Eq = (a: SqlValue, b: SqlValue) => boolean

/** Total order over arrays: element-wise, then a shorter array sorts first when
 *  it is a prefix of the longer one (matching Postgres array comparison). */
export function arrayOrder(a: ArrayValue, b: ArrayValue, cmp: Cmp): number {
  const n = Math.min(a.items.length, b.items.length)
  for (let i = 0; i < n; i++) {
    const c = cmp(a.items[i], b.items[i])
    if (c !== 0) return c
  }
  return a.items.length - b.items.length
}

// --- containment / overlap --------------------------------------------------

/** `a @> b` — does array `a` contain every element of array `b`? */
export function arrayContains(a: ArrayValue, b: ArrayValue, eq: Eq): boolean {
  return b.items.every((be) => a.items.some((ae) => eq(ae, be)))
}

/** `a && b` — do arrays `a` and `b` share at least one element? */
export function arrayOverlap(a: ArrayValue, b: ArrayValue, eq: Eq): boolean {
  return a.items.some((ae) => b.items.some((be) => eq(ae, be)))
}

// --- element access ----------------------------------------------------------

/** 1-based subscript. Out-of-range (or NULL index) yields SQL NULL. */
export function arraySubscript(a: ArrayValue, index: number): SqlValue {
  const i = Math.trunc(index) - 1
  return i >= 0 && i < a.items.length ? a.items[i] : null
}

/** 1-based inclusive slice `a[lo:hi]`. Omitted bounds clamp to the ends.
 *  Out-of-range bounds clamp; an empty range yields an empty array. */
export function arraySlice(a: ArrayValue, lo: number | null, hi: number | null): ArrayValue {
  const n = a.items.length
  let l = lo === null ? 1 : Math.trunc(lo)
  let h = hi === null ? n : Math.trunc(hi)
  if (l < 1) l = 1
  if (h > n) h = n
  if (l > h) return makeArray([], a.el)
  return makeArray(a.items.slice(l - 1, h), a.el)
}

// --- searching / mutation (return fresh arrays — values are immutable) -------

/** 1-based index of the first element equal to `v`, or null. */
export function arrayPosition(a: ArrayValue, v: SqlValue, eq: Eq): number | null {
  for (let i = 0; i < a.items.length; i++) if (eq(a.items[i], v)) return i + 1
  return null
}

/** All 1-based indices of elements equal to `v` (an array of integers). NULL
 *  search values match NULL elements here, matching `array_positions`. */
export function arrayPositions(a: ArrayValue, v: SqlValue, eq: Eq): ArrayValue {
  const out: SqlValue[] = []
  for (let i = 0; i < a.items.length; i++) {
    if (v === null ? a.items[i] === null : eq(a.items[i], v)) out.push(i + 1)
  }
  return makeArray(out, 'INTEGER')
}

export function arrayRemove(a: ArrayValue, v: SqlValue, eq: Eq): ArrayValue {
  return makeArray(
    a.items.filter((x) => (v === null ? x !== null : !eq(x, v))),
    a.el,
  )
}

export function arrayReplace(a: ArrayValue, from: SqlValue, to: SqlValue, eq: Eq): ArrayValue {
  return makeArray(
    a.items.map((x) => ((from === null ? x === null : eq(x, from)) ? to : x)),
    a.el,
  )
}

export function arrayAppend(a: ArrayValue, v: SqlValue): ArrayValue {
  return makeArray([...a.items, v], a.el)
}
export function arrayPrepend(v: SqlValue, a: ArrayValue): ArrayValue {
  return makeArray([v, ...a.items], a.el)
}
export function arrayCat(a: ArrayValue, b: ArrayValue): ArrayValue {
  return makeArray([...a.items, ...b.items], a.el ?? b.el)
}

// --- shape -------------------------------------------------------------------

/** Length of the array along its first dimension (Postgres `array_length(a,1)`).
 *  Empty arrays have NULL length, as in Postgres. */
export function arrayLength(a: ArrayValue): number | null {
  return a.items.length === 0 ? null : a.items.length
}

/** Total number of (leaf) elements across every dimension (`cardinality`). */
export function cardinality(a: ArrayValue): number {
  let n = 0
  for (const x of a.items) n += isArray(x) ? cardinality(x) : 1
  return n
}

/** Nesting depth: a flat array is 1-D, an array of arrays is 2-D, …. */
export function arrayNdims(a: ArrayValue): number {
  let depth = 1
  for (const x of a.items) {
    if (isArray(x)) depth = Math.max(depth, 1 + arrayNdims(x))
  }
  return depth
}

/** Postgres `array_dims` text, e.g. `[1:2][1:3]` for a rectangular 2×3 array.
 *  Returns null for an empty array. Jagged arrays report their first row. */
export function arrayDims(a: ArrayValue): string | null {
  if (a.items.length === 0) return null
  const dims: number[] = []
  let cur: ArrayValue | null = a
  while (cur && cur.items.length > 0) {
    dims.push(cur.items.length)
    const first: SqlValue = cur.items[0]
    cur = isArray(first) ? first : null
  }
  return dims.map((d) => `[1:${d}]`).join('')
}

/** `generate_subscripts(a, 1)` — the 1..length index series for the first dim. */
export function generateSubscripts(a: ArrayValue): number[] {
  const out: number[] = []
  for (let i = 1; i <= a.items.length; i++) out.push(i)
  return out
}

// --- text format (Postgres `{…}` external representation) --------------------

/** Does a text element need double-quoting in the `{…}` representation? */
function needsQuote(s: string): boolean {
  if (s === '') return true
  if (s.toUpperCase() === 'NULL') return true
  return /[{}",\\\s]/.test(s)
}

function quoteElem(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/** Render an array in Postgres' `{…}` text form. Element scalars are rendered by
 *  `fmt`; NULL → `NULL`; text needing it is quoted; nested arrays recurse. */
export function formatArray(a: ArrayValue, fmt: (v: SqlValue) => string): string {
  const parts = a.items.map((v) => {
    if (v === null) return 'NULL'
    if (isArray(v)) return formatArray(v, fmt)
    const s = fmt(v)
    // Only TEXT-ish renderings can collide with the grammar; quote when needed.
    return needsQuote(s) ? quoteElem(s) : s
  })
  return '{' + parts.join(',') + '}'
}

// --- text parse (the inverse of formatArray) --------------------------------

/** A parsed array element before element-type coercion: a raw (possibly quoted)
 *  scalar token, an unquoted NULL, or a nested array. */
export type RawElem = { kind: 'null' } | { kind: 'scalar'; text: string; quoted: boolean } | { kind: 'array'; items: RawElem[] }

/** Parse Postgres `{…}` array text into a raw element tree. The caller coerces
 *  scalar tokens to the target element type. Throws on malformed input. */
export function parseArrayText(src: string): RawElem {
  let i = 0
  const n = src.length
  const skipWs = () => {
    while (i < n && /\s/.test(src[i])) i++
  }
  function parseArr(): RawElem {
    skipWs()
    if (src[i] !== '{') throw new SqlError(`malformed array literal: expected '{' at offset ${i}`, 'array')
    i++ // {
    const items: RawElem[] = []
    skipWs()
    if (src[i] === '}') {
      i++
      return { kind: 'array', items }
    }
    for (;;) {
      skipWs()
      if (src[i] === '{') {
        items.push(parseArr())
      } else if (src[i] === '"') {
        items.push(parseQuoted())
      } else {
        items.push(parseUnquoted())
      }
      skipWs()
      if (src[i] === ',') {
        i++
        continue
      }
      if (src[i] === '}') {
        i++
        break
      }
      throw new SqlError(`malformed array literal: expected ',' or '}' at offset ${i}`, 'array')
    }
    return { kind: 'array', items }
  }
  function parseQuoted(): RawElem {
    i++ // opening "
    let out = ''
    while (i < n) {
      const c = src[i]
      if (c === '\\') {
        i++
        if (i < n) out += src[i++]
        continue
      }
      if (c === '"') {
        // A doubled "" is an embedded quote (lenient, CSV-style); a single "
        // closes the element.
        if (src[i + 1] === '"') {
          out += '"'
          i += 2
          continue
        }
        i++
        return { kind: 'scalar', text: out, quoted: true }
      }
      out += c
      i++
    }
    throw new SqlError('malformed array literal: unterminated quoted element', 'array')
  }
  function parseUnquoted(): RawElem {
    let out = ''
    while (i < n && src[i] !== ',' && src[i] !== '}' && src[i] !== '{') out += src[i++]
    const text = out.trim()
    if (text.toUpperCase() === 'NULL') return { kind: 'null' }
    return { kind: 'scalar', text, quoted: false }
  }
  skipWs()
  const result = parseArr()
  skipWs()
  if (i !== n) throw new SqlError(`malformed array literal: trailing characters at offset ${i}`, 'array')
  return result
}
