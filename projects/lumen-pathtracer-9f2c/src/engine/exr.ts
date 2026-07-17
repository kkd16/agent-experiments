// exr.ts — (27.0) a from-scratch OpenEXR (`.exr`) scanline reader + writer.
//
// 25.0 taught Lumen to read Radiance RGBE (`.hdr`, lossy-but-compact); 26.0 added
// the Portable FloatMap (`.pfm`, lossless-but-uncompressed). This adds the format
// the *film industry* actually ships — Industrial Light & Magic's **OpenEXR** —
// the last major HDR interchange format and the one Nuke, After Effects, Mari,
// Houdini, Blender and every VFX pipeline read and write. Where RGBE quantises to
// a shared exponent and PFM stores raw float32, EXR stores **half-precision**
// (IEEE-754 float16) radiance and *compresses it losslessly*, so it carries the
// same ~30-stop dynamic range at roughly a quarter the bytes of a PFM — which is
// why the HDRI marketplaces (Poly Haven &c.) ship `.exr` as their default.
//
// Nothing here is a library call. EXR's ZIP scanlines are zlib DEFLATE, so this
// file carries a **from-scratch DEFLATE inflate** (stored, fixed- and dynamic-
// Huffman blocks — RFC 1951) and a stored-block deflate writer with a real zlib
// wrapper (RFC 1950 + Adler-32), plus EXR's own run-length codec and its
// predictor/reorder pre-filter. Half↔float is a hand-rolled round-to-nearest-even
// converter. The whole path is exercised by the self-test suite: a FLOAT round-
// trip is bit-for-bit through NONE/RLE/ZIP, the inflate is checked against a
// reference-zlib dynamic-Huffman vector, and a decoded panorama drives the
// importance sampler — the same proof the RGBE and PFM codecs carry.
//
// Scope: single-part **scanline** images (the equirectangular panorama case),
// NONE / RLE / ZIPS / ZIP compression, HALF / FLOAT / UINT channels. Tiled, deep,
// multi-part, PIZ / PXR24 / B44 / DWA files are detected and rejected with a
// clear message rather than mis-decoded.
//
// References: the OpenEXR file-layout spec (openexr.com/en/latest/), Imf::Zip /
// ImfRleCompressor (the predictor + reorder), and RFC 1950/1951 (zlib/DEFLATE).

import type { HdrImage } from './hdr'

// ---- half ↔ float (IEEE-754 binary16) --------------------------------------

const _fbuf = new ArrayBuffer(4)
const _f32 = new Float32Array(_fbuf)
const _u32 = new Uint32Array(_fbuf)

// Expand a 16-bit half to a JS double. Exact for every half value: normals,
// subnormals, ±0, ±∞ and NaN all round-trip through `floatToHalf` losslessly.
export function halfToFloat(h: number): number {
  const s = (h >> 15) & 1
  const e = (h >> 10) & 0x1f
  const m = h & 0x3ff
  if (e === 0) {
    // Subnormal (or ±0): value = m · 2^-24, no implicit leading 1.
    const val = m * 5.960464477539063e-8 // 2^-24
    return s ? -val : val
  }
  if (e === 31) return m ? NaN : s ? -Infinity : Infinity
  const val = Math.pow(2, e - 15) * (1 + m / 1024)
  return s ? -val : val
}

// Pack a double into a 16-bit half with round-to-nearest-even (the IEEE default
// rounding, and what OpenEXR's `half` class uses). Overflows saturate to ±∞,
// underflows to ±0; NaN stays NaN. Exact inverse of `halfToFloat` on the values
// half can represent.
export function floatToHalf(value: number): number {
  _f32[0] = value
  const x = _u32[0]
  const sign = (x >>> 16) & 0x8000
  const exp = (x >>> 23) & 0xff
  const mant = x & 0x7fffff
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x0200 : 0) // ∞ or NaN (nonzero mantissa)
  const e = exp - 127 + 15
  if (e >= 31) return sign | 0x7c00 // overflow → ∞
  if (e <= 0) {
    if (e < -10) return sign // magnitude below 2^-24 → ±0
    // Subnormal: restore the implicit 1, then shift into the 10-bit field.
    const m = mant | 0x800000
    const shift = 14 - e
    let half = m >>> shift
    const rem = m & ((1 << shift) - 1)
    const halfway = 1 << (shift - 1)
    if (rem > halfway || (rem === halfway && (half & 1))) half++
    return sign | half
  }
  let half = (e << 10) | (mant >>> 13)
  const rem = mant & 0x1fff
  // Round half-to-even; a carry out of the mantissa correctly bumps the exponent.
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1))) half++
  return sign | half
}

