// Forward error correction — the convolutional-code and Viterbi-decoder core
// behind the Coding lab. Everything here is from scratch: a feed-forward
// convolutional encoder over an octal generator set, hard- AND soft-decision
// Viterbi maximum-likelihood decoding (add–compare–select + traceback),
// rate-compatible PUNCTURING, and the code's DISTANCE SPECTRUM enumerated from
// the trellis so the union-bound BER can be drawn as a closed-form oracle beside
// the measured Monte-Carlo curve. No libraries.
//
// Conventions
// -----------
// A rate-1/n code shifts one input bit u_t into a K-bit register per step, where
// K is the constraint length. The register is `full = (u_t << (K-1)) | state`,
// state being the K-1 previous inputs with its MSB the most-recent one. Each
// generator g (given in OCTAL, MSB = tap on the current input u_t — the MATLAB
// `poly2trellis` convention) produces one output bit = parity(full & g). The next
// state is `full >> 1`. BPSK carries a coded bit b as the amplitude 1-2b (bit
// 0 → +1, bit 1 → −1), matching the Modem lab's BPSK.

import { qfunc, mulberry32, gaussian } from './comms'

export { mulberry32, gaussian }

// --- code catalogue -------------------------------------------------------------

export interface ConvCode {
  id: string
  label: string
  /** constraint length K (register width; memory = K−1). */
  K: number
  /** generator polynomials in octal (one per output bit). */
  gensOctal: number[]
  /** short human note (the code's provenance / d_free). */
  note: string
}

// Classic, textbook feed-forward codes. All are non-catastrophic and
// optimum-distance-profile for their (K, rate). d_free values are the published
// ones and are re-derived at runtime by `distanceSpectrum`.
export const CONV_CODES: ConvCode[] = [
  { id: 'k3_r12', label: 'K=3, rate 1/2 (7,5)', K: 3, gensOctal: [0o7, 0o5], note: 'the classic 4-state teaching code, d_free = 5' },
  { id: 'k4_r12', label: 'K=4, rate 1/2 (15,17)', K: 4, gensOctal: [0o15, 0o17], note: '8-state, d_free = 6' },
  { id: 'k5_r12', label: 'K=5, rate 1/2 (23,35)', K: 5, gensOctal: [0o23, 0o35], note: '16-state, d_free = 7' },
  { id: 'k7_r12', label: 'K=7, rate 1/2 (171,133)', K: 7, gensOctal: [0o171, 0o133], note: 'the industry standard (Voyager, 802.11, GSM), d_free = 10' },
  { id: 'k7_r13', label: 'K=7, rate 1/3 (171,133,165)', K: 7, gensOctal: [0o171, 0o133, 0o165], note: 'the rate-1/3 deep-space code, d_free = 15' },
]

export function codeById(id: string): ConvCode {
  const c = CONV_CODES.find((x) => x.id === id)
  if (!c) throw new Error(`unknown code ${id}`)
  return c
}

// --- trellis --------------------------------------------------------------------

export interface Branch {
  /** state reached after this input. */
  nextState: number
  /** the n output bits (MSB = generator 0), as a small array. */
  out: number[]
  /** the n output bits packed into an integer (out[0] most significant). */
  outSym: number
  /** Hamming weight of the output (number of 1s). */
  outWeight: number
}

export interface Trellis {
  code: ConvCode
  /** outputs per input bit, n = number of generators (so the rate is 1/n). */
  n: number
  numStates: number
  /** branch[state][input] for input ∈ {0,1}. */
  branch: Branch[][]
}

function parity(x: number): number {
  let p = 0
  while (x) {
    p ^= 1
    x &= x - 1
  }
  return p
}

function popcount(x: number): number {
  let c = 0
  while (x) {
    c++
    x &= x - 1
  }
  return c
}

/** Build the full branch table for a convolutional code. */
export function buildTrellis(code: ConvCode): Trellis {
  const { K, gensOctal } = code
  const n = gensOctal.length
  const numStates = 1 << (K - 1)
  const branch: Branch[][] = []
  for (let state = 0; state < numStates; state++) {
    branch[state] = []
    for (let input = 0; input < 2; input++) {
      const full = (input << (K - 1)) | state
      const out: number[] = []
      let outSym = 0
      for (let j = 0; j < n; j++) {
        const b = parity(full & gensOctal[j])
        out.push(b)
        outSym = (outSym << 1) | b
      }
      const nextState = full >> 1
      branch[state][input] = { nextState, out, outSym, outWeight: popcount(outSym) }
    }
  }
  return { code, n, numStates, branch }
}

