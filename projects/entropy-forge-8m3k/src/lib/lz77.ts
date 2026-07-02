// lz77.ts — LZ77 / LZSS sliding-window compression.
//
// Where Huffman and arithmetic coding attack the *symbol distribution*, LZ77
// (Lempel–Ziv, 1977) attacks *repetition*: it replaces a run of bytes that has
// occurred before with a (distance, length) back-reference into a sliding window
// of recent output. This is the dictionary half of DEFLATE (gzip/zlib/PNG). We
// use the LZSS refinement (Storer–Szymanski): a single flag bit distinguishes a
// literal from a match, so short non-repeats cost 1 bit of overhead instead of a
// wasted zero-distance reference.

import { BitReader, BitWriter } from './bits.ts'

const WINDOW_BITS = 12 // 4096-byte sliding window
const WINDOW = 1 << WINDOW_BITS
const LENGTH_BITS = 4 // match length field
const MIN_MATCH = 3
const MAX_MATCH = MIN_MATCH + (1 << LENGTH_BITS) - 1 // 18

export type LzToken =
  | { kind: 'lit'; pos: number; byte: number }
  | { kind: 'match'; pos: number; distance: number; length: number }

export interface Lz77Result {
  tokens: LzToken[]
  encoded: Uint8Array
  encodedBits: number
  length: number
  literals: number
  matches: number
}

// Greedy longest-match search over the window. O(n·window·match) — ample for the
// lab; production LZ uses hash chains. Returns the best (distance, length) or null.
function findMatch(data: Uint8Array, pos: number): { distance: number; length: number } | null {
  const start = Math.max(0, pos - WINDOW)
  const maxLen = Math.min(MAX_MATCH, data.length - pos)
  if (maxLen < MIN_MATCH) return null
  let bestLen = 0
  let bestDist = 0
  for (let j = pos - 1; j >= start; j--) {
    let len = 0
    while (len < maxLen && data[j + len] === data[pos + len]) len++
    if (len > bestLen) {
      bestLen = len
      bestDist = pos - j
      if (len === maxLen) break // can't do better
    }
  }
  return bestLen >= MIN_MATCH ? { distance: bestDist, length: bestLen } : null
}

export function lz77Encode(data: Uint8Array): Lz77Result {
  const tokens: LzToken[] = []
  const w = new BitWriter()
  let pos = 0
  let literals = 0
  let matches = 0
  while (pos < data.length) {
    const m = findMatch(data, pos)
    if (m) {
      tokens.push({ kind: 'match', pos, distance: m.distance, length: m.length })
      w.writeBit(1)
      w.writeBits(m.distance - 1, WINDOW_BITS)
      w.writeBits(m.length - MIN_MATCH, LENGTH_BITS)
      pos += m.length
      matches++
    } else {
      tokens.push({ kind: 'lit', pos, byte: data[pos] })
      w.writeBit(0)
      w.writeBits(data[pos], 8)
      pos++
      literals++
    }
  }
  const encodedBits = w.bitLength
  return { tokens, encoded: w.finish(), encodedBits, length: data.length, literals, matches }
}

export function lz77Decode(encoded: Uint8Array, length: number): Uint8Array {
  const r = new BitReader(encoded)
  const out = new Uint8Array(length)
  let pos = 0
  while (pos < length) {
    const flag = r.readBit()
    if (flag === 0) {
      out[pos++] = r.readBits(8)
    } else {
      const distance = r.readBits(WINDOW_BITS) + 1
      const len = r.readBits(LENGTH_BITS) + MIN_MATCH
      const from = pos - distance
      for (let k = 0; k < len; k++) out[pos + k] = out[from + k]
      pos += len
    }
  }
  return out
}

export const LZ77_PARAMS = { WINDOW, MIN_MATCH, MAX_MATCH, WINDOW_BITS, LENGTH_BITS }
