// gzip.ts — the byte-exact container formats that wrap a DEFLATE stream.
//
// DEFLATE alone is headless: it carries no length, no checksum, no filename. The
// two ubiquitous wrappers add exactly that. **gzip** (RFC 1952 — the `.gz` file,
// HTTP `Content-Encoding: gzip`) prepends a 10-byte header with a magic number
// and modification time and appends a CRC-32 + the input size mod 2^32. **zlib**
// (RFC 1950 — PNG's IDAT, HTTP `deflate`) is leaner: a 2-byte header and a
// trailing Adler-32. Building both from scratch — and verifying the checksum on
// the way in — is what makes our `.gz` open in any archiver and any archiver's
// `.gz` open here.

import { deflate, inflate, type Strategy } from './deflate.ts'
import { crc32, adler32 } from './crc32.ts'

function u32le(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
}
function u32be(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
}
function readU32le(d: Uint8Array, o: number): number {
  return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0
}
function concat(parts: (Uint8Array | number[])[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p instanceof Uint8Array ? p : Uint8Array.from(p), o)
    o += p.length
  }
  return out
}

// ---- gzip (RFC 1952) ----
export const GZIP_FLAGS = { FTEXT: 1, FHCRC: 2, FEXTRA: 4, FNAME: 8, FCOMMENT: 16 }

export interface GzipOptions {
  strategy?: Strategy
  filename?: string
  mtime?: number // seconds since the epoch
  os?: number // 255 = unknown, 3 = Unix, 0 = FAT
}

export interface GzipField {
  name: string
  offset: number
  bytes: number
  value: string
}

export function gzipEncode(data: Uint8Array, opts: GzipOptions = {}): Uint8Array {
  const flg = opts.filename ? GZIP_FLAGS.FNAME : 0
  const mtime = opts.mtime ?? 0
  const os = opts.os ?? 255
  const header = [0x1f, 0x8b, 0x08, flg, ...u32le(mtime), 0x00, os]
  if (opts.filename) {
    for (const b of new TextEncoder().encode(opts.filename)) header.push(b)
    header.push(0) // NUL-terminated
  }
  const body = deflate(data, { strategy: opts.strategy ?? 'auto' }).bytes
  const trailer = [...u32le(crc32(data)), ...u32le(data.length >>> 0)]
  return concat([header, body, trailer])
}

export interface GzipDecodeResult {
  data: Uint8Array
  filename?: string
  mtime: number
  os: number
  crcOk: boolean
  sizeOk: boolean
  fields: GzipField[] // annotated header/trailer fields for the hex viewer
}

export function gzipDecode(input: Uint8Array): GzipDecodeResult {
  if (input.length < 18) throw new Error('too short to be a gzip stream')
  if (input[0] !== 0x1f || input[1] !== 0x8b) throw new Error('bad gzip magic (expected 1f 8b)')
  if (input[2] !== 0x08) throw new Error(`unsupported compression method ${input[2]}`)
  const flg = input[3]
  const mtime = readU32le(input, 4)
  const os = input[9]
  const fields: GzipField[] = [
    { name: 'ID1·ID2 (magic)', offset: 0, bytes: 2, value: '1f 8b' },
    { name: 'CM (method)', offset: 2, bytes: 1, value: '8 = deflate' },
    { name: 'FLG (flags)', offset: 3, bytes: 1, value: `0x${flg.toString(16).padStart(2, '0')}` },
    { name: 'MTIME', offset: 4, bytes: 4, value: mtime === 0 ? '0 (none)' : String(mtime) },
    { name: 'XFL', offset: 8, bytes: 1, value: String(input[8]) },
    { name: 'OS', offset: 9, bytes: 1, value: String(os) },
  ]
  let off = 10
  let filename: string | undefined
  if (flg & GZIP_FLAGS.FEXTRA) {
    const xlen = input[off] | (input[off + 1] << 8)
    fields.push({ name: 'FEXTRA', offset: off, bytes: 2 + xlen, value: `${xlen} bytes` })
    off += 2 + xlen
  }
  if (flg & GZIP_FLAGS.FNAME) {
    const start = off
    let s = ''
    while (input[off] !== 0 && off < input.length) s += String.fromCharCode(input[off++])
    off++ // skip NUL
    filename = s
    fields.push({ name: 'FNAME', offset: start, bytes: off - start, value: s })
  }
  if (flg & GZIP_FLAGS.FCOMMENT) {
    const start = off
    while (input[off] !== 0 && off < input.length) off++
    off++
    fields.push({ name: 'FCOMMENT', offset: start, bytes: off - start, value: '(comment)' })
  }
  if (flg & GZIP_FLAGS.FHCRC) {
    fields.push({ name: 'FHCRC', offset: off, bytes: 2, value: 'header CRC16' })
    off += 2
  }
  const data = inflate(input, off)
  const crcStored = readU32le(input, input.length - 8)
  const sizeStored = readU32le(input, input.length - 4)
  const crcOk = crc32(data) === crcStored
  const sizeOk = (data.length >>> 0) === sizeStored
  fields.push({
    name: 'CRC32',
    offset: input.length - 8,
    bytes: 4,
    value: `0x${crcStored.toString(16).padStart(8, '0')}${crcOk ? ' ✓' : ' ✗'}`,
  })
  fields.push({
    name: 'ISIZE',
    offset: input.length - 4,
    bytes: 4,
    value: `${sizeStored}${sizeOk ? ' ✓' : ' ✗'}`,
  })
  return { data, filename, mtime, os, crcOk, sizeOk, fields }
}

// ---- zlib (RFC 1950) ----
export function zlibEncode(data: Uint8Array, opts: { strategy?: Strategy } = {}): Uint8Array {
  // CMF: CM=8 (deflate), CINFO=7 (32 KB window) → 0x78. FLG chosen so the 16-bit
  // header is a multiple of 31 (the RFC's integrity check) with no preset dict.
  const cmf = 0x78
  let flg = 0 // FLEVEL=0, FDICT=0
  const rem = (cmf * 256 + flg) % 31
  if (rem !== 0) flg += 31 - rem
  const body = deflate(data, { strategy: opts.strategy ?? 'auto' }).bytes
  return concat([[cmf, flg], body, u32be(adler32(data))]) // zlib's Adler-32 is big-endian
}

export function zlibDecode(input: Uint8Array): { data: Uint8Array; adlerOk: boolean } {
  if (input.length < 6) throw new Error('too short to be a zlib stream')
  const cmf = input[0]
  const flg = input[1]
  if ((cmf & 0x0f) !== 8) throw new Error('zlib: not a deflate stream')
  if ((cmf * 256 + flg) % 31 !== 0) throw new Error('zlib: header check (mod 31) failed')
  if (flg & 0x20) throw new Error('zlib: preset dictionaries are not supported')
  const data = inflate(input, 2)
  // The Adler-32 trailer is stored big-endian, unlike gzip's little-endian fields.
  const be =
    ((input[input.length - 4] << 24) |
      (input[input.length - 3] << 16) |
      (input[input.length - 2] << 8) |
      input[input.length - 1]) >>>
    0
  return { data, adlerOk: adler32(data) === be }
}
