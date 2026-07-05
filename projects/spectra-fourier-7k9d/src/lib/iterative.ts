// Iterative computed-tomography reconstruction — the algebraic (ART-family)
// alternative to filtered back-projection.
//
// FBP is a *direct* inverse: ramp-filter, back-project, done. It is fast and
// exact in the limit of infinitely many noiseless projections over a full 180°.
// Real scans are none of those things — few angles (dose!), noisy readings, or a
// missing wedge of angles (a truncated gantry, a metal implant). There FBP
// streaks and ripples, because it has no way to say "but attenuation can't be
// negative" or "the answer that best fits ALL the rays at once."
//
// The algebraic view treats reconstruction as a linear system: stack every ray
// as one equation ⟨a_i, x⟩ = b_i and solve A x = b in the least-squares sense,
// min ‖A x − b‖². A is the forward projector (the Radon transform as a sparse
// matrix); Aᵀ is back-projection. We never build A — we apply it matrix-free.
//
// The one non-negotiable for iterative methods to converge is that the
// back-projector is the EXACT transpose of the projector: ⟨A x, y⟩ = ⟨x, Aᵀ y⟩
// for all x, y. We guarantee it by construction — both directions walk the same
// rays with the same bilinear weights, one gathering (forward) and one
// scattering (adjoint). The engine self-test checks this to ~1e-9.
//
// Three solvers share that projector pair:
//
//   • SIRT  — Simultaneous Iterative Reconstruction Technique. Landweber
//     gradient descent preconditioned by the inverse row and column sums:
//     x ← x + λ · C Aᵀ R (b − A x). Every ray votes on every update; smooth and
//     robust, the workhorse of real cone-beam CT.
//
//   • SART  — Simultaneous ART. The same correction but applied one projection
//     (one angle) at a time, sweeping the angles each iteration. Block-iterative:
//     it uses fresh information sooner, so it resolves in far fewer sweeps.
//
//   • CGLS  — Conjugate-Gradient Least Squares. The Krylov solver for the normal
//     equations (AᵀA + μ²I) x = Aᵀ b, with optional Tikhonov damping μ. The
//     residual falls fastest of the three; a handful of iterations rival FBP and,
//     under sparse or noisy data, beat it.
//
// Non-negativity (x ≥ 0, physically attenuation is never negative) is applied as
// a projection each iteration for SIRT/SART — projected Landweber, which stays
// convergent. CGLS runs unconstrained (a clamp would break conjugacy); it is
// clamped only for display.

import type { Sinogram } from './radon'

export type IterMethod = 'sirt' | 'sart' | 'cgls'

export const ITER_METHODS: { id: IterMethod; label: string }[] = [
  { id: 'sirt', label: 'SIRT (simultaneous)' },
  { id: 'sart', label: 'SART (per-angle)' },
  { id: 'cgls', label: 'CGLS (conjugate gradient)' },
]

const SQRT2 = Math.SQRT2

/**
 * Ray/pixel geometry shared by the projector and its adjoint. Mirrors the
 * sampling in `radon.ts::forwardRadon` exactly, so a sinogram measured there is
 * a consistent right-hand side b for the system A x = b solved here.
 */
export interface CTGeometry {
  size: number
  nAngles: number
  nDet: number
  tMax: number
  sMax: number
  nSteps: number
  ds: number
  cos: Float64Array // one per angle
  sin: Float64Array
}

/** Build the geometry that matches an existing measured sinogram. */
export function geometryFromSino(sino: Sinogram, size: number): CTGeometry {
  const nSteps = Math.max(64, Math.round(size * 1.5))
  const sMax = SQRT2
  const cos = new Float64Array(sino.nAngles)
  const sin = new Float64Array(sino.nAngles)
  for (let a = 0; a < sino.nAngles; a++) {
    cos[a] = Math.cos(sino.angles[a])
    sin[a] = Math.sin(sino.angles[a])
  }
  return {
    size,
    nAngles: sino.nAngles,
    nDet: sino.nDet,
    tMax: sino.tMax,
    sMax,
    nSteps,
    ds: (2 * sMax) / (nSteps - 1),
    cos,
    sin,
  }
}

// ---------------------------------------------------------------------------
// The matched projector / back-projector pair.
//
// For one ray (angle a, detector d) the forward operator integrates the image
// along the ray by dense bilinear sampling:  p = ds · Σ_s Σ_{4 nbrs} w · x[nbr].
// The adjoint scatters the same weights back:  (Aᵀp)[nbr] += ds · w · p.
// Using identical w in both directions makes Aᵀ the exact transpose of A.
// ---------------------------------------------------------------------------

