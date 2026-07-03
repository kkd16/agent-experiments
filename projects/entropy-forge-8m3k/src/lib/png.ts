// png.ts — a from-scratch, spec-compliant PNG codec (ISO/IEC 15948, RFC 2083).
//
// This is the capstone that ties the lab together: a PNG is a real-world
// container built from exactly the pieces this repo already implements from
// scratch — an RFC-1951 DEFLATE, a zlib (RFC 1950) wrapper, and CRC-32. The only
// genuinely new idea PNG adds is a *modelling pre-filter*: §6 scanline filters
// reshape the image bytes so the entropy coder that follows (our DEFLATE) sees a
// far less redundant stream. So the lab's through-line — "watch entropy become
// bits" — becomes literal here: the filter measurably lowers the order-0 entropy
// of the byte stream before DEFLATE ever runs.
//
// Everything below is our own code; only crc32 (crc32.ts) and zlibEncode/
// zlibDecode (gzip.ts → our DEFLATE) are reused. The codec supports every colour
// type × bit depth the spec allows, all five filters, and Adam7 interlacing, and
// round-trips at the raw-raster level bit-for-bit.

import { crc32 } from './crc32.ts'
import { zlibEncode, zlibDecode } from './gzip.ts'
import type { Strategy } from './deflate.ts'

// ---- the 8-byte PNG signature (§5.2) ----
export const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])

// ---- colour model (§11.2.2) ----
export type ColorType = 0 | 2 | 3 | 4 | 6
export const COLOR_TYPE_NAME: Record<ColorType, string> = {
  0: 'Grayscale',
  2: 'Truecolour (RGB)',
  3: 'Indexed (palette)',
  4: 'Grayscale + alpha',
  6: 'Truecolour + alpha (RGBA)',
}
/** Samples per pixel for each colour type. */
export const CHANNELS: Record<ColorType, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
/** The bit depths the spec permits for each colour type (Table 11.1). */
export const ALLOWED_DEPTHS: Record<ColorType, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
}

export type FilterType = 0 | 1 | 2 | 3 | 4
export const FILTER_NAME = ['None', 'Sub', 'Up', 'Average', 'Paeth'] as const
export type FilterStrategy = 'adaptive' | 'none' | 'sub' | 'up' | 'average' | 'paeth' | 'minsum'

// ---- the canonical in-memory form ----
//
// `samples` holds the *logical* (de-interlaced) image exactly as PNG lays out an
// uncompressed, unfiltered raster: for each of `height` rows, `rowBytes` bytes of
// packed samples, samples MSB-first within a byte, 16-bit samples big-endian. This
// is the form the round-trip identity is proven on — decode(encode(r)) === r.
export interface Raster {
  width: number
  height: number
  bitDepth: number // 1, 2, 4, 8, 16
  colorType: ColorType
  interlace: 0 | 1
  samples: Uint8Array // height * rowBytes
  palette?: Uint8Array // 3·N (RGB triples), colour type 3
  trns?: Uint8Array // raw tRNS payload: N alpha bytes (type 3), or 2/6 bytes (types 0/2)
}

// ---- geometry helpers ----
export function rowBytes(width: number, colorType: ColorType, bitDepth: number): number {
  const bitsPerPixel = CHANNELS[colorType] * bitDepth
  return Math.ceil((width * bitsPerPixel) / 8)
}
/** Filter byte-offset: distance (in bytes) to the pixel on the left. Always ≥ 1. */
function bppOf(colorType: ColorType, bitDepth: number): number {
  return Math.max(1, Math.ceil((CHANNELS[colorType] * bitDepth) / 8))
}

export function validateHeader(colorType: ColorType, bitDepth: number): string | null {
  if (!(colorType in CHANNELS)) return `bad colour type ${colorType}`
  if (!ALLOWED_DEPTHS[colorType].includes(bitDepth))
    return `bit depth ${bitDepth} is not allowed for ${COLOR_TYPE_NAME[colorType]}`
  return null
}

