// Polar codes — Arıkan's channel-polarization construction, the first family of
// codes *proven* to achieve the symmetric capacity of any binary-input memoryless
// channel with an explicit, low-complexity construction, and the code that carries
// the 5G-NR control channels (PBCH / PDCCH / PUCCH). Everything here is from
// scratch, no libraries:
//
//   • the polar transform x = u·F^{⊗n} (F = [[1,0],[1,1]]) as an in-place butterfly,
//     and its exact inverse — encoding is a self-inverse GF(2) transform,
//   • two *channel constructions* that decide which synthetic bit-channels are
//     reliable enough to carry information (the rest are "frozen" to 0):
//       – the Bhattacharyya-parameter recursion on the binary erasure channel
//         (Z⁻ = 2Z−Z², Z⁺ = Z²), Arıkan's original construction, and
//       – the Gaussian-approximation of density evolution on the BI-AWGN channel
//         (track the mean LLR through the φ-function recursion), the construction
//         real designs use,
//   • the successive-cancellation (SC) decoder as the natural recursive f/g message
//     schedule (exact box-plus *or* the min-sum hardware approximation),
//   • the successive-cancellation *list* (SCL) decoder — Tal & Vardy's breakthrough
//     that keeps the L most-likely paths through the same recursion and prunes by an
//     LLR path metric — and its CRC-aided variant (CA-SCL), the 5G decoder, where an
//     outer CRC picks the surviving path (turning polar codes from "good" to
//     "state-of-the-art at short block lengths"),
//   • a BPSK-over-AWGN Monte-Carlo link that measures BLER/BER waterfalls for each
//     decoder, and the BI-AWGN channel capacity (Gauss-Legendre-free adaptive
//     Simpson integration) as the information-theoretic yardstick.
//
// Index / sign conventions
// ------------------------
// The transform is used in *natural* (non-bit-reversed) order: u and the frozen
// mask are indexed 0…N−1 in the order the SC recursion decodes them, and the
// codeword x is in the order it is transmitted. Bit 0 → BPSK +1, bit 1 → −1
// (matching the Modem / LDPC labs). A log-likelihood ratio L = log P(0)/P(1) is
// therefore POSITIVE when the channel leans toward a 0; the channel LLR of a
// received sample y at noise variance σ² is L = 2y/σ².

import { mulberry32, gaussian, ebn0ToSigma } from './comms'

export { mulberry32 }

// ---------------------------------------------------------------------------
// The polar transform (encoder)
// ---------------------------------------------------------------------------

/** log2 of a power of two (throws if `n` is not one). */
export function log2Exact(n: number): number {
  let k = 0
  let m = n
  while (m > 1) {
    if (m & 1) throw new Error(`${n} is not a power of two`)
    m >>= 1
    k++
  }
  return k
}

/**
 * In-place polar transform of a GF(2) vector: `x ← u·F^{⊗n}`, F = [[1,0],[1,1]].
 * The butterfly XORs the low element of each pair with the high one, doubling the
 * stride each stage. The transform is its own inverse (F² = I over GF(2)), so the
 * same routine both encodes (u → x) and inverts (x → u).
 */
export function polarTransform(bits: Uint8Array): Uint8Array {
  const N = bits.length
  const out = Uint8Array.from(bits)
  for (let len = 1; len < N; len <<= 1) {
    for (let i = 0; i < N; i += len << 1) {
      for (let j = 0; j < len; j++) {
        out[i + j] ^= out[i + j + len]
      }
    }
  }
  return out
}

/**
 * Snapshot the polar transform after every butterfly stage (for the encoder
 * animation). `stages[0]` is the input u; `stages[k]` is the vector after stage k;
 * the last is the codeword x. Each stage k XORs elements `i+j` with `i+j+2^k`.
 */
