// jpeg.ts — a from-scratch, baseline (sequential DCT, Huffman) **JPEG** codec:
// the lossy capstone of the lab. Everything the lossless pillar chased was a
// hard floor (the entropy H); JPEG steps past it by *throwing information away*
// on purpose — but only the information the eye cannot see — and trading bits
// for fidelity along Shannon's rate–distortion curve.
//
// The pipeline (ITU-T T.81, baseline profile), all built here with zero deps:
//
//   RGB → YCbCr → (chroma subsample) → 8×8 blocks → level shift → DCT
//       → quantise (the lossy step) → zig-zag → DC diff + AC run/size
//       → Huffman → byte-stuffed entropy stream → JFIF container
//
// and its exact inverse for decode. It reuses the lab's own DCT (dct.ts) and the
// standard tables (jpegTables.ts). The output is a real .jpg: the self-test
// proves the *browser's own* decoder renders our file, and that we decode the
// browser's — the same interop bar the gzip/PNG pillars clear, now for a lossy
// format (matched within a PSNR tolerance rather than bit-for-bit, because lossy
// means the pixels legitimately differ).

import { fdct8x8, idct8x8, ZIGZAG } from './dct.ts'
import {
  STD_LUMA_QUANT,
  STD_CHROMA_QUANT,
  STD_DC_LUMA,
  STD_DC_CHROMA,
  STD_AC_LUMA,
  STD_AC_CHROMA,
  scaleQuantTable,
  type HuffSpec,
} from './jpegTables.ts'
import type { RGBAImage } from './png.ts'

// ---- colour space (JFIF full-range YCbCr, BT.601 coefficients) ----

export function rgbToYCbCr(r: number, g: number, b: number): [number, number, number] {
  const y = 0.299 * r + 0.587 * g + 0.114 * b
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
  return [y, cb, cr]
}

export function yCbCrToRgb(y: number, cb: number, cr: number): [number, number, number] {
  const r = y + 1.402 * (cr - 128)
  const g = y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128)
  const b = y + 1.772 * (cb - 128)
  return [clamp8(r), clamp8(g), clamp8(b)]
}

function clamp8(v: number): number {
  const r = Math.round(v)
  return r < 0 ? 0 : r > 255 ? 255 : r
}

// ---- Huffman tables (canonical code from a DHT spec; Annex C & F) ----

class HuffTable {
  readonly spec: HuffSpec
  // encoder: symbol → (code, length)
  readonly ecode = new Int32Array(256).fill(-1)
  readonly esize = new Uint8Array(256)
  // decoder: per code length, the canonical range (Annex F.2.2.3)
  readonly mincode = new Int32Array(17)
  readonly maxcode = new Int32Array(17).fill(-1)
  readonly valptr = new Int32Array(17)
  readonly huffval: readonly number[]

  constructor(spec: HuffSpec) {
    this.spec = spec
    this.huffval = spec.values
    // HUFFSIZE / HUFFCODE (Annex C.2)
    const sizes: number[] = []
    for (let l = 1; l <= 16; l++) for (let i = 0; i < spec.bits[l - 1]; i++) sizes.push(l)
    const codes: number[] = []
    let code = 0
    let k = 0
    if (sizes.length > 0) {
      let si = sizes[0]
      for (;;) {
        while (k < sizes.length && sizes[k] === si) {
          codes.push(code)
          code++
          k++
        }
        if (k >= sizes.length) break
        do {
          code <<= 1
          si++
        } while (sizes[k] !== si)
      }
    }
    for (let i = 0; i < spec.values.length; i++) {
      this.ecode[spec.values[i]] = codes[i]
      this.esize[spec.values[i]] = sizes[i]
    }
    // decoder ranges
    let p = 0
    for (let l = 1; l <= 16; l++) {
      if (spec.bits[l - 1] > 0) {
        this.valptr[l] = p
        this.mincode[l] = codes[p]
        p += spec.bits[l - 1]
        this.maxcode[l] = codes[p - 1]
      } else {
        this.maxcode[l] = -1
      }
    }
  }
}

// ---- bit writer with JPEG byte-stuffing (0xFF → 0xFF 0x00) ----

class BitStuffWriter {
  private bytes: number[] = []
  private acc = 0
  private nbits = 0

