// Core value & type system for the QueryForge SQL engine.
//
// We keep the value space deliberately small and JS-native so the whole
// engine stays serializable to localStorage and easy to reason about:
//   NULL    -> null
//   INTEGER -> number (integral)
//   REAL    -> number
//   TEXT    -> string
//   BOOLEAN -> boolean

import {
  isTemporal,
  formatTemporal,
  compareTemporal,
  orderTemporal,
  hashTemporal,
  asTemporalKind,
  temporalScalar,
  type Temporal,
  type TemporalKind,
} from './temporal'

export type ColumnType =
  | 'INTEGER'
  | 'REAL'
  | 'TEXT'
  | 'BOOLEAN'
  | 'DATE'
  | 'TIME'
  | 'TIMESTAMP'
  | 'INTERVAL'

export type SqlValue = null | number | string | boolean | Temporal

export const COLUMN_TYPES: readonly ColumnType[] = [
  'INTEGER',
  'REAL',
  'TEXT',
  'BOOLEAN',
  'DATE',
  'TIME',
  'TIMESTAMP',
  'INTERVAL',
]

/** Map a temporal column type to its runtime tag. */
const TEMPORAL_KIND: Partial<Record<ColumnType, TemporalKind>> = {
  DATE: 'date',
  TIME: 'time',
  TIMESTAMP: 'timestamp',
  INTERVAL: 'interval',
}

export function isNull(v: SqlValue): v is null {
  return v === null
}

/** A human-readable label for a runtime value's type (for errors / inspection). */
export function valueTypeOf(v: SqlValue): ColumnType | 'NULL' {
  if (v === null) return 'NULL'
  if (typeof v === 'boolean') return 'BOOLEAN'
  if (typeof v === 'string') return 'TEXT'
  if (isTemporal(v)) {
    return v.t === 'date' ? 'DATE' : v.t === 'time' ? 'TIME' : v.t === 'timestamp' ? 'TIMESTAMP' : 'INTERVAL'
  }
  return Number.isInteger(v) ? 'INTEGER' : 'REAL'
}

/** Coerce a parsed/produced value into a declared column type, or throw. */
export function coerceTo(type: ColumnType, v: SqlValue): SqlValue {
  if (v === null) return null
  const tkind = TEMPORAL_KIND[type]
  if (tkind) {
    const t = asTemporalKind(tkind, v)
    if (t) return t
    throw new TypeErrorSql(`cannot store ${JSON.stringify(v)} as ${type}`)
  }
  if (isTemporal(v)) {
    // A temporal value flowing into a non-temporal column: TEXT renders it,
    // INTEGER/REAL take its numeric scalar, BOOLEAN is a hard error.
    if (type === 'TEXT') return formatTemporal(v)
    if (type === 'INTEGER' || type === 'REAL') {
      const n = temporalScalar(v)
      return type === 'INTEGER' ? Math.trunc(n) : n
    }
    throw new TypeErrorSql(`cannot store ${type === 'BOOLEAN' ? 'a temporal value' : JSON.stringify(v)} as ${type}`)
  }
  switch (type) {
    case 'DATE':
    case 'TIME':
    case 'TIMESTAMP':
    case 'INTERVAL':
      // Unreachable (handled above), but keeps the switch exhaustive.
      throw new TypeErrorSql(`cannot store ${JSON.stringify(v)} as ${type}`)
    case 'INTEGER': {
      if (typeof v === 'number') return Math.trunc(v)
      if (typeof v === 'boolean') return v ? 1 : 0
      if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Math.trunc(Number(v))
      throw new TypeErrorSql(`cannot store ${JSON.stringify(v)} as INTEGER`)
    }
    case 'REAL': {
      if (typeof v === 'number') return v
      if (typeof v === 'boolean') return v ? 1 : 0
      if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
      throw new TypeErrorSql(`cannot store ${JSON.stringify(v)} as REAL`)
    }
    case 'TEXT':
      return typeof v === 'string' ? v : String(v)
    case 'BOOLEAN': {
      if (typeof v === 'boolean') return v
      if (typeof v === 'number') return v !== 0
      if (typeof v === 'string') {
        const lo = v.toLowerCase()
        if (lo === 'true' || lo === 't' || lo === '1') return true
        if (lo === 'false' || lo === 'f' || lo === '0') return false
      }
      throw new TypeErrorSql(`cannot store ${JSON.stringify(v)} as BOOLEAN`)
    }
  }
}

/** SQL three-valued comparison. Returns null when either side is NULL. */
export function compareValues(a: SqlValue, b: SqlValue): number | null {
  if (a === null || b === null) return null
  // Temporal values compare among themselves, and coerce a string/number
  // counterpart into their kind (so `date_col = '2026-06-15'` works).
  const at = isTemporal(a)
  const bt = isTemporal(b)
  if (at || bt) {
    if (at && bt) return compareTemporal(a, b)
    const temp = (at ? a : b) as Temporal
    const other = at ? b : a
    const coerced = asTemporalKind(temp.t, other)
    if (!coerced) return null
    const c = at ? compareTemporal(temp, coerced) : compareTemporal(coerced, temp)
    return c
  }
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    const na = a ? 1 : 0
    const nb = b ? 1 : 0
    return na - nb
  }
  // Mixed numeric/boolean
  if (typeof a !== 'string' && typeof b !== 'string') {
    const na = typeof a === 'boolean' ? (a ? 1 : 0) : a
    const nb = typeof b === 'boolean' ? (b ? 1 : 0) : b
    return na < nb ? -1 : na > nb ? 1 : 0
  }
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

/** Total order used for sorting / index keys. NULLs sort first. */
export function orderValues(a: SqlValue, b: SqlValue): number {
  if (a === null && b === null) return 0
  if (a === null) return -1
  if (b === null) return 1
  if (isTemporal(a) && isTemporal(b)) return orderTemporal(a, b)
  const c = compareValues(a, b)
  return c ?? 0
}

export function valuesEqual(a: SqlValue, b: SqlValue): boolean {
  return compareValues(a, b) === 0
}

/** Stable string key for hashing values in joins / aggregation / distinct. */
export function hashKey(values: SqlValue[]): string {
  let out = ''
  for (const v of values) {
    if (v === null) out += 'N;'
    else if (typeof v === 'string') out += `S${v.length}:${v}`
    else if (typeof v === 'boolean') out += v ? 'B1;' : 'B0;'
    else if (isTemporal(v)) out += `T${hashTemporal(v)};`
    else out += `D${v};`
  }
  return out
}

export function formatValue(v: SqlValue): string {
  if (v === null) return 'NULL'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'string') return v
  if (isTemporal(v)) return formatTemporal(v)
  return String(v)
}

/** All engine-thrown errors derive from this so the UI can render them nicely. */
export class SqlError extends Error {
  readonly phase: string
  constructor(message: string, phase = 'error') {
    super(message)
    this.name = 'SqlError'
    this.phase = phase
  }
}

export class TypeErrorSql extends SqlError {
  constructor(message: string) {
    super(message, 'type')
    this.name = 'TypeError'
  }
}