// --- encoding -------------------------------------------------------------------

/**
 * Encode message bits with a rate-1/n convolutional code, zero-terminated: K−1
 * trailing zero bits flush the register back to state 0 so the decoder's
 * traceback has a known endpoint. Returns `n·(msgLen + K − 1)` coded bits.
 */
export function convEncode(msg: ArrayLike<number>, tr: Trellis): Uint8Array {
  const { K } = tr.code
  const tail = K - 1
  const steps = msg.length + tail
  const out = new Uint8Array(steps * tr.n)
  let state = 0
  let w = 0
  for (let t = 0; t < steps; t++) {
    const input = t < msg.length ? msg[t] & 1 : 0
    const br = tr.branch[state][input]
    for (let j = 0; j < tr.n; j++) out[w++] = br.out[j]
    state = br.nextState
  }
  return out
}

// --- puncturing -----------------------------------------------------------------
//
// A puncture matrix keeps only some of the mother code's output bits to raise the
// rate. It is n rows (one per generator) × P columns (the period); a 0 deletes
// that output bit. These are the standard rate-compatible patterns (IEEE 802.11 /
// DVB) built on the (171,133) rate-1/2 mother.

export interface Puncture {
  id: string
  label: string
  /** required n (number of generators) this pattern applies to. */
  n: number
  /** the pattern: pattern[j][c] ∈ {0,1}, j over outputs, c over the period. */
  pattern: number[][]
}

export const PUNCTURES: Puncture[] = [
  { id: 'none', label: 'none (rate 1/2)', n: 2, pattern: [[1], [1]] },
  { id: 'r23', label: 'rate 2/3', n: 2, pattern: [[1, 1], [1, 0]] },
  { id: 'r34', label: 'rate 3/4', n: 2, pattern: [[1, 1, 0], [1, 0, 1]] },
  { id: 'r56', label: 'rate 5/6', n: 2, pattern: [[1, 1, 0, 1, 0], [1, 0, 1, 0, 1]] },
]

export function punctureById(id: string): Puncture {
  const p = PUNCTURES.find((x) => x.id === id)
  if (!p) throw new Error(`unknown puncture ${id}`)
  return p
}

/** The code rate k/N after puncturing: for a rate-1/n mother over period P, the
 *  numerator is P input bits and the denominator is the number of kept bits. */
export function punctureRate(n: number, punc: Puncture): number {
  const period = punc.pattern[0].length
  let kept = 0
  for (let j = 0; j < n; j++) for (let c = 0; c < period; c++) kept += punc.pattern[j][c]
  return period / kept
}

/** Delete punctured bits from a full coded stream. */
export function applyPuncture(coded: ArrayLike<number>, n: number, punc: Puncture): Uint8Array {
  const period = punc.pattern[0].length
  const steps = coded.length / n
  const out: number[] = []
  for (let t = 0; t < steps; t++) {
    const c = t % period
    for (let j = 0; j < n; j++) if (punc.pattern[j][c]) out.push(coded[t * n + j])
  }
  return Uint8Array.from(out)
}

/**
 * Re-insert erasures where the puncturer deleted bits, producing a full-length
 * stream plus a validity mask (1 = a real received value, 0 = erased/no info).
 * Works for both hard bits and soft samples (fill value is caller-supplied).
 */
export function depuncture(
  received: ArrayLike<number>,
  n: number,
  punc: Puncture,
  steps: number,
  fill: number,
): { full: Float64Array; mask: Uint8Array } {
  const period = punc.pattern[0].length
  const full = new Float64Array(steps * n).fill(fill)
  const mask = new Uint8Array(steps * n)
  let r = 0
  for (let t = 0; t < steps; t++) {
    const c = t % period
    for (let j = 0; j < n; j++) {
      if (punc.pattern[j][c]) {
        full[t * n + j] = received[r++]
        mask[t * n + j] = 1
      }
    }
  }
  return { full, mask }
}

// --- Viterbi decoding -----------------------------------------------------------

export interface ViterbiResult {
  /** decoded message bits (the K−1 flush bits already removed). */
  decoded: Uint8Array
  /** the maximum-likelihood state path, length steps+1 (starts at 0). */
  path: number[]
  /** per-step survivor path metrics over all states (for the trellis animation). */
  metrics: Float64Array[]
  /** survPred[t][s] = the predecessor state of the survivor entering state s at
   *  step t (−1 if unreached) — the traceback pointers, for the animation. */
  survPred: Int32Array[]
  /** total metric of the winning path. */
  finalMetric: number
  /** number of trellis steps decoded. */
  steps: number
}