export function transformStages(bits: Uint8Array): Uint8Array[] {
  const N = bits.length
  const stages: Uint8Array[] = [Uint8Array.from(bits)]
  const cur = Uint8Array.from(bits)
  for (let len = 1; len < N; len <<= 1) {
    for (let i = 0; i < N; i += len << 1) {
      for (let j = 0; j < len; j++) cur[i + j] ^= cur[i + j + len]
    }
    stages.push(Uint8Array.from(cur))
  }
  return stages
}

// ---------------------------------------------------------------------------
// Cyclic redundancy check (for CRC-aided list decoding)
// ---------------------------------------------------------------------------

/** A CRC specified by its generator polynomial (MSB-first, implicit leading 1). */
export interface CrcSpec {
  id: string
  label: string
  width: number
  /** polynomial without the leading x^width term, e.g. CRC-8 = x⁸+x²+x+1 → 0x07. */
  poly: number
}

export const CRCS: CrcSpec[] = [
  { id: 'none', label: 'None (plain SCL)', width: 0, poly: 0 },
  { id: 'crc6', label: 'CRC-6 (5G, x⁶+x⁵+1)', width: 6, poly: 0x21 },
  { id: 'crc8', label: 'CRC-8 (x⁸+x²+x+1)', width: 8, poly: 0x07 },
  { id: 'crc11', label: 'CRC-11 (5G, x¹¹+x¹⁰+x⁹+x⁵+1)', width: 11, poly: 0x621 },
]

export function crcById(id: string): CrcSpec {
  const c = CRCS.find((x) => x.id === id)
  if (!c) throw new Error(`unknown CRC ${id}`)
  return c
}

/** Bit-wise CRC remainder of a message (MSB-first), returned as `width` bits. */
export function crcBits(msg: ArrayLike<number>, spec: CrcSpec): Uint8Array {
  const w = spec.width
  if (w === 0) return new Uint8Array(0)
  // shift-register remainder over GF(2)
  let reg = 0
  const topMask = 1 << (w - 1)
  const wMask = (1 << w) - 1
  for (let i = 0; i < msg.length; i++) {
    const inBit = msg[i] & 1
    const top = (reg & topMask) !== 0 ? 1 : 0
    reg = ((reg << 1) & wMask) | 0
    if (top ^ inBit) reg ^= spec.poly
  }
  const out = new Uint8Array(w)
  for (let i = 0; i < w; i++) out[i] = (reg >> (w - 1 - i)) & 1
  return out
}

/** True iff the message's own trailing `width` bits equal its CRC over the head. */
export function crcCheck(infoBits: ArrayLike<number>, spec: CrcSpec): boolean {
  if (spec.width === 0) return true
  const k = infoBits.length - spec.width
  if (k < 0) return false
  const head = new Uint8Array(k)
  for (let i = 0; i < k; i++) head[i] = infoBits[i] & 1
  const c = crcBits(head, spec)
  for (let i = 0; i < spec.width; i++) if ((infoBits[k + i] & 1) !== c[i]) return false
  return true
}

// ---------------------------------------------------------------------------
// φ-function for the Gaussian approximation of density evolution
// ---------------------------------------------------------------------------

// φ(x) = 1 − E[tanh(u/2)] for u ~ N(x, 2x): the expected "soft bit" of a
// consistent-Gaussian LLR of mean x. φ(0)=1, φ(∞)=0, strictly decreasing. The
// Chung–Richardson–Urbanke closed-form approximation (2001) avoids any integral.
export function gaPhi(x: number): number {
  if (x <= 0) return 1
  if (x < 10) return Math.exp(-0.4527 * Math.pow(x, 0.86) + 0.0218)
  // large-x tail: sqrt(pi/x) e^{-x/4} (1 − 10/(7x))
  return Math.sqrt(Math.PI / x) * Math.exp(-x / 4) * (1 - 10 / (7 * x))
}

