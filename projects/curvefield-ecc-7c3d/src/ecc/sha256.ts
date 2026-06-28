// A from-scratch, synchronous SHA-256 + HMAC-SHA256, on Uint32 arithmetic.
//
// Why not crypto.subtle? It is async and unavailable in some sandboxed contexts
// (the catalog renders thumbnails with no same-origin guarantees). A pure,
// synchronous implementation keeps the signing labs deterministic and testable
// against the published NIST/RFC vectors, with no environment dependencies.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

/** SHA-256 of a byte array, returning 32 bytes. */
export function sha256(msg: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])

  // Pad: append 0x80, then zeros, then the 64-bit big-endian bit length.
  const bitLen = msg.length * 8
  const withOne = msg.length + 1
  const total = withOne + ((56 - (withOne % 64) + 64) % 64) + 8
  const data = new Uint8Array(total)
  data.set(msg)
  data[msg.length] = 0x80
  // 64-bit length; messages here fit in 32 bits, so the high word stays 0.
  const dv = new DataView(data.buffer)
  dv.setUint32(total - 4, bitLen >>> 0, false)
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false)

  const w = new Uint32Array(64)
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }

    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      hh = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    h[0] = (h[0] + a) | 0
    h[1] = (h[1] + b) | 0
    h[2] = (h[2] + c) | 0
    h[3] = (h[3] + d) | 0
    h[4] = (h[4] + e) | 0
    h[5] = (h[5] + f) | 0
    h[6] = (h[6] + g) | 0
    h[7] = (h[7] + hh) | 0
  }

  const out = new Uint8Array(32)
  const odv = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i], false)
  return out
}

/** HMAC-SHA256(key, msg) → 32 bytes (RFC 2104). */
export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const block = 64
  let k = key
  if (k.length > block) k = sha256(k)
  const kPad = new Uint8Array(block)
  kPad.set(k)

  const ipad = new Uint8Array(block)
  const opad = new Uint8Array(block)
  for (let i = 0; i < block; i++) {
    ipad[i] = kPad[i] ^ 0x36
    opad[i] = kPad[i] ^ 0x5c
  }
  const inner = sha256(concat(ipad, msg))
  return sha256(concat(opad, inner))
}

// ── byte / hex / bigint helpers shared by the signing labs ──────────────────

export function concat(...arrs: Uint8Array[]): Uint8Array {
  const len = arrs.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(len)
  let off = 0
  for (const a of arrs) {
    out.set(a, off)
    off += a.length
  }
  return out
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

export function bytesToHex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '')
  if (clean.length % 2 !== 0) throw new Error('hex string must have even length')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToBig(b: Uint8Array): bigint {
  let n = 0n
  for (const x of b) n = (n << 8n) | BigInt(x)
  return n
}

/** Big-endian fixed-width encoding of n into `len` bytes. */
export function bigToBytes(n: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len)
  let v = n
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}
