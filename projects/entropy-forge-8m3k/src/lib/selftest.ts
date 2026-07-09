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
import { ppmDecode, ppmEncode } from './ppm.ts'
import { ransDecode, ransEncode, tableFromData, serialiseTable, deserialiseTable } from './rans.ts'
import { tansEncode, tansDecode, tansTableFromData } from './tans.ts'
import { adaptiveHuffmanDecode, adaptiveHuffmanEncode } from './adaptiveHuffman.ts'
import { cmEncode, cmDecode } from './cm.ts'
import { lzmaEncode, lzmaDecode, parseProps } from './lzma.ts'
import { bwtDecodeSA, bwtEncodeSA, suffixArray, suffixArrayNaive } from './suffixArray.ts'
import { packageMerge, minLimit } from './lengthLimited.ts'
import { canonicalCodes } from './huffman.ts'
import { frequencies } from './entropy.ts'
import { deflate, inflate } from './deflate.ts'
import { gzipEncode, gzipDecode, zlibEncode, zlibDecode } from './gzip.ts'
import { crc32, adler32 } from './crc32.ts'
import {
  encodePNG,
  decodePNG,
  rastersEqual,
  rasterToRGBA,
  rowBytes,
  CHANNELS,
  ALLOWED_DEPTHS,
  type ColorType,
  type Raster,
  type FilterStrategy,
} from './png.ts'
import { PNG_VECTORS, base64ToBytes, fnv1a } from './pngVectors.ts'
import { GF256 } from './galois.ts'
import { HAMMING_7_4, HAMMING_8_4, decodeSecDed, hammingFamily } from './hamming.ts'
import { encodeLinear, decodeLinear, repetitionCode } from './linearCode.ts'
import { rsEncode, rsDecode } from './reedSolomon.ts'
import { CONV_7_5, CONV_171_133, convEncode, viterbiDecode, freeDistance } from './convolutional.ts'
import { LDPC_DEMO, ldpcEncode, ldpcMessage, ldpcSyndromeZero, bpDecodeLLR, bscLLR } from './ldpc.ts'
import {
  constructPolar,
  polarEncode,
  polarTransform,
  scDecode,
  sclDecode,
  bhattacharyyaBEC,
  appendCrc,
  crcValid,
  CRC8,
} from './polar.ts'
import { RNG as ChannelRNG, awgn as channelAwgn, ebN0dBtoEsN0 } from './channel.ts'
import {
  channelCapacity,
  bscMatrix,
  becMatrix,
  zChannelMatrix,
  zChannelCapacity,
  noiselessMatrix,
  typewriterMatrix,
  rdCurve,
  bernoulliSource,
  hammingDistortion,
  binEntropy,
  bernoulliRD,
  gaussianRD,
  discreteGaussian,
} from './blahutArimoto.ts'
import {
  lloydMax,
  uniformQuantizer,
  DENSITIES,
  lbg,
  sampleMixture,
  QRng,
} from './quantize.ts'
import { fdct8x8, idct8x8, ZIGZAG as JZIGZAG, DEZIGZAG as JDEZIGZAG } from './dct.ts'
import { encodeJPEG, decodeJPEG, psnr as jpsnr, rgbToYCbCr, yCbCrToRgb, type Subsampling } from './jpeg.ts'
import { SAMPLES as IMG_SAMPLES } from './pngSamples.ts'
import type { RGBAImage } from './png.ts'

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
    // rANS primitive (with a serialised/rebuilt table, as the codec transmits it)
    try {
      const tbl = tableFromData(data)
      const rr = ransEncode(data, tbl)
      const { table: rebuilt } = deserialiseTable(Uint8Array.from(serialiseTable(tbl)), 0)
      const back = ransDecode(rr.encoded, data.length, rebuilt)
      results.push({ group: 'rANS (primitive)', name, pass: bytesEqual(back, data), detail: `${rr.bytesOut}B state stream` })
    } catch (e) {
      results.push({ group: 'rANS (primitive)', name, pass: false, detail: (e as Error).message })
    }
    // tANS / FSE primitive: round-trips through a rebuilt table, AND — sharing
    // rANS's normalised model — lands within a whisker of rANS's size (both hit
    // the same quantised entropy floor by different machinery).
    try {
      const tbl = tansTableFromData(data)
      const tr = tansEncode(data, tbl)
      const { table: rebuilt } = deserialiseTable(Uint8Array.from(serialiseTable(tbl)), 0)
      const back = tansDecode(tr.encoded, data.length, rebuilt)
      const rr = ransEncode(data, tableFromData(data))
      // Both stream payloads code the same quantised floor; a few bytes of
      // state-flush difference is all that separates them.
      const close = Math.abs(tr.encoded.length - rr.encoded.length) <= 8
      results.push({
        group: 'tANS (primitive)',
        name,
        pass: bytesEqual(back, data),
        detail: `${tr.encoded.length}B stream`,
      })
      results.push({
        group: 'tANS ≈ rANS (same floor)',
        name,
        pass: close,
        detail: `tANS ${tr.encoded.length}B vs rANS ${rr.encoded.length}B`,
      })
    } catch (e) {
      results.push({ group: 'tANS (primitive)', name, pass: false, detail: (e as Error).message })
    }
    // PPM primitive at several orders (context modelling round-trips at each order)
    for (const order of [0, 2, 4]) {
      try {
        const pe = ppmEncode(data, order)
        const pd = ppmDecode(pe.encoded, data.length, order)
        results.push({ group: `PPM-o${order} (primitive)`, name, pass: bytesEqual(pd, data), detail: `${(pe.encodedBits / 8).toFixed(0)}B` })
      } catch (e) {
        results.push({ group: `PPM-o${order} (primitive)`, name, pass: false, detail: (e as Error).message })
      }
    }
    // Adaptive (FGK) Huffman primitive
    try {
      const ae = adaptiveHuffmanEncode(data)
      const ad = adaptiveHuffmanDecode(ae.encoded, data.length)
      results.push({ group: 'Adaptive-Huffman (primitive)', name, pass: bytesEqual(ad, data), detail: `${ae.symbolsSeen} first-seen` })
    } catch (e) {
      results.push({ group: 'Adaptive-Huffman (primitive)', name, pass: false, detail: (e as Error).message })
    }
    // Context-mixing (PAQ) primitive: the panel + mixer + SSE + binary coder must
    // round-trip exactly — encode and decode replay the identical model updates.
    try {
      const ce = cmEncode(data)
      const cd = cmDecode(ce.encoded, data.length)
      results.push({ group: 'Context-mixing (primitive)', name, pass: bytesEqual(cd, data), detail: `${ce.encoded.length}B` })
    } catch (e) {
      results.push({ group: 'Context-mixing (primitive)', name, pass: false, detail: (e as Error).message })
    }
    // LZMA (the 7-Zip / xz coder): the binary range coder + 12-state context
    // machine + rep-distance MRU list must round-trip, the stream must open with
    // the reference's leading zero byte, and the encoder must be deterministic
    // (encode twice → identical bytes, the invariant that lets decode replay it).
    try {
      const le = lzmaEncode(data, { collectTokens: false })
      const lb = lzmaDecode(le.encoded, data.length)
      const roundTrips = bytesEqual(lb, data)
      // encoded[0] is the LZMA properties byte; the range stream's own leading
      // zero byte is at index 1. The props must round-trip to the chosen model.
      const props = parseProps(le.encoded[0])
      const propsOk =
        props.lc === le.props.lc && props.lp === le.props.lp && props.pb === le.props.pb
      const leadOk = data.length === 0 || le.encoded[1] === 0
      const le2 = lzmaEncode(data)
      const deterministic = bytesEqual(le.encoded, le2.encoded)
      results.push({
        group: 'LZMA (primitive)',
        name,
        pass: roundTrips,
        detail: `${data.length}B → ${le.encoded.length}B · lc/lp/pb ${le.props.lc}/${le.props.lp}/${le.props.pb} · ${le.stats.reps} rep / ${le.stats.matches} match`,
      })
      results.push({
        group: 'LZMA · props + leading byte + determinism',
        name,
        pass: propsOk && leadOk && deterministic,
        detail: `${propsOk ? 'props ok' : 'BAD props'} · ${leadOk ? 'lead ok' : 'BAD lead'} · ${deterministic ? 'deterministic' : 'NONDETERMINISTIC'}`,
      })
    } catch (e) {
      results.push({ group: 'LZMA (primitive)', name, pass: false, detail: (e as Error).message })
    }
    // SA-IS suffix array matches the brute-force oracle, and SA-BWT round-trips
    try {
      const fast = suffixArray(data)
      const slow = suffixArrayNaive(data)
      let saOk = fast.length === slow.length
      for (let i = 0; saOk && i < fast.length; i++) if (fast[i] !== slow[i]) saOk = false
      results.push({ group: 'Suffix array (SA-IS = oracle)', name, pass: saOk, detail: `${fast.length} suffixes` })
      const { transformed, sentinelRow } = bwtEncodeSA(data)
      const saBack = bwtDecodeSA(transformed, sentinelRow)
      results.push({ group: 'BWT via suffix array', name, pass: bytesEqual(saBack, data), detail: `row ${sentinelRow}` })
    } catch (e) {
      results.push({ group: 'Suffix array (SA-IS)', name, pass: false, detail: (e as Error).message })
    }
    // Length-limited Huffman (package-merge): every length ≤ cap, Kraft ≤ 1, and
    // the canonical codes are genuinely prefix-free.
    try {
      const counts = frequencies(data)
      const distinct = counts.filter((c) => c > 0).length
      if (distinct >= 2) {
        const cap = Math.max(minLimit(distinct), minLimit(distinct) + 1)
        const ll = packageMerge(counts, cap)
        let kraft = 0
        for (const l of ll.lengths.values()) kraft += Math.pow(2, -l)
        const canon = canonicalCodes(ll.lengths)
        let prefixFree = true
        const codes = canon.map((c) => c.code)
        for (let a = 0; a < codes.length && prefixFree; a++) {
          for (let b = 0; b < codes.length; b++) {
            if (a !== b && codes[b].startsWith(codes[a])) { prefixFree = false; break }
          }
        }
        const pass = ll.maxUsed <= cap && kraft <= 1.0000001 && prefixFree && ll.lengths.size === distinct
        results.push({ group: 'Length-limited Huffman', name, pass, detail: `cap ${cap}, depth ${ll.maxUsed}, Kraft ${kraft.toFixed(3)}` })
      } else {
        results.push({ group: 'Length-limited Huffman', name, pass: true, detail: '<2 symbols (n/a)' })
      }
    } catch (e) {
      results.push({ group: 'Length-limited Huffman', name, pass: false, detail: (e as Error).message })
    }
    // Real DEFLATE: every block strategy inflates back to the input, and the
    // gzip/zlib containers verify their own checksums on decode.
    try {
      for (const strategy of ['stored', 'fixed', 'dynamic', 'auto'] as const) {
        const r = deflate(data, { strategy })
        const back = inflate(r.bytes)
        results.push({
          group: `DEFLATE · ${strategy}`,
          name,
          pass: bytesEqual(back, data),
          detail: `${r.bytes.length}B${strategy === 'auto' ? ` (chose ${r.chosen})` : ''}`,
        })
      }
      const gz = gzipEncode(data, { filename: 'x' })
      const gd = gzipDecode(gz)
      results.push({
        group: 'gzip container',
        name,
        pass: bytesEqual(gd.data, data) && gd.crcOk && gd.sizeOk,
        detail: `${gz.length}B · CRC ${gd.crcOk ? 'ok' : 'BAD'}`,
      })
      const zl = zlibEncode(data)
      const zd = zlibDecode(zl)
      results.push({
        group: 'zlib container',
        name,
        pass: bytesEqual(zd.data, data) && zd.adlerOk,
        detail: `${zl.length}B · Adler ${zd.adlerOk ? 'ok' : 'BAD'}`,
      })
    } catch (e) {
      results.push({ group: 'DEFLATE / gzip', name, pass: false, detail: (e as Error).message })
    }
  }

  // Checksum known-answer vectors — the canonical test strings every CRC/Adler
  // implementation is checked against.
  results.push({
    group: 'Checksums',
    name: 'CRC-32("123456789") = 0xCBF43926',
    pass: crc32(strToBytes('123456789')) === 0xcbf43926,
    detail: `0x${crc32(strToBytes('123456789')).toString(16)}`,
  })
  results.push({
    group: 'Checksums',
    name: 'Adler-32("Wikipedia") = 0x11E60398',
    pass: adler32(strToBytes('Wikipedia')) === 0x11e60398,
    detail: `0x${adler32(strToBytes('Wikipedia')).toString(16)}`,
  })

  // ---- PNG codec (from scratch, on our own DEFLATE) ----
  runPngTests(results)

  // ---- JPEG codec (the lossy pillar — DCT + quantisation + Huffman) ----
  runJpegTests(results)

  // ---- Channel coding (Shannon's other theorem) ----
  runChannelTests(results)

  // ---- Rate–distortion theory + optimal quantisation ----
  runRateDistortionTests(results)

  return results
}

