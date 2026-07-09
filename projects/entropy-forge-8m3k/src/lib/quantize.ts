// quantize.ts — optimal quantiser design, the CONSTRUCTIVE side of rate–distortion.
//
// The rate–distortion function R(D) (see blahutArimoto.ts) says how few bits a
// source *can* be described in for a target distortion — an existence theorem.
// A quantiser is the concrete machine that spends those bits: it partitions the
// signal into cells and maps each to one reconstruction value. This module builds
// the OPTIMAL ones:
//
//   • Lloyd–Max — the optimal fixed-rate SCALAR quantiser for a known density,
//     found by alternating the two necessary conditions (nearest-neighbour cells,
//     centroid reconstruction). It is exactly k-means in 1-D against a pdf, and it
//     is where JPEG's per-coefficient quantisation lives.
//   • LBG (Linde–Buzo–Gray) — the same idea in higher dimensions: a VECTOR
//     quantiser grown by codeword splitting + generalised Lloyd. Vector quantisers
//     beat scalar ones even on i.i.d. data (the "space-filling" and "shape" gains),
//     the reason R(D) is only reachable in the limit of large blocks.
//
// Everything is measured against the theory so the operational (R, D) point can
// be dropped straight onto the R(D) curve on the page.

// ────────────────────────────────────────────────────────────────────────────
// Source densities (all normalised to unit variance so results are comparable)
// ────────────────────────────────────────────────────────────────────────────

export type Density = 'gaussian' | 'laplacian' | 'uniform'

export interface DensityDef {
  pdf: (x: number) => number
  /** A sensible integration/plot half-range in σ units (support edge for uniform). */
  span: number
  label: string
  /** Differential entropy h(X) in bits, for the rate context. */
  hDiff: number
}

export const DENSITIES: Record<Density, DensityDef> = {
  // Unit-variance standard normal.
  gaussian: {
    pdf: (x) => Math.exp(-(x * x) / 2) / Math.sqrt(2 * Math.PI),
    span: 6,
    label: 'Gaussian',
    hDiff: 0.5 * Math.log2(2 * Math.PI * Math.E), // ≈ 2.047 bits
  },
  // Zero-mean Laplacian, variance 1 ⇒ scale b = 1/√2.
  laplacian: {
    pdf: (x) => (1 / Math.SQRT2) * Math.exp(-Math.SQRT2 * Math.abs(x)),
    span: 8,
    label: 'Laplacian',
    hDiff: Math.log2(2 * Math.E * (1 / Math.SQRT2)), // log2(2 e b)
  },
  // Uniform on [−√3, √3] ⇒ variance 1. Its optimal quantiser is exactly uniform.
  uniform: {
    pdf: (x) => (Math.abs(x) <= Math.sqrt(3) ? 1 / (2 * Math.sqrt(3)) : 0),
    span: Math.sqrt(3),
    label: 'Uniform',
    hDiff: Math.log2(2 * Math.sqrt(3)), // log2(2√3)
  },
}

// ────────────────────────────────────────────────────────────────────────────
// Lloyd–Max scalar quantiser
// ────────────────────────────────────────────────────────────────────────────

export interface LloydResult {
  /** Reconstruction levels y₁ < y₂ < … < y_N (the codebook). */
  levels: number[]
  /** Interior decision boundaries b₁ < … < b_{N−1} (b₀=−∞, b_N=+∞ implied). */
  boundaries: number[]
  /** Probability mass of each cell P_k = ∫_{cell} p. */
  cellProb: number[]
  /** Mean-squared distortion D = E[(X−Q(X))²]. */
  distortion: number
  /** Fixed-rate cost log₂N (bits/sample if indices sent raw). */
  rateFixed: number
  /** Output entropy H = −Σ P_k log₂P_k (bits/sample if indices are entropy-coded). */
  entropy: number
  /** Signal-to-noise ratio 10·log₁₀(σ²/D) in dB (σ²=1). */
  snrDb: number
  /** Distortion after each Lloyd iteration — monotone non-increasing. */
  trace: number[]
  iterations: number
}

/**
 * Design the optimal N-level scalar quantiser for a density by Lloyd's algorithm.
 * The density is discretised onto a fine grid; each iteration recomputes cell
 * boundaries as level midpoints (nearest-neighbour condition) and each level as
 * its cell's centroid (centroid condition). Distortion falls monotonically to a
 * fixed point satisfying both necessary conditions.
 */
