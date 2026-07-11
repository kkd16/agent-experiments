// Low-Density Parity-Check codes — the modern, capacity-approaching channel code
// that convolutional/Viterbi (the Coding lab) never reaches. Everything here is
// from scratch, no libraries:
//
//   • Tanner-graph / sparse parity-check representation (the bipartite graph BP runs on),
//   • three code constructors — the (7,4) Hamming code as an LDPC (pedagogy), a
//     Progressive-Edge-Growth (Hu–Eleftheriou–Arnold 2005) random regular code
//     conditioned for large girth, and a circulant-lifted QC-LDPC (the 802.11n / 5G form),
//   • a GF(2) Gaussian-elimination encoder that turns ANY H into a systematic generator
//     (message bits ride the free columns, parity bits are XOR combinations) — so every
//     codeword provably satisfies H·c = 0,
//   • BPSK-over-AWGN with the exact channel LLR, and
//   • an iterative message-passing decoder with four schedules that share one graph:
//     sum-product (the exact box-plus check rule via a numerically-stable forward/backward
//     pass), min-sum, normalised min-sum, and offset min-sum — each with syndrome-based
//     early termination and a per-iteration convergence trace for the animation.
//
// Sign convention: bit 0 → BPSK +1, bit 1 → −1 (matching the Modem/Coding labs). A
// log-likelihood ratio L = log P(bit=0)/P(bit=1) is therefore POSITIVE when the channel
// leans toward a 0. The channel LLR of a received sample y is L = 2y/σ².

import { mulberry32, gaussian } from './comms'

export { mulberry32, gaussian }

// ---------------------------------------------------------------------------
// The Tanner graph / parity-check code
// ---------------------------------------------------------------------------

/**
 * A binary LDPC code stored as a sparse Tanner graph plus a systematic encoder
 * derived from H by GF(2) elimination. `n` variable (bit) nodes, `m` check nodes;
 * the code rate is `k / n` where `k = n − rank(H)`.
 */
export interface LdpcCode {
  id: string
  label: string
  n: number // codeword length (variable nodes)
  m: number // number of parity checks (check nodes; may exceed rank if H is redundant)
  k: number // message length = n − rank(H)
  rank: number // GF(2) rank of H
  rate: number // k / n
  // Sparse adjacency. checkNodes[c] = variable indices in check c; varNodes[v] = check indices on v.
  checkNodes: number[][]
  varNodes: number[][]
  // Edge list (parallel arrays). Edge e connects variable edgeVar[e] to check edgeChk[e].
  edgeVar: Int32Array
  edgeChk: Int32Array
  // Per-check / per-variable lists of edge indices (same order as checkNodes / varNodes).
  checkEdges: number[][]
  varEdges: number[][]
  // Systematic encoder derived from RREF(H).
  messageCols: number[] // the k free columns that carry raw message bits
  parityCols: number[] // the `rank` pivot columns solved from the checks
  // parityRows[i] lists the message indices (0..k−1) that XOR into parityCols[i].
  parityRows: number[][]
}

/** Build the edge list + per-node edge indices from the check→variable adjacency. */
function buildEdges(n: number, checkNodes: number[][]): Pick<
  LdpcCode,
  'varNodes' | 'edgeVar' | 'edgeChk' | 'checkEdges' | 'varEdges'
> {
  const m = checkNodes.length
  const varNodes: number[][] = Array.from({ length: n }, () => [])
  const checkEdges: number[][] = Array.from({ length: m }, () => [])
  const varEdges: number[][] = Array.from({ length: n }, () => [])
  const evar: number[] = []
  const echk: number[] = []
  let e = 0
  for (let c = 0; c < m; c++) {
    for (const v of checkNodes[c]) {
      evar.push(v)
      echk.push(c)
      checkEdges[c].push(e)
      varEdges[v].push(e)
      varNodes[v].push(c)
      e++
    }
  }
  return {
    varNodes,
    edgeVar: Int32Array.from(evar),
    edgeChk: Int32Array.from(echk),
    checkEdges,
    varEdges,
  }
}