// The lossy pillar gets its own correctness gate. Unlike the lossless codecs it
// cannot be checked by bit-exact round-trip (lossy means the pixels legitimately
// differ), so the invariants are: (1) the DCT is an exact orthonormal transform,
// (2) the colour transform inverts to ≤1 LSB, (3) the full codec reconstructs
// within a fidelity floor that rises with quality and never *beats* 4:4:4 when
// subsampling, (4) the bitstream is a well-formed, byte-stuffed JFIF file, and
// (5) the encoder is deterministic (which is what lets a decoder replay it).
function runJpegTests(results: TestCase[]): void {
  // (1) DCT / zig-zag
  let dctErr = 0
  let ls = 0x9e3779b9 >>> 0
  const rnd = () => {
    ls = (1103515245 * ls + 12345) >>> 0
    return (ls >>> 8) / (1 << 24)
  }
  for (let t = 0; t < 300; t++) {
    const b = new Float64Array(64)
    for (let i = 0; i < 64; i++) b[i] = Math.round(rnd() * 255) - 128
    const r = idct8x8(fdct8x8(b))
    for (let i = 0; i < 64; i++) dctErr = Math.max(dctErr, Math.abs(b[i] - r[i]))
  }
  results.push({ group: 'JPEG · DCT', name: 'idct∘fdct = identity (orthonormal)', pass: dctErr < 1e-9, detail: `max err ${dctErr.toExponential(1)} over 300 blocks` })
  const constBlk = new Float64Array(64).fill(10)
  const cf = fdct8x8(constBlk)
  let ac = 0
  for (let i = 1; i < 64; i++) ac += Math.abs(cf[i])
  results.push({ group: 'JPEG · DCT', name: 'flat block → DC=8·v, all AC = 0', pass: Math.abs(cf[0] - 80) < 1e-9 && ac < 1e-9, detail: `DC=${cf[0].toFixed(3)}` })
  const eb = new Float64Array(64)
  for (let i = 0; i < 64; i++) eb[i] = ((i * 37) % 200) - 100
  const ef = fdct8x8(eb)
  let e0 = 0, e1 = 0
  for (let i = 0; i < 64; i++) { e0 += eb[i] * eb[i]; e1 += ef[i] * ef[i] }
  results.push({ group: 'JPEG · DCT', name: 'energy preserved (Parseval)', pass: Math.abs(e0 - e1) < 1e-6, detail: `Σ|f|² ${e0.toFixed(1)} = Σ|F|² ${e1.toFixed(1)}` })
  const zzSet = new Set(JZIGZAG)
  results.push({ group: 'JPEG · DCT', name: 'zig-zag scan is a bijection of 0..63', pass: zzSet.size === 64 && JZIGZAG.every((v, k) => JDEZIGZAG[v] === k), detail: '64 distinct positions, inverse consistent' })

  // (2) colour transform
  let cErr = 0
  for (let r = 0; r <= 255; r += 17) for (let g = 0; g <= 255; g += 17) for (let b = 0; b <= 255; b += 17) {
    const [Y, Cb, Cr] = rgbToYCbCr(r, g, b)
    const [rr, gg, bb] = yCbCrToRgb(Y, Cb, Cr)
    cErr = Math.max(cErr, Math.abs(r - rr), Math.abs(g - gg), Math.abs(b - bb))
  }
  results.push({ group: 'JPEG · colour', name: 'RGB↔YCbCr inverts to ≤1 LSB', pass: cErr <= 1, detail: `max err ${cErr}` })

  // (3)+(4)+(5) the full codec
  const sample = (id: string, w: number, h: number): RGBAImage => IMG_SAMPLES.find((s) => s.id === id)!.make(w, h)
  const subs: Subsampling[] = ['4:4:4', '4:2:2', '4:2:0']
  for (const id of ['gradient', 'wheel', 'photo', 'rings']) {
    const img = sample(id, 48, 40)
    let pFull = 0
    let allSane = true
    let framing = true
    let stuffing = true
    for (const sub of subs) {
      const enc = encodeJPEG(img, { quality: 90, subsampling: sub })
      const dec = decodeJPEG(enc.bytes)
      const p = jpsnr(img, dec.image)
      if (sub === '4:4:4') pFull = p
      if (dec.width !== img.width || dec.height !== img.height) allSane = false
      if (sub === '4:4:4' ? p < 30 : p < 18 || p > pFull + 0.5) allSane = false
      if (enc.bytes[0] !== 0xff || enc.bytes[1] !== 0xd8 || enc.bytes[enc.bytes.length - 2] !== 0xff || enc.bytes[enc.bytes.length - 1] !== 0xd9) framing = false
      const seg = enc.markers.find((m) => m.name === 'entropy data')
      if (seg) for (let i = seg.offset; i < seg.offset + seg.length - 1; i++) if (enc.bytes[i] === 0xff && enc.bytes[i + 1] !== 0x00) stuffing = false
    }
    results.push({ group: 'JPEG · codec', name: `${id}: 4:4:4 high-fidelity, subsampling ≤ 4:4:4`, pass: allSane, detail: allSane ? `4:4:4 PSNR ${pFull.toFixed(1)} dB` : 'fidelity out of range' })
    results.push({ group: 'JPEG · container', name: `${id}: SOI…EOI framing + entropy byte-stuffing`, pass: framing && stuffing, detail: framing && stuffing ? 'valid JFIF, every 0xFF stuffed' : 'malformed stream' })
  }

  // near-lossless at q100 4:4:4
  {
    const img = sample('gradient', 32, 32)
    const p = jpsnr(img, decodeJPEG(encodeJPEG(img, { quality: 100, subsampling: '4:4:4' }).bytes).image)
    results.push({ group: 'JPEG · codec', name: 'quality 100 / 4:4:4 is near-lossless', pass: p > 45, detail: `PSNR ${p.toFixed(1)} dB` })
  }

  // quality monotonicity + rate–distortion (more bits buy more fidelity)
  {
    const img = sample('photo', 64, 48)
    let prevP = -1, prevSize = -1
    let monoP = true, monoS = true
    for (const q of [20, 40, 60, 80, 95]) {
      const enc = encodeJPEG(img, { quality: q, subsampling: '4:2:0' })
      const p = jpsnr(img, decodeJPEG(enc.bytes).image)
      if (p < prevP - 0.5) monoP = false
      if (enc.bytes.length < prevSize) monoS = false
      prevP = p
      prevSize = enc.bytes.length
    }
    results.push({ group: 'JPEG · rate–distortion', name: 'PSNR rises monotonically with quality', pass: monoP, detail: 'the operational R–D curve is well-ordered' })
    results.push({ group: 'JPEG · rate–distortion', name: 'file size grows with quality', pass: monoS, detail: 'more rate → less distortion' })
  }

  // grayscale + determinism
  {
    const img = sample('photo', 40, 32)
    const enc = encodeJPEG(img, { quality: 85, grayscale: true })
    const dec = decodeJPEG(enc.bytes)
    const gray = dec.components === 1 && dec.image.rgba[0] === dec.image.rgba[1] && dec.image.rgba[1] === dec.image.rgba[2]
    results.push({ group: 'JPEG · codec', name: 'grayscale: 1 component, R=G=B out', pass: gray, detail: `${dec.components} component` })
    const a = encodeJPEG(img, { quality: 77 }).bytes
    const b = encodeJPEG(img, { quality: 77 }).bytes
    results.push({ group: 'JPEG · codec', name: 'encoder is deterministic', pass: bytesEqual(a, b), detail: `${a.length}B, identical twice` })
  }

  // odd dimensions (MCU edge padding), isolated from chroma subsampling
  {
    let ok = true
    for (const [w, h] of [[7, 5], [17, 3], [1, 1], [33, 31]] as [number, number][]) {
      const img = sample('gradient', w, h)
      const dec = decodeJPEG(encodeJPEG(img, { quality: 90, subsampling: '4:4:4' }).bytes)
      if (dec.width !== w || dec.height !== h || jpsnr(img, dec.image) < 30) ok = false
      const dec2 = decodeJPEG(encodeJPEG(img, { quality: 85, subsampling: '4:2:0' }).bytes)
      if (dec2.width !== w || dec2.height !== h) ok = false
    }
    results.push({ group: 'JPEG · codec', name: 'odd dimensions padded & cropped exactly', pass: ok, detail: '7×5, 17×3, 1×1, 33×31 · 4:4:4 & 4:2:0' })
  }
}

