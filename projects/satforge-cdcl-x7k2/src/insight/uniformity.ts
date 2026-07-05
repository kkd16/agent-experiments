// Measuring how uniform a sampler really is.
//
// A sampler that *claims* to be uniform is easy to write and hard to trust. On the
// small instances the studio explores we can settle the question exactly: enumerate the
// entire solution space (projected onto the sampling set), then compare the empirical
// frequencies of a batch of draws against the flat 1/K target. This module turns that
// comparison into numbers a human — and a self-test — can read: total-variation
// distance, Pearson's χ², coverage, and the min/max frequency ratio, plus per-variable
// marginals (exact vs sampled). All exact, all deterministic.

import type { CNF } from '../sat/cnf'
import { projectedModels } from './enumerate'
import type { Sample } from './sampling'

// --- χ² goodness-of-fit tail probability, from scratch ---------------------
// The p-value of a χ² test is the survival function of the χ²ₖ distribution at the
// observed statistic: p = Q(k/2, x/2), where Q(a,x) is the regularized *upper*
// incomplete gamma function. We implement Q from the standard series / continued-
// fraction split (Numerical Recipes §6.2) so the studio reports a real confidence,
// not just the raw statistic — no external stats library.

function gammaln(x: number): number {
  // Lanczos approximation to ln Γ(x), accurate to ~1e-10 for x > 0.
  const g = 7
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ]
  if (x < 0.5) {
    // Reflection formula for completeness (unused here, but keeps the function total).
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - gammaln(1 - x)
  }
  x -= 1
  let a = c[0]
  const t = x + g + 0.5
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

/** Regularized lower incomplete gamma P(a,x) by its series expansion (x < a+1). */
function gammpSeries(a: number, x: number): number {
  if (x <= 0) return 0
  let ap = a
  let sum = 1 / a
  let del = sum
  for (let n = 0; n < 300; n++) {
    ap += 1
    del *= x / ap
    sum += del
    if (Math.abs(del) < Math.abs(sum) * 1e-14) break
  }
  return sum * Math.exp(-x + a * Math.log(x) - gammaln(a))
}

/** Regularized upper incomplete gamma Q(a,x) by its continued fraction (x ≥ a+1). */
function gammqCF(a: number, x: number): number {
  const tiny = 1e-30
  let b = x + 1 - a
  let c = 1 / tiny
  let d = 1 / b
  let h = d
  for (let i = 1; i <= 300; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < tiny) d = tiny
    c = b + an / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-14) break
  }
  return Math.exp(-x + a * Math.log(x) - gammaln(a)) * h
}

/** Upper-tail probability Q(a,x) = 1 − P(a,x). */
function gammq(a: number, x: number): number {
  if (x < 0 || a <= 0) return 1
  if (x < a + 1) return 1 - gammpSeries(a, x)
  return gammqCF(a, x)
}

/** The p-value of a χ² statistic with `dof` degrees of freedom (survival function). */
export function chiSquarePValue(chi2: number, dof: number): number {
  if (dof <= 0) return 1
  if (chi2 <= 0) return 1
  return Math.max(0, Math.min(1, gammq(dof / 2, chi2 / 2)))
}

/** Bit-string key of an assignment restricted to `vars` (order = `vars`). */
export function sampleKey(assign: boolean[], vars: number[]): string {
  let s = ''
  for (const v of vars) s += assign[v] ? '1' : '0'
  return s
}

export interface UniformityReport {
  /** Number of samples analysed. */
  n: number
  /** Size K of the exact (projected) solution space. */
  support: number
  /** Distinct solutions actually hit, and coverage = distinct / support. */
  distinct: number
  coverage: number
  /** Total-variation distance from the uniform distribution, ½·Σ|pᵢ − 1/K| ∈ [0,1]. */
  tvDistance: number
  /** Pearson's χ² statistic against the uniform expectation (Σ(oᵢ−e)²/e). */
  chiSquare: number
  /** Degrees of freedom (K−1) for the χ² test. */
  chiDof: number
  /** p-value of the χ² goodness-of-fit test against the uniform null. A *large* p
   *  means the data is consistent with uniform; p → 0 means significantly skewed. */
  pValue: number
  /** Verdict at the 1% level: does the sample look uniform? (null when there is not
   *  enough data — <2 solutions, or expected count too small for the χ² approximation). */
  looksUniform: boolean | null
  /** Expected count per solution under uniformity (n / K). */
  expected: number
  /** Observed max/min counts over the *support* (unseen solutions count as 0). */
  maxCount: number
  minCount: number
  /** Draws that landed *outside* the exact support — must be 0 (soundness). Any
   *  positive value means the sampler emitted a non-solution. */
  outOfSupport: number
  /** Per-solution counts, in support order, for plotting. */
  counts: { key: string; count: number }[]
}

