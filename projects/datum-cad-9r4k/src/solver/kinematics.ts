import type { Constraint, EntityId } from '../model/types'
import type { ParamRef, Sketch } from '../model/sketch'
import { residualsAndJacobian } from './jacobian'
import { residualCount, arcResidualCount } from './residuals'
import { pushArcResidualsG, pushResidualsG } from './residualsCore'
import { AD2, h_konst, h_seed } from './ad2'
import type { HyperDual } from './ad2'
import { AD3, h3_konst, h3_seed } from './ad3'
import type { CubicDual } from './ad3'
import { solveLinear } from './linalg'

// ---------------------------------------------------------------------------
// Kinematics: from a solved sketch to the exact motion of a driven mechanism.
//
// A driver constraint pins one scalar (a crank angle, a stroke length) to a value
// θ. Holding *every* constraint fixed, the free parameters become an implicit
// function x(θ) defined by the constraint system F(x, θ) = 0. Differentiating that
// identity gives the whole mechanism's motion, exactly and analytically:
//
//   first order   J ẋ = −F_θ            ⇒ ẋ = J⁺ · e_driver      (velocity field)
//   second order  J ẍ = −(ẋᵀ ∇²F ẋ)     ⇒ ẍ = J⁺ · (−b)          (acceleration field)
//
// where J = ∂F/∂x is the exact autodiff Jacobian the solver already assembles, and
// bᵢ = ẋᵀ Hᵢ ẋ is the second directional derivative of residual i along the motion
// direction — delivered in one pass by the hyper-dual backend (ad2.ts). Because the
// driver enters each residual *linearly* (…− θ), its parametrisation contributes
// nothing to the Hessian, so b depends on x alone. We parametrise θ in the driver
// residual's own output unit (radians for an angle driver, length for a distance
// driver); then F_θ is simply −1 in the driver's row, and ẋ, ẍ are the classical
// first- and second-order kinematic coefficients (dx/dθ, d²x/dθ²).
//
// Everything reuses the existing exact-derivative machinery — no finite differences
// in the reported result — and every claim is re-derived independently in the live
// self-test suite (velocity vs a re-solve finite difference, acceleration vs a
// finite difference of the velocity field, and a closed-form slider-crank check).
// ---------------------------------------------------------------------------

export type PointMotion = {
  id: EntityId
  x: number
  y: number
  vx: number // dx/dθ  (first-order kinematic coefficient)
  vy: number
  ax: number // d²x/dθ² (second-order kinematic coefficient)
  ay: number
}

export type RadiusMotion = { id: EntityId; vr: number; ar: number }

export type Kinematics = {
  ok: boolean
  reason?: string
  points: PointMotion[]
  radii: RadiusMotion[]
  // Parametrisation unit of the coefficients: 'rad' for an angle driver (so a
  // velocity coefficient is length-per-radian), 'len' for a distance/radius driver.
  unit: 'rad' | 'len'
  // Peak |velocity coefficient| over all points — the mechanism's drive gain. It
  // diverges as the mechanism approaches a dead point (a singular Jacobian), which
  // is the honest signal we surface rather than a fabricated condition number.
  driveGain: number
  // True when the drive gain is pathologically large: the mechanism is at (or near)
  // a toggle / dead-centre position where an input rate produces unbounded response.
  nearDeadPoint: boolean
}

// A driver must pin a single scalar we can parametrise: an angle (radians) or a
// length (distance / radius / diameter). These all contribute exactly one residual.
function driverUnit(c: Constraint): 'rad' | 'len' | null {
  if (c.kind === 'angle') return 'rad'
  if (c.kind === 'distance' || c.kind === 'radius' || c.kind === 'diameter') return 'len'
  return null
}

