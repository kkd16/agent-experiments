// A small one-dimensional root finder, the engine behind Goal Seek ("what value of
// the changing cell makes the target cell equal X?"). It pairs a secant iteration
// — fast when the function is smooth — with a bracketing + bisection fallback that
// guarantees progress when the secant stalls or the target is awkwardly shaped.
// The function it solves is supplied as a black box: in practice it sets a cell,
// recomputes the whole workbook, and reads back the target. So `solve` knows nothing
// about spreadsheets, which keeps it trivially unit-testable.

export interface GoalSeekResult {
  /** Did we reach the target within tolerance? */
  found: boolean
  /** The input value we settled on. */
  x: number
  /** The target-cell value produced by `x` (what `f(x)` returned). */
  fx: number
  iterations: number
}

export interface GoalSeekOptions {
  maxIter?: number
  tol?: number
}

/** Find `x` such that `f(x) ≈ target`, starting the search near `start`. */
export function solve(f: (x: number) => number, target: number, start: number, opts: GoalSeekOptions = {}): GoalSeekResult {
  const maxIter = opts.maxIter ?? 200
  const tol = opts.tol ?? 1e-9
  const g = (x: number): number => f(x) - target
  const within = (gx: number): boolean => Number.isFinite(gx) && Math.abs(gx) <= tol

  let x0 = Number.isFinite(start) ? start : 0
  let g0 = g(x0)
  if (within(g0)) return { found: true, x: x0, fx: g0 + target, iterations: 0 }

  // Secant phase: two seeds straddling the start.
  let x1 = x0 !== 0 ? x0 * (1 + 1e-3) + 1e-4 : 1
  let g1 = g(x1)
  let iter = 0
  for (; iter < maxIter; iter++) {
    if (within(g1)) return { found: true, x: x1, fx: g1 + target, iterations: iter }
    const denom = g1 - g0
    let x2: number
    if (denom === 0 || !Number.isFinite(denom)) {
      x2 = x1 + (x1 - x0 || 1) * 1.6 // nudge outward when the slope is flat
    } else {
      x2 = x1 - (g1 * (x1 - x0)) / denom
    }
    if (!Number.isFinite(x2)) break
    x0 = x1
    g0 = g1
    x1 = x2
    g1 = g(x1)
  }
  if (within(g1)) return { found: true, x: x1, fx: g1 + target, iterations: iter }

  // Bracketing phase: expand a window around the start until the sign of g flips,
  // then bisect. This rescues non-smooth or secant-resistant targets.
  let lo = Number.isFinite(start) ? start : 0
  let step = Math.max(1, Math.abs(lo) * 0.5)
  let glo = g(lo)
  let hi = lo
  let ghi = glo
  for (let k = 0; k < 80; k++) {
    const cand = lo + step
    const gcand = g(cand)
    if (Number.isFinite(gcand) && Number.isFinite(glo) && Math.sign(gcand) !== Math.sign(glo) && gcand !== 0) {
      hi = cand
      ghi = gcand
      break
    }
    const candDown = lo - step
    const gDown = g(candDown)
    if (Number.isFinite(gDown) && Number.isFinite(glo) && Math.sign(gDown) !== Math.sign(glo) && gDown !== 0) {
      hi = lo
      ghi = glo
      lo = candDown
      glo = gDown
      break
    }
    step *= 2
  }
  if (Number.isFinite(glo) && Number.isFinite(ghi) && Math.sign(glo) !== Math.sign(ghi)) {
    for (let k = 0; k < maxIter; k++) {
      const mid = (lo + hi) / 2
      const gmid = g(mid)
      iter++
      if (within(gmid)) return { found: true, x: mid, fx: gmid + target, iterations: iter }
      if (Math.sign(gmid) === Math.sign(glo)) {
        lo = mid
        glo = gmid
      } else {
        hi = mid
      }
    }
    const mid = (lo + hi) / 2
    return { found: Math.abs(g(mid)) <= Math.max(tol, 1e-6), x: mid, fx: f(mid), iterations: iter }
  }

  return { found: false, x: x1, fx: g1 + target, iterations: iter }
}
