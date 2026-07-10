import type { Sketch } from '../model/sketch'
import { residualVector } from './residuals'
import { residualsAndJacobian } from './jacobian'
import { matrixRank } from './linalg'

export type DofStatus = 'well' | 'under' | 'over' | 'empty'

export type DofReport = {
  params: number // free scalar parameters
  equations: number // scalar constraint equations
  rank: number // independent equations (Jacobian rank)
  dof: number // remaining degrees of freedom = params − rank
  redundant: number // dependent/conflicting equations = equations − rank
  status: DofStatus
}

// Analyse how constrained the sketch is by inspecting the rank of the constraint
// Jacobian at the current configuration.
//
//   dof        = params − rank   → how many free motions remain
//   redundant  = equations − rank → how many equations are dependent on others
//
// A fully-determined ("well-constrained") sketch has dof = 0 and no redundant
// equations. Extra degrees of freedom mean it can still be dragged; redundant
// equations mean constraints overlap (harmless if consistent, a conflict if not).
export function analyzeDof(sketch: Sketch): DofReport {
  const refs = sketch.freeParams()
  const n = refs.length
  const constraints = sketch.constraints

  const base = residualVector(sketch, constraints)
  const m = base.length

  if (n === 0 && m === 0) {
    return { params: 0, equations: 0, rank: 0, dof: 0, redundant: 0, status: 'empty' }
  }
  if (m === 0) {
    return { params: n, equations: 0, rank: 0, dof: n, redundant: 0, status: n === 0 ? 'well' : 'under' }
  }

  // Structural (generic) rank: evaluate the Jacobian at a slightly perturbed
  // configuration rather than at the exact solution. Perfectly symmetric
  // configurations (a true square, a regular polygon) can have accidental
  // gradient degeneracies that make an otherwise-independent constraint look
  // redundant. A tiny deterministic symmetry-breaking nudge reveals the generic
  // rank — which is the degree-of-freedom count CAD tools report. The nudge is
  // local to this analysis; it never touches the geometry the user sees.
  const x0 = sketch.readParams(refs)
  const x = Float64Array.from(x0)
  for (let j = 0; j < n; j++) {
    // Deterministic hash in [-1, 1) so the perturbation is stable across runs.
    const frac = Math.sin((j + 1) * 12.9898) * 43758.5453
    const noise = 2 * (frac - Math.floor(frac)) - 1
    x[j] += 0.05 * (1 + Math.abs(x[j])) * noise
  }
  sketch.writeParams(refs, x)
  // Exact Jacobian at the perturbed configuration, by automatic differentiation.
  const { J } = residualsAndJacobian(sketch, constraints, refs)
  sketch.writeParams(refs, x0) // restore the real geometry

  const rank = matrixRank(J, m, n)
  const dof = n - rank
  const redundant = m - rank

  let status: DofStatus
  if (redundant > 0) status = 'over'
  else if (dof > 0) status = 'under'
  else status = 'well'

  return { params: n, equations: m, rank, dof, redundant, status }
}
