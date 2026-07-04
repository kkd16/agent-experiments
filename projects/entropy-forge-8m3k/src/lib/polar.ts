// polar.ts — Polar codes: the first provably CAPACITY-ACHIEVING codes, and the
// error-correcting code standardised for the 5G-NR control channel (the sibling
// of LDPC, which carries 5G's data). Arıkan's 2009 construction is the other
// half of the channel-coding story this lab tells — where LDPC *approaches*
// capacity with a clever sparse graph, Polar codes *reach* it with a recursive
// algebraic transform and an exact, ML-flavoured sequential decoder.
//
// THE IDEA — channel polarisation. Take two copies of a channel W and combine
// them with the 2×2 kernel F = [[1,0],[1,1]] (u → x with x0 = u0⊕u1, x1 = u1).
// Split the result back into two *synthetic* channels seen by u0 and u1: the one
// for u0 (decoded first, from both received symbols) is WORSE than W; the one for
// u1 (decoded knowing u0) is BETTER. Recurse this n times over N = 2ⁿ copies and
// the synthetic channels POLARISE: a fraction → C(W) become perfect (capacity 1)
// and the rest → 0 become useless. Send data on the good ones, freeze the bad
// ones to a known value (0). As N→∞ the good fraction → the channel capacity C,
// so the code achieves capacity — Shannon's promise, made constructive.
//
// THE TRANSFORM is Gₙ = F⊗ⁿ (the n-fold Kronecker power), computed by an in-place
// butterfly identical in shape to an FFT — O(N log N), no matrix. The DECODER is
// Successive Cancellation (SC): a depth-first recursion over the same butterfly
// that turns channel log-likelihood ratios into a hard decision per bit, feeding
// each decided bit forward as it goes. SC-List (SCL) keeps the L most-likely
// partial decodings instead of one, and CRC-aided SCL — the 5G decoder — appends
// a CRC to the message and lets the list pick the survivor that checks out,
// which is what lifts Polar codes past LDPC at short block lengths.
//
// Everything is in the LLR domain L = log P(bit=0)/P(bit=1) (positive ⇒ 0 more
// likely), the SAME convention the channel model and the LDPC decoder use, so a
// received word flows straight from channel.ts into any decoder here.

// ------------------------------------------------------------------ kernels --

/** Check-node ("−", worse channel) LLR combine — the min-sum approximation of
 *  2·atanh(tanh(a/2)·tanh(b/2)): sign product times the smaller magnitude. This
 *  is the hardware-standard SC update and pairs exactly with the |λ| path metric
 *  used by the list decoder below. */
function fMin(a: number, b: number): number {
  const sa = a < 0 ? -1 : 1
  const sb = b < 0 ? -1 : 1
  const m = Math.min(Math.abs(a), Math.abs(b))
  return sa * sb * m
}

/** Variable-node ("+", better channel) LLR combine given the already-decoded
 *  partial-sum bit c: repetition of the two LLRs, one flipped by the known bit.
 *  c=0 ⇒ a+b, c=1 ⇒ b−a. */
function gLLR(a: number, b: number, c: number): number {
  return c ? b - a : b + a
}

// --------------------------------------------------------------- the transform

/**
 * The polar transform x = u·Gₙ over GF(2), Gₙ = F⊗ⁿ in NON-bit-reversed order,
 * computed in place by the log₂N-stage butterfly. This is the encoder core: put
 * the message on the info positions of u, zeros on the frozen positions, and this
 * returns the codeword. `u.length` must be a power of two.
 */
export function polarTransform(u: ArrayLike<number>): Uint8Array {
  const N = u.length
  const x = new Uint8Array(N)
  for (let i = 0; i < N; i++) x[i] = u[i] & 1
  for (let len = 1; len < N; len <<= 1) {
    for (let i = 0; i < N; i += len << 1) {
      for (let j = 0; j < len; j++) x[i + j] ^= x[i + j + len]
    }
  }
  return x
}

