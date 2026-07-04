// Parks–McClellan optimal equiripple FIR design (the Remez exchange algorithm).
//
// The windowed-sinc FIR in `filterdesign.ts` is simple but wasteful: it spends
// its ripple budget unevenly, so for a target stopband attenuation it needs more
// taps than necessary. Parks–McClellan instead finds the *optimal* linear-phase
// filter in the Chebyshev (minimax) sense — the one whose worst-case weighted
// error is as small as possible. By the alternation theorem that optimum is the
// unique filter whose error ripples with equal amplitude, alternating sign, at
// exactly r+1 frequencies (r = number of cosine basis functions). The Remez
// exchange finds those frequencies iteratively:
//
//   1. guess r+1 trial extremal frequencies,
//   2. solve for the deviation δ and the amplitude that interpolates the desired
//      response (with alternating ±δ/W offsets) at them — a barycentric Lagrange
//      interpolation with a closed-form δ,
//   3. evaluate the weighted error on a dense grid and relocate the extrema to the
//      grid's r+1 largest local peaks,
//   4. repeat until the extremal error magnitudes are all equal.
//
// This is a from-scratch TypeScript port of the classic McClellan–Parks–Rabiner
// routine, restricted to the symmetric, odd-length "type I" filter (which realises
// low-pass, high-pass, band-pass and band-stop). No libraries.

/** One approximation band: edges in cycles/sample (Nyquist = 0.5). */
export interface RemezBand {
  lo: number
  hi: number
  desired: number
  weight: number
}

export interface RemezResult {
  taps: Float64Array
  /** Converged deviation δ (weighted minimax error). */
  deviation: number
  iterations: number
  converged: boolean
}

// Barycentric-Lagrange evaluation of the trial amplitude response A(f).
function computeA(freq: number, ne: number, ad: Float64Array, x: Float64Array, y: Float64Array): number {
  const xc = Math.cos(2 * Math.PI * freq)
  let num = 0
  let den = 0
  for (let i = 0; i < ne; i++) {
    let c = xc - x[i]
    if (Math.abs(c) < 1e-7) return y[i]
    c = ad[i] / c
    den += c
    num += c * y[i]
  }
  return num / den
}

// Locate the alternating extrema of the weighted error on the grid, trimmed to
// exactly `numext` (the r+1 the alternation theorem calls for).
function searchExtrema(E: Float64Array, gridsize: number, numext: number): number[] {
  const cand: number[] = []
  for (let i = 0; i < gridsize; i++) {
    const e = E[i]
    if (e === 0) continue
    const l = i > 0 ? E[i - 1] : e
    const r = i < gridsize - 1 ? E[i + 1] : e
    const isExt =
      i === 0
        ? (e > 0 && e >= r) || (e < 0 && e <= r)
        : i === gridsize - 1
          ? (e > 0 && e >= l) || (e < 0 && e <= l)
          : (e > 0 && e >= l && e >= r) || (e < 0 && e <= l && e <= r)
    if (isExt) cand.push(i)
  }
  // Collapse runs of same-signed candidates, keeping the largest-magnitude one —
  // the alternation theorem wants strictly sign-alternating extrema.
  const alt: number[] = []
  for (const c of cand) {
    if (alt.length === 0) {
      alt.push(c)
      continue
    }
    const prev = alt[alt.length - 1]
    if (Math.sign(E[c]) === Math.sign(E[prev])) {
      if (Math.abs(E[c]) > Math.abs(E[prev])) alt[alt.length - 1] = c
    } else {
      alt.push(c)
    }
  }
  // Drop the weakest end(s) until we have exactly numext.
  while (alt.length > numext) {
    if (Math.abs(E[alt[0]]) <= Math.abs(E[alt[alt.length - 1]])) alt.shift()
    else alt.pop()
  }
  return alt
}

