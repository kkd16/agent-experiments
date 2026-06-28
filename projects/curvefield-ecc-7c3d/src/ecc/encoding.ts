// The serialization layer: how curve points, keys, and signatures become the
// strings and byte-strings you actually see in the wild — compressed SEC points,
// DER signatures, WIF private keys, Base58Check, Bech32/Bech32m, and the Bitcoin
// addresses built on top of them. None of this is new mathematics; it is the
// encoding glue that surrounds the math, and getting it exactly right (down to
// the checksum and the high-bit padding) is its own discipline. Every routine
// here is validated in the self-test against published vectors.

import { secp256k1, P, N, G, type EcdsaSig } from './secp256k1'
import { type Point } from './curve'
import { mod, modPow } from './field'
import { sha256, ripemd160AndSha256, bytesToHex, hexToBytes, bytesToBig, bigToBytes } from './sha256'

// ── SEC point encoding (compressed / uncompressed) ──────────────────────────

/** Compressed SEC1 encoding: 0x02/0x03 ‖ x (33 bytes). The parity byte records
 *  whether y is even (02) or odd (03), so x alone determines the point. */
export function pointCompress(Q: Point): Uint8Array {
  if (Q === null) return new Uint8Array([0x00])
  const prefix = Q.y % 2n === 0n ? 0x02 : 0x03
  const out = new Uint8Array(33)
  out[0] = prefix
  out.set(bigToBytes(Q.x, 32), 1)
  return out
}

/** Uncompressed SEC1 encoding: 0x04 ‖ x ‖ y (65 bytes). */
export function pointUncompress(Q: Point): Uint8Array {
  if (Q === null) return new Uint8Array([0x00])
  const out = new Uint8Array(65)
  out[0] = 0x04
  out.set(bigToBytes(Q.x, 32), 1)
  out.set(bigToBytes(Q.y, 32), 33)
  return out
}

/** Decode a SEC1 byte string (33-byte compressed or 65-byte uncompressed). For
 *  the compressed form we recover y from x by solving y² = x³ + 7 and picking
 *  the root with the requested parity — the decompression that keys rely on. */
export function pointDecode(b: Uint8Array): Point {
  if (b.length === 1 && b[0] === 0x00) return null
  if (b.length === 65 && b[0] === 0x04) {
    const x = bytesToBig(b.slice(1, 33))
    const y = bytesToBig(b.slice(33, 65))
    const pt = { x, y }
    if (!secp256k1.isOnCurve(pt)) throw new Error('point is not on secp256k1')
    return pt
  }
  if (b.length === 33 && (b[0] === 0x02 || b[0] === 0x03)) {
    const x = bytesToBig(b.slice(1, 33))
    if (x >= P) throw new Error('x out of field range')
    const rhs = mod(x * x * x + 7n, P)
    // p ≡ 3 (mod 4): the square root is rhs^((p+1)/4).
    let y = modPow(rhs, (P + 1n) / 4n, P)
    if (mod(y * y, P) !== rhs) throw new Error('x is not on the curve (no square root)')
    const wantOdd = b[0] === 0x03
    if ((y % 2n === 1n) !== wantOdd) y = P - y
    return { x, y }
  }
  throw new Error('not a valid SEC point encoding')
}

// ── DER signature encoding (strict) ─────────────────────────────────────────
// ECDSA signatures travel as ASN.1 DER: SEQUENCE { INTEGER r, INTEGER s }. The
// "strict" rules below are exactly what consensus-critical verifiers (e.g.
// Bitcoin's BIP-66) enforce — minimal-length integers, a leading 0x00 only when
// the high bit would otherwise read as negative, no trailing garbage.

function derInt(x: bigint): Uint8Array {
  let bytes = Array.from(bigToBytes(x, Math.max(1, Math.ceil(x.toString(16).length / 2))))
  // Drop superfluous leading zeros (but keep one if the next byte's top bit is set).
  while (bytes.length > 1 && bytes[0] === 0x00 && (bytes[1] & 0x80) === 0) bytes.shift()
  if (bytes[0] & 0x80) bytes = [0x00, ...bytes] // pad so it reads as positive
  return new Uint8Array([0x02, bytes.length, ...bytes])
}

