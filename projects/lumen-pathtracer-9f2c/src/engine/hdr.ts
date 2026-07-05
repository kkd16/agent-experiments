// hdr.ts — (25.0) a from-scratch Radiance RGBE (`.hdr`/`.pic`) codec.
//
// For four versions Lumen's image-based lighting (21.0) has been *real* — a
// luminance×sinθ importance distribution over an equirectangular panorama, MIS-
// paired with BSDF sampling — but the panoramas themselves were procedural: three
// baked presets with no way to bring your own. This module closes that gap. It
// decodes the file format the whole HDRI ecosystem ships in — Greg Ward's
// Radiance RGBE — so any panorama from Poly Haven, HDRI-Haven, Blender or a
// spherical-camera capture can be dropped onto the viewport and *lights the
// scene*, importance-sampled exactly like the built-in maps.
//
// RGBE packs a floating-point RGB triple into four bytes: a shared 8-bit exponent
// E and three 8-bit mantissas, decoded as `channel · 2^(E−136)`. Eight mantissa
// bits give ~0.4 % relative precision across the format's full ~76-decade range —
// the reason it became the interchange standard. Scanlines are stored either flat
// or (the near-universal case for real files) new-style **run-length encoded**,
// one RLE stream per channel. This is a complete, spec-faithful reader for both,
// plus an *encoder* — so the same code round-trips in the verification suite (the
// only honest proof a decoder is correct) and powers a **true-HDR export** of the
// rendered frame (save physical radiance, not just a tone-mapped PNG).
//
// References: Ward, "Real Pixels" (Graphics Gems II, 1991); the `rgbe.c` reference
// reader/writer; the Radiance `.hdr` file-format note.

// An in-memory decoded panorama: interleaved linear-radiance [r,g,b], row-major,
// **row 0 = the top of the image** (the zenith, matching envmap.ts's convention).
export interface HdrImage {
  width: number
  height: number
  pixels: Float32Array
}

// ---- RGBE ↔ float -----------------------------------------------------------

// frexp: split v into a mantissa m∈[0.5,1) and exponent e with v = m·2^e. Used by
// the encoder to choose the shared exponent (the max channel drives it).
function frexp(value: number): { m: number; e: number } {
  if (value === 0 || !isFinite(value)) return { m: value, e: 0 }
  const abs = Math.abs(value)
  let e = Math.ceil(Math.log2(abs))
  let m = abs / 2 ** e
  // Guard the two rounding boundaries so m lands strictly in [0.5,1).
  if (m >= 1) {
    m *= 0.5
    e += 1
  } else if (m < 0.5) {
    m *= 2
    e -= 1
  }
  return { m: Math.sign(value) * m, e }
}

// Pack a linear RGB triple into RGBE (four bytes written into `out` at `o`). The
// shared exponent comes from the largest channel; a triple below ~1e-32 encodes
// as all-zero (the format's signal for black). Inverse of `rgbeToFloat`.
export function floatToRgbe(r: number, g: number, b: number, out: Uint8Array, o: number): void {
  const v = Math.max(r, g, b)
  if (v < 1e-32) {
    out[o] = 0
    out[o + 1] = 0
    out[o + 2] = 0
    out[o + 3] = 0
    return
  }
  const { e } = frexp(v)
  // s = 2^(8−e): scales the max channel to ~[128,256) so its mantissa fills the
  // byte. r ≤ v ⇒ r·s ≤ 256, clamped to 255.
  const s = 2 ** (8 - e)
  out[o] = Math.min(255, Math.max(0, Math.floor(r * s)))
  out[o + 1] = Math.min(255, Math.max(0, Math.floor(g * s)))
  out[o + 2] = Math.min(255, Math.max(0, Math.floor(b * s)))
  out[o + 3] = Math.min(255, Math.max(0, e + 128))
}