/** Forward-project a single angle into `out[0..nDet)` (overwrites). */
function projectAngle(x: ArrayLike<number>, g: CTGeometry, a: number, out: Float64Array): void {
  const { size, nDet, tMax, sMax, nSteps, ds } = g
  const cos = g.cos[a]
  const sin = g.sin[a]
  const c = (size - 1) / 2
  const scale = size / 2
  for (let d = 0; d < nDet; d++) {
    const t = ((d / (nDet - 1)) * 2 - 1) * tMax
    const bx = t * cos
    const by = t * sin
    let sum = 0
    for (let si = 0; si < nSteps; si++) {
      const s = ((si / (nSteps - 1)) * 2 - 1) * sMax
      const wx = bx - s * sin
      const wy = by + s * cos
      const px = wx * scale + c
      const py = -wy * scale + c
      if (px < 0 || px > size - 1 || py < 0 || py > size - 1) continue
      const x0 = Math.floor(px)
      const y0 = Math.floor(py)
      const x1 = Math.min(size - 1, x0 + 1)
      const y1 = Math.min(size - 1, y0 + 1)
      const fx = px - x0
      const fy = py - y0
      const w00 = (1 - fx) * (1 - fy)
      const w10 = fx * (1 - fy)
      const w01 = (1 - fx) * fy
      const w11 = fx * fy
      sum +=
        w00 * x[y0 * size + x0] +
        w10 * x[y0 * size + x1] +
        w01 * x[y1 * size + x0] +
        w11 * x[y1 * size + x1]
    }
    out[d] = sum * ds
  }
}

/** Back-project (scatter the adjoint of) a single angle's row `row[0..nDet)` into `acc` (adds). */
function backprojectAngle(row: ArrayLike<number>, g: CTGeometry, a: number, acc: Float64Array): void {
  const { size, nDet, tMax, sMax, nSteps, ds } = g
  const cos = g.cos[a]
  const sin = g.sin[a]
  const c = (size - 1) / 2
  const scale = size / 2
  for (let d = 0; d < nDet; d++) {
    const val = row[d] * ds
    if (val === 0) continue
    const t = ((d / (nDet - 1)) * 2 - 1) * tMax
    const bx = t * cos
    const by = t * sin
    for (let si = 0; si < nSteps; si++) {
      const s = ((si / (nSteps - 1)) * 2 - 1) * sMax
      const wx = bx - s * sin
      const wy = by + s * cos
      const px = wx * scale + c
      const py = -wy * scale + c
      if (px < 0 || px > size - 1 || py < 0 || py > size - 1) continue
      const x0 = Math.floor(px)
      const y0 = Math.floor(py)
      const x1 = Math.min(size - 1, x0 + 1)
      const y1 = Math.min(size - 1, y0 + 1)
      const fx = px - x0
      const fy = py - y0
      acc[y0 * size + x0] += (1 - fx) * (1 - fy) * val
      acc[y0 * size + x1] += fx * (1 - fy) * val
      acc[y1 * size + x0] += (1 - fx) * fy * val
      acc[y1 * size + x1] += fx * fy * val
    }
  }
}

/** Full forward projection A x → sinogram data (nAngles × nDet, row-major). */
export function project(x: ArrayLike<number>, g: CTGeometry): Float64Array {
  const out = new Float64Array(g.nAngles * g.nDet)
  const row = new Float64Array(g.nDet)
  for (let a = 0; a < g.nAngles; a++) {
    projectAngle(x, g, a, row)
    out.set(row, a * g.nDet)
  }
  return out
}

/** Full adjoint / back-projection Aᵀ p → image (size × size). */
export function backproject(p: ArrayLike<number>, g: CTGeometry): Float64Array {
  const acc = new Float64Array(g.size * g.size)
  const row = new Float64Array(g.nDet)
  for (let a = 0; a < g.nAngles; a++) {
    for (let d = 0; d < g.nDet; d++) row[d] = p[a * g.nDet + d]
    backprojectAngle(row, g, a, acc)
  }
  return acc
}

// ---------------------------------------------------------------------------
// Solver options and the incremental solver state.
// ---------------------------------------------------------------------------

export interface IterOptions {
  method: IterMethod
  relax: number // λ relaxation for SIRT/SART (0 < λ ≤ 2), typ. 1
  nonneg: boolean // project onto x ≥ 0 each iteration (SIRT/SART)
  lambda: number // Tikhonov damping μ for CGLS (0 = pure least squares)
}