/** Encode (r, s) as a strict DER SEQUENCE. */
export function derEncode(sig: EcdsaSig): Uint8Array {
  const r = derInt(sig.r)
  const s = derInt(sig.s)
  const body = new Uint8Array([...r, ...s])
  return new Uint8Array([0x30, body.length, ...body])
}

/** Parse a strict-DER signature, throwing on any non-canonical encoding. This
 *  doubles as a malleability check: a verifier that accepts only strict DER
 *  rejects the dozens of "valid but reshaped" encodings Wycheproof probes. */
export function derDecode(b: Uint8Array): EcdsaSig {
  let i = 0
  const need = (cond: boolean, msg: string) => {
    if (!cond) throw new Error('DER: ' + msg)
  }
  need(b[i++] === 0x30, 'expected SEQUENCE')
  const seqLen = b[i++]
  need(seqLen === b.length - 2, 'sequence length mismatch')
  const readInt = (): bigint => {
    need(b[i++] === 0x02, 'expected INTEGER')
    const len = b[i++]
    need(len > 0, 'zero-length integer')
    need(!(b[i] === 0x00 && (b[i + 1] & 0x80) === 0), 'non-minimal leading zero')
    need(!(b[i] & 0x80), 'negative integer')
    const v = bytesToBig(b.slice(i, i + len))
    i += len
    return v
  }
  const r = readInt()
  const s = readInt()
  need(i === b.length, 'trailing bytes after sequence')
  return { r, s }
}

// ── Base58 / Base58Check ─────────────────────────────────────────────────────

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

export function base58encode(b: Uint8Array): string {
  let n = bytesToBig(b)
  let out = ''
  while (n > 0n) {
    const r = Number(n % 58n)
    n /= 58n
    out = B58[r] + out
  }
  // Each leading zero byte becomes a leading '1'.
  for (const byte of b) {
    if (byte === 0) out = '1' + out
    else break
  }
  return out
}

export function base58decode(s: string): Uint8Array {
  let n = 0n
  for (const ch of s) {
    const v = B58.indexOf(ch)
    if (v < 0) throw new Error(`invalid base58 character '${ch}'`)
    n = n * 58n + BigInt(v)
  }
  const bytes: number[] = []
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn))
    n >>= 8n
  }
  for (const ch of s) {
    if (ch === '1') bytes.unshift(0)
    else break
  }
  return new Uint8Array(bytes)
}

/** Base58Check: payload ‖ first4(SHA256²(payload)), then base58. */
export function base58check(payload: Uint8Array): string {
  const checksum = sha256(sha256(payload)).slice(0, 4)
  return base58encode(new Uint8Array([...payload, ...checksum]))
}

/** Decode + verify a Base58Check string, returning the payload (sans checksum). */
export function base58checkDecode(s: string): Uint8Array {
  const raw = base58decode(s)
  if (raw.length < 5) throw new Error('too short for Base58Check')
  const payload = raw.slice(0, -4)
  const check = raw.slice(-4)
  const want = sha256(sha256(payload)).slice(0, 4)
  if (bytesToHex(check) !== bytesToHex(want)) throw new Error('bad Base58Check checksum')
  return payload
}

// ── WIF (Wallet Import Format) ───────────────────────────────────────────────

/** Encode a private scalar as mainnet WIF. `compressed` appends the 0x01 flag
 *  that tells wallets to derive the compressed public key. */
export function wifEncode(d: bigint, compressed = true): string {
  const body = compressed
    ? new Uint8Array([0x80, ...bigToBytes(d, 32), 0x01])
    : new Uint8Array([0x80, ...bigToBytes(d, 32)])
  return base58check(body)
}

export interface WifDecoded {
  d: bigint
  compressed: boolean
}

