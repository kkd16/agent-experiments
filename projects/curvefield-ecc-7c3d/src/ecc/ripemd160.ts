// RIPEMD-160 from scratch, on Uint32 arithmetic.
//
// Bitcoin hashes a public key with SHA-256 then RIPEMD-160 ("HASH160") to make
// the 20-byte payload of a legacy or SegWit address. crypto.subtle never offered
// RIPEMD-160, so an address lab has no choice but to implement it — which is also
// the honest thing to do in a from-scratch crypto lab. Validated in the self-test
// against the canonical "" and "abc" digests from the RIPEMD-160 reference.

const rotl = (x: number, n: number): number => ((x << n) | (x >>> (32 - n))) >>> 0

// Message-word selection for the left and right lines.
const ZL = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
  3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
  1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
  4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13,
]
const ZR = [
  5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
  6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
  15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
  8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
  12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11,
]
// Per-round rotate amounts.
const SL = [
  11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
  7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
  11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
  11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
  9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6,
]
const SR = [
  8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
  9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
  9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
  15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
  8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11,
]
// Round constants for the left and right lines.
const KL = [0x00000000, 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xa953fd4e]
const KR = [0x50a28be6, 0x5c4dd124, 0x6d703ef3, 0x7a6d76e9, 0x00000000]

// Boolean functions, selected by round.
function f(j: number, x: number, y: number, z: number): number {
  if (j < 16) return x ^ y ^ z
  if (j < 32) return (x & y) | (~x & z)
  if (j < 48) return (x | ~y) ^ z
  if (j < 64) return (x & z) | (y & ~z)
  return x ^ (y | ~z)
}

/** RIPEMD-160 of a byte array, returning 20 bytes. */
export function ripemd160(msg: Uint8Array): Uint8Array {
  // Pad: 0x80, zeros, then the 64-bit little-endian bit length.
  const bitLen = msg.length * 8
  const withOne = msg.length + 1
  const total = withOne + ((56 - (withOne % 64) + 64) % 64) + 8
  const data = new Uint8Array(total)
  data.set(msg)
  data[msg.length] = 0x80
  const dv = new DataView(data.buffer)
  dv.setUint32(total - 8, bitLen >>> 0, true)
  dv.setUint32(total - 4, Math.floor(bitLen / 0x100000000), true)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0

  const X = new Uint32Array(16)
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) X[i] = dv.getUint32(off + i * 4, true)

    let al = h0, bl = h1, cl = h2, dl = h3, el = h4
    let ar = h0, br = h1, cr = h2, dr = h3, er = h4

    for (let j = 0; j < 80; j++) {
      const round = Math.floor(j / 16)
      let t = (al + f(j, bl, cl, dl) + X[ZL[j]] + KL[round]) | 0
      t = (rotl(t >>> 0, SL[j]) + el) | 0
      al = el; el = dl; dl = rotl(cl, 10); cl = bl; bl = t

      t = (ar + f(79 - j, br, cr, dr) + X[ZR[j]] + KR[round]) | 0
      t = (rotl(t >>> 0, SR[j]) + er) | 0
      ar = er; er = dr; dr = rotl(cr, 10); cr = br; br = t
    }

    const t = (h1 + cl + dr) | 0
    h1 = (h2 + dl + er) | 0
    h2 = (h3 + el + ar) | 0
    h3 = (h4 + al + br) | 0
    h4 = (h0 + bl + cr) | 0
    h0 = t
  }

  const out = new Uint8Array(20)
  const odv = new DataView(out.buffer)
  odv.setUint32(0, h0 >>> 0, true)
  odv.setUint32(4, h1 >>> 0, true)
  odv.setUint32(8, h2 >>> 0, true)
  odv.setUint32(12, h3 >>> 0, true)
  odv.setUint32(16, h4 >>> 0, true)
  return out
}