// ---- big-endian u32 helpers ----
function u32be(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
}
function readU32be(d: Uint8Array, o: number): number {
  return ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0
}
function concatBytes(parts: Uint8Array[]): Uint8Array {
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

// ---- the scanline filters (§6 / §9) ----
//
// Every filter is a per-byte predictor over three neighbours: a = the byte one
// pixel to the left, b = the byte directly above, c = the byte up-and-left. The
// filter transmits cur − prediction (mod 256); the reconstructor adds it back.
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** Apply one filter to a scanline `cur` given the (unfiltered) previous row. */
function applyFilter(
  ftype: FilterType,
  cur: Uint8Array,
  prev: Uint8Array | null,
  bpp: number,
  out: Uint8Array,
): void {
  const n = cur.length
  for (let i = 0; i < n; i++) {
    const x = cur[i]
    const a = i >= bpp ? cur[i - bpp] : 0
    const b = prev ? prev[i] : 0
    const c = prev && i >= bpp ? prev[i - bpp] : 0
    let pred = 0
    switch (ftype) {
      case 0: break
      case 1: pred = a; break
      case 2: pred = b; break
      case 3: pred = (a + b) >> 1; break
      case 4: pred = paeth(a, b, c); break
    }
    out[i] = (x - pred) & 0xff
  }
}

/** Reconstruct a scanline in place: `row` arrives filtered, leaves unfiltered. */
function reconstructFilter(
  ftype: FilterType,
  row: Uint8Array,
  prev: Uint8Array | null,
  bpp: number,
): void {
  const n = row.length
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? row[i - bpp] : 0
    const b = prev ? prev[i] : 0
    const c = prev && i >= bpp ? prev[i - bpp] : 0
    let pred = 0
    switch (ftype) {
      case 0: break
      case 1: pred = a; break
      case 2: pred = b; break
      case 3: pred = (a + b) >> 1; break
      case 4: pred = paeth(a, b, c); break
      default: throw new Error(`unknown filter type ${ftype}`)
    }
    row[i] = (row[i] + pred) & 0xff
  }
}

/** The libpng minimum-sum-of-absolute-differences heuristic: pick the filter
 *  whose output has the smallest total |signed byte|, a cheap proxy for "least
 *  for DEFLATE to encode". */
function minSumScore(bytes: Uint8Array): number {
  let s = 0
  for (let i = 0; i < bytes.length; i++) {
    const v = bytes[i]
    s += v < 128 ? v : 256 - v
  }
  return s
}

// ---- filter a whole (already de-interlaced or per-pass) raster ----
//
// Produces the concatenation of [filterByte, ...filteredRow] for every row, and
// reports the filter chosen per row (for the visualiser).
interface Filtered {
  data: Uint8Array
  rowFilters: number[]
}
function filterRows(
  samples: Uint8Array,
  height: number,
  bytesPerRow: number,
  bpp: number,
  strategy: FilterStrategy,
): Filtered {
  const out = new Uint8Array(height * (bytesPerRow + 1))
  const rowFilters: number[] = []
  const scratch = new Uint8Array(bytesPerRow)
  const best = new Uint8Array(bytesPerRow)
  let prev: Uint8Array | null = null
  let o = 0
  const fixed: Record<Exclude<FilterStrategy, 'adaptive' | 'minsum'>, FilterType> = {
    none: 0, sub: 1, up: 2, average: 3, paeth: 4,
  }
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * bytesPerRow, y * bytesPerRow + bytesPerRow)
    let chosen: FilterType
    let chosenBytes: Uint8Array
    if (strategy === 'adaptive' || strategy === 'minsum') {
      let bestScore = Infinity
      chosen = 0
      for (let f = 0 as FilterType; f <= 4; f = (f + 1) as FilterType) {
        applyFilter(f, cur, prev, bpp, scratch)
        const score = minSumScore(scratch)
        if (score < bestScore) {
          bestScore = score
          chosen = f
          best.set(scratch)
        }
      }
      chosenBytes = best
    } else {
      chosen = fixed[strategy]
      applyFilter(chosen, cur, prev, bpp, scratch)
      chosenBytes = scratch
    }
    out[o++] = chosen
    out.set(chosenBytes, o)
    o += bytesPerRow
    rowFilters.push(chosen)
    prev = cur
  }
  return { data: out, rowFilters }
}

