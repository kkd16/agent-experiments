// ldpc.ts — Low-Density Parity-Check codes and iterative belief-propagation
// decoding, the capacity-approaching codes that supplanted everything else and
// now run inside Wi-Fi 6, 5G-NR, 10GBASE-T and modern satellite/DVB-S2 links.
//
// An LDPC code is just a linear code whose parity-check matrix H is SPARSE — a
// handful of 1s per row and column. Sparsity is the whole trick: it lets the
// decoder work on the TANNER GRAPH (variable nodes = codeword bits, check nodes
// = parity equations, an edge wherever H has a 1) by passing local "beliefs"
// along the edges. Each check node tells each neighbouring bit what it thinks
// that bit should be, given the *other* bits it touches; each bit pools the
// opinions of its checks and the channel. Iterated, these local messages
// converge to the globally most-likely codeword — SUM-PRODUCT belief propagation,
// exact on a tree and astonishingly good on the near-tree-like sparse graph.
//
// Everything is done in the LOG-LIKELIHOOD-RATIO domain (L = log P(0)/P(1)): the
// channel gives each bit a prior LLR, the variable update is a sum, and the check
// update is the numerically-stable "box-plus" combination of tanh's. We build a
// quasi-cyclic (3,6)-regular code (column weight 3, row weight 6, rate 1/2) from
// circulant blocks — the same construction family the Wi-Fi/5G standards use —
// with encoding derived from H's null space so it is guaranteed consistent.

import { type BitMatrix, matVecMul, nullSpace } from './galois.ts'
import { minDistance } from './linearCode.ts'

export interface LdpcCode {
  name: string
  n: number
  k: number
  m: number // parity checks (= n − k if H full rank)
  H: BitMatrix // m×n sparse parity-check
  G: BitMatrix // k×n generator (rows = null space of H)
  infoCols: number[] // the k codeword positions that carry the message bits
  // Adjacency for the Tanner graph / BP (built from H).
  checkNbrs: number[][] // checkNbrs[c] = variable indices in check c
  varNbrs: number[][] // varNbrs[v] = check indices touching variable v
  colWeight: number
  rowWeight: number
}

/**
 * Build a quasi-cyclic (wc, wr)-regular LDPC parity-check from a base matrix of
 * circulant shifts. Each base entry s ≥ 0 expands to an L×L cyclic-shift identity
 * (a 1 at column (row+s) mod L); s < 0 expands to an all-zero L×L block. Distinct
 * shifts within the graph keep the girth ≥ 6 (no length-4 cycles), which is what
 * BP needs to work well.
 */
export function qcLdpcH(base: number[][], L: number): BitMatrix {
  const mb = base.length
  const nb = base[0].length
  const m = mb * L
  const n = nb * L
  const H: BitMatrix = Array.from({ length: m }, () => new Array(n).fill(0))
  for (let bi = 0; bi < mb; bi++) {
    for (let bj = 0; bj < nb; bj++) {
      const s = base[bi][bj]
      if (s < 0) continue
      for (let r = 0; r < L; r++) {
        const c = (r + s) % L
        H[bi * L + r][bj * L + c] = 1
      }
    }
  }
  return H
}

/** Assemble an LdpcCode from a parity-check matrix: derive G from H's null space
 * and precompute the Tanner-graph adjacency. */
export function makeLdpcCode(name: string, H: BitMatrix): LdpcCode {
  const m = H.length
  const n = H[0].length
  const G = nullSpace(H) // k × n; rows systematic in the free (info) columns
  const k = G.length
  // The info columns are the free columns of H — recover them from G's rows:
  // basis row j is the unique codeword with a 1 in the j-th free column and 0 in
  // the others, so the info column of row j is where that row's "pivot-free" 1 sits.
  // We recompute them the same way nullSpace does, to label the message bits.
  const infoCols = deriveInfoCols(H, n)
  const checkNbrs: number[][] = H.map((row) => {
    const nb: number[] = []
    for (let j = 0; j < n; j++) if (row[j]) nb.push(j)
    return nb
  })
  const varNbrs: number[][] = Array.from({ length: n }, () => [])
  for (let c = 0; c < m; c++) for (const v of checkNbrs[c]) varNbrs[v].push(c)
  const colWeight = varNbrs.reduce((a, x) => Math.max(a, x.length), 0)
  const rowWeight = checkNbrs.reduce((a, x) => Math.max(a, x.length), 0)
  return { name, n, k, m, H, G, infoCols, checkNbrs, varNbrs, colWeight, rowWeight }
}