export function wifDecode(s: string): WifDecoded {
  const payload = base58checkDecode(s)
  if (payload[0] !== 0x80) throw new Error('not a mainnet WIF (wrong version byte)')
  if (payload.length === 34 && payload[33] === 0x01)
    return { d: bytesToBig(payload.slice(1, 33)), compressed: true }
  if (payload.length === 33) return { d: bytesToBig(payload.slice(1)), compressed: false }
  throw new Error('malformed WIF payload')
}

// ── Addresses ────────────────────────────────────────────────────────────────

/** HASH160 = RIPEMD160(SHA256(x)) — the 20-byte digest behind every Bitcoin
 *  address. The double hash buys collision resistance from SHA-256 and the
 *  shorter output from RIPEMD-160. */
export function hash160(x: Uint8Array): Uint8Array {
  return ripemd160AndSha256(x)
}

/** Legacy P2PKH address (version 0x00): base58check(0x00 ‖ HASH160(pubkey)). */
export function p2pkhAddress(pubkey: Uint8Array): string {
  return base58check(new Uint8Array([0x00, ...hash160(pubkey)]))
}

// ── Bech32 / Bech32m (BIP-173 / BIP-350) ─────────────────────────────────────

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const BECH32_CONST = 1
const BECH32M_CONST = 0x2bc830a3

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i]
  }
  return chk >>> 0
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = []
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5)
  out.push(0)
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31)
  return out
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0
  let bits = 0
  const out: number[] = []
  const maxv = (1 << to) - 1
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null
    acc = (acc << from) | value
    bits += from
    while (bits >= to) {
      bits -= to
      out.push((acc >> bits) & maxv)
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv)
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    return null
  }
  return out
}

function bech32Encode(hrp: string, data: number[], spec: number): string {
  const values = [...hrpExpand(hrp), ...data]
  const mod1 = polymod([...values, 0, 0, 0, 0, 0, 0]) ^ spec
  const checksum: number[] = []
  for (let i = 0; i < 6; i++) checksum.push((mod1 >> (5 * (5 - i))) & 31)
  let out = hrp + '1'
  for (const d of [...data, ...checksum]) out += CHARSET[d]
  return out
}

/** Encode a SegWit address (BIP-173 v0 → Bech32, BIP-350 v1+ → Bech32m). */
export function segwitAddress(hrp: string, witver: number, program: Uint8Array): string {
  const five = convertBits(Array.from(program), 8, 5, true)
  if (five === null) throw new Error('convertBits failed')
  const spec = witver === 0 ? BECH32_CONST : BECH32M_CONST
  return bech32Encode(hrp, [witver, ...five], spec)
}

/** Native-SegWit v0 P2WPKH address: bc1… over HASH160(compressed pubkey). */
export function p2wpkhAddress(pubkeyCompressed: Uint8Array, hrp = 'bc'): string {
  return segwitAddress(hrp, 0, hash160(pubkeyCompressed))
}

/** Taproot (BIP-341) v1 P2TR address: bc1p… over a 32-byte x-only output key. */
export function p2trAddress(outputKeyX: bigint, hrp = 'bc'): string {
  return segwitAddress(hrp, 1, bigToBytes(outputKeyX, 32))
}

// A small convenience for the page: derive everything from one private scalar.
export interface DerivedKey {
  d: bigint
  pubUncompressed: Uint8Array
  pubCompressed: Uint8Array
  wifCompressed: string
  wifUncompressed: string
  p2pkhCompressed: string
  p2pkhUncompressed: string
  p2wpkh: string
}

export function deriveAll(d: bigint): DerivedKey {
  const Q = secp256k1.multiply(d, G)
  const pubU = pointUncompress(Q)
  const pubC = pointCompress(Q)
  return {
    d,
    pubUncompressed: pubU,
    pubCompressed: pubC,
    wifCompressed: wifEncode(d, true),
    wifUncompressed: wifEncode(d, false),
    p2pkhCompressed: p2pkhAddress(pubC),
    p2pkhUncompressed: p2pkhAddress(pubU),
    p2wpkh: p2wpkhAddress(pubC),
  }
}

export { bytesToHex, hexToBytes, bytesToBig, bigToBytes, N }