// Least-squares solve of J y = rhs via the (tiny-regularised) normal equations
// (JᵀJ + μI) y = Jᵀ rhs — i.e. y = J⁺ rhs. For a well-constrained mechanism with a
// single driven degree of freedom J has full column rank and this is the exact
// implicit-function derivative; the Tikhonov floor only steadies the arithmetic as
// the mechanism nears a singular (dead-point) configuration.
function pseudoSolve(J: number[], rhs: number[], m: number, n: number): Float64Array | null {
  const H = new Float64Array(n * n)
  const g = new Float64Array(n)
  for (let i = 0; i < m; i++) {
    const off = i * n
    const ri = rhs[i]
    for (let a = 0; a < n; a++) {
      const Jia = J[off + a]
      if (Jia === 0) continue
      g[a] += Jia * ri
      for (let b = a; b < n; b++) {
        const val = Jia * J[off + b]
        H[a * n + b] += val
        if (b !== a) H[b * n + a] += val
      }
    }
  }
  let tr = 0
  for (let d = 0; d < n; d++) tr += H[d * n + d]
  const mu = 1e-12 * (tr / Math.max(n, 1) || 1)
  for (let d = 0; d < n; d++) H[d * n + d] += mu
  return solveLinear(H, g, n)
}

// The row index of the driver constraint's residual, matching the assembly order
// of residualVector / residualsAndJacobian: every arc's intrinsic residuals first
// (in entity order), then user constraints in order.
function driverResidualRow(sketch: Sketch, constraints: Constraint[], driverId: EntityId): number {
  let row = arcResidualCount(sketch)
  for (const c of constraints) {
    if (c.id === driverId) return row
    row += residualCount(c)
  }
  return -1
}

// The hyper-dual coordinate accessors: each free variable carries its assigned seed
// (the velocity coefficient in its column); fixed / pinned coordinates are constants
// with a zero seed. Mirrors jacobian.ts's `vars`, but seeding the *motion direction*
// instead of a unit column, so one residual pass yields the second directional
// derivative each residual contributes to the acceleration right-hand side.
function seededVars(sketch: Sketch, col: Map<string, number>, seed: Float64Array) {
  const read = (id: EntityId, key: 'x' | 'y' | 'r', value: number): HyperDual => {
    const c = col.get(id + ':' + key)
    return c === undefined ? h_konst(value) : h_seed(value, seed[c])
  }
  return {
    px: (id: EntityId) => read(id, 'x', sketch.point(id).x),
    py: (id: EntityId) => read(id, 'y', sketch.point(id).y),
    cr: (id: EntityId) => read(id, 'r', sketch.radiusOf(id)),
  }
}

// Second directional derivatives b_i = q̇ᵀ H_i q̇ of every residual along the motion
// direction `seed`, in the same row order as the Jacobian. One hyper-dual pass.
function secondDirectional(sketch: Sketch, constraints: Constraint[], col: Map<string, number>, seed: Float64Array): number[] {
  const vars = seededVars(sketch, col, seed)
  const hds: HyperDual[] = []
  for (const e of sketch.entities) if (e.kind === 'arc') pushArcResidualsG(AD2, vars, e, hds)
  for (const c of constraints) pushResidualsG(sketch, AD2, vars, c, hds)
  return hds.map((h) => h.d2)
}

// Both directional derivatives of every residual along `seed`, via a single
// hyper-dual pass: d1_i = (J·seed)_i and d2_i = seedᵀ H_i seed. Exposed for the
// self-tests, which prove d1 equals the sparse-AD Jacobian-vector product (machine
// precision) and d2 equals a central finite difference of d1 along the seed — so
// the second-order algebra is validated against two independent references.
export function directionalDerivatives(sketch: Sketch, seed: Float64Array): { refs: ParamRef[]; d1: number[]; d2: number[] } {
  const refs = sketch.freeParams()
  const col = new Map<string, number>()
  for (let i = 0; i < refs.length; i++) col.set(refs[i].owner.id + ':' + refs[i].key, i)
  const vars = seededVars(sketch, col, seed)
  const hds: HyperDual[] = []
  for (const e of sketch.entities) if (e.kind === 'arc') pushArcResidualsG(AD2, vars, e, hds)
  for (const c of sketch.constraints) pushResidualsG(sketch, AD2, vars, c, hds)
  return { refs, d1: hds.map((h) => h.d1), d2: hds.map((h) => h.d2) }
}