export function lloydMax(
  density: DensityDef,
  N: number,
  opts: { grid?: number; tol?: number; maxIter?: number } = {},
): LloydResult {
  const M = opts.grid ?? 6000
  const tol = opts.tol ?? 1e-10
  const maxIter = opts.maxIter ?? 300
  const L = density.span
  const step = (2 * L) / M
  // Grid points and their probability mass (mid-point rule).
  const gx = new Array<number>(M)
  const gw = new Array<number>(M)
  let Z = 0
  for (let i = 0; i < M; i++) {
    const x = -L + (i + 0.5) * step
    gx[i] = x
    const w = density.pdf(x) * step
    gw[i] = w
    Z += w
  }
  for (let i = 0; i < M; i++) gw[i] /= Z // normalise away truncation error

  // Initialise levels at equiprobable-cell centroids (good, robust start).
  let levels = initLevels(gx, gw, N)

  const trace: number[] = []
  let prevD = Infinity
  let iter = 0
  const sum0 = new Array<number>(N)
  const sum1 = new Array<number>(N)
  for (; iter < maxIter; iter++) {
    for (let k = 0; k < N; k++) {
      sum0[k] = 0
      sum1[k] = 0
    }
    // Assign each grid point to its nearest level (levels kept sorted).
    let k = 0
    for (let i = 0; i < M; i++) {
      const x = gx[i]
      // Advance k while the midpoint to the next level is passed.
      while (k < N - 1 && x > (levels[k] + levels[k + 1]) / 2) k++
      sum0[k] += gw[i]
      sum1[k] += gw[i] * x
    }
    // Centroid update; distortion for the trace.
    const nl = new Array<number>(N)
    for (let j = 0; j < N; j++) nl[j] = sum0[j] > 0 ? sum1[j] / sum0[j] : levels[j]
    // Nudge apart any collided/empty levels to keep them strictly sorted.
    for (let j = 1; j < N; j++) if (nl[j] <= nl[j - 1]) nl[j] = nl[j - 1] + 1e-6
    levels = nl
    const D = distortionOf(gx, gw, levels)
    trace.push(D)
    if (Math.abs(prevD - D) < tol) {
      iter++
      break
    }
    prevD = D
  }

  const boundaries: number[] = []
  for (let j = 0; j < N - 1; j++) boundaries.push((levels[j] + levels[j + 1]) / 2)

  // Cell probabilities and output entropy.
  const cellProb = cellProbabilities(gx, gw, levels)
  let H = 0
  for (const p of cellProb) if (p > 0) H -= p * Math.log2(p)

  const distortion = distortionOf(gx, gw, levels)
  return {
    levels,
    boundaries,
    cellProb,
    distortion,
    rateFixed: Math.log2(N),
    entropy: H,
    snrDb: distortion > 0 ? 10 * Math.log10(1 / distortion) : Infinity,
    trace,
    iterations: iter,
  }
}

/** Initial levels = centroids of N equal-probability cells (inverse-CDF split). */
function initLevels(gx: number[], gw: number[], N: number): number[] {
  const M = gx.length
  const targets: number[] = []
  for (let k = 0; k < N; k++) targets.push((k + 0.5) / N)
  const levels: number[] = []
  let acc = 0
  let ti = 0
  // Accumulate cdf; place a level at each equiprobable centroid target.
  let cellSum0 = 0
  let cellSum1 = 0
  let lastCut = 0
  for (let i = 0; i < M; i++) {
    acc += gw[i]
    cellSum0 += gw[i]
    cellSum1 += gw[i] * gx[i]
    const nextCut = ti < N ? (ti + 1) / N : 1
    if (acc >= nextCut || i === M - 1) {
      if (ti < N) {
        levels.push(cellSum0 > 0 ? cellSum1 / cellSum0 : gx[i])
        ti++
      }
      cellSum0 = 0
      cellSum1 = 0
      lastCut = acc
    }
  }
  void lastCut
  void targets
  while (levels.length < N) levels.push(levels[levels.length - 1] + 1e-3)
  // Ensure strictly increasing.
  for (let j = 1; j < levels.length; j++) if (levels[j] <= levels[j - 1]) levels[j] = levels[j - 1] + 1e-4
  return levels
}

