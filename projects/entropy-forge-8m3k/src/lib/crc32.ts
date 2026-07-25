// crc32.ts — the two integrity checksums real container formats carry.
//
// A compressed stream is worthless if a single flipped bit goes undetected, so
// gzip appends a CRC-32 of the *uncompressed* data and zlib appends an Adler-32.
// Both are computed here from scratch — the CRC by the standard reflected
// table-driven algorithm, Adler by its rolling modular sum. These are what make
// our containers *byte-exact* with the real tools: the checksum a genuine gzip
// writes over the same bytes is the checksum we write.

// ---- CRC-32 (IEEE 802.3, the gzip/PNG/zip variant) ----
//
// The polynomial is 0x04C11DB7; gzip processes bits least-significant-first, so
// the table is built from the *reflected* polynomial 0xEDB88320. The running
// value is pre- and post-conditioned by XOR with 0xFFFFFFFF (the "all-ones"
// initialisation and final inversion) — without that a leading run of zero bytes
// would be invisible.

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    t[n] = c >>> 0
  }
  return t
})()

/** Continue a CRC-32 over `data`, starting from a previous value (default fresh). */
export function crc32(data: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0
  for (let i = 0; i < data.length; i++) {
    c = (CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)) >>> 0
  }
  return (c ^ 0xffffffff) >>> 0
}

// ---- CRC-32/BZIP2 (the checksum bzip2 carries per block) ----
//
// Same polynomial (0x04C11DB7) as gzip's CRC, but bzip2 does NOT reflect: it
// feeds each byte in most-significant-bit-first, so the table is built from the
// *un-reflected* polynomial and the running value shifts left. Pre- and
// post-conditioned by XOR 0xFFFFFFFF exactly like the reflected variant. This is
// the checksum a genuine bzip2 writes over each block's original bytes — matching
// it bit-for-bit is what lets `bunzip2` accept the blocks we produce, and lets us
// validate the blocks it produces.

const CRC_TABLE_BZ: Uint32Array = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = (n << 24) >>> 0
    for (let k = 0; k < 8; k++) {
      c = c & 0x80000000 ? ((c << 1) ^ 0x04c11db7) >>> 0 : (c << 1) >>> 0
    }
    t[n] = c >>> 0
  }
  return t
})()

/** Continue a bzip2 CRC-32 over `data` from a previous *finalised* value. */
export function crc32Bzip2(data: Uint8Array, seed = 0): number {
  let c = (~seed) >>> 0
  for (let i = 0; i < data.length; i++) {
    c = ((c << 8) ^ CRC_TABLE_BZ[((c >>> 24) ^ data[i]) & 0xff]) >>> 0
  }
  return (~c) >>> 0
}

// ---- Adler-32 (RFC 1950, the zlib checksum) ----
//
// Two rolling sums modulo the largest prime below 2^16 (65521): `a` accumulates
// the bytes, `b` accumulates the running `a`. Cheaper than a CRC and the reason
// zlib streams (PNG's IDAT payload, HTTP `deflate`) carry it. We reduce lazily
// every NMAX bytes — the most iterations that cannot overflow a 32-bit `b`.

const ADLER_MOD = 65521
const ADLER_NMAX = 5552 // largest n with 255·n·(n+1)/2 + (n+1)(MOD-1) ≤ 2^32−1

export function adler32(data: Uint8Array, seed = 1): number {
  let a = seed & 0xffff
  let b = (seed >>> 16) & 0xffff
  let i = 0
  while (i < data.length) {
    let n = Math.min(ADLER_NMAX, data.length - i)
    while (n-- > 0) {
      a += data[i++]
      b += a
    }
    a %= ADLER_MOD
    b %= ADLER_MOD
  }
  return (((b << 16) | a) >>> 0)
}
