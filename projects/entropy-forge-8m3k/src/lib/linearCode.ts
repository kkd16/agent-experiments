// linearCode.ts — a general binary linear block code (n, k, d).
//
// A linear code is a k-dimensional subspace of GF(2)^n. It is described by two
// matrices that are two sides of the same coin:
//   • the GENERATOR matrix G (k×n): encode is a matrix product, codeword = m·G.
//   • the PARITY-CHECK matrix H ((n−k)×n): a word w is a codeword iff H·wᵀ = 0.
// In SYSTEMATIC form G = [I_k | P] and H = [Pᵀ | I_{n−k}], so the first k bits of
// a codeword are the message verbatim and the rest are parity — which makes
// decoding, once errors are corrected, a trivial truncation.
//
// DECODING is by SYNDROME. The received word r = c ⊕ e (error pattern e). Then
// H·rᵀ = H·cᵀ ⊕ H·eᵀ = H·eᵀ = the "syndrome" — it depends ONLY on the error, not
// the message. Standard-array / syndrome decoding precomputes, for each of the
// 2^{n−k} syndromes, the minimum-weight error pattern (coset leader) that
// produces it; decoding is then a table lookup + XOR. This corrects every error
// pattern up to the code's guarantee t = ⌊(d−1)/2⌋ and is maximum-likelihood on
// the BSC.
//
// Repetition codes and single-parity-check codes are just special cases built by
// the constructors at the bottom.

import { type BitMatrix, bitWeight, matVecMul, vecMatMul } from './galois.ts'

export interface LinearCode {
  name: string
  n: number
  k: number
  G: BitMatrix // k×n generator (systematic [I|P])
  H: BitMatrix // (n−k)×n parity check ([Pᵀ|I])
  d: number // minimum distance
  t: number // guaranteed correctable errors ⌊(d−1)/2⌋
  /** Coset-leader table: syndrome (as an int, MSB = first check row) → error pattern. */
  syndromeTable: Map<number, number[]>
}

/** Build the systematic H = [Pᵀ | I] from a systematic G = [I | P]. */
export function parityFromGenerator(G: BitMatrix, k: number, n: number): BitMatrix {
  const m = n - k
  const H: BitMatrix = Array.from({ length: m }, () => new Array(n).fill(0))
  // P is the right k×m block of G. Pᵀ is the left m×k block of H.
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < m; j++) {
      H[j][i] = G[i][k + j] & 1
    }
  }
  // Identity on the right.
  for (let j = 0; j < m; j++) H[j][k + j] = 1
  return H
}

/** Interpret a syndrome bit vector as an integer key (first row = MSB). */
export function syndromeKey(s: number[]): number {
  let key = 0
  for (const b of s) key = (key << 1) | (b & 1)
  return key
}

/**
 * Precompute the standard-array coset leaders. For each of the 2^n error
 * patterns in increasing Hamming weight, record it as the leader of its syndrome
 * if that syndrome hasn't been claimed yet. Enumerating by weight guarantees the
 * MINIMUM-weight leader wins — exactly maximum-likelihood on the BSC. Feasible
 * for the small n this lab uses (n ≤ ~24 with early stop once all cosets filled).
 */
export function buildSyndromeTable(H: BitMatrix, n: number): Map<number, number[]> {
  const m = H.length
  const table = new Map<number, number[]>()
  const totalCosets = 1 << m
  // Weight 0 → zero syndrome.
  table.set(0, new Array(n).fill(0))
  // Enumerate error patterns by increasing weight until every coset has a leader.
  for (let w = 1; w <= n && table.size < totalCosets; w++) {
    const idx = new Array(w)
    for (let i = 0; i < w; i++) idx[i] = i
    for (;;) {
      const e = new Array(n).fill(0)
      for (const p of idx) e[p] = 1
      const key = syndromeKey(matVecMul(H, e))
      if (!table.has(key)) table.set(key, e)
      // Advance the combination (odometer over positions).
      let i = w - 1
      while (i >= 0 && idx[i] === n - w + i) i--
      if (i < 0) break
      idx[i]++
      for (let j = i + 1; j < w; j++) idx[j] = idx[j - 1] + 1
    }
  }
  return table
}

/** Minimum distance of a linear code = minimum Hamming weight of a non-zero codeword. */
export function minDistance(G: BitMatrix, k: number): number {
  let best = Infinity
  // Enumerate all 2^k − 1 non-zero messages (k is small in this lab).
  for (let msg = 1; msg < 1 << k; msg++) {
    const vec = new Array(k)
    for (let i = 0; i < k; i++) vec[i] = (msg >>> (k - 1 - i)) & 1
    const cw = vecMatMul(vec, G)
    const w = bitWeight(cw)
    if (w > 0 && w < best) best = w
  }
  return best === Infinity ? 0 : best
}

/** Assemble a LinearCode from a systematic generator matrix. */
export function makeLinearCode(name: string, G: BitMatrix): LinearCode {
  const k = G.length
  const n = G[0].length
  const H = parityFromGenerator(G, k, n)
  const d = minDistance(G, k)
  const t = Math.floor((d - 1) / 2)
  const syndromeTable = buildSyndromeTable(H, n)
  return { name, n, k, G, H, d, t, syndromeTable }
}

/** Encode a length-k message bit vector → length-n codeword. */
export function encodeLinear(code: LinearCode, msg: number[]): number[] {
  return vecMatMul(msg, code.G)
}

/** The syndrome H·rᵀ of a received word. */
export function syndrome(code: LinearCode, received: number[]): number[] {
  return matVecMul(code.H, received)
}

export interface DecodeResult {
  corrected: number[] // corrected codeword (length n)
  message: number[] // recovered message (first k bits)
  errorPattern: number[] // estimated error (length n)
  syndrome: number[] // the syndrome that was looked up
  numErrors: number // weight of the estimated error
  detected: boolean // was any error detected (syndrome ≠ 0)?
}

/**
 * Syndrome-decode a received word: look up the coset leader for its syndrome,
 * XOR it out, and read off the systematic message bits. Corrects up to t errors
 * and is ML on the BSC; beyond t it returns its best (possibly wrong) guess —
 * which is exactly how a real decoder behaves and what the demos illustrate.
 */
export function decodeLinear(code: LinearCode, received: number[]): DecodeResult {
  const s = syndrome(code, received)
  const key = syndromeKey(s)
  const e = code.syndromeTable.get(key) ?? new Array(code.n).fill(0)
  const corrected = received.map((b, i) => (b ^ e[i]) & 1)
  const message = corrected.slice(0, code.k)
  return {
    corrected,
    message,
    errorPattern: e,
    syndrome: s,
    numErrors: bitWeight(e),
    detected: key !== 0,
  }
}

// ---- Convenience constructors for the textbook small codes ----

/** The (n, 1) repetition code: one bit sent n times. d = n, corrects ⌊(n−1)/2⌋. */
export function repetitionCode(n: number): LinearCode {
  const G: BitMatrix = [new Array(n).fill(1)]
  return makeLinearCode(`Repetition (${n},1)`, G)
}

/** The (k+1, k) single-parity-check code: appends the XOR of all data bits. d = 2. */
export function parityCheckCode(k: number): LinearCode {
  const n = k + 1
  const G: BitMatrix = Array.from({ length: k }, (_, i) => {
    const row = new Array(n).fill(0)
    row[i] = 1
    row[k] = 1 // every data bit contributes to the single parity bit
    return row
  })
  return makeLinearCode(`Single-parity (${n},${k})`, G)
}