/** Reconstruct `height` rows from a filtered byte stream (reader advances). */
function reconstructRows(
  filtered: Uint8Array,
  offset: number,
  height: number,
  bytesPerRow: number,
  bpp: number,
): { samples: Uint8Array; next: number; rowFilters: number[] } {
  const samples = new Uint8Array(height * bytesPerRow)
  const rowFilters: number[] = []
  let o = offset
  let prev: Uint8Array | null = null
  for (let y = 0; y < height; y++) {
    const ftype = filtered[o++] as FilterType
    if (ftype > 4) throw new Error(`bad filter type ${ftype} on row ${y}`)
    const row = samples.subarray(y * bytesPerRow, y * bytesPerRow + bytesPerRow)
    row.set(filtered.subarray(o, o + bytesPerRow))
    o += bytesPerRow
    reconstructFilter(ftype, row, prev, bpp)
    rowFilters.push(ftype)
    prev = row
  }
  return { samples, next: o, rowFilters }
}

// ---- Adam7 interlacing (§8) ----
// Each pass picks a sub-lattice of pixels: (xStart + col·xStep, yStart + row·yStep).
const ADAM7 = [
  { xStart: 0, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 4, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 0, yStart: 4, xStep: 4, yStep: 8 },
  { xStart: 2, yStart: 0, xStep: 4, yStep: 4 },
  { xStart: 0, yStart: 2, xStep: 2, yStep: 4 },
  { xStart: 1, yStart: 0, xStep: 2, yStep: 2 },
  { xStart: 0, yStart: 1, xStep: 1, yStep: 2 },
]
function passDims(w: number, h: number, p: (typeof ADAM7)[number]) {
  const pw = w > p.xStart ? Math.ceil((w - p.xStart) / p.xStep) : 0
  const ph = h > p.yStart ? Math.ceil((h - p.yStart) / p.yStep) : 0
  return { pw, ph }
}

// ---- sub-byte / 16-bit pixel sample access (used only for interlacing gather/
// scatter, where a pass's pixels are not contiguous in the logical raster) ----
function getSample(buf: Uint8Array, rb: number, x: number, y: number, ch: number, channels: number, bitDepth: number): number {
  if (bitDepth === 16) {
    const i = y * rb + (x * channels + ch) * 2
    return (buf[i] << 8) | buf[i + 1]
  }
  if (bitDepth === 8) {
    return buf[y * rb + x * channels + ch]
  }
  const bitPos = x * bitDepth // sub-byte depths are single-channel only
  const byteIndex = y * rb + (bitPos >> 3)
  const shift = 8 - bitDepth - (bitPos & 7)
  return (buf[byteIndex] >> shift) & ((1 << bitDepth) - 1)
}
function setSample(buf: Uint8Array, rb: number, x: number, y: number, ch: number, channels: number, bitDepth: number, v: number): void {
  if (bitDepth === 16) {
    const i = y * rb + (x * channels + ch) * 2
    buf[i] = (v >> 8) & 0xff
    buf[i + 1] = v & 0xff
    return
  }
  if (bitDepth === 8) {
    buf[y * rb + x * channels + ch] = v & 0xff
    return
  }
  const bitPos = x * bitDepth
  const byteIndex = y * rb + (bitPos >> 3)
  const shift = 8 - bitDepth - (bitPos & 7)
  const mask = ((1 << bitDepth) - 1) << shift
  buf[byteIndex] = (buf[byteIndex] & ~mask) | ((v << shift) & mask)
}

// ---- chunk layer (§5.3) ----
export interface ChunkInfo {
  type: string
  length: number
  crc: number
  crcOk: boolean
  note?: string
}
function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from([type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)])
  const body = concatBytes([typeBytes, data])
  const crc = crc32(body) // CRC-32 over type + data (§5.3)
  return concatBytes([Uint8Array.from(u32be(data.length)), body, Uint8Array.from(u32be(crc))])
}

// ---- ENCODE ----
export interface EncodeOptions {
  strategy?: FilterStrategy
  deflateStrategy?: Strategy
}
export interface EncodeResult {
  bytes: Uint8Array
  filtered: Uint8Array // pre-zlib filtered stream (what DEFLATE sees)
  filteredSize: number
  idatSize: number // zlib-compressed IDAT payload
  totalSize: number
  rowFilters: number[] // chosen filter per scanline, all passes concatenated
  filterHistogram: number[] // count per filter type 0..4
  chunks: ChunkInfo[]
}

