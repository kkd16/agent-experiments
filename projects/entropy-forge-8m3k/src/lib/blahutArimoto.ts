// blahutArimoto.ts — the Blahut–Arimoto algorithm, the numerical engine that
// computes the two fundamental limits of information theory for an ARBITRARY
// discrete source or channel, in cases where no closed form exists.
//
// Everywhere else in this lab the limits are known analytically — the entropy
// floor H(X), the BSC capacity 1−H(p), the Gaussian R(D)=½log(σ²/D). Those are
// the lucky special cases. Blahut–Arimoto (Arimoto 1972 / Blahut 1972) is the
// general answer: an alternating-minimisation (an instance of what we now call
// the EM / mirror-descent family) that provably converges to
//
//   • CHANNEL CAPACITY  C = max_{p(x)} I(X;Y)   — the most bits/use a channel carries, and
//   • the RATE–DISTORTION function  R(D) = min_{p(x̂|x): E[d]≤D} I(X;X̂)
//                                    — the fewest bits/symbol to describe a source within distortion D.
//
// The two are duals: capacity is a MAX of mutual information over inputs, R(D)
// is a MIN of mutual information over test channels. One algorithm, run in two
// directions, pins down both halves of Shannon's theory. Everything is in bits
// (log base 2) and dependency-free.

const LOG2E = Math.LOG2E

/** x·log₂x with the 0·log0 = 0 convention. */
function xlog2x(x: number): number {
  return x <= 0 ? 0 : x * Math.log2(x)
}

// ────────────────────────────────────────────────────────────────────────────
// Channel capacity
// ────────────────────────────────────────────────────────────────────────────

export interface CapacityResult {
  /** Capacity in bits per channel use (the converged achievable value I_L). */
  C: number
  /** The capacity-achieving input distribution p*(x). */
  inputDist: number[]
  /** The induced output distribution p*(y) = Σ_x p*(x) Q(y|x). */
  outputDist: number[]
  /** Per-input divergence Dₓ = D(Q(·|x) ‖ p_Y) at convergence — all equal to C on the support (KKT). */
  perInput: number[]
  /** Convergence trace: {iter, lower I_L, upper I_U} — the sandwich squeezing onto C. */
  trace: { iter: number; lower: number; upper: number }[]
  iterations: number
  /** Final gap I_U − I_L (bits) — the certified accuracy. */
  gap: number
}

/**
 * Capacity of a discrete memoryless channel by Blahut–Arimoto.
 *
 * @param Q  transition matrix, Q[x][y] = P(y | x). Rows (inputs) must sum to 1.
 *
 * Each iteration computes, for the current input law p,
 *   the output law   p_Y(y) = Σ_x p(x) Q(y|x),
 *   the per-input divergence  Dₓ = Σ_y Q(y|x) log₂( Q(y|x) / p_Y(y) ),
 * then multiplicatively reweights  p(x) ← p(x)·2^{Dₓ}, renormalised.
 * The classic bounds  I_L = Σ_x p(x)Dₓ ≤ C ≤ maxₓ Dₓ = I_U  sandwich the answer
 * and their gap → 0, giving a certified stopping test rather than a guess.
 */