// Decode one RGBE quadruple to linear float, writing r,g,b into `out` at `o3`.
// E = 0 is black; otherwise channel·2^(E−128−8). The −8 folds in the mantissa's
// implicit /256 scaling so `floatToRgbe`∘`rgbeToFloat` is the identity to within
// the 8-bit mantissa quantisation.
function rgbeToFloat(R: number, G: number, B: number, E: number, out: Float32Array, o3: number): void {
  if (E === 0) {
    out[o3] = 0
    out[o3 + 1] = 0
    out[o3 + 2] = 0
    return
  }
  const f = 2 ** (E - 136)
  out[o3] = R * f
  out[o3 + 1] = G * f
  out[o3 + 2] = B * f
}

// ---- decode -----------------------------------------------------------------

// CIE XYZ → linear sRGB (D65). Used only for the rare `32-bit_rle_xyze` variant;
// negatives (out-of-gamut) are clamped to zero.
function xyzToRgb(X: number, Y: number, Z: number): [number, number, number] {
  const r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z
  const g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z
  const b = 0.0557 * X - 0.204 * Y + 1.057 * Z
  return [Math.max(0, r), Math.max(0, g), Math.max(0, b)]
}

// Old-format scanline: pixels read one RGBE quad at a time, with an (R,G,B)=(1,1,1)
// quad signalling "repeat the previous pixel E<<shift times" (shift grows by 8 on
// each consecutive run marker, so runs longer than 255 chain). Returns the new
// read position.
function decodeOldScanline(bytes: Uint8Array, p: number, width: number, out: Uint8Array): number {
  let x = 0
  let shift = 0
  let pr = 0
  let pg = 0
  let pb = 0
  let pe = 0
  while (x < width) {
    if (p + 4 > bytes.length) throw new Error('unexpected EOF in scanline')
    const R = bytes[p++]
    const G = bytes[p++]
    const B = bytes[p++]
    const E = bytes[p++]
    if (R === 1 && G === 1 && B === 1) {
      let count = E << shift
      while (count-- > 0 && x < width) {
        const o = x * 4
        out[o] = pr
        out[o + 1] = pg
        out[o + 2] = pb
        out[o + 3] = pe
        x++
      }
      shift += 8
    } else {
      const o = x * 4
      out[o] = R
      out[o + 1] = G
      out[o + 2] = B
      out[o + 3] = E
      pr = R
      pg = G
      pb = B
      pe = E
      x++
      shift = 0
    }
  }
  return p
}

// Decode a single scanline into `out` (width×4 RGBE bytes). Auto-detects the
// new-style RLE header [2,2,widthHi,widthLo]; anything else (including too-narrow
// or too-wide scanlines the RLE format forbids) falls back to the old format.
function decodeScanline(bytes: Uint8Array, p: number, width: number, out: Uint8Array): number {
  if (width < 8 || width > 0x7fff) return decodeOldScanline(bytes, p, width, out)
  if (p + 4 > bytes.length) throw new Error('unexpected EOF at scanline header')
  const b0 = bytes[p]
  const b1 = bytes[p + 1]
  const b2 = bytes[p + 2]
  const b3 = bytes[p + 3]
  if (b0 !== 2 || b1 !== 2 || ((b2 << 8) | b3) !== width) return decodeOldScanline(bytes, p, width, out)
  p += 4
  // Four independent RLE streams (all R, then all G, then all B, then all E).
  for (let c = 0; c < 4; c++) {
    let x = 0
    while (x < width) {
      if (p >= bytes.length) throw new Error('unexpected EOF in RLE stream')
      let count = bytes[p++]
      if (count > 128) {
        // A run: (count−128) copies of the next byte.
        count -= 128
        const val = bytes[p++]
        if (x + count > width) throw new Error('RLE run overruns scanline')
        while (count-- > 0) out[x++ * 4 + c] = val
      } else {
        // A literal segment: `count` bytes copied verbatim.
        if (x + count > width) throw new Error('RLE literal overruns scanline')
        while (count-- > 0) out[x++ * 4 + c] = bytes[p++]
      }
    }
  }
  return p
}