export function encodePNG(raster: Raster, opts: EncodeOptions = {}): EncodeResult {
  const { width, height, bitDepth, colorType, interlace } = raster
  const err = validateHeader(colorType, bitDepth)
  if (err) throw new Error('encode: ' + err)
  if (colorType === 3 && !raster.palette) throw new Error('encode: colour type 3 requires a palette')
  const strategy = opts.strategy ?? 'adaptive'
  const channels = CHANNELS[colorType]
  const bpp = bppOf(colorType, bitDepth)

  let filtered: Uint8Array
  const rowFilters: number[] = []
  if (interlace === 0) {
    const rb = rowBytes(width, colorType, bitDepth)
    const f = filterRows(raster.samples, height, rb, bpp, strategy)
    filtered = f.data
    rowFilters.push(...f.rowFilters)
  } else {
    // Adam7: gather each pass into its own packed buffer, filter it, concatenate.
    const rbLogical = rowBytes(width, colorType, bitDepth)
    const parts: Uint8Array[] = []
    for (const p of ADAM7) {
      const { pw, ph } = passDims(width, height, p)
      if (pw === 0 || ph === 0) continue
      const passRb = rowBytes(pw, colorType, bitDepth)
      const passSamples = new Uint8Array(ph * passRb)
      for (let ry = 0; ry < ph; ry++) {
        const sy = p.yStart + ry * p.yStep
        for (let rx = 0; rx < pw; rx++) {
          const sx = p.xStart + rx * p.xStep
          for (let c = 0; c < channels; c++) {
            setSample(passSamples, passRb, rx, ry, c, channels, bitDepth, getSample(raster.samples, rbLogical, sx, sy, c, channels, bitDepth))
          }
        }
      }
      const f = filterRows(passSamples, ph, passRb, bpp, strategy)
      parts.push(f.data)
      rowFilters.push(...f.rowFilters)
    }
    filtered = concatBytes(parts)
  }

  const idat = zlibEncode(filtered, { strategy: opts.deflateStrategy ?? 'auto' })

  const ihdr = new Uint8Array([
    ...u32be(width), ...u32be(height), bitDepth, colorType, 0, 0, interlace,
  ])
  const chunks: Uint8Array[] = [PNG_SIGNATURE, makeChunk('IHDR', ihdr)]
  const chunkInfo: ChunkInfo[] = [{ type: 'IHDR', length: 13, crc: 0, crcOk: true, note: `${width}×${height}, ${bitDepth}-bit ${COLOR_TYPE_NAME[colorType]}${interlace ? ', Adam7' : ''}` }]
  if (raster.palette) {
    chunks.push(makeChunk('PLTE', raster.palette))
    chunkInfo.push({ type: 'PLTE', length: raster.palette.length, crc: 0, crcOk: true, note: `${raster.palette.length / 3} colours` })
  }
  if (raster.trns) {
    chunks.push(makeChunk('tRNS', raster.trns))
    chunkInfo.push({ type: 'tRNS', length: raster.trns.length, crc: 0, crcOk: true, note: 'transparency' })
  }
  chunks.push(makeChunk('IDAT', idat))
  chunkInfo.push({ type: 'IDAT', length: idat.length, crc: 0, crcOk: true, note: `zlib(${filtered.length} B filtered) via our DEFLATE` })
  chunks.push(makeChunk('IEND', new Uint8Array(0)))
  chunkInfo.push({ type: 'IEND', length: 0, crc: 0, crcOk: true })

  const bytes = concatBytes(chunks)
  const hist = [0, 0, 0, 0, 0]
  for (const f of rowFilters) hist[f]++
  return {
    bytes,
    filtered,
    filteredSize: filtered.length,
    idatSize: idat.length,
    totalSize: bytes.length,
    rowFilters,
    filterHistogram: hist,
    chunks: chunkInfo,
  }
}

// ---- DECODE ----
export interface DecodeResult {
  raster: Raster
  chunks: ChunkInfo[]
  adlerOk: boolean
  rowFilters: number[]
  ancillary: { type: string; text: string }[]
  filteredSize: number
}

function ascii(d: Uint8Array, o: number): string {
  return String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3])
}