/** The free (non-pivot) columns of H — these carry the k message bits. */
function deriveInfoCols(H: BitMatrix, n: number): number[] {
  // Reduce a copy to row echelon and collect pivot columns; the rest are free.
  const R = H.map((r) => r.slice())
  const rows = R.length
  const pivots = new Set<number>()
  let r = 0
  for (let c = 0; c < n && r < rows; c++) {
    let piv = -1
    for (let i = r; i < rows; i++) if (R[i][c] & 1) { piv = i; break }
    if (piv === -1) continue
    ;[R[piv], R[r]] = [R[r], R[piv]]
    for (let i = 0; i < rows; i++) if (i !== r && R[i][c] & 1) for (let j = c; j < n; j++) R[i][j] ^= R[r][j]
    pivots.add(c)
    r++
  }
  const info: number[] = []
  for (let c = 0; c < n; c++) if (!pivots.has(c)) info.push(c)
  return info
}

/** Encode k message bits → n-bit codeword via G (rows = null space of H). */
export function ldpcEncode(code: LdpcCode, msg: number[]): number[] {
  const out = new Array(code.n).fill(0)
  for (let i = 0; i < code.k; i++) {
    if (msg[i] & 1) {
      const row = code.G[i]
      for (let j = 0; j < code.n; j++) out[j] ^= row[j]
    }
  }
  return out
}

/** Read the message bits back out of a (corrected) codeword. */
export function ldpcMessage(code: LdpcCode, codeword: number[]): number[] {
  return code.infoCols.map((c) => codeword[c] & 1)
}

/** Is the syndrome zero (valid codeword)? */
export function ldpcSyndromeZero(code: LdpcCode, word: number[]): boolean {
  const s = matVecMul(code.H, word)
  return s.every((b) => b === 0)
}

export interface BpResult {
  bits: number[] // hard-decision decoded codeword
  message: number[] // recovered message bits
  success: boolean // syndrome cleared within the iteration budget
  iterations: number // iterations actually run
  unsatisfiedPerIter: number[] // # failing checks after each iteration (for viz)
  llr: number[] // final total LLR per bit
}

/** Numerically stable 2·atanh(∏ tanh(x/2)) via the sign/min "box-plus" isn't used
 * here; we use the direct tanh product with clamping, which is exact sum-product. */
function boxplusProduct(vals: number[]): number {
  let prod = 1
  for (const x of vals) {
    let t = Math.tanh(x / 2)
    // Clamp away from ±1 to keep atanh finite.
    if (t > 0.999999999999) t = 0.999999999999
    else if (t < -0.999999999999) t = -0.999999999999
    prod *= t
  }
  if (prod > 0.999999999999) prod = 0.999999999999
  else if (prod < -0.999999999999) prod = -0.999999999999
  return 2 * Math.atanh(prod)
}

/**
 * Sum-product (belief propagation) decode from per-bit channel LLRs (positive ⇒
 * bit 0 more likely). Runs the flooding schedule to convergence or maxIter.
 */
export function bpDecodeLLR(code: LdpcCode, channelLLR: number[], maxIter = 50): BpResult {
  const { m, n, checkNbrs, varNbrs } = code
  // Edge messages, indexed [check][position-in-check] and [var][position-in-var].
  // We store variable→check messages M and check→variable messages E as maps
  // keyed by (c, v) via parallel arrays over the check adjacency.
  const M: number[][] = checkNbrs.map((nb) => nb.map(() => 0)) // M[c][i] : var nb[i] → check c
  const E: number[][] = checkNbrs.map((nb) => nb.map(() => 0)) // E[c][i] : check c → var nb[i]
  // Init variable→check with the channel LLR.
  for (let c = 0; c < m; c++) for (let i = 0; i < checkNbrs[c].length; i++) M[c][i] = channelLLR[checkNbrs[c][i]]

  const unsatisfiedPerIter: number[] = []
  let bits = new Array(n).fill(0)
  let iterations = 0
  for (let it = 0; it < maxIter; it++) {
    iterations = it + 1
    // ---- check → variable ----
    for (let c = 0; c < m; c++) {
      const deg = checkNbrs[c].length
      for (let i = 0; i < deg; i++) {
        const others: number[] = []
        for (let j = 0; j < deg; j++) if (j !== i) others.push(M[c][j])
        E[c][i] = boxplusProduct(others)
      }
    }
    // ---- variable → check, and hard decision ----
    const total = channelLLR.slice()
    // Accumulate all incoming check messages per variable.
    // First reset then add each edge's E to its variable.
    for (let c = 0; c < m; c++) for (let i = 0; i < checkNbrs[c].length; i++) total[checkNbrs[c][i]] += E[c][i]
    // Update outgoing variable→check = total − that edge's own E.
    for (let c = 0; c < m; c++) {
      for (let i = 0; i < checkNbrs[c].length; i++) {
        const v = checkNbrs[c][i]
        M[c][i] = total[v] - E[c][i]
      }
    }
    bits = total.map((l) => (l < 0 ? 1 : 0))
    // Count unsatisfied checks.
    let bad = 0
    for (let c = 0; c < m; c++) {
      let s = 0
      for (const v of checkNbrs[c]) s ^= bits[v]
      if (s) bad++
    }
    unsatisfiedPerIter.push(bad)
    if (bad === 0) {
      return {
        bits,
        message: ldpcMessage(code, bits),
        success: true,
        iterations,
        unsatisfiedPerIter,
        llr: total,
      }
    }
    void varNbrs // (adjacency kept for the UI; flooding schedule uses check lists)
  }
  // Did not converge: return best hard decision.
  const total = channelLLR.slice()
  for (let c = 0; c < m; c++) for (let i = 0; i < checkNbrs[c].length; i++) total[checkNbrs[c][i]] += E[c][i]
  return {
    bits,
    message: ldpcMessage(code, bits),
    success: false,
    iterations,
    unsatisfiedPerIter,
    llr: total,
  }
}

