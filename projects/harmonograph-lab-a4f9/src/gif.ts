// A from-scratch animated-GIF encoder — no dependencies, no <canvas>.toBlob
// tricks. We render the drawing pass into an offscreen canvas frame by frame,
// quantize the colors down to a 256-entry palette with median cut, map every
// pixel to its nearest palette index, and emit a real GIF89a byte stream with
// variable-width LZW compression and a NETSCAPE2.0 loop block. The result plays
// everywhere — including the contexts where canvas `captureStream` / WebM is
// unavailable — so it's the universal way to share an animated figure.
//
// Everything that touches the DOM or reads pixels is feature-detected and
// wrapped in try/catch so an unsupported/sandboxed context degrades gracefully.

export interface GifOptions {
  size: number // square pixel dimension of the GIF
  frames: number // number of frames across the drawing pass (trace 0→1)
  delayMs: number // delay between frames
  holdMs: number // extra time lingering on the finished figure
}

// Render the project at a given trace into an offscreen context. The caller
// supplies this so the GIF reuses the exact same render path as the screen.
export type RenderAt = (ctx: CanvasRenderingContext2D, size: number, trace: number) => void

export function canGif(): boolean {
  try {
    return (
      typeof document !== 'undefined' &&
      typeof document.createElement === 'function' &&
      typeof Uint8Array !== 'undefined'
    )
  } catch {
    return false
  }
}

// ---- LSB-first bit packer (GIF packs LZW codes low bit first) --------------

class BitWriter {
  private bytes: number[] = []
  private cur = 0
  private nbits = 0

  writeBits(value: number, len: number) {
    this.cur |= (value << this.nbits) & 0xff_ff_ff_ff
    this.nbits += len
    while (this.nbits >= 8) {
      this.bytes.push(this.cur & 0xff)
      this.cur >>>= 8
      this.nbits -= 8
    }
  }

  finish(): number[] {
    if (this.nbits > 0) {
      this.bytes.push(this.cur & 0xff)
      this.cur = 0
      this.nbits = 0
    }
    return this.bytes
  }
}

// ---- variable-width LZW (GIF flavour) -------------------------------------
// Standard GIF LZW: a clear code and an end-of-information code bracket the
// stream; the dictionary grows from `minCodeSize + 1` bits up to 12, resetting
// with a clear code whenever it fills. Indices are packed LSB-first.

function lzwCompress(indices: Uint8Array, minCodeSize: number): number[] {
  const clearCode = 1 << minCodeSize
  const eoiCode = clearCode + 1
  const writer = new BitWriter()

  let codeSize = minCodeSize + 1
  let dict = new Map<string, number>()
  let next = eoiCode + 1
  const resetDict = () => {
    dict = new Map<string, number>()
    for (let i = 0; i < clearCode; i++) dict.set(String(i), i)
    next = eoiCode + 1
    codeSize = minCodeSize + 1
  }

  resetDict()
  writer.writeBits(clearCode, codeSize)

  if (indices.length === 0) {
    writer.writeBits(eoiCode, codeSize)
    return writer.finish()
  }

  let w = String(indices[0])
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]
    const wk = w + ',' + k
    if (dict.has(wk)) {
      w = wk
    } else {
      writer.writeBits(dict.get(w)!, codeSize)
      dict.set(wk, next)
      next++
      // Grow the code width the instant the next index needs one more bit, and
      // flush with a clear code once the table is full — both in lockstep with
      // how a standard GIF decoder grows and resets its own table.
      if (next === 4096) {
        writer.writeBits(clearCode, codeSize)
        resetDict()
      } else if (next === 1 << codeSize && codeSize < 12) {
        codeSize++
      }
      w = String(k)
    }
  }
  writer.writeBits(dict.get(w)!, codeSize)
  writer.writeBits(eoiCode, codeSize)
  return writer.finish()
}

// GIF stores image data as sub-blocks of at most 255 bytes, each prefixed by
// its length; a zero-length block terminates the run.
function toSubBlocks(data: number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.slice(i, i + 255)
    out.push(chunk.length)
    for (const b of chunk) out.push(b)
  }
  out.push(0)
  return out
}

// ---- median-cut color quantization ----------------------------------------

