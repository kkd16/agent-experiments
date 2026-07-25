// bzip2.ts — a from-scratch, **byte-compatible** implementation of the real
// bzip2 (.bz2) container: the full block-sorting compressor whose files the Unix
// `bzip2`/`bunzip2` tools produce and consume.
//
// bzip2 (Julian Seward, 1996) is the canonical *Burrows–Wheeler* compressor.
// The lab already has all the moving parts as isolated primitives — BWT, MTF,
// RLE, Huffman, package-merge, the bzip2 CRC — but had no format that assembles
// them into a real, interoperable stream. This is that format, implemented to the
// spec so that:
//
//   • our decoder reads genuine `.bz2` files written by `bzip2`, and
//   • our encoder writes `.bz2` files that `bunzip2` accepts and round-trips.
//
// The pipeline, per block:
//
//   original bytes
//     └─ RLE1 (runs of ≥4 → 4 bytes + count)         ── cheap defence vs. long runs
//        └─ BWT (sort all rotations, keep origPtr)     ── the reversible clustering
//           └─ MTF (move-to-front over the used bytes) ── turns clusters into zeros
//              └─ RLE2 (RUNA/RUNB bijective zero-runs) ── collapses the zero seas
//                 └─ multi-table Huffman (2..6 tables, ── the entropy stage:
//                    50-symbol groups, MTF'd selectors)   several codes, best per group
//
// Everything is MSB-first bit I/O (bzip2's convention), so `bits.ts`'s BitWriter
// is the exact substrate. The only external help is the bzip2 CRC-32 in
// `crc32.ts` and the length-limited (≤20-bit) Huffman code in `lengthLimited.ts`.

import { BitWriter } from './bits.ts'
import { crc32Bzip2 } from './crc32.ts'
import { bwtDecode } from './bwt.ts'
import { packageMerge } from './lengthLimited.ts'

// ---- format constants ----------------------------------------------------

const BLOCK_MAGIC_HI = 0x314159 // 0x314159265359 (π digits), split for 24-bit writes
const BLOCK_MAGIC_LO = 0x265359
const EOS_MAGIC_HI = 0x177245 // 0x177245385090 (√π digits)
const EOS_MAGIC_LO = 0x385090

const RUNA = 0
const RUNB = 1

const BZ_G_SIZE = 50 // symbols per selector group
const BZ_N_ITERS = 4 // table-optimisation refinement passes
const MAX_CODE_LEN = 20 // bzip2 caps Huffman code lengths at 20 bits
const MAX_LEN_ARR = 24 // decode-table array sizing (BZ_MAX_CODE_LEN margin)

// ---- BWT (forward) -------------------------------------------------------

/**
 * Forward Burrows–Wheeler transform over cyclic rotations, returning the last
 * column and the primary index (bzip2's `origPtr`). Uses prefix-doubling with an
 * integer comparator — O(n·log²n), ample for lab-scale blocks and exact. The
 * (L, ptr) it produces is inverted by `bwtDecode` (LF-mapping) and, identically,
 * by bunzip2's own inverse — the two conventions are the same index-based BWT.
 */
export function bwtForward(s: Uint8Array): { L: Uint8Array; ptr: number } {
  const n = s.length
  if (n === 0) return { L: new Uint8Array(0), ptr: 0 }
  if (n === 1) return { L: Uint8Array.from([s[0]]), ptr: 0 }

  const sa = new Array<number>(n)
  const rank = new Int32Array(n)
  const tmp = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    sa[i] = i
    rank[i] = s[i]
  }

  for (let k = 1; ; k <<= 1) {
    const cmp = (a: number, b: number): number => {
      if (rank[a] !== rank[b]) return rank[a] - rank[b]
      const ra = rank[(a + k) % n]
      const rb = rank[(b + k) % n]
      return ra - rb
    }
    sa.sort(cmp)
    tmp[sa[0]] = 0
    for (let i = 1; i < n; i++) {
      tmp[sa[i]] = tmp[sa[i - 1]] + (cmp(sa[i - 1], sa[i]) < 0 ? 1 : 0)
    }
    for (let i = 0; i < n; i++) rank[i] = tmp[i]
    if (tmp[sa[n - 1]] === n - 1) break // all rotations now distinct
    if (k >= n) break
  }

  const L = new Uint8Array(n)
  let ptr = 0
  for (let i = 0; i < n; i++) {
    const j = sa[i]
    L[i] = s[(j + n - 1) % n]
    if (j === 0) ptr = i
  }
  return { L, ptr }
}