export function channelCapacity(
  Q: number[][],
  opts: { tol?: number; maxIter?: number } = {},
): CapacityResult {
  const tol = opts.tol ?? 1e-10
  const maxIter = opts.maxIter ?? 5000
  const nX = Q.length
  const nY = Q[0].length

  // Uniform start keeps every input on the support so no log blows up.
  let p = new Array<number>(nX).fill(1 / nX)
  const trace: { iter: number; lower: number; upper: number }[] = []
  const pY = new Array<number>(nY).fill(0)
  const D = new Array<number>(nX).fill(0)

  let iter = 0
  let lower = 0
  let upper = 0
  for (; iter < maxIter; iter++) {
    // Output distribution induced by the current input law.
    pY.fill(0)
    for (let x = 0; x < nX; x++) {
      const px = p[x]
      if (px === 0) continue
      const row = Q[x]
      for (let y = 0; y < nY; y++) pY[y] += px * row[y]
    }
    // Per-input divergence Dₓ = D(Q(·|x) ‖ p_Y).
    for (let x = 0; x < nX; x++) {
      const row = Q[x]
      let d = 0
      for (let y = 0; y < nY; y++) {
        const q = row[y]
        if (q > 0 && pY[y] > 0) d += q * Math.log2(q / pY[y])
      }
      D[x] = d
    }
    // Bounds. I_L is the current mutual information (achievable); I_U = maxₓ Dₓ.
    lower = 0
    upper = -Infinity
    for (let x = 0; x < nX; x++) {
      lower += p[x] * D[x]
      if (D[x] > upper) upper = D[x]
    }
    trace.push({ iter, lower, upper })
    if (upper - lower < tol) break

    // Multiplicative reweight p ← p·2^{Dₓ}, renormalised.
    let Z = 0
    const np = new Array<number>(nX)
    for (let x = 0; x < nX; x++) {
      np[x] = p[x] * Math.pow(2, D[x])
      Z += np[x]
    }
    for (let x = 0; x < nX; x++) np[x] /= Z
    p = np
  }

  // Final output law for reporting.
  pY.fill(0)
  for (let x = 0; x < nX; x++) {
    for (let y = 0; y < nY; y++) pY[y] += p[x] * Q[x][y]
  }

  return {
    C: lower,
    inputDist: p,
    outputDist: pY.slice(),
    perInput: D.slice(),
    trace,
    iterations: iter + 1,
    gap: upper - lower,
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Standard channels as transition matrices, so the page (and the self-test) can
// feed Blahut–Arimoto a channel whose capacity has a known closed form.
// ────────────────────────────────────────────────────────────────────────────

/** Binary symmetric channel: each bit flips with probability p. C = 1 − H(p). */
export function bscMatrix(p: number): number[][] {
  return [
    [1 - p, p],
    [p, 1 - p],
  ]
}

/**
 * Binary erasure channel: outputs {0, ?, 1}. A bit survives w.p. 1−ε, else it is
 * erased. C = 1 − ε. The middle column is the erasure symbol.
 */
export function becMatrix(eps: number): number[][] {
  return [
    [1 - eps, eps, 0],
    [0, eps, 1 - eps],
  ]
}

/**
 * Z-channel (asymmetric): a 0 is never corrupted, a 1 decays to 0 w.p. p. The
 * capacity-achieving input is NOT uniform — a lovely demonstration that BA finds
 * the right, skewed input law on its own. Closed form:
 *   C = log₂(1 + (1−p)·p^{p/(1−p)}).
 */
export function zChannelMatrix(p: number): number[][] {
  return [
    [1, 0],
    [p, 1 - p],
  ]
}

/** Analytic Z-channel capacity, for cross-checking BA. */
export function zChannelCapacity(p: number): number {
  if (p <= 0) return 1
  if (p >= 1) return 0
  // The optimal input maximises I; the closed form gives capacity directly.
  const z = Math.pow(p, p / (1 - p))
  return Math.log2(1 + (1 - p) * z)
}

/** A noiseless K-ary channel (identity matrix). Capacity = log₂ K, uniform input. */
export function noiselessMatrix(K: number): number[][] {
  return Array.from({ length: K }, (_, i) => Array.from({ length: K }, (_, j) => (i === j ? 1 : 0)))
}

/**
 * Noisy typewriter (Shannon's example): K symbols on a ring, each received as
 * itself or its right neighbour with equal probability. Capacity = log₂(K/2),
 * achieved by using every other input — a code, discovered by BA as a two-point
 * input support pattern.
 */
export function typewriterMatrix(K: number): number[][] {
  return Array.from({ length: K }, (_, i) =>
    Array.from({ length: K }, (_, j) => (j === i || j === (i + 1) % K ? 0.5 : 0)),
  )
}

// ────────────────────────────────────────────────────────────────────────────
// The rate–distortion function R(D)
// ────────────────────────────────────────────────────────────────────────────

export interface RDPoint {
  /** Lagrange slope s ≤ 0 that produced this point; dR/dD = s/ln2 in bits/unit. */
  s: number
  /** Achieved average distortion. */
  D: number
  /** Achieved rate in bits/symbol = I(X;X̂). */
  R: number
  iterations: number
}

/**
 * One point of the rate–distortion curve for a fixed Lagrange slope, by
 * Blahut–Arimoto. Given a source law p(x), a reconstruction alphabet and a
 * distortion matrix d[x][x̂] ≥ 0, the parametric solution for slope s ≤ 0 is the
 * fixed point of
 *   Q(x̂|x) = q(x̂)·e^{s·d(x,x̂)} / Σ_{x̂'} q(x̂')·e^{s·d(x,x̂')},
 *   q(x̂)   = Σ_x p(x) Q(x̂|x),
 * after which  D = Σ p(x)Q(x̂|x)d(x,x̂)  and  R = Σ p(x)Q(x̂|x)log₂(Q(x̂|x)/q(x̂)).
 * Sweeping s from 0⁻ (→ D_max, R=0) to −∞ (→ D_min, R=H) traces the whole curve.
 */
export function rdPoint(
  p: number[],
  d: number[][],
  s: number,
  opts: { tol?: number; maxIter?: number } = {},
): RDPoint {
  const tol = opts.tol ?? 1e-11
  const maxIter = opts.maxIter ?? 4000
  const nX = p.length
  const nXh = d[0].length

  // Precompute the kernel e^{s·d} once — s is fixed for this point.
  const K: number[][] = Array.from({ length: nX }, (_, x) =>
    Array.from({ length: nXh }, (_, xh) => Math.exp(s * d[x][xh])),
  )

  let q = new Array<number>(nXh).fill(1 / nXh)
  // Conditional test channel, reused each sweep.
  const Q: number[][] = Array.from({ length: nX }, () => new Array<number>(nXh).fill(0))

  let iter = 0
  for (; iter < maxIter; iter++) {
    // E-step: the optimal test channel for the current output marginal.
    for (let x = 0; x < nX; x++) {
      const Kx = K[x]
      let norm = 0
      for (let xh = 0; xh < nXh; xh++) norm += q[xh] * Kx[xh]
      const Qx = Q[x]
      if (norm <= 0) {
        // Degenerate (all kernels underflowed): concentrate on the min-distortion x̂.
        let best = 0
        for (let xh = 1; xh < nXh; xh++) if (d[x][xh] < d[x][best]) best = xh
        for (let xh = 0; xh < nXh; xh++) Qx[xh] = xh === best ? 1 : 0
      } else {
        for (let xh = 0; xh < nXh; xh++) Qx[xh] = (q[xh] * Kx[xh]) / norm
      }
    }
    // M-step: refresh the output marginal.
    const nq = new Array<number>(nXh).fill(0)
    for (let x = 0; x < nX; x++) {
      const px = p[x]
      const Qx = Q[x]
      for (let xh = 0; xh < nXh; xh++) nq[xh] += px * Qx[xh]
    }
    let delta = 0
    for (let xh = 0; xh < nXh; xh++) delta += Math.abs(nq[xh] - q[xh])
    q = nq
    if (delta < tol) {
      iter++
      break
    }
  }

  // Read off the operating point.
  let D = 0
  let R = 0
  for (let x = 0; x < nX; x++) {
    const px = p[x]
    if (px === 0) continue
    const Qx = Q[x]
    for (let xh = 0; xh < nXh; xh++) {
      const qc = Qx[xh]
      if (qc <= 0) continue
      D += px * qc * d[x][xh]
      if (q[xh] > 0) R += px * qc * Math.log2(qc / q[xh])
    }
  }
  if (R < 0) R = 0 // guard tiny negative round-off near the R=0 corner
  return { s, D, R, iterations: iter }
}

/**
 * Trace the full R(D) curve by sweeping the Lagrange slope. Slopes are placed
 * densely near 0 (where the curve turns over toward D_max) and stretched out
 * toward large negative values (approaching the lossless corner R→H).
 */
export function rdCurve(
  p: number[],
  d: number[][],
  opts: { points?: number; sMax?: number } = {},
): RDPoint[] {
  const n = opts.points ?? 60
  const sMax = opts.sMax ?? 60 // |s| grows to this; larger ⇒ closer to D_min
  const out: RDPoint[] = []
  for (let i = 0; i < n; i++) {
    // Geometric-ish spacing in |s| for smooth coverage of both corners.
    const t = i / (n - 1)
    const s = -sMax * Math.pow(t, 2.2) - 1e-4
    out.push(rdPoint(p, d, s))
  }
  // Sort by distortion ascending so the polyline is monotone in x.
  out.sort((a, b) => a.D - b.D)
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// Source/distortion builders + the closed forms they should reproduce.
// ────────────────────────────────────────────────────────────────────────────

/** Source law of a Bernoulli(p) binary source, alphabet {0,1}. */
export function bernoulliSource(p: number): number[] {
  return [1 - p, p]
}

/** Hamming distortion on a k-symbol alphabet: 0 on the diagonal, 1 off it. */
export function hammingDistortion(k: number): number[][] {
  return Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => (i === j ? 0 : 1)))
}

/** Binary entropy H(p) in bits. */
export function binEntropy(p: number): number {
  return -xlog2x(p) - xlog2x(1 - p)
}

/**
 * Closed-form R(D) for a Bernoulli(p) source under Hamming distortion:
 *   R(D) = H(p) − H(D)  for 0 ≤ D ≤ min(p,1−p),  else 0.
 * The theoretical curve BA must reproduce.
 */
export function bernoulliRD(p: number, D: number): number {
  const pm = Math.min(p, 1 - p)
  if (D >= pm) return 0
  if (D <= 0) return binEntropy(p)
  return Math.max(0, binEntropy(p) - binEntropy(D))
}

/**
 * Gaussian source of variance σ² under squared-error distortion (continuous):
 *   R(D) = ½·log₂(σ²/D)  for 0 < D ≤ σ²,  else 0.
 */
export function gaussianRD(sigma2: number, D: number): number {
  if (D >= sigma2) return 0
  if (D <= 0) return Infinity
  return 0.5 * Math.log2(sigma2 / D)
}

/**
 * A finite quantisation of a zero-mean Gaussian into `n` mass points on a grid,
 * plus a squared-error distortion matrix over the same points, so BA can trace
 * the Gaussian R(D) numerically and be laid against the ½log₂(σ²/D) closed form.
 */
export function discreteGaussian(
  sigma: number,
  n: number,
  span = 4,
): { levels: number[]; p: number[]; d: number[][] } {
  const levels: number[] = []
  for (let i = 0; i < n; i++) levels.push(-span * sigma + ((2 * span * sigma) * i) / (n - 1))
  const step = levels[1] - levels[0]
  const pdf = (x: number) => Math.exp(-(x * x) / (2 * sigma * sigma))
  const p = levels.map((x) => pdf(x) * step)
  const Z = p.reduce((a, b) => a + b, 0)
  for (let i = 0; i < n; i++) p[i] /= Z
  const d = levels.map((x) => levels.map((y) => (x - y) * (x - y)))
  return { levels, p, d }
}

// Keep LOG2E referenced (used implicitly in bit conversions elsewhere); exporting
// avoids an unused-const lint while documenting the base convention.
export const BITS_PER_NAT = LOG2E