  writeBits(value: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >> i) & 1)
      this.nbits++
      if (this.nbits === 8) this.flushByte()
    }
  }

  private flushByte(): void {
    const b = this.acc & 0xff
    this.bytes.push(b)
    if (b === 0xff) this.bytes.push(0x00) // stuff
    this.acc = 0
    this.nbits = 0
  }

  /** Pad the final partial byte with 1-bits (the standard) and return bytes. */
  finish(): number[] {
    if (this.nbits > 0) {
      this.acc = (this.acc << (8 - this.nbits)) | ((1 << (8 - this.nbits)) - 1)
      this.nbits = 8
      this.flushByte()
    }
    return this.bytes
  }
}

// ---- bit reader over an entropy segment (undoes stuffing, stops at markers) ----

class BitStuffReader {
  private data: Uint8Array
  private pos: number
  private bitBuf = 0
  private bitCnt = 0
  ended = false
  constructor(data: Uint8Array, start: number) {
    this.data = data
    this.pos = start
  }
  // pull the next entropy byte, undoing 0xFF00 stuffing and stopping at markers
  private nextByte(): number {
    if (this.ended || this.pos >= this.data.length) {
      this.ended = true
      return 0xff // feed 1-bits past the end (the standard padding)
    }
    const b = this.data[this.pos++]
    if (b === 0xff) {
      const next = this.data[this.pos]
      if (next === 0x00) {
        this.pos++ // stuffed literal 0xFF — skip the padding zero
      } else {
        // a real marker (EOI, RSTn, …). Rewind so restart()/the caller can see it.
        this.pos--
        this.ended = true
        return 0xff
      }
    }
    return b
  }
  readBit(): number {
    if (this.bitCnt === 0) {
      this.bitBuf = this.nextByte()
      this.bitCnt = 8
    }
    this.bitCnt--
    return (this.bitBuf >> this.bitCnt) & 1
  }
  readBits(len: number): number {
    let v = 0
    for (let i = 0; i < len; i++) v = (v << 1) | this.readBit()
    return v
  }
  decodeSymbol(t: HuffTable): number {
    let l = 1
    let code = this.readBit()
    while (l <= 16 && (t.maxcode[l] < 0 || code > t.maxcode[l])) {
      code = (code << 1) | this.readBit()
      l++
    }
    if (l > 16) return 0
    const idx = t.valptr[l] + (code - t.mincode[l])
    return t.huffval[idx] ?? 0
  }
  // At a restart interval boundary: discard the partial byte, consume the
  // RSTn marker if present, and resume. Lets us decode browser-emitted JPEGs
  // that use restart markers.
  restart(): void {
    this.bitCnt = 0
    this.ended = false
    if (this.data[this.pos] === 0xff && this.data[this.pos + 1] >= 0xd0 && this.data[this.pos + 1] <= 0xd7) {
      this.pos += 2
    }
  }
}

// ---- magnitude / category coding (Annex F.1.2.1) ----

function magnitudeCategory(v: number): number {
  const a = Math.abs(v)
  return a === 0 ? 0 : 32 - Math.clz32(a)
}
// additional low bits for a signed value of the given category
function magnitudeBits(v: number, s: number): number {
  return (v >= 0 ? v : v - 1) & ((1 << s) - 1)
}
// inverse: extend s received bits back to a signed value (F.2.2.1 EXTEND)
function extend(t: number, s: number): number {
  return t < 1 << (s - 1) ? t - (1 << s) + 1 : t
}

// ---- component / options model ----

export type Subsampling = '4:4:4' | '4:2:2' | '4:2:0'

export interface EncodeOptions {
  quality?: number // 1..100, default 75
  subsampling?: Subsampling // default 4:2:0 (ignored for grayscale)
  grayscale?: boolean // encode luma only
}

interface Component {
  id: number
  h: number // horizontal sampling factor
  v: number // vertical sampling factor
  quantId: number
  dcId: number
  acId: number
}

export interface ComponentStat {
  name: string
  dcBits: number
  acBits: number
  blocks: number
  nonZeroCoef: number
}

