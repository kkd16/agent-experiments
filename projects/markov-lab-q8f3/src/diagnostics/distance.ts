// Distributional accuracy — how close is the *whole* sampled distribution to
// the truth, not just its mean? Every target here exposes an unnormalised
// analytic log-density, so we can grid-normalise it into a real reference
// probability field, bin the live samples onto the same grid, and compare.
//
// The headline number is the total-variation distance
//   TV = ½ Σ |p̂(cell) − p(cell)|   ∈ [0, 1],
// the largest possible disagreement between the two distributions on any event.
// It's the honest score the mean-error metric can't give: a chain marooned in
// one mode of a mixture reads a large TV even while its local statistics look
// healthy. Because it only needs the density (which every target has), it works
// for *all* of them — including the multimodal and heavy-tailed ones with no
// tidy closed-form mean.

import type { Target } from '../targets/targets'

/** Resolution of the accuracy grid (RES×RES cells over the target's view). */
export const ACC_RES = 48

export interface ShapeGrids {
  res: number
  ref: Float64Array // reference probability per cell (Σ = 1)
  emp: Float64Array // empirical probability per cell (Σ = 1, or all-zero)
  tv: number // total-variation distance between them
  view: [number, number, number, number]
}

// Reference grids are pure functions of (target, res); cache them.
const refCache = new Map<string, Float64Array>()

/**
 * Normalised reference probability over the target's view: exp(logπ) at each
 * cell centre, divided by the total so it sums to 1 *within the view*. (For a
 * heavy-tailed target some mass lives outside the window; the reference is
 * therefore the truth *conditioned on the view*, which is exactly what the
 * empirical grid — also restricted to the view — should be compared against.)
 */
export function referenceGrid(target: Target, res = ACC_RES): Float64Array {
  const key = `${target.id}:${res}`
  const cached = refCache.get(key)
  if (cached) return cached

  const [xMin, xMax, yMin, yMax] = target.view
  const grid = new Float64Array(res * res)
  // Work in log-space with a max-shift so exp() never overflows or underflows.
  let lo = Infinity
  let hi = -Infinity
  const logs = new Float64Array(res * res)
  for (let j = 0; j < res; j++) {
    const y = yMin + ((j + 0.5) / res) * (yMax - yMin)
    for (let i = 0; i < res; i++) {
      const x = xMin + ((i + 0.5) / res) * (xMax - xMin)
      const lp = target.logDensity([x, y])
      logs[j * res + i] = lp
      if (Number.isFinite(lp)) {
        if (lp < lo) lo = lp
        if (lp > hi) hi = lp
      }
    }
  }
  let sum = 0
  for (let k = 0; k < grid.length; k++) {
    const w = Number.isFinite(logs[k]) ? Math.exp(logs[k] - hi) : 0
    grid[k] = w
    sum += w
  }
  const inv = sum > 0 ? 1 / sum : 0
  for (let k = 0; k < grid.length; k++) grid[k] *= inv
  refCache.set(key, grid)
  return grid
}

/**
 * Bin post-burn-in samples onto the same grid and normalise to a probability
 * field. Samples outside the view are dropped (so both fields describe the same
 * conditional-on-view distribution). Returns an all-zero grid if nothing landed
 * inside — the caller treats that as "not enough data yet".
 */
export function empiricalGrid(
  xs: number[],
  ys: number[],
  view: [number, number, number, number],
  res = ACC_RES,
): { grid: Float64Array; inView: number } {
  const [xMin, xMax, yMin, yMax] = view
  const grid = new Float64Array(res * res)
  const n = Math.min(xs.length, ys.length)
  let inView = 0
  for (let k = 0; k < n; k++) {
    const x = xs[k]
    const y = ys[k]
    if (x < xMin || x >= xMax || y < yMin || y >= yMax) continue
    const i = Math.min(res - 1, Math.floor(((x - xMin) / (xMax - xMin)) * res))
    const j = Math.min(res - 1, Math.floor(((y - yMin) / (yMax - yMin)) * res))
    grid[j * res + i] += 1
    inView++
  }
  if (inView > 0) {
    const inv = 1 / inView
    for (let k = 0; k < grid.length; k++) grid[k] *= inv
  }
  return { grid, inView }
}

/** Total-variation distance ½Σ|p − q| between two normalised grids. */
export function totalVariation(p: Float64Array, q: Float64Array): number {
  let s = 0
  for (let k = 0; k < p.length; k++) s += Math.abs(p[k] - q[k])
  return 0.5 * s
}

/**
 * Everything the shape-error card needs: the reference field, the empirical
 * field, and their TV distance — or `null` while the chain is still too small
 * to have put a meaningful number of samples inside the view.
 */
export function shapeGrids(
  target: Target,
  xs: number[],
  ys: number[],
  res = ACC_RES,
): ShapeGrids | null {
  const ref = referenceGrid(target, res)
  const { grid: emp, inView } = empiricalGrid(xs, ys, target.view, res)
  if (inView < 40) return null
  return { res, ref, emp, tv: totalVariation(ref, emp), view: target.view }
}

/** Just the TV number (or NaN if too little data). Cheap enough for stats(). */
export function tvDistance(target: Target, xs: number[], ys: number[], res = ACC_RES): number {
  const ref = referenceGrid(target, res)
  const { grid: emp, inView } = empiricalGrid(xs, ys, target.view, res)
  if (inView < 40) return NaN
  return totalVariation(ref, emp)
}
