import { EXAMPLES } from '../model/examples'
import { solve } from './solver'

export type Probe = { ok: boolean; detail: string }

// Drive the four-bar linkage through a full crank rotation and confirm it stays
// assembled (every step converges) the whole way around.
export function fourBarProbe(): Probe {
  const built = EXAMPLES.find((e) => e.id === 'four-bar')!.build()
  const s = built.sketch
  const drv = built.driver!
  const constraint = s.constraints.find((c) => c.id === drv.constraintId)!
  let worst = 0
  let failedAt = -1
  for (let deg = 0; deg <= 360; deg += 10) {
    constraint.value = deg
    const r = solve(s, { maxIterations: 80 })
    worst = Math.max(worst, r.maxResidual)
    if (!r.converged) {
      failedAt = deg
      break
    }
  }
  return {
    ok: failedAt === -1,
    detail: failedAt === -1 ? `assembled 0–360°, worst residual ${worst.toExponential(1)}` : `broke at ${failedAt}°`,
  }
}

// Drive the slider-crank and confirm the slider tracks the guide line (constant
// y within tolerance) across a full rotation.
export function sliderProbe(): Probe {
  const built = EXAMPLES.find((e) => e.id === 'slider-crank')!.build()
  const s = built.sketch
  const drv = built.driver!
  const constraint = s.constraints.find((c) => c.id === drv.constraintId)!
  // The slider is the last point entity added.
  const points = s.entities.filter((e) => e.kind === 'point')
  const slider = points[points.length - 1]
  let maxDev = 0
  const guideY = -35
  for (let deg = 0; deg <= 360; deg += 15) {
    constraint.value = deg
    const r = solve(s, { maxIterations: 80 })
    if (!r.converged) return { ok: false, detail: `failed to solve at ${deg}°` }
    maxDev = Math.max(maxDev, Math.abs((slider as { y: number }).y - guideY))
  }
  return { ok: maxDev < 1e-2, detail: `max off-guide deviation ${maxDev.toExponential(1)} units` }
}