export interface EncodeResult {
  bytes: Uint8Array
  width: number
  height: number
  quality: number
  subsampling: Subsampling | 'gray'
  lumaQuant: Uint16Array
  chromaQuant: Uint16Array | null
  components: ComponentStat[]
  scanBytes: number // entropy-coded segment length
  headerBytes: number
  bitsPerPixel: number
  markers: { name: string; offset: number; length: number }[]
}

// clamp a quantised coefficient to the range the baseline Huffman tables can
// express (|DC diff| ≤ cat 11, |AC| ≤ cat 10); only ever bites at quality ~100
// on pathological synthetic blocks, never on natural images.
function clampCoef(q: number): number {
  return q < -1023 ? -1023 : q > 1023 ? 1023 : q
}

// ---- the encoder ----

export function encodeJPEG(img: RGBAImage, opts: EncodeOptions = {}): EncodeResult {
  const quality = opts.quality ?? 75
  const grayscale = opts.grayscale ?? false
  const sub: Subsampling = opts.subsampling ?? '4:2:0'
  const { width, height, rgba } = img

  const lumaQ = scaleQuantTable(STD_LUMA_QUANT, quality)
  const chromaQ = scaleQuantTable(STD_CHROMA_QUANT, quality)

  // component layout
  let comps: Component[]
  if (grayscale) {
    comps = [{ id: 1, h: 1, v: 1, quantId: 0, dcId: 0, acId: 0 }]
  } else {
    const [yh, yv] = sub === '4:2:0' ? [2, 2] : sub === '4:2:2' ? [2, 1] : [1, 1]
    comps = [
      { id: 1, h: yh, v: yv, quantId: 0, dcId: 0, acId: 0 },
      { id: 2, h: 1, v: 1, quantId: 1, dcId: 1, acId: 1 },
      { id: 3, h: 1, v: 1, quantId: 1, dcId: 1, acId: 1 },
    ]
  }
  const hMax = Math.max(...comps.map((c) => c.h))
  const vMax = Math.max(...comps.map((c) => c.v))
  const mcusX = Math.ceil(width / (8 * hMax))
  const mcusY = Math.ceil(height / (8 * vMax))

  // full-resolution YCbCr planes (float), edge-clamped sampling handles padding
  const yP = new Float64Array(width * height)
  const cbP = new Float64Array(width * height)
  const crP = new Float64Array(width * height)
  for (let p = 0, i = 0; p < width * height; p++, i += 4) {
    const [Y, Cb, Cr] = rgbToYCbCr(rgba[i], rgba[i + 1], rgba[i + 2])
    yP[p] = Y
    cbP[p] = Cb
    crP[p] = Cr
  }
  const plane = [yP, cbP, crP]

  // sample a full-res plane at reduced resolution with edge clamping (this both
  // downsamples chroma by box-averaging and pads out-of-bounds to the edge).
  function sampleBlock(planeIdx: number, sx: number, sy: number, px0: number, py0: number, out: Float64Array): void {
    const pl = plane[planeIdx]
    for (let by = 0; by < 8; by++) {
      for (let bx = 0; bx < 8; bx++) {
        const fx0 = (px0 + bx) * sx
        const fy0 = (py0 + by) * sy
        let acc = 0
        for (let dy = 0; dy < sy; dy++) {
          let yy = fy0 + dy
          if (yy >= height) yy = height - 1
          for (let dx = 0; dx < sx; dx++) {
            let xx = fx0 + dx
            if (xx >= width) xx = width - 1
            acc += pl[yy * width + xx]
          }
        }
        out[by * 8 + bx] = acc / (sx * sy) - 128 // level shift
      }
    }
  }

  const writer = new BitStuffWriter()
  const dcTables = [new HuffTable(STD_DC_LUMA), new HuffTable(STD_DC_CHROMA)]
  const acTables = [new HuffTable(STD_AC_LUMA), new HuffTable(STD_AC_CHROMA)]
  const quantTables = [lumaQ, chromaQ]
  const prevDC = new Array<number>(comps.length).fill(0)
  const stats: ComponentStat[] = comps.map((c) => ({
    name: c.id === 1 ? 'Y' : c.id === 2 ? 'Cb' : 'Cr',
    dcBits: 0,
    acBits: 0,
    blocks: 0,
    nonZeroCoef: 0,
  }))

  const spatial = new Float64Array(64)
  const freq = new Float64Array(64)
  const zz = new Int32Array(64)

  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      for (let ci = 0; ci < comps.length; ci++) {
        const c = comps[ci]
        const sx = hMax / c.h
        const sy = vMax / c.v
        const q = quantTables[c.quantId]
        const dcT = dcTables[c.dcId]
        const acT = acTables[c.acId]
        for (let by = 0; by < c.v; by++) {
          for (let bx = 0; bx < c.h; bx++) {
            const px0 = (mx * c.h + bx) * 8
            const py0 = (my * c.v + by) * 8
            sampleBlock(ci, sx, sy, px0, py0, spatial)
            fdct8x8(spatial, freq)
            // quantise + zig-zag
            for (let k = 0; k < 64; k++) {
              const nat = ZIGZAG[k]
              zz[k] = clampCoef(Math.round(freq[nat] / q[nat]))
            }
            // DC: differential + category
            const dc = zz[0]
            const diff = dc - prevDC[ci]
            prevDC[ci] = dc
            const s = magnitudeCategory(diff)
            writer.writeBits(dcT.ecode[s], dcT.esize[s])
            if (s > 0) writer.writeBits(magnitudeBits(diff, s), s)
            stats[ci].dcBits += dcT.esize[s] + s
            // AC: run/size
            let run = 0
            let lastNonZero = 0
            for (let k = 63; k >= 1; k--) if (zz[k] !== 0) { lastNonZero = k; break }
            let nz = dc !== 0 ? 1 : 0
            for (let k = 1; k <= lastNonZero; k++) {
              const coef = zz[k]
              if (coef === 0) {
                run++
                continue
              }
              while (run > 15) {
                writer.writeBits(acT.ecode[0xf0], acT.esize[0xf0]) // ZRL
                stats[ci].acBits += acT.esize[0xf0]
                run -= 16
              }
              const size = magnitudeCategory(coef)
              const sym = (run << 4) | size
              writer.writeBits(acT.ecode[sym], acT.esize[sym])
              writer.writeBits(magnitudeBits(coef, size), size)
              stats[ci].acBits += acT.esize[sym] + size
              nz++
              run = 0
            }
            if (lastNonZero < 63) {
              writer.writeBits(acT.ecode[0x00], acT.esize[0x00]) // EOB
              stats[ci].acBits += acT.esize[0x00]
            }
            stats[ci].blocks++
            stats[ci].nonZeroCoef += nz
          }
        }
      }
    }
  }

  const scan = writer.finish()

  // ---- assemble the JFIF byte stream ----
  const out: number[] = []
  const markers: { name: string; offset: number; length: number }[] = []
  const put16 = (v: number) => {
    out.push((v >> 8) & 0xff, v & 0xff)
  }
  const seg = (name: string, marker: number, body: number[]) => {
    const offset = out.length
    out.push(0xff, marker)
    put16(body.length + 2)
    for (const b of body) out.push(b)
    markers.push({ name, offset, length: body.length + 4 })
  }

  out.push(0xff, 0xd8) // SOI
  markers.push({ name: 'SOI', offset: 0, length: 2 })

  // APP0 / JFIF
  seg('APP0 (JFIF)', 0xe0, [
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    1, 1, // version 1.1
    0, // units
    0, 1, 0, 1, // X/Y density
    0, 0, // thumbnail
  ])

  // DQT (luma, and chroma if colour)
  const dqtBody = (id: number, table: Uint16Array): number[] => {
    const body = [0x00 | id] // 8-bit precision
    for (let k = 0; k < 64; k++) body.push(table[ZIGZAG[k]])
    return body
  }
  seg('DQT · luma', 0xdb, dqtBody(0, lumaQ))
  if (!grayscale) seg('DQT · chroma', 0xdb, dqtBody(1, chromaQ))

  // SOF0 (baseline)
  const sof: number[] = [8, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, comps.length]
  for (const c of comps) sof.push(c.id, (c.h << 4) | c.v, c.quantId)
  seg('SOF0 (baseline)', 0xc0, sof)

  // DHT (all tables actually used)
  const dht = (cls: number, id: number, spec: HuffSpec): number[] => {
    const body = [(cls << 4) | id]
    for (let i = 0; i < 16; i++) body.push(spec.bits[i])
    for (const v of spec.values) body.push(v)
    return body
  }
  seg('DHT · DC luma', 0xc4, dht(0, 0, STD_DC_LUMA))
  seg('DHT · AC luma', 0xc4, dht(1, 0, STD_AC_LUMA))
  if (!grayscale) {
    seg('DHT · DC chroma', 0xc4, dht(0, 1, STD_DC_CHROMA))
    seg('DHT · AC chroma', 0xc4, dht(1, 1, STD_AC_CHROMA))
  }

  // SOS
  const sos: number[] = [comps.length]
  for (const c of comps) sos.push(c.id, (c.dcId << 4) | c.acId)
  sos.push(0, 63, 0) // Ss, Se, Ah/Al
  const scanStart = out.length
  seg('SOS', 0xda, sos)
  const scanHeaderEnd = out.length
  for (const b of scan) out.push(b)
  markers.push({ name: 'entropy data', offset: scanHeaderEnd, length: scan.length })

  out.push(0xff, 0xd9) // EOI
  markers.push({ name: 'EOI', offset: out.length - 2, length: 2 })

  const bytes = Uint8Array.from(out)
  return {
    bytes,
    width,
    height,
    quality,
    subsampling: grayscale ? 'gray' : sub,
    lumaQuant: lumaQ,
    chromaQuant: grayscale ? null : chromaQ,
    components: stats,
    scanBytes: scan.length,
    headerBytes: scanStart,
    bitsPerPixel: (scan.length * 8) / (width * height),
    markers,
  }
}