// --- GF(2) systematic encoder from H -----------------------------------------

/**
 * Reduce H (given as check→variable adjacency) to reduced row-echelon form over
 * GF(2), then read off a systematic encoder: the non-pivot ("free") columns carry
 * the raw message bits, and each pivot column is the XOR of the free bits sharing
 * its RREF row. Guarantees H·encode(msg) = 0 for every message.
 */
function makeEncoder(
  n: number,
  checkNodes: number[][],
): { k: number; rank: number; messageCols: number[]; parityCols: number[]; parityRows: number[][] } {
  const m = checkNodes.length
  // Dense bit rows as Uint8Array (0/1). Small codes only — fine for our sizes.
  const rows: Uint8Array[] = []
  for (let c = 0; c < m; c++) {
    const row = new Uint8Array(n)
    for (const v of checkNodes[c]) row[v] ^= 1
    rows.push(row)
  }
  // Gauss–Jordan elimination, recording the pivot column of each pivot row.
  const pivotColOfRow: number[] = []
  const isPivotCol = new Uint8Array(n)
  let r = 0 // current pivot row
  for (let col = 0; col < n && r < m; col++) {
    // find a row >= r with a 1 in this column
    let sel = -1
    for (let i = r; i < m; i++) {
      if (rows[i][col]) {
        sel = i
        break
      }
    }
    if (sel === -1) continue
    // swap into position r
    const tmp = rows[r]
    rows[r] = rows[sel]
    rows[sel] = tmp
    // eliminate this column from every other row
    for (let i = 0; i < m; i++) {
      if (i !== r && rows[i][col]) {
        const a = rows[i]
        const b = rows[r]
        for (let j = 0; j < n; j++) a[j] ^= b[j]
      }
    }
    pivotColOfRow.push(col)
    isPivotCol[col] = 1
    r++
  }
  const rank = r
  const parityCols = pivotColOfRow.slice()
  const messageCols: number[] = []
  for (let col = 0; col < n; col++) if (!isPivotCol[col]) messageCols.push(col)
  const k = messageCols.length
  // Map each free column to its index in the message vector.
  const msgIndexOfCol = new Int32Array(n).fill(-1)
  messageCols.forEach((col, i) => (msgIndexOfCol[col] = i))
  // For each pivot row i, parity bit = XOR of message bits at the free columns that
  // are set in that (reduced) row.
  const parityRows: number[][] = []
  for (let i = 0; i < rank; i++) {
    const list: number[] = []
    const row = rows[i]
    for (let col = 0; col < n; col++) {
      if (!isPivotCol[col] && row[col]) list.push(msgIndexOfCol[col])
    }
    parityRows.push(list)
  }
  return { k, rank, messageCols, parityCols, parityRows }
}

/** Assemble a full `LdpcCode` from a check→variable adjacency list. */
export function makeCode(id: string, label: string, n: number, checkNodes: number[][]): LdpcCode {
  // De-duplicate & sort each check's variable list (a clean sparse graph).
  const clean = checkNodes.map((c) => Array.from(new Set(c)).sort((a, b) => a - b))
  const edges = buildEdges(n, clean)
  const enc = makeEncoder(n, clean)
  return {
    id,
    label,
    n,
    m: clean.length,
    k: enc.k,
    rank: enc.rank,
    rate: enc.k / n,
    checkNodes: clean,
    ...edges,
    messageCols: enc.messageCols,
    parityCols: enc.parityCols,
    parityRows: enc.parityRows,
  }
}

// --- encode / verify ---------------------------------------------------------