const INF = 1e18

/**
 * Core add–compare–select Viterbi over a trellis. `stepCost(t, out)` returns the
 * branch metric for emitting the n-bit output vector `out` at step t (lower is
 * better). The path is forced to terminate at state 0 (zero-terminated code).
 */
function viterbi(tr: Trellis, steps: number, stepCost: (t: number, out: number[]) => number): ViterbiResult {
  const S = tr.numStates
  let pm = new Float64Array(S).fill(INF)
  pm[0] = 0
  const back = new Int32Array(steps * S).fill(-1) // predecessor state
  const inbit = new Uint8Array(steps * S) // input bit taken into each state
  const metricsHist: Float64Array[] = []
  const survHist: Int32Array[] = []
  for (let t = 0; t < steps; t++) {
    const npm = new Float64Array(S).fill(INF)
    for (let s = 0; s < S; s++) {
      if (pm[s] >= INF) continue
      for (let input = 0; input < 2; input++) {
        const br = tr.branch[s][input]
        const cand = pm[s] + stepCost(t, br.out)
        const ns = br.nextState
        if (cand < npm[ns]) {
          npm[ns] = cand
          back[t * S + ns] = s
          inbit[t * S + ns] = input
        }
      }
    }
    pm = npm
    metricsHist.push(npm.slice())
    survHist.push(back.slice(t * S, t * S + S))
  }
  // Traceback from the terminal zero state.
  const path = new Array<number>(steps + 1)
  let s = 0
  path[steps] = 0
  const inputs = new Uint8Array(steps)
  for (let t = steps - 1; t >= 0; t--) {
    inputs[t] = inbit[t * S + s]
    const prev = back[t * S + s]
    path[t] = prev < 0 ? 0 : prev
    s = path[t]
  }
  const tail = tr.code.K - 1
  const decoded = inputs.subarray(0, Math.max(0, steps - tail)).slice()
  return { decoded, path, metrics: metricsHist, survPred: survHist, finalMetric: pm[0], steps }
}

/** Hard-decision Viterbi: Hamming distance between received bits and branch out. */
export function viterbiHard(
  rxBits: ArrayLike<number>,
  tr: Trellis,
  mask?: ArrayLike<number>,
): ViterbiResult {
  const steps = Math.floor(rxBits.length / tr.n)
  return viterbi(tr, steps, (t, out) => {
    let d = 0
    for (let j = 0; j < tr.n; j++) {
      const idx = t * tr.n + j
      if (mask && !mask[idx]) continue // erased (punctured) bit: no information
      if ((rxBits[idx] & 1) !== out[j]) d++
    }
    return d
  })
}

/**
 * Soft-decision Viterbi: squared Euclidean distance between the received BPSK
 * samples and the ideal amplitudes (bit b → 1−2b). Unquantised soft decisions buy
 * ~2 dB over hard decisions — the classic soft-decision coding gain.
 */
export function viterbiSoft(
  rxSoft: ArrayLike<number>,
  tr: Trellis,
  mask?: ArrayLike<number>,
): ViterbiResult {
  const steps = Math.floor(rxSoft.length / tr.n)
  return viterbi(tr, steps, (t, out) => {
    let d = 0
    for (let j = 0; j < tr.n; j++) {
      const idx = t * tr.n + j
      if (mask && !mask[idx]) continue
      const ideal = 1 - 2 * out[j] // 0 → +1, 1 → −1
      const e = rxSoft[idx] - ideal
      d += e * e
    }
    return d
  })
}

// --- distance spectrum (the union-bound oracle) ---------------------------------
//
// Enumerate every ERROR EVENT — a trellis path that leaves the all-zero state and
// returns to it for the first time — collecting, per output Hamming weight d, the
// number of such paths a_d and the total input-bit weight c_d = Σ (input weight).
// This is the code's distance spectrum {(d, a_d, c_d)}; d_free is its smallest d.
// The union bound on the bit-error rate is then Σ_d c_d · P₂(d).

export interface SpectrumTerm {
  d: number
  /** number of error events of output weight d. */
  aCount: number
  /** total information-bit weight across those events (the union-bound coefficient). */
  cInfo: number
}

export interface DistanceSpectrum {
  dFree: number
  terms: SpectrumTerm[]
}

