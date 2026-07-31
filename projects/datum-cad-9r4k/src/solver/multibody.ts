import type { EntityId } from '../model/types'
import type { ParamRef, Sketch } from '../model/sketch'
import { residualsAndJacobian } from './jacobian'
import { directionalDerivatives } from './kinematics'
import { lumpedMasses } from './dynamics'
import { solveLinear } from './linalg'

// ---------------------------------------------------------------------------
// Multi-DOF constrained rigid-body dynamics — the Lagrange-multiplier DAE.
//
// Session 6's `dynamics.ts` releases a *single*-degree-of-freedom driven mechanism
// and marches one scalar ODE (the Eksergian equation of motion). This module removes
// the single-DOF restriction entirely: it runs the FULL constrained dynamics of the
// sketch, as a system of point masses connected by any of Datum's holonomic
// constraints, with NO generalized-coordinate reduction — so a double pendulum, an
// open chain, or a free-floating body all run.
//
// The generalized coordinates are simply the free point coordinates q (mass lives at
// the points — the same lumped-rod model dynamics.ts uses). The constraints are
// c(q)=0 with Jacobian C = ∂c/∂q, which is EXACTLY the exact autodiff Jacobian the
// solver already assembles. d'Alembert's principle gives the equations of motion with
// the constraint forces expressed through multipliers λ:
//
//     M q̈ = f(q,q̇) + Cᵀ λ            (Cᵀλ is the constraint force, ⟂ the manifold)
//     c(q) = 0
//
// Differentiating the constraint twice yields the acceleration-level condition
// C q̈ = −Ċ q̇ =: γ, and (Ċ q̇)_k = q̇ᵀ ∇²c_k q̇ is PRECISELY the second directional
// derivative the hyper-dual backend (ad2.ts) already delivers in one pass — the very
// term Session 5's acceleration field is built from. Stacking the two gives one
// saddle-point (KKT) linear solve per evaluation:
//
//     ⎡ M   −Cᵀ ⎤ ⎡ q̈ ⎤   ⎡ f ⎤
//     ⎣ C    0  ⎦ ⎣ λ  ⎦ = ⎣ γ ⎦
//
// for q̈ (and, as a bonus, the joint-reaction multipliers λ). We march (q, q̇) with
// classical RK4, then — to kill the secular drift every index-1 DAE integrator suffers
// — project each full step back onto the manifold: re-solve the positions with the LM
// solver, then remove the constraint-violating velocity component in the MASS metric
//     q̇ ← q̇ − M⁻¹Cᵀ (C M⁻¹Cᵀ)⁻¹ C q̇,
// which is energy-consistent (it removes only the illegal velocity, in the metric the
// kinetic energy is measured in), so the conservation self-tests stay razor-sharp.
//
// Everything reuses the existing exact-derivative machinery — C from
// residualsAndJacobian, γ from the hyper-dual directionalDerivatives — with no new
// derivative code. Pure: the LM solver is injected (as in dynamics.ts), so there is no
// import cycle, and every claim is re-derived independently in the live self-test suite
// (projectile vs the closed-form parabola, a simple pendulum cross-checked against the
// single-DOF Eksergian EOM, double-pendulum energy conservation, and a free dumbbell
// conserving linear + angular momentum + energy).
// ---------------------------------------------------------------------------

export type MBParams = {
  gravity: number // g ≥ 0, world units/s²; pulls toward −y (screen "down")
  density: number // ρ, mass per unit length of each rod (link)
  baseMass: number // per-point base mass, so a lone joint is never massless
  damping: number // c ≥ 0, viscous per-point damping (a −c q̇ term)
}

export const DEFAULT_MB: MBParams = {
  gravity: 240,
  density: 0.012,
  baseMass: 0.6,
  damping: 0,
}

// The dynamical state over the reduced coordinate vector q (the free point coords):
// positions and their velocities, both length = number of dynamic coordinates.
export type MBState = { q: Float64Array; qd: Float64Array }

// One dynamic coordinate: which point it belongs to and whether it is the x or y axis.
type CoordMeta = { id: EntityId; axis: 'x' | 'y'; mass: number }

// A point that carries dynamics, with the column indices of its two coordinates in q
// (−1 if that coordinate is fixed / not free) — used to read off per-point velocity,
// energy and momentum.
export type MBPoint = { id: EntityId; xi: number; yi: number; mass: number }

