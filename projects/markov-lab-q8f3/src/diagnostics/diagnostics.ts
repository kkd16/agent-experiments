// Convergence & efficiency diagnostics — the numbers that tell you whether a
// chain has actually explored the target or is just wandering. All computed
// from scratch: autocorrelation, effective sample size, and split-R̂.

export function mean(a: number[]): number {
  let s = 0
  for (const v of a) s += v
  return s / a.length
}

export function variance(a: number[], m = mean(a)): number {
  let s = 0
  for (const v of a) s += (v - m) ** 2
  return s / Math.max(1, a.length - 1)
}

export function std(a: number[]): number {
  return Math.sqrt(variance(a))
}

/**
 * Normalised autocorrelation ρ(k) for k = 0…maxLag, computed directly.
 * ρ(0) = 1 by construction.
 */
export function autocorr(a: number[], maxLag: number): number[] {
  const n = a.length
  const m = mean(a)
  let denom = 0
  for (let i = 0; i < n; i++) denom += (a[i] - m) ** 2
  denom = denom || 1
  const out = new Array<number>(maxLag + 1)
  for (let k = 0; k <= maxLag; k++) {
    let s = 0
    for (let i = 0; i < n - k; i++) s += (a[i] - m) * (a[i + k] - m)
    out[k] = s / denom
  }
  return out
}

/**
 * Effective sample size from the initial-positive-sequence estimator
 * (Geyer 1992): ESS = N / (1 + 2 Σ ρ(k)), truncating the sum where
 * consecutive autocorrelation pairs first go non-positive.
 */
export function effectiveSampleSize(a: number[]): number {
  const n = a.length
  if (n < 8) return n
  const maxLag = Math.min(n - 1, 1000)
  const rho = autocorr(a, maxLag)
  let sum = 0
  for (let k = 1; k + 1 <= maxLag; k += 2) {
    const pair = rho[k] + rho[k + 1]
    if (pair <= 0) break
    sum += pair
  }
  const tau = 1 + 2 * sum // integrated autocorrelation time
  return Math.max(1, n / tau)
}

/** Integrated autocorrelation time τ = N / ESS. */
export function iact(a: number[]): number {
  return a.length / effectiveSampleSize(a)
}

/**
 * Split-R̂ (Gelman et al.): split one chain into two halves and compare
 * between- vs within-half variance. Values near 1 signal convergence;
 * anything above ~1.1 is a red flag.
 */
export function splitRHat(a: number[]): number {
  const n = a.length
  if (n < 8) return NaN
  const half = Math.floor(n / 2)
  const c1 = a.slice(0, half)
  const c2 = a.slice(half, 2 * half)
  const m1 = mean(c1)
  const m2 = mean(c2)
  const v1 = variance(c1, m1)
  const v2 = variance(c2, m2)
  const W = (v1 + v2) / 2 // within-chain variance
  const grand = (m1 + m2) / 2
  const B = half * ((m1 - grand) ** 2 + (m2 - grand) ** 2) // between-chain
  const varHat = ((half - 1) / half) * W + B / half
  return Math.sqrt(varHat / (W || 1e-12))
}

/** Quantile via linear interpolation on a sorted copy. */
export function quantile(a: number[], q: number): number {
  if (a.length === 0) return NaN
  const s = [...a].sort((x, y) => x - y)
  const pos = q * (s.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return s[lo]
  return s[lo] + (pos - lo) * (s[hi] - s[lo])
}