// ---- RLE1 (bzip2's initial run-length stage) -----------------------------

/**
 * bzip2 RLE1: any run of ≥4 identical bytes becomes 4 literal copies followed by
 * a single count byte in 0..251 (the number of *extra* copies, so a group covers
 * up to 255 bytes); longer runs emit several groups. Runs of 1..3 pass through
 * literally. This bounds the BWT's worst case and is the exact stage the decoder
 * inverts first.
 */
function rle1Encode(input: Uint8Array, start: number, budget: number): { rle: Uint8Array; end: number } {
  const out: number[] = []
  let pos = start
  while (pos < input.length && out.length < budget) {
    const b = input[pos]
    let run = 1
    while (pos + run < input.length && input[pos + run] === b && run < 255) run++
    if (run >= 4) {
      out.push(b, b, b, b, run - 4)
      pos += run
    } else {
      for (let k = 0; k < run; k++) out.push(b)
      pos += run
    }
  }
  return { rle: Uint8Array.from(out), end: pos }
}

/** Invert RLE1: after 4 identical bytes, the next byte is a count of extra copies. */
function rle1Decode(rle: Uint8Array): Uint8Array {
  const out: number[] = []
  let runLen = 0
  let last = -1
  for (let i = 0; i < rle.length; i++) {
    const b = rle[i]
    if (runLen === 4) {
      for (let k = 0; k < b; k++) out.push(last)
      runLen = 0
      last = -1
      continue
    }
    if (b === last) runLen++
    else {
      runLen = 1
      last = b
    }
    out.push(b)
  }
  return Uint8Array.from(out)
}

// ---- canonical Huffman helpers (bzip2 convention) ------------------------

/** Length-limited (≤20) code lengths for every symbol 0..alphaSize-1. */
function huffmanLengths(freq: Int32Array, alphaSize: number): Uint8Array {
  // Every symbol needs a code even at zero frequency, so floor to weight 1.
  const counts = new Array<number>(alphaSize)
  for (let i = 0; i < alphaSize; i++) counts[i] = freq[i] > 0 ? freq[i] : 1
  const res = packageMerge(counts, MAX_CODE_LEN)
  const len = new Uint8Array(alphaSize)
  for (let i = 0; i < alphaSize; i++) len[i] = res.lengths.get(i) ?? 1
  return len
}

/** Assign canonical codes from lengths (increasing length, then symbol order). */
function assignCodes(len: Uint8Array, alphaSize: number): { code: Int32Array; minLen: number; maxLen: number } {
  let minLen = 32
  let maxLen = 0
  for (let i = 0; i < alphaSize; i++) {
    if (len[i] > maxLen) maxLen = len[i]
    if (len[i] < minLen) minLen = len[i]
  }
  const code = new Int32Array(alphaSize)
  let vec = 0
  for (let L = minLen; L <= maxLen; L++) {
    for (let sym = 0; sym < alphaSize; sym++) {
      if (len[sym] === L) code[sym] = vec++
    }
    vec <<= 1
  }
  return { code, minLen, maxLen }
}

// ---- MTF + RLE2 ----------------------------------------------------------

interface MtfResult {
  mtfv: number[] // symbol stream: RUNA/RUNB, MTF values shifted +1, EOB last
  eob: number // symbol value of end-of-block (= nInUse + 1)
  alphaSize: number // nInUse + 2
  inUse16: number // 16-bit range map
  inUseRanges: number[] // for each used range, the 16-bit symbol map
  seqToUnseq: number[] // sorted list of used byte values (MTF init order)
  nInUse: number
}

