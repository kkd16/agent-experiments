// codecs.ts — a uniform Codec interface over every algorithm in the lab.
//
// Each Codec is *self-contained*: encode(bytes) → a compressed byte array that
// carries everything decode() needs (lengths, tables, indices) to reproduce the
// input exactly. That closure is what lets the Benchmark page compare them fairly
// on the same corpora and what the self-test round-trips. Composite codecs
// (DEFLATE-lite = LZ77 + entropy coding; bzip-lite = BWT + MTF + RLE + entropy
// coding) are built by chaining the primitives, each of which is individually
// invertible — so the composite is invertible by construction.

import { BitReader, BitWriter } from './bits.ts'
import {
  Order0Adaptive,
  Order1Adaptive,
  arithDecode,
  arithEncode,
  type Model,
} from './arithmetic.ts'
import { canonicalCodes, codeLengths, buildTree } from './huffman.ts'
import { frequencies } from './entropy.ts'
import { lz77Decode, lz77Encode, LZ77_PARAMS } from './lz77.ts'
import { lzwDecode, lzwEncode } from './lzw.ts'
import {
  bwtDecode,
  bwtEncode,
  mtfDecode,
  mtfEncode,
  rleDecode,
  rleEncode,
} from './bwt.ts'
import { ppmDecode, ppmEncode } from './ppm.ts'
import { ransDecode, ransEncode, tableFromData, serialiseTable, deserialiseTable } from './rans.ts'
import { tansEncode, tansDecode, tansTableFromData } from './tans.ts'
import { adaptiveHuffmanDecode, adaptiveHuffmanEncode } from './adaptiveHuffman.ts'
import { gzipEncode, gzipDecode } from './gzip.ts'
import { cmEncode, cmDecode } from './cm.ts'

export interface Codec {
  id: string
  name: string
  family: 'entropy' | 'dictionary' | 'transform'
  blurb: string
  encode(data: Uint8Array): Uint8Array
  decode(comp: Uint8Array): Uint8Array
}

// ---- little-endian uint32 helpers for headers ----
function putU32(arr: number[], v: number) {
  arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
}
function getU32(data: Uint8Array, off: number): number {
  return (data[off] | (data[off + 1] << 8) | (data[off + 2] << 16) | (data[off + 3] << 24)) >>> 0
}
function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

// ---- Static Huffman codec: transmits code lengths, then the bitstream. ----
function huffmanCodecEncode(data: Uint8Array): Uint8Array {
  const counts = frequencies(data)
  const tree = buildTree(counts)
  const lengths = codeLengths(tree)
  const canonical = canonicalCodes(lengths)
  const codeMap = new Map<number, string>()
  for (const c of canonical) codeMap.set(c.symbol, c.code)

  const header: number[] = []
  putU32(header, data.length)
  putU32(header, canonical.length)
  for (const c of canonical) header.push(c.symbol, c.length) // length ≤ 255 for lab inputs

  const w = new BitWriter()
  for (const b of data) {
    const code = codeMap.get(b)
    if (code) for (const ch of code) w.writeBit(ch === '1' ? 1 : 0)
  }
  return concat([Uint8Array.from(header), w.finish()])
}
function huffmanCodecDecode(comp: Uint8Array): Uint8Array {
  const length = getU32(comp, 0)
  const numSyms = getU32(comp, 4)
  let off = 8
  const lengths = new Map<number, number>()
  for (let i = 0; i < numSyms; i++) {
    lengths.set(comp[off], comp[off + 1])
    off += 2
  }
  const canonical = canonicalCodes(lengths)
  const byCode = new Map<string, number>()
  let maxLen = 0
  for (const c of canonical) {
    byCode.set(c.code, c.symbol)
    if (c.length > maxLen) maxLen = c.length
  }
  const reader = new BitReader(comp.subarray(off))
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) {
    let acc = ''
    for (let l = 0; l <= maxLen; l++) {
      acc += reader.readBit() === 1 ? '1' : '0'
      const sym = byCode.get(acc)
      if (sym !== undefined) {
        out[i] = sym
        break
      }
    }
  }
  return out
}

// ---- Adaptive arithmetic codecs (order-0 and order-1). No table transmitted. ----
function arithCodec(make: () => Model): Pick<Codec, 'encode' | 'decode'> {
  return {
    encode(data) {
      const { encoded } = arithEncode(data, make)
      const header: number[] = []
      putU32(header, data.length)
      return concat([Uint8Array.from(header), encoded])
    },
    decode(comp) {
      const length = getU32(comp, 0)
      return arithDecode(comp.subarray(4), length, make)
    },
  }
}