interface Box {
  pixels: number[] // packed 0xRRGGBB
  rMin: number
  rMax: number
  gMin: number
  gMax: number
  bMin: number
  bMax: number
}

function boundsOf(pixels: number[]): Box {
  let rMin = 255
  let gMin = 255
  let bMin = 255
  let rMax = 0
  let gMax = 0
  let bMax = 0
  for (const p of pixels) {
    const r = (p >> 16) & 0xff
    const g = (p >> 8) & 0xff
    const b = p & 0xff
    if (r < rMin) rMin = r
    if (r > rMax) rMax = r
    if (g < gMin) gMin = g
    if (g > gMax) gMax = g
    if (b < bMin) bMin = b
    if (b > bMax) bMax = b
  }
  return { pixels, rMin, rMax, gMin, gMax, bMin, bMax }
}

// Quantize a sample of packed pixels into <= maxColors representative colors.
function medianCut(sample: number[], maxColors: number): number[][] {
  if (sample.length === 0) return [[0, 0, 0]]
  const boxes: Box[] = [boundsOf(sample)]

  while (boxes.length < maxColors) {
    // Split the box with the largest single-channel spread.
    let target = -1
    let bestRange = 0
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]
      if (b.pixels.length < 2) continue
      const range = Math.max(b.rMax - b.rMin, b.gMax - b.gMin, b.bMax - b.bMin)
      if (range > bestRange) {
        bestRange = range
        target = i
      }
    }
    if (target < 0 || bestRange === 0) break

    const box = boxes[target]
    const rR = box.rMax - box.rMin
    const gR = box.gMax - box.gMin
    const bR = box.bMax - box.bMin
    const shift = rR >= gR && rR >= bR ? 16 : gR >= bR ? 8 : 0
    box.pixels.sort((p1, p2) => ((p1 >> shift) & 0xff) - ((p2 >> shift) & 0xff))
    const mid = box.pixels.length >> 1
    const lo = box.pixels.slice(0, mid)
    const hi = box.pixels.slice(mid)
    boxes.splice(target, 1, boundsOf(lo), boundsOf(hi))
  }

  return boxes.map((box) => {
    let r = 0
    let g = 0
    let b = 0
    for (const p of box.pixels) {
      r += (p >> 16) & 0xff
      g += (p >> 8) & 0xff
      b += p & 0xff
    }
    const n = Math.max(1, box.pixels.length)
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
  })
}

// A nearest-palette-index lookup with a 15-bit (5 bits/channel) cache so we pay
// the 256-color distance search at most once per color bucket, not per pixel.
class Quantizer {
  readonly palette: number[][]
  private cache: Int16Array

  constructor(palette: number[][]) {
    this.palette = palette
    this.cache = new Int16Array(32768).fill(-1)
  }

  indexOf(r: number, g: number, b: number): number {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    const cached = this.cache[key]
    if (cached >= 0) return cached
    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < this.palette.length; i++) {
      const c = this.palette[i]
      const dr = r - c[0]
      const dg = g - c[1]
      const db = b - c[2]
      const dist = dr * dr + dg * dg + db * db
      if (dist < bestDist) {
        bestDist = dist
        best = i
      }
    }
    this.cache[key] = best
    return best
  }
}

// ---- GIF assembly ----------------------------------------------------------

function pushString(out: number[], s: string) {
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i))
}
function pushShort(out: number[], v: number) {
  out.push(v & 0xff, (v >> 8) & 0xff)
}

// Build the global color table sized to a power of two, returning the bytes,
// the entry count, and the bits needed to index it.
function buildColorTable(palette: number[][]): { bytes: number[]; bits: number; size: number } {
  const bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, palette.length))))
  const size = 1 << bits
  const bytes: number[] = []
  for (let i = 0; i < size; i++) {
    const c = palette[i] ?? [0, 0, 0]
    bytes.push(c[0] & 0xff, c[1] & 0xff, c[2] & 0xff)
  }
  return { bytes, bits, size }
}