export function decodePNG(bytes: Uint8Array): DecodeResult {
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error('not a PNG (bad signature)')
  }
  let o = 8
  let ihdr: { width: number; height: number; bitDepth: number; colorType: ColorType; interlace: 0 | 1 } | null = null
  let palette: Uint8Array | undefined
  let trns: Uint8Array | undefined
  const idatParts: Uint8Array[] = []
  const chunks: ChunkInfo[] = []
  const ancillary: { type: string; text: string }[] = []
  let sawIEND = false

  while (o + 8 <= bytes.length) {
    const len = readU32be(bytes, o)
    const type = ascii(bytes, o + 4)
    const dataStart = o + 8
    if (dataStart + len + 4 > bytes.length) throw new Error(`chunk ${type} truncated`)
    const data = bytes.subarray(dataStart, dataStart + len)
    const storedCrc = readU32be(bytes, dataStart + len)
    const calcCrc = crc32(bytes.subarray(o + 4, dataStart + len))
    const crcOk = storedCrc === calcCrc
    if (!crcOk) throw new Error(`chunk ${type}: CRC-32 mismatch (0x${storedCrc.toString(16)} ≠ 0x${calcCrc.toString(16)})`)

    let note: string | undefined
    switch (type) {
      case 'IHDR': {
        const width = readU32be(data, 0)
        const height = readU32be(data, 4)
        const bitDepth = data[8]
        const colorType = data[9] as ColorType
        if (data[10] !== 0) throw new Error('unsupported compression method')
        if (data[11] !== 0) throw new Error('unsupported filter method')
        const interlace = data[12] as 0 | 1
        if (interlace !== 0 && interlace !== 1) throw new Error('unsupported interlace method')
        const he = validateHeader(colorType, bitDepth)
        if (he) throw new Error(he)
        ihdr = { width, height, bitDepth, colorType, interlace }
        note = `${width}×${height}, ${bitDepth}-bit ${COLOR_TYPE_NAME[colorType]}${interlace ? ', Adam7' : ''}`
        break
      }
      case 'PLTE':
        palette = data.slice()
        note = `${len / 3} colours`
        break
      case 'tRNS':
        trns = data.slice()
        note = 'transparency'
        break
      case 'IDAT':
        idatParts.push(data.slice())
        note = `${len} B`
        break
      case 'IEND':
        sawIEND = true
        break
      case 'tEXt': {
        let k = 0
        while (k < data.length && data[k] !== 0) k++
        const keyword = String.fromCharCode(...data.subarray(0, k))
        const text = String.fromCharCode(...data.subarray(k + 1))
        ancillary.push({ type: 'tEXt', text: `${keyword}: ${text}` })
        note = keyword
        break
      }
      case 'gAMA':
        note = `γ = ${readU32be(data, 0) / 100000}`
        ancillary.push({ type: 'gAMA', text: note })
        break
      case 'pHYs': {
        const x = readU32be(data, 0)
        const y = readU32be(data, 4)
        note = `${x}×${y} px/unit`
        ancillary.push({ type: 'pHYs', text: note })
        break
      }
      case 'sRGB':
        note = `rendering intent ${data[0]}`
        ancillary.push({ type: 'sRGB', text: note })
        break
      case 'bKGD':
        note = 'background colour'
        break
      case 'tIME':
        note = 'timestamp'
        break
      default:
        // Unknown chunk: critical (uppercase first letter) chunks we don't grok
        // are a hard error; ancillary ones are safely skipped.
        if ((type.charCodeAt(0) & 0x20) === 0 && type !== 'IHDR') {
          throw new Error(`unknown critical chunk ${type}`)
        }
        note = 'ancillary (skipped)'
        break
    }
    chunks.push({ type, length: len, crc: storedCrc, crcOk, note })
    o = dataStart + len + 4
    if (sawIEND) break
  }

  if (!ihdr) throw new Error('no IHDR chunk')
  if (idatParts.length === 0) throw new Error('no IDAT data')
  if (ihdr.colorType === 3 && !palette) throw new Error('colour type 3 requires a PLTE chunk')

  const { data: filtered, adlerOk } = zlibDecode(concatBytes(idatParts))
  const { width, height, bitDepth, colorType, interlace } = ihdr
  const channels = CHANNELS[colorType]
  const bpp = bppOf(colorType, bitDepth)
  const rowFilters: number[] = []
  let samples: Uint8Array

  if (interlace === 0) {
    const rb = rowBytes(width, colorType, bitDepth)
    const r = reconstructRows(filtered, 0, height, rb, bpp)
    samples = r.samples
    rowFilters.push(...r.rowFilters)
  } else {
    const rbLogical = rowBytes(width, colorType, bitDepth)
    samples = new Uint8Array(height * rbLogical)
    let off = 0
    for (const p of ADAM7) {
      const { pw, ph } = passDims(width, height, p)
      if (pw === 0 || ph === 0) continue
      const passRb = rowBytes(pw, colorType, bitDepth)
      const r = reconstructRows(filtered, off, ph, passRb, bpp)
      off = r.next
      rowFilters.push(...r.rowFilters)
      for (let ry = 0; ry < ph; ry++) {
        const sy = p.yStart + ry * p.yStep
        for (let rx = 0; rx < pw; rx++) {
          const sx = p.xStart + rx * p.xStep
          for (let c = 0; c < channels; c++) {
            setSample(samples, rbLogical, sx, sy, c, channels, bitDepth, getSample(r.samples, passRb, rx, ry, c, channels, bitDepth))
          }
        }
      }
    }
  }

  return {
    raster: { width, height, bitDepth, colorType, interlace, samples, palette, trns },
    chunks,
    adlerOk,
    rowFilters,
    ancillary,
    filteredSize: filtered.length,
  }
}

