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
import {
  isDecimal,
  formatDecimal,
  hashDecimal,
  compareDecimal,
  parseDecimal,
  fromNumber as decimalFromNumber,
  fromInt as decimalFromInt,
  toNumber as decimalToNumber,
  rescale as decimalRescale,
  type DecimalValue,
} from './decimal'
import {
  isJson,
  jsonOf,
  parseJson,
  tryParseJson,
  stringify as jsonStringify,
  jsonOrder,
  jsonHash,
  toJson,
  type Json,
  type JsonValue,
} from './json'
import {
  isTsVector,
  isTsQuery,
  formatTsVector,
  formatTsQuery,
  tsVectorOrder,
  tsQueryOrder,
  tsVectorHash,
  tsQueryHash,
  asTsVector,
  asTsQuery,
  type TsVector,
  type TsQuery,
} from './fts'
import {
  isArray,
  makeArray,
  arrayOrder,
  formatArray,
  parseArrayText,
  type ArrayValue,
  type RawElem,
} from './array'

export type ColumnType =
  | 'INTEGER'
  | 'REAL'
  | 'TEXT'
  | 'BOOLEAN'
  | 'DATE'
  | 'TIME'
  | 'TIMESTAMP'
  | 'INTERVAL'
  | 'DECIMAL'
  | 'JSON'
  | 'TSVECTOR'
  | 'TSQUERY'
  | 'ARRAY'

export type SqlValue = null | number | string | boolean | Temporal | DecimalValue | JsonValue | TsVector | TsQuery | ArrayValue

export const COLUMN_TYPES: readonly ColumnType[] = [
  'INTEGER',
  'REAL',
  'DECIMAL',
  'TEXT',
  'BOOLEAN',
  'DATE',
  'TIME',
  'TIMESTAMP',
  'INTERVAL',
  'JSON',
  'TSVECTOR',
  'TSQUERY',
  'ARRAY',
]

/** Coerce any value into an exact DECIMAL (used by comparison + coercion). */
function asDecimalExact(v: SqlValue): DecimalValue | null {
  if (isDecimal(v)) return v
  if (typeof v === 'boolean') return decimalFromInt(v ? 1 : 0)
  if (typeof v === 'number') return Number.isInteger(v) ? decimalFromInt(v) : null
  if (typeof v === 'string') return parseDecimal(v)
  return null
}

/** Infer the element-type tag of an array from its first non-null element. */
export function inferElemType(items: SqlValue[]): ColumnType | null {
  for (const x of items) {
    if (x === null) continue
    const t = valueTypeOf(x)
    return t === 'NULL' ? null : t
  }
  return null
}

/** Coerce every element of an array to `elemType` (recursing into nested arrays). */
function coerceArrayElems(a: ArrayValue, elemType: ColumnType): ArrayValue {
  return makeArray(
    a.items.map((x) => (x === null ? null : isArray(x) ? coerceArrayElems(x, elemType) : coerceTo(elemType, x))),
    elemType,
  )
}

/** Recursively convert an array value to JSON data (`to_json` over an array). */
function arrayToJson(a: ArrayValue): Json {
  return a.items.map((x) => (isArray(x) ? arrayToJson(x) : toJson(x)))
}

/** Build an array value from a parsed `{…}` element tree, coercing scalar tokens
 *  to `elemType` (left as TEXT when no element type is known). */
function rawToValue(r: RawElem, elemType: ColumnType | null): SqlValue {
  if (r.kind === 'null') return null
  if (r.kind === 'array') return makeArray(r.items.map((it) => rawToValue(it, elemType)), elemType)
  return elemType === null || elemType === 'TEXT' ? r.text : coerceTo(elemType, r.text)
}

