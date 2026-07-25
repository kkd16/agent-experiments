// The column encodings — a from-scratch subset of the Parquet/ORC family, each
// a lossless codec over one column's non-NULL values:
//
//   PLAIN      the values as-is (the baseline every other encoding must beat)
//   DICTIONARY distinct values + a bit-packed code per row  — kills repetition
//              in low-cardinality columns (a status/category column of a
//              million rows collapses to a handful of dictionary entries)
//   RLE        (value, run-length) pairs                    — kills long runs
//              (a sorted or clustered column)
//   BITPACK    frame-of-reference: subtract the group min, bit-pack the
//   (FOR)      residuals in ⌈log₂(max−min)⌉ bits            — kills wide ints
//              whose *range* inside a group is small
//   DELTA      first value + bit-packed ZigZag deltas       — kills monotone
//              columns (ids, timestamps): consecutive gaps are tiny even when
//              the absolute values are huge
//
// The auto-encoder (`encodeColumn`) builds every legal candidate and keeps the
// smallest, exactly as ORC/Parquet writers choose an encoding per column chunk.
// Every codec is proven a byte-for-byte round-trip in the self-tests, so the
// answer is always exact — the encoding only ever changes the *size*.

import { orderValues, valuesEqual, hashKey, type SqlValue } from '../types'
import { bitsFor, packBits, unpackBits, readAt, zigzag, unzigzag } from './bitpack'
import {
  plainSize,
  varintLen,
  zoneSize,
  type ColumnChunk,
  type EncodingKind,
  type ZoneMap,
} from './types'

/** BITPACK/DELTA are only offered when the residual/delta width fits here; past
 *  it we fall back to PLAIN/DICTIONARY (a value beyond 2^52 loses JS integer
 *  exactness, so packing it would not be a faithful round-trip). */
const MAX_WIDTH = 52

// ---- NULL bitmap + zone map ------------------------------------------------

interface Split {
  nulls: Uint8Array | null
  nullCount: number
  present: SqlValue[]
}

/** Separate a raw column into a NULL bitmap + the dense list of non-NULL
 *  values (what every encoding actually compresses). */
function splitNulls(values: SqlValue[]): Split {
  const n = values.length
  let nullCount = 0
  for (const v of values) if (v === null) nullCount++
  if (nullCount === 0) return { nulls: null, nullCount: 0, present: values.slice() }
  const nulls = new Uint8Array((n + 7) >> 3)
  const present: SqlValue[] = []
  for (let i = 0; i < n; i++) {
    if (values[i] === null) nulls[i >> 3] |= 1 << (i & 7)
    else present.push(values[i])
  }
  return { nulls, nullCount, present }
}

/** True when row `i` is NULL, read from a bitmap (or always false when none). */
export function isNullAt(nulls: Uint8Array | null, i: number): boolean {
  return nulls !== null && ((nulls[i >> 3] >> (i & 7)) & 1) === 1
}

/** Build the zone map (min / max / null-count / exact distinct) for a column. */
export function computeZone(values: SqlValue[], present: SqlValue[], nullCount: number): ZoneMap {
  let min: SqlValue = null
  let max: SqlValue = null
  const seen = new Set<string>()
  for (const v of present) {
    if (min === null || orderValues(v, min) < 0) min = v
    if (max === null || orderValues(v, max) > 0) max = v
    seen.add(hashKey([v]))
  }
  return { count: values.length, nullCount, min, max, distinct: seen.size }
}

function nullBytes(nullCount: number, n: number): number {
  return nullCount > 0 ? (n + 7) >> 3 : 0
}

/** Whole non-NULL column is JS integers ⇒ the numeric encodings are eligible. */
function isIntegerColumn(present: SqlValue[]): boolean {
  if (present.length === 0) return false
  for (const v of present) if (typeof v !== 'number' || !Number.isInteger(v)) return false
  return true
}

// ---- encoders --------------------------------------------------------------

