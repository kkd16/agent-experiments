import type { Constraint } from '../model/types'
import type { Sketch } from '../model/sketch'
import type { Vars } from './residualsCore'
import { ARC_RESIDUALS, PLAIN, pushArcResidualsG, pushResidualsG, wrapAngle } from './residualsCore'

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

// Plain-number coordinate accessors — read straight off the model.
function plainVars(sketch: Sketch): Vars<number> {
  return {
    px: (id) => sketch.point(id).x,
    py: (id) => sketch.point(id).y,
    cr: (id) => sketch.radiusOf(id),
  }
}

// Append this constraint's residuals to `out`, as plain numbers. This is the
// readable reference evaluation: it runs the one generic residual builder
// (residualsCore.ts) through the plain-number algebra. The same builder run
// through the AD algebra (jacobian.ts) produces these exact values *and* their
// derivatives — so the residual equations are the single source of truth for both.
export function pushResiduals(sketch: Sketch, c: Constraint, out: number[]): void {
  pushResidualsG(sketch, PLAIN, plainVars(sketch), c, out)
}

// Assemble the full residual vector: every arc's intrinsic endpoint-on-circle
// residuals FIRST (in entity order), then the user constraints. Two properties ride
// on this exact ordering:
//   • it matches the AD Jacobian's row order (jacobian.ts), so plain values and
//     analytic derivatives line up row for row (the solver and differential test), and
//   • putting the intrinsic rows first lets the conflict analyzer give them pivots
//     before user constraints, so a user relation that merely restates an arc's own
//     geometry is the one flagged redundant — not the arc (see conflicts.ts).
export function residualVector(sketch: Sketch, constraints: Constraint[]): number[] {
  const out: number[] = []
  const vars = plainVars(sketch)
  for (const e of sketch.entities) if (e.kind === 'arc') pushArcResidualsG(PLAIN, vars, e, out)
  for (const c of constraints) pushResiduals(sketch, c, out)
  return out
}

// Number of extra (intrinsic) residual rows the sketch's arcs contribute.
export function arcResidualCount(sketch: Sketch): number {
  let n = 0
  for (const e of sketch.entities) if (e.kind === 'arc') n += ARC_RESIDUALS
  return n
}
