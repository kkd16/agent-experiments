import type { Constraint, EntityId } from '../model/types'
import type { ParamRef, Sketch } from '../model/sketch'
import { paramKey } from '../model/sketch'
import { pushArcResidualsG, pushResidualsG } from './residualsCore'
import { AD, konst, variable } from './ad'
import type { Dual } from './ad'

export type LinearSystem = {
  r: number[] // residual vector (m)
  J: number[] // Jacobian ∂r/∂x, row-major, m rows × n cols
  m: number // number of scalar residual equations
  n: number // number of free scalar parameters
}

// Evaluate the residual vector and its exact Jacobian at the sketch's current
// configuration, over the free parameters `refs`. Each residual is evaluated
// through the AD algebra (see ad.ts + residualsCore.ts); the value drops into `r`
// and the sparse gradient scatters into the corresponding Jacobian row.
export function residualsAndJacobian(sketch: Sketch, constraints: Constraint[], refs: ParamRef[]): LinearSystem {
  const n = refs.length
  // Map each free scalar (coordinate or auxiliary) to its column in the Jacobian.
  const col = new Map<string, number>()
  for (let i = 0; i < n; i++) col.set(paramKey(refs[i]), i)

  // A coordinate is a free variable (unit gradient in its column) unless it is
  // fixed — an anchored point, or one pinned for this solve — in which case it is
  // a constant with an empty gradient, and simply drops out of the Jacobian.
  const vars = {
    px: (id: EntityId): Dual => {
      const c = col.get(id + ':x')
      const p = sketch.point(id)
      return c === undefined ? konst(p.x) : variable(p.x, c)
    },
    py: (id: EntityId): Dual => {
      const c = col.get(id + ':y')
      const p = sketch.point(id)
      return c === undefined ? konst(p.y) : variable(p.y, c)
    },
    cr: (id: EntityId): Dual => {
      const c = col.get(id + ':r')
      const r = sketch.radiusOf(id)
      return c === undefined ? konst(r) : variable(r, c)
    },
    aux: (cid: EntityId, index: number): Dual => {
      const c = col.get(cid + ':aux' + index)
      const val = sketch.auxValue(cid, index)
      return c === undefined ? konst(val) : variable(val, c)
    },
  }

  const duals: Dual[] = []
  // Arc intrinsic residuals FIRST (in entity order), then user constraints —
  // matching residualVector's row layout exactly (residuals.ts explains why the
  // intrinsic rows lead).
  for (const e of sketch.entities) if (e.kind === 'arc') pushArcResidualsG(AD, vars, e, duals)
  for (const c of constraints) pushResidualsG(sketch, AD, vars, c, duals)

  const m = duals.length
  const r = new Array<number>(m)
  const J = new Array<number>(m * n).fill(0)
  for (let i = 0; i < m; i++) {
    r[i] = duals[i].v
    const rowOff = i * n
    for (const [j, val] of duals[i].d) J[rowOff + j] = val
  }
  return { r, J, m, n }
}

// The Jacobian at a slightly *perturbed* ("generic") configuration, evaluated
// then rolled back so the geometry the user sees is untouched. Perfectly
// symmetric configurations — a true square, a regular polygon — can have
// accidental gradient degeneracies that make an otherwise-independent constraint
// look redundant. A tiny deterministic symmetry-breaking nudge reveals the
// *generic* rank, which is the degree-of-freedom count CAD tools report. Both the
// DOF analysis and the conflict analysis need exactly this matrix.
export function genericJacobian(sketch: Sketch): LinearSystem {
  const refs = sketch.freeParams()
  const n = refs.length
  const x0 = sketch.readParams(refs)
  const x = Float64Array.from(x0)
  for (let j = 0; j < n; j++) {
    // Deterministic hash in [-1, 1) so the perturbation is stable across runs.
    const frac = Math.sin((j + 1) * 12.9898) * 43758.5453
    const noise = 2 * (frac - Math.floor(frac)) - 1
    x[j] += 0.05 * (1 + Math.abs(x[j])) * noise
  }
  sketch.writeParams(refs, x)
  const sys = residualsAndJacobian(sketch, sketch.constraints, refs)
  sketch.writeParams(refs, x0) // restore the real geometry
  return sys
}