/** Encode one column under a specific encoding. Throws if the encoding is not
 *  legal for the column's data (the auto-encoder never asks for an illegal one;
 *  a caller that forces one gets a precise reason). */
export function encodeColumnAs(kind: EncodingKind, values: SqlValue[]): ColumnChunk {
  const { nulls, nullCount, present } = splitNulls(values)
  const zone = computeZone(values, present, nullCount)
  const base = { n: values.length, present: present.length, nulls, nullCount, zone }
  const overhead = nullBytes(nullCount, values.length) + zoneSize(zone)

  switch (kind) {
    case 'plain': {
      let bytes = overhead
      for (const v of present) bytes += plainSize(v)
      return { ...base, encoding: 'plain', plain: present, byteSize: bytes }
    }
    case 'dict': {
      const codeOf = new Map<string, number>()
      const dictVals: SqlValue[] = []
      const codes: number[] = []
      for (const v of present) {
        const k = hashKey([v])
        let c = codeOf.get(k)
        if (c === undefined) {
          c = dictVals.length
          codeOf.set(k, c)
          dictVals.push(v)
        }
        codes.push(c)
      }
      const width = bitsFor(Math.max(0, dictVals.length - 1))
      const packed = packBits(codes, width)
      let bytes = overhead + packed.length
      for (const v of dictVals) bytes += plainSize(v)
      return { ...base, encoding: 'dict', dict: { values: dictVals, codes: packed, width }, byteSize: bytes }
    }
    case 'rle': {
      const vals: SqlValue[] = []
      const lens: number[] = []
      const starts: number[] = []
      let start = 0
      for (const v of present) {
        if (vals.length > 0 && valuesEqual(v, vals[vals.length - 1])) {
          lens[lens.length - 1]++
        } else {
          starts.push(start)
          vals.push(v)
          lens.push(1)
        }
        start++
      }
      let bytes = overhead
      for (const v of vals) bytes += plainSize(v)
      for (const l of lens) bytes += varintLen(l)
      return { ...base, encoding: 'rle', rle: { values: vals, lens, starts }, byteSize: bytes }
    }
    case 'bitpack': {
      if (!isIntegerColumn(present)) throw new Error('BITPACK needs an all-integer column')
      let min = present[0] as number
      let max = min
      for (const v of present) {
        const n = v as number
        if (n < min) min = n
        if (n > max) max = n
      }
      const width = bitsFor(max - min)
      if (width > MAX_WIDTH) throw new Error('BITPACK residual width exceeds integer-exact range')
      const bytes = packBits(present.map((v) => (v as number) - min), width)
      return {
        ...base,
        encoding: 'bitpack',
        for: { min, width, bytes },
        byteSize: overhead + varintLen(min) + bytes.length,
      }
    }
    case 'delta': {
      if (!isIntegerColumn(present)) throw new Error('DELTA needs an all-integer column')
      const first = present[0] as number
      const zz: number[] = []
      let maxZ = 0
      for (let i = 1; i < present.length; i++) {
        const z = zigzag((present[i] as number) - (present[i - 1] as number))
        if (z > maxZ) maxZ = z
        zz.push(z)
      }
      const width = bitsFor(maxZ)
      if (width > MAX_WIDTH) throw new Error('DELTA gap width exceeds integer-exact range')
      const bytes = packBits(zz, width)
      return {
        ...base,
        encoding: 'delta',
        delta: { first, width, bytes },
        byteSize: overhead + varintLen(first) + bytes.length,
      }
    }
  }
}

/** Which encodings are legal for this column (for the auto-encoder + the Lab's
 *  side-by-side size comparison). PLAIN/DICTIONARY/RLE always; the numeric
 *  encodings only for an all-integer column whose range fits the packer. */