function mtfAndRle2(L: Uint8Array): MtfResult {
  // Which byte values appear.
  const present = new Uint8Array(256)
  for (let i = 0; i < L.length; i++) present[L[i]] = 1
  const seqToUnseq: number[] = []
  for (let b = 0; b < 256; b++) if (present[b]) seqToUnseq.push(b)
  const nInUse = seqToUnseq.length

  // 16-range symbol map.
  let inUse16 = 0
  const inUseRanges: number[] = []
  for (let r = 0; r < 16; r++) {
    let rangeBits = 0
    let any = 0
    for (let j = 0; j < 16; j++) {
      if (present[r * 16 + j]) {
        rangeBits |= 1 << (15 - j)
        any = 1
      }
    }
    if (any) {
      inUse16 |= 1 << (15 - r)
      inUseRanges.push(rangeBits)
    }
  }

  // MTF over the used-byte list, then RLE2 of zero runs.
  const mtf = seqToUnseq.slice()
  const eob = nInUse + 1
  const mtfv: number[] = []
  let zeros = 0

  const flushZeros = () => {
    if (zeros === 0) return
    // bijective base-2 encode of the zero run via RUNA/RUNB.
    let z = zeros - 1
    while (true) {
      mtfv.push(z & 1 ? RUNB : RUNA)
      if (z < 2) break
      z = (z - 2) >> 1
    }
    zeros = 0
  }

  for (let i = 0; i < L.length; i++) {
    const byte = L[i]
    // find position of `byte` in the MTF list (linear — nInUse ≤ 256).
    let j = 0
    for (; j < mtf.length; j++) if (mtf[j] === byte) break
    if (j === 0) {
      zeros++
    } else {
      flushZeros()
      mtfv.push(j + 1) // shift past RUNA/RUNB (0,1)
      // move-to-front
      for (let k = j; k > 0; k--) mtf[k] = mtf[k - 1]
      mtf[0] = byte
    }
  }
  flushZeros()
  mtfv.push(eob)

  return { mtfv, eob, alphaSize: nInUse + 2, inUse16, inUseRanges, seqToUnseq, nInUse }
}

// ---- multi-table Huffman selection (bzip2 sendMTFValues) -----------------

function chooseNGroups(nMTF: number): number {
  if (nMTF < 200) return 2
  if (nMTF < 600) return 3
  if (nMTF < 1200) return 4
  if (nMTF < 2400) return 5
  return 6
}

interface TableSet {
  nGroups: number
  len: Uint8Array[] // len[t][sym]
  selectors: number[] // table index per 50-symbol group
}

function buildTables(mtfv: number[], alphaSize: number): TableSet {
  const nMTF = mtfv.length
  const nGroups = chooseNGroups(nMTF)

  // per-symbol frequency across the whole block.
  const freq = new Int32Array(alphaSize)
  for (let i = 0; i < nMTF; i++) freq[mtfv[i]]++

  // Initial tables: partition the alphabet into nGroups equal-frequency spans,
  // cost 0 inside the span and 15 outside (bzip2's BZ_LESSER/GREATER_ICOST).
  const len: Uint8Array[] = []
  for (let t = 0; t < nGroups; t++) len.push(new Uint8Array(alphaSize))
  {
    let remF = nMTF
    let gs = 0
    for (let nPart = nGroups; nPart > 0; nPart--) {
      const tFreq = Math.floor(remF / nPart)
      let ge = gs - 1
      let aFreq = 0
      while (aFreq < tFreq && ge < alphaSize - 1) {
        ge++
        aFreq += freq[ge]
      }
      if (ge > gs && nPart !== nGroups && nPart !== 1 && (nGroups - nPart) % 2 === 1) {
        aFreq -= freq[ge]
        ge--
      }
      const table = len[nPart - 1]
      for (let v = 0; v < alphaSize; v++) table[v] = v >= gs && v <= ge ? 0 : 15
      gs = ge + 1
      remF -= aFreq
    }
  }

  let selectors: number[] = []
  const nGroupsRfreq: Int32Array[] = []
  for (let t = 0; t < nGroups; t++) nGroupsRfreq.push(new Int32Array(alphaSize))

  for (let iter = 0; iter < BZ_N_ITERS; iter++) {
    for (let t = 0; t < nGroups; t++) nGroupsRfreq[t].fill(0)
    selectors = []
    let gs = 0
    while (gs < nMTF) {
      const ge = Math.min(gs + BZ_G_SIZE - 1, nMTF - 1)
      // cost of coding this group under each table.
      let bt = 0
      let bc = Infinity
      for (let t = 0; t < nGroups; t++) {
        let cost = 0
        const table = len[t]
        for (let i = gs; i <= ge; i++) cost += table[mtfv[i]]
        if (cost < bc) {
          bc = cost
          bt = t
        }
      }
      selectors.push(bt)
      const rf = nGroupsRfreq[bt]
      for (let i = gs; i <= ge; i++) rf[mtfv[i]]++
      gs = ge + 1
    }
    // rebuild each table's code lengths from the frequencies it now owns.
    for (let t = 0; t < nGroups; t++) len[t] = huffmanLengths(nGroupsRfreq[t], alphaSize)
  }

  return { nGroups, len, selectors }
}