export interface CTSolver {
  readonly x: Float64Array // current estimate (size × size)
  iter: number
  /** ‖A x − b‖ / ‖b‖ after the last step (the data-misfit the solver drives down). */
  relResidual: number
  step(): void
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

function norm(a: Float64Array): number {
  return Math.sqrt(dot(a, a))
}

/**
 * Create a stateful solver for A x = b that advances one iteration per `step()`,
 * so the UI can animate convergence. `b` is a measured sinogram's data array.
 */
export function makeSolver(b: Float64Array, g: CTGeometry, opts: IterOptions): CTSolver {
  const n = g.size * g.size
  const x = new Float64Array(n)
  const bNorm = norm(b) || 1

  const clampNonneg = () => {
    if (!opts.nonneg) return
    for (let i = 0; i < n; i++) if (x[i] < 0) x[i] = 0
  }
  const relOf = () => {
    const r = project(x, g)
    for (let i = 0; i < r.length; i++) r[i] -= b[i]
    return norm(r) / bNorm
  }

  if (opts.method === 'cgls') {
    // CGLS on (AᵀA + μ²I) x = Aᵀ b (Björck). Monotone residual, no preconditioner.
    const mu2 = opts.lambda * opts.lambda
    const r = b.slice() // r = b − A x, x = 0 (mutated in place each step)
    const s = backproject(r, g) // s = Aᵀ r − μ² x = Aᵀ b
    for (let i = 0; i < n; i++) s[i] -= mu2 * x[i]
    const p = s.slice() // search direction (mutated in place)
    let gamma = dot(s, s)
    return {
      x,
      iter: 0,
      relResidual: 1,
      step() {
        const q = project(p, g) // q = A p
        let denom = dot(q, q)
        if (mu2 > 0) denom += mu2 * dot(p, p)
        if (denom <= 1e-30 || gamma <= 1e-30) {
          this.relResidual = relOf()
          this.iter++
          return
        }
        const alpha = gamma / denom
        for (let i = 0; i < n; i++) x[i] += alpha * p[i]
        for (let i = 0; i < r.length; i++) r[i] -= alpha * q[i]
        const sNew = backproject(r, g)
        for (let i = 0; i < n; i++) sNew[i] -= mu2 * x[i]
        const gammaNew = dot(sNew, sNew)
        const beta = gammaNew / gamma
        for (let i = 0; i < n; i++) p[i] = sNew[i] + beta * p[i]
        gamma = gammaNew
        this.iter++
        this.relResidual = relOf()
      },
    }
  }

  // SIRT / SART share the preconditioners: R = 1/rowSums, C = 1/colSums.
  const ones = new Float64Array(n)
  ones.fill(1)
  const onesSino = new Float64Array(g.nAngles * g.nDet)
  onesSino.fill(1)
  const rowSums = project(ones, g) // A · 1  (per ray)
  const colSums = backproject(onesSino, g) // Aᵀ · 1 (per pixel)
  const invRow = new Float64Array(rowSums.length)
  for (let i = 0; i < invRow.length; i++) invRow[i] = rowSums[i] > 1e-9 ? 1 / rowSums[i] : 0
  const invCol = new Float64Array(colSums.length)
  for (let i = 0; i < invCol.length; i++) invCol[i] = colSums[i] > 1e-9 ? 1 / colSums[i] : 0

  if (opts.method === 'sirt') {
    return {
      x,
      iter: 0,
      relResidual: 1,
      step() {
        const r = project(x, g)
        for (let i = 0; i < r.length; i++) r[i] = (b[i] - r[i]) * invRow[i]
        const corr = backproject(r, g)
        for (let i = 0; i < n; i++) x[i] += opts.relax * corr[i] * invCol[i]
        clampNonneg()
        this.iter++
        this.relResidual = relOf()
      },
    }
  }

  // SART — per-angle (block) updates. Precompute each angle's column sums
  // (Aₐᵀ·1) so the correction is properly normalised block-by-block.
  const colSumsAngle: Float64Array[] = []
  {
    const oneRow = new Float64Array(g.nDet)
    oneRow.fill(1)
    for (let a = 0; a < g.nAngles; a++) {
      const acc = new Float64Array(n)
      backprojectAngle(oneRow, g, a, acc)
      const inv = new Float64Array(n)
      for (let i = 0; i < n; i++) inv[i] = acc[i] > 1e-9 ? 1 / acc[i] : 0
      colSumsAngle.push(inv)
    }
  }
  const rowBuf = new Float64Array(g.nDet)
  const corrBuf = new Float64Array(n)
  return {
    x,
    iter: 0,
    relResidual: 1,
    step() {
      for (let a = 0; a < g.nAngles; a++) {
        projectAngle(x, g, a, rowBuf) // A_a x
        const base = a * g.nDet
        for (let d = 0; d < g.nDet; d++) rowBuf[d] = (b[base + d] - rowBuf[d]) * invRow[base + d]
        corrBuf.fill(0)
        backprojectAngle(rowBuf, g, a, corrBuf) // A_aᵀ (…)
        const invA = colSumsAngle[a]
        for (let i = 0; i < n; i++) x[i] += opts.relax * corrBuf[i] * invA[i]
        clampNonneg()
      }
      this.iter++
      this.relResidual = relOf()
    },
  }
}

/**
 * Run a solver to a fixed iteration count and return the final estimate plus the
 * per-iteration relative-residual history. Convenience for tests and one-shot use.
 */
export function reconstructIterative(
  b: Float64Array,
  g: CTGeometry,
  opts: IterOptions,
  iterations: number,
): { x: Float64Array; history: number[] } {
  const solver = makeSolver(b, g, opts)
  const history: number[] = []
  for (let k = 0; k < iterations; k++) {
    solver.step()
    history.push(solver.relResidual)
  }
  return { x: solver.x.slice(), history }
}
