// Pulse shaping — the bandwidth-limiting half of a digital link. A stream of
// impulse-like symbols is upsampled and convolved with a root-raised-cosine
// (RRC) filter at the transmitter; the receiver applies the *same* RRC as a
// matched filter. The two RRCs cascade into a full raised-cosine (RC) response,
// whose defining property is **zero inter-symbol interference**: it is exactly
// zero at every symbol instant except its own. That is what opens the eye.
//
// All filters are built here from their closed-form impulse responses (no tables)
// and are FIR / linear-phase. Signals are complex (I/Q) baseband.

export interface CSignal {
  re: Float64Array
  im: Float64Array
  length: number
}

function csig(n: number): CSignal {
  return { re: new Float64Array(n), im: new Float64Array(n), length: n }
}

/**
 * Root-raised-cosine impulse response. `sps` = samples per symbol, `span` = the
 * one-sided support in symbols (so the filter is 2·span·sps + 1 taps, centered).
 * `beta` ∈ [0,1] is the roll-off (excess bandwidth). Taps are normalized to unit
 * energy, so the matched-filter cascade has unit peak gain at the symbol instant.
 */
export function rrcTaps(beta: number, sps: number, span: number): Float64Array {
  const N = 2 * span * sps
  const taps = new Float64Array(N + 1)
  const b = Math.min(Math.max(beta, 1e-6), 1)
  for (let n = 0; n <= N; n++) {
    const t = (n - N / 2) / sps // time in symbol periods
    let h: number
    if (Math.abs(t) < 1e-8) {
      h = 1 - b + (4 * b) / Math.PI
    } else if (Math.abs(Math.abs(4 * b * t) - 1) < 1e-8) {
      // Removable singularity at t = ±1/(4β).
      h =
        (b / Math.SQRT2) *
        ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * b)) +
          (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * b)))
    } else {
      const num =
        Math.sin(Math.PI * t * (1 - b)) + 4 * b * t * Math.cos(Math.PI * t * (1 + b))
      const den = Math.PI * t * (1 - (4 * b * t) * (4 * b * t))
      h = num / den
    }
    taps[n] = h
  }
  // Normalize to unit energy.
  let e = 0
  for (let i = 0; i < taps.length; i++) e += taps[i] * taps[i]
  const s = 1 / Math.sqrt(e)
  for (let i = 0; i < taps.length; i++) taps[i] *= s
  return taps
}

/**
 * Raised-cosine impulse response (the RRC⊛RRC cascade target). Normalized to a
 * peak of 1 at the center; zero at every nonzero integer symbol instant.
 */
export function rcTaps(beta: number, sps: number, span: number): Float64Array {
  const N = 2 * span * sps
  const taps = new Float64Array(N + 1)
  const b = Math.min(Math.max(beta, 1e-6), 1)
  for (let n = 0; n <= N; n++) {
    const t = (n - N / 2) / sps
    let h: number
    if (Math.abs(t) < 1e-8) {
      h = 1
    } else if (Math.abs(Math.abs(2 * b * t) - 1) < 1e-8) {
      h = (Math.PI / 4) * sinc(1 / (2 * b))
    } else {
      h = sinc(t) * (Math.cos(Math.PI * b * t) / (1 - (2 * b * t) * (2 * b * t)))
    }
    taps[n] = h
  }
  return taps
}

function sinc(x: number): number {
  if (Math.abs(x) < 1e-9) return 1
  const px = Math.PI * x
  return Math.sin(px) / px
}

/** Insert sps−1 zeros between symbols (zero-order upsampling to the sample rate). */
export function upsample(re: ArrayLike<number>, im: ArrayLike<number>, sps: number): CSignal {
  const n = re.length
  const out = csig(n * sps)
  for (let s = 0; s < n; s++) {
    out.re[s * sps] = re[s]
    out.im[s * sps] = im[s]
  }
  return out
}

/** Linear convolution of a complex signal with a real FIR filter. */
export function firComplex(sig: CSignal, taps: Float64Array): CSignal {
  const n = sig.length
  const m = taps.length
  const out = csig(n + m - 1)
  for (let i = 0; i < n; i++) {
    const xr = sig.re[i]
    const xi = sig.im[i]
    if (xr === 0 && xi === 0) continue
    for (let j = 0; j < m; j++) {
      out.re[i + j] += xr * taps[j]
      out.im[i + j] += xi * taps[j]
    }
  }
  return out
}

/** Linear convolution of two real sequences (used to form RRC⊛RRC). */
export function convolveReal(x: ArrayLike<number>, h: ArrayLike<number>): Float64Array {
  const n = x.length
  const m = h.length
  const out = new Float64Array(n + m - 1)
  for (let i = 0; i < n; i++) {
    const xi = x[i]
    if (xi === 0) continue
    for (let j = 0; j < m; j++) out[i + j] += xi * h[j]
  }
  return out
}

export interface ShapedLink {
  /** transmitted, pulse-shaped waveform (I/Q). */
  tx: CSignal
  /** matched-filtered waveform at the receiver. */
  rx: CSignal
  /** group delay (samples) from the two filters — where symbol instants land. */
  delay: number
  /** the RRC taps used (for display). */
  taps: Float64Array
}

/**
 * Full single-carrier shaping chain: upsample → RRC (Tx) → optional AWGN →
 * RRC (Rx, matched). Returns both waveforms and the sampling delay so the eye
 * and the decision instants line up.
 */
export function shapeLink(
  symRe: ArrayLike<number>,
  symIm: ArrayLike<number>,
  beta: number,
  sps: number,
  span: number,
  noiseSigma: number,
  rng: () => number,
  gaussian: (r: () => number) => number,
): ShapedLink {
  const taps = rrcTaps(beta, sps, span)
  const up = upsample(symRe, symIm, sps)
  const tx = firComplex(up, taps)
  // AWGN on the shaped waveform. Scale so per-symbol Eb/N0 matches the symbol
  // model: matched filtering of unit-energy RRC noise preserves the per-symbol σ.
  let noisy = tx
  if (noiseSigma > 0) {
    noisy = { re: Float64Array.from(tx.re), im: Float64Array.from(tx.im), length: tx.length }
    for (let i = 0; i < noisy.length; i++) {
      noisy.re[i] += noiseSigma * gaussian(rng)
      noisy.im[i] += noiseSigma * gaussian(rng)
    }
  }
  const rx = firComplex(noisy, taps)
  const delay = taps.length - 1 // total group delay of the two FIRs
  return { tx, rx, delay, taps }
}

/**
 * Slice a real waveform into overlapping traces of `spanSymbols` symbols for an
 * eye diagram. `offset` aligns trace starts to symbol boundaries.
 */
export function eyeTraces(
  sig: ArrayLike<number>,
  sps: number,
  spanSymbols: number,
  offset: number,
): number[][] {
  const traceLen = spanSymbols * sps
  const traces: number[][] = []
  const n = sig.length
  for (let start = offset; start + traceLen < n; start += sps) {
    const tr: number[] = new Array(traceLen + 1)
    for (let i = 0; i <= traceLen; i++) tr[i] = sig[start + i]
    traces.push(tr)
  }
  return traces
}

/** Sample a shaped/matched waveform back to one complex value per symbol. */
export function sampleSymbols(rx: CSignal, sps: number, delay: number, nSymbols: number): CSignal {
  const out = csig(nSymbols)
  for (let s = 0; s < nSymbols; s++) {
    const idx = delay + s * sps
    if (idx < rx.length) {
      out.re[s] = rx.re[idx]
      out.im[s] = rx.im[idx]
    }
  }
  return out
}

export type { CSignal as ComplexSignal }