// ---- DEFLATE inflate (RFC 1951) + zlib unwrap (RFC 1950) --------------------

// DEFLATE length/distance base + extra-bit tables (RFC 1951 §3.2.5).
const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
// Order in which the 19 code-length-alphabet lengths appear in a dynamic block.
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

interface Huffman {
  counts: Int32Array // counts[len] = number of symbols with code length `len`
  symbols: Int32Array // symbols sorted by (length, value) — canonical order
}

// Build a canonical Huffman decode table from a list of per-symbol code lengths
// (0 = symbol absent), following the RFC's construction. Decoding walks bit by
// bit (see `decodeSym`), which needs only these two arrays.
function buildHuffman(lengths: number[] | Int32Array): Huffman {
  const counts = new Int32Array(16)
  for (let i = 0; i < lengths.length; i++) counts[lengths[i]]++
  counts[0] = 0
  const offsets = new Int32Array(16)
  for (let len = 1; len < 15; len++) offsets[len + 1] = offsets[len] + counts[len]
  const symbols = new Int32Array(lengths.length)
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbols[offsets[lengths[s]]++] = s
  return { counts, symbols }
}

class BitReader {
  private data: Uint8Array
  private pos: number
  private buf = 0
  private cnt = 0
  constructor(data: Uint8Array, pos: number) {
    this.data = data
    this.pos = pos
  }
  // Read `n` bits LSB-first (the DEFLATE convention for values and extra bits).
  bits(n: number): number {
    while (this.cnt < n) {
      if (this.pos >= this.data.length) throw new Error('DEFLATE stream truncated')
      this.buf |= this.data[this.pos++] << this.cnt
      this.cnt += 8
    }
    const v = this.buf & ((1 << n) - 1)
    this.buf >>>= n
    this.cnt -= n
    return v
  }
  // Canonical Huffman decode: accumulate the code MSB-first, one bit per length,
  // until it falls inside the block of codes of the current length (puff's algo).
  decodeSym(h: Huffman): number {
    let code = 0
    let first = 0
    let index = 0
    for (let len = 1; len <= 15; len++) {
      code |= this.bits(1)
      const count = h.counts[len]
      if (code - count < first) return h.symbols[index + (code - first)]
      index += count
      first = (first + count) << 1
      code <<= 1
    }
    throw new Error('invalid Huffman code')
  }
  // Discard the partial bits of the current byte, aligning to a byte boundary.
  align(): void {
    const drop = this.cnt & 7
    this.buf >>>= drop
    this.cnt -= drop
  }
  // Read one byte, honouring bytes already pulled into the bit buffer.
  byte(): number {
    if (this.cnt >= 8) {
      const b = this.buf & 0xff
      this.buf >>>= 8
      this.cnt -= 8
      return b
    }
    if (this.pos >= this.data.length) throw new Error('DEFLATE stream truncated')
    return this.data[this.pos++]
  }
}

// Fixed Huffman tables (RFC 1951 §3.2.6) — built once, lazily.
let _fixedLit: Huffman | null = null
let _fixedDist: Huffman | null = null
function fixedTables(): { lit: Huffman; dist: Huffman } {
  if (!_fixedLit) {
    const litLen = new Int32Array(288)
    for (let i = 0; i < 144; i++) litLen[i] = 8
    for (let i = 144; i < 256; i++) litLen[i] = 9
    for (let i = 256; i < 280; i++) litLen[i] = 7
    for (let i = 280; i < 288; i++) litLen[i] = 8
    _fixedLit = buildHuffman(litLen)
    _fixedDist = buildHuffman(new Int32Array(30).fill(5))
  }
  return { lit: _fixedLit!, dist: _fixedDist! }
}