// -------------------------------------------------------------- construction --
//
// "Constructing" a polar code = ranking the N synthetic bit-channels by
// reliability and freezing the worst N−K. Two classic reliability metrics, both
// following the SAME recursion tree as the transform (child 2i = the worse "−"
// channel, child 2i+1 = the better "+" channel — an ordering that coincides
// exactly with the natural bit index the SC decoder decides), so the resulting
// index is directly the u-index the encoder/decoder use.

/**
 * Bhattacharyya parameters Z for the N = 2ⁿ bit-channels of a Binary Erasure
 * Channel with erasure probability ε — the ONE channel where polar construction
 * is exact and closed-form (Arıkan 2009): Z(W⁻) = 2Z − Z², Z(W⁺) = Z². For the
 * BEC the symmetric capacity is exactly I = 1 − Z, so this doubles as the
 * per-channel capacity used by the polarisation plot. Lower Z ⇒ more reliable.
 */
export function bhattacharyyaBEC(n: number, eps: number): Float64Array {
  let z = new Float64Array([eps])
  for (let level = 0; level < n; level++) {
    const next = new Float64Array(z.length * 2)
    for (let i = 0; i < z.length; i++) {
      const zi = z[i]
      next[2 * i] = 2 * zi - zi * zi // W⁻ (worse)
      next[2 * i + 1] = zi * zi // W⁺ (better)
    }
    z = next
  }
  return z
}

/** The φ function of the Gaussian-approximation construction (Chung–Richardson–
 *  Urbanke): φ(x) = E[tanh(U/2)] for U~N(x,2x), monotone-decreasing from φ(0)=1
 *  to φ(∞)=0, with the standard piecewise closed-form approximation. */
function phi(x: number): number {
  if (x <= 0) return 1
  if (x < 10) return Math.exp(-0.4527 * Math.pow(x, 0.859) + 0.0218)
  return Math.sqrt(Math.PI / x) * Math.exp(-x / 4) * (1 - 10 / (7 * x))
}

/** Inverse of φ by bisection (φ is strictly decreasing on x>0). Input in (0,1]. */
function phiInv(y: number): number {
  if (y >= 1) return 0
  if (y <= 0) return 1e9
  let lo = 0
  let hi = 1
  while (phi(hi) > y) {
    hi *= 2
    if (hi > 1e9) return 1e9
  }
  for (let it = 0; it < 60; it++) {
    const mid = 0.5 * (lo + hi)
    if (phi(mid) > y) lo = mid
    else hi = mid
  }
  return 0.5 * (lo + hi)
}

/**
 * Gaussian-approximation (GA) reliability for the BI-AWGN channel: track the MEAN
 * LLR of each synthetic channel through the density-evolution recursion under the
 * consistent-Gaussian assumption. The variable-node ("+") mean adds (2m); the
 * check-node ("−") mean is φ⁻¹(1 − (1 − φ(m))²). Higher mean ⇒ more reliable.
 * `meanInit` is the channel LLR mean E[L] = 2/σ² = 4·(Es/N0) at the design point.
 */
export function gaMeans(n: number, meanInit: number): Float64Array {
  let m = new Float64Array([meanInit])
  for (let level = 0; level < n; level++) {
    const next = new Float64Array(m.length * 2)
    for (let i = 0; i < m.length; i++) {
      const mi = m[i]
      const p = phi(mi)
      next[2 * i] = phiInv(1 - (1 - p) * (1 - p)) // W⁻ (worse)
      next[2 * i + 1] = 2 * mi // W⁺ (better)
    }
    m = next
  }
  return m
}

export type PolarConstruction = 'ga' | 'bec'

export interface PolarCode {
  N: number
  K: number
  n: number
  frozen: Uint8Array // length N, 1 = frozen (forced to 0), 0 = carries a message bit
  infoPos: number[] // the K info bit-indices, ascending — where the message rides
  reliability: number[] // channel indices, MOST reliable first (length N)
  metric: Float64Array // per-channel reliability metric (Z for bec, mean for ga)
  construction: PolarConstruction
  designSnrDb?: number
  eps?: number
}

/**
 * Construct an (N,K) polar code: rank the N channels by the chosen metric and
 * freeze the least reliable N−K. `designSnrDb` is the Eb/N0 the GA construction
 * is tuned for (rate R = K/N folded in); `eps` is the BEC erasure probability.
 */