export type MBSystem = {
  supported: boolean
  reason?: string
  clone: Sketch // the sketch with any released constraints removed
  refs: ParamRef[] // the dynamic coordinates (all free point x/y), in column order
  coords: CoordMeta[] // parallel to refs
  points: MBPoint[] // one per free point that carries at least one dynamic coordinate
  n: number // number of dynamic coordinates
  ndof: number // n − rank(C): the true number of degrees of freedom
}

// Build the dynamic system from a sketch. `released` names constraints to drop before
// running (typically the driver, so its pinned DOF is freed). The system is supported
// only when every free parameter is a point coordinate — the point-mass model does not
// cover a free circle/arc radius or a curve parameter, and we say so honestly rather
// than silently producing nonsense.
export function buildSystem(sketch: Sketch, released: EntityId[], p: MBParams): MBSystem {
  const clone = sketch.clone()
  for (const id of released) clone.removeConstraint(id)

  const refs = clone.freeParams()
  const bad = refs.find((r) => r.kind !== 'coord' || r.key === 'r')
  if (bad) {
    return {
      supported: false,
      reason: 'free-body dynamics needs point coordinates only (no free radius or curve parameter)',
      clone,
      refs: [],
      coords: [],
      points: [],
      n: 0,
      ndof: 0,
    }
  }

  const massMap = lumpedMasses(clone, { gravity: p.gravity, density: p.density, baseMass: p.baseMass, damping: p.damping, torque: 0 })
  const coords: CoordMeta[] = refs.map((r) => {
    const id = (r as { owner: { id: EntityId } }).owner.id
    const axis = (r as { key: 'x' | 'y' }).key
    return { id, axis, mass: massMap.get(id) ?? p.baseMass }
  })

  // Gather the dynamic points and their coordinate column indices.
  const byPoint = new Map<EntityId, MBPoint>()
  coords.forEach((c, i) => {
    let mp = byPoint.get(c.id)
    if (!mp) {
      mp = { id: c.id, xi: -1, yi: -1, mass: c.mass }
      byPoint.set(c.id, mp)
    }
    if (c.axis === 'x') mp.xi = i
    else mp.yi = i
  })
  const points = [...byPoint.values()]

  const n = refs.length
  const ndof = n === 0 ? 0 : n - constraintRank(clone, refs)
  return { supported: true, clone, refs, coords, points, n, ndof }
}

// Rank of the constraint Jacobian at the current configuration (the number of
// independent scalar constraints), so ndof = n − rank.
function constraintRank(sketch: Sketch, refs: ParamRef[]): number {
  const { J, m, n } = residualsAndJacobian(sketch, sketch.constraints, refs)
  // Reuse the same Gauss–Jordan rank the DOF analysis uses.
  return rankOf(J, m, n)
}

function rankOf(J: number[], m: number, n: number, tol = 1e-7): number {
  const A = J.slice()
  let rank = 0
  for (let col = 0; col < n && rank < m; col++) {
    let pivot = -1
    let best = tol
    for (let r = rank; r < m; r++) {
      const v = Math.abs(A[r * n + col])
      if (v > best) {
        best = v
        pivot = r
      }
    }
    if (pivot === -1) continue
    if (pivot !== rank) {
      for (let k = 0; k < n; k++) {
        const t = A[rank * n + k]
        A[rank * n + k] = A[pivot * n + k]
        A[pivot * n + k] = t
      }
    }
    const diag = A[rank * n + col]
    for (let r = 0; r < m; r++) {
      if (r === rank) continue
      const f = A[r * n + col] / diag
      if (f === 0) continue
      for (let k = col; k < n; k++) A[r * n + k] -= f * A[rank * n + k]
    }
    rank++
  }
  return rank
}

// The state read straight off the clone's current geometry, at rest (q̇ = 0).
export function mbStateAtRest(sys: MBSystem): MBState {
  return { q: sys.clone.readParams(sys.refs), qd: new Float64Array(sys.n) }
}

// The exact result of one KKT solve: the acceleration field q̈ (length n) and the
// Lagrange multipliers λ (the joint-reaction magnitudes, one per constraint residual).
export type MBAccel = { ok: boolean; qdd: Float64Array; lambda: Float64Array }