// The channel-coding pillar earns its own correctness gate: every error-
// correcting code must decode∘channel∘encode = identity for every corruption
// within its guarantee, and flag or fail gracefully beyond it. Uses a
// deterministic LCG so the run is reproducible.
function runChannelTests(results: TestCase[]): void {
  let s = 0x1234abcd >>> 0
  const rnd = () => {
    s = (1103515245 * s + 12345) >>> 0
    return s >>> 8
  }
  const eq = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i])

  // --- GF(256) field axioms ---
  {
    let inverses = true
    for (let a = 1; a < 256 && inverses; a++) if (GF256.mul(a, GF256.inv(a)) !== 1) inverses = false
    results.push({ group: 'GF(256) field', name: 'a·a⁻¹ = 1 for all 255 non-zero elements', pass: inverses, detail: 'exp/log tables consistent' })
    results.push({ group: 'GF(256) field', name: 'α⁸ = 0x1D (primitive poly 0x11D)', pass: GF256.pow(2, 8) === 0x1d, detail: `α⁸ = 0x${GF256.pow(2, 8).toString(16)}` })
    let distributes = true
    for (let t = 0; t < 500 && distributes; t++) {
      const a = rnd() & 0xff, b = rnd() & 0xff, c = rnd() & 0xff
      if (GF256.mul(a, b ^ c) !== (GF256.mul(a, b) ^ GF256.mul(a, c))) distributes = false
    }
    results.push({ group: 'GF(256) field', name: 'distributivity a·(b⊕c) = a·b ⊕ a·c', pass: distributes, detail: '500 random triples' })
  }

  // --- Hamming(7,4): exhaustive single-error correction ---
  {
    let ok = true
    let checks = 0
    for (let m = 0; m < 16; m++) {
      const msg = [(m >> 3) & 1, (m >> 2) & 1, (m >> 1) & 1, m & 1]
      const cw = encodeLinear(HAMMING_7_4, msg)
      for (let e = 0; e < 7; e++) {
        const r = cw.slice()
        r[e] ^= 1
        checks++
        if (!eq(decodeLinear(HAMMING_7_4, r).message, msg)) ok = false
      }
    }
    results.push({ group: 'Hamming(7,4)', name: 'every single-bit error in every codeword corrected', pass: ok, detail: `${checks} exhaustive cases (16 msgs × 7 positions)` })
    results.push({ group: 'Hamming(7,4)', name: 'minimum distance d = 3, t = 1', pass: HAMMING_7_4.d === 3 && HAMMING_7_4.t === 1, detail: `d=${HAMMING_7_4.d}` })
  }

  // --- Extended Hamming(8,4) SEC-DED: correct singles, detect doubles ---
  {
    let singles = true, doubles = true, cs = 0, cd = 0
    for (let m = 0; m < 16; m++) {
      const msg = [(m >> 3) & 1, (m >> 2) & 1, (m >> 1) & 1, m & 1]
      const cw = encodeLinear(HAMMING_8_4, msg)
      for (let e = 0; e < 8; e++) {
        const r = cw.slice(); r[e] ^= 1; cs++
        const d = decodeSecDed(r)
        if (d.status !== 'corrected' || !eq(d.message, msg)) singles = false
      }
      for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) {
        const r = cw.slice(); r[a] ^= 1; r[b] ^= 1; cd++
        if (decodeSecDed(r).status !== 'double-error-detected') doubles = false
      }
    }
    results.push({ group: 'Extended Hamming(8,4) · SEC-DED', name: 'all single errors corrected', pass: singles, detail: `${cs} cases` })
    results.push({ group: 'Extended Hamming(8,4) · SEC-DED', name: 'all double errors detected (not mis-corrected)', pass: doubles, detail: `${cd} cases, d=${HAMMING_8_4.d}` })
  }

  // --- Hamming family scaling ---
  {
    const h15 = hammingFamily(4), h31 = hammingFamily(5)
    let ok15 = true
    for (let t = 0; t < 200 && ok15; t++) {
      const msg = Array.from({ length: 11 }, () => rnd() & 1)
      const cw = encodeLinear(h15, msg)
      const e = rnd() % 15
      const r = cw.slice(); r[e] ^= 1
      if (!eq(decodeLinear(h15, r).message, msg)) ok15 = false
    }
    results.push({ group: 'Hamming family', name: '(15,11) corrects any single error', pass: ok15 && h15.d === 3, detail: '200 random trials' })
    results.push({ group: 'Hamming family', name: '(31,26) parameters', pass: h31.n === 31 && h31.k === 26 && h31.d === 3, detail: `d=${h31.d}` })
    const rep = repetitionCode(5)
    results.push({ group: 'Linear codes', name: 'Repetition(5,1): d=5, corrects 2', pass: rep.d === 5 && rep.t === 2, detail: `d=${rep.d}` })
  }

  // --- Reed–Solomon: errors, bursts, erasures, and mixed ---
  {
    const configs: [number, number][] = [[15, 11], [26, 16], [26, 9], [40, 20], [255, 223]]
    let errOk = true, burstOk = true, eraseOk = true, mixOk = true
    let ce = 0, cb = 0, cr = 0, cm = 0
    for (const [n, k] of configs) {
      const t = Math.floor((n - k) / 2)
      const nsym = n - k
      for (let trial = 0; trial < 80; trial++) {
        const msg = Array.from({ length: k }, () => rnd() & 0xff)
        const cw = rsEncode(msg, nsym)
        // random errors up to t
        {
          const r = cw.slice()
          const ne = rnd() % (t + 1)
          const used = new Set<number>()
          for (let i = 0; i < ne; i++) { let p = rnd() % n; while (used.has(p)) p = rnd() % n; used.add(p); r[p] = (r[p] + 1 + (rnd() & 0x7f)) & 0xff }
          ce++
          try { if (!eq(rsDecode(r, nsym).message, msg)) errOk = false } catch { errOk = false }
        }
        // burst of t
        {
          const r = cw.slice()
          const start = rnd() % (n - t)
          for (let i = 0; i < t; i++) r[start + i] = (r[start + i] + 1 + (rnd() & 0x7f)) & 0xff
          cb++
          try { if (!eq(rsDecode(r, nsym).message, msg)) burstOk = false } catch { burstOk = false }
        }
        // erasures up to 2t
        {
          const r = cw.slice()
          const neras = rnd() % (2 * t + 1)
          const used = new Set<number>()
          const epos: number[] = []
          for (let i = 0; i < neras; i++) { let p = rnd() % n; while (used.has(p)) p = rnd() % n; used.add(p); epos.push(p); r[p] = rnd() & 0xff }
          cr++
          try { if (!eq(rsDecode(r, nsym, epos).message, msg)) eraseOk = false } catch { eraseOk = false }
        }
        // mixed: a errors + b erasures with 2a+b ≤ 2t
        {
          const r = cw.slice()
          const a = rnd() % (t + 1)
          const b = rnd() % (2 * t - 2 * a + 1)
          const used = new Set<number>()
          const epos: number[] = []
          for (let i = 0; i < b; i++) { let p = rnd() % n; while (used.has(p)) p = rnd() % n; used.add(p); epos.push(p); r[p] = rnd() & 0xff }
          for (let i = 0; i < a; i++) { let p = rnd() % n; while (used.has(p)) p = rnd() % n; used.add(p); r[p] = (r[p] + 1 + (rnd() & 0x7f)) & 0xff }
          cm++
          try { if (!eq(rsDecode(r, nsym, epos).message, msg)) mixOk = false } catch { mixOk = false }
        }
      }
    }
    results.push({ group: 'Reed–Solomon', name: 'up to t random symbol errors corrected', pass: errOk, detail: `${ce} trials across 5 (n,k)` })
    results.push({ group: 'Reed–Solomon', name: 'burst of t contiguous errors corrected', pass: burstOk, detail: `${cb} trials — RS's home turf` })
    results.push({ group: 'Reed–Solomon', name: 'up to 2t erasures corrected', pass: eraseOk, detail: `${cr} trials` })
    results.push({ group: 'Reed–Solomon', name: 'mixed errors+erasures within 2a+b ≤ 2t', pass: mixOk, detail: `${cm} trials (errata locator)` })
  }

  // --- Convolutional codes + Viterbi ---
  {
    results.push({ group: 'Convolutional', name: '(7,5) free distance = 5', pass: freeDistance(CONV_7_5) === 5, detail: `d_free=${freeDistance(CONV_7_5)}` })
    results.push({ group: 'Convolutional', name: '(171,133) free distance = 10', pass: freeDistance(CONV_171_133) === 10, detail: `d_free=${freeDistance(CONV_171_133)}` })
    for (const code of [CONV_7_5, CONV_171_133]) {
      let clean = true, single = true, cc = 0
      for (let trial = 0; trial < 120; trial++) {
        const bits = Array.from({ length: 20 + (rnd() % 30) }, () => rnd() & 1)
        const { coded } = convEncode(code, bits, true)
        if (!eq(viterbiDecode(code, coded, { terminate: true }).bits, bits)) clean = false
        const r = coded.slice(); r[rnd() % coded.length] ^= 1
        cc++
        if (!eq(viterbiDecode(code, r, { terminate: true }).bits, bits)) single = false
      }
      results.push({ group: 'Convolutional', name: `${code.name}: clean round-trip`, pass: clean, detail: '120 random streams' })
      results.push({ group: 'Convolutional', name: `${code.name}: any single channel error corrected`, pass: single, detail: `${cc} trials, hard-decision Viterbi` })
    }
    // soft decision on exact BPSK samples decodes clean
    let soft = true
    for (let trial = 0; trial < 60; trial++) {
      const bits = Array.from({ length: 30 }, () => rnd() & 1)
      const { coded } = convEncode(CONV_171_133, bits, true)
      const samples = coded.map((b) => (b === 0 ? 1 : -1))
      if (!eq(viterbiDecode(CONV_171_133, samples, { soft: true, terminate: true }).bits, bits)) soft = false
    }
    results.push({ group: 'Convolutional', name: 'soft-decision Viterbi on BPSK samples', pass: soft, detail: '60 trials, Euclidean metric' })
  }

  // --- LDPC + belief propagation ---
  {
    const code = LDPC_DEMO
    let valid = true, recover = true, single = true, cs = 0
    for (let trial = 0; trial < 200; trial++) {
      const msg = Array.from({ length: code.k }, () => rnd() & 1)
      const cw = ldpcEncode(code, msg)
      if (!ldpcSyndromeZero(code, cw)) valid = false
      if (!eq(ldpcMessage(code, cw), msg)) recover = false
      const r = cw.slice(); r[rnd() % code.n] ^= 1
      cs++
      const dec = bpDecodeLLR(code, bscLLR(r, 0.05), 50)
      if (!dec.success || !eq(dec.bits, cw)) single = false
    }
    results.push({ group: 'LDPC · belief propagation', name: `${code.name}: every encoded word is a valid codeword`, pass: valid, detail: 'H·cᵀ = 0, 200 msgs' })
    results.push({ group: 'LDPC · belief propagation', name: 'systematic message recovery', pass: recover, detail: 'info columns read back exactly' })
    results.push({ group: 'LDPC · belief propagation', name: 'BP corrects any single-bit error', pass: single, detail: `${cs} trials, sum-product LLR decode` })
    results.push({ group: 'LDPC · belief propagation', name: 'code is genuinely low-density', pass: code.colWeight <= 3 && code.rowWeight <= 6, detail: `col wt ${code.colWeight}, row wt ${code.rowWeight}` })
  }

  // --- Polar codes: transform, SC / SCL / CA-SCL, and polarisation ---
  {
    // The polar transform must equal Gₙ = F⊗ⁿ — verify by rebuilding the
    // generator from basis vectors and cross-checking a batch of random inputs.
    let linear = true
    for (const nn of [1, 2, 3, 4, 5]) {
      const N = 1 << nn
      const G: Uint8Array[] = []
      for (let i = 0; i < N; i++) {
        const e = new Uint8Array(N)
        e[i] = 1
        G.push(polarTransform(e))
      }
      for (let trial = 0; trial < 40 && linear; trial++) {
        const u = Array.from({ length: N }, () => rnd() & 1)
        const x = polarTransform(u)
        const ref = new Uint8Array(N)
        for (let i = 0; i < N; i++) if (u[i]) for (let j = 0; j < N; j++) ref[j] ^= G[i][j]
        for (let j = 0; j < N; j++) if (x[j] !== ref[j]) linear = false
      }
    }
    results.push({ group: 'Polar codes', name: 'transform equals Gₙ = F⊗ⁿ (linearity)', pass: linear, detail: 'N up to 32, generator rebuilt from basis' })

    // Noiseless round-trip for SC, SCL and CA-SCL across sizes: strong LLRs
    // (bit 0 → +30, bit 1 → −30) must recover the message exactly.
    const bigLLR = (cw: Uint8Array) => Array.from(cw, (b) => (b === 0 ? 30 : -30))
    let scRT = true, sclRT = true, caRT = true
    const configs: [number, number][] = [[16, 8], [64, 32], [128, 64], [256, 128]]
    for (const [N, K] of configs) {
      const pc = constructPolar(N, K, { construction: 'ga', designSnrDb: 2 })
      for (let trial = 0; trial < 20; trial++) {
        const msg = Array.from({ length: K }, () => rnd() & 1)
        const cw = polarEncode(pc, msg)
        const llr = bigLLR(cw)
        if (scDecode(pc, llr).message.join('') !== msg.join('')) scRT = false
        if (sclDecode(pc, llr, 8).message.join('') !== msg.join('')) sclRT = false
        const payload = msg.slice(0, K - CRC8.width)
        const info = appendCrc(payload, CRC8)
        const ca = sclDecode(pc, bigLLR(polarEncode(pc, info)), 8, CRC8)
        if (!ca.crcPassed || ca.message.slice(0, K - CRC8.width).join('') !== payload.join('')) caRT = false
      }
    }
    results.push({ group: 'Polar codes', name: 'SC decode: noiseless round-trip', pass: scRT, detail: '4 sizes to (256,128), 20 msgs each' })
    results.push({ group: 'Polar codes', name: 'SC-List (L=8): noiseless round-trip', pass: sclRT, detail: 'list never loses the true path' })
    results.push({ group: 'Polar codes', name: 'CRC-aided SCL: round-trip + CRC selects', pass: caRT, detail: 'the 5G decoder, CRC-8 outer check' })

    // Over an AWGN channel: SCL is never worse than SC, and CA-SCL is best —
    // the whole reason 5G uses list decoding. Count block errors over a batch.
    {
      const N = 128, K = 64
      const pc = constructPolar(N, K, { construction: 'ga', designSnrDb: 2 })
      const payloadLen = K - CRC8.width
      const esno = ebN0dBtoEsN0(1.5, K / N)
      const crng = new ChannelRNG(0xc0ffee)
      let scErr = 0, sclErr = 0, caErr = 0
      const T = 200
      for (let t = 0; t < T; t++) {
        const payload = Array.from({ length: payloadLen }, () => (crng.float() < 0.5 ? 0 : 1))
        const info = appendCrc(payload, CRC8)
        const cw = polarEncode(pc, info)
        const { llr } = channelAwgn(Array.from(cw), esno, crng)
        if (scDecode(pc, llr).message.slice(0, payloadLen).join('') !== payload.join('')) scErr++
        if (sclDecode(pc, llr, 8).message.slice(0, payloadLen).join('') !== payload.join('')) sclErr++
        if (sclDecode(pc, llr, 8, CRC8).message.slice(0, payloadLen).join('') !== payload.join('')) caErr++
      }
      results.push({ group: 'Polar codes', name: 'AWGN: SC-List ≤ SC block errors', pass: sclErr <= scErr, detail: `${sclErr} vs ${scErr} of ${T} @ Eb/N0=1.5 dB` })
      results.push({ group: 'Polar codes', name: 'AWGN: CA-SCL is the strongest decoder', pass: caErr <= sclErr, detail: `${caErr} vs ${sclErr} block errors` })
      results.push({ group: 'Polar codes', name: 'AWGN: SC decodes below the noise floor', pass: scErr / T < 0.5, detail: `SC BLER ${(scErr / T).toFixed(2)}` })
    }

    // Polarisation: on the BEC the channels split toward capacity 0 or 1, and
    // the un-polarised middle shrinks as N grows (Arıkan's theorem, made finite).
    const middleFrac = (nn: number) => {
      const Z = bhattacharyyaBEC(nn, 0.5)
      let mid = 0
      for (const z of Z) if (z > 0.01 && z < 0.99) mid++
      return mid / Z.length
    }
    const f4 = middleFrac(4), f7 = middleFrac(7), f10 = middleFrac(10)
    results.push({ group: 'Polar codes', name: 'channels polarise as N grows (middle shrinks)', pass: f10 < f7 && f7 < f4, detail: `mixed fraction ${f4.toFixed(2)}→${f7.toFixed(2)}→${f10.toFixed(2)} for N=16→128→1024` })
    // Capacity is conserved by the transform: mean synthetic capacity = C(W).
    {
      const Z = bhattacharyyaBEC(9, 0.3)
      let cap = 0
      for (const z of Z) cap += 1 - z
      results.push({ group: 'Polar codes', name: 'transform conserves capacity (Σ(1−Z)/N = C)', pass: Math.abs(cap / Z.length - 0.7) < 1e-6, detail: `mean cap ${(cap / Z.length).toFixed(4)} vs C=0.70` })
    }

    // CRC append/validate is self-consistent, and a single bit flip is caught.
    {
      let ok = true, caught = 0, flips = 0
      for (let t = 0; t < 200; t++) {
        const len = 1 + (rnd() % 60)
        const p = Array.from({ length: len }, () => rnd() & 1)
        const info = appendCrc(p, CRC8)
        if (!crcValid(info, CRC8)) ok = false
        const bad = info.slice()
        const pos = rnd() % bad.length
        bad[pos] ^= 1
        flips++
        if (!crcValid(bad, CRC8)) caught++
      }
      results.push({ group: 'Polar codes', name: 'CRC-8 append/validate consistent', pass: ok, detail: '200 random payloads' })
      results.push({ group: 'Polar codes', name: 'CRC-8 catches every single-bit flip', pass: caught === flips, detail: `${caught}/${flips} detected` })
    }
  }
}

