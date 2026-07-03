// deflateTables.ts — the fixed constants of RFC 1951 (the DEFLATE spec).
//
// DEFLATE never sends a raw (length, distance); it maps each onto a small *code*
// plus a handful of "extra" literal bits. A length 3..258 becomes one of 29 codes
// (257..285), a distance 1..32768 one of 30 codes (0..29), each with a base value
// and an extra-bit count taken straight from §3.2.5. These tables — and the fixed
// Huffman lengths of §3.2.6 — are the parts of the format that are simply *given*.
// Everything else (the LZ parse, the dynamic Huffman codes) we compute.

// ---- match-length codes 257..285 ----
// Base length and number of extra bits for each length code. Index 0 == code 257.
export const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
]
export const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]

// ---- distance codes 0..29 ----
export const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
]
export const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]

export const MIN_MATCH = 3
export const MAX_MATCH = 258
export const WINDOW_SIZE = 32768 // 2^15, DEFLATE's maximum back-reference distance
export const END_OF_BLOCK = 256
export const NUM_LL = 286 // 0..255 literals, 256 EOB, 257..285 length codes
export const NUM_DIST = 30

// The 19-symbol "code-length" alphabet used to transmit the dynamic Huffman code
// lengths: 0..15 are literal lengths, 16 = "copy previous 3..6×", 17 = "run of
// 3..10 zeros", 18 = "run of 11..138 zeros". HCLEN sends *these* codes' lengths,
// and in this deliberately shuffled order so the most common entries come first
// and trailing zeros can be dropped (§3.2.7).
export const CLC_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

// Map an actual match length (3..258) → its length-code index (0..28 == 257..285).
export const LEN_CODE = (() => {
  const t = new Int16Array(MAX_MATCH + 1).fill(-1)
  for (let code = 0; code < LEN_BASE.length; code++) {
    const base = LEN_BASE[code]
    const span = 1 << LEN_EXTRA[code]
    const last = code === LEN_BASE.length - 1 ? base : base + span - 1
    for (let l = base; l <= last; l++) t[l] = code
  }
  return t
})()

// Map an actual distance (1..32768) → its distance-code index (0..29).
export const DIST_CODE = (() => {
  const t = new Int16Array(WINDOW_SIZE + 1).fill(-1)
  for (let code = 0; code < DIST_BASE.length; code++) {
    const base = DIST_BASE[code]
    const last = base + (1 << DIST_EXTRA[code]) - 1
    for (let d = base; d <= last && d <= WINDOW_SIZE; d++) t[d] = code
  }
  return t
})()

// Fixed Huffman code lengths (§3.2.6): the compressor may skip the dynamic
// header entirely and use this canned code. Literals/lengths: 0..143→8, 144..255→9,
// 256..279→7, 280..287→8; every distance is a flat 5 bits.
export function fixedLitLengths(): number[] {
  const L = new Array(288)
  for (let i = 0; i < 144; i++) L[i] = 8
  for (let i = 144; i < 256; i++) L[i] = 9
  for (let i = 256; i < 280; i++) L[i] = 7
  for (let i = 280; i < 288; i++) L[i] = 8
  return L
}
export function fixedDistLengths(): number[] {
  return new Array(30).fill(5)
}