// ---- pixel layer: raster ⇄ RGBA8 (for display and for encoding arbitrary images) ----
export interface RGBAImage {
  width: number
  height: number
  rgba: Uint8Array // width·height·4
}

function scaleTo8(v: number, bitDepth: number): number {
  if (bitDepth === 8) return v
  if (bitDepth === 16) return v >> 8
  const max = (1 << bitDepth) - 1
  return Math.round((v * 255) / max)
}

/** Expand any raster into 8-bit RGBA for display. Exact (no loss beyond the
 *  16-bit→8-bit display truncation and bit-depth up-scaling). */
export function rasterToRGBA(r: Raster): RGBAImage {
  const { width, height, colorType, bitDepth } = r
  const channels = CHANNELS[colorType]
  const rb = rowBytes(width, colorType, bitDepth)
  const rgba = new Uint8Array(width * height * 4)
  // tRNS colour keys (native sample values) for types 0/2.
  let grayKey = -1
  let rKey = -1, gKey = -1, bKey = -1
  if (r.trns) {
    if (colorType === 0) grayKey = (r.trns[0] << 8) | r.trns[1]
    else if (colorType === 2) {
      rKey = (r.trns[0] << 8) | r.trns[1]
      gKey = (r.trns[2] << 8) | r.trns[3]
      bKey = (r.trns[4] << 8) | r.trns[5]
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (colorType === 0) {
        const v = getSample(r.samples, rb, x, y, 0, channels, bitDepth)
        const g = scaleTo8(v, bitDepth)
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g
        rgba[o + 3] = v === grayKey ? 0 : 255
      } else if (colorType === 2) {
        const rr = getSample(r.samples, rb, x, y, 0, channels, bitDepth)
        const gg = getSample(r.samples, rb, x, y, 1, channels, bitDepth)
        const bb = getSample(r.samples, rb, x, y, 2, channels, bitDepth)
        rgba[o] = scaleTo8(rr, bitDepth)
        rgba[o + 1] = scaleTo8(gg, bitDepth)
        rgba[o + 2] = scaleTo8(bb, bitDepth)
        rgba[o + 3] = rr === rKey && gg === gKey && bb === bKey ? 0 : 255
      } else if (colorType === 3) {
        const idx = getSample(r.samples, rb, x, y, 0, channels, bitDepth)
        const p = r.palette!
        rgba[o] = p[idx * 3]
        rgba[o + 1] = p[idx * 3 + 1]
        rgba[o + 2] = p[idx * 3 + 2]
        rgba[o + 3] = r.trns && idx < r.trns.length ? r.trns[idx] : 255
      } else if (colorType === 4) {
        const g = getSample(r.samples, rb, x, y, 0, channels, bitDepth)
        const a = getSample(r.samples, rb, x, y, 1, channels, bitDepth)
        const g8 = scaleTo8(g, bitDepth)
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g8
        rgba[o + 3] = scaleTo8(a, bitDepth)
      } else {
        const rr = getSample(r.samples, rb, x, y, 0, channels, bitDepth)
        const gg = getSample(r.samples, rb, x, y, 1, channels, bitDepth)
        const bb = getSample(r.samples, rb, x, y, 2, channels, bitDepth)
        const aa = getSample(r.samples, rb, x, y, 3, channels, bitDepth)
        rgba[o] = scaleTo8(rr, bitDepth)
        rgba[o + 1] = scaleTo8(gg, bitDepth)
        rgba[o + 2] = scaleTo8(bb, bitDepth)
        rgba[o + 3] = scaleTo8(aa, bitDepth)
      }
    }
  }
  return { width, height, rgba }
}

