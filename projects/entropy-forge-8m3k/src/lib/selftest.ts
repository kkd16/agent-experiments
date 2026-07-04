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

  // ---- Channel coding (Shannon's other theorem) ----
  runChannelTests(results)

  return results
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