// A growable output buffer that supports LZ77 back-copies from what it has
// already produced (including overlapping runs).
class OutBuffer {
  buf: Uint8Array
  len = 0
  constructor(hint: number) {
    this.buf = new Uint8Array(Math.max(hint, 64))
  }
  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return
    let cap = this.buf.length * 2
    while (cap < this.len + extra) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }
  push(b: number): void {
    this.ensure(1)
    this.buf[this.len++] = b
  }
  copy(dist: number, length: number): void {
    if (dist > this.len) throw new Error('DEFLATE back-reference before start')
    this.ensure(length)
    let from = this.len - dist
    for (let i = 0; i < length; i++) this.buf[this.len++] = this.buf[from++]
  }
  result(): Uint8Array {
    return this.buf.subarray(0, this.len)
  }
}

function inflateBlock(br: BitReader, out: OutBuffer, lit: Huffman, dist: Huffman): void {
  for (;;) {
    const sym = br.decodeSym(lit)
    if (sym < 256) {
      out.push(sym)
    } else if (sym === 256) {
      return // end of block
    } else {
      const li = sym - 257
      if (li >= LEN_BASE.length) throw new Error('bad DEFLATE length symbol')
      const length = LEN_BASE[li] + br.bits(LEN_EXTRA[li])
      const ds = br.decodeSym(dist)
      if (ds >= DIST_BASE.length) throw new Error('bad DEFLATE distance symbol')
      const distance = DIST_BASE[ds] + br.bits(DIST_EXTRA[ds])
      out.copy(distance, length)
    }
  }
}

// Inflate a raw DEFLATE stream starting at `pos`. `sizeHint` pre-sizes the output.
function inflateRaw(data: Uint8Array, pos: number, sizeHint: number): Uint8Array {
  const br = new BitReader(data, pos)
  const out = new OutBuffer(sizeHint)
  for (;;) {
    const final = br.bits(1)
    const type = br.bits(2)
    if (type === 0) {
      // Stored (uncompressed) block.
      br.align()
      const len = br.byte() | (br.byte() << 8)
      br.byte() // NLEN low
      br.byte() // NLEN high (one's complement of LEN — not verified)
      for (let i = 0; i < len; i++) out.push(br.byte())
    } else if (type === 1) {
      const { lit, dist } = fixedTables()
      inflateBlock(br, out, lit, dist)
    } else if (type === 2) {
      // Dynamic Huffman: read the two code tables, then the block.
      const hlit = br.bits(5) + 257
      const hdist = br.bits(5) + 1
      const hclen = br.bits(4) + 4
      const clLengths = new Int32Array(19)
      for (let i = 0; i < hclen; i++) clLengths[CLEN_ORDER[i]] = br.bits(3)
      const clTable = buildHuffman(clLengths)
      const lengths = new Int32Array(hlit + hdist)
      let i = 0
      while (i < lengths.length) {
        const sym = br.decodeSym(clTable)
        if (sym < 16) {
          lengths[i++] = sym
        } else if (sym === 16) {
          const rep = 3 + br.bits(2)
          if (i === 0) throw new Error('DEFLATE repeat with no previous length')
          const prev = lengths[i - 1]
          for (let r = 0; r < rep && i < lengths.length; r++) lengths[i++] = prev
        } else if (sym === 17) {
          const rep = 3 + br.bits(3)
          for (let r = 0; r < rep && i < lengths.length; r++) lengths[i++] = 0
        } else {
          const rep = 11 + br.bits(7)
          for (let r = 0; r < rep && i < lengths.length; r++) lengths[i++] = 0
        }
      }
      const lit = buildHuffman(lengths.subarray(0, hlit))
      const dist = buildHuffman(lengths.subarray(hlit))
      inflateBlock(br, out, lit, dist)
    } else {
      throw new Error('invalid DEFLATE block type 3')
    }
    if (final) break
  }
  return out.result()
}