/** Numerical inverse of φ on (0,1] by bisection (φ is monotone decreasing). */
export function gaPhiInv(y: number): number {
  if (y >= 1) return 0
  if (y <= 0) return Infinity
  let lo = 0
  let hi = 1
  // expand hi until φ(hi) < y
  while (gaPhi(hi) > y) {
    hi *= 2
    if (hi > 1e12) return hi
  }
  for (let it = 0; it < 200; it++) {
    const mid = 0.5 * (lo + hi)
    if (gaPhi(mid) > y) lo = mid
    else hi = mid
  }
  return 0.5 * (lo + hi)
}

// ---------------------------------------------------------------------------
// Channel construction — which synthetic channels carry information
// ---------------------------------------------------------------------------

export type Construction = 'bhattacharyya' | 'ga'

/**
 * Reliability of every synthetic bit-channel, in *natural* index order (index i's
 * value describes the channel decoded i-th by SC). Two flavours share one recursion
 * shape — even child = the "−" (worse) transform, odd child = the "+" (better) one:
 *
 *   Bhattacharyya (BEC(ε)):  z⁻ = 2z − z²,  z⁺ = z²  — SMALLER z is better.
 *   Gaussian-approx (AWGN):  φ(m⁻)=1−(1−φ(m))²,  m⁺ = 2m — LARGER m is better.
 *
 * Returns a `score[]` where LARGER is always more reliable (Bhattacharyya returns
 * `1 − z` so both agree), plus the raw metric for display.
 */
export interface Reliability {
  construction: Construction
  /** larger ⇒ more reliable, for ranking. */
  score: Float64Array
  /** raw metric: Bhattacharyya Z (∈[0,1]) or GA mean-LLR (≥0). */
  metric: Float64Array
}

export function bhattacharyya(n: number, epsilon: number): Reliability {
  let z = new Float64Array([Math.min(1, Math.max(0, epsilon))])
  for (let level = 0; level < n; level++) {
    const next = new Float64Array(z.length * 2)
    for (let j = 0; j < z.length; j++) {
      const zj = z[j]
      next[2 * j] = 2 * zj - zj * zj // − channel (worse)
      next[2 * j + 1] = zj * zj // + channel (better)
    }
    z = next
  }
  const score = new Float64Array(z.length)
  for (let i = 0; i < z.length; i++) score[i] = 1 - z[i]
  return { construction: 'bhattacharyya', score, metric: z }
}

export function gaussianApprox(n: number, m0: number): Reliability {
  let m = new Float64Array([Math.max(0, m0)])
  for (let level = 0; level < n; level++) {
    const next = new Float64Array(m.length * 2)
    for (let j = 0; j < m.length; j++) {
      const mj = m[j]
      const phi = gaPhi(mj)
      next[2 * j] = gaPhiInv(1 - (1 - phi) * (1 - phi)) // − channel (worse)
      next[2 * j + 1] = 2 * mj // + channel (better)
    }
    m = next
  }
  return { construction: 'ga', score: Float64Array.from(m), metric: Float64Array.from(m) }
}

/**
 * Build a reliability profile for block length N = 2ⁿ. `designSnrDb` is the design
 * Eb/N0; for the BEC construction it is mapped to a matched erasure probability, and
 * for the GA construction to the initial mean LLR m₀ = 4·R·(Eb/N0) at the target rate.
 */
export function reliability(
  n: number,
  construction: Construction,
  designSnrDb: number,
  rate: number,
): Reliability {
  const ebn0 = Math.pow(10, designSnrDb / 10)
  if (construction === 'ga') {
    const m0 = 4 * rate * ebn0
    return gaussianApprox(n, m0)
  }
  // BEC design point: use the capacity-matched erasure prob of a BI-AWGN at the
  // design SNR so the two constructions are broadly comparable. ε = 1 − C.
  const esn0 = rate * ebn0
  const eps = Math.min(0.99, Math.max(0.001, 1 - biAwgnCapacity(esn0)))
  return bhattacharyya(n, eps)
}

