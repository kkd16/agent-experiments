// Digital communications core — the modulation/demodulation, channel and
// error-rate machinery behind the Modem lab. Everything here is from scratch:
// Gray-coded square-QAM (plus BPSK) constellations, an AWGN channel with a
// seeded Gaussian source, closed-form BER/SER theory (via a rational erfc), and
// a Monte-Carlo link simulator whose measured error rate tracks the theory.
//
// Conventions
// -----------
// A "symbol" is one complex point drawn from a constellation of M points, each
// carrying k = log2(M) bits. Constellations are scaled to **unit average
// symbol energy** (Es = 1), so the noise level is set purely by Eb/N0: with a
// complex-baseband AWGN channel the noise variance per real dimension is
//   σ² = N0/2 = Es / (2·k·(Eb/N0)) = 1 / (2·k·(Eb/N0)).

export type Scheme = 'bpsk' | 'qpsk' | 'qam16' | 'qam64'

export interface SchemeInfo {
  id: Scheme
  label: string
  /** bits carried per symbol, k = log2(M). */
  bitsPerSymbol: number
  /** constellation size M. */
  M: number
}

export const SCHEMES: SchemeInfo[] = [
  { id: 'bpsk', label: 'BPSK (1 bit)', bitsPerSymbol: 1, M: 2 },
  { id: 'qpsk', label: 'QPSK (2 bits)', bitsPerSymbol: 2, M: 4 },
  { id: 'qam16', label: '16-QAM (4 bits)', bitsPerSymbol: 4, M: 16 },
  { id: 'qam64', label: '64-QAM (6 bits)', bitsPerSymbol: 6, M: 64 },
]

export function schemeInfo(scheme: Scheme): SchemeInfo {
  const s = SCHEMES.find((x) => x.id === scheme)
  if (!s) throw new Error(`unknown scheme ${scheme}`)
  return s
}

// --- binary-reflected Gray code -------------------------------------------------

/** Natural integer i → its Gray-code label (i ^ i>>1). */
export function grayEncode(i: number): number {
  return i ^ (i >>> 1)
}

/** Gray-code label g → the natural integer it stands for (inverse of grayEncode). */
export function grayDecode(g: number): number {
  let i = g
  while (g > 0) {
    g >>>= 1
    i ^= g
  }
  return i
}

// --- pulse-amplitude levels per axis -------------------------------------------
//
// A square M-QAM constellation is the product of two independent PAM axes, each
// carrying kAxis = k/2 bits. The kAxis bits (MSB first) form a Gray label g; the
// level *index* is grayDecode(g), and the amplitude is the odd integer
// 2·index − (Maxis − 1) ∈ {−(Maxis−1), …, −1, +1, …, +(Maxis−1)}.

function axisAmplitude(bits: number, kAxis: number): number {
  const Maxis = 1 << kAxis
  const index = grayDecode(bits)
  return 2 * index - (Maxis - 1)
}

function axisBitsFromLevel(amp: number, kAxis: number): number {
  const Maxis = 1 << kAxis
  let index = Math.round((amp + (Maxis - 1)) / 2)
  if (index < 0) index = 0
  if (index > Maxis - 1) index = Maxis - 1
  return grayEncode(index)
}

// --- constellation --------------------------------------------------------------

export interface ConstPoint {
  re: number
  im: number
  /** the k bits (MSB first) this point encodes. */
  bits: number[]
  /** the integer symbol value 0..M-1 (bits packed MSB first). */
  value: number
}

export interface Constellation {
  points: ConstPoint[]
  bitsPerSymbol: number
  M: number
  /** amplitude scale applied so average symbol energy is 1. */
  norm: number
}

function packBits(bits: number[]): number {
  let v = 0
  for (const b of bits) v = (v << 1) | (b & 1)
  return v
}