// Compute the exact velocity and acceleration fields of the mechanism driven by
// `driverId`, at the sketch's current (assumed solved) configuration.
export function computeKinematics(sketch: Sketch, driverId: EntityId): Kinematics {
  const empty: Kinematics = { ok: false, points: [], radii: [], unit: 'rad', driveGain: 0, nearDeadPoint: false }
  const driver = sketch.constraints.find((c) => c.id === driverId)
  if (!driver) return { ...empty, reason: 'no driver' }
  const unit = driverUnit(driver)
  if (!unit) return { ...empty, reason: 'driver is not an angle or length' }

  const constraints = sketch.constraints
  const refs = sketch.freeParams()
  const n = refs.length
  if (n === 0) return { ...empty, unit, reason: 'no free parameters' }

  const { J, m } = residualsAndJacobian(sketch, constraints, refs)
  const row = driverResidualRow(sketch, constraints, driverId)
  if (row < 0 || row >= m) return { ...empty, unit, reason: 'driver row not found' }

  // Velocity: J ẋ = −F_θ = +e_driverRow  (F_θ is −1 in the driver's row and 0 elsewhere).
  const eDriver = new Array<number>(m).fill(0)
  eDriver[row] = 1
  const vel = pseudoSolve(J, eDriver, m, n)
  if (!vel) return { ...empty, unit, reason: 'singular at this configuration' }

  // Acceleration: J ẍ = −b, with b_i = ẋᵀ H_i ẋ from one hyper-dual pass.
  const col = new Map<string, number>()
  for (let i = 0; i < n; i++) col.set(refs[i].owner.id + ':' + refs[i].key, i)
  const b = secondDirectional(sketch, constraints, col, vel)
  const negB = b.map((x) => -x)
  const acc = pseudoSolve(J, negB, m, n) ?? new Float64Array(n)

  // Scatter the flat coefficient vectors back onto points and radii.
  const pointIdx = new Map<EntityId, { vx?: number; vy?: number; ax?: number; ay?: number }>()
  const radii: RadiusMotion[] = []
  const radiusIdx = new Map<EntityId, { vr: number; ar: number }>()
  for (let i = 0; i < n; i++) {
    const ref = refs[i]
    const id = ref.owner.id
    if (ref.key === 'r') {
      radiusIdx.set(id, { vr: vel[i], ar: acc[i] })
    } else {
      const slot = pointIdx.get(id) ?? {}
      if (ref.key === 'x') {
        slot.vx = vel[i]
        slot.ax = acc[i]
      } else {
        slot.vy = vel[i]
        slot.ay = acc[i]
      }
      pointIdx.set(id, slot)
    }
  }
  for (const [id, v] of radiusIdx) radii.push({ id, vr: v.vr, ar: v.ar })

  const points: PointMotion[] = []
  let driveGain = 0
  for (const e of sketch.entities) {
    if (e.kind !== 'point') continue
    const slot = pointIdx.get(e.id)
    const vx = slot?.vx ?? 0
    const vy = slot?.vy ?? 0
    const ax = slot?.ax ?? 0
    const ay = slot?.ay ?? 0
    points.push({ id: e.id, x: e.x, y: e.y, vx, vy, ax, ay })
    driveGain = Math.max(driveGain, Math.hypot(vx, vy))
  }

  return {
    ok: true,
    points,
    radii,
    unit,
    driveGain,
    // A driven point moving faster than ~1000 length-units per unit of driver is a
    // toggle/dead-centre singularity for any sanely-scaled sketch (a rigid crank of
    // radius r gives gain r; dead points send it to ∞).
    nearDeadPoint: driveGain > 1000,
  }
}