export function constructPolar(
  N: number,
  K: number,
  opts: { construction?: PolarConstruction; designSnrDb?: number; eps?: number } = {},
): PolarCode {
  const n = Math.round(Math.log2(N))
  if (1 << n !== N) throw new Error('N must be a power of two')
  if (K < 0 || K > N) throw new Error('K out of range')
  const construction = opts.construction ?? 'ga'
  const rate = K / N

  let metric: Float64Array
  // Higher `score` = more reliable. For BEC we score by −Z (small Z is good);
  // for GA we score by the mean LLR directly.
  let score: (i: number) => number
  if (construction === 'bec') {
    const eps = opts.eps ?? 0.5
    metric = bhattacharyyaBEC(n, eps)
    score = (i) => -metric[i]
  } else {
    const ebno = Math.pow(10, (opts.designSnrDb ?? 2) / 10)
    const esno = rate * ebno
    const meanInit = 4 * esno // 2/σ², σ² = 1/(2·Es/N0)
    metric = gaMeans(n, meanInit)
    score = (i) => metric[i]
  }

  const reliability = Array.from({ length: N }, (_, i) => i).sort((a, b) => score(b) - score(a))
  const frozen = new Uint8Array(N).fill(1)
  const infoSet = reliability.slice(0, K)
  for (const i of infoSet) frozen[i] = 0
  const infoPos = infoSet.slice().sort((a, b) => a - b)

  return {
    N,
    K,
    n,
    frozen,
    infoPos,
    reliability,
    metric,
    construction,
    designSnrDb: opts.designSnrDb,
    eps: opts.eps,
  }
}

// ------------------------------------------------------------------- encoding

/** Place the K message bits on the info positions (in ascending index order) and
 *  run the polar transform. Returns the N-bit codeword. */
export function polarEncode(code: PolarCode, msg: ArrayLike<number>): Uint8Array {
  const u = new Uint8Array(code.N)
  for (let i = 0; i < code.K; i++) u[code.infoPos[i]] = msg[i] & 1
  return polarTransform(u)
}

/** Read the message bits out of a decoded u-vector at the info positions. */
export function polarExtract(code: PolarCode, uhat: ArrayLike<number>): number[] {
  return code.infoPos.map((p) => uhat[p] & 1)
}

// ------------------------------------------------------- successive cancellation

export interface ScResult {
  uhat: Uint8Array // the full decoded u-vector (frozen positions are 0)
  message: number[] // the K info bits
}

/**
 * Successive-Cancellation decode from per-bit channel LLRs. A depth-first
 * recursion over the transform butterfly: the "−" combine feeds the upper half,
 * its decoded partial sums steer the "+" combine into the lower half, and the two
 * are stitched back together on the way up. Frozen leaves decide 0; info leaves
 * decide by the sign of their LLR. O(N log N). This is the L=1 case of `sclDecode`
 * and serves as its correctness oracle.
 */
export function scDecode(code: PolarCode, llr: ArrayLike<number>): ScResult {
  const N = code.N
  const uhat = new Uint8Array(N)
  const frozen = code.frozen

  function rec(a: Float64Array, off: number): Uint8Array {
    const m = a.length
    if (m === 1) {
      const bit = frozen[off] ? 0 : a[0] < 0 ? 1 : 0
      uhat[off] = bit
      return Uint8Array.of(bit)
    }
    const half = m >> 1
    const lUp = new Float64Array(half)
    for (let i = 0; i < half; i++) lUp[i] = fMin(a[i], a[i + half])
    const u1 = rec(lUp, off)
    const lLo = new Float64Array(half)
    for (let i = 0; i < half; i++) lLo[i] = gLLR(a[i], a[i + half], u1[i])
    const u2 = rec(lLo, off + half)
    const x = new Uint8Array(m)
    for (let i = 0; i < half; i++) {
      x[i] = u1[i] ^ u2[i]
      x[i + half] = u2[i]
    }
    return x
  }

  const root = new Float64Array(N)
  for (let i = 0; i < N; i++) root[i] = llr[i]
  rec(root, 0)
  return { uhat, message: polarExtract(code, uhat) }
}

