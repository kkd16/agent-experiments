// pfm.ts — (26.0) a from-scratch Portable FloatMap (`.pfm`) codec.
//
// 25.0 taught Lumen to read Radiance RGBE (`.hdr`), the lossy-but-compact format
// the HDRI marketplaces ship. This adds its lossless sibling — the **Portable
// FloatMap** — the format Mitsuba, HDRShop, `pfstools` and much of the graphics-
// research world use to move *exact* radiance between tools. Where RGBE quantises
// to a shared 8-bit exponent, a PFM stores raw IEEE-754 **float32** per channel,
// so a decode→encode is bit-for-bit — a stronger correctness statement than RGBE
// can make, and the reason it's the interchange format for ground-truth imagery.
//
// The format is deliberately tiny: a three-line ASCII header — `PF` (colour) or
// `Pf` (greyscale), then `width height`, then a `scale` whose SIGN is the byte
// order (negative = little-endian, positive = big-endian) and whose magnitude is a
// multiplier — followed by raw float32 scanlines stored **bottom-to-top** (the
// OpenGL convention). This reader/writer handles colour and greyscale, both byte
// orders, and flips rows to Lumen's row-0-is-the-zenith convention. Paired with an
// encoder so the verification suite round-trips it and the studio can export the
// rendered frame as a lossless `.pfm`.
//
// Reference: Ward's PFM note; the `pfstools` / Mitsuba readers.

import type { HdrImage } from './hdr'

// Read the next whitespace-delimited ASCII token from `bytes` starting at `pos`,
// returning the token and the index just past it. Throws at EOF.
function readToken(bytes: Uint8Array, pos: number): { token: string; next: number } {
  let p = pos
  // Skip leading whitespace (space, tab, CR, LF).
  while (p < bytes.length && (bytes[p] === 0x20 || bytes[p] === 0x09 || bytes[p] === 0x0d || bytes[p] === 0x0a)) p++
  if (p >= bytes.length) throw new Error('unexpected end of PFM header')
  let s = ''
  while (p < bytes.length && bytes[p] !== 0x20 && bytes[p] !== 0x09 && bytes[p] !== 0x0d && bytes[p] !== 0x0a) {
    s += String.fromCharCode(bytes[p])
    p++
  }
  return { token: s, next: p }
}

// Decode a `.pfm` byte buffer to a linear-radiance `HdrImage` (row 0 = top).
// Throws a descriptive Error on malformed input so the UI surfaces a clean message.
export function decodePfm(bytes: Uint8Array): HdrImage {
  const magic = readToken(bytes, 0)
  const color = magic.token === 'PF'
  if (!color && magic.token !== 'Pf') throw new Error(`not a PFM file (magic "${magic.token}", expected PF/Pf)`)
  const channels = color ? 3 : 1

  const wTok = readToken(bytes, magic.next)
  const hTok = readToken(bytes, wTok.next)
  const sTok = readToken(bytes, hTok.next)
  const width = parseInt(wTok.token, 10)
  const height = parseInt(hTok.token, 10)
  const scale = parseFloat(sTok.token)
  if (!(width > 0) || !(height > 0)) throw new Error(`bad PFM dimensions "${wTok.token}×${hTok.token}"`)
  if (!isFinite(scale) || scale === 0) throw new Error(`bad PFM scale "${sTok.token}"`)
  if (width * height > 64_000_000) throw new Error(`PFM too large (${width}×${height})`)

  const littleEndian = scale < 0
  const mult = Math.abs(scale) === 1 ? 1 : Math.abs(scale)

  // Exactly one whitespace byte separates the scale line from the binary payload.
  const dataStart = sTok.next + 1
  const need = width * height * channels * 4
  if (dataStart + need > bytes.length) throw new Error('PFM payload truncated')

  const view = new DataView(bytes.buffer, bytes.byteOffset + dataStart, need)
  const pixels = new Float32Array(width * height * 3)
  let o = 0
  // File scanlines run bottom-to-top; map file row r to image row (H-1-r).
  for (let r = 0; r < height; r++) {
    const destRow = height - 1 - r
    for (let x = 0; x < width; x++) {
      const dst = (destRow * width + x) * 3
      if (color) {
        const rr = view.getFloat32(o, littleEndian) * mult
        const gg = view.getFloat32(o + 4, littleEndian) * mult
        const bb = view.getFloat32(o + 8, littleEndian) * mult
        o += 12
        pixels[dst] = rr
        pixels[dst + 1] = gg
        pixels[dst + 2] = bb
      } else {
        const g = view.getFloat32(o, littleEndian) * mult
        o += 4
        pixels[dst] = g
        pixels[dst + 1] = g
        pixels[dst + 2] = g
      }
    }
  }
  return { width, height, pixels }
}

// Encode a linear-radiance image to a colour `.pfm` byte buffer. `littleEndian`
// (default) writes `scale = −1.0`; big-endian writes `+1.0`. Row 0 is treated as
// the top of the image and written last (the format is bottom-to-top). Exact
// inverse of `decodePfm` — the round-trip is bit-for-bit float32.
export function encodePfm(pixels: Float32Array, width: number, height: number, littleEndian = true): Uint8Array {
  const header = `PF\n${width} ${height}\n${littleEndian ? '-1.0' : '1.0'}\n`
  const head = new TextEncoder().encode(header)
  const body = new Uint8Array(width * height * 3 * 4)
  const view = new DataView(body.buffer)
  let o = 0
  for (let r = 0; r < height; r++) {
    // File row r is the image's bottom-up row: image row (H-1-r).
    const srcRow = height - 1 - r
    for (let x = 0; x < width; x++) {
      const src = (srcRow * width + x) * 3
      view.setFloat32(o, pixels[src], littleEndian)
      view.setFloat32(o + 4, pixels[src + 1], littleEndian)
      view.setFloat32(o + 8, pixels[src + 2], littleEndian)
      o += 12
    }
  }
  const out = new Uint8Array(head.length + body.length)
  out.set(head, 0)
  out.set(body, head.length)
  return out
}

// Sniff a file's format from its leading bytes: Radiance `.hdr` opens with the
// `#?` magic, a PFM with `PF`/`Pf`. Returns 'hdr', 'pfm', or null (unknown).
export function sniffHdrFormat(bytes: Uint8Array): 'hdr' | 'pfm' | null {
  if (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x3f) return 'hdr' // "#?"
  if (bytes.length >= 2 && bytes[0] === 0x50 && (bytes[1] === 0x46 || bytes[1] === 0x66)) return 'pfm' // "PF"/"Pf"
  return null
}