// ---- block encoding ------------------------------------------------------

function write24(w: BitWriter, v: number) {
  w.writeBits(v & 0xffffff, 24)
}
function write32(w: BitWriter, v: number) {
  w.writeBits((v >>> 16) & 0xffff, 16)
  w.writeBits(v & 0xffff, 16)
}

interface BlockInfo {
  origLen: number
  rleLen: number
  bwtPtr: number
  nInUse: number
  nMTF: number
  nGroups: number
  nSelectors: number
  crc: number
}

function encodeBlock(w: BitWriter, orig: Uint8Array, rle: Uint8Array): BlockInfo {
  const crc = crc32Bzip2(orig)
  const { L, ptr } = bwtForward(rle)
  const m = mtfAndRle2(L)
  const { nGroups, len, selectors } = buildTables(m.mtfv, m.alphaSize)

  // 1) block magic, 2) CRC, 3) randomised=0, 4) origPtr
  write24(w, BLOCK_MAGIC_HI)
  write24(w, BLOCK_MAGIC_LO)
  write32(w, crc >>> 0)
  w.writeBit(0)
  write24(w, ptr)

  // 5) symbol map
  w.writeBits(m.inUse16, 16)
  for (const bits of m.inUseRanges) w.writeBits(bits, 16)

  // 6) nGroups, 7) nSelectors
  w.writeBits(nGroups, 3)
  const nSelectors = selectors.length
  w.writeBits(nSelectors, 15)

  // 8) selectors, MTF-coded as unary
  const mtfSel: number[] = []
  for (let t = 0; t < nGroups; t++) mtfSel.push(t)
  for (const s of selectors) {
    let j = 0
    for (; j < mtfSel.length; j++) if (mtfSel[j] === s) break
    for (let k = 0; k < j; k++) w.writeBit(1)
    w.writeBit(0)
    for (let k = j; k > 0; k--) mtfSel[k] = mtfSel[k - 1]
    mtfSel[0] = s
  }

  // 9) code lengths for each table, delta-coded from a 5-bit start
  const codes: { code: Int32Array }[] = []
  for (let t = 0; t < nGroups; t++) {
    const table = len[t]
    let cur = table[0]
    w.writeBits(cur, 5)
    for (let sym = 0; sym < m.alphaSize; sym++) {
      const target = table[sym]
      while (cur < target) {
        w.writeBit(1)
        w.writeBit(0)
        cur++
      }
      while (cur > target) {
        w.writeBit(1)
        w.writeBit(1)
        cur--
      }
      w.writeBit(0)
    }
    codes.push({ code: assignCodes(table, m.alphaSize).code })
  }

  // 10) the entropy-coded symbol stream, 50 symbols per selector group
  let groupNo = -1
  let groupPos = 0
  let table = 0
  for (let i = 0; i < m.mtfv.length; i++) {
    if (groupPos === 0) {
      groupNo++
      table = selectors[groupNo]
      groupPos = BZ_G_SIZE
    }
    groupPos--
    const sym = m.mtfv[i]
    w.writeBits(codes[table].code[sym], len[table][sym])
  }

  return {
    origLen: orig.length,
    rleLen: rle.length,
    bwtPtr: ptr,
    nInUse: m.nInUse,
    nMTF: m.mtfv.length,
    nGroups,
    nSelectors,
    crc: crc >>> 0,
  }
}

export interface Bzip2Options {
  level?: number // 1..9, block size = level × 100000 bytes (default 9)
}

export interface Bzip2EncodeResult {
  bytes: Uint8Array
  blocks: BlockInfo[]
  combinedCrc: number
}

