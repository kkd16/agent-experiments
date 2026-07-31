// A deterministic 32-bit hash of a tuple `IndexKey`, shared by both dynamic
// hashing access methods (extendible & linear hashing).
//
// Correctness never depends on the hash: the buckets store full keys and resolve
// equality with `compareKeys`, so a collision (even between *unequal* keys) is
// harmless — it only means two keys share a bucket and are told apart by the
// exact comparison. The hash's only job is to *route* well, so we care about two
// things: (1) it is a pure function of the key's value (the same key always
// hashes the same way — no `Math.random`, no identity), and (2) its **low** bits
// are well mixed, because that is exactly what extendible hashing splits on and
// what linear hashing takes modulo. FNV-1a alone has weak low-bit avalanche, so
// we finish with murmur3's `fmix32` integer avalanche to disperse every bit.

import type { IndexKey } from '../storage/btree'
import type { SqlValue } from '../types'

/** A stored index entry: one distinct key mapped to a set of row ids (so the
 *  same structure backs both unique and non-unique indexes). Shared by both the
 *  extendible and linear hash tables. */
export interface HashEntry {
  key: IndexKey
  rowids: number[]
}

// Canonicalize any SqlValue (primitive or tagged object) to a string. Distinct
// values may canonicalize identically without breaking anything (see above), but
// in practice the tag + fields make the encoding effectively injective. BigInt
// (inside DECIMAL) and nested arrays/objects (JSON, arrays) are handled so the
// serializer never throws the way a bare `JSON.stringify` would on a BigInt.
function canon(v: unknown): string {
  if (v === null || v === undefined) return 'N'
  const t = typeof v
  if (t === 'number') return 'd' + (Object.is(v, -0) ? '0' : String(v))
  if (t === 'string') return 's' + (v as string)
  if (t === 'boolean') return v ? 'bT' : 'bF'
  if (t === 'bigint') return 'i' + (v as bigint).toString()
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'
  if (t === 'object') {
    const o = v as Record<string, unknown>
    const keys = Object.keys(o).sort()
    return '{' + keys.map((k) => k + ':' + canon(o[k])).join(',') + '}'
  }
  return 'u'
}

/** A deterministic 32-bit unsigned hash of a composite index key. */
export function hashKey(key: IndexKey): number {
  const s = key.map(canon).join('')
  // FNV-1a
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  // murmur3 fmix32 — avalanche so the low bits are as random as the high bits.
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** Extract the low `d` bits of `h` (guards the `1 << 32` overflow at d ≥ 31). */
export function lowBits(h: number, d: number): number {
  if (d <= 0) return 0
  if (d >= 31) return h & 0x7fffffff
  return h & ((1 << d) - 1)
}

/** Render a key for a trace / label: a bare value, or a parenthesized tuple. */
export function fmtKey(key: IndexKey, format: (v: SqlValue) => string): string {
  return key.length === 1 ? format(key[0]) : '(' + key.map(format).join(', ') + ')'
}