/** Parse Postgres `{…}` array text into a typed array value. */
export function parseArrayLiteral(text: string, elemType: ColumnType | null): ArrayValue {
  const v = rawToValue(parseArrayText(text), elemType)
  if (!isArray(v)) throw new TypeErrorSql('an array literal must be enclosed in { }')
  return v
}

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
  if (isArray(v)) return 'ARRAY'
  if (isTsVector(v)) return 'TSVECTOR'
  if (isTsQuery(v)) return 'TSQUERY'
  if (isJson(v)) return 'JSON'
  if (isDecimal(v)) return 'DECIMAL'
  if (isTemporal(v)) {
    return v.t === 'date' ? 'DATE' : v.t === 'time' ? 'TIME' : v.t === 'timestamp' ? 'TIMESTAMP' : 'INTERVAL'
  }
  return Number.isInteger(v) ? 'INTEGER' : 'REAL'
}

/** Coerce a parsed/produced value into a declared column type, or throw.
 *  For DECIMAL, `scale` (when given) rounds the value to that many fractional
 *  digits — i.e. the `s` of a `DECIMAL(p, s)` column or CAST. */
export function coerceTo(type: ColumnType, v: SqlValue, scale?: number, elemType?: ColumnType): SqlValue {
  if (v === null) return null
  if (type === 'ARRAY') {
    // An existing array passes through (coercing its elements to elemType when
    // one is declared); array text `'{…}'` parses; anything else is an error.
    if (isArray(v)) return elemType ? coerceArrayElems(v, elemType) : v
    if (typeof v === 'string') return parseArrayLiteral(v, elemType ?? null)
    throw new TypeErrorSql(`cannot store ${JSON.stringify(v)} as an array`)
  }
  if (isArray(v)) {
    // An array flowing into a non-array column.
    if (type === 'TEXT') return formatArray(v, formatValue)
    if (type === 'JSON') return jsonOf(arrayToJson(v))
    throw new TypeErrorSql(`cannot store an array as ${type}`)
  }
  if (type === 'TSVECTOR') {
    const tv = asTsVector(v)
    if (!tv) throw new TypeErrorSql(`cannot store ${JSON.stringify(v)} as TSVECTOR`)
    return tv
  }
  if (type === 'TSQUERY') {
    const tq = asTsQuery(v)
    if (!tq) throw new TypeErrorSql(`cannot store ${JSON.stringify(v)} as TSQUERY`)
    return tq
  }
  if (isTsVector(v) || isTsQuery(v)) {
    // a text-search value flowing into another column type: TEXT renders it.
    if (type === 'TEXT') return isTsVector(v) ? formatTsVector(v) : formatTsQuery(v)
    throw new TypeErrorSql(`cannot store a ${isTsVector(v) ? 'TSVECTOR' : 'TSQUERY'} as ${type}`)
  }
  if (type === 'JSON') {
    // text parses (jsonb), an existing JSON value passes through, and any other
    // scalar is wrapped like `to_json` (CAST is lenient where SQL's `::json` isn't).
    if (isJson(v)) return v
    if (typeof v === 'string') return parseJson(v)
    return jsonOf(toJson(v))
  }
  if (isJson(v)) {
    // A JSON value flowing into a non-JSON column.
    if (type === 'TEXT') return jsonStringify(v.v)
    const inner = v.v
    if (type === 'INTEGER') {
      if (typeof inner === 'number') return Math.trunc(inner)
      if (typeof inner === 'boolean') return inner ? 1 : 0
      if (typeof inner === 'string' && inner.trim() !== '' && !Number.isNaN(Number(inner))) return Math.trunc(Number(inner))
    } else if (type === 'REAL') {
      if (typeof inner === 'number') return inner
      if (typeof inner === 'boolean') return inner ? 1 : 0
      if (typeof inner === 'string' && inner.trim() !== '' && !Number.isNaN(Number(inner))) return Number(inner)
    } else if (type === 'BOOLEAN') {
      if (typeof inner === 'boolean') return inner
      if (typeof inner === 'number') return inner !== 0
    }
    throw new TypeErrorSql(`cannot store a JSON ${typeof inner === 'object' ? (Array.isArray(inner) ? 'array' : 'object') : typeof inner} as ${type}`)
  }
  if (type === 'DECIMAL') {
    const d = asDecimalExact(v) ?? (typeof v === 'number' ? decimalFromNumber(v) : null)
    if (!d) throw new TypeErrorSql(`cannot store ${JSON.stringify(v)} as DECIMAL`)
    return scale === undefined ? d : decimalRescale(d, scale)
  }
  if (isDecimal(v)) {
    // A DECIMAL flowing into a non-decimal column.
    if (type === 'TEXT') return formatDecimal(v)
    if (type === 'INTEGER') return Math.trunc(decimalToNumber(v))
    if (type === 'REAL') return decimalToNumber(v)
    if (type === 'BOOLEAN') return v.d !== '0'
    throw new TypeErrorSql(`cannot store a DECIMAL as ${type}`)
  }
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
/** Read a value as JSON data for cross-comparison: a JSON value unwraps, a
 *  string parses if it's valid JSON (else it's treated as a JSON string), and
 *  any other scalar maps through `to_json`. */
function asJsonData(v: SqlValue): Json {
  if (isJson(v)) return v.v
  if (typeof v === 'string') return tryParseJson(v)?.v ?? v
  return toJson(v)
}

export function compareValues(a: SqlValue, b: SqlValue): number | null {
  if (a === null || b === null) return null
  // Arrays compare element-wise among themselves (Postgres array ordering).
  if (isArray(a) || isArray(b)) {
    if (isArray(a) && isArray(b)) return arrayOrder(a, b, orderValues)
    return null
  }
  // Text-search values compare among themselves by canonical text; a string
  // counterpart is read into the same kind so `vec_col = '…'::tsvector` works.
  if (isTsVector(a) || isTsVector(b)) {
    const va = asTsVector(a)
    const vb = asTsVector(b)
    return va && vb ? tsVectorOrder(va, vb) : null
  }
  if (isTsQuery(a) || isTsQuery(b)) {
    const qa = asTsQuery(a)
    const qb = asTsQuery(b)
    return qa && qb ? tsQueryOrder(qa, qb) : null
  }
  // JSON compares structurally (jsonb's total order); a string/scalar opposite
  // is read as JSON so `json_col = '{"a":1}'` behaves intuitively.
  if (isJson(a) || isJson(b)) return jsonOrder(asJsonData(a), asJsonData(b))
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
  // Decimals compare exactly among themselves and against any value that can be
  // read as an exact decimal (integers, decimal-shaped strings); a non-integer
  // REAL falls back to a float comparison, matching `numeric vs double`.
  if (isDecimal(a) || isDecimal(b)) {
    const da = asDecimalExact(a)
    const db = asDecimalExact(b)
    if (da && db) return compareDecimal(da, db)
    const na = isDecimal(a) ? decimalToNumber(a) : typeof a === 'boolean' ? (a ? 1 : 0) : Number(a)
    const nb = isDecimal(b) ? decimalToNumber(b) : typeof b === 'boolean' ? (b ? 1 : 0) : Number(b)
    if (Number.isNaN(na) || Number.isNaN(nb)) return null
    return na < nb ? -1 : na > nb ? 1 : 0
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
  if (isArray(a) && isArray(b)) return arrayOrder(a, b, orderValues)
  if (isTsVector(a) && isTsVector(b)) return tsVectorOrder(a, b)
  if (isTsQuery(a) && isTsQuery(b)) return tsQueryOrder(a, b)
  if (isJson(a) && isJson(b)) return jsonOrder(a.v, b.v)
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
    else if (isArray(v)) out += `A${v.items.length}[${hashKey(v.items)}];`
    else if (isTsVector(v)) out += `V${tsVectorHash(v)};`
    else if (isTsQuery(v)) out += `Q${tsQueryHash(v)};`
    else if (isJson(v)) out += `J${jsonHash(v)};`
    else if (isTemporal(v)) out += `T${hashTemporal(v)};`
    else if (isDecimal(v)) out += `D${hashDecimal(v)};`
    else out += `D${v};`
  }
  return out
}

export function formatValue(v: SqlValue): string {
  if (v === null) return 'NULL'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'string') return v
  if (isArray(v)) return formatArray(v, formatValue)
  if (isTsVector(v)) return formatTsVector(v)
  if (isTsQuery(v)) return formatTsQuery(v)
  if (isJson(v)) return jsonStringify(v.v)
  if (isDecimal(v)) return formatDecimal(v)
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