function distortionOf(gx: number[], gw: number[], levels: number[]): number {
  const N = levels.length
  let D = 0
  let k = 0
  for (let i = 0; i < gx.length; i++) {
    const x = gx[i]
    while (k < N - 1 && x > (levels[k] + levels[k + 1]) / 2) k++
    const e = x - levels[k]
    D += gw[i] * e * e
  }
  return D
}

function cellProbabilities(gx: number[], gw: number[], levels: number[]): number[] {
  const N = levels.length
  const p = new Array<number>(N).fill(0)
  let k = 0
  for (let i = 0; i < gx.length; i++) {
    const x = gx[i]
    while (k < N - 1 && x > (levels[k] + levels[k + 1]) / 2) k++
    p[k] += gw[i]
  }
  return p
}

/**
 * A plain UNIFORM quantiser of N levels loaded to ±Lq, for comparison against
 * Lloyd–Max. Reconstruction at cell centres, distortion (granular + overload)
 * integrated over the true density. On a uniform source this equals Lloyd–Max;
 * on Gaussian/Laplacian it is measurably worse — the gain Lloyd–Max buys.
 */
export function uniformQuantizer(density: DensityDef, N: number, loadSigma: number): number {
  const Lq = loadSigma
  const delta = (2 * Lq) / N
  const M = 8000
  const L = Math.max(density.span, Lq + delta)
  const step = (2 * L) / M
  let Z = 0
  const gw = new Array<number>(M)
  const gx = new Array<number>(M)
  for (let i = 0; i < M; i++) {
    const x = -L + (i + 0.5) * step
    gx[i] = x
    gw[i] = density.pdf(x) * step
    Z += gw[i]
  }
  let D = 0
  for (let i = 0; i < M; i++) {
    const x = gx[i]
    // Nearest uniform reconstruction level (mid-rise), clamped at the outer levels.
    let idx = Math.floor((x + Lq) / delta)
    if (idx < 0) idx = 0
    if (idx > N - 1) idx = N - 1
    const y = -Lq + (idx + 0.5) * delta
    const e = x - y
    D += (gw[i] / Z) * e * e
  }
  return D
}

/**
 * High-rate (Bennett) prediction of Lloyd–Max distortion:
 *   D ≈ (1/12)·2^{−2R}·(∫ p^{1/3})³ · 2^{2h?}  — expressed via the well-known
 * per-source constants: for large N, SNR ≈ 6.02·R + c, with c = −4.35 dB
 * (Gaussian) / −3.01 dB via the shape factor. We return the classic 6.02R slope
 * anchor used to draw the asymptote on the page.
 */
export function highRateSlopeDb(R: number, source: Density): number {
  // SNR(R) ≈ 6.0206·R + c_source (dB), c from the Panter–Dite / shape factor.
  const c: Record<Density, number> = { uniform: 0, gaussian: -4.35, laplacian: -3.0 }
  return 6.0206 * R + c[source]
}

// ────────────────────────────────────────────────────────────────────────────
// Vector quantiser (LBG / generalised Lloyd) in 2-D
// ────────────────────────────────────────────────────────────────────────────

export type Vec2 = [number, number]

export interface LBGResult {
  codebook: Vec2[]
  /** Cluster index for each input point. */
  assign: number[]
  distortion: number
  /** Distortion after each Lloyd refinement step (across all splits) — monotone. */
  trace: number[]
  iterations: number
}

/**
 * Linde–Buzo–Gray vector quantiser. Starts from the single global centroid and
 * repeatedly (a) SPLITS every codeword into a perturbed pair, then (b) runs
 * generalised Lloyd (assign to nearest ⇒ recompute centroids) until the codebook
 * reaches N words. Both steps only ever lower distortion, so the trace is
 * monotone non-increasing — the vector analogue of Lloyd–Max.
 */