/**
 * Compute the distance spectrum up to `maxTerms` weights past d_free, by a
 * weight-bounded dynamic program over first-return-to-zero paths. Non-catastrophic
 * codes accumulate weight on every nonzero-state cycle, so the DP terminates.
 */
export function distanceSpectrum(tr: Trellis, maxTermsPastFree = 6, weightCap = 40, maxSteps = 200): DistanceSpectrum {
  // Live partial error events keyed by (state, cumulative output weight):
  // count = number of paths, info = summed input weight over them.
  type Cell = { count: number; info: number }
  let live = new Map<number, Cell>() // key = state * (weightCap+1) + weight
  const key = (s: number, w: number) => s * (weightCap + 1) + w
  const aCount: number[] = new Array(weightCap + 1).fill(0)
  const cInfo: number[] = new Array(weightCap + 1).fill(0)

  // Seed: the single diverging branch out of state 0 (input = 1). Input 0 keeps
  // us on the reference zero path and is excluded.
  {
    const br = tr.branch[0][1]
    const w = br.outWeight
    if (w <= weightCap) live.set(key(br.nextState, w), { count: 1, info: 1 })
  }

  for (let step = 0; step < maxSteps && live.size > 0; step++) {
    const next = new Map<number, Cell>()
    for (const [k, cell] of live) {
      const s = Math.floor(k / (weightCap + 1))
      const w = k % (weightCap + 1)
      for (let input = 0; input < 2; input++) {
        const br = tr.branch[s][input]
        const nw = w + br.outWeight
        if (nw > weightCap) continue
        const addInfo = cell.info + cell.count * input // each path gains `input` to its info weight
        if (br.nextState === 0) {
          // A completed error event of output weight nw.
          aCount[nw] += cell.count
          cInfo[nw] += addInfo
        } else {
          const nk = key(br.nextState, nw)
          const ex = next.get(nk)
          if (ex) {
            ex.count += cell.count
            ex.info += addInfo
          } else {
            next.set(nk, { count: cell.count, info: addInfo })
          }
        }
      }
    }
    live = next
  }

  let dFree = -1
  for (let d = 0; d <= weightCap; d++) {
    if (aCount[d] > 0) {
      dFree = d
      break
    }
  }
  const terms: SpectrumTerm[] = []
  if (dFree >= 0) {
    for (let d = dFree; d <= weightCap && terms.length <= maxTermsPastFree; d++) {
      if (aCount[d] > 0) terms.push({ d, aCount: aCount[d], cInfo: cInfo[d] })
    }
  }
  return { dFree, terms }
}

// --- union bounds ---------------------------------------------------------------

/** Soft-decision pairwise error probability over an AWGN channel: two coded
 *  words at Hamming distance d, energy R·Eb per coded bit. */
export function pairwiseSoft(d: number, rate: number, ebn0Lin: number): number {
  return qfunc(Math.sqrt(2 * rate * d * ebn0Lin))
}

function binom(nn: number, kk: number): number {
  if (kk < 0 || kk > nn) return 0
  let r = 1
  for (let i = 0; i < kk; i++) r = (r * (nn - i)) / (i + 1)
  return r
}

/** Hard-decision pairwise error probability over the induced BSC (crossover p):
 *  the probability the wrong path of weight d wins a majority vote. */
export function pairwiseHard(d: number, p: number): number {
  let s = 0
  if (d % 2 === 0) {
    // even d: half-count the exact tie.
    s += 0.5 * binom(d, d / 2) * Math.pow(p, d / 2) * Math.pow(1 - p, d / 2)
    for (let e = d / 2 + 1; e <= d; e++) s += binom(d, e) * Math.pow(p, e) * Math.pow(1 - p, d - e)
  } else {
    for (let e = (d + 1) / 2; e <= d; e++) s += binom(d, e) * Math.pow(p, e) * Math.pow(1 - p, d - e)
  }
  return s
}

/** Union-bound BER for soft-decision decoding at a given Eb/N0 (dB). */
export function unionBoundSoft(spec: DistanceSpectrum, rate: number, ebn0Db: number): number {
  const g = Math.pow(10, ebn0Db / 10)
  let ber = 0
  for (const t of spec.terms) ber += t.cInfo * pairwiseSoft(t.d, rate, g)
  return Math.min(ber, 0.5)
}

/** Union-bound BER for hard-decision decoding at a given Eb/N0 (dB). */
export function unionBoundHard(spec: DistanceSpectrum, rate: number, ebn0Db: number): number {
  const g = Math.pow(10, ebn0Db / 10)
  const p = qfunc(Math.sqrt(2 * rate * g)) // BSC crossover for coded BPSK
  let ber = 0
  for (const t of spec.terms) ber += t.cInfo * pairwiseHard(t.d, p)
  return Math.min(ber, 0.5)
}