// ---- LZ77 / LZW codecs (length-prefixed) ----
function lz77CodecEncode(data: Uint8Array): Uint8Array {
  const { encoded } = lz77Encode(data)
  const header: number[] = []
  putU32(header, data.length)
  return concat([Uint8Array.from(header), encoded])
}
function lz77CodecDecode(comp: Uint8Array): Uint8Array {
  return lz77Decode(comp.subarray(4), getU32(comp, 0))
}
function lzwCodecEncode(data: Uint8Array): Uint8Array {
  const { encoded } = lzwEncode(data)
  const header: number[] = []
  putU32(header, data.length)
  return concat([Uint8Array.from(header), encoded])
}
function lzwCodecDecode(comp: Uint8Array): Uint8Array {
  return lzwDecode(comp.subarray(4), getU32(comp, 0))
}

// ---- bzip-lite: BWT → MTF → RLE → adaptive arithmetic ----
function bzipEncode(data: Uint8Array): Uint8Array {
  const { transformed, primaryIndex } = bwtEncode(data)
  const mtf = mtfEncode(transformed)
  const rle = rleEncode(mtf)
  const { encoded } = arithEncode(rle, () => new Order0Adaptive(256))
  const header: number[] = []
  putU32(header, data.length) // == transformed length
  putU32(header, primaryIndex)
  putU32(header, rle.length) // symbols the arith coder must produce
  return concat([Uint8Array.from(header), encoded])
}
function bzipDecode(comp: Uint8Array): Uint8Array {
  const origLen = getU32(comp, 0)
  const primaryIndex = getU32(comp, 4)
  const rleLen = getU32(comp, 8)
  const rle = arithDecode(comp.subarray(12), rleLen, () => new Order0Adaptive(256))
  const mtf = rleDecode(rle)
  const transformed = mtfDecode(mtf).subarray(0, origLen)
  return bwtDecode(transformed, primaryIndex)
}

// ---- deflate-lite: LZ77 token stream entropy-coded ----
// LL alphabet: 0..255 literals, 256..(256+16-1) match-length codes. Distances go
// into their own raw 12-bit stream (one per match), mirroring DEFLATE's split of
// literal/length vs distance. The LL stream is order-0 adaptive-arithmetic coded.
const LL_ALPHABET = 256 + (LZ77_PARAMS.MAX_MATCH - LZ77_PARAMS.MIN_MATCH + 1) // 272
function deflateEncode(data: Uint8Array): Uint8Array {
  const { tokens } = lz77Encode(data)
  const symbols: number[] = []
  const distW = new BitWriter()
  for (const t of tokens) {
    if (t.kind === 'lit') {
      symbols.push(t.byte)
    } else {
      symbols.push(256 + (t.length - LZ77_PARAMS.MIN_MATCH))
      distW.writeBits(t.distance - 1, LZ77_PARAMS.WINDOW_BITS)
    }
  }
  // The LL alphabet is 272 > 256, so we drive the coder over a number[] directly.
  const { encoded } = arithEncodeWide(symbols, LL_ALPHABET)
  const dist = distW.finish()
  const header: number[] = []
  putU32(header, data.length)
  putU32(header, symbols.length)
  putU32(header, encoded.length)
  return concat([Uint8Array.from(header), encoded, dist])
}
function deflateDecode(comp: Uint8Array): Uint8Array {
  const origLen = getU32(comp, 0)
  const numSyms = getU32(comp, 4)
  const arithLen = getU32(comp, 8)
  const symbols = arithDecodeWide(comp.subarray(12, 12 + arithLen), numSyms, LL_ALPHABET)
  const distReader = new BitReader(comp.subarray(12 + arithLen))
  const out = new Uint8Array(origLen)
  let pos = 0
  for (const s of symbols) {
    if (s < 256) {
      out[pos++] = s
    } else {
      const length = s - 256 + LZ77_PARAMS.MIN_MATCH
      const distance = distReader.readBits(LZ77_PARAMS.WINDOW_BITS) + 1
      const from = pos - distance
      for (let k = 0; k < length; k++) out[pos + k] = out[from + k]
      pos += length
    }
  }
  return out
}