// --------------------------------------------------------- SC-List decoding ---

/** ln(1 + e^{−(1−2b)·λ}) — the exact per-bit path-metric increment for deciding
 *  bit b against an LLR λ, computed in a numerically stable way. Deciding with the
 *  LLR sign costs ≈0; deciding against it costs ≈|λ|. */
function pathMetricInc(lambda: number, b: number): number {
  const s = (1 - 2 * b) * lambda
  return s >= 0 ? Math.log1p(Math.exp(-s)) : -s + Math.log1p(Math.exp(s))
}

interface Path {
  pm: number
  uhat: Uint8Array
  stack: (Float64Array | undefined)[] // LLRs by recursion depth
  psum: (Uint8Array | undefined)[] // saved upper-subtree partial sums by depth
  x: Uint8Array // partial sums of the subtree just decoded
}

export interface SclResult {
  uhat: Uint8Array
  message: number[]
  listSize: number
  crcPassed: boolean // whether a CRC-valid survivor was found (CA-SCL only)
}

/**
 * Successive-Cancellation LIST decode: run L parallel SC decoders that fork at
 * every info bit (trying 0 and 1), keep the L partial decodings of lowest path
 * metric, and pick the best survivor at the end. With a `crc` spec it becomes
 * CRC-aided SCL — the 5G decoder — choosing the lowest-metric survivor whose
 * message passes the CRC, which is what makes short polar codes beat LDPC.
 *
 * Memory is held per path as depth-indexed stacks of LLRs and partial sums,
 * eager-copied on each fork (O(N) per fork) — simpler than Tal–Vardy's lazy copy
 * and plenty fast for the block lengths this lab explores.
 */
export function sclDecode(
  code: PolarCode,
  llr: ArrayLike<number>,
  L: number,
  crc?: CrcSpec,
): SclResult {
  const N = code.N
  const frozen = code.frozen
  const root = new Float64Array(N)
  for (let i = 0; i < N; i++) root[i] = llr[i]

  let paths: Path[] = [
    { pm: 0, uhat: new Uint8Array(N), stack: [root], psum: [], x: new Uint8Array(0) },
  ]

  function rec(depth: number, m: number, off: number): void {
    if (m === 1) {
      if (frozen[off]) {
        for (const p of paths) {
          const lam = p.stack[depth]![0]
          p.pm += pathMetricInc(lam, 0)
          p.uhat[off] = 0
          p.x = Uint8Array.of(0)
        }
        return
      }
      // Info leaf: fork every surviving path into b=0 and b=1, keep the best L.
      const cand: { parent: Path; b: number; pm: number }[] = []
      for (const p of paths) {
        const lam = p.stack[depth]![0]
        cand.push({ parent: p, b: 0, pm: p.pm + pathMetricInc(lam, 0) })
        cand.push({ parent: p, b: 1, pm: p.pm + pathMetricInc(lam, 1) })
      }
      cand.sort((u, v) => u.pm - v.pm)
      const keep = cand.slice(0, L)
      const next: Path[] = []
      for (const c of keep) {
        const np: Path = {
          pm: c.pm,
          uhat: c.parent.uhat.slice(),
          stack: c.parent.stack.slice(),
          psum: c.parent.psum.slice(),
          x: Uint8Array.of(c.b),
        }
        np.uhat[off] = c.b
        next.push(np)
      }
      paths = next
      return
    }
    const half = m >> 1
    // Down the "−" branch (upper half).
    for (const p of paths) {
      const a = p.stack[depth]!
      const up = new Float64Array(half)
      for (let i = 0; i < half; i++) up[i] = fMin(a[i], a[i + half])
      p.stack[depth + 1] = up
    }
    rec(depth + 1, half, off)
    // Down the "+" branch (lower half), steered by the upper partial sums u1.
    for (const p of paths) {
      const a = p.stack[depth]!
      const u1 = p.x
      const lo = new Float64Array(half)
      for (let i = 0; i < half; i++) lo[i] = gLLR(a[i], a[i + half], u1[i])
      p.stack[depth + 1] = lo
      p.psum[depth] = u1 // preserved across the fork inside the "+" recursion
    }
    rec(depth + 1, half, off + half)
    // Stitch the two subtrees' partial sums back together for the parent.
    for (const p of paths) {
      const u1 = p.psum[depth]!
      const u2 = p.x
      const x = new Uint8Array(m)
      for (let i = 0; i < half; i++) {
        x[i] = u1[i] ^ u2[i]
        x[i + half] = u2[i]
      }
      p.x = x
    }
  }

  rec(0, N, 0)
  paths.sort((u, v) => u.pm - v.pm)

  let crcPassed = false
  let chosen = paths[0]
  if (crc) {
    for (const p of paths) {
      const msg = polarExtract(code, p.uhat)
      if (crcValid(msg, crc)) {
        chosen = p
        crcPassed = true
        break
      }
    }
  }
  return {
    uhat: chosen.uhat,
    message: polarExtract(code, chosen.uhat),
    listSize: L,
    crcPassed,
  }
}