// ---------------------------------------------------------------------------
// The code (frozen set) built from a reliability profile
// ---------------------------------------------------------------------------

export interface PolarCode {
  n: number
  N: number
  K: number // information bits (incl. CRC)
  crc: CrcSpec
  msgLen: number // K − crc.width
  rate: number // msgLen / N (true payload rate)
  construction: Construction
  designSnrDb: number
  frozen: Uint8Array // 1 = frozen (value 0), 0 = information — natural order
  infoPos: number[] // information indices, ascending
  frozenPos: number[]
  rel: Reliability
}

/**
 * Choose the K most-reliable indices as information (the rest frozen). K includes
 * the CRC bits. Ties broken by index (deterministic).
 */
export function buildCode(
  N: number,
  K: number,
  construction: Construction,
  designSnrDb: number,
  crc: CrcSpec = CRCS[0],
): PolarCode {
  const n = log2Exact(N)
  const msgLen = K - crc.width
  if (msgLen < 0) throw new Error(`K=${K} smaller than CRC width ${crc.width}`)
  const rel = reliability(n, construction, designSnrDb, Math.max(1 / N, K / N))
  // rank indices by reliability (descending score, index tiebreak)
  const order = Array.from({ length: N }, (_, i) => i)
  order.sort((a, b) => rel.score[b] - rel.score[a] || a - b)
  const frozen = new Uint8Array(N).fill(1)
  const infoSet = new Set<number>()
  for (let i = 0; i < K; i++) infoSet.add(order[i])
  const infoPos: number[] = []
  const frozenPos: number[] = []
  for (let i = 0; i < N; i++) {
    if (infoSet.has(i)) {
      frozen[i] = 0
      infoPos.push(i)
    } else {
      frozenPos.push(i)
    }
  }
  return {
    n,
    N,
    K,
    crc,
    msgLen,
    rate: msgLen / N,
    construction,
    designSnrDb,
    frozen,
    infoPos,
    frozenPos,
    rel,
  }
}

// ---------------------------------------------------------------------------
// Encoding a message
// ---------------------------------------------------------------------------

export interface Encoded {
  u: Uint8Array // the length-N input vector (frozen=0, info=payload‖crc)
  x: Uint8Array // the codeword u·F^{⊗n}
  info: Uint8Array // the K info bits placed (payload then CRC)
}

/**
 * Place a message (length `code.msgLen`) into the information positions — appending
 * the CRC of the message when the code carries one — then apply the polar transform.
 */
export function encode(msg: ArrayLike<number>, code: PolarCode): Encoded {
  if (msg.length !== code.msgLen) throw new Error(`message must be ${code.msgLen} bits`)
  const info = new Uint8Array(code.K)
  for (let i = 0; i < code.msgLen; i++) info[i] = msg[i] & 1
  if (code.crc.width > 0) {
    const c = crcBits(info.subarray(0, code.msgLen), code.crc)
    for (let i = 0; i < code.crc.width; i++) info[code.msgLen + i] = c[i]
  }
  const u = new Uint8Array(code.N)
  for (let i = 0; i < code.infoPos.length; i++) u[code.infoPos[i]] = info[i]
  const x = polarTransform(u)
  return { u, x, info }
}

/** Extract the K info bits (payload‖CRC order) from a decoded input vector. */
export function extractInfo(u: Uint8Array, code: PolarCode): Uint8Array {
  const info = new Uint8Array(code.K)
  for (let i = 0; i < code.infoPos.length; i++) info[i] = u[code.infoPos[i]]
  return info
}

// ---------------------------------------------------------------------------
// LLR node functions
// ---------------------------------------------------------------------------