// A from-scratch PNG codec deserves the suite's highest bar: an exhaustive
// raster-level round-trip across every colour type × bit depth × filter ×
// interlace (decode∘encode = identity), the filter apply/reconstruct inverses,
// and a known-answer decode of real PNGs produced by Node's *independent* zlib.
function runPngTests(results: TestCase[]): void {
  // deterministic byte source
  let rs = 305419896 >>> 0
  const rb8 = () => {
    rs = (1103515245 * rs + 12345) >>> 0
    return (rs >>> 16) & 0xff
  }
  const combos: [ColorType, number][] = []
  for (const ct of [0, 2, 3, 4, 6] as ColorType[]) for (const bd of ALLOWED_DEPTHS[ct]) combos.push([ct, bd])

  function randRaster(w: number, h: number, ct: ColorType, bd: number, interlace: 0 | 1): Raster {
    const rbytes = rowBytes(w, ct, bd)
    const samples = new Uint8Array(h * rbytes)
    for (let i = 0; i < samples.length; i++) samples[i] = rb8()
    // Canonicalise the unused trailing bits of each row for sub-byte depths so the
    // round-trip target is well defined (the decoder writes zeros there).
    const usedBits = w * CHANNELS[ct] * bd
    const rem = usedBits % 8
    if (rem > 0) {
      const full = Math.floor(usedBits / 8)
      const mask = (0xff << (8 - rem)) & 0xff
      for (let y = 0; y < h; y++) samples[y * rbytes + full] &= mask
    }
    const r: Raster = { width: w, height: h, bitDepth: bd, colorType: ct, interlace, samples }
    if (ct === 3) {
      const N = Math.min(1 << bd, 64)
      const pal = new Uint8Array(N * 3)
      for (let i = 0; i < pal.length; i++) pal[i] = rb8()
      r.palette = pal
      if (bd === 8) for (let i = 0; i < samples.length; i++) samples[i] %= N
    }
    return r
  }

  const strategies: FilterStrategy[] = ['adaptive', 'none', 'sub', 'up', 'average', 'paeth']
  let rtTotal = 0, rtFail = 0
  for (const [ct, bd] of combos) {
    for (const interlace of [0, 1] as (0 | 1)[]) {
      for (const [w, h] of [[7, 5], [16, 9], [1, 13]] as [number, number][]) {
        for (const strat of strategies) {
          rtTotal++
          try {
            const r = randRaster(w, h, ct, bd, interlace)
            const enc = encodePNG(r, { strategy: strat })
            const dec = decodePNG(enc.bytes)
            if (!rastersEqual(r, dec.raster) || !dec.adlerOk) rtFail++
          } catch {
            rtFail++
          }
        }
      }
    }
    results.push({
      group: 'PNG · raster round-trip',
      name: `${COLOR_TYPE_LABEL(ct)} · ${bd}-bit — all filters × interlace`,
      pass: rtFail === 0,
      detail: rtFail === 0 ? 'decode∘encode = identity' : `${rtFail} failing`,
    })
    rtFail = 0
  }
  results.push({
    group: 'PNG · raster round-trip',
    name: 'total raster round-trips',
    pass: true,
    detail: `${rtTotal} encode→decode identities across every colour type × depth × filter × interlace`,
  })

  // Known-answer decode of real PNGs made by Node's *independent* zlib.
  for (const v of PNG_VECTORS) {
    try {
      const dec = decodePNG(base64ToBytes(v.b64))
      const dimsOk = dec.raster.width === v.width && dec.raster.height === v.height && dec.raster.colorType === v.colorType && dec.raster.bitDepth === v.bitDepth
      const hash = fnv1a(rasterToRGBA(dec.raster).rgba)
      const pass = dimsOk && hash === v.rgbaHash
      results.push({
        group: 'PNG · known-answer (Node-zlib PNGs)',
        name: v.name,
        pass,
        detail: pass ? `${v.width}×${v.height}, pixels match the source pattern exactly` : `hash ${hash} ≠ ${v.rgbaHash}`,
      })
      // Fixed-point: re-encode the decoded image with us, decode again, pixels stable.
      const re = fnv1a(rasterToRGBA(decodePNG(encodePNG(dec.raster).bytes).raster).rgba)
      results.push({
        group: 'PNG · re-encode fixed point',
        name: v.name,
        pass: re === v.rgbaHash,
        detail: re === v.rgbaHash ? 'our encode→decode preserves the third-party pixels' : `hash ${re} ≠ ${v.rgbaHash}`,
      })
    } catch (e) {
      results.push({ group: 'PNG · known-answer (Node-zlib PNGs)', name: v.name, pass: false, detail: (e as Error).message })
    }
  }
}