/** Systematic encode: message (length k) → codeword (length n), with H·c = 0. */
export function encode(code: LdpcCode, msg: ArrayLike<number>): Uint8Array {
  const c = new Uint8Array(code.n)
  for (let i = 0; i < code.k; i++) c[code.messageCols[i]] = msg[i] & 1
  for (let i = 0; i < code.rank; i++) {
    let bit = 0
    for (const mi of code.parityRows[i]) bit ^= msg[mi] & 1
    c[code.parityCols[i]] = bit
  }
  return c
}

/** Pull the systematic message bits back out of a codeword. */
export function extractMessage(code: LdpcCode, codeword: ArrayLike<number>): Uint8Array {
  const msg = new Uint8Array(code.k)
  for (let i = 0; i < code.k; i++) msg[i] = codeword[code.messageCols[i]] & 1
  return msg
}

/** Syndrome weight: number of unsatisfied parity checks for a hard bit vector. */
export function syndromeWeight(code: LdpcCode, bits: ArrayLike<number>): number {
  let bad = 0
  for (let c = 0; c < code.m; c++) {
    let p = 0
    for (const v of code.checkNodes[c]) p ^= bits[v] & 1
    if (p) bad++
  }
  return bad
}

// ---------------------------------------------------------------------------
// Code constructors
// ---------------------------------------------------------------------------

/** The (7,4) Hamming code as an LDPC — tiny, dense, girth-4; ideal for the graph view. */
export function hammingCode(): LdpcCode {
  // Standard parity-check matrix (columns = binary 1..7):
  //   c0: p1 p3 p5 p7   c1: p2 p3 p6 p7   c2: p4 p5 p6 p7   (1-indexed → 0-indexed below)
  const checks = [
    [0, 2, 4, 6],
    [1, 2, 5, 6],
    [3, 4, 5, 6],
  ]
  return makeCode('hamming74', 'Hamming (7,4)', 7, checks)
}

/**
 * Progressive Edge-Growth (Hu, Eleftheriou & Arnold, 2005). Grows a Tanner graph
 * one edge at a time, always attaching a variable node's next edge to the check
 * node that is *farthest away* in the graph built so far (ties broken by lowest
 * degree, then by the seeded RNG). Maximising each new edge's local distance is
 * exactly what pushes the girth up and kills the short cycles BP hates.
 *
 * `dv` = variable-node degree; check degrees fall out close to n·dv/m.
 */
export function pegCode(id: string, label: string, n: number, m: number, dv: number, seed = 1): LdpcCode {
  const rng = mulberry32(seed)
  const checkNodes: number[][] = Array.from({ length: m }, () => [])
  const varNodes: number[][] = Array.from({ length: n }, () => [])
  const checkDeg = new Int32Array(m)

  // BFS over the current bipartite graph from a variable node; returns the depth
  // at which each check node is first reached (Infinity if unreachable).
  const checkDepthFrom = (v0: number): Float64Array => {
    const depth = new Float64Array(m).fill(Infinity)
    const varSeen = new Uint8Array(n)
    let frontierVars = [v0]
    varSeen[v0] = 1
    let d = 0
    while (frontierVars.length) {
      const nextChecks: number[] = []
      for (const v of frontierVars) {
        for (const c of varNodes[v]) {
          if (depth[c] === Infinity) {
            depth[c] = d + 1
            nextChecks.push(c)
          }
        }
      }
      if (!nextChecks.length) break
      const nextVars: number[] = []
      for (const c of nextChecks) {
        for (const v of checkNodes[c]) {
          if (!varSeen[v]) {
            varSeen[v] = 1
            nextVars.push(v)
          }
        }
      }
      frontierVars = nextVars
      d += 2
    }
    return depth
  }

  for (let v = 0; v < n; v++) {
    for (let e = 0; e < dv; e++) {
      const adjacent = new Set(varNodes[v])
      let cand: number[]
      if (e === 0) {
        // First edge: simply the lowest-degree check.
        let best = Infinity
        cand = []
        for (let c = 0; c < m; c++) {
          if (checkDeg[c] < best) {
            best = checkDeg[c]
            cand = [c]
          } else if (checkDeg[c] === best) cand.push(c)
        }
      } else {
        const depth = checkDepthFrom(v)
        // Prefer the largest distance (unreachable = ∞ is best); among those, lowest degree.
        let bestDepth = -1
        for (let c = 0; c < m; c++) {
          if (adjacent.has(c)) continue
          const dep = depth[c] === Infinity ? 1e9 : depth[c]
          if (dep > bestDepth) bestDepth = dep
        }
        let best = Infinity
        cand = []
        for (let c = 0; c < m; c++) {
          if (adjacent.has(c)) continue
          const dep = depth[c] === Infinity ? 1e9 : depth[c]
          if (dep !== bestDepth) continue
          if (checkDeg[c] < best) {
            best = checkDeg[c]
            cand = [c]
          } else if (checkDeg[c] === best) cand.push(c)
        }
      }
      if (!cand.length) break
      const c = cand[Math.floor(rng() * cand.length) % cand.length]
      checkNodes[c].push(v)
      varNodes[v].push(c)
      checkDeg[c]++
    }
  }
  return makeCode(id, label, n, checkNodes)
}