/** The check-node "box-plus": exact log-domain form, numerically stable. */
export function boxPlusExact(a: number, b: number): number {
  const s = (a < 0 ? -1 : 1) * (b < 0 ? -1 : 1)
  const m = Math.min(Math.abs(a), Math.abs(b))
  return s * m + Math.log1p(Math.exp(-Math.abs(a + b))) - Math.log1p(Math.exp(-Math.abs(a - b)))
}

/** The min-sum approximation (the hardware form): sign·sign·min|·|. */
export function boxPlusMinSum(a: number, b: number): number {
  const s = (a < 0 ? -1 : 1) * (b < 0 ? -1 : 1)
  return s * Math.min(Math.abs(a), Math.abs(b))
}

/** g-node: combine the two half-LLRs with the decided partial-sum bit u. */
function gNode(a: number, b: number, u: number): number {
  return b + (1 - 2 * u) * a
}

/** Numerically stable softplus ln(1+eᶻ). */
function softplus(z: number): number {
  return Math.max(z, 0) + Math.log1p(Math.exp(-Math.abs(z)))
}

// ---------------------------------------------------------------------------
// Successive-cancellation (SC) decoder — the recursive f/g schedule
// ---------------------------------------------------------------------------

export interface ScResult {
  u: Uint8Array // decoded input vector (frozen forced to 0)
  info: Uint8Array // extracted K info bits
  ok: boolean // CRC check (always true for a CRC-free code)
}

/**
 * Recursive SC decode. Returns the decoded vector `u`; internally each recursion
 * returns its subtree's re-encoded partial sums for the parent's g-node.
 */
export function decodeSC(llr: Float64Array, code: PolarCode, exact = true): ScResult {
  const u = new Uint8Array(code.N)
  const box = exact ? boxPlusExact : boxPlusMinSum
  const rec = (r: Float64Array, base: number): Uint8Array => {
    const len = r.length
    if (len === 1) {
      const bit = code.frozen[base] ? 0 : r[0] < 0 ? 1 : 0
      u[base] = bit
      return Uint8Array.of(bit)
    }
    const half = len >> 1
    const ll = new Float64Array(half)
    for (let i = 0; i < half; i++) ll[i] = box(r[i], r[i + half])
    const xl = rec(ll, base)
    const rr = new Float64Array(half)
    for (let i = 0; i < half; i++) rr[i] = gNode(r[i], r[i + half], xl[i])
    const xr = rec(rr, base + half)
    const x = new Uint8Array(len)
    for (let i = 0; i < half; i++) {
      x[i] = xl[i] ^ xr[i]
      x[i + half] = xr[i]
    }
    return x
  }
  rec(Float64Array.from(llr), 0)
  const info = extractInfo(u, code)
  return { u, info, ok: crcCheck(info, code.crc) }
}

// ---------------------------------------------------------------------------
// Successive-cancellation list (SCL) decoder — Tal & Vardy
// ---------------------------------------------------------------------------

export interface SclResult {
  u: Uint8Array // chosen path's decoded input vector
  info: Uint8Array // chosen path's K info bits
  ok: boolean // chosen path passed CRC
  listSize: number
  /** every survivor's (pm, info, crcOk), best metric first — for the UI list view. */
  survivors: { pm: number; info: Uint8Array; crcOk: boolean }[]
  /** the pm-best path (ignoring CRC), to contrast with the CRC-selected one. */
  bestByMetric: Uint8Array
}

/**
 * SCL decode keeping the L lowest-metric paths. Each information bit forks every
 * surviving path into its 0- and 1-continuation; the paths are ranked by the LLR
 * path metric  PM ← PM + ln(1 + e^{−(1−2û)·L})  and pruned back to L. With a CRC the
 * returned path is the lowest-metric survivor whose info bits satisfy the CRC.
 *
 * Implemented as a recursion that carries, for every live path, the LLRs of the
 * current sub-block; a fork returns a `survivor[]` map (new-path → parent) that each
 * frame applies to remap its own state, so the whole list shares one f/g schedule.
 */