// Inflate a zlib stream (RFC 1950): a 2-byte header, DEFLATE payload, Adler-32
// trailer. The header/checksum are recognised but not verified — a corrupt file
// surfaces as a decode error downstream, which is enough for the UI.
export function inflateZlib(data: Uint8Array, sizeHint = 0): Uint8Array {
  let start = 0
  // zlib header: CM=8 (deflate) in the low nibble and (CMF·256+FLG) a multiple of 31.
  if (data.length >= 2 && (data[0] & 0x0f) === 8 && ((data[0] << 8) | data[1]) % 31 === 0) {
    start = 2
    if (data[1] & 0x20) start += 4 // FDICT — a preset-dictionary id we don't expect
  }
  return inflateRaw(data, start, sizeHint)
}

// Adler-32 checksum (RFC 1950) of `data` — the zlib trailer our writer appends.
function adler32(data: Uint8Array): number {
  let a = 1
  let b = 0
  const MOD = 65521
  // Chunk to keep the sums from overflowing a 32-bit-safe range before the mod.
  let i = 0
  while (i < data.length) {
    const end = Math.min(i + 5552, data.length)
    for (; i < end; i++) {
      a += data[i]
      b += a
    }
    a %= MOD
    b %= MOD
  }
  return ((b << 16) | a) >>> 0
}

// Wrap `data` in a zlib stream using stored (uncompressed) DEFLATE blocks. The
// result is a spec-correct RFC 1950 stream that any zlib reader — and our own
// `inflateZlib` — decodes back to `data` exactly. (Stored blocks don't shrink the
// payload; EXR readers accept them because the format is defined by zlib, not by
// how the encoder chose its blocks.)
export function deflateStored(data: Uint8Array): Uint8Array {
  const nBlocks = Math.max(1, Math.ceil(data.length / 0xffff))
  // 2 header + per-block(5 + payload) + 4 Adler.
  const out = new Uint8Array(2 + nBlocks * 5 + data.length + 4)
  let o = 0
  out[o++] = 0x78 // CMF: CM=8, CINFO=7 (32 KB window)
  out[o++] = 0x01 // FLG: FCHECK making 0x7801 % 31 === 0, no dict, fastest level
  let p = 0
  do {
    const len = Math.min(0xffff, data.length - p)
    const last = p + len >= data.length ? 1 : 0
    out[o++] = last // BFINAL in bit 0, BTYPE=00 (stored) — rest of byte is padding
    out[o++] = len & 0xff
    out[o++] = (len >> 8) & 0xff
    out[o++] = ~len & 0xff
    out[o++] = (~len >> 8) & 0xff
    out.set(data.subarray(p, p + len), o)
    o += len
    p += len
  } while (p < data.length)
  const sum = adler32(data)
  out[o++] = (sum >>> 24) & 0xff
  out[o++] = (sum >>> 16) & 0xff
  out[o++] = (sum >>> 8) & 0xff
  out[o++] = sum & 0xff
  return out.subarray(0, o)
}

// ---- EXR run-length codec + predictor/reorder pre-filter --------------------

// EXR's run-length decode (ImfRle.cpp `rleUncompress`): a signed control byte —
// negative means a literal run of `-c` bytes, non-negative means the next byte
// repeated `c + 1` times.
function rleUncompress(src: Uint8Array, outSize: number): Uint8Array {
  const out = new Uint8Array(outSize)
  let ip = 0
  let op = 0
  while (ip < src.length && op < outSize) {
    let c = src[ip++]
    if (c > 127) c -= 256 // interpret as signed
    if (c < 0) {
      let n = -c
      while (n-- > 0 && op < outSize) out[op++] = src[ip++]
    } else {
      let n = c + 1
      const val = src[ip++]
      while (n-- > 0 && op < outSize) out[op++] = val
    }
  }
  return out
}