function scaleFrom8(v8: number, bitDepth: number): number {
  if (bitDepth === 8) return v8
  if (bitDepth === 16) return (v8 << 8) | v8
  const max = (1 << bitDepth) - 1
  return Math.round((v8 * max) / 255)
}

/** Encode an arbitrary RGBA8 image into a raster of the chosen colour type / bit
 *  depth. Colour types 0/2/4/6 are supported at every legal depth (grayscale via
 *  Rec.601 luma). Colour type 3 builds an exact palette when the image has ≤256
 *  distinct colours, else a median-cut quantised one. */
export function rgbaToRaster(
  img: RGBAImage,
  colorType: ColorType,
  bitDepth: number,
  interlace: 0 | 1 = 0,
): Raster {
  const { width, height, rgba } = img
  const err = validateHeader(colorType, bitDepth)
  if (err) throw new Error('rgbaToRaster: ' + err)
  const channels = CHANNELS[colorType]
  const rb = rowBytes(width, colorType, bitDepth)
  const samples = new Uint8Array(height * rb)
  const luma = (r: number, g: number, b: number) => Math.round(0.299 * r + 0.587 * g + 0.114 * b)

  if (colorType === 3) {
    const { palette, indexOf, trns } = buildPalette(rgba, 1 << bitDepth)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4
        setSample(samples, rb, x, y, 0, channels, bitDepth, indexOf(rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]))
      }
    }
    return { width, height, bitDepth, colorType, interlace, samples, palette, trns }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2], a = rgba[o + 3]
      if (colorType === 0) {
        setSample(samples, rb, x, y, 0, channels, bitDepth, scaleFrom8(luma(r, g, b), bitDepth))
      } else if (colorType === 2) {
        setSample(samples, rb, x, y, 0, channels, bitDepth, scaleFrom8(r, bitDepth))
        setSample(samples, rb, x, y, 1, channels, bitDepth, scaleFrom8(g, bitDepth))
        setSample(samples, rb, x, y, 2, channels, bitDepth, scaleFrom8(b, bitDepth))
      } else if (colorType === 4) {
        setSample(samples, rb, x, y, 0, channels, bitDepth, scaleFrom8(luma(r, g, b), bitDepth))
        setSample(samples, rb, x, y, 1, channels, bitDepth, scaleFrom8(a, bitDepth))
      } else {
        setSample(samples, rb, x, y, 0, channels, bitDepth, scaleFrom8(r, bitDepth))
        setSample(samples, rb, x, y, 1, channels, bitDepth, scaleFrom8(g, bitDepth))
        setSample(samples, rb, x, y, 2, channels, bitDepth, scaleFrom8(b, bitDepth))
        setSample(samples, rb, x, y, 3, channels, bitDepth, scaleFrom8(a, bitDepth))
      }
    }
  }
  return { width, height, bitDepth, colorType, interlace, samples }
}