/**
 * Circulant-lifted QC-LDPC. A small base matrix of shift values (−1 = L×L zero
 * block, s ≥ 0 = the identity cyclically shifted right by s) lifts to a sparse H
 * of size (mb·L) × (nb·L). This is the algebraic structure Wi-Fi (802.11n) and 5G
 * NR LDPC are built from — regular, hardware-friendly, and easy to store.
 */
export function qcLdpcCode(
  id: string,
  label: string,
  base: number[][],
  L: number,
): LdpcCode {
  const mb = base.length
  const nb = base[0].length
  const n = nb * L
  const checkNodes: number[][] = Array.from({ length: mb * L }, () => [])
  for (let bi = 0; bi < mb; bi++) {
    for (let bj = 0; bj < nb; bj++) {
      const s = base[bi][bj]
      if (s < 0) continue
      for (let r = 0; r < L; r++) {
        // Identity shifted right by s: row r has its 1 in column (r + s) mod L.
        const col = bj * L + ((r + s) % L)
        checkNodes[bi * L + r].push(col)
      }
    }
  }
  return makeCode(id, label, n, checkNodes)
}

// --- the catalogue -----------------------------------------------------------

// A rate-1/2 base matrix (mb=4, nb=8) with a lower-triangular parity block, the
// staircase form real QC-LDPC codes use so a systematic encoder always exists.
const QC_BASE_HALF: number[][] = [
  [1, 3, -1, 2, 0, -1, -1, -1],
  [-1, 0, 2, 1, 5, 0, -1, -1],
  [2, -1, 4, -1, 1, 6, 0, -1],
  [3, 1, -1, 5, -1, 2, 3, 0],
]

let _catalogue: LdpcCode[] | null = null

/** The lab's code catalogue, built once (PEG construction is seeded/deterministic). */
export function codeCatalogue(): LdpcCode[] {
  if (_catalogue) return _catalogue
  _catalogue = [
    hammingCode(),
    pegCode('peg_12_6', 'PEG (12, 6) · dv=3', 12, 6, 3, 7),
    pegCode('peg_48_24', 'PEG (48, 24) · dv=3', 48, 24, 3, 11),
    pegCode('peg_96_48', 'PEG (96, 48) · dv=3', 96, 48, 3, 23),
    pegCode('peg_204_102', 'PEG (204, 102) · dv=3', 204, 102, 3, 101),
    qcLdpcCode('qc_96_48', 'QC-LDPC (96, 48) · L=12', QC_BASE_HALF, 12),
  ]
  return _catalogue
}

export function codeById(id: string): LdpcCode {
  const cat = codeCatalogue()
  return cat.find((c) => c.id === id) ?? cat[0]
}

// ---------------------------------------------------------------------------
// Channel: BPSK over AWGN → LLRs
// ---------------------------------------------------------------------------