function unpackBits(value: number, k: number): number[] {
  const bits: number[] = []
  for (let i = k - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  return bits
}

/** Raw (un-normalized) complex point for a symbol value under `scheme`. */
function rawPoint(value: number, scheme: Scheme): { re: number; im: number } {
  if (scheme === 'bpsk') {
    // 1-D: value 0 → +1, 1 → −1 (Gray-trivial). Keep +1 for bit 0.
    return { re: value === 0 ? 1 : -1, im: 0 }
  }
  const k = schemeInfo(scheme).bitsPerSymbol
  const kAxis = k / 2
  const iBits = value >>> kAxis // most-significant half → in-phase
  const qBits = value & ((1 << kAxis) - 1) // least-significant half → quadrature
  return { re: axisAmplitude(iBits, kAxis), im: axisAmplitude(qBits, kAxis) }
}

/** Build the full, energy-normalized constellation for a scheme. */
export function constellation(scheme: Scheme): Constellation {
  const info = schemeInfo(scheme)
  const { M, bitsPerSymbol: k } = info
  // First pass: raw points and their mean energy.
  const raw: { re: number; im: number }[] = []
  let energy = 0
  for (let v = 0; v < M; v++) {
    const p = rawPoint(v, scheme)
    raw.push(p)
    energy += p.re * p.re + p.im * p.im
  }
  const norm = Math.sqrt(M / energy) // scale so mean(|s|²) = 1
  const points: ConstPoint[] = raw.map((p, v) => ({
    re: p.re * norm,
    im: p.im * norm,
    bits: unpackBits(v, k),
    value: v,
  }))
  return { points, bitsPerSymbol: k, M, norm }
}

// --- mapping & hard-decision demapping -----------------------------------------

export interface SymbolStream {
  re: Float64Array
  im: Float64Array
  length: number
}

/** Map a bit stream (length must be a multiple of k) to unit-energy symbols. */
export function mapBits(bits: ArrayLike<number>, scheme: Scheme): SymbolStream {
  const info = schemeInfo(scheme)
  const k = info.bitsPerSymbol
  const n = Math.floor(bits.length / k)
  const norm = constellation(scheme).norm
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let s = 0; s < n; s++) {
    let value = 0
    for (let j = 0; j < k; j++) value = (value << 1) | (bits[s * k + j] & 1)
    const p = rawPoint(value, scheme)
    re[s] = p.re * norm
    im[s] = p.im * norm
  }
  return { re, im, length: n }
}

/** Nearest-point (maximum-likelihood, per-axis for QAM) hard decision → bits. */
export function demapSymbols(re: ArrayLike<number>, im: ArrayLike<number>, scheme: Scheme): Uint8Array {
  const info = schemeInfo(scheme)
  const k = info.bitsPerSymbol
  const n = re.length
  const out = new Uint8Array(n * k)
  const norm = constellation(scheme).norm
  if (scheme === 'bpsk') {
    for (let s = 0; s < n; s++) out[s] = re[s] >= 0 ? 0 : 1
    return out
  }
  const kAxis = k / 2
  for (let s = 0; s < n; s++) {
    // Un-normalize to the integer PAM grid, decide per axis.
    const iAmp = re[s] / norm
    const qAmp = im[s] / norm
    const iBits = axisBitsFromLevel(iAmp, kAxis)
    const qBits = axisBitsFromLevel(qAmp, kAxis)
    const value = (iBits << kAxis) | qBits
    const bits = unpackBits(value, k)
    for (let j = 0; j < k; j++) out[s * k + j] = bits[j]
  }
  return out
}

/** Decide the nearest constellation *value* for a received point (for coloring). */
export function decideValue(re: number, im: number, scheme: Scheme): number {
  const info = schemeInfo(scheme)
  const norm = constellation(scheme).norm
  if (scheme === 'bpsk') return re >= 0 ? 0 : 1
  const kAxis = info.bitsPerSymbol / 2
  const iBits = axisBitsFromLevel(re / norm, kAxis)
  const qBits = axisBitsFromLevel(im / norm, kAxis)
  return (iBits << kAxis) | qBits
}

// --- seeded randomness ----------------------------------------------------------

/** Deterministic 32-bit PRNG (same generator used elsewhere in the app). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One standard-normal sample via the Box–Muller transform. */
export function gaussian(rng: () => number): number {
  let u = 0
  while (u === 0) u = rng() // avoid log(0)
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** Noise std per real dimension for a target Eb/N0 (dB) at k bits/symbol, Es=1. */
export function ebn0ToSigma(ebn0Db: number, bitsPerSymbol: number): number {
  const gamma = Math.pow(10, ebn0Db / 10) // Eb/N0 linear
  return Math.sqrt(1 / (2 * bitsPerSymbol * gamma))
}

/** Add complex AWGN of the given per-dimension std, returning a new stream. */
export function addAwgn(sym: SymbolStream, sigma: number, rng: () => number): SymbolStream {
  const n = sym.length
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    re[i] = sym.re[i] + sigma * gaussian(rng)
    im[i] = sym.im[i] + sigma * gaussian(rng)
  }
  return { re, im, length: n }
}

// --- error-function & Q-function -----------------------------------------------

/**
 * Complementary error function via the Numerical-Recipes rational approximation
 * (fractional error < 1.2e-7 everywhere). erf(x) = 1 − erfc(x).
 */
