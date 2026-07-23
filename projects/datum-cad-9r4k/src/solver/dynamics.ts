import type { EntityId } from '../model/types'
import type { Sketch } from '../model/sketch'
import { computeKinematics } from './kinematics'

// ---------------------------------------------------------------------------
// Time-domain dynamics: a driven mechanism released to run under its own physics.
//
// A well-constrained mechanism carrying a driver has exactly ONE degree of freedom:
// hold every constraint and the whole configuration is an implicit function x(θ) of
// the single generalized coordinate θ (the driver's angle or stroke). Session 5's
// kinematics already delivers, exactly, the two things a one-DOF Lagrangian needs —
// the first- and second-order kinematic coefficients
//
//     x'(θ) = dx/dθ = J⁺ e_driver          x''(θ) = d²x/dθ²
//
// From them the entire equation of motion collapses to a single scalar ODE — the
// classical *Eksergian* equation of motion for a single-DOF machine:
//
//     I(θ) θ̈ + ½ I'(θ) θ̇²  =  τ − c θ̇ − V'(θ)
//
//   I(θ)  = Σ mᵢ |xᵢ'(θ)|²          the generalized (effective) inertia
//   I'(θ) = Σ 2 mᵢ xᵢ'(θ)·xᵢ''(θ)   its θ-derivative, from the 2nd-order coefficient
//   V(θ)  = g Σ mᵢ yᵢ(θ)            gravitational potential   ⇒  V'(θ) = g Σ mᵢ yᵢ'(θ)
//   τ                              a constant applied generalized force on the DOF
//   c θ̇                            linear viscous damping
//
// Derivation. With kinetic energy T = ½ I(θ) θ̇² and Lagrangian L = T − V, the
// Euler–Lagrange equation d/dt(∂L/∂θ̇) − ∂L/∂θ = Q_nc gives
//     I θ̈ + I' θ̇² − (½ I' θ̇² − V') = Q_nc   ⇒   I θ̈ + ½ I' θ̇² + V' = Q_nc,
// with Q_nc = τ − c θ̇. Hence θ̈ = (τ − c θ̇ − V' − ½ I' θ̇²) / I. When τ = c = 0 the
// system is conservative and E = T + V is exactly constant — the sharpest possible
// self-test, since the lumped-mass model below is itself a bona-fide Lagrangian
// system (not an approximation *of* the EOM, an exact instance of one).
//
// Mass is lumped honestly: each link (line) is a uniform rod of linear density ρ,
// its mass ρ·L split evenly to its two endpoints, plus a per-point base mass so an
// isolated joint is never massless. Every RHS evaluation is one constraint re-solve
// (to place x(θ)) followed by one kinematics pass — machinery Datum already owns.
// Everything here is pure: the solver is injected as `solveAt`, so this module has
// no import cycle and is exercised end-to-end by the live self-test suite.
// ---------------------------------------------------------------------------

export type DynParams = {
  gravity: number // g ≥ 0, world units/s²; pulls toward −y (screen "down")
  density: number // ρ, mass per unit length of each rod (link)
  baseMass: number // per-point base mass, so a lone joint is not massless
  damping: number // c ≥ 0, viscous generalized damping (a −c θ̇ term)
  torque: number // τ, constant applied generalized force on the driver DOF
}

export const DEFAULT_DYN: DynParams = {
  gravity: 240,
  density: 0.012,
  baseMass: 0.4,
  damping: 0.06,
  torque: 0,
}

// The dynamical state: θ is the generalized coordinate in the driver residual's own
// unit — RADIANS for an angle driver, length for a distance/radius driver — and
// θ̇ = ω its rate. (The kinematic coefficients from computeKinematics are per that
// same unit, so θ and the coefficients compose without any unit conversion.)
export type DynState = { theta: number; omega: number }

export type DynEval = {
  ok: boolean
  thetaddot: number // θ̈ from the Eksergian EOM
  I: number // generalized inertia I(θ)
  dIdtheta: number // I'(θ)
  dVdtheta: number // V'(θ)
  T: number // kinetic energy ½ I θ̇²
  V: number // gravitational potential g Σ mᵢ yᵢ
  E: number // total mechanical energy T + V
  power: number // non-conservative power (τ − c θ̇) θ̇ = dE/dt
}

const ZERO_EVAL: DynEval = { ok: false, thetaddot: 0, I: 0, dIdtheta: 0, dVdtheta: 0, T: 0, V: 0, E: 0, power: 0 }

// Lumped point masses: every point starts at `baseMass`; each line, treated as a
// uniform rod of density ρ, contributes ρ·L/2 to each of its two endpoints. Returns
// a map keyed by point id (points not in the map are treated as massless).
export function lumpedMasses(sketch: Sketch, p: DynParams): Map<EntityId, number> {
  const mass = new Map<EntityId, number>()
  for (const e of sketch.entities) if (e.kind === 'point') mass.set(e.id, p.baseMass)
  for (const e of sketch.entities) {
    if (e.kind !== 'line') continue
    const a = sketch.point(e.p1)
    const b = sketch.point(e.p2)
    const half = 0.5 * p.density * Math.hypot(b.x - a.x, b.y - a.y)
    mass.set(e.p1, (mass.get(e.p1) ?? 0) + half)
    mass.set(e.p2, (mass.get(e.p2) ?? 0) + half)
  }
  return mass
}