function COLOR_TYPE_LABEL(ct: ColorType): string {
  return { 0: 'Gray', 2: 'RGB', 3: 'Palette', 4: 'Gray+A', 6: 'RGBA' }[ct]
}

// ---- native interoperability (async, feature-detected) ----
//
// The strongest correctness proof there is: our from-scratch gzip must be
// readable by the platform's own gunzip, and the platform's gzip readable by us.
// Uses the Web Streams CompressionStream/DecompressionStream when present (all
// modern browsers and Node ≥18); returns an empty list where unavailable.
export interface InteropResult {
  name: string
  pass: boolean
  detail: string
}

async function streamThrough(
  input: Uint8Array,
  format: 'gzip' | 'deflate' | 'deflate-raw',
  mode: 'compress' | 'decompress',
): Promise<Uint8Array> {
  const Ctor =
    mode === 'compress'
      ? (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream
      : (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream
  if (!Ctor) throw new Error('Web Streams compression API unavailable')
  const s = new Ctor(format)
  const writer = s.writable.getWriter()
  void writer.write(input as unknown as BufferSource)
  void writer.close()
  const reader = s.readable.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  let n = 0
  for (const c of chunks) n += c.length
  const out = new Uint8Array(n)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

export function interopAvailable(): boolean {
  return (
    typeof (globalThis as { CompressionStream?: unknown }).CompressionStream !== 'undefined' &&
    typeof (globalThis as { DecompressionStream?: unknown }).DecompressionStream !== 'undefined'
  )
}

export async function runInterop(samples?: { name: string; data: Uint8Array }[]): Promise<InteropResult[]> {
  const inputs = samples ?? allInputs()
  const out: InteropResult[] = []
  if (!interopAvailable()) return out
  for (const { name, data } of inputs) {
    try {
      // our gzip → the platform's native gunzip
      const mine = gzipEncode(data)
      const native = await streamThrough(mine, 'gzip', 'decompress')
      out.push({ name: `native gunzip(ours) · ${name}`, pass: bytesEqual(native, data), detail: `${mine.length}B` })
      // the platform's native gzip → our inflater
      const nativeGz = await streamThrough(data, 'gzip', 'compress')
      const ours = gzipDecode(nativeGz)
      out.push({
        name: `ours.gunzip(native) · ${name}`,
        pass: bytesEqual(ours.data, data) && ours.crcOk,
        detail: `${nativeGz.length}B`,
      })
    } catch (e) {
      out.push({ name: `interop · ${name}`, pass: false, detail: (e as Error).message })
    }
  }
  return out
}

// ---- JPEG native interoperability (the lossy-pillar showstopper) ----
//
// The strongest proof a from-scratch image codec can offer: the *browser's own*
// JPEG decoder must render the file we emit, and our decoder must read the file
// the browser emits. Because JPEG is lossy the pixels legitimately differ, so
// the bar is a PSNR agreement threshold rather than a bit-for-bit match — but
// the two independent codecs converging on the same picture is exactly the
// interop guarantee the gzip/PNG pillars prove losslessly.

export function jpegInteropAvailable(): boolean {
  return (
    typeof (globalThis as { createImageBitmap?: unknown }).createImageBitmap !== 'undefined' &&
    typeof document !== 'undefined'
  )
}

function rgbaToCanvas(img: RGBAImage): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.rgba), img.width, img.height), 0, 0)
  return c
}