// ---------------------------------------------------------------------------
// Jerk: the third-order kinematic coefficient x'''(θ) = d³x/dθ³, the rate of change
// of acceleration a cam/follower designer reads for smoothness (bounded jerk ⇒ no
// snap). Differentiating the constraint identity a third time (the driver enters
// linearly, so its θ-parametrisation drops out beyond first order) gives
//
//     J x''' = −( 3 · x'ᵀ Hᵢ x''  +  x'ᵀ Tᵢ x' x' )         per residual i,
//
// where Hᵢ is residual i's Hessian and Tᵢ its third-derivative tensor. The pure
// third directional derivative x'ᵀTᵢx'x' comes straight from ONE cubic-dual pass
// (ad3.ts) seeded with the velocity field x'. The mixed term x'ᵀHᵢx'' is recovered
// from three hyper-dual passes by polarisation:
//     x'ᵀHᵢx'' = ½[ (x'+x'')ᵀHᵢ(x'+x'') − x'ᵀHᵢx' − x''ᵀHᵢx'' ].
// Everything reuses the velocity/acceleration fields computeKinematics already
// solves; the result is validated against a finite difference of the acceleration
// field in the self-tests.
// ---------------------------------------------------------------------------

export type PointJerk = { id: EntityId; jx: number; jy: number }
export type Jerk = { ok: boolean; points: PointJerk[]; peak: number }

// Cubic-dual coordinate accessors seeded with a motion direction (the velocity
// field): mirrors seededVars but one AD order deeper.
function seededVars3(sketch: Sketch, col: Map<string, number>, seed: Float64Array) {
  const read = (id: EntityId, key: 'x' | 'y' | 'r', value: number): CubicDual => {
    const c = col.get(id + ':' + key)
    return c === undefined ? h3_konst(value) : h3_seed(value, seed[c])
  }
  return {
    px: (id: EntityId) => read(id, 'x', sketch.point(id).x),
    py: (id: EntityId) => read(id, 'y', sketch.point(id).y),
    cr: (id: EntityId) => read(id, 'r', sketch.radiusOf(id)),
  }
}

// Third directional derivatives Tᵢ(seed,seed,seed) of every residual, in Jacobian row
// order, from one cubic-dual pass.
function thirdDirectional(sketch: Sketch, constraints: Constraint[], col: Map<string, number>, seed: Float64Array): number[] {
  const vars = seededVars3(sketch, col, seed)
  const cds: CubicDual[] = []
  for (const e of sketch.entities) if (e.kind === 'arc') pushArcResidualsG(AD3, vars, e, cds)
  for (const c of constraints) pushResidualsG(sketch, AD3, vars, c, cds)
  return cds.map((h) => h.d3)
}

// Compute the exact jerk field x'''(θ) of the mechanism driven by `driverId` at its
// current (assumed solved) configuration. Independent of computeKinematics's scatter,
// it redoes the velocity/acceleration solve so the two functions never share mutable
// state.
export function computeJerk(sketch: Sketch, driverId: EntityId): Jerk {
  const constraints = sketch.constraints
  const refs = sketch.freeParams()
  const n = refs.length
  if (n === 0) return { ok: false, points: [], peak: 0 }
  const { J, m } = residualsAndJacobian(sketch, constraints, refs)
  const row = driverResidualRow(sketch, constraints, driverId)
  if (row < 0 || row >= m) return { ok: false, points: [], peak: 0 }

  const eDriver = new Array<number>(m).fill(0)
  eDriver[row] = 1
  const vel = pseudoSolve(J, eDriver, m, n)
  if (!vel) return { ok: false, points: [], peak: 0 }

  const col = new Map<string, number>()
  for (let i = 0; i < n; i++) col.set(refs[i].owner.id + ':' + refs[i].key, i)

  const b2vel = secondDirectional(sketch, constraints, col, vel) // x'ᵀHx'
  const acc = pseudoSolve(J, b2vel.map((x) => -x), m, n) ?? new Float64Array(n)

  // Mixed term x'ᵀHx'' by polarisation of the hyper-dual quadratic form.
  const sum = new Float64Array(n)
  for (let i = 0; i < n; i++) sum[i] = vel[i] + acc[i]
  const b2acc = secondDirectional(sketch, constraints, col, acc) // x''ᵀHx''
  const b2sum = secondDirectional(sketch, constraints, col, sum) // (x'+x'')ᵀH(x'+x'')
  const third = thirdDirectional(sketch, constraints, col, vel) // x'ᵀTx'x'

  const rhs = new Array<number>(m)
  for (let i = 0; i < m; i++) {
    const mixed = 0.5 * (b2sum[i] - b2vel[i] - b2acc[i])
    rhs[i] = -(3 * mixed + third[i])
  }
  const jerk = pseudoSolve(J, rhs, m, n) ?? new Float64Array(n)

  const jIdx = new Map<EntityId, { jx?: number; jy?: number }>()
  for (let i = 0; i < n; i++) {
    const ref = refs[i]
    if (ref.key === 'r') continue
    const slot = jIdx.get(ref.owner.id) ?? {}
    if (ref.key === 'x') slot.jx = jerk[i]
    else slot.jy = jerk[i]
    jIdx.set(ref.owner.id, slot)
  }
  const points: PointJerk[] = []
  let peak = 0
  for (const e of sketch.entities) {
    if (e.kind !== 'point') continue
    const slot = jIdx.get(e.id)
    const jx = slot?.jx ?? 0
    const jy = slot?.jy ?? 0
    points.push({ id: e.id, jx, jy })
    peak = Math.max(peak, Math.hypot(jx, jy))
  }
  return { ok: true, points, peak }
}