export function decodeSCL(
  llr: Float64Array,
  code: PolarCode,
  L: number,
  exact = true,
): SclResult {
  const box = exact ? boxPlusExact : boxPlusMinSum
  // Live path state: path metric and the decoded input vector so far.
  let pm: number[] = [0]
  let uMat: Uint8Array[] = [new Uint8Array(code.N)]

  const remapBits = (arr: Uint8Array[], survivor: number[]): Uint8Array[] =>
    survivor.map((p) => Uint8Array.from(arr[p]))
  const remapLlr = (arr: Float64Array[], survivor: number[]): Float64Array[] =>
    survivor.map((p) => Float64Array.from(arr[p]))

  // Returns { out: per-path re-encoded partial sums, survivor: newPath→oldPath }.
  const rec = (
    llrs: Float64Array[],
    base: number,
  ): { out: Uint8Array[]; survivor: number[] } => {
    const P = llrs.length
    const len = llrs[0].length
    if (len === 1) {
      if (code.frozen[base]) {
        const out: Uint8Array[] = []
        for (let p = 0; p < P; p++) {
          pm[p] += softplus(-llrs[p][0]) // forced bit 0
          uMat[p][base] = 0
          out.push(Uint8Array.of(0))
        }
        return { out, survivor: Array.from({ length: P }, (_, p) => p) }
      }
      // fork every path into bit 0 / bit 1
      const cand: { parent: number; bit: number; pm: number }[] = []
      for (let p = 0; p < P; p++) {
        cand.push({ parent: p, bit: 0, pm: pm[p] + softplus(-llrs[p][0]) })
        cand.push({ parent: p, bit: 1, pm: pm[p] + softplus(llrs[p][0]) })
      }
      cand.sort((a, b) => a.pm - b.pm)
      const keep = cand.slice(0, Math.min(L, cand.length))
      const survivor = keep.map((c) => c.parent)
      const newPm = keep.map((c) => c.pm)
      const newU = keep.map((c) => {
        const v = Uint8Array.from(uMat[c.parent])
        v[base] = c.bit
        return v
      })
      pm = newPm
      uMat = newU
      const out = keep.map((c) => Uint8Array.of(c.bit))
      return { out, survivor }
    }
    const half = len >> 1
    // left LLRs via f
    const llrL = llrs.map((r) => {
      const o = new Float64Array(half)
      for (let i = 0; i < half; i++) o[i] = box(r[i], r[i + half])
      return o
    })
    const r1 = rec(llrL, base)
    // remap this frame's parent LLRs onto the post-left path set
    const parent = remapLlr(llrs, r1.survivor)
    let xL = r1.out // already in the post-left path set
    // right LLRs via g, using the left subtree's partial sums
    const llrR = parent.map((r, idx) => {
      const o = new Float64Array(half)
      for (let i = 0; i < half; i++) o[i] = gNode(r[i], r[i + half], xL[idx][i])
      return o
    })
    const r2 = rec(llrR, base + half)
    // remap left outputs onto the post-right path set, then combine
    xL = remapBits(xL, r2.survivor)
    const xR = r2.out
    const out = xR.map((xr, idx) => {
      const x = new Uint8Array(len)
      const xl = xL[idx]
      for (let i = 0; i < half; i++) {
        x[i] = xl[i] ^ xr[i]
        x[i + half] = xr[i]
      }
      return x
    })
    // compose survivor maps: newPath → (post-left) → (pre-call)
    const survivor = r2.survivor.map((k) => r1.survivor[k])
    return { out, survivor }
  }

  rec([Float64Array.from(llr)], 0)

  // rank survivors, apply CRC selection
  const idx = Array.from({ length: pm.length }, (_, i) => i).sort((a, b) => pm[a] - pm[b])
  const survivors = idx.map((i) => {
    const info = extractInfo(uMat[i], code)
    return { pm: pm[i], info, crcOk: crcCheck(info, code.crc) }
  })
  const bestByMetric = Uint8Array.from(uMat[idx[0]])
  // CRC-aided pick: first (lowest-pm) survivor that checks; else the pm-best.
  let chosen = idx[0]
  if (code.crc.width > 0) {
    const good = idx.find((i) => crcCheck(extractInfo(uMat[i], code), code.crc))
    if (good !== undefined) chosen = good
  }
  const u = Uint8Array.from(uMat[chosen])
  const info = extractInfo(u, code)
  return {
    u,
    info,
    ok: crcCheck(info, code.crc),
    listSize: pm.length,
    survivors,
    bestByMetric,
  }
}