/** Noise σ for a coded BPSK link at the given information-bit Eb/N0 and code rate. */
export function noiseSigma(ebn0Db: number, rate: number): number {
  const ebn0 = Math.pow(10, ebn0Db / 10)
  const esn0 = ebn0 * rate // energy per *coded* bit
  return Math.sqrt(1 / (2 * esn0))
}

export interface ChannelBlock {
  tx: Uint8Array // transmitted codeword bits
  rx: Float64Array // received BPSK samples (x = 1−2·bit, plus noise)
  llr: Float64Array // channel LLRs = 2·rx/σ²
  sigma: number
}

/** Push a codeword through BPSK + AWGN and return the samples and channel LLRs. */
export function channel(codeword: Uint8Array, sigma: number, rng: () => number): ChannelBlock {
  const n = codeword.length
  const rx = new Float64Array(n)
  const llr = new Float64Array(n)
  const inv = 2 / (sigma * sigma)
  for (let i = 0; i < n; i++) {
    const x = 1 - 2 * codeword[i]
    const y = x + sigma * gaussian(rng)
    rx[i] = y
    llr[i] = inv * y
  }
  return { tx: codeword, rx, llr, sigma }
}

// ---------------------------------------------------------------------------
// The iterative belief-propagation decoder
// ---------------------------------------------------------------------------

export type DecoderAlgo = 'sp' | 'ms' | 'nms' | 'oms'

export const DECODERS: { id: DecoderAlgo; label: string; short: string }[] = [
  { id: 'sp', label: 'Sum-product (exact box-plus)', short: 'sum-product' },
  { id: 'ms', label: 'Min-sum', short: 'min-sum' },
  { id: 'nms', label: 'Normalised min-sum (α=0.75)', short: 'norm min-sum' },
  { id: 'oms', label: 'Offset min-sum (β=0.5)', short: 'offset min-sum' },
]

export interface DecodeOptions {
  algo: DecoderAlgo
  maxIter: number
  alpha?: number // normalised min-sum scale (default 0.75)
  beta?: number // offset min-sum offset (default 0.5)
  trace?: boolean // record per-iteration hard bits + syndrome weight
}

export interface DecodeResult {
  hard: Uint8Array // final hard decision (length n)
  iterations: number // iterations actually run
  converged: boolean // syndrome reached zero
  syndromeTrace: number[] // unsatisfied-check count after each iteration (index 0 = pre-decode)
  hardTrace?: Uint8Array[] // per-iteration hard bits (only if trace requested)
  posterior: Float64Array // final total LLR per variable
}

// Numerically-stable box-plus: 2·atanh(tanh(a/2)·tanh(b/2)) without ever forming
// tanh/atanh (which saturate). Uses  a ⊞ b = sgn·min(|a|,|b|) + correction.
function boxplus(a: number, b: number): number {
  const s = Math.sign(a) * Math.sign(b)
  const mag = Math.min(Math.abs(a), Math.abs(b))
  // log1p(e^-|a+b|) − log1p(e^-|a−b|)
  const corr = Math.log1p(Math.exp(-Math.abs(a + b))) - Math.log1p(Math.exp(-Math.abs(a - b)))
  return s * mag + corr
}

/**
 * Flooding-schedule message passing. All four algorithms share this loop and the
 * variable-node update; they differ only in the check-node combine:
 *   • sum-product uses the exact box-plus (forward/backward, division-free),
 *   • min-sum uses sign-product × min-magnitude (first/second minimum trick),
 *   • normalised / offset min-sum scale or shrink that magnitude to de-bias min-sum.
 * Terminates early the instant the hard decision satisfies every parity check.
 */