// Assemble a complete, looping GIF89a byte stream from already-indexed frames
// and a shared palette. Pure (no DOM), so it can be unit-tested in isolation.
export function assembleGif(
  indexed: Uint8Array[],
  size: number,
  palette: number[][],
  delayMs: number,
  holdRepeat: number,
): Uint8Array<ArrayBuffer> {
  const table = buildColorTable(palette)
  const minCodeSize = Math.max(2, table.bits)

  const out: number[] = []
  pushString(out, 'GIF89a')
  pushShort(out, size)
  pushShort(out, size)
  out.push(0x80 | ((table.bits - 1) & 0x07)) // global table present, color res 1
  out.push(0) // background color index
  out.push(0) // pixel aspect ratio
  for (const b of table.bytes) out.push(b)

  // NETSCAPE2.0 application extension: loop forever.
  out.push(0x21, 0xff, 0x0b)
  pushString(out, 'NETSCAPE2.0')
  out.push(0x03, 0x01)
  pushShort(out, 0) // 0 = infinite loop
  out.push(0x00)

  const delayCs = Math.max(1, Math.round(delayMs / 10)) // GIF delay is in 1/100 s
  const emitFrame = (idx: Uint8Array) => {
    // Graphic control extension (frame delay, no transparency).
    out.push(0x21, 0xf9, 0x04, 0x04)
    pushShort(out, delayCs)
    out.push(0x00, 0x00)
    // Image descriptor.
    out.push(0x2c)
    pushShort(out, 0)
    pushShort(out, 0)
    pushShort(out, size)
    pushShort(out, size)
    out.push(0x00) // no local color table
    // LZW image data.
    out.push(minCodeSize)
    for (const b of toSubBlocks(lzwCompress(idx, minCodeSize))) out.push(b)
  }

  for (const idx of indexed) emitFrame(idx)
  // Linger on the finished figure by repeating the last frame.
  for (let h = 0; h < holdRepeat && indexed.length > 0; h++) {
    emitFrame(indexed[indexed.length - 1])
  }

  out.push(0x3b) // trailer
  return new Uint8Array(out)
}

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0))

export async function recordGif(render: RenderAt, opts: GifOptions): Promise<Blob> {
  if (!canGif()) throw new Error('GIF export is not supported here.')

  const size = Math.max(16, Math.round(opts.size))
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not create a drawing context for GIF export.')

  const frameCount = Math.max(2, Math.round(opts.frames))
  const holdFrames = Math.max(0, Math.round(opts.holdMs / Math.max(1, opts.delayMs)))

  // ease-out so the pen accelerates away from the start and settles at the end.
  const ease = (t: number) => 1 - Math.pow(1 - t, 1.7)

  // Capture every frame's pixels up front (indexed later against one shared
  // palette so colors stay stable across the whole animation).
  const framePixels: Uint8ClampedArray[] = []
  for (let f = 0; f < frameCount; f++) {
    const trace = ease(f / (frameCount - 1))
    render(ctx, size, trace)
    let data: Uint8ClampedArray
    try {
      data = ctx.getImageData(0, 0, size, size).data
    } catch (err) {
      throw err instanceof Error ? err : new Error('Could not read frame pixels.')
    }
    framePixels.push(data)
    if (f % 4 === 0) await yieldToUi()
  }

  // Build one global palette from the final (fullest) frame plus a sampling of
  // the earlier ones, so colors revealed only mid-draw still get represented.
  const sample: number[] = []
  const last = framePixels[framePixels.length - 1]
  const step = Math.max(1, Math.floor((size * size) / 16000))
  for (const data of [last, framePixels[Math.floor(frameCount / 2)]]) {
    for (let i = 0; i < size * size; i += step) {
      const o = i * 4
      sample.push((data[o] << 16) | (data[o + 1] << 8) | data[o + 2])
    }
  }
  const palette = medianCut(sample, 256)
  const quant = new Quantizer(palette)

  // Index every frame's pixels against the shared palette.
  const indexed: Uint8Array[] = []
  for (let f = 0; f < frameCount; f++) {
    const data = framePixels[f]
    const idx = new Uint8Array(size * size)
    for (let i = 0; i < size * size; i++) {
      const o = i * 4
      idx[i] = quant.indexOf(data[o], data[o + 1], data[o + 2])
    }
    indexed.push(idx)
    if (f % 4 === 0) await yieldToUi()
  }

  const bytes = assembleGif(indexed, size, palette, opts.delayMs, holdFrames)
  return new Blob([bytes], { type: 'image/gif' })
}
