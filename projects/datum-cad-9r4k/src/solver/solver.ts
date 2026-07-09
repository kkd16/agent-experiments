import type { EntityId } from '../model/types'
import type { ParamRef } from '../model/sketch'
import type { Sketch } from '../model/sketch'
import { residualVector } from './residuals'
import { solveLinear } from './linalg'

export type SolveOptions = {
  maxIterations?: number
  tolerance?: number // stop when the residual norm drops below this
  // Points to hold fixed for this solve in addition to entity.fixed — used by
  // dragging (pin the grabbed point at the cursor and solve everything else).
  extraFixed?: Set<EntityId>
}

export type SolveResult = {
  converged: boolean
  iterations: number
  residualNorm: number // ‖r‖₂ at the final iterate
  maxResidual: number // ‖r‖∞ — the single worst-satisfied equation
  params: number // number of free scalar parameters
  equations: number // number of scalar residual equations
}

// Levenberg–Marquardt least-squares solve of the constraint system.
//
// The solver treats the sketch as a nonlinear least-squares problem: find the
// parameter vector x (free point coordinates and circle radii) minimising
// ½‖r(x)‖² where r stacks every constraint's residual equations. LM interpolates
// between Gauss–Newton (fast near a solution) and gradient descent (robust far
// away) via a damping parameter λ that adapts to whether each step improves the
// cost. The Jacobian ∂r/∂x is estimated by forward finite differences, which
// keeps every constraint's residual as the single source of truth — there is no
// separate hand-derived derivative to fall out of sync.
export function solve(sketch: Sketch, opts: SolveOptions = {}): SolveResult {
  const maxIterations = opts.maxIterations ?? 60
  const tolerance = opts.tolerance ?? 1e-9

  const refs: ParamRef[] = sketch.freeParams(opts.extraFixed)
  const constraints = sketch.constraints
  const n = refs.length

  const evalResiduals = (): number[] => residualVector(sketch, constraints)

  // Nothing to move, or nothing to satisfy.
  const r0 = evalResiduals()
  const m = r0.length
  const norm = (v: number[]) => Math.sqrt(v.reduce((a, b) => a + b * b, 0))
  const maxAbs = (v: number[]) => v.reduce((a, b) => Math.max(a, Math.abs(b)), 0)

  if (n === 0 || m === 0) {
    return {
      converged: maxAbs(r0) <= 1e-6,
      iterations: 0,
      residualNorm: norm(r0),
      maxResidual: maxAbs(r0),
      params: n,
      equations: m,
    }
  }

  const x = sketch.readParams(refs)
  let r = r0
  let cost = dot(r, r)
  let lambda = 1e-3
  let iterations = 0

  // Forward-difference Jacobian, stored row-major (m rows × n cols).
  const jacobian = (): number[] => {
    const J = new Array<number>(m * n)
    for (let j = 0; j < n; j++) {
      const orig = x[j]
      const h = 1e-6 * (1 + Math.abs(orig))
      x[j] = orig + h
      sketch.writeParams(refs, x)
      const rp = evalResiduals()
      x[j] = orig
      const invh = 1 / h
      for (let i = 0; i < m; i++) J[i * n + j] = (rp[i] - r[i]) * invh
      // Column j reset below via writeParams before use.
    }
    sketch.writeParams(refs, x) // restore
    return J
  }

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1
    if (maxAbs(r) <= tolerance) break

    const J = jacobian()

    // Normal equations: H = JᵀJ, g = Jᵀr.
    const H = new Float64Array(n * n)
    const g = new Float64Array(n)
    for (let i = 0; i < m; i++) {
      const rowOff = i * n
      const ri = r[i]
      for (let a = 0; a < n; a++) {
        const Jia = J[rowOff + a]
        if (Jia === 0) continue
        g[a] += Jia * ri
        for (let b = a; b < n; b++) {
          const v = Jia * J[rowOff + b]
          H[a * n + b] += v
          if (b !== a) H[b * n + a] += v
        }
      }
    }

    // Inner loop: grow λ until a step actually decreases the cost.
    let stepped = false
    for (let attempt = 0; attempt < 12; attempt++) {
      const A = Float64Array.from(H)
      for (let d = 0; d < n; d++) {
        const scale = H[d * n + d]
        A[d * n + d] += lambda * (scale > 1e-12 ? scale : 1)
      }
      const negG = new Float64Array(n)
      for (let d = 0; d < n; d++) negG[d] = -g[d]

      const dx = solveLinear(A, negG, n)
      if (!dx) {
        lambda *= 10
        continue
      }

      const trial = Float64Array.from(x)
      for (let d = 0; d < n; d++) trial[d] += dx[d]
      sketch.writeParams(refs, trial)
      const rTrial = evalResiduals()
      const costTrial = dot(rTrial, rTrial)

      if (costTrial < cost) {
        for (let d = 0; d < n; d++) x[d] = trial[d]
        r = rTrial
        cost = costTrial
        lambda = Math.max(lambda / 3, 1e-12)
        stepped = true
        break
      } else {
        sketch.writeParams(refs, x) // revert
        lambda *= 10
        if (lambda > 1e12) break
      }
    }

    if (!stepped) break // λ blew up: stuck at a local min / conflicting constraints
  }

  sketch.writeParams(refs, x)
  const rFinal = evalResiduals()
  return {
    converged: maxAbs(rFinal) <= 1e-6,
    iterations,
    residualNorm: norm(rFinal),
    maxResidual: maxAbs(rFinal),
    params: n,
    equations: m,
  }
}

function dot(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
