import type { Constraint, EntityId } from '../model/types'
import type { ParamRef, Sketch } from '../model/sketch'
import { pushResidualsG } from './residualsCore'
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
  // Map each free scalar (entity id + field) to its column in the Jacobian.
  const col = new Map<string, number>()
  for (let i = 0; i < n; i++) col.set(refs[i].owner.id + ':' + refs[i].key, i)

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
      const circ = sketch.circle(id)
      return c === undefined ? konst(circ.r) : variable(circ.r, c)
    },
  }

  const duals: Dual[] = []
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