// Evaluate q̈ at a state: assemble C and γ through the exact-derivative stack, add the
// applied forces f (gravity + viscous damping), and solve the saddle-point system.
// Writes q onto the clone (so C and γ are read at these positions); leaves it there.
export function mbAccel(sys: MBSystem, st: MBState, p: MBParams): MBAccel {
  const { clone, refs, coords, n } = sys
  clone.writeParams(refs, st.q)

  const { J, m } = residualsAndJacobian(clone, clone.constraints, refs)
  // γ_k = −(q̇ᵀ ∇²c_k q̇), the second directional derivative along the velocity, in the
  // same residual-row order as J (both assemble arcs-first then constraints).
  const d2 = directionalDerivatives(clone, st.qd).d2

  // Applied generalized forces: gravity pulls each mass toward −y (so f on a y-coord is
  // −g·m), and viscous damping resists motion (−c·q̇ on every coordinate).
  const f = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const c = coords[i]
    let fi = -p.damping * st.qd[i]
    if (c.axis === 'y') fi += -p.gravity * c.mass
    f[i] = fi
  }

  // Assemble the KKT saddle-point matrix  [[M, −Cᵀ], [C, −εI]]  (the tiny −εI in the
  // multiplier block keeps the solve well-posed when constraints are redundant — a
  // consistent over-constrained mechanism — without perturbing q̈ measurably).
  const N = n + m
  const A = new Float64Array(N * N)
  const rhs = new Float64Array(N)
  for (let i = 0; i < n; i++) {
    A[i * N + i] = coords[i].mass
    rhs[i] = f[i]
  }
  // Scale the regularization to the mass matrix so it is dimensionally sane.
  let trM = 0
  for (let i = 0; i < n; i++) trM += coords[i].mass
  const eps = 1e-9 * (trM / Math.max(n, 1) || 1)
  for (let k = 0; k < m; k++) {
    const row = n + k
    for (let i = 0; i < n; i++) {
      const Cki = J[k * n + i]
      A[row * N + i] = Cki // C block
      A[i * N + row] = -Cki // −Cᵀ block
    }
    A[row * N + row] = -eps
    rhs[row] = -d2[k]
  }

  const sol = solveLinear(A, rhs, N)
  if (!sol) return { ok: false, qdd: new Float64Array(n), lambda: new Float64Array(m) }
  const qdd = sol.slice(0, n)
  const lambda = sol.slice(n, N)
  return { ok: true, qdd, lambda }
}

// Project a candidate position back onto the constraint manifold with the injected LM
// solver (a warm-started re-solve of the active constraint set), returning the solved q.
function projectPosition(sys: MBSystem, q: Float64Array, solveAt: (s: Sketch) => void): Float64Array {
  sys.clone.writeParams(sys.refs, q)
  solveAt(sys.clone)
  return sys.clone.readParams(sys.refs)
}

// Project a velocity onto the tangent space of the manifold in the mass metric:
// q̇ ← q̇ − M⁻¹Cᵀ (C M⁻¹Cᵀ)⁻¹ C q̇. This removes exactly the constraint-violating part
// of the velocity, measured in the metric the kinetic energy uses, so it is
// energy-consistent (it can only remove the — physically illegal — normal component).
function projectVelocity(sys: MBSystem, q: Float64Array, qd: Float64Array): Float64Array {
  const { clone, refs, coords, n } = sys
  clone.writeParams(refs, q)
  const { J, m } = residualsAndJacobian(clone, clone.constraints, refs)
  if (m === 0) return qd
  const Minv = coords.map((c) => 1 / c.mass)

  // A = C M⁻¹ Cᵀ  (m×m),  b = C q̇.
  const A = new Float64Array(m * m)
  const b = new Float64Array(m)
  for (let i = 0; i < m; i++) {
    let bi = 0
    for (let k = 0; k < n; k++) bi += J[i * n + k] * qd[k]
    b[i] = bi
    for (let j = i; j < m; j++) {
      let s = 0
      for (let k = 0; k < n; k++) s += J[i * n + k] * Minv[k] * J[j * n + k]
      A[i * m + j] = s
      A[j * m + i] = s
    }
  }
  // Small Tikhonov floor so redundant constraint rows never make A singular.
  let tr = 0
  for (let i = 0; i < m; i++) tr += A[i * m + i]
  const reg = 1e-9 * (tr / Math.max(m, 1) || 1)
  for (let i = 0; i < m; i++) A[i * m + i] += reg

  const mu = solveLinear(A, b, m)
  if (!mu) return qd
  const out = Float64Array.from(qd)
  for (let k = 0; k < n; k++) {
    let s = 0
    for (let i = 0; i < m; i++) s += J[i * n + k] * mu[i]
    out[k] -= Minv[k] * s
  }
  return out
}