// ----------------------------------------------------------------------- CRC --
//
// A small bit-wise CRC for CRC-aided SCL. The message carried by the info
// positions is [payload | crc(payload)]; the list decoder keeps only survivors
// whose trailing CRC recomputes from their payload — a cheap outer check that
// rescues the correct codeword even when it wasn't the minimum-metric path.

export interface CrcSpec {
  width: number
  poly: number // width-bit generator (implicit leading 1 omitted), e.g. 0x07 for CRC-8
}

/** Common short CRCs. 5G-NR polar uses CRC-11/CRC-6; CRC-8 is a fine demo pick. */
export const CRC8: CrcSpec = { width: 8, poly: 0x07 } // x⁸+x²+x+1 (CRC-8/CCITT)
export const CRC6: CrcSpec = { width: 6, poly: 0x03 } // x⁶+x+1

/** Compute the `width`-bit CRC of a bit array (MSB-first, no reflection). */
export function crcBits(bits: ArrayLike<number>, spec: CrcSpec): number[] {
  const w = spec.width
  let reg = 0
  const topMask = (1 << w) - 1
  for (let i = 0; i < bits.length; i++) {
    const inBit = bits[i] & 1
    const top = (reg >>> (w - 1)) & 1
    reg = ((reg << 1) & topMask) | 0
    if (top ^ inBit) reg ^= spec.poly
  }
  // Flush w zero bits so every message bit influences the register.
  for (let i = 0; i < w; i++) {
    const top = (reg >>> (w - 1)) & 1
    reg = (reg << 1) & topMask
    if (top) reg ^= spec.poly
  }
  const out: number[] = []
  for (let i = w - 1; i >= 0; i--) out.push((reg >>> i) & 1)
  return out
}

/** Build the info-bit vector [payload | CRC(payload)] for CRC-aided coding. */
export function appendCrc(payload: ArrayLike<number>, spec: CrcSpec): number[] {
  const p = Array.from(payload, (b) => b & 1)
  return p.concat(crcBits(p, spec))
}

/** Check a decoded info vector's trailing CRC against its payload. */
export function crcValid(info: ArrayLike<number>, spec: CrcSpec): boolean {
  const K = info.length
  if (K < spec.width) return false
  const payload: number[] = []
  for (let i = 0; i < K - spec.width; i++) payload.push(info[i] & 1)
  const expect = crcBits(payload, spec)
  for (let i = 0; i < spec.width; i++) if ((info[K - spec.width + i] & 1) !== expect[i]) return false
  return true
}

// --------------------------------------------------------------- presets ------

/** A handful of ready-made codes for the lab pages and the self-test. */
export const POLAR_16_8 = constructPolar(16, 8, { construction: 'ga', designSnrDb: 2 })
export const POLAR_64_32 = constructPolar(64, 32, { construction: 'ga', designSnrDb: 2 })
export const POLAR_128_64 = constructPolar(128, 64, { construction: 'ga', designSnrDb: 2.5 })
export const POLAR_256_128 = constructPolar(256, 128, { construction: 'ga', designSnrDb: 2.5 })
