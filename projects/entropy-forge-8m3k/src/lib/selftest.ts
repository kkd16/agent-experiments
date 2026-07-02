// selftest.ts — the correctness backbone. Every codec must satisfy
// decode(encode(x)) === x on every input, and every primitive transform must be
// exactly invertible. The Self-test page runs this live in the browser; the same
// module is executed under Node during development. A codec that fails here is not
// shown as trustworthy in the benchmark.

import { bytesEqual, strToBytes } from './bits.ts'
import { CODECS } from './codecs.ts'
import { CORPUS } from './corpus.ts'
import {
  bwtDecode,
  bwtEncode,
  mtfDecode,
  mtfEncode,
  rleDecode,
  rleEncode,
} from './bwt.ts'
import { arithDecode, arithEncode, Order0Adaptive, Order1Adaptive } from './arithmetic.ts'
import { huffmanDecode, huffmanEncode } from './huffman.ts'
import { lz77Decode, lz77Encode } from './lz77.ts'
import { lzwDecode, lzwEncode } from './lzw.ts'

export interface TestCase {
  group: string
  name: string
  pass: boolean
  detail: string
}

// A spread of adversarial byte inputs beyond the human-readable corpus.
function edgeInputs(): { name: string; data: Uint8Array }[] {
  const cases: { name: string; data: Uint8Array }[] = []
  cases.push({ name: 'empty', data: new Uint8Array(0) })
  cases.push({ name: 'single byte', data: Uint8Array.from([42]) })
  cases.push({ name: 'one symbol ×64', data: new Uint8Array(64).fill(7) })
  cases.push({ name: 'two symbols', data: Uint8Array.from(Array.from({ length: 50 }, (_, i) => (i % 2 ? 0 : 255))) })
  // All 256 byte values once.
  cases.push({ name: 'all 256 bytes', data: Uint8Array.from(Array.from({ length: 256 }, (_, i) => i)) })
  // Deterministic pseudo-random bytes (full range).
  let x = 2246822519
  const rnd = new Uint8Array(300)
  for (let i = 0; i < rnd.length; i++) {
    x = (1103515245 * x + 12345) >>> 0
    rnd[i] = (x >>> 16) & 0xff
  }
  cases.push({ name: 'random bytes', data: rnd })
  // Long single run (RLE / BWT stress).
  cases.push({ name: 'long run', data: new Uint8Array(500).fill(65) })
  return cases
}

function corpusInputs(): { name: string; data: Uint8Array }[] {
  return CORPUS.map((c) => ({ name: c.name, data: strToBytes(c.text) }))
}

function allInputs() {
  return [...corpusInputs(), ...edgeInputs()]
}

export function runSelfTest(): TestCase[] {
  const results: TestCase[] = []
  const inputs = allInputs()

  // 1. Every full codec round-trips every input.
  for (const codec of CODECS) {
    for (const { name, data } of inputs) {
      let pass = false
      let detail: string
      try {
        const enc = codec.encode(data)
        const dec = codec.decode(enc)
        pass = bytesEqual(dec, data)
        const ratio = data.length > 0 ? enc.length / data.length : 1
        detail = pass
          ? `${data.length}B → ${enc.length}B (${(ratio * 100).toFixed(0)}%)`
          : `mismatch: got ${dec.length}B, expected ${data.length}B`
      } catch (e) {
        detail = `threw: ${(e as Error).message}`
      }
      results.push({ group: codec.name, name, pass, detail })
    }
  }

  // 2. Primitive transforms are individually invertible.
  for (const { name, data } of inputs) {
    // BWT
    try {
      const { transformed, primaryIndex } = bwtEncode(data)
      const back = bwtDecode(transformed, primaryIndex)
      results.push({ group: 'BWT (transform)', name, pass: bytesEqual(back, data), detail: `idx ${primaryIndex}` })
    } catch (e) {
      results.push({ group: 'BWT (transform)', name, pass: false, detail: (e as Error).message })
    }
    // MTF
    const mtfBack = mtfDecode(mtfEncode(data))
    results.push({ group: 'MTF (transform)', name, pass: bytesEqual(mtfBack, data), detail: '' })
    // RLE
    const rleBack = rleDecode(rleEncode(data))
    results.push({ group: 'RLE (transform)', name, pass: bytesEqual(rleBack, data), detail: `${rleEncode(data).length}B` })
    // Huffman primitive
    try {
      const h = huffmanEncode(data)
      const hb = huffmanDecode(h.encoded, h.canonical, data.length)
      results.push({ group: 'Huffman (primitive)', name, pass: bytesEqual(hb, data), detail: `${h.avgLength.toFixed(2)} b/sym` })
    } catch (e) {
      results.push({ group: 'Huffman (primitive)', name, pass: false, detail: (e as Error).message })
    }
    // Arithmetic order-0 and order-1 primitives
    try {
      const a0 = arithEncode(data, () => new Order0Adaptive(256))
      const b0 = arithDecode(a0.encoded, data.length, () => new Order0Adaptive(256))
      results.push({ group: 'Arith-0 (primitive)', name, pass: bytesEqual(b0, data), detail: `${a0.encodedBits} bits` })
      const a1 = arithEncode(data, () => new Order1Adaptive(256))
      const b1 = arithDecode(a1.encoded, data.length, () => new Order1Adaptive(256))
      results.push({ group: 'Arith-1 (primitive)', name, pass: bytesEqual(b1, data), detail: `${a1.encodedBits} bits` })
    } catch (e) {
      results.push({ group: 'Arith (primitive)', name, pass: false, detail: (e as Error).message })
    }
    // LZ primitives
    const lz = lz77Encode(data)
    results.push({ group: 'LZ77 (primitive)', name, pass: bytesEqual(lz77Decode(lz.encoded, data.length), data), detail: `${lz.matches} matches` })
    const lw = lzwEncode(data)
    results.push({ group: 'LZW (primitive)', name, pass: bytesEqual(lzwDecode(lw.encoded, data.length), data), detail: `${lw.codes.length} codes` })
  }

  return results
}

export interface TestSummary {
  total: number
  passed: number
  failed: number
  cases: TestCase[]
}

export function summarize(cases: TestCase[]): TestSummary {
  const passed = cases.filter((c) => c.pass).length
  return { total: cases.length, passed, failed: cases.length - passed, cases }
}