export function remezDesign(
  numtaps: number,
  bands: RemezBand[],
  gridDensity = 16,
  maxIter = 40,
): RemezResult {
  const N = numtaps % 2 === 0 ? numtaps + 1 : numtaps // type I ⇒ odd length
  const M = (N - 1) / 2
  const nfcns = M + 1 // number of cosine basis functions
  const numext = nfcns + 1

  // ---- dense frequency grid over the union of bands ----
  const grid: number[] = []
  const D: number[] = []
  const W: number[] = []
  const delf = 0.5 / (gridDensity * nfcns)
  for (const b of bands) {
    const span = b.hi - b.lo
    const npts = Math.max(2, Math.floor(span / delf + 0.5) + 1)
    for (let i = 0; i < npts; i++) {
      let f = b.lo + i * delf
      if (i === npts - 1) f = b.hi
      if (f > b.hi) f = b.hi
      grid.push(f)
      D.push(b.desired)
      W.push(b.weight)
    }
  }
  const gridsize = grid.length

  // ---- initial extremal guess: evenly spread indices ----
  const ext = new Int32Array(numext)
  for (let i = 0; i < numext; i++) ext[i] = Math.round((i * (gridsize - 1)) / (numext - 1))

  const x = new Float64Array(numext)
  const y = new Float64Array(numext)
  const ad = new Float64Array(numext)
  const E = new Float64Array(gridsize)
  let dev = 0
  let iter = 0
  let converged = false

  for (; iter < maxIter; iter++) {
    for (let i = 0; i < numext; i++) x[i] = Math.cos(2 * Math.PI * grid[ext[i]])

    // Barycentric weights ad[i] = 1 / ∏_{k≠i} (x_i − x_k), with the classic
    // "jet" skip that keeps the product from over/underflowing for long filters.
    const ld = Math.floor((numext - 1) / 15) + 1
    for (let i = 0; i < numext; i++) {
      let denom = 1
      const xi = x[i]
      for (let j = 0; j < ld; j++) {
        for (let k = j; k < numext; k += ld) {
          if (k !== i) denom *= 2 * (xi - x[k])
        }
      }
      if (Math.abs(denom) < 1e-30) denom = denom < 0 ? -1e-30 : 1e-30
      ad[i] = 1 / denom
    }

    // Closed-form deviation δ.
    let numer = 0
    let den = 0
    let sign = 1
    for (let i = 0; i < numext; i++) {
      numer += ad[i] * D[ext[i]]
      den += (sign * ad[i]) / W[ext[i]]
      sign = -sign
    }
    dev = numer / den

    // Amplitude targets at the extrema, offset by the alternating ±δ/W.
    sign = 1
    for (let i = 0; i < numext; i++) {
      y[i] = D[ext[i]] - (sign * dev) / W[ext[i]]
      sign = -sign
    }

    // Weighted error on the whole grid.
    for (let i = 0; i < gridsize; i++) {
      E[i] = W[i] * (D[i] - computeA(grid[i], numext, ad, x, y))
    }

    const newext = searchExtrema(E, gridsize, numext)
    if (newext.length === numext) {
      let mn = Infinity
      let mx = 0
      for (const e of newext) {
        const a = Math.abs(E[e])
        if (a < mn) mn = a
        if (a > mx) mx = a
      }
      for (let i = 0; i < numext; i++) ext[i] = newext[i]
      if (mx > 0 && (mx - mn) / mx < 1e-4) {
        converged = true
        iter++
        break
      }
    } else if (newext.length > 0) {
      for (let i = 0; i < numext; i++) ext[i] = newext[Math.min(i, newext.length - 1)]
    }
  }

  // ---- reconstruct the taps from the converged amplitude response ----
  // The type-I amplitude A(ω) is a real even cosine polynomial; sampling the
  // linear-phase spectrum H_k = A(ω_k)·e^{−jMω_k} on N points and inverse-DFTing
  // (real part) yields the exact symmetric taps.
  const taps = new Float64Array(N)
  const A = new Float64Array(N)
  for (let k = 0; k < N; k++) {
    const fk = k / N
    A[k] = computeA(fk <= 0.5 ? fk : 1 - fk, numext, ad, x, y)
  }
  for (let n = 0; n < N; n++) {
    let acc = 0
    for (let k = 0; k < N; k++) {
      acc += A[k] * Math.cos((2 * Math.PI * k * (n - M)) / N)
    }
    taps[n] = acc / N
  }
  // Force exact symmetry (kills rounding asymmetry from the IDFT).
  for (let n = 0; n < M; n++) {
    const avg = 0.5 * (taps[n] + taps[N - 1 - n])
    taps[n] = avg
    taps[N - 1 - n] = avg
  }

  return { taps, deviation: Math.abs(dev), iterations: iter, converged }
}

/**
 * Build the band spec for a standard low/high/band/stop response and run Remez.
 * Edges are in cycles/sample (Nyquist = 0.5). `rippleWeight` weights the stopband
 * relative to the passband (>1 ⇒ deeper stopband at the cost of passband flatness).
 */
export function remezStandard(
  numtaps: number,
  response: 'low' | 'high' | 'band' | 'notch',
  edges: { f1: number; f2?: number; f3?: number; f4?: number },
  stopWeight = 1,
): RemezResult {
  const { f1, f2, f3, f4 } = edges
  let bands: RemezBand[]
  switch (response) {
    case 'low':
      bands = [
        { lo: 0, hi: f1, desired: 1, weight: 1 },
        { lo: f2 ?? f1 + 0.05, hi: 0.5, desired: 0, weight: stopWeight },
      ]
      break
    case 'high':
      bands = [
        { lo: 0, hi: f1, desired: 0, weight: stopWeight },
        { lo: f2 ?? f1 + 0.05, hi: 0.5, desired: 1, weight: 1 },
      ]
      break
    case 'band':
      bands = [
        { lo: 0, hi: f1, desired: 0, weight: stopWeight },
        { lo: f2 ?? f1 + 0.05, hi: f3 ?? 0.3, desired: 1, weight: 1 },
        { lo: f4 ?? (f3 ?? 0.3) + 0.05, hi: 0.5, desired: 0, weight: stopWeight },
      ]
      break
    case 'notch':
      bands = [
        { lo: 0, hi: f1, desired: 1, weight: 1 },
        { lo: f2 ?? f1 + 0.05, hi: f3 ?? 0.3, desired: 0, weight: stopWeight },
        { lo: f4 ?? (f3 ?? 0.3) + 0.05, hi: 0.5, desired: 1, weight: 1 },
      ]
      break
  }
  return remezDesign(numtaps, bands)
}