// Undo EXR's predictor + reorder that ZIP and RLE apply before compressing
// (Imf::Zip::uncompress). The predictor is a byte delta; the reorder splits the
// stream into two interleaved halves. Both are applied in place / into `out`.
function applyExrPostFilter(data: Uint8Array): Uint8Array {
  // 1) Undo the predictor: t[i] += t[i-1] - 128 (mod 256).
  for (let i = 1; i < data.length; i++) {
    data[i] = (data[i - 1] + data[i] - 128) & 0xff
  }
  // 2) Undo the reorder: de-interleave the two halves back into scan order.
  const out = new Uint8Array(data.length)
  const half = (data.length + 1) >> 1
  let t1 = 0
  let t2 = half
  let s = 0
  while (s < data.length) {
    out[s++] = data[t1++]
    if (s < data.length) out[s++] = data[t2++]
  }
  return out
}

// Apply the predictor + reorder before ZIP/RLE compression (Imf::Zip::compress) —
// the exact inverse of `applyExrPostFilter`, used by the writer.
function applyExrPreFilter(data: Uint8Array): Uint8Array {
  // 1) Reorder: interleave into two halves.
  const tmp = new Uint8Array(data.length)
  const half = (data.length + 1) >> 1
  let t1 = 0
  let t2 = half
  let s = 0
  while (s < data.length) {
    tmp[t1++] = data[s++]
    if (s < data.length) tmp[t2++] = data[s++]
  }
  // 2) Predictor: t[i] = t[i] - t[i-1] + 128 (mod 256), walking forward.
  let prev = tmp[0]
  for (let i = 1; i < tmp.length; i++) {
    const cur = tmp[i]
    tmp[i] = (cur - prev + 128) & 0xff
    prev = cur
  }
  return tmp
}

// ---- EXR header + scanline decode -------------------------------------------

const EXR_MAGIC = 0x01312f76 // little-endian read of bytes 76 2f 31 01

type PixelType = 0 | 1 | 2 // UINT | HALF | FLOAT
interface ExrChannel {
  name: string
  type: PixelType
  bytes: number // 2 for HALF, 4 for UINT/FLOAT
}

const COMPRESSION_NAMES = ['NONE', 'RLE', 'ZIPS', 'ZIP', 'PIZ', 'PXR24', 'B44', 'B44A', 'DWAA', 'DWAB']
const LINES_PER_BLOCK = [1, 1, 1, 16, 32, 16, 32, 32, 32, 256]

class ByteCursor {
  view: DataView
  bytes: Uint8Array
  pos: number
  constructor(bytes: Uint8Array, pos = 0) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.pos = pos
  }
  u8(): number {
    return this.bytes[this.pos++]
  }
  i32(): number {
    const v = this.view.getInt32(this.pos, true)
    this.pos += 4
    return v
  }
  u32(): number {
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }
  u64(): number {
    const lo = this.view.getUint32(this.pos, true)
    const hi = this.view.getUint32(this.pos + 4, true)
    this.pos += 8
    return hi * 0x100000000 + lo
  }
  str(): string {
    // Null-terminated latin1 string (attribute + channel names).
    let s = ''
    while (this.pos < this.bytes.length && this.bytes[this.pos] !== 0) s += String.fromCharCode(this.bytes[this.pos++])
    this.pos++ // consume the null
    return s
  }
}

