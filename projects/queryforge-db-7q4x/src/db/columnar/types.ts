// Column-store types + the physical-size model.
//
// A columnar store slices a table into **row groups** (a few thousand rows);
// inside a group each column is encoded **independently**, and carries a
// **zone map** (min / max / null-count) so a scan can skip a whole group whose
// range can't satisfy a predicate — the two ideas (per-column encoding + zone
// maps) behind every analytical engine: Parquet, ORC, DuckDB, ClickHouse,
// Vertica, Dremel.
//
// The encodings genuinely bit-pack their codes/residuals into real `Uint8Array`
// bitstreams (see `bitpack.ts`), so decode is a true byte-level round-trip. The
// value *payloads* (dictionary entries, RLE run values, plain values) are held
// as engine `SqlValue`s and their on-disk footprint is *modelled* by
// `plainSize` — an honest, documented size model, not a fake number: it is what
// lets the Lab report a real compression ratio while decode stays exact.

import { formatValue, type SqlValue } from '../types'
import { zigzag } from './bitpack'

export type EncodingKind = 'plain' | 'dict' | 'rle' | 'bitpack' | 'delta'

export const ENCODING_LABEL: Record<EncodingKind, string> = {
  plain: 'PLAIN',
  dict: 'DICTIONARY',
  rle: 'RLE',
  bitpack: 'BITPACK (frame-of-reference)',
  delta: 'DELTA',
}

/** Per-column, per-group summary statistics — the "zone map" / "min-max index"
 *  that lets a scan prune a whole group without decoding it. */
export interface ZoneMap {
  count: number // total rows in the group (including NULLs)
  nullCount: number
  min: SqlValue // min over non-NULL values (null when the group is all-NULL)
  max: SqlValue // max over non-NULL values
  distinct: number // exact distinct non-NULL values (teaching-grade)
}

/** One encoded column within one row group. A single struct (switched on
 *  `encoding`) rather than a union — it keeps the many decode call sites terse.
 *  Exactly one payload field is populated per encoding. */
export interface ColumnChunk {
  encoding: EncodingKind
  n: number // rows (incl. NULLs)
  present: number // count of non-NULL values
  nulls: Uint8Array | null // NULL bitmap (bit i set ⇒ row i is NULL); null ⇒ no NULLs
  byteSize: number // modelled physical size (payload + codes + nulls + zone)
  zone: ZoneMap
  // payloads (exactly one is set):
  plain?: SqlValue[] // PLAIN: the non-NULL values, in row order
  dict?: { values: SqlValue[]; codes: Uint8Array; width: number } // DICTIONARY
  rle?: { values: SqlValue[]; lens: number[]; starts: number[] } // RLE over non-NULLs
  for?: { min: number; width: number; bytes: Uint8Array } // BITPACK / frame-of-reference (ints)
  delta?: { first: number; width: number; bytes: Uint8Array } // DELTA (zigzag deltas, ints)
  // a lazily-filled decode cache for DELTA random access (never serialised):
  _present?: SqlValue[]
}

/** UTF-8 byte length of a string (the on-disk size a TEXT value would take). */
function utf8Len(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** Bytes a LEB128 varint would take for a (possibly negative) integer. */
export function varintLen(n: number): number {
  let z = zigzag(n)
  let bytes = 1
  while (z >= 128) {
    z = Math.floor(z / 128)
    bytes++
  }
  return bytes
}

/** Modelled physical footprint of one stored value, matching how a real column
 *  format would serialise it: varint for integers, 8 bytes for a REAL, a
 *  length-prefixed UTF-8 blob for TEXT, and a length-prefixed rendering for the
 *  rich types (DECIMAL/temporal/JSON/array/text-search). NULLs cost nothing —
 *  they live in the group's NULL bitmap. */
export function plainSize(v: SqlValue): number {
  if (v === null) return 0
  if (typeof v === 'boolean') return 1
  if (typeof v === 'number') return Number.isInteger(v) ? varintLen(v) : 8
  if (typeof v === 'string') return 2 + utf8Len(v)
  return 2 + utf8Len(formatValue(v))
}

/** Bytes a zone map costs on disk (its two endpoint values + three counters). */
export function zoneSize(z: ZoneMap): number {
  return plainSize(z.min) + plainSize(z.max) + 12
}