export function decode(code: LdpcCode, channelLlr: ArrayLike<number>, opts: DecodeOptions): DecodeResult {
  const { n, m } = code
  const E = code.edgeVar.length
  const alpha = opts.alpha ?? 0.75
  const beta = opts.beta ?? 0.5
  const msgV2C = new Float64Array(E) // variable → check
  const msgC2V = new Float64Array(E) // check → variable
  const ch = new Float64Array(n)
  for (let i = 0; i < n; i++) ch[i] = channelLlr[i]

  // Initialise variable → check messages with the raw channel LLRs.
  for (let e = 0; e < E; e++) msgV2C[e] = ch[code.edgeVar[e]]

  const hard = new Uint8Array(n)
  const posterior = new Float64Array(n)
  const syndromeTrace: number[] = []
  const hardTrace: Uint8Array[] | undefined = opts.trace ? [] : undefined

  // Pre-decode syndrome from the channel alone (iteration 0 of the trace).
  for (let i = 0; i < n; i++) hard[i] = ch[i] < 0 ? 1 : 0
  syndromeTrace.push(syndromeWeight(code, hard))
  if (hardTrace) hardTrace.push(hard.slice())

  let converged = syndromeTrace[0] === 0
  let iter = 0
  for (; iter < opts.maxIter && !converged; iter++) {
    // --- check-node update ---
    for (let c = 0; c < m; c++) {
      const es = code.checkEdges[c]
      const d = es.length
      if (d === 0) continue
      if (opts.algo === 'sp') {
        // Forward/backward box-plus so each outgoing message excludes its own edge.
        const fwd = new Float64Array(d) // fwd[j] = ⊞ of inputs 0..j-1
        const bwd = new Float64Array(d) // bwd[j] = ⊞ of inputs j+1..d-1
        fwd[0] = Infinity // identity for box-plus (⊞ with +∞ is a no-op)
        for (let j = 1; j < d; j++) fwd[j] = boxplus(fwd[j - 1], msgV2C[es[j - 1]])
        bwd[d - 1] = Infinity
        for (let j = d - 2; j >= 0; j--) bwd[j] = boxplus(bwd[j + 1], msgV2C[es[j + 1]])
        for (let j = 0; j < d; j++) msgC2V[es[j]] = boxplus(fwd[j], bwd[j])
      } else {
        // Min-sum family: total sign, first & second minima, index of the minimum.
        let signAll = 1
        let min1 = Infinity
        let min2 = Infinity
        let argmin = -1
        for (let j = 0; j < d; j++) {
          const val = msgV2C[es[j]]
          if (val < 0) signAll = -signAll
          const a = Math.abs(val)
          if (a < min1) {
            min2 = min1
            min1 = a
            argmin = j
          } else if (a < min2) {
            min2 = a
          }
        }
        for (let j = 0; j < d; j++) {
          const val = msgV2C[es[j]]
          const mag = j === argmin ? min2 : min1
          let out = mag
          if (opts.algo === 'nms') out = alpha * mag
          else if (opts.algo === 'oms') out = Math.max(mag - beta, 0)
          const sgn = signAll * (val < 0 ? -1 : 1) // exclude this edge's own sign
          msgC2V[es[j]] = sgn * out
        }
      }
    }

    // --- variable-node update + hard decision ---
    for (let v = 0; v < n; v++) {
      let total = ch[v]
      const es = code.varEdges[v]
      for (const e of es) total += msgC2V[e]
      posterior[v] = total
      hard[v] = total < 0 ? 1 : 0
      for (const e of es) msgV2C[e] = total - msgC2V[e] // extrinsic
    }

    const sw = syndromeWeight(code, hard)
    syndromeTrace.push(sw)
    if (hardTrace) hardTrace.push(hard.slice())
    if (sw === 0) {
      converged = true
      iter++
      break
    }
  }

  return { hard: hard.slice(), iterations: iter, converged, syndromeTrace, hardTrace, posterior }
}

// ---------------------------------------------------------------------------
// Monte-Carlo BER / BLER waterfall
// ---------------------------------------------------------------------------