async function sourceToRGBA(source: CanvasImageSource, w: number, h: number): Promise<RGBAImage> {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  ctx.drawImage(source, 0, 0)
  const id = ctx.getImageData(0, 0, w, h)
  return { width: w, height: h, rgba: Uint8Array.from(id.data) }
}

function canvasToBlob(c: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/jpeg', quality)
  })
}

export async function runJpegInterop(): Promise<InteropResult[]> {
  const out: InteropResult[] = []
  if (!jpegInteropAvailable()) return out
  const samples = [
    { id: 'gradient', w: 64, h: 64 },
    { id: 'photo', w: 80, h: 64 },
    { id: 'wheel', w: 64, h: 64 },
  ]
  for (const s of samples) {
    const def = IMG_SAMPLES.find((d) => d.id === s.id)
    if (!def) continue
    const img = def.make(s.w, s.h)
    // Direction A — our encoder → the browser's decoder.
    try {
      const enc = encodeJPEG(img, { quality: 92, subsampling: '4:4:4' })
      const bmp = await createImageBitmap(new Blob([enc.bytes as unknown as BlobPart], { type: 'image/jpeg' }))
      const browserPixels = await sourceToRGBA(bmp, img.width, img.height)
      const ourPixels = decodeJPEG(enc.bytes).image
      const pOrig = jpsnr(img, browserPixels)
      const pAgree = jpsnr(ourPixels, browserPixels)
      const dimsOk = browserPixels.width === img.width && browserPixels.height === img.height
      out.push({
        name: `native decode(ours) · ${s.id}`,
        pass: dimsOk && pOrig > 30 && pAgree > 34,
        detail: `browser reads our .jpg — ${pOrig.toFixed(1)} dB vs original, ${pAgree.toFixed(1)} dB vs our decoder`,
      })
    } catch (e) {
      out.push({ name: `native decode(ours) · ${s.id}`, pass: false, detail: (e as Error).message })
    }
    // Direction B — the browser's encoder → our decoder.
    try {
      const canvas = rgbaToCanvas(img)
      const blob = await canvasToBlob(canvas, 0.92)
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const ourPixels = decodeJPEG(bytes).image
      const bmp = await createImageBitmap(blob)
      const browserPixels = await sourceToRGBA(bmp, img.width, img.height)
      const pAgree = jpsnr(ourPixels, browserPixels)
      const dimsOk = ourPixels.width === img.width && ourPixels.height === img.height
      out.push({
        name: `ours.decode(native) · ${s.id}`,
        pass: dimsOk && pAgree > 34,
        detail: `we read the browser's .jpg — ${pAgree.toFixed(1)} dB agreement`,
      })
    } catch (e) {
      out.push({ name: `ours.decode(native) · ${s.id}`, pass: false, detail: (e as Error).message })
    }
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// Rate–distortion theory (Blahut–Arimoto) + optimal quantisation (Lloyd–Max, LBG)
//
// Unlike a codec, there is no encode/decode to invert here — the proof of
// correctness is that the numerical optimisers reproduce the KNOWN CLOSED-FORM
// limits (BSC/BEC/Z capacities, the Bernoulli and Gaussian R(D) functions, the
// Lloyd–Max known optimal points) and obey the structural laws (convexity,
// monotone descent, the centroid/nearest-neighbour conditions).
// ────────────────────────────────────────────────────────────────────────────
function runRateDistortionTests(results: TestCase[]): void {
  const G = 'Rate–distortion · Blahut–Arimoto'
  const GQ = 'Quantisation · Lloyd–Max'
  const GV = 'Vector quantisation · LBG'

  // --- Channel capacity vs closed forms ---
  try {
    let maxErr = 0
    const probes = [0, 0.05, 0.1, 0.25, 0.4, 0.5]
    for (const p of probes) maxErr = Math.max(maxErr, Math.abs(channelCapacity(bscMatrix(p)).C - (1 - binEntropy(p))))
    results.push({ group: G, name: 'BSC capacity → 1 − H(p) for p ∈ {0…0.5}', pass: maxErr < 1e-3, detail: `max err ${maxErr.toExponential(1)} bits` })
  } catch (e) {
    results.push({ group: G, name: 'BSC capacity', pass: false, detail: (e as Error).message })
  }
  try {
    let maxErr = 0
    for (const eps of [0, 0.2, 0.5, 0.8]) maxErr = Math.max(maxErr, Math.abs(channelCapacity(becMatrix(eps)).C - (1 - eps)))
    results.push({ group: G, name: 'BEC capacity → 1 − ε', pass: maxErr < 1e-3, detail: `max err ${maxErr.toExponential(1)} bits` })
  } catch (e) {
    results.push({ group: G, name: 'BEC capacity', pass: false, detail: (e as Error).message })
  }
  try {
    let maxErr = 0
    for (const p of [0.1, 0.3, 0.5, 0.7]) maxErr = Math.max(maxErr, Math.abs(channelCapacity(zChannelMatrix(p)).C - zChannelCapacity(p)))
    results.push({ group: G, name: 'Z-channel capacity → closed form (asymmetric)', pass: maxErr < 2e-3, detail: `max err ${maxErr.toExponential(1)} bits` })
  } catch (e) {
    results.push({ group: G, name: 'Z-channel capacity', pass: false, detail: (e as Error).message })
  }
  try {
    const r = channelCapacity(noiselessMatrix(4))
    const uniform = r.inputDist.every((v) => Math.abs(v - 0.25) < 1e-3)
    results.push({ group: G, name: 'noiseless 4-ary → C = log₂4 = 2, uniform input', pass: Math.abs(r.C - 2) < 1e-6 && uniform, detail: `C ${r.C.toFixed(4)}, input ${r.inputDist.map((v) => v.toFixed(2)).join('/')}` })
  } catch (e) {
    results.push({ group: G, name: 'noiseless capacity', pass: false, detail: (e as Error).message })
  }
  try {
    const r = channelCapacity(typewriterMatrix(6))
    results.push({ group: G, name: 'noisy typewriter (6) → C = log₂3', pass: Math.abs(r.C - Math.log2(3)) < 2e-3, detail: `C ${r.C.toFixed(4)} vs ${Math.log2(3).toFixed(4)}` })
  } catch (e) {
    results.push({ group: G, name: 'typewriter capacity', pass: false, detail: (e as Error).message })
  }
  try {
    // Fully-noisy channel (identical rows) has zero capacity.
    const C = channelCapacity([[0.5, 0.5], [0.5, 0.5]]).C
    results.push({ group: G, name: 'useless channel (identical rows) → C = 0', pass: C < 1e-6, detail: `C ${C.toExponential(1)}` })
  } catch (e) {
    results.push({ group: G, name: 'useless channel', pass: false, detail: (e as Error).message })
  }
  try {
    // The certified bound gap must actually close.
    const r = channelCapacity(zChannelMatrix(0.3))
    results.push({ group: G, name: 'BA bound sandwich I_U − I_L → 0', pass: r.gap < 1e-8, detail: `gap ${r.gap.toExponential(1)} in ${r.iterations} iters` })
  } catch (e) {
    results.push({ group: G, name: 'BA bound sandwich', pass: false, detail: (e as Error).message })
  }

  // --- R(D) vs closed forms ---
  try {
    const p = 0.3
    const curve = rdCurve(bernoulliSource(p), hammingDistortion(2), { points: 60, sMax: 40 })
    let maxErr = 0
    for (const pt of curve) maxErr = Math.max(maxErr, Math.abs(pt.R - bernoulliRD(p, pt.D)))
    const rmax = Math.max(...curve.map((c) => c.R))
    results.push({ group: G, name: 'Bernoulli(0.3) R(D) → H(p) − H(D)', pass: maxErr < 0.02, detail: `max err ${maxErr.toFixed(4)} bits over the curve` })
    results.push({ group: G, name: 'Bernoulli R(0) → H(p) (lossless corner)', pass: Math.abs(rmax - binEntropy(p)) < 0.05, detail: `R_max ${rmax.toFixed(3)} vs H ${binEntropy(p).toFixed(3)}` })
    // convexity + monotone non-increasing
    const s = [...curve].sort((a, b) => a.D - b.D)
    let mono = true
    let convex = true
    for (let i = 1; i < s.length; i++) if (s[i].R > s[i - 1].R + 1e-4) mono = false
    for (let i = 1; i < s.length - 1; i++) {
      const mid = (s[i - 1].R + s[i + 1].R) / 2
      if (s[i].R > mid + 0.02) convex = false
    }
    results.push({ group: G, name: 'R(D) is non-increasing and convex', pass: mono && convex, detail: mono && convex ? 'both hold along the swept curve' : `mono ${mono}, convex ${convex}` })
  } catch (e) {
    results.push({ group: G, name: 'Bernoulli R(D)', pass: false, detail: (e as Error).message })
  }
  try {
    const { p: gp, d } = discreteGaussian(1, 71, 4)
    const curve = rdCurve(gp, d, { points: 70, sMax: 160 })
    // Compare the mid-range points to ½log₂(σ²/D).
    let maxErr = 0
    let n = 0
    for (const pt of curve) {
      if (pt.D > 0.08 && pt.D < 0.7) {
        maxErr = Math.max(maxErr, Math.abs(pt.R - gaussianRD(1, pt.D)))
        n++
      }
    }
    results.push({ group: G, name: 'Gaussian R(D) → ½·log₂(σ²/D)', pass: maxErr < 0.05 && n > 5, detail: `max err ${maxErr.toFixed(4)} bits over ${n} mid-range points` })
  } catch (e) {
    results.push({ group: G, name: 'Gaussian R(D)', pass: false, detail: (e as Error).message })
  }

  // --- Lloyd–Max scalar quantiser ---
  try {
    // Known optimum for the unit Gaussian, N=2: level √(2/π), MSE 1−2/π. Fine grid.
    const r = lloydMax(DENSITIES.gaussian, 2, { grid: 40000 })
    const levelOk = Math.abs(Math.abs(r.levels[1]) - Math.sqrt(2 / Math.PI)) < 1e-3
    const mseOk = Math.abs(r.distortion - (1 - 2 / Math.PI)) < 1e-3
    results.push({ group: GQ, name: 'Gaussian N=2 → level √(2/π), MSE 1−2/π', pass: levelOk && mseOk, detail: `level ${Math.abs(r.levels[1]).toFixed(5)}, MSE ${r.distortion.toFixed(5)}` })
  } catch (e) {
    results.push({ group: GQ, name: 'Gaussian N=2 known optimum', pass: false, detail: (e as Error).message })
  }
  try {
    // Uniform source: the optimal N-level MSE is exactly 1/N² at unit variance.
    let ok = true
    let worst = 0
    for (const N of [2, 4, 8, 16]) {
      const r = lloydMax(DENSITIES.uniform, N, { grid: 20000 })
      const err = Math.abs(r.distortion - 1 / (N * N))
      worst = Math.max(worst, err)
      if (err > 3e-3) ok = false
    }
    results.push({ group: GQ, name: 'uniform source N-level MSE → 1/N²', pass: ok, detail: `max err ${worst.toExponential(1)}` })
  } catch (e) {
    results.push({ group: GQ, name: 'uniform source optimum', pass: false, detail: (e as Error).message })
  }
  try {
    // Lloyd descent is monotone; each level is its cell centroid (stationarity).
    const r = lloydMax(DENSITIES.laplacian, 6)
    let mono = true
    for (let i = 1; i < r.trace.length; i++) if (r.trace[i] > r.trace[i - 1] + 1e-9) mono = false
    results.push({ group: GQ, name: 'Lloyd distortion is monotone non-increasing', pass: mono, detail: `${r.trace.length} steps, D ${r.distortion.toFixed(4)}` })
  } catch (e) {
    results.push({ group: GQ, name: 'Lloyd monotone', pass: false, detail: (e as Error).message })
  }
  try {
    // Optimal ≤ uniform quantiser for a non-uniform source; entropy ≤ log₂N.
    let ok = true
    for (const N of [4, 8, 16]) {
      const r = lloydMax(DENSITIES.gaussian, N)
      const uq = uniformQuantizer(DENSITIES.gaussian, N, 4)
      if (r.distortion > uq + 1e-9) ok = false
      if (r.entropy > Math.log2(N) + 1e-9) ok = false
    }
    results.push({ group: GQ, name: 'Lloyd–Max ≤ uniform quantiser, H ≤ log₂N', pass: ok, detail: 'Gaussian N ∈ {4,8,16}' })
  } catch (e) {
    results.push({ group: GQ, name: 'Lloyd vs uniform', pass: false, detail: (e as Error).message })
  }
  try {
    // High-rate: each extra bit adds ≈ 6 dB (measured, N=16→32).
    const a = lloydMax(DENSITIES.gaussian, 16).snrDb
    const b = lloydMax(DENSITIES.gaussian, 32).snrDb
    const perBit = b - a
    results.push({ group: GQ, name: 'high-rate: +1 bit ≈ +6 dB', pass: perBit > 5 && perBit < 6.6, detail: `${perBit.toFixed(2)} dB from N=16→32` })
  } catch (e) {
    results.push({ group: GQ, name: 'high-rate 6 dB/bit', pass: false, detail: (e as Error).message })
  }

  // --- LBG vector quantiser ---
  try {
    const data = sampleMixture(600, 4, new QRng(20260709))
    const r2 = lbg(data, 2)
    const r4 = lbg(data, 4)
    const r8 = lbg(data, 8)
    const nested = r4.distortion <= r2.distortion + 1e-9 && r8.distortion <= r4.distortion + 1e-9
    results.push({ group: GV, name: 'distortion falls as the codebook grows (D₈ ≤ D₄ ≤ D₂)', pass: nested, detail: `${r2.distortion.toFixed(3)} → ${r4.distortion.toFixed(3)} → ${r8.distortion.toFixed(3)}` })
    let mono = true
    for (let i = 1; i < r8.trace.length; i++) if (r8.trace[i] > r8.trace[i - 1] + 1e-9) mono = false
    results.push({ group: GV, name: 'LBG descent is monotone across splits', pass: mono && r8.codebook.length === 8, detail: `${r8.trace.length} Lloyd steps, ${r8.codebook.length} codewords` })
    // Centroid condition: each codeword equals the mean of its assigned points.
    const cx = new Array(r8.codebook.length).fill(0)
    const cy = new Array(r8.codebook.length).fill(0)
    const cn = new Array(r8.codebook.length).fill(0)
    for (let i = 0; i < data.length; i++) {
      const k = r8.assign[i]
      cx[k] += data[i][0]
      cy[k] += data[i][1]
      cn[k]++
    }
    let centroidOk = true
    for (let k = 0; k < r8.codebook.length; k++) {
      if (cn[k] === 0) continue
      if (Math.abs(cx[k] / cn[k] - r8.codebook[k][0]) > 1e-6 || Math.abs(cy[k] / cn[k] - r8.codebook[k][1]) > 1e-6) centroidOk = false
    }
    results.push({ group: GV, name: 'each codeword is its cluster centroid (stationarity)', pass: centroidOk, detail: 'centroid condition holds for all cells' })
  } catch (e) {
    results.push({ group: GV, name: 'LBG', pass: false, detail: (e as Error).message })
  }
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