/** Uncoded BPSK BER (the baseline the coding gain is measured against). */
export function uncodedBer(ebn0Db: number): number {
  const g = Math.pow(10, ebn0Db / 10)
  return qfunc(Math.sqrt(2 * g))
}

/** Asymptotic coding gains (dB): soft ≈ 10log₁₀(R·d_free), hard ≈ that minus 3 dB. */
export function asymptoticGainDb(dFree: number, rate: number): { soft: number; hard: number } {
  const soft = 10 * Math.log10(rate * dFree)
  const hard = 10 * Math.log10((rate * dFree) / 2)
  return { soft, hard }
}

// --- end-to-end Monte-Carlo link ------------------------------------------------

export interface CodedLinkOpts {
  msgBits: number
  ebn0Db: number
  punc: Puncture
  seed: number
}

export interface CodedLinkResult {
  ebn0Db: number
  rate: number
  msgBits: number
  codedBits: number
  txBits: number // after puncturing
  /** channel bit errors on the raw hard-sliced coded stream (pre-decoding). */
  channelBitErrors: number
  channelBer: number
  hardBitErrors: number
  hardBer: number
  softBitErrors: number
  softBer: number
  uncodedBitErrors: number
  uncodedBer: number
}

function randBits(n: number, rng: () => number): Uint8Array {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = rng() < 0.5 ? 0 : 1
  return b
}

/**
 * Simulate one Eb/N0 point end to end: random message → convolutional encode →
 * puncture → BPSK → AWGN → (hard slice + Viterbi) AND (soft Viterbi), counting
 * information-bit errors for each, plus an uncoded BPSK reference at the same
 * Eb/N0. Coded-bit energy is R·Eb, so σ² = 1/(2·R·Eb/N0).
 */
export function simulateCoded(tr: Trellis, opts: CodedLinkOpts): CodedLinkResult {
  const { msgBits, ebn0Db, punc, seed } = opts
  const rng = mulberry32(seed)
  const rate = punctureRate(tr.n, punc)
  const msg = randBits(msgBits, rng)
  const coded = convEncode(msg, tr)
  const steps = coded.length / tr.n
  const tx = punc.id === 'none' ? coded : applyPuncture(coded, tr.n, punc)

  const g = Math.pow(10, ebn0Db / 10)
  const sigma = Math.sqrt(1 / (2 * rate * g))
  // BPSK transmit ±1, add noise → soft samples.
  const soft = new Float64Array(tx.length)
  const hard = new Uint8Array(tx.length)
  let channelBitErrors = 0
  for (let i = 0; i < tx.length; i++) {
    const s = (1 - 2 * tx[i]) + sigma * gaussian(rng)
    soft[i] = s
    const b = s >= 0 ? 0 : 1
    hard[i] = b
    if (b !== tx[i]) channelBitErrors++
  }

  // De-puncture for the decoder (soft fill = 0 → equidistant/no info; hard mask).
  let softIn: ArrayLike<number> = soft
  let hardIn: ArrayLike<number> = hard
  let mask: ArrayLike<number> | undefined
  if (punc.id !== 'none') {
    const dpS = depuncture(soft, tr.n, punc, steps, 0)
    const dpH = depuncture(hard, tr.n, punc, steps, 0)
    softIn = dpS.full
    hardIn = dpH.full
    mask = dpS.mask
  }

  const hardDec = viterbiHard(hardIn, tr, mask)
  const softDec = viterbiSoft(softIn, tr, mask)
  let hardBitErrors = 0
  let softBitErrors = 0
  for (let i = 0; i < msgBits; i++) {
    if (hardDec.decoded[i] !== msg[i]) hardBitErrors++
    if (softDec.decoded[i] !== msg[i]) softBitErrors++
  }

  // Uncoded reference: the same message bits sent as BPSK at this Eb/N0.
  const sigmaU = Math.sqrt(1 / (2 * g))
  let uncodedBitErrors = 0
  for (let i = 0; i < msgBits; i++) {
    const s = (1 - 2 * msg[i]) + sigmaU * gaussian(rng)
    if ((s >= 0 ? 0 : 1) !== msg[i]) uncodedBitErrors++
  }

  return {
    ebn0Db,
    rate,
    msgBits,
    codedBits: coded.length,
    txBits: tx.length,
    channelBitErrors,
    channelBer: channelBitErrors / tx.length,
    hardBitErrors,
    hardBer: hardBitErrors / msgBits,
    softBitErrors,
    softBer: softBitErrors / msgBits,
    uncodedBitErrors,
    uncodedBer: uncodedBitErrors / msgBits,
  }
}