export function erfc(x: number): number {
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

/** Gaussian tail probability Q(x) = P(N(0,1) > x) = ½·erfc(x/√2). */
export function qfunc(x: number): number {
  return 0.5 * erfc(x / Math.SQRT2)
}

// --- closed-form theory ---------------------------------------------------------

/**
 * Theoretical symbol-error rate for the scheme at Eb/N0 (dB). Square-QAM uses the
 * exact 2-D union over the two PAM axes; BPSK/QPSK are exact.
 */
export function theorySER(scheme: Scheme, ebn0Db: number): number {
  const info = schemeInfo(scheme)
  const k = info.bitsPerSymbol
  const gamma = Math.pow(10, ebn0Db / 10) // Eb/N0
  if (scheme === 'bpsk') return qfunc(Math.sqrt(2 * gamma))
  const M = info.M
  // Per-axis symbol error of √M-PAM, then combine the two independent axes.
  const q = qfunc(Math.sqrt((3 * k * gamma) / (M - 1)))
  const sqrtM = Math.sqrt(M)
  const pAxis = (2 * (1 - 1 / sqrtM)) * q // SER of one √M-PAM axis
  return 1 - (1 - pAxis) * (1 - pAxis)
}

/**
 * Theoretical bit-error rate. Gray coding makes a nearest-neighbour symbol error
 * flip (to first order) one bit, so BER ≈ SER/k for QAM; BPSK/QPSK are exact.
 */
export function theoryBER(scheme: Scheme, ebn0Db: number): number {
  const info = schemeInfo(scheme)
  const k = info.bitsPerSymbol
  const gamma = Math.pow(10, ebn0Db / 10)
  if (scheme === 'bpsk' || scheme === 'qpsk') return qfunc(Math.sqrt(2 * gamma))
  const M = info.M
  const sqrtM = Math.sqrt(M)
  // Standard Gray-coded square-QAM bit-error approximation.
  return ((4 / k) * (1 - 1 / sqrtM)) * qfunc(Math.sqrt((3 * k * gamma) / (M - 1)))
}

// --- Monte-Carlo link simulation ------------------------------------------------

export interface LinkResult {
  scheme: Scheme
  ebn0Db: number
  nBits: number
  nSymbols: number
  bitErrors: number
  symbolErrors: number
  ber: number
  ser: number
  /** received (noisy) symbols, for the scatter plot. */
  rxRe: Float64Array
  rxIm: Float64Array
  /** per-symbol correctness (1 = decoded correctly), for coloring. */
  correct: Uint8Array
  /** root-mean-square error-vector magnitude (%), an implementation-agnostic quality metric. */
  evmPct: number
}

/** Random 0/1 bit stream of the given length. */
export function randomBits(n: number, rng: () => number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = rng() < 0.5 ? 0 : 1
  return out
}

/**
 * Simulate one Eb/N0 point end to end: random bits → map → AWGN → hard decision,
 * counting bit and symbol errors and keeping the received cloud for plotting.
 */
export function simulateLink(scheme: Scheme, ebn0Db: number, nSymbols: number, seed: number): LinkResult {
  const info = schemeInfo(scheme)
  const k = info.bitsPerSymbol
  const rng = mulberry32(seed)
  const txBits = randomBits(nSymbols * k, rng)
  const tx = mapBits(txBits, scheme)
  const sigma = ebn0ToSigma(ebn0Db, k)
  const rx = addAwgn(tx, sigma, rng)
  const rxBits = demapSymbols(rx.re, rx.im, scheme)
  let bitErrors = 0
  for (let i = 0; i < txBits.length; i++) if (txBits[i] !== rxBits[i]) bitErrors++
  let symbolErrors = 0
  const correct = new Uint8Array(nSymbols)
  for (let s = 0; s < nSymbols; s++) {
    let bad = false
    for (let j = 0; j < k; j++) if (txBits[s * k + j] !== rxBits[s * k + j]) bad = true
    correct[s] = bad ? 0 : 1
    if (bad) symbolErrors++
  }
  // EVM: rms distance between received and *transmitted* symbols, vs signal rms.
  let errPow = 0
  for (let s = 0; s < nSymbols; s++) {
    const dr = rx.re[s] - tx.re[s]
    const di = rx.im[s] - tx.im[s]
    errPow += dr * dr + di * di
  }
  const evmPct = Math.sqrt(errPow / nSymbols) * 100 // Es = 1
  return {
    scheme,
    ebn0Db,
    nBits: txBits.length,
    nSymbols,
    bitErrors,
    symbolErrors,
    ber: bitErrors / txBits.length,
    ser: symbolErrors / nSymbols,
    rxRe: rx.re,
    rxIm: rx.im,
    correct,
    evmPct,
  }
}

export interface BerPoint {
  ebn0Db: number
  measured: number
  theory: number
}

/** Sweep a range of Eb/N0 values, returning measured (MC) and theoretical BER. */
export function berCurve(
  scheme: Scheme,
  ebn0List: number[],
  symbolsPerPoint: number,
  seed: number,
): BerPoint[] {
  return ebn0List.map((ebn0Db, i) => {
    const r = simulateLink(scheme, ebn0Db, symbolsPerPoint, seed + i * 101)
    return { ebn0Db, measured: r.ber, theory: theoryBER(scheme, ebn0Db) }
  })
}

/** Spectral efficiency (bits/s/Hz) of a Nyquist-shaped link at excess bandwidth β. */
export function spectralEfficiency(scheme: Scheme, rolloff: number): number {
  return schemeInfo(scheme).bitsPerSymbol / (1 + rolloff)
}

export { packBits, unpackBits }