// Wide-alphabet adaptive arithmetic over a number[] (alphabet > 256). Reuses the
// same integer coder; only the model's alphabet size differs.
function arithEncodeWide(symbols: number[], alphabet: number): { encoded: Uint8Array } {
  const model = new Order0Adaptive(alphabet)
  const w = new BitWriter()
  const PRECISION = 32
  const WHOLE = 2 ** PRECISION
  const HALF = WHOLE / 2
  const QUARTER = WHOLE / 4
  const THREE_Q = 3 * QUARTER
  let low = 0
  let high = WHOLE - 1
  let pending = 0
  const emit = (bit: number) => {
    w.writeBit(bit)
    while (pending > 0) {
      w.writeBit(bit ^ 1)
      pending--
    }
  }
  for (const sym of symbols) {
    const total = model.total()
    const [cLow, cHigh] = model.encodeRange(sym)
    const range = high - low + 1
    high = low + Math.floor((range * cHigh) / total) - 1
    low = low + Math.floor((range * cLow) / total)
    for (;;) {
      if (high < HALF) emit(0)
      else if (low >= HALF) {
        emit(1)
        low -= HALF
        high -= HALF
      } else if (low >= QUARTER && high < THREE_Q) {
        pending++
        low -= QUARTER
        high -= QUARTER
      } else break
      low = low * 2
      high = high * 2 + 1
    }
    model.update(sym)
  }
  pending++
  emit(low < QUARTER ? 0 : 1)
  return { encoded: w.finish() }
}
function arithDecodeWide(encoded: Uint8Array, length: number, alphabet: number): number[] {
  const model = new Order0Adaptive(alphabet)
  const r = new BitReader(encoded)
  const out: number[] = []
  const PRECISION = 32
  const WHOLE = 2 ** PRECISION
  const HALF = WHOLE / 2
  const QUARTER = WHOLE / 4
  const THREE_Q = 3 * QUARTER
  let low = 0
  let high = WHOLE - 1
  let code = 0
  for (let i = 0; i < PRECISION; i++) code = code * 2 + r.readBit()
  for (let n = 0; n < length; n++) {
    const total = model.total()
    const range = high - low + 1
    const scaled = Math.floor(((code - low + 1) * total - 1) / range)
    const { symbol, low: cLow, high: cHigh } = model.decodeSymbol(scaled)
    out.push(symbol)
    high = low + Math.floor((range * cHigh) / total) - 1
    low = low + Math.floor((range * cLow) / total)
    for (;;) {
      if (high < HALF) {
        // noop
      } else if (low >= HALF) {
        low -= HALF
        high -= HALF
        code -= HALF
      } else if (low >= QUARTER && high < THREE_Q) {
        low -= QUARTER
        high -= QUARTER
        code -= QUARTER
      } else break
      low = low * 2
      high = high * 2 + 1
      code = code * 2 + r.readBit()
    }
    model.update(symbol)
  }
  return out
}

// ---- Static rANS codec: transmits the normalised frequency table, then the
// state-normalisation byte stream. A modern, table-driven entropy backend that
// reaches the same order-0 floor as the arithmetic coder by a different route. ----
function ransCodecEncode(data: Uint8Array): Uint8Array {
  const table = tableFromData(data)
  const { encoded } = ransEncode(data, table)
  const header: number[] = []
  putU32(header, data.length)
  const tableBytes = serialiseTable(table)
  return concat([Uint8Array.from(header), Uint8Array.from(tableBytes), encoded])
}
function ransCodecDecode(comp: Uint8Array): Uint8Array {
  const length = getU32(comp, 0)
  const { table, next } = deserialiseTable(comp, 4)
  return ransDecode(comp.subarray(next), length, table)
}

// ---- Static tANS codec: same transmitted table as rANS, decoded by a pure
// finite-state machine (table lookups + shifts, no multiplies) — the FSE entropy
// backend of Zstandard. Reaches the same quantised floor as rANS by a different
// mechanism, so the two agree to within table-rounding on every input. ----
function tansCodecEncode(data: Uint8Array): Uint8Array {
  const table = tansTableFromData(data)
  const { encoded } = tansEncode(data, table)
  const header: number[] = []
  putU32(header, data.length)
  const tableBytes = serialiseTable(table)
  return concat([Uint8Array.from(header), Uint8Array.from(tableBytes), encoded])
}
function tansCodecDecode(comp: Uint8Array): Uint8Array {
  const length = getU32(comp, 0)
  const { table, next } = deserialiseTable(comp, 4)
  return tansDecode(comp.subarray(next), length, table)
}

// ---- PPM codec (order-4 PPMC): a context-mixing coder that models the previous
// up-to-4 bytes with escape+exclusion, range-coded. The maxOrder is transmitted
// so decode rebuilds the identical model. ----
const PPM_ORDER = 4
function ppmCodecEncode(data: Uint8Array): Uint8Array {
  const { encoded } = ppmEncode(data, PPM_ORDER)
  const header: number[] = []
  putU32(header, data.length)
  header.push(PPM_ORDER)
  return concat([Uint8Array.from(header), encoded])
}
function ppmCodecDecode(comp: Uint8Array): Uint8Array {
  const length = getU32(comp, 0)
  const order = comp[4]
  return ppmDecode(comp.subarray(5), length, order)
}

// ---- Adaptive (FGK) Huffman codec: one-pass, self-synchronising — no table. ----
function adaptiveHuffmanCodecEncode(data: Uint8Array): Uint8Array {
  const { encoded } = adaptiveHuffmanEncode(data)
  const header: number[] = []
  putU32(header, data.length)
  return concat([Uint8Array.from(header), encoded])
}
function adaptiveHuffmanCodecDecode(comp: Uint8Array): Uint8Array {
  return adaptiveHuffmanDecode(comp.subarray(4), getU32(comp, 0))
}