// Decode an OpenEXR byte buffer to a linear-radiance `HdrImage` (row 0 = top,
// the dataWindow's yMin). Throws a descriptive Error on anything unsupported or
// malformed so the UI can surface a clean message.
export function decodeExr(bytes: Uint8Array): HdrImage {
  const cur = new ByteCursor(bytes)
  if (bytes.length < 8 || cur.u32() !== EXR_MAGIC) throw new Error('not an OpenEXR file (bad magic)')
  const version = cur.u32()
  const flags = version >> 8
  if (flags & 0x02) throw new Error('tiled EXR not supported (scanline only)')
  if (flags & 0x08) throw new Error('deep EXR not supported')
  if (flags & 0x10) throw new Error('multi-part EXR not supported')

  let channels: ExrChannel[] | null = null
  let compression = -1
  let dw: { xMin: number; yMin: number; xMax: number; yMax: number } | null = null

  // Header: attributes until an empty name terminates the list.
  for (;;) {
    const name = cur.str()
    if (name === '') break
    cur.str() // attribute type name (e.g. 'chlist', 'box2i') — not needed to parse the value
    const size = cur.i32()
    const end = cur.pos + size
    if (name === 'channels') {
      const list: ExrChannel[] = []
      for (;;) {
        if (cur.bytes[cur.pos] === 0) {
          cur.pos++ // list terminator
          break
        }
        const cname = cur.str()
        const ptype = cur.i32() as PixelType
        cur.pos += 4 // pLinear (1) + reserved (3)
        cur.i32() // xSampling
        cur.i32() // ySampling
        list.push({ name: cname, type: ptype, bytes: ptype === 1 ? 2 : 4 })
      }
      channels = list
    } else if (name === 'compression') {
      compression = cur.u8()
    } else if (name === 'dataWindow') {
      dw = { xMin: cur.i32(), yMin: cur.i32(), xMax: cur.i32(), yMax: cur.i32() }
    }
    cur.pos = end // skip anything we didn't consume (displayWindow, etc.)
  }

  if (!channels || channels.length === 0) throw new Error('EXR has no channels')
  if (compression < 0) throw new Error('EXR missing compression attribute')
  if (!dw) throw new Error('EXR missing dataWindow')
  if (compression >= 4) throw new Error(`EXR ${COMPRESSION_NAMES[compression] ?? compression} compression not supported`)

  const width = dw.xMax - dw.xMin + 1
  const height = dw.yMax - dw.yMin + 1
  if (!(width > 0) || !(height > 0)) throw new Error(`bad EXR dataWindow (${width}×${height})`)
  if (width * height > 64_000_000) throw new Error(`EXR too large (${width}×${height})`)

  const rowStride = channels.reduce((s, c) => s + width * c.bytes, 0)
  // Byte offset of each channel within one scanline's planar layout.
  const chanOffset: number[] = []
  {
    let acc = 0
    for (const c of channels) {
      chanOffset.push(acc)
      acc += width * c.bytes
    }
  }
  // Pick the R/G/B channels; fall back to a luminance channel or the first one.
  const findCh = (n: string) => channels!.findIndex((c) => c.name === n)
  let idxR = findCh('R')
  let idxG = findCh('G')
  let idxB = findCh('B')
  if (idxR < 0 && idxG < 0 && idxB < 0) {
    const y = findCh('Y')
    const grey = y >= 0 ? y : 0
    idxR = idxG = idxB = grey
  } else {
    if (idxR < 0) idxR = idxG >= 0 ? idxG : idxB
    if (idxG < 0) idxG = idxR
    if (idxB < 0) idxB = idxG
  }

  const linesPerBlock = LINES_PER_BLOCK[compression]
  const nBlocks = Math.ceil(height / linesPerBlock)
  const offsets: number[] = []
  for (let b = 0; b < nBlocks; b++) offsets.push(cur.u64())

  const pixels = new Float32Array(width * height * 3)

  const readSample = (view: DataView, off: number, type: PixelType): number => {
    if (type === 1) return halfToFloat(view.getUint16(off, true))
    if (type === 2) return view.getFloat32(off, true)
    return view.getUint32(off, true) // UINT — treat integer as radiance
  }

  for (let b = 0; b < nBlocks; b++) {
    const bc = new ByteCursor(bytes, offsets[b])
    const y0 = bc.i32() // starting scanline (dataWindow y)
    const dataSize = bc.i32()
    const linesInBlock = Math.min(linesPerBlock, dw.yMax - y0 + 1)
    const uncompressedSize = linesInBlock * rowStride
    const raw = bytes.subarray(bc.pos, bc.pos + dataSize)

    let block: Uint8Array
    if (dataSize >= uncompressedSize) {
      block = raw // stored raw (compression didn't help, or NONE)
    } else if (compression === 1) {
      block = applyExrPostFilter(rleUncompress(raw, uncompressedSize))
    } else {
      // ZIPS (2) or ZIP (3): zlib DEFLATE + predictor/reorder.
      block = applyExrPostFilter(inflateZlib(raw, uncompressedSize))
    }

    const blockView = new DataView(block.buffer, block.byteOffset, block.byteLength)
    for (let li = 0; li < linesInBlock; li++) {
      const y = y0 + li - dw.yMin // image row (0 = top)
      if (y < 0 || y >= height) continue
      const rowBase = li * rowStride
      const rDst = idxR
      const gDst = idxG
      const bDst = idxB
      const rOff = rowBase + chanOffset[rDst]
      const gOff = rowBase + chanOffset[gDst]
      const bOff = rowBase + chanOffset[bDst]
      const rT = channels[rDst].type
      const gT = channels[gDst].type
      const bT = channels[bDst].type
      const rBpc = channels[rDst].bytes
      const gBpc = channels[gDst].bytes
      const bBpc = channels[bDst].bytes
      let po = y * width * 3
      for (let x = 0; x < width; x++) {
        pixels[po] = readSample(blockView, rOff + x * rBpc, rT)
        pixels[po + 1] = readSample(blockView, gOff + x * gBpc, gT)
        pixels[po + 2] = readSample(blockView, bOff + x * bBpc, bT)
        po += 3
      }
    }
  }

  return { width, height, pixels }
}

