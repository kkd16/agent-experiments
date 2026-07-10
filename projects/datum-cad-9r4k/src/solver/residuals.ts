import type { Constraint } from '../model/types'
import type { Sketch } from '../model/sketch'
import { PLAIN, pushResidualsG, wrapAngle } from './residualsCore'

// Re-exported so existing callers keep importing angle wrapping from here.
export { wrapAngle }

// How many scalar residual equations a constraint contributes. Kept in sync with
// the residual builder in residualsCore.ts; used for degree-of-freedom accounting.
export function residualCount(c: Constraint): number {
  switch (c.kind) {
    case 'coincident':
    case 'concentric':
    case 'midpoint':
    case 'symmetric':
    case 'colinear':
      return 2
    default:
      return 1
  }
}

// Append this constraint's residuals to `out`, as plain numbers. This is the
// readable reference evaluation: it runs the one generic residual builder
// (residualsCore.ts) through the plain-number algebra. The same builder run
// through the AD algebra (jacobian.ts) produces these exact values *and* their
// derivatives — so the residual equations are the single source of truth for both.
export function pushResiduals(sketch: Sketch, c: Constraint, out: number[]): void {
  pushResidualsG(
    sketch,
    PLAIN,
    {
      px: (id) => sketch.point(id).x,
      py: (id) => sketch.point(id).y,
      cr: (id) => sketch.circle(id).r,
    },
    c,
    out,
  )
}

// Assemble the full residual vector for a list of constraints.
export function residualVector(sketch: Sketch, constraints: Constraint[]): number[] {
  const out: number[] = []
  for (const c of constraints) pushResiduals(sketch, c, out)
  return out
}