// ---------------------------------------------------------------------------
// BI-AWGN channel capacity (the yardstick)
// ---------------------------------------------------------------------------

/**
 * Capacity of the binary-input AWGN channel at Es/N0 (linear), Es = 1, in
 * bits/channel-use. C = 1 − E_t[ log2(1 + e^{−2(1+σt)/σ²}) ], t ~ N(0,1), computed by
 * composite Simpson over t ∈ [−8, 8].
 */
export function biAwgnCapacity(esn0Lin: number): number {
  if (esn0Lin <= 0) return 0
  const sigma2 = 1 / (2 * esn0Lin)
  const sigma = Math.sqrt(sigma2)
  const f = (t: number): number => {
    const g = Math.exp(-0.5 * t * t) / Math.sqrt(2 * Math.PI) // N(0,1) pdf
    const arg = (-2 * (1 + sigma * t)) / sigma2
    return g * Math.log2(1 + Math.exp(arg))
  }
  const a = -8
  const b = 8
  const m = 2000 // even
  const h = (b - a) / m
  let s = f(a) + f(b)
  for (let i = 1; i < m; i++) s += (i % 2 ? 4 : 2) * f(a + i * h)
  const integral = (h / 3) * s
  return Math.min(1, Math.max(0, 1 - integral))
}

/**
 * Symmetric capacity of a bit-channel whose LLR is a consistent Gaussian of mean m
 * (variance 2m): C = 1 − E[log2(1+e^{−L})], L ~ N(m, 2m), by composite Simpson. Maps
 * the Gaussian-approximation reliability onto the same [0,1] axis as the BEC's 1−Z.
 */
export function capacityFromMeanLLR(m: number): number {
  if (m <= 0) return 0
  const sd = Math.sqrt(2 * m)
  const f = (t: number): number => {
    const g = Math.exp(-0.5 * t * t) / Math.sqrt(2 * Math.PI)
    return g * Math.log2(1 + Math.exp(-(m + sd * t)))
  }
  const a = -8
  const b = 8
  const M = 800
  const h = (b - a) / M
  let s = f(a) + f(b)
  for (let i = 1; i < M; i++) s += (i % 2 ? 4 : 2) * f(a + i * h)
  return Math.min(1, Math.max(0, 1 - (h / 3) * s))
}

/** Per-channel symmetric capacity in [0,1] from a reliability profile. */
export function channelCapacities(rel: Reliability): Float64Array {
  const c = new Float64Array(rel.metric.length)
  if (rel.construction === 'bhattacharyya') {
    for (let i = 0; i < c.length; i++) c[i] = 1 - rel.metric[i]
  } else {
    for (let i = 0; i < c.length; i++) c[i] = capacityFromMeanLLR(rel.metric[i])
  }
  return c
}

/** The Eb/N0 (dB) Shannon limit for a binary-input code of the given rate. */
export function biAwgnLimitDb(rate: number): number {
  // find Eb/N0 s.t. C(rate·Eb/N0) = rate  (bisection on Es/N0)
  let lo = 1e-4
  let hi = 1e4
  for (let it = 0; it < 200; it++) {
    const mid = Math.sqrt(lo * hi)
    if (biAwgnCapacity(mid) < rate) lo = mid
    else hi = mid
  }
  const esn0 = Math.sqrt(lo * hi)
  const ebn0 = esn0 / rate
  return 10 * Math.log10(ebn0)
}