// A compact colour quantiser: exact when ≤ maxColors distinct, otherwise median cut.
function buildPalette(rgba: Uint8Array, maxColors: number): {
  palette: Uint8Array
  trns?: Uint8Array
  indexOf: (r: number, g: number, b: number, a: number) => number
} {
  const n = rgba.length / 4
  const seen = new Map<number, { r: number; g: number; b: number; a: number }>()
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const key = (rgba[o] << 24) | (rgba[o + 1] << 16) | (rgba[o + 2] << 8) | rgba[o + 3]
    if (!seen.has(key >>> 0)) seen.set(key >>> 0, { r: rgba[o], g: rgba[o + 1], b: rgba[o + 2], a: rgba[o + 3] })
  }
  let colors = [...seen.values()]
  if (colors.length > maxColors) {
    colors = medianCut(rgba, maxColors)
  }
  const palette = new Uint8Array(colors.length * 3)
  let anyAlpha = false
  const alpha = new Uint8Array(colors.length)
  for (let i = 0; i < colors.length; i++) {
    palette[i * 3] = colors[i].r
    palette[i * 3 + 1] = colors[i].g
    palette[i * 3 + 2] = colors[i].b
    alpha[i] = colors[i].a
    if (colors[i].a !== 255) anyAlpha = true
  }
  // trms is truncated to the last non-opaque entry (§11.3.2).
  let trns: Uint8Array | undefined
  if (anyAlpha) {
    let last = colors.length - 1
    while (last >= 0 && alpha[last] === 255) last--
    trns = alpha.subarray(0, last + 1).slice()
  }
  const cache = new Map<number, number>()
  const indexOf = (r: number, g: number, b: number, a: number): number => {
    const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i]
      const dr = c.r - r, dg = c.g - g, db = c.b - b, da = c.a - a
      const d = dr * dr + dg * dg + db * db + da * da
      if (d < bestD) { bestD = d; best = i; if (d === 0) break }
    }
    cache.set(key, best)
    return best
  }
  return { palette, trns, indexOf }
}

interface QColor { r: number; g: number; b: number; a: number }
function medianCut(rgba: Uint8Array, maxColors: number): QColor[] {
  const pixels: QColor[] = []
  for (let i = 0; i < rgba.length; i += 4) pixels.push({ r: rgba[i], g: rgba[i + 1], b: rgba[i + 2], a: rgba[i + 3] })
  const buckets: QColor[][] = [pixels]
  while (buckets.length < maxColors) {
    // Split the bucket with the largest channel range.
    let bi = -1, bestRange = -1, bestCh: 'r' | 'g' | 'b' = 'r'
    for (let i = 0; i < buckets.length; i++) {
      const bk = buckets[i]
      if (bk.length < 2) continue
      for (const ch of ['r', 'g', 'b'] as const) {
        let lo = 255, hi = 0
        for (const p of bk) { if (p[ch] < lo) lo = p[ch]; if (p[ch] > hi) hi = p[ch] }
        if (hi - lo > bestRange) { bestRange = hi - lo; bi = i; bestCh = ch }
      }
    }
    if (bi < 0) break
    const bk = buckets[bi]
    bk.sort((p, q) => p[bestCh] - q[bestCh])
    const mid = bk.length >> 1
    buckets.splice(bi, 1, bk.slice(0, mid), bk.slice(mid))
  }
  return buckets.map((bk) => {
    let r = 0, g = 0, b = 0, a = 0
    for (const p of bk) { r += p.r; g += p.g; b += p.b; a += p.a }
    const n = bk.length || 1
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), a: Math.round(a / n) }
  })
}

/** Convenience: encode an RGBA image straight to PNG bytes. */
export function encodeRGBA(
  img: RGBAImage,
  opts: { colorType?: ColorType; bitDepth?: number; interlace?: 0 | 1 } & EncodeOptions = {},
): EncodeResult {
  const colorType = opts.colorType ?? 6
  const bitDepth = opts.bitDepth ?? 8
  const raster = rgbaToRaster(img, colorType, bitDepth, opts.interlace ?? 0)
  return encodePNG(raster, opts)
}

/** Compare two rasters for exact sample equality (the round-trip oracle). */
export function rastersEqual(a: Raster, b: Raster): boolean {
  if (a.width !== b.width || a.height !== b.height) return false
  if (a.bitDepth !== b.bitDepth || a.colorType !== b.colorType) return false
  if (a.samples.length !== b.samples.length) return false
  for (let i = 0; i < a.samples.length; i++) if (a.samples[i] !== b.samples[i]) return false
  const pa = a.palette, pb = b.palette
  if (!!pa !== !!pb) return false
  if (pa && pb) {
    if (pa.length !== pb.length) return false
    for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return false
  }
  return true
}