/** Full bzip2 encode → a valid `.bz2` stream `bunzip2` decompresses. */
export function bzip2EncodeDetailed(input: Uint8Array, opts: Bzip2Options = {}): Bzip2EncodeResult {
  const level = Math.min(9, Math.max(1, opts.level ?? 9))
  const blockSize = level * 100000
  const budget = blockSize - 6

  const w = new BitWriter()
  // stream header: 'B' 'Z' 'h' <level>
  w.writeBits(0x42, 8)
  w.writeBits(0x5a, 8)
  w.writeBits(0x68, 8)
  w.writeBits(0x30 + level, 8)

  const blocks: BlockInfo[] = []
  let combined = 0
  let pos = 0
  while (pos < input.length) {
    const { rle, end } = rle1Encode(input, pos, budget)
    const orig = input.subarray(pos, end)
    const info = encodeBlock(w, orig, rle)
    blocks.push(info)
    combined = ((combined << 1) | (combined >>> 31)) >>> 0
    combined = (combined ^ info.crc) >>> 0
    pos = end
  }

  // stream footer: EOS magic, combined CRC, byte-align
  write24(w, EOS_MAGIC_HI)
  write24(w, EOS_MAGIC_LO)
  write32(w, combined >>> 0)

  return { bytes: w.finish(), blocks, combinedCrc: combined >>> 0 }
}

export function bzip2Encode(input: Uint8Array, opts: Bzip2Options = {}): Uint8Array {
  return bzip2EncodeDetailed(input, opts).bytes
}

// ---- bit reader (strict, MSB-first) --------------------------------------

class BzReader {
  private data: Uint8Array
  pos = 0 // bit position
  constructor(data: Uint8Array) {
    this.data = data
  }
  bit(): number {
    const byteIndex = this.pos >>> 3
    if (byteIndex >= this.data.length) throw new Error('bzip2: unexpected end of stream')
    const b = (this.data[byteIndex] >>> (7 - (this.pos & 7))) & 1
    this.pos++
    return b
  }
  bits(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit()
    return v >>> 0
  }
  bits48(): number {
    const hi = this.bits(24)
    const lo = this.bits(24)
    return hi * 0x1000000 + lo
  }
  get eof(): boolean {
    return this.pos >= this.data.length * 8
  }
}

// ---- decode tables (bzip2 hbCreateDecodeTables) --------------------------

interface DecodeTable {
  limit: Int32Array
  base: Int32Array
  perm: Int32Array
  minLen: number
  maxLen: number
}

function makeDecodeTable(len: Uint8Array, alphaSize: number): DecodeTable {
  let minLen = 32
  let maxLen = 0
  for (let i = 0; i < alphaSize; i++) {
    if (len[i] > maxLen) maxLen = len[i]
    if (len[i] < minLen) minLen = len[i]
  }
  const perm = new Int32Array(alphaSize)
  let pp = 0
  for (let L = minLen; L <= maxLen; L++) {
    for (let sym = 0; sym < alphaSize; sym++) if (len[sym] === L) perm[pp++] = sym
  }
  const base = new Int32Array(MAX_LEN_ARR + 2)
  const limit = new Int32Array(MAX_LEN_ARR + 2)
  for (let i = 0; i < alphaSize; i++) base[len[i] + 1]++
  for (let i = 1; i < MAX_LEN_ARR + 2; i++) base[i] += base[i - 1]
  let vec = 0
  for (let L = minLen; L <= maxLen; L++) {
    vec += base[L + 1] - base[L]
    limit[L] = vec - 1
    vec <<= 1
  }
  for (let L = minLen + 1; L <= maxLen; L++) {
    base[L] = ((limit[L - 1] + 1) << 1) - base[L]
  }
  return { limit, base, perm, minLen, maxLen }
}

function decodeSym(r: BzReader, t: DecodeTable): number {
  let zn = t.minLen
  let zvec = r.bits(zn)
  while (zn <= t.maxLen && zvec > t.limit[zn]) {
    zn++
    zvec = (zvec << 1) | r.bit()
  }
  return t.perm[zvec - t.base[zn]]
}

// ---- block + stream decoding ---------------------------------------------