/** Channel LLRs for a hard BSC output at crossover p. */
export function bscLLR(received: number[], p: number): number[] {
  const mag = Math.log((1 - p) / Math.max(p, 1e-9))
  return received.map((r) => (r === 0 ? mag : -mag))
}

/** Minimum distance of the LDPC code (small codes only — exponential in k). */
export function ldpcMinDistance(code: LdpcCode): number {
  return minDistance(code.G, code.k)
}

// ---- default codes ----
//
// Systematic form H = [P | I_m]: the identity block makes H full rank (so the
// rate is exactly k/n and the code is trivially encodable) while P stays sparse
// (info-bit column weight 3, and any two info columns share ≤ 1 check, so the
// Tanner graph has girth ≥ 6 — no 4-cycles for BP to choke on). This is the
// "lower-triangular / systematic" LDPC construction used when guaranteed linear-
// time encoding matters, as in the DVB-S2 and 802.11n standards' base codes.

/** Assemble H = [P | I_m] from an m×k sparse P block. */
export function systematicLdpcH(P: BitMatrix): BitMatrix {
  const m = P.length
  const k = P[0].length
  const n = k + m
  return P.map((row, i) => {
    const full = new Array(n).fill(0)
    for (let j = 0; j < k; j++) full[j] = row[j]
    full[k + i] = 1
    return full
  })
}

// A hand-verified rate-½ (24,12) code: 12 info columns of weight 3 over 12 checks,
// pairwise column overlap ≤ 1. Small enough to draw the whole Tanner graph.
const P_24_12: BitMatrix = [
  [0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0],
  [0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0],
  [0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0],
  [0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
  [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
  [1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0],
  [0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0],
  [0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1],
  [1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0],
  [0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0],
  [0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1],
]

export const LDPC_DEMO: LdpcCode = makeLdpcCode('LDPC (24,12) · rate ½', systematicLdpcH(P_24_12))

/**
 * A larger rate-½ systematic LDPC (k info bits, k parity checks, info column
 * weight `w`) built deterministically from a seeded LCG, with pairwise info-
 * column overlap kept ≤ 1. Used for the BER waterfall where a longer block shows
 * a steeper cliff. Deterministic, so every run matches.
 */
export function buildSystematicLdpc(k: number, w = 3, seed = 0x1a2b3c4d): LdpcCode {
  const m = k
  let s = seed >>> 0
  const rnd = () => {
    s = (1103515245 * s + 12345) >>> 0
    return s >>> 16
  }
  const cols: number[][] = []
  const rowUse = new Array(m).fill(0)
  for (let c = 0; c < k; c++) {
    let best: { set: number[]; cost: number } | null = null
    for (let att = 0; att < 600; att++) {
      const set = new Set<number>()
      while (set.size < w) set.add(rnd() % m)
      const arr = [...set]
      let okc = true
      for (const pc of cols) {
        let sh = 0
        for (const x of arr) if (pc.includes(x)) sh++
        if (sh >= 2) { okc = false; break }
      }
      if (!okc) continue
      const cost = Math.max(...arr.map((x) => rowUse[x]))
      if (best === null || cost < best.cost) best = { set: arr, cost }
    }
    if (!best) {
      // Fallback: accept overlap to keep the build total (rare for these sizes).
      const set = new Set<number>()
      while (set.size < w) set.add(rnd() % m)
      best = { set: [...set], cost: 0 }
    }
    cols.push(best.set)
    for (const x of best.set) rowUse[x]++
  }
  const P: BitMatrix = Array.from({ length: m }, () => new Array(k).fill(0))
  cols.forEach((set, c) => set.forEach((row) => (P[row][c] = 1)))
  return makeLdpcCode(`LDPC (${2 * k},${k}) · rate ½`, systematicLdpcH(P))
}

export const LDPC_BIG: LdpcCode = buildSystematicLdpc(48, 3)