// ---------------------------------------------------------------------------
// Monte-Carlo link (BPSK over AWGN)
// ---------------------------------------------------------------------------

export type DecoderKind = 'sc' | 'scl' | 'ca-scl'

export interface DecoderSpec {
  id: string
  label: string
  kind: DecoderKind
  L: number
}

/**
 * One decode of a random message at a given Eb/N0. Returns bit/block error against
 * the transmitted message payload (CRC bits excluded from the payload BER).
 */
export function simulateBlock(
  code: PolarCode,
  ebn0Db: number,
  decoder: { kind: DecoderKind; L: number },
  exact: boolean,
  rng: () => number,
): { bitErrors: number; blockError: boolean } {
  const msg = new Uint8Array(code.msgLen)
  for (let i = 0; i < code.msgLen; i++) msg[i] = rng() < 0.5 ? 0 : 1
  const { x } = encode(msg, code)
  // BPSK: bit 0 → +1, bit 1 → −1. Rate for Eb/N0 uses the true payload rate.
  const R = Math.max(1e-6, code.rate)
  const sigma = ebn0ToSigma(ebn0Db + 10 * Math.log10(R), 1) // Es/N0 = R·Eb/N0
  const N = code.N
  const llr = new Float64Array(N)
  const inv = 1 / (sigma * sigma)
  for (let i = 0; i < N; i++) {
    const s = x[i] === 0 ? 1 : -1
    const y = s + sigma * gaussian(rng)
    llr[i] = 2 * y * inv // LLR = 2y/σ²
  }
  let info: Uint8Array
  if (decoder.kind === 'sc') info = decodeSC(llr, code, exact).info
  else info = decodeSCL(llr, code, decoder.L, exact).info
  let bitErrors = 0
  for (let i = 0; i < code.msgLen; i++) if (info[i] !== msg[i]) bitErrors++
  return { bitErrors, blockError: bitErrors > 0 }
}

export interface WaterfallPoint {
  ebn0Db: number
  blocks: number
  blockErrors: number
  bitErrors: number
  bler: number
  ber: number
}

export interface WaterfallBudget {
  minBlocks: number
  maxBlocks: number
  targetBlockErrors: number
  seed: number
}

/**
 * Sweep Eb/N0, accumulating blocks until either the target number of block errors or
 * the block cap is reached (adaptive so high-SNR points don't run forever).
 */
export function waterfall(
  code: PolarCode,
  decoder: { kind: DecoderKind; L: number },
  ebn0List: number[],
  exact: boolean,
  budget: WaterfallBudget,
): WaterfallPoint[] {
  return ebn0List.map((ebn0Db, pi) => {
    const rng = mulberry32(budget.seed + pi * 7919 + 1)
    let blocks = 0
    let blockErrors = 0
    let bitErrors = 0
    while (blocks < budget.maxBlocks) {
      const r = simulateBlock(code, ebn0Db, decoder, exact, rng)
      blocks++
      if (r.blockError) blockErrors++
      bitErrors += r.bitErrors
      if (blocks >= budget.minBlocks && blockErrors >= budget.targetBlockErrors) break
    }
    return {
      ebn0Db,
      blocks,
      blockErrors,
      bitErrors,
      bler: blockErrors / blocks,
      ber: bitErrors / (blocks * code.msgLen),
    }
  })
}

/** Uncoded BPSK BER at Eb/N0 (dB) — the reference floor. */
export function uncodedBer(ebn0Db: number): number {
  const gamma = Math.pow(10, ebn0Db / 10)
  // Q(√(2·Eb/N0)) via erfc
  return 0.5 * erfc(Math.sqrt(gamma))
}

function erfc(x: number): number {
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
                            t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    )
  return x >= 0 ? ans : 2 - ans
}