// The driver's parametrisation unit, mirroring kinematics.ts. Only these kinds pin a
// single scalar we can integrate as the generalized coordinate.
export function driverParamUnit(sketch: Sketch, driverId: EntityId): 'rad' | 'len' | null {
  const c = sketch.constraints.find((k) => k.id === driverId)
  if (!c) return null
  if (c.kind === 'angle') return 'rad'
  if (c.kind === 'distance' || c.kind === 'radius' || c.kind === 'diameter') return 'len'
  return null
}

// Write the generalized coordinate θ onto the driver constraint and re-solve, so the
// sketch is placed at the configuration x(θ). Angle drivers store DEGREES (the residual
// multiplies by π/180 internally), so θ [rad] maps to value = θ·180/π; length drivers
// store the value directly.
function placeAt(sketch: Sketch, driverId: EntityId, theta: number, unit: 'rad' | 'len', solveAt: (s: Sketch) => void): boolean {
  const drv = sketch.constraints.find((k) => k.id === driverId)
  if (!drv) return false
  drv.value = unit === 'rad' ? (theta * 180) / Math.PI : theta
  solveAt(sketch)
  return true
}

// Evaluate the Eksergian EOM at a dynamical state: place x(θ), take one kinematics
// pass, assemble I, I', V' and the energies, and return θ̈. Mutates `work` (leaves it
// solved at θ); intended to be called on a private clone.
export function evalDynamics(
  work: Sketch,
  driverId: EntityId,
  mass: Map<EntityId, number>,
  st: DynState,
  p: DynParams,
  unit: 'rad' | 'len',
  solveAt: (s: Sketch) => void,
): DynEval {
  if (!placeAt(work, driverId, st.theta, unit, solveAt)) return ZERO_EVAL
  const k = computeKinematics(work, driverId)
  if (!k.ok) return ZERO_EVAL

  let I = 0
  let dI = 0
  let dV = 0
  let V = 0
  for (const pm of k.points) {
    const m = mass.get(pm.id) ?? 0
    if (m === 0) continue
    I += m * (pm.vx * pm.vx + pm.vy * pm.vy)
    dI += 2 * m * (pm.vx * pm.ax + pm.vy * pm.ay)
    dV += p.gravity * m * pm.vy
    V += p.gravity * m * pm.y
  }
  // A tiny inertia floor keeps θ̈ finite at a momentary configuration where every mass
  // is instantaneously stationary in θ (a physical singularity of the parametrisation).
  const Ieff = Math.max(I, 1e-9)
  const w = st.omega
  const thetaddot = (p.torque - p.damping * w - dV - 0.5 * dI * w * w) / Ieff
  const T = 0.5 * I * w * w
  const power = (p.torque - p.damping * w) * w
  return { ok: true, thetaddot, I, dIdtheta: dI, dVdtheta: dV, T, V, E: T + V, power }
}

// One classical fourth-order Runge–Kutta step of the coupled system (θ' = ω,
// ω' = θ̈(θ, ω)) over dt. Each of the four stages evaluates the EOM at a nearby state
// (a warm-started re-solve), so the mechanism advances along its constraint manifold.
function rk4(
  work: Sketch,
  driverId: EntityId,
  mass: Map<EntityId, number>,
  st: DynState,
  p: DynParams,
  unit: 'rad' | 'len',
  dt: number,
  solveAt: (s: Sketch) => void,
): DynState {
  const acc = (s: DynState) => evalDynamics(work, driverId, mass, s, p, unit, solveAt).thetaddot
  const a1 = acc(st)
  const s2 = { theta: st.theta + 0.5 * dt * st.omega, omega: st.omega + 0.5 * dt * a1 }
  const a2 = acc(s2)
  const s3 = { theta: st.theta + 0.5 * dt * s2.omega, omega: st.omega + 0.5 * dt * a2 }
  const a3 = acc(s3)
  const s4 = { theta: st.theta + dt * s3.omega, omega: st.omega + dt * a3 }
  const a4 = acc(s4)
  return {
    theta: st.theta + (dt / 6) * (st.omega + 2 * s2.omega + 2 * s3.omega + s4.omega),
    omega: st.omega + (dt / 6) * (a1 + 2 * a2 + 2 * a3 + a4),
  }
}

export type StepResult = { state: DynState; ev: DynEval }

// Advance the dynamics by wall-clock `dt`, split into `substeps` RK4 steps for
// stability (four stiff re-solves per substep). Returns the new state and a fresh
// energy read-out evaluated *at* that new state (so the reported energies are exact
// for what the live sketch now shows). Leaves `work` solved at the final θ.
export function stepDynamics(
  work: Sketch,
  driverId: EntityId,
  mass: Map<EntityId, number>,
  st: DynState,
  p: DynParams,
  unit: 'rad' | 'len',
  dt: number,
  solveAt: (s: Sketch) => void,
  substeps = 4,
): StepResult {
  let cur = st
  const h = dt / Math.max(1, substeps)
  for (let i = 0; i < substeps; i++) cur = rk4(work, driverId, mass, cur, p, unit, h, solveAt)
  const ev = evalDynamics(work, driverId, mass, cur, p, unit, solveAt)
  return { state: cur, ev }
}