/**
 * Compare a batch of samples against the exact projected solution space of `cnf`.
 * `samplingVars` is the projection (independent support); it must match the set the
 * sampler drew over.
 */
export function uniformityReport(cnf: CNF, samplingVars: number[], samples: Sample[]): UniformityReport {
  const vars = [...samplingVars].sort((a, b) => a - b)
  // Exact projected support (capped generously; the studio only calls this on small
  // instances where the whole space is enumerable).
  const enumRes = projectedModels(cnf, vars, { maxModels: 100000 })
  const supportKeys = enumRes.models.map((m) => sampleKey(m, vars))
  const order = [...supportKeys].sort()
  const count = new Map<string, number>()
  for (const k of order) count.set(k, 0)

  let outOfSupport = 0
  for (const s of samples) {
    const k = sampleKey(s, vars)
    if (count.has(k)) count.set(k, count.get(k)! + 1)
    else outOfSupport++
  }

  const K = order.length
  const n = samples.length
  const expected = K > 0 ? n / K : 0
  let tv = 0
  let chi2 = 0
  let distinct = 0
  let maxCount = 0
  let minCount = n > 0 ? Infinity : 0
  const counts: { key: string; count: number }[] = []
  for (const k of order) {
    const c = count.get(k)!
    counts.push({ key: k, count: c })
    if (c > 0) distinct++
    if (c > maxCount) maxCount = c
    if (c < minCount) minCount = c
    const p = n > 0 ? c / n : 0
    tv += Math.abs(p - (K > 0 ? 1 / K : 0))
    if (expected > 0) chi2 += ((c - expected) * (c - expected)) / expected
  }
  tv *= 0.5
  if (!isFinite(minCount)) minCount = 0

  const chiDof = Math.max(0, K - 1)
  const pValue = chiSquarePValue(chi2, chiDof)
  // The χ² approximation needs a handful of expected counts and >1 category; below
  // that we decline a verdict rather than report a misleading one.
  const looksUniform = K >= 2 && expected >= 4 ? pValue >= 0.01 : null

  return {
    n,
    support: K,
    distinct,
    coverage: K > 0 ? distinct / K : 0,
    tvDistance: tv,
    chiSquare: chi2,
    chiDof,
    pValue,
    looksUniform,
    expected,
    maxCount,
    minCount,
    outOfSupport,
    counts,
  }
}

export interface MarginalComparison {
  /** For each sampling variable: its exact P(v=true) and the sampled estimate. */
  rows: { v: number; exact: number; sampled: number }[]
  /** Largest |exact − sampled| across all variables (∞-norm error). */
  maxError: number
}

/**
 * Exact per-variable marginals over the projected solution space, next to the marginals
 * estimated from `samples`. The exact side counts each distinct projected solution once
 * (the distribution UniGen targets); the sampled side is the observed frequency.
 */
export function marginalComparison(cnf: CNF, samplingVars: number[], samples: Sample[]): MarginalComparison {
  const vars = [...samplingVars].sort((a, b) => a - b)
  const enumRes = projectedModels(cnf, vars, { maxModels: 100000 })
  const total = enumRes.models.length
  const rows = vars.map((v) => {
    let exactTrue = 0
    for (const m of enumRes.models) if (m[v]) exactTrue++
    let sampTrue = 0
    for (const s of samples) if (s[v]) sampTrue++
    return {
      v,
      exact: total > 0 ? exactTrue / total : 0,
      sampled: samples.length > 0 ? sampTrue / samples.length : 0,
    }
  })
  let maxError = 0
  for (const r of rows) maxError = Math.max(maxError, Math.abs(r.exact - r.sampled))
  return { rows, maxError }
}