export interface Bzip2DecodeResult {
  data: Uint8Array
  blocks: number
  combinedCrc: number
}

/** Full bzip2 decode of a real `.bz2` stream (as written by `bzip2`). */
export function bzip2DecodeDetailed(input: Uint8Array): Bzip2DecodeResult {
  const r = new BzReader(input)
  if (r.bits(8) !== 0x42 || r.bits(8) !== 0x5a || r.bits(8) !== 0x68) {
    throw new Error('bzip2: bad magic (expected "BZh")')
  }
  const level = r.bits(8) - 0x30
  if (level < 1 || level > 9) throw new Error('bzip2: bad block-size level')

  const chunks: Uint8Array[] = []
  let combined = 0
  let nBlocks = 0

  for (;;) {
    const magic = r.bits48()
    if (magic === EOS_MAGIC_HI * 0x1000000 + EOS_MAGIC_LO) {
      const streamCrc = r.bits(32) >>> 0
      if (streamCrc !== (combined >>> 0)) throw new Error('bzip2: stream CRC mismatch')
      break
    }
    if (magic !== BLOCK_MAGIC_HI * 0x1000000 + BLOCK_MAGIC_LO) {
      throw new Error('bzip2: bad block magic')
    }
    nBlocks++

    const blockCrc = r.bits(32) >>> 0
    const randomised = r.bit()
    if (randomised) throw new Error('bzip2: randomised blocks are not supported')
    const origPtr = r.bits(24)

    // symbol map → seqToUnseq
    const inUse16 = r.bits(16)
    const seqToUnseq: number[] = []
    for (let r16 = 0; r16 < 16; r16++) {
      if (inUse16 & (1 << (15 - r16))) {
        const bits = r.bits(16)
        for (let j = 0; j < 16; j++) if (bits & (1 << (15 - j))) seqToUnseq.push(r16 * 16 + j)
      }
    }
    const nInUse = seqToUnseq.length
    if (nInUse === 0) throw new Error('bzip2: empty symbol map')
    const alphaSize = nInUse + 2
    const eob = nInUse + 1

    const nGroups = r.bits(3)
    if (nGroups < 2 || nGroups > 6) throw new Error('bzip2: bad nGroups')
    const nSelectors = r.bits(15)

    // selectors (MTF-coded)
    const mtfSel: number[] = []
    for (let t = 0; t < nGroups; t++) mtfSel.push(t)
    const selectors = new Int32Array(nSelectors)
    for (let i = 0; i < nSelectors; i++) {
      let j = 0
      while (r.bit() === 1) {
        j++
        if (j >= nGroups) throw new Error('bzip2: selector out of range')
      }
      const s = mtfSel[j]
      for (let k = j; k > 0; k--) mtfSel[k] = mtfSel[k - 1]
      mtfSel[0] = s
      selectors[i] = s
    }

    // code lengths per table (delta-coded)
    const tables: DecodeTable[] = []
    for (let t = 0; t < nGroups; t++) {
      const len = new Uint8Array(alphaSize)
      let cur = r.bits(5)
      for (let sym = 0; sym < alphaSize; sym++) {
        for (;;) {
          if (cur < 1 || cur > MAX_LEN_ARR) throw new Error('bzip2: code length out of range')
          if (r.bit() === 0) break
          if (r.bit() === 0) cur++
          else cur--
        }
        len[sym] = cur
      }
      tables.push(makeDecodeTable(len, alphaSize))
    }

    // entropy-coded stream → inverse MTF+RLE2 → BWT last column L
    const mtf = seqToUnseq.slice()
    const L: number[] = []
    let groupNo = -1
    let groupPos = 0
    let curTable = tables[0]
    let run = 0
    let runBit = 0

    const flushRun = () => {
      if (run <= 0) return
      const b = mtf[0]
      for (let k = 0; k < run; k++) L.push(b)
      run = 0
      runBit = 0
    }

    for (;;) {
      if (groupPos === 0) {
        groupNo++
        if (groupNo >= nSelectors) throw new Error('bzip2: ran out of selectors')
        curTable = tables[selectors[groupNo]]
        groupPos = BZ_G_SIZE
      }
      groupPos--
      const sym = decodeSym(r, curTable)
      if (sym === RUNA) {
        run += 1 << runBit
        runBit++
        continue
      }
      if (sym === RUNB) {
        run += 2 << runBit
        runBit++
        continue
      }
      flushRun()
      if (sym === eob) break
      // sym in 2..nInUse → MTF index (sym - 1)
      const j = sym - 1
      const b = mtf[j]
      for (let k = j; k > 0; k--) mtf[k] = mtf[k - 1]
      mtf[0] = b
      L.push(b)
    }

    // inverse BWT → RLE1 stream → original block bytes
    const Larr = Uint8Array.from(L)
    if (origPtr >= Larr.length) throw new Error('bzip2: origPtr out of range')
    const rle = bwtDecode(Larr, origPtr)
    const block = rle1Decode(rle)

    if ((crc32Bzip2(block) >>> 0) !== blockCrc) throw new Error('bzip2: block CRC mismatch')
    chunks.push(block)
    combined = ((combined << 1) | (combined >>> 31)) >>> 0
    combined = (combined ^ blockCrc) >>> 0
  }

  // concatenate blocks
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return { data: out, blocks: nBlocks, combinedCrc: combined >>> 0 }
}