// ---- EXR scanline encode ----------------------------------------------------

export interface ExrEncodeOptions {
  compression?: 'none' | 'rle' | 'zip'
  channelType?: 'half' | 'float'
}

function writeStr(arr: number[], s: string): void {
  for (let i = 0; i < s.length; i++) arr.push(s.charCodeAt(i) & 0xff)
  arr.push(0)
}
function writeI32(arr: number[], v: number): void {
  arr.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff)
}

// EXR run-length encode (ImfRle.cpp `rleCompress`): emit literal runs and
// repeat runs, both capped at 128 bytes. Inverse of `rleUncompress`.
function rleCompress(src: Uint8Array): Uint8Array {
  const out: number[] = []
  const n = src.length
  let i = 0
  while (i < n) {
    // Count a run of equal bytes (max 128).
    let runEnd = i + 1
    while (runEnd < n && runEnd - i < 128 && src[runEnd] === src[i]) runEnd++
    const runLen = runEnd - i
    if (runLen >= 2) {
      out.push((runLen - 1) & 0xff) // control byte c ≥ 0 → repeat c+1 times
      out.push(src[i])
      i = runEnd
    } else {
      // Gather a literal run until a run of ≥3 equal bytes begins (max 128).
      const litStart = i
      i++
      while (i < n && i - litStart < 128) {
        if (i + 2 < n && src[i] === src[i + 1] && src[i + 1] === src[i + 2]) break
        i++
      }
      const litLen = i - litStart
      out.push((256 - litLen) & 0xff) // control byte c < 0 (as unsigned) → literal run of -c
      for (let k = 0; k < litLen; k++) out.push(src[litStart + k])
    }
  }
  return Uint8Array.from(out)
}