// libjpeg-style "fancy" (triangle-filter) chroma upsampling by a factor of
// 2 in each requested dimension, with 3:1 edge-aware blending — what real
// decoders (and browsers) use, so our reconstruction and their reconstruction
// of the same file converge. `fx`,`fy` ∈ {1,2}.
function fancyUpsample(src: Uint8Array, cw: number, ch: number, fx: number, fy: number): Uint8Array {
  let cur = src
  let w = cw
  const h = ch
  if (fx === 2) {
    const nw = cw * 2
    const out = new Uint8Array(nw * h)
    for (let y = 0; y < h; y++) {
      const r = y * cw
      const o = y * nw
      if (cw === 1) {
        out[o] = cur[r]
        out[o + 1] = cur[r]
        continue
      }
      out[o] = cur[r]
      out[o + 1] = (cur[r] * 3 + cur[r + 1] + 2) >> 2
      for (let x = 1; x < cw - 1; x++) {
        const v3 = cur[r + x] * 3
        out[o + 2 * x] = (v3 + cur[r + x - 1] + 1) >> 2
        out[o + 2 * x + 1] = (v3 + cur[r + x + 1] + 2) >> 2
      }
      out[o + 2 * (cw - 1)] = (cur[r + cw - 1] * 3 + cur[r + cw - 2] + 1) >> 2
      out[o + 2 * cw - 1] = cur[r + cw - 1]
    }
    cur = out
    w = nw
  }
  if (fy === 2) {
    const nh = h * 2
    const out = new Uint8Array(w * nh)
    for (let x = 0; x < w; x++) {
      if (h === 1) {
        out[x] = cur[x]
        out[w + x] = cur[x]
        continue
      }
      out[x] = cur[x]
      out[w + x] = (cur[x] * 3 + cur[w + x] + 2) >> 2
      for (let y = 1; y < h - 1; y++) {
        const v3 = cur[y * w + x] * 3
        out[2 * y * w + x] = (v3 + cur[(y - 1) * w + x] + 1) >> 2
        out[(2 * y + 1) * w + x] = (v3 + cur[(y + 1) * w + x] + 2) >> 2
      }
      out[2 * (h - 1) * w + x] = (cur[(h - 1) * w + x] * 3 + cur[(h - 2) * w + x] + 1) >> 2
      out[(2 * h - 1) * w + x] = cur[(h - 1) * w + x]
    }
    cur = out
  }
  return cur
}

