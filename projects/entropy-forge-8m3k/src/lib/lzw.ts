// lzw.ts — LZW (Lempel–Ziv–Welch, 1984), the algorithm behind GIF, TIFF and
// classic Unix `compress`.
//
// LZW is the elegant, table-only cousin of LZ77: instead of transmitting
// (distance, length) pairs it builds a *dictionary* of byte-strings on the fly
// and emits fixed-then-growing integer codes into it. Encoder and decoder build
// the identical dictionary from the code stream alone — nothing about the table
// is transmitted. The subtle KwKwK case (a code that refers to an entry being
// defined this very step) is handled explicitly below.

import { BitReader, BitWriter } from './bits.ts'

const MAX_WIDTH = 16 // freeze the dictionary once codes reach this width

export interface LzwResult {
  codes: number[]
  encoded: Uint8Array
  encodedBits: number
  length: number
  dictSize: number
}

export function lzwEncode(data: Uint8Array): LzwResult {
  const w = new BitWriter()
  const codes: number[] = []
  // Dictionary: map from string-of-bytes to code. Seed with all 256 singletons.
  const dict = new Map<string, number>()
  for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i)
  let next = 256
  let width = 9

  const emit = (code: number) => {
    codes.push(code)
    w.writeBits(code, width)
  }
  // Add a dictionary entry and grow the code width the instant the count reaches
  // 2^width. The decoder, being one entry behind, grows at 2^width − 1 to stay
  // in lock-step (the standard variable-width LZW pairing).
  const addEntry = (s: string) => {
    if (next < 1 << MAX_WIDTH) {
      dict.set(s, next++)
      if (next === 1 << width && width < MAX_WIDTH) width++
    }
  }

  if (data.length === 0) {
    return { codes, encoded: w.finish(), encodedBits: 0, length: 0, dictSize: next }
  }

  let current = String.fromCharCode(data[0])
  for (let i = 1; i < data.length; i++) {
    const c = String.fromCharCode(data[i])
    const combined = current + c
    if (dict.has(combined)) {
      current = combined
    } else {
      emit(dict.get(current)!)
      addEntry(combined)
      current = c
    }
  }
  emit(dict.get(current)!)

  const encodedBits = w.bitLength
  return { codes, encoded: w.finish(), encodedBits, length: data.length, dictSize: next }
}

export function lzwDecode(encoded: Uint8Array, length: number): Uint8Array {
  const out: number[] = []
  if (length === 0) return new Uint8Array(0)
  const r = new BitReader(encoded)
  // Dictionary as an array of byte-arrays, seeded with singletons.
  const dict: number[][] = []
  for (let i = 0; i < 256; i++) dict.push([i])
  let next = 256
  let width = 9

  // Add an entry and grow width one step *before* the encoder does (at 2^width−1
  // rather than 2^width), because the decoder builds each entry one code late.
  const addEntry = (entry: number[]) => {
    if (next < 1 << MAX_WIDTH) {
      dict[next++] = entry
      if (next === (1 << width) - 1 && width < MAX_WIDTH) width++
    }
  }

  const firstCode = r.readBits(width)
  let prev = dict[firstCode].slice()
  for (const b of prev) out.push(b)

  while (out.length < length) {
    const code = r.readBits(width)
    let entry: number[]
    if (code < next && dict[code]) {
      entry = dict[code].slice()
    } else {
      // KwKwK: the code refers to the entry we are about to define this step.
      entry = prev.concat(prev[0])
    }
    for (const b of entry) out.push(b)
    addEntry(prev.concat(entry[0]))
    prev = entry
  }
  return Uint8Array.from(out.slice(0, length))
}
