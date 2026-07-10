import type { Sketch } from '../model/sketch'
import type { EntityId } from '../model/types'
import { genericJacobian } from './jacobian'
import { residualCount } from './residuals'

export type ConflictReport = {
  // Constraint ids that contribute at least one linearly-dependent equation —
  // i.e. an equation already implied by the others. Removing these leaves the
  // sketch's shape unchanged; keeping an *inconsistent* one is what makes an
  // over-constrained sketch fight back.
  redundant: Set<EntityId>
  // Total number of dependent scalar equations (== DofReport.redundant).
  count: number
}

const EMPTY: ConflictReport = { redundant: new Set(), count: 0 }

// Pinpoint *which* constraints are redundant, not merely how many equations are.
//
// The constraint Jacobian's rows are the gradients of the scalar equations. A row
// that is a linear combination of earlier rows adds no new information: its
// equation is already implied. We find those rows by Gaussian elimination *by
// rows* — reduce each row against the running set of independent (pivot) rows; if
// nothing of magnitude survives, the row is dependent. Processing rows in
// constraint order makes the attribution deterministic and intuitive: the earlier
// constraints establish the shape, and a later one that restates them is flagged.
export function analyzeConflicts(sketch: Sketch): ConflictReport {
  const constraints = sketch.constraints
  if (constraints.length === 0) return EMPTY

  const { J, m, n } = genericJacobian(sketch)
  if (m === 0 || n === 0) return EMPTY

  const dependentRow = new Array<boolean>(m).fill(false)
  const pivots: { col: number; vec: Float64Array }[] = []
  const tol = 1e-7

  for (let i = 0; i < m; i++) {
    const row = new Float64Array(n)
    for (let k = 0; k < n; k++) row[k] = J[i * n + k]
    // Eliminate the components along every established pivot direction.
    for (const p of pivots) {
      const f = row[p.col]
      if (f !== 0) for (let k = 0; k < n; k++) row[k] -= f * p.vec[k]
    }
    // The largest surviving entry decides: nothing left ⇒ dependent equation.
    let best = tol
    let col = -1
    for (let k = 0; k < n; k++) {
      const v = Math.abs(row[k])
      if (v > best) {
        best = v
        col = k
      }
    }
    if (col === -1) {
      dependentRow[i] = true
    } else {
      const inv = 1 / row[col]
      for (let k = 0; k < n; k++) row[k] *= inv
      pivots.push({ col, vec: row })
    }
  }

  // Map dependent rows back to the constraints that produced them.
  const redundant = new Set<EntityId>()
  let count = 0
  let row = 0
  for (const c of constraints) {
    const rows = residualCount(c)
    for (let k = 0; k < rows; k++) {
      if (dependentRow[row + k]) {
        redundant.add(c.id)
        count++
      }
    }
    row += rows
  }
  return { redundant, count }
}