// ---- the decoder ----

interface FrameComponent {
  id: number
  h: number
  v: number
  quantId: number
}

export interface DecodeResult {
  image: RGBAImage
  width: number
  height: number
  components: number
  subsampling: string
  progressive: boolean
}

export function decodeJPEG(data: Uint8Array): DecodeResult {
  let pos = 0
  const rd16 = () => {
    const v = (data[pos] << 8) | data[pos + 1]
    pos += 2
    return v
  }
  if (data[pos] !== 0xff || data[pos + 1] !== 0xd8) throw new Error('not a JPEG (missing SOI)')
  pos += 2

  const quant: (Uint16Array | undefined)[] = []
  const dcTab: (HuffTable | undefined)[] = []
  const acTab: (HuffTable | undefined)[] = []
  let width = 0
  let height = 0
  let frameComps: FrameComponent[] = []
  let scanComps: { comp: FrameComponent; dcId: number; acId: number }[] = []
  let scanStart = -1
  let restartInterval = 0

  for (;;) {
    if (pos >= data.length) throw new Error('unexpected end of JPEG')
    if (data[pos] !== 0xff) {
      pos++
      continue
    }
    const marker = data[pos + 1]
    pos += 2
    if (marker === 0xd9) break // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue // standalone
    const segLen = rd16()
    const segEnd = pos + segLen - 2

    if (marker === 0xdb) {
      // DQT
      while (pos < segEnd) {
        const pq = data[pos] >> 4
        const tq = data[pos] & 0x0f
        pos++
        const t = new Uint16Array(64)
        for (let k = 0; k < 64; k++) {
          const v = pq === 0 ? data[pos++] : rd16()
          t[ZIGZAG[k]] = v
        }
        quant[tq] = t
      }
    } else if (marker === 0xc4) {
      // DHT
      while (pos < segEnd) {
        const tc = data[pos] >> 4
        const th = data[pos] & 0x0f
        pos++
        const bits: number[] = []
        let total = 0
        for (let i = 0; i < 16; i++) {
          bits.push(data[pos + i])
          total += data[pos + i]
        }
        pos += 16
        const values: number[] = []
        for (let i = 0; i < total; i++) values.push(data[pos++])
        const table = new HuffTable({ bits, values })
        if (tc === 0) dcTab[th] = table
        else acTab[th] = table
      }
    } else if (marker === 0xc0 || marker === 0xc1) {
      // SOF0/1 baseline
      pos++ // precision
      height = rd16()
      width = rd16()
      const nf = data[pos++]
      frameComps = []
      for (let i = 0; i < nf; i++) {
        const id = data[pos++]
        const hv = data[pos++]
        const tq = data[pos++]
        frameComps.push({ id, h: hv >> 4, v: hv & 0x0f, quantId: tq })
      }
    } else if (marker === 0xdd) {
      // DRI — restart interval (in MCUs)
      restartInterval = rd16()
    } else if (marker === 0xc2) {
      throw new Error('progressive JPEG not supported (baseline only)')
    } else if (marker === 0xda) {
      // SOS
      const ns = data[pos++]
      scanComps = []
      for (let i = 0; i < ns; i++) {
        const cs = data[pos++]
        const tdta = data[pos++]
        const comp = frameComps.find((c) => c.id === cs)
        if (!comp) throw new Error('SOS references unknown component')
        scanComps.push({ comp, dcId: tdta >> 4, acId: tdta & 0x0f })
      }
      pos += 3 // Ss, Se, Ah/Al
      scanStart = pos
      break
    } else {
      pos = segEnd // skip APPn/COM/etc
    }
  }

  if (scanStart < 0) throw new Error('no scan found')

  const hMax = Math.max(...frameComps.map((c) => c.h))
  const vMax = Math.max(...frameComps.map((c) => c.v))
  const mcusX = Math.ceil(width / (8 * hMax))
  const mcusY = Math.ceil(height / (8 * vMax))
  const paddedW = mcusX * hMax * 8

  // reconstructed component planes at their native (sub-sampled) resolution
  const planes = frameComps.map((c) => new Uint8Array(mcusX * c.h * 8 * (mcusY * c.v * 8)))
  const planeW = frameComps.map((c) => mcusX * c.h * 8)

  const reader = new BitStuffReader(data, scanStart)
  const prevDC = new Array<number>(frameComps.length).fill(0)
  const coef = new Float64Array(64)
  const spatial = new Float64Array(64)
  let mcuCount = 0

  for (let my = 0; my < mcusY; my++) {
    for (let mx = 0; mx < mcusX; mx++) {
      if (restartInterval > 0 && mcuCount > 0 && mcuCount % restartInterval === 0) {
        reader.restart()
        prevDC.fill(0)
      }
      mcuCount++
      for (let si = 0; si < scanComps.length; si++) {
        const { comp, dcId, acId } = scanComps[si]
        const ci = frameComps.indexOf(comp)
        const q = quant[comp.quantId]
        const dcT = dcTab[dcId]
        const acT = acTab[acId]
        if (!q || !dcT || !acT) throw new Error('scan references missing table')
        for (let by = 0; by < comp.v; by++) {
          for (let bx = 0; bx < comp.h; bx++) {
            coef.fill(0)
            // DC
            const s = reader.decodeSymbol(dcT)
            const diff = s > 0 ? extend(reader.readBits(s), s) : 0
            prevDC[ci] += diff
            coef[0] = prevDC[ci] * q[0]
            // AC
            let k = 1
            while (k < 64) {
              const rs = reader.decodeSymbol(acT)
              const run = rs >> 4
              const size = rs & 0x0f
              if (size === 0) {
                if (run === 15) {
                  k += 16 // ZRL
                  continue
                }
                break // EOB
              }
              k += run
              if (k >= 64) break
              const nat = ZIGZAG[k]
              coef[nat] = extend(reader.readBits(size), size) * q[nat]
              k++
            }
            idct8x8(coef, spatial)
            // write block into plane
            const pw = planeW[ci]
            const ox = (mx * comp.h + bx) * 8
            const oy = (my * comp.v + by) * 8
            const pl = planes[ci]
            for (let yy = 0; yy < 8; yy++) {
              const row = (oy + yy) * pw + ox
              for (let xx = 0; xx < 8; xx++) {
                pl[row + xx] = clamp8(spatial[yy * 8 + xx] + 128)
              }
            }
          }
        }
      }
    }
  }

  // upsample every plane to full padded resolution (fancy triangle filter for
  // subsampled chroma), then combine → RGBA and crop to the true dimensions.
  const full = frameComps.map((c, ci) =>
    fancyUpsample(planes[ci], mcusX * c.h * 8, mcusY * c.v * 8, hMax / c.h, vMax / c.v),
  )
  const rgba = new Uint8Array(width * height * 4)
  const gray = frameComps.length === 1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4
      const fi = y * paddedW + x
      if (gray) {
        const pv = full[0][fi]
        rgba[idx] = pv
        rgba[idx + 1] = pv
        rgba[idx + 2] = pv
        rgba[idx + 3] = 255
      } else {
        const [r, g, b] = yCbCrToRgb(full[0][fi], full[1][fi], full[2][fi])
        rgba[idx] = r
        rgba[idx + 1] = g
        rgba[idx + 2] = b
        rgba[idx + 3] = 255
      }
    }
  }

  const sub =
    gray
      ? 'gray'
      : frameComps[0].h === 2 && frameComps[0].v === 2
        ? '4:2:0'
        : frameComps[0].h === 2 && frameComps[0].v === 1
          ? '4:2:2'
          : '4:4:4'

  return { image: { width, height, rgba }, width, height, components: frameComps.length, subsampling: sub, progressive: false }
}

// ---- distortion metrics ----

/** Mean squared error over the RGB channels of two equal-size images. */
export function mse(a: RGBAImage, b: RGBAImage): number {
  const n = a.width * a.height
  let sum = 0
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const dr = a.rgba[i] - b.rgba[i]
    const dg = a.rgba[i + 1] - b.rgba[i + 1]
    const db = a.rgba[i + 2] - b.rgba[i + 2]
    sum += dr * dr + dg * dg + db * db
  }
  return sum / (n * 3)
}

/** Peak signal-to-noise ratio in dB — the standard image-fidelity measure.
 *  ∞ (returned as a large sentinel) when the images are identical. */
export function psnr(a: RGBAImage, b: RGBAImage): number {
  const e = mse(a, b)
  if (e <= 1e-12) return Infinity
  return 10 * Math.log10((255 * 255) / e)
}