// ---------------------------------------------------------------------------
// Motion profile: sweep the driver across its full range and record the speed and
// acceleration magnitude of a chosen tracer point at every step — the data behind
// the v(θ) / a(θ) plot. Runs on a private clone so it never disturbs the live model.
// ---------------------------------------------------------------------------

export type MotionSample = { theta: number; speed: number; accel: number; jerk: number; vx: number; vy: number }
export type MotionProfile = {
  samples: MotionSample[]
  maxSpeed: number
  maxAccel: number
  maxJerk: number
  minSpeed: number
  unit: 'rad' | 'len'
}

// `solveAt` re-solves the clone at each driver value; injected to avoid a solver
// import cycle (kinematics → solver → …). Steps across [min, max] inclusive.
export function computeMotionProfile(
  sketch: Sketch,
  driverId: EntityId,
  tracer: EntityId,
  range: { min: number; max: number },
  toRadians: (deg: number) => number,
  solveAt: (s: Sketch) => void,
  steps = 96,
): MotionProfile {
  const clone = sketch.clone()
  const drv = clone.constraints.find((c) => c.id === driverId)
  const unit = drv ? driverUnit(drv) : null
  const samples: MotionSample[] = []
  let maxSpeed = 0
  let maxAccel = 0
  let maxJerk = 0
  let minSpeed = Infinity
  if (drv && unit && clone.get(tracer)?.kind === 'point') {
    for (let i = 0; i <= steps; i++) {
      const value = range.min + ((range.max - range.min) * i) / steps
      drv.value = value
      solveAt(clone)
      const k = computeKinematics(clone, driverId)
      const pm = k.points.find((p) => p.id === tracer)
      const vx = pm ? pm.vx : 0
      const vy = pm ? pm.vy : 0
      const speed = Math.hypot(vx, vy)
      const accel = pm ? Math.hypot(pm.ax, pm.ay) : 0
      const jk = computeJerk(clone, driverId)
      const jm = jk.points.find((p) => p.id === tracer)
      const jerk = jm ? Math.hypot(jm.jx, jm.jy) : 0
      // θ on the plot axis is the driver's own quantity (radians for an angle driver).
      const theta = unit === 'rad' ? toRadians(value) : value
      samples.push({ theta, speed, accel, jerk, vx, vy })
      if (Number.isFinite(speed)) {
        maxSpeed = Math.max(maxSpeed, speed)
        minSpeed = Math.min(minSpeed, speed)
      }
      if (Number.isFinite(accel)) maxAccel = Math.max(maxAccel, accel)
      if (Number.isFinite(jerk)) maxJerk = Math.max(maxJerk, jerk)
    }
  }
  return { samples, maxSpeed, maxAccel, maxJerk, minSpeed: Number.isFinite(minSpeed) ? minSpeed : 0, unit: unit ?? 'rad' }
}