export interface WaterfallPoint {
  ebn0Db: number
  ber: number // information-bit error rate
  bler: number // block (frame) error rate
  avgIter: number // mean decoder iterations at this SNR
  blocks: number
  bitErrors: number
  blockErrors: number
}

/**
 * BER/BLER vs Eb/N0 by Monte-Carlo. Uses the all-zero codeword — valid for any
 * linear code on a symmetric channel, and the textbook way to keep the simulation
 * fast enough to run live. Stops accumulating a point once it has both enough
 * blocks and enough block errors for a stable estimate.
 */
export function waterfall(
  code: LdpcCode,
  algo: DecoderAlgo,
  ebn0List: number[],
  maxIter: number,
  opts: { minBlocks?: number; maxBlocks?: number; targetBlockErrors?: number; seed?: number } = {},
): WaterfallPoint[] {
  const minBlocks = opts.minBlocks ?? 200
  const maxBlocks = opts.maxBlocks ?? 4000
  const targetErrors = opts.targetBlockErrors ?? 60
  const rng = mulberry32(opts.seed ?? 20260711)
  const zero = new Uint8Array(code.n) // the all-zero codeword
  const out: WaterfallPoint[] = []
  for (const ebn0Db of ebn0List) {
    const sigma = noiseSigma(ebn0Db, code.rate)
    let bitErrors = 0
    let blockErrors = 0
    let iterSum = 0
    let blocks = 0
    for (; blocks < maxBlocks; ) {
      const blk = channel(zero, sigma, rng)
      const res = decode(code, blk.llr, { algo, maxIter })
      iterSum += res.iterations
      // information-bit errors = set bits at the systematic message columns
      let be = 0
      for (const col of code.messageCols) be += res.hard[col]
      bitErrors += be
      if (be > 0 || !res.converged) blockErrors++
      blocks++
      if (blocks >= minBlocks && blockErrors >= targetErrors) break
    }
    out.push({
      ebn0Db,
      ber: bitErrors / (blocks * code.k),
      bler: blockErrors / blocks,
      avgIter: iterSum / blocks,
      blocks,
      bitErrors,
      blockErrors,
    })
  }
  return out
}

/** Uncoded BPSK BER, Q(√(2·Eb/N0)) — the baseline the coding gain is measured against. */
export function uncodedBer(ebn0Db: number): number {
  const x = Math.sqrt(2 * Math.pow(10, ebn0Db / 10))
  // Q(x) = ½ erfc(x/√2)
  return 0.5 * erfc(x / Math.SQRT2)
}

function erfc(x: number): number {
  // Rational approximation (Numerical Recipes), |error| < 1.2e-7.
  const z = Math.abs(x)
  const t = 1 / (1 + 0.5 * z)
  const ans =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    )
  return x >= 0 ? ans : 2 - ans
}

/**
 * The Shannon limit (unconstrained AWGN) for a given rate: the minimum Eb/N0 at
 * which reliable communication is even possible. Eb/N0 ≥ (2^{2R}−1)/(2R).
 */
export function shannonLimitDb(rate: number): number {
  return 10 * Math.log10((Math.pow(2, 2 * rate) - 1) / (2 * rate))
}

// ---------------------------------------------------------------------------
// Graph analysis for the "code" view
// ---------------------------------------------------------------------------

/** Shortest cycle in the Tanner graph (always even; ∞ if the graph is a forest). */
export function girth(code: LdpcCode): number {
  const { n, m } = code
  const N = n + m // variable nodes 0..n-1, check nodes n..n+m-1
  const neighbours: number[][] = Array.from({ length: N }, () => [])
  for (let e = 0; e < code.edgeVar.length; e++) {
    const v = code.edgeVar[e]
    const c = n + code.edgeChk[e]
    neighbours[v].push(c)
    neighbours[c].push(v)
  }
  let best = Infinity
  const dist = new Int32Array(N)
  const parent = new Int32Array(N)
  for (let s = 0; s < N; s++) {
    dist.fill(-1)
    parent.fill(-1)
    dist[s] = 0
    const queue = [s]
    let head = 0
    while (head < queue.length) {
      const u = queue[head++]
      if (dist[u] * 2 >= best) continue // can't improve
      for (const w of neighbours[u]) {
        if (dist[w] === -1) {
          dist[w] = dist[u] + 1
          parent[w] = u
          queue.push(w)
        } else if (parent[u] !== w) {
          const cycle = dist[u] + dist[w] + 1
          if (cycle < best) best = cycle
        }
      }
    }
  }
  return best
}