export function availableEncodings(values: SqlValue[]): EncodingKind[] {
  const out: EncodingKind[] = ['plain', 'dict', 'rle']
  const present = values.filter((v) => v !== null)
  if (isIntegerColumn(present)) {
    let min = present[0] as number
    let max = min
    for (const v of present) {
      const n = v as number
      if (n < min) min = n
      if (n > max) max = n
    }
    if (bitsFor(max - min) <= MAX_WIDTH) out.push('bitpack')
    let maxZ = 0
    for (let i = 1; i < present.length; i++) {
      const z = zigzag((present[i] as number) - (present[i - 1] as number))
      if (z > maxZ) maxZ = z
    }
    if (bitsFor(maxZ) <= MAX_WIDTH) out.push('delta')
  }
  return out
}

/** The auto-encoder: build every legal candidate, keep the smallest — exactly
 *  how a Parquet/ORC writer picks a column chunk's encoding. Ties break toward
 *  the earlier (simpler) encoding. */
export function encodeColumn(values: SqlValue[]): ColumnChunk {
  let best: ColumnChunk | null = null
  for (const kind of availableEncodings(values)) {
    const c = encodeColumnAs(kind, values)
    if (best === null || c.byteSize < best.byteSize) best = c
  }
  // `availableEncodings` always includes 'plain', so best is non-null.
  return best as ColumnChunk
}

// ---- decoders --------------------------------------------------------------

/** Decode a chunk's dense non-NULL values back to an array. */
export function decodePresent(chunk: ColumnChunk): SqlValue[] {
  switch (chunk.encoding) {
    case 'plain':
      return chunk.plain as SqlValue[]
    case 'dict': {
      const { values, codes, width } = chunk.dict!
      return unpackBits(codes, width, chunk.present).map((c) => values[c])
    }
    case 'rle': {
      const { values, lens } = chunk.rle!
      const out: SqlValue[] = []
      for (let r = 0; r < values.length; r++) for (let k = 0; k < lens[r]; k++) out.push(values[r])
      return out
    }
    case 'bitpack': {
      const { min, width, bytes } = chunk.for!
      return unpackBits(bytes, width, chunk.present).map((r) => min + r)
    }
    case 'delta': {
      const { first, width, bytes } = chunk.delta!
      const zz = unpackBits(bytes, width, Math.max(0, chunk.present - 1))
      const out: SqlValue[] = chunk.present > 0 ? [first] : []
      let cur = first
      for (const z of zz) {
        cur += unzigzag(z)
        out.push(cur)
      }
      return out
    }
  }
}

/** Full column decode — weave the non-NULL values back through the NULL bitmap
 *  so the result is exactly the original column (the differential invariant). */
export function decodeColumn(chunk: ColumnChunk): SqlValue[] {
  const present = decodePresent(chunk)
  if (chunk.nulls === null) return present.slice()
  const out = new Array<SqlValue>(chunk.n)
  let j = 0
  for (let i = 0; i < chunk.n; i++) out[i] = isNullAt(chunk.nulls, i) ? null : present[j++]
  return out
}

/** Random-access read of the `j`-th non-NULL value — O(1) for every encoding
 *  except RLE (O(log runs)) and DELTA (a one-time full decode, then O(1)). This
 *  is the primitive **late materialization** rides on: a projected column is
 *  read only at the row offsets that survived the predicate. */
export function presentAt(chunk: ColumnChunk, j: number): SqlValue {
  switch (chunk.encoding) {
    case 'plain':
      return (chunk.plain as SqlValue[])[j]
    case 'dict': {
      const { values, codes, width } = chunk.dict!
      return values[readAt(codes, width, j)]
    }
    case 'rle': {
      const { values, starts, lens } = chunk.rle!
      // binary search for the run whose [start, start+len) contains j
      let lo = 0
      let hi = starts.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (starts[mid] <= j) lo = mid
        else hi = mid - 1
      }
      void lens
      return values[lo]
    }
    case 'bitpack': {
      const { min, width, bytes } = chunk.for!
      return min + readAt(bytes, width, j)
    }
    case 'delta': {
      if (!chunk._present) chunk._present = decodePresent(chunk)
      return chunk._present[j]
    }
  }
}