export function lbg(
  data: Vec2[],
  N: number,
  opts: { eps?: number; lloydIters?: number; tol?: number } = {},
): LBGResult {
  const eps = opts.eps ?? 0.01
  const lloydIters = opts.lloydIters ?? 40
  const tol = opts.tol ?? 1e-9
  const n = data.length

  const trace: number[] = []
  let codebook: Vec2[] = [meanOf(data, range(n))]
  let assign = new Array<number>(n).fill(0)
  let totalIters = 0

  while (codebook.length < N) {
    // Split each codeword into two perturbed copies.
    const next: Vec2[] = []
    for (const c of codebook) {
      next.push([c[0] * (1 + eps) + 1e-4, c[1] * (1 + eps)])
      next.push([c[0] * (1 - eps) - 1e-4, c[1] * (1 - eps)])
    }
    codebook = next.slice(0, N)
    // Generalised Lloyd refine.
    let prevD = Infinity
    for (let it = 0; it < lloydIters; it++) {
      assign = assignNearest(data, codebook)
      recomputeCentroids(data, assign, codebook)
      const D = vqDistortion(data, assign, codebook)
      trace.push(D)
      totalIters++
      if (Math.abs(prevD - D) < tol) break
      prevD = D
    }
  }
  // A final refine to settle.
  let prevD = trace.length ? trace[trace.length - 1] : Infinity
  for (let it = 0; it < lloydIters; it++) {
    assign = assignNearest(data, codebook)
    recomputeCentroids(data, assign, codebook)
    const D = vqDistortion(data, assign, codebook)
    trace.push(D)
    totalIters++
    if (Math.abs(prevD - D) < tol) break
    prevD = D
  }

  return { codebook, assign, distortion: vqDistortion(data, assign, codebook), trace, iterations: totalIters }
}

function range(n: number): number[] {
  const r = new Array<number>(n)
  for (let i = 0; i < n; i++) r[i] = i
  return r
}

function meanOf(data: Vec2[], idx: number[]): Vec2 {
  let sx = 0
  let sy = 0
  for (const i of idx) {
    sx += data[i][0]
    sy += data[i][1]
  }
  const m = idx.length || 1
  return [sx / m, sy / m]
}

function assignNearest(data: Vec2[], cb: Vec2[]): number[] {
  const a = new Array<number>(data.length)
  for (let i = 0; i < data.length; i++) {
    const p = data[i]
    let best = 0
    let bd = Infinity
    for (let k = 0; k < cb.length; k++) {
      const dx = p[0] - cb[k][0]
      const dy = p[1] - cb[k][1]
      const dd = dx * dx + dy * dy
      if (dd < bd) {
        bd = dd
        best = k
      }
    }
    a[i] = best
  }
  return a
}

function recomputeCentroids(data: Vec2[], assign: number[], cb: Vec2[]): void {
  const K = cb.length
  const sx = new Array<number>(K).fill(0)
  const sy = new Array<number>(K).fill(0)
  const cnt = new Array<number>(K).fill(0)
  for (let i = 0; i < data.length; i++) {
    const k = assign[i]
    sx[k] += data[i][0]
    sy[k] += data[i][1]
    cnt[k]++
  }
  for (let k = 0; k < K; k++) {
    if (cnt[k] > 0) {
      cb[k] = [sx[k] / cnt[k], sy[k] / cnt[k]]
    }
    // Empty cells keep their position; the next split perturbs them anyway.
  }
}

function vqDistortion(data: Vec2[], assign: number[], cb: Vec2[]): number {
  let D = 0
  for (let i = 0; i < data.length; i++) {
    const p = data[i]
    const c = cb[assign[i]]
    const dx = p[0] - c[0]
    const dy = p[1] - c[1]
    D += dx * dx + dy * dy
  }
  return D / (data.length || 1)
}

// ────────────────────────────────────────────────────────────────────────────
// A small deterministic sampler for the VQ demo (Gaussian-mixture blobs).
// ────────────────────────────────────────────────────────────────────────────

/** Minimal xorshift RNG so the VQ demo is deterministic (no Math.random). */
export class QRng {
  private s: number
  constructor(seed = 0x2545f491) {
    this.s = seed >>> 0 || 1
  }
  next(): number {
    let x = this.s
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.s = x >>> 0
    return this.s / 4294967296
  }
  normal(): number {
    let u = 0
    let v = 0
    while (u === 0) u = this.next()
    while (v === 0) v = this.next()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
}

/** Sample a 2-D Gaussian mixture with `blobs` clusters (deterministic given seed). */
export function sampleMixture(count: number, blobs: number, rng: QRng): Vec2[] {
  const centers: Vec2[] = []
  for (let b = 0; b < blobs; b++) {
    const ang = (2 * Math.PI * b) / blobs
    centers.push([Math.cos(ang) * 2.2, Math.sin(ang) * 2.2])
  }
  const out: Vec2[] = []
  for (let i = 0; i < count; i++) {
    const c = centers[i % blobs]
    out.push([c[0] + rng.normal() * 0.55, c[1] + rng.normal() * 0.55])
  }
  return out
}