export interface DegreeStats {
  varDegrees: number[] // histogram index = degree, value = count of variable nodes
  checkDegrees: number[]
  minVar: number
  maxVar: number
  minCheck: number
  maxCheck: number
  avgVar: number
  avgCheck: number
}

export function degreeStats(code: LdpcCode): DegreeStats {
  const varDegrees: number[] = []
  const checkDegrees: number[] = []
  let sv = 0
  let sc = 0
  let minVar = Infinity
  let maxVar = 0
  let minCheck = Infinity
  let maxCheck = 0
  for (let v = 0; v < code.n; v++) {
    const d = code.varNodes[v].length
    varDegrees[d] = (varDegrees[d] ?? 0) + 1
    sv += d
    minVar = Math.min(minVar, d)
    maxVar = Math.max(maxVar, d)
  }
  for (let c = 0; c < code.m; c++) {
    const d = code.checkNodes[c].length
    checkDegrees[d] = (checkDegrees[d] ?? 0) + 1
    sc += d
    minCheck = Math.min(minCheck, d)
    maxCheck = Math.max(maxCheck, d)
  }
  for (let i = 0; i < varDegrees.length; i++) if (varDegrees[i] === undefined) varDegrees[i] = 0
  for (let i = 0; i < checkDegrees.length; i++) if (checkDegrees[i] === undefined) checkDegrees[i] = 0
  return {
    varDegrees,
    checkDegrees,
    minVar,
    maxVar,
    minCheck,
    maxCheck,
    avgVar: sv / code.n,
    avgCheck: sc / code.m,
  }
}

// ---------------------------------------------------------------------------
// A single-block decode demo (used by the animated Tanner-graph view)
// ---------------------------------------------------------------------------

export interface DecodeDemo {
  code: LdpcCode
  tx: Uint8Array
  rx: Float64Array
  channelHard: Uint8Array // hard decision from the channel alone
  channelErrors: number[] // variable indices the channel flipped
  result: DecodeResult
  finalErrors: number[] // variable indices still wrong after decoding
  recovered: boolean
}

/** Encode a (seeded) random message, run it through the channel, and decode with a trace. */
export function decodeDemo(
  code: LdpcCode,
  ebn0Db: number,
  algo: DecoderAlgo,
  maxIter: number,
  seed: number,
): DecodeDemo {
  const rng = mulberry32(seed >>> 0)
  const msg = new Uint8Array(code.k)
  for (let i = 0; i < code.k; i++) msg[i] = rng() < 0.5 ? 0 : 1
  const tx = encode(code, msg)
  const sigma = noiseSigma(ebn0Db, code.rate)
  const blk = channel(tx, sigma, rng)
  const channelHard = new Uint8Array(code.n)
  const channelErrors: number[] = []
  for (let i = 0; i < code.n; i++) {
    channelHard[i] = blk.llr[i] < 0 ? 1 : 0
    if (channelHard[i] !== tx[i]) channelErrors.push(i)
  }
  const result = decode(code, blk.llr, { algo, maxIter, trace: true })
  const finalErrors: number[] = []
  for (let i = 0; i < code.n; i++) if (result.hard[i] !== tx[i]) finalErrors.push(i)
  return {
    code,
    tx,
    rx: blk.rx,
    channelHard,
    channelErrors,
    result,
    finalErrors,
    recovered: finalErrors.length === 0,
  }
}