// One classical RK4 step of (q̇ = qd, q̈ = mbAccel) over dt, followed by the coordinate
// projection that keeps the trajectory exactly on the manifold.
function rk4(sys: MBSystem, st: MBState, p: MBParams, dt: number, solveAt: (s: Sketch) => void): MBState {
  const n = sys.n
  const acc = (s: MBState) => mbAccel(sys, s, p).qdd
  const a1 = acc(st)
  const s2: MBState = { q: addScaled(st.q, st.qd, 0.5 * dt), qd: addScaled(st.qd, a1, 0.5 * dt) }
  const a2 = acc(s2)
  const s3: MBState = { q: addScaled(st.q, s2.qd, 0.5 * dt), qd: addScaled(st.qd, a2, 0.5 * dt) }
  const a3 = acc(s3)
  const s4: MBState = { q: addScaled(st.q, s3.qd, dt), qd: addScaled(st.qd, a3, dt) }
  const a4 = acc(s4)

  const q = new Float64Array(n)
  const qd = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    q[i] = st.q[i] + (dt / 6) * (st.qd[i] + 2 * s2.qd[i] + 2 * s3.qd[i] + s4.qd[i])
    qd[i] = st.qd[i] + (dt / 6) * (a1[i] + 2 * a2[i] + 2 * a3[i] + a4[i])
  }
  const qProj = projectPosition(sys, q, solveAt)
  const qdProj = projectVelocity(sys, qProj, qd)
  return { q: qProj, qd: qdProj }
}

function addScaled(a: Float64Array, b: Float64Array, s: number): Float64Array {
  const out = new Float64Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] + s * b[i]
  return out
}

export type MBReadout = {
  T: number // kinetic energy ½ Σ mᵢ|q̇ᵢ|²
  V: number // gravitational potential g Σ mᵢ yᵢ
  E: number // total mechanical energy T + V
  px: number // linear momentum Σ mᵢ ẋᵢ
  py: number // linear momentum Σ mᵢ ẏᵢ
  Lz: number // angular momentum about the origin Σ mᵢ (xᵢ ẏᵢ − yᵢ ẋᵢ)
}

// Kinetic + potential energy and linear/angular momentum at a state — the invariants
// the free-body run must conserve (and the numbers the read-out panel shows).
export function mbReadout(sys: MBSystem, st: MBState, p: MBParams): MBReadout {
  let T = 0
  let V = 0
  let px = 0
  let py = 0
  let Lz = 0
  for (const mp of sys.points) {
    const m = mp.mass
    const x = mp.xi >= 0 ? st.q[mp.xi] : sys.clone.point(mp.id).x
    const y = mp.yi >= 0 ? st.q[mp.yi] : sys.clone.point(mp.id).y
    const vx = mp.xi >= 0 ? st.qd[mp.xi] : 0
    const vy = mp.yi >= 0 ? st.qd[mp.yi] : 0
    T += 0.5 * m * (vx * vx + vy * vy)
    V += p.gravity * m * y
    px += m * vx
    py += m * vy
    Lz += m * (x * vy - y * vx)
  }
  return { T, V, E: T + V, px, py, Lz }
}

export type MBStep = { state: MBState; readout: MBReadout }

// Advance the dynamics by wall-clock dt, split into `substeps` RK4 steps for stability,
// each ending with a coordinate projection. Leaves the clone solved at the final q, and
// returns the new state plus a fresh energy/momentum read-out at that state.
export function mbStepAdvance(
  sys: MBSystem,
  st: MBState,
  p: MBParams,
  dt: number,
  solveAt: (s: Sketch) => void,
  substeps = 4,
): MBStep {
  let cur = st
  const h = dt / Math.max(1, substeps)
  for (let i = 0; i < substeps; i++) cur = rk4(sys, cur, p, h, solveAt)
  // Leave the clone placed at the final configuration.
  sys.clone.writeParams(sys.refs, cur.q)
  return { state: cur, readout: mbReadout(sys, cur, p) }
}

// Per-point velocity (dx/dt, dy/dt) at a state — the field the live overlay draws.
export function mbVelocities(sys: MBSystem, st: MBState): Map<EntityId, { vx: number; vy: number }> {
  const out = new Map<EntityId, { vx: number; vy: number }>()
  for (const mp of sys.points) {
    out.set(mp.id, { vx: mp.xi >= 0 ? st.qd[mp.xi] : 0, vy: mp.yi >= 0 ? st.qd[mp.yi] : 0 })
  }
  return out
}