// Encode a linear-radiance image to an OpenEXR byte buffer. Defaults to the VFX-
// standard **ZIP-compressed HALF** (compact, what Nuke/AE expect); `channelType:
// 'float'` gives a lossless float32 image whose decode is bit-for-bit. Writes a
// single-part scanline file with R,G,B channels.
export function encodeExr(pixels: Float32Array, width: number, height: number, opts: ExrEncodeOptions = {}): Uint8Array {
  const comp = opts.compression ?? 'zip'
  const half = (opts.channelType ?? 'half') === 'half'
  const compId = comp === 'none' ? 0 : comp === 'rle' ? 1 : 3 // 3 = ZIP
  const bpc = half ? 2 : 4
  const ptype = half ? 1 : 2

  // ---- header ----
  const h: number[] = []
  h.push(0x76, 0x2f, 0x31, 0x01) // magic
  h.push(2, 0, 0, 0) // version 2, scanline single-part, no flags

  const attr = (name: string, type: string, payload: number[]) => {
    writeStr(h, name)
    writeStr(h, type)
    writeI32(h, payload.length)
    for (const b of payload) h.push(b)
  }
  // channels: EXR stores them sorted by name → B, G, R.
  const chlist: number[] = []
  for (const cn of ['B', 'G', 'R']) {
    writeStr(chlist, cn)
    writeI32(chlist, ptype)
    chlist.push(0, 0, 0, 0) // pLinear + reserved
    writeI32(chlist, 1) // xSampling
    writeI32(chlist, 1) // ySampling
  }
  chlist.push(0) // terminator
  attr('channels', 'chlist', chlist)
  attr('compression', 'compression', [compId])
  const box: number[] = []
  writeI32(box, 0)
  writeI32(box, 0)
  writeI32(box, width - 1)
  writeI32(box, height - 1)
  attr('dataWindow', 'box2i', box)
  attr('displayWindow', 'box2i', box)
  attr('lineOrder', 'lineOrder', [0]) // INCREASING_Y
  const f32: number[] = []
  const fb = new Uint8Array(4)
  new DataView(fb.buffer).setFloat32(0, 1, true)
  f32.push(fb[0], fb[1], fb[2], fb[3])
  attr('pixelAspectRatio', 'float', f32)
  // screenWindowCenter (v2f) + screenWindowWidth (float) keep strict readers happy.
  attr('screenWindowCenter', 'v2f', [0, 0, 0, 0, 0, 0, 0, 0])
  attr('screenWindowWidth', 'float', f32)
  h.push(0) // end of header

  const linesPerBlock = comp === 'zip' ? 16 : 1
  const nBlocks = Math.ceil(height / linesPerBlock)
  const rowStride = width * 3 * bpc // three channels

  // Build each block's raw planar bytes (channels in B,G,R order), compress, and
  // lay out [y][dataSize][data]; then patch the offset table now that we know the
  // header + table sizes.
  const headerBytes = Uint8Array.from(h)
  const offsetTableSize = nBlocks * 8
  const blockBuffers: Uint8Array[] = []
  const setSample = (view: DataView, off: number, val: number) => {
    if (half) view.setUint16(off, floatToHalf(val), true)
    else view.setFloat32(off, val, true)
  }

  for (let b = 0; b < nBlocks; b++) {
    const y0 = b * linesPerBlock
    const lines = Math.min(linesPerBlock, height - y0)
    const rawSize = lines * rowStride
    const rawBlock = new Uint8Array(rawSize)
    const rv = new DataView(rawBlock.buffer)
    for (let li = 0; li < lines; li++) {
      const y = y0 + li
      const rowBase = li * rowStride
      // planar: all B, then all G, then all R
      const bBase = rowBase
      const gBase = rowBase + width * bpc
      const rBase = rowBase + 2 * width * bpc
      let src = y * width * 3
      for (let x = 0; x < width; x++) {
        setSample(rv, bBase + x * bpc, pixels[src + 2])
        setSample(rv, gBase + x * bpc, pixels[src + 1])
        setSample(rv, rBase + x * bpc, pixels[src])
        src += 3
      }
    }

    let payload: Uint8Array
    if (comp === 'none') {
      payload = rawBlock
    } else if (comp === 'rle') {
      const c = rleCompress(applyExrPreFilter(rawBlock))
      payload = c.length < rawSize ? c : rawBlock // store raw if it didn't shrink
    } else {
      const c = deflateStored(applyExrPreFilter(rawBlock))
      payload = c.length < rawSize ? c : rawBlock
    }

    const chunk = new Uint8Array(8 + payload.length)
    const cv = new DataView(chunk.buffer)
    cv.setInt32(0, y0, true)
    cv.setInt32(4, payload.length, true)
    chunk.set(payload, 8)
    blockBuffers.push(chunk)
  }

  // Assemble: header, offset table, chunks.
  let total = headerBytes.length + offsetTableSize
  for (const bb of blockBuffers) total += bb.length
  const out = new Uint8Array(total)
  out.set(headerBytes, 0)
  const tableView = new DataView(out.buffer, headerBytes.length, offsetTableSize)
  let chunkPos = headerBytes.length + offsetTableSize
  for (let b = 0; b < nBlocks; b++) {
    tableView.setUint32(b * 8, chunkPos & 0xffffffff, true)
    tableView.setUint32(b * 8 + 4, Math.floor(chunkPos / 0x100000000), true)
    out.set(blockBuffers[b], chunkPos)
    chunkPos += blockBuffers[b].length
  }
  return out
}