export interface CodedBerPoint {
  ebn0Db: number
  hardMeasured: number
  softMeasured: number
  hardBound: number
  softBound: number
  uncoded: number
}

/** Sweep Eb/N0, returning measured (MC) and union-bound BER for hard & soft. */
export function codedBerCurve(
  tr: Trellis,
  spec: DistanceSpectrum,
  ebn0List: number[],
  msgBits: number,
  punc: Puncture,
  seed: number,
): CodedBerPoint[] {
  const rate = punctureRate(tr.n, punc)
  return ebn0List.map((ebn0Db, i) => {
    const r = simulateCoded(tr, { msgBits, ebn0Db, punc, seed: seed + i * 2654435761 })
    return {
      ebn0Db,
      hardMeasured: r.hardBer,
      softMeasured: r.softBer,
      hardBound: unionBoundHard(spec, rate, ebn0Db),
      softBound: unionBoundSoft(spec, rate, ebn0Db),
      uncoded: uncodedBer(ebn0Db),
    }
  })
}

// --- decode demo (for the animated trellis) -------------------------------------

export interface DecodeDemo {
  msg: Uint8Array
  coded: Uint8Array
  /** received soft BPSK samples (length = coded.length). */
  soft: Float64Array
  /** hard-sliced received bits. */
  hard: Uint8Array
  /** the Viterbi run (hard or soft depending on `soft` flag). */
  vit: ViterbiResult
  /** the true encoder state path (length steps+1) — the correct answer. */
  truePath: number[]
  /** indices of coded bits corrupted by the channel. */
  channelErrors: number[]
  /** message-bit errors remaining after decoding. */
  residualErrors: number
  steps: number
  n: number
}

/** Run a full short-message decode with noise, returning every intermediate for
 *  the trellis visualiser. `useSoft` selects soft- vs hard-decision decoding. */
export function decodeDemo(
  tr: Trellis,
  msgBits: number,
  ebn0Db: number,
  useSoft: boolean,
  seed: number,
): DecodeDemo {
  const rng = mulberry32(seed)
  const msg = randBits(msgBits, rng)
  const coded = convEncode(msg, tr)
  const steps = coded.length / tr.n
  const g = Math.pow(10, ebn0Db / 10)
  const rate = 1 / tr.n // demo is always the unpunctured mother code
  const sigma = Math.sqrt(1 / (2 * rate * g))
  const soft = new Float64Array(coded.length)
  const hard = new Uint8Array(coded.length)
  const channelErrors: number[] = []
  for (let i = 0; i < coded.length; i++) {
    const s = (1 - 2 * coded[i]) + sigma * gaussian(rng)
    soft[i] = s
    hard[i] = s >= 0 ? 0 : 1
    if (hard[i] !== coded[i]) channelErrors.push(i)
  }
  const vit = useSoft ? viterbiSoft(soft, tr) : viterbiHard(hard, tr)
  // The true encoder state path.
  const truePath: number[] = [0]
  let st = 0
  for (let t = 0; t < steps; t++) {
    const input = t < msgBits ? msg[t] : 0
    st = tr.branch[st][input].nextState
    truePath.push(st)
  }
  let residualErrors = 0
  for (let i = 0; i < msgBits; i++) if (vit.decoded[i] !== msg[i]) residualErrors++
  return { msg, coded, soft, hard, vit, truePath, channelErrors, residualErrors, steps, n: tr.n }
}

// --- text ⇄ bits (for the message demo) -----------------------------------------

/** Pack a UTF-8-ish ASCII string into a bit array (8 bits per char, MSB first). */
export function textToBits(text: string): Uint8Array {
  const bits = new Uint8Array(text.length * 8)
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i) & 0xff
    for (let j = 0; j < 8; j++) bits[i * 8 + j] = (c >> (7 - j)) & 1
  }
  return bits
}

export function bitsToText(bits: ArrayLike<number>): string {
  const n = Math.floor(bits.length / 8)
  let s = ''
  for (let i = 0; i < n; i++) {
    let c = 0
    for (let j = 0; j < 8; j++) c = (c << 1) | (bits[i * 8 + j] & 1)
    s += String.fromCharCode(c)
  }
  return s
}