export function bzip2Decode(input: Uint8Array): Uint8Array {
  return bzip2DecodeDetailed(input).data
}

// ---- analysis for the UI -------------------------------------------------

export interface Bzip2StageSizes {
  input: number
  rle1: number
  mtfSymbols: number
  compressed: number
}

export interface Bzip2Analysis {
  ok: boolean
  error?: string
  stream: Uint8Array
  level: number
  blocks: BlockInfo[]
  combinedCrc: number
  sizes: Bzip2StageSizes
  ratio: number // compressed / input
  bitsPerByte: number
  roundTrips: boolean
  // first-block detail for visualisation
  first?: {
    rle1: Uint8Array
    bwtL: Uint8Array
    bwtPtr: number
    mtfv: number[]
    seqToUnseq: number[]
    nGroups: number
    selectors: number[]
    tableLens: Uint8Array[]
  }
}

/** Encode + introspect a block for the UI, and confirm the round-trip. */
export function bzip2Analyze(input: Uint8Array, opts: Bzip2Options = {}): Bzip2Analysis {
  try {
    const enc = bzip2EncodeDetailed(input, opts)
    let rle1Total = 0
    let mtfTotal = 0
    for (const b of enc.blocks) {
      rle1Total += b.rleLen
      mtfTotal += b.nMTF
    }
    const level = Math.min(9, Math.max(1, opts.level ?? 9))

    // first-block detail (recompute the intermediate stages for display)
    let first: Bzip2Analysis['first']
    if (input.length > 0) {
      const budget = level * 100000 - 6
      const { rle, end } = rle1Encode(input, 0, budget)
      void end
      const { L, ptr } = bwtForward(rle)
      const m = mtfAndRle2(L)
      const ts = buildTables(m.mtfv, m.alphaSize)
      first = {
        rle1: rle,
        bwtL: L,
        bwtPtr: ptr,
        mtfv: m.mtfv,
        seqToUnseq: m.seqToUnseq,
        nGroups: ts.nGroups,
        selectors: ts.selectors,
        tableLens: ts.len,
      }
    }

    const dec = bzip2Decode(enc.bytes)
    const roundTrips = dec.length === input.length && dec.every((v, i) => v === input[i])

    return {
      ok: true,
      stream: enc.bytes,
      level,
      blocks: enc.blocks,
      combinedCrc: enc.combinedCrc,
      sizes: { input: input.length, rle1: rle1Total, mtfSymbols: mtfTotal, compressed: enc.bytes.length },
      ratio: input.length ? enc.bytes.length / input.length : 0,
      bitsPerByte: input.length ? (enc.bytes.length * 8) / input.length : 0,
      roundTrips,
      first,
    }
  } catch (e) {
    return {
      ok: false,
      error: (e as Error).message,
      stream: new Uint8Array(0),
      level: opts.level ?? 9,
      blocks: [],
      combinedCrc: 0,
      sizes: { input: input.length, rle1: 0, mtfSymbols: 0, compressed: 0 },
      ratio: 0,
      bitsPerByte: 0,
      roundTrips: false,
    }
  }
}