// Decode a Radiance `.hdr` byte buffer to a linear-radiance `HdrImage`. Throws a
// descriptive Error on any malformed input (so the UI can surface a clean message
// instead of a silent black render).
export function decodeHdr(bytes: Uint8Array): HdrImage {
  let pos = 0
  const readLine = (): string => {
    let s = ''
    while (pos < bytes.length) {
      const c = bytes[pos++]
      if (c === 0x0a) break
      // A stray CR (CRLF files) is dropped; the header is otherwise ASCII.
      if (c !== 0x0d) s += String.fromCharCode(c)
    }
    return s
  }

  const magic = readLine()
  if (!magic.startsWith('#?')) throw new Error('not a Radiance HDR file (missing "#?" magic)')

  let format = ''
  let exposure = 1
  for (;;) {
    if (pos >= bytes.length) throw new Error('unexpected end of header')
    const line = readLine()
    if (line === '') break // the blank line terminates the header
    if (line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim().toUpperCase()
    const val = line.slice(eq + 1).trim()
    if (key === 'FORMAT') format = val
    else if (key === 'EXPOSURE') {
      const e = parseFloat(val)
      if (isFinite(e) && e !== 0) exposure *= e // EXPOSURE lines multiply
    }
  }
  const isXyze = /xyze/i.test(format)
  if (format && !/rgbe/i.test(format) && !isXyze) throw new Error(`unsupported HDR format: "${format}"`)

  // Resolution line, e.g. "-Y 512 +X 1024". The standard writer always emits Y
  // (the scanline-stacking axis) first and X (the within-scanline axis) second.
  const resLine = readLine()
  const m = resLine.match(/([+-])Y\s+(\d+)\s+([+-])X\s+(\d+)/)
  if (!m) throw new Error(`unsupported resolution line: "${resLine}" (expected "±Y h ±X w")`)
  const flipY = m[1] === '+' // "+Y" ⇒ first scanline is the bottom row
  const height = parseInt(m[2], 10)
  const flipX = m[3] === '-' // "-X" ⇒ pixels run right-to-left
  const width = parseInt(m[4], 10)
  if (width <= 0 || height <= 0 || width * height > 64_000_000) throw new Error(`bad HDR dimensions ${width}×${height}`)

  const pixels = new Float32Array(width * height * 3)
  const scan = new Uint8Array(width * 4)
  const invExp = exposure !== 0 ? 1 / exposure : 1
  for (let sy = 0; sy < height; sy++) {
    pos = decodeScanline(bytes, pos, width, scan)
    const destRow = flipY ? height - 1 - sy : sy
    for (let sx = 0; sx < width; sx++) {
      const destCol = flipX ? width - 1 - sx : sx
      const o3 = (destRow * width + destCol) * 3
      const R = scan[sx * 4]
      const G = scan[sx * 4 + 1]
      const B = scan[sx * 4 + 2]
      const E = scan[sx * 4 + 3]
      rgbeToFloat(R, G, B, E, pixels, o3)
      if (E !== 0) {
        pixels[o3] *= invExp
        pixels[o3 + 1] *= invExp
        pixels[o3 + 2] *= invExp
        if (isXyze) {
          const [r, g, b] = xyzToRgb(pixels[o3], pixels[o3 + 1], pixels[o3 + 2])
          pixels[o3] = r
          pixels[o3 + 1] = g
          pixels[o3 + 2] = b
        }
      }
    }
  }
  return { width, height, pixels }
}

// ---- encode -----------------------------------------------------------------

// Run-length encode one channel of a scanline (Radiance's per-channel scheme):
// literal segments carry a count byte in [1,128] then that many verbatim bytes; a
// run of ≥4 identical bytes is emitted as (128+n),value with n∈[1,127]. This is
// the exact inverse the decoder above expects.
function rleEncodeChannel(ch: Uint8Array, out: number[]): void {
  const W = ch.length
  let i = 0
  while (i < W) {
    // Extend a literal segment until a run of ≥4 equal bytes begins.
    let litEnd = i
    while (litEnd < W) {
      let r = litEnd
      while (r < W && ch[r] === ch[litEnd]) r++
      if (r - litEnd >= 4) break
      litEnd = r
    }
    let x = i
    while (x < litEnd) {
      const n = Math.min(128, litEnd - x)
      out.push(n)
      for (let k = 0; k < n; k++) out.push(ch[x + k])
      x += n
    }
    i = litEnd
    if (i < W) {
      const val = ch[i]
      let r = i
      while (r < W && ch[r] === val) r++
      let len = r - i
      while (len > 0) {
        const n = Math.min(127, len)
        out.push(128 + n)
        out.push(val)
        len -= n
      }
      i = r
    }
  }
}

// Encode a linear-radiance image to a Radiance `.hdr` byte buffer. `rle` (default)
// writes new-style per-channel RLE scanlines when the width is in [8,32767];
// narrower/wider images (and `rle:false`) write flat scanlines. Row 0 is treated
// as the top of the image and written first ("-Y h +X w").
export function encodeHdr(pixels: Float32Array, width: number, height: number, rle = true): Uint8Array {
  const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`
  const body: number[] = []
  const useRle = rle && width >= 8 && width <= 0x7fff
  const scan = new Uint8Array(width * 4)
  const channels: [Uint8Array, Uint8Array, Uint8Array, Uint8Array] = [
    new Uint8Array(width),
    new Uint8Array(width),
    new Uint8Array(width),
    new Uint8Array(width),
  ]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o3 = (y * width + x) * 3
      floatToRgbe(pixels[o3], pixels[o3 + 1], pixels[o3 + 2], scan, x * 4)
    }
    if (useRle) {
      body.push(2, 2, (width >> 8) & 0xff, width & 0xff)
      for (let c = 0; c < 4; c++) {
        const ch = channels[c]
        for (let x = 0; x < width; x++) ch[x] = scan[x * 4 + c]
        rleEncodeChannel(ch, body)
      }
    } else {
      for (let x = 0; x < width * 4; x++) body.push(scan[x])
    }
  }
  const head = new TextEncoder().encode(header)
  const out = new Uint8Array(head.length + body.length)
  out.set(head, 0)
  out.set(body, head.length)
  return out
}

// ---- solid-angle-correct box downsample -------------------------------------

// Box-average an equirectangular panorama down to at most `maxWidth` columns
// (halving the sampler's build cost and the postMessage payload for the 2K–8K
// maps real HDRIs ship at). Each output texel averages a contiguous block of
// source texels; because neighbouring rows share almost the same sinθ, the
// sin-weighted mean radiance (the map's total irradiance) is preserved to well
// under a percent — verified in the self-tests.
export function downsampleEquirect(img: HdrImage, maxWidth: number): HdrImage {
  const { width: W, height: H, pixels: src } = img
  if (W <= maxWidth) return img
  const factor = Math.ceil(W / maxWidth)
  const nW = Math.max(1, Math.round(W / factor))
  const nH = Math.max(1, Math.round(H / factor))
  const out = new Float32Array(nW * nH * 3)
  for (let y = 0; y < nH; y++) {
    const y0 = Math.floor((y * H) / nH)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * H) / nH))
    for (let x = 0; x < nW; x++) {
      const x0 = Math.floor((x * W) / nW)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * W) / nW))
      let r = 0
      let g = 0
      let b = 0
      let c = 0
      for (let j = y0; j < y1; j++) {
        for (let i = x0; i < x1; i++) {
          const o = (j * W + i) * 3
          r += src[o]
          g += src[o + 1]
          b += src[o + 2]
          c++
        }
      }
      const o = (y * nW + x) * 3
      out[o] = r / c
      out[o + 1] = g / c
      out[o + 2] = b / c
    }
  }
  return { width: nW, height: nH, pixels: out }
}