// ---- Context-mixing codec (PAQ/lpaq class): a logistic mixer over order-0..6,
// word and match models, refined by two SSE stages and coded a bit at a time by a
// binary arithmetic coder. Nothing is transmitted but the length + coded stream —
// the decoder rebuilds the identical model and replays the identical updates. ----
function cmCodecEncode(data: Uint8Array): Uint8Array {
  const { encoded } = cmEncode(data)
  const header: number[] = []
  putU32(header, data.length)
  return concat([Uint8Array.from(header), encoded])
}
function cmCodecDecode(comp: Uint8Array): Uint8Array {
  return cmDecode(comp.subarray(4), getU32(comp, 0))
}

export const CODECS: Codec[] = [
  {
    id: 'huffman',
    name: 'Huffman (static)',
    family: 'entropy',
    blurb: 'Optimal integer-length prefix code; transmits a canonical length table.',
    encode: huffmanCodecEncode,
    decode: huffmanCodecDecode,
  },
  {
    id: 'adaptive-huffman',
    name: 'Huffman (adaptive · FGK)',
    family: 'entropy',
    blurb: 'One-pass adaptive prefix code; the tree mutates as symbols arrive — no table sent.',
    encode: adaptiveHuffmanCodecEncode,
    decode: adaptiveHuffmanCodecDecode,
  },
  {
    id: 'arith0',
    name: 'Arithmetic · order-0',
    family: 'entropy',
    blurb: 'Adaptive memoryless arithmetic coder; reaches the order-0 entropy, no table.',
    ...arithCodec(() => new Order0Adaptive(256)),
  } as Codec,
  {
    id: 'arith1',
    name: 'Arithmetic · order-1',
    family: 'entropy',
    blurb: 'Context model on the previous byte; exploits order-1 structure of text.',
    ...arithCodec(() => new Order1Adaptive(256)),
  } as Codec,
  {
    id: 'rans',
    name: 'rANS (static)',
    family: 'entropy',
    blurb: 'Asymmetric numeral system — zstd/LZFSE-class entropy coder; byte-wise renorm.',
    encode: ransCodecEncode,
    decode: ransCodecDecode,
  },
  {
    id: 'tans',
    name: 'tANS / FSE',
    family: 'entropy',
    blurb: 'Table-driven ANS — the multiply-free finite-state entropy coder inside Zstandard.',
    encode: tansCodecEncode,
    decode: tansCodecDecode,
  },
  {
    id: 'ppm',
    name: 'PPM · order-4',
    family: 'entropy',
    blurb: 'Prediction by partial matching (PPMC): escape + exclusion over 0..4-byte contexts.',
    encode: ppmCodecEncode,
    decode: ppmCodecDecode,
  },
  {
    id: 'cm',
    name: 'Context mixing (PAQ)',
    family: 'entropy',
    blurb:
      'A logistic mixer over order-0..6 + word + match models, SSE-refined and bit-arithmetic-coded — the state-of-the-art family. Usually the best all-rounder here.',
    encode: cmCodecEncode,
    decode: cmCodecDecode,
  },
  {
    id: 'lz77',
    name: 'LZ77 / LZSS',
    family: 'dictionary',
    blurb: 'Sliding-window back-references; the dictionary half of DEFLATE.',
    encode: lz77CodecEncode,
    decode: lz77CodecDecode,
  },
  {
    id: 'lzw',
    name: 'LZW',
    family: 'dictionary',
    blurb: 'Self-building dictionary of growing codes; powers GIF and Unix compress.',
    encode: lzwCodecEncode,
    decode: lzwCodecDecode,
  },
  {
    id: 'deflate',
    name: 'DEFLATE-lite',
    family: 'dictionary',
    blurb: 'LZ77 tokens entropy-coded (arithmetic LL stream + raw distances).',
    encode: deflateEncode,
    decode: deflateDecode,
  },
  {
    id: 'gzip',
    name: 'gzip (real DEFLATE)',
    family: 'dictionary',
    blurb:
      'The genuine RFC 1951/1952 codec: hash-chain LZ77 + fixed/dynamic Huffman, CRC-32 checked. Interoperates byte-for-byte with the OS gzip.',
    encode: (data) => gzipEncode(data),
    decode: (comp) => gzipDecode(comp).data,
  },
  {
    id: 'bzip',
    name: 'bzip-lite (BWT)',
    family: 'transform',
    blurb: 'Burrows–Wheeler → move-to-front → RLE → arithmetic, the bzip2 stack.',
    encode: bzipEncode,
    decode: bzipDecode,
  },
]
