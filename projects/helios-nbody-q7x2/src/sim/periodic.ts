// Periodic orbits and choreographies of the planar N-body problem.
//
// Almost every trajectory in the gravitational N-body problem is chaotic — the
// Three-Body Atlas (`threebody.ts`) is a whole fractal built from that fact. Yet
// woven through the chaos is a measure-zero skeleton of exact **periodic orbits**:
// initial conditions that return to themselves after a finite time T, tracing a
// closed curve forever. The most famous is the **figure-eight choreography**
// (Moore 1993; Chenciner & Montgomery 2000), where three equal masses chase one
// another around a single ∞-shaped track. This module finds these orbits from
// first principles and measures their stability.
//
// Three pieces of machinery, all from scratch, no libraries:
//
//   1. A high-accuracy integrator that carries the **monodromy matrix** (the
//      state-transition matrix over one period) alongside the trajectory. The
//      monodromy needs the gradient of the force — the same tidal tensor the
//      chaos lab already derives — so we evolve the real state and 4N tangent
//      vectors together under one RK4 map. The monodromy IS the linearisation of
//      the "advance by T" map; its columns are how each initial coordinate
//      propagates to the end.
//
//   2. A **differential corrector** — Newton's method (damped, Levenberg–
//      Marquardt) on the shooting residual φ_T(z₀) − z₀, using the monodromy as
//      the Jacobian. Seeded from a literature initial guess it polishes an orbit
//      until it closes to machine precision (‖residual‖ ~ 1e-12).
//
//   3. A from-scratch **eigenvalue solver** (Householder → upper Hessenberg, then
//      the Francis double-shift QR to real Schur form) that reads the **Floquet
//      multipliers** — the eigenvalues of the monodromy — off the converged
//      quasi-triangular matrix. Their moduli decide linear stability: all on the
//      unit circle ⇒ the orbit is (linearly) stable; any outside ⇒ it is
//      hyperbolically unstable, and the largest modulus is the per-period blow-up
//      factor. A Hamiltonian monodromy is symplectic, so det = 1 exactly and the
//      multipliers come in reciprocal pairs {λ, 1/λ} — both are checked.
//
// Everything runs in the plane with G and the masses configurable; softening is
// available but defaults to zero, because a genuine periodic orbit is a solution
// of the *exact* Newtonian equations.

// ---------------------------------------------------------------------------
// Phase-space layout
// ---------------------------------------------------------------------------
// A configuration of N bodies is a flat phase vector ψ ∈ ℝ^{4N} in the order
//   ψ = [ x₀…x_{N-1}, y₀…y_{N-1}, vx₀…vx_{N-1}, vy₀…vy_{N-1} ].
// The monodromy M is stored row-major (M[r*D + c]) with the same coordinate
// order on both axes.

export interface OrbitState {
  n: number
  /** Masses, length n. */
  mass: Float64Array
  /** Flat phase vector ψ, length 4n. */
  psi: Float64Array
  /** Period. */
  period: number
  /** Gravitational constant used. */
  g: number
}

export interface PeriodicConfig {
  g: number
  /** Plummer softening length ε (default 0 — exact Newtonian). */
  softening: number
}

export const DEFAULT_CONFIG: PeriodicConfig = { g: 1, softening: 0 }

/** Build an empty flat phase vector. */
export function makePsi(n: number): Float64Array {
  return new Float64Array(4 * n)
}

/** Read body i's (x, y, vx, vy) out of a flat phase vector. */
export function bodyOf(psi: Float64Array, n: number, i: number): [number, number, number, number] {
  return [psi[i], psi[n + i], psi[2 * n + i], psi[3 * n + i]]
}

/** Write body i's (x, y, vx, vy) into a flat phase vector. */
export function setBody(psi: Float64Array, n: number, i: number, x: number, y: number, vx: number, vy: number): void {
  psi[i] = x
  psi[n + i] = y
  psi[2 * n + i] = vx
  psi[3 * n + i] = vy
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface Conserved {
  energy: number
  px: number
  py: number
  angular: number
  comX: number
  comY: number
  comVX: number
  comVY: number
}

/** Conserved quantities for a state with explicit masses. */
export function conservedWith(psi: Float64Array, n: number, mass: Float64Array, cfg: PeriodicConfig): Conserved {
  const g = cfg.g
  const eps2 = cfg.softening * cfg.softening
  let ke = 0
  let px = 0
  let py = 0
  let angular = 0
  let mtot = 0
  let cx = 0
  let cy = 0
  let cvx = 0
  let cvy = 0
  for (let i = 0; i < n; i++) {
    const x = psi[i]
    const y = psi[n + i]
    const vx = psi[2 * n + i]
    const vy = psi[3 * n + i]
    const m = mass[i]
    ke += 0.5 * m * (vx * vx + vy * vy)
    px += m * vx
    py += m * vy
    angular += m * (x * vy - y * vx)
    mtot += m
    cx += m * x
    cy += m * y
    cvx += m * vx
    cvy += m * vy
  }
  let pe = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = psi[j] - psi[i]
      const dy = psi[n + j] - psi[n + i]
      const r = Math.sqrt(dx * dx + dy * dy + eps2)
      pe -= (g * mass[i] * mass[j]) / r
    }
  }
  return {
    energy: ke + pe,
    px,
    py,
    angular,
    comX: cx / mtot,
    comY: cy / mtot,
    comVX: cvx / mtot,
    comVY: cvy / mtot,
  }
}

/** Shift a state into its centre-of-mass rest frame (COM at origin, zero net momentum). */
export function centreOfMassFrame(psi: Float64Array, n: number, mass: Float64Array): void {
  let mtot = 0
  let cx = 0
  let cy = 0
  let cvx = 0
  let cvy = 0
  for (let i = 0; i < n; i++) {
    const m = mass[i]
    mtot += m
    cx += m * psi[i]
    cy += m * psi[n + i]
    cvx += m * psi[2 * n + i]
    cvy += m * psi[3 * n + i]
  }
  cx /= mtot
  cy /= mtot
  cvx /= mtot
  cvy /= mtot
  for (let i = 0; i < n; i++) {
    psi[i] -= cx
    psi[n + i] -= cy
    psi[2 * n + i] -= cvx
    psi[3 * n + i] -= cvy
  }
}

// ---------------------------------------------------------------------------
// The vector field and its variational (tangent) companion
// ---------------------------------------------------------------------------
//
// The acceleration of body i under softened Newtonian gravity is
//   aᵢ = G Σⱼ≠ᵢ mⱼ (rⱼ − rᵢ) / s³ ,  s = √(|rⱼ − rᵢ|² + ε²).
// Its exact derivative gives the variational acceleration of a deviation δr,
//   δaᵢ = G Σⱼ mⱼ [ δdᵢⱼ / s³ − 3 (dᵢⱼ·δdᵢⱼ) dᵢⱼ / s⁵ ] ,  δdᵢⱼ = δrⱼ − δrᵢ,
// exactly as the chaos lab derives it. Here we apply that same tidal operator to
// *many* deviation vectors at once (the columns of the monodromy), reusing each
// pair's geometry.

/**
 * Real acceleration at positions (X,Y) plus the tidal action on `k` tangent
 * columns whose position parts are packed in TQX/TQY (column c, body i at
 * index c*n + i). Outputs the real acceleration in AX/AY and each column's
 * tangent acceleration in TAX/TAY. One symmetric O(n²·k) pass.
 */
function accelWithTangents(
  n: number,
  X: Float64Array,
  Y: Float64Array,
  mass: Float64Array,
  g: number,
  eps2: number,
  k: number,
  TQX: Float64Array,
  TQY: Float64Array,
  AX: Float64Array,
  AY: Float64Array,
  TAX: Float64Array,
  TAY: Float64Array,
): void {
  for (let i = 0; i < n; i++) {
    AX[i] = 0
    AY[i] = 0
  }
  const kn = k * n
  for (let c = 0; c < kn; c++) {
    TAX[c] = 0
    TAY[c] = 0
  }
  for (let i = 0; i < n; i++) {
    const xi = X[i]
    const yi = Y[i]
    const mi = mass[i]
    for (let j = i + 1; j < n; j++) {
      const dx = X[j] - xi
      const dy = Y[j] - yi
      const r2 = dx * dx + dy * dy + eps2
      const inv = 1 / Math.sqrt(r2)
      const inv3 = inv * inv * inv
      const inv5 = inv3 * inv * inv
      const mj = mass[j]

      // Real acceleration (Newton's third law keeps the pass symmetric).
      const fx = g * dx * inv3
      const fy = g * dy * inv3
      AX[i] += mj * fx
      AY[i] += mj * fy
      AX[j] -= mi * fx
      AY[j] -= mi * fy

      // Tidal action on every tangent column.
      const g3 = g * inv3
      const g5 = 3 * g * inv5
      for (let c = 0; c < k; c++) {
        const bi = c * n + i
        const bj = c * n + j
        const ddx = TQX[bj] - TQX[bi]
        const ddy = TQY[bj] - TQY[bi]
        const dot = dx * ddx + dy * ddy
        const tx = g3 * ddx - g5 * dot * dx
        const ty = g3 * ddy - g5 * dot * dy
        TAX[bi] += mj * tx
        TAY[bi] += mj * ty
        TAX[bj] -= mi * tx
        TAY[bj] -= mi * ty
      }
    }
  }
}

/** Plain acceleration only (no tangents) — used for the drawing-only integrator. */
function accelOnly(
  n: number,
  X: Float64Array,
  Y: Float64Array,
  mass: Float64Array,
  g: number,
  eps2: number,
  AX: Float64Array,
  AY: Float64Array,
): void {
  for (let i = 0; i < n; i++) {
    AX[i] = 0
    AY[i] = 0
  }
  for (let i = 0; i < n; i++) {
    const xi = X[i]
    const yi = Y[i]
    const mi = mass[i]
    for (let j = i + 1; j < n; j++) {
      const dx = X[j] - xi
      const dy = Y[j] - yi
      const r2 = dx * dx + dy * dy + eps2
      const inv = 1 / Math.sqrt(r2)
      const inv3 = inv * inv * inv
      const mj = mass[j]
      const fx = g * dx * inv3
      const fy = g * dy * inv3
      AX[i] += mj * fx
      AY[i] += mj * fy
      AX[j] -= mi * fx
      AY[j] -= mi * fy
    }
  }
}

// ---------------------------------------------------------------------------
// Augmented RK4: state + monodromy
// ---------------------------------------------------------------------------
//
// We integrate the real trajectory and the k = 4N monodromy columns with a
// classical fourth-order Runge–Kutta. RK4 needs the tidal tensor re-evaluated at
// each stage's *real* position, which is exactly what `accelWithTangents` gives.
// The tangent block only couples δq ↔ δv (velocities never enter the force), so
// each column's dynamics is d(δq)/dt = δv, d(δv)/dt = A(q)·δq.

export interface MonodromyResult {
  /** Final flat phase vector ψ(T). */
  psiT: Float64Array
  /** The D×D monodromy matrix (row-major), D = 4n. */
  monodromy: Float64Array
  /** Max |E(t) − E(0)| / |E(0)| over the integration — an accuracy witness. */
  energyDrift: number
  /** Steps taken. */
  steps: number
}

/**
 * Integrate for time T, carrying the full monodromy. Returns ψ(T) and M(T).
 */
export function integrateMonodromy(
  psi0: Float64Array,
  n: number,
  mass: Float64Array,
  T: number,
  steps: number,
  cfg: PeriodicConfig,
): MonodromyResult {
  const g = cfg.g
  const eps2 = cfg.softening * cfg.softening
  const D = 4 * n
  const k = D // one tangent column per phase coordinate
  const dt = T / steps

  // Real state.
  const X = new Float64Array(n)
  const Y = new Float64Array(n)
  const VX = new Float64Array(n)
  const VY = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    X[i] = psi0[i]
    Y[i] = psi0[n + i]
    VX[i] = psi0[2 * n + i]
    VY[i] = psi0[3 * n + i]
  }

  // Tangent columns (identity initial condition): column c holds the deviation
  // whose only non-zero coordinate is c. Layout index = c*n + body.
  const kn = k * n
  const TQX = new Float64Array(kn)
  const TQY = new Float64Array(kn)
  const TVX = new Float64Array(kn)
  const TVY = new Float64Array(kn)
  for (let c = 0; c < D; c++) {
    for (let i = 0; i < n; i++) {
      const b = c * n + i
      TQX[b] = c === i ? 1 : 0
      TQY[b] = c === n + i ? 1 : 0
      TVX[b] = c === 2 * n + i ? 1 : 0
      TVY[b] = c === 3 * n + i ? 1 : 0
    }
  }

  // RK4 scratch: a derivative evaluator writes into (dX..dVY, dTQX..dTVY).
  const AX = new Float64Array(n)
  const AY = new Float64Array(n)
  const TAX = new Float64Array(kn)
  const TAY = new Float64Array(kn)

  // Stage accumulators. We use the "sum of k's" RK4 form on a temporary state.
  const sX = new Float64Array(n)
  const sY = new Float64Array(n)
  const sVX = new Float64Array(n)
  const sVY = new Float64Array(n)
  const sTQX = new Float64Array(kn)
  const sTQY = new Float64Array(kn)
  const sTVX = new Float64Array(kn)
  const sTVY = new Float64Array(kn)

  // Running accumulation of the increment (weighted sum of stage derivatives).
  const accX = new Float64Array(n)
  const accY = new Float64Array(n)
  const accVX = new Float64Array(n)
  const accVY = new Float64Array(n)
  const accTQX = new Float64Array(kn)
  const accTQY = new Float64Array(kn)
  const accTVX = new Float64Array(kn)
  const accTVY = new Float64Array(kn)

  const initial = conservedWith(psi0, n, mass, cfg)
  let maxDrift = 0
  const e0 = Math.abs(initial.energy) > 1e-300 ? Math.abs(initial.energy) : 1

  // Classical RK4 with the four stages inlined. The stage state (sX…) is always
  // formed from the *base* (start-of-step) state X…, so overwriting sVX in place
  // is safe: each stage reads the previous stage's stored velocity/accel.
  for (let step = 0; step < steps; step++) {
    // --- Stage 1 (at base) ---
    accelWithTangents(n, X, Y, mass, g, eps2, k, TQX, TQY, AX, AY, TAX, TAY)
    for (let i = 0; i < n; i++) {
      accX[i] = VX[i]; accY[i] = VY[i]; accVX[i] = AX[i]; accVY[i] = AY[i]
      sX[i] = X[i] + 0.5 * dt * VX[i]
      sY[i] = Y[i] + 0.5 * dt * VY[i]
      sVX[i] = VX[i] + 0.5 * dt * AX[i]
      sVY[i] = VY[i] + 0.5 * dt * AY[i]
    }
    for (let c = 0; c < kn; c++) {
      accTQX[c] = TVX[c]; accTQY[c] = TVY[c]; accTVX[c] = TAX[c]; accTVY[c] = TAY[c]
      sTQX[c] = TQX[c] + 0.5 * dt * TVX[c]
      sTQY[c] = TQY[c] + 0.5 * dt * TVY[c]
      sTVX[c] = TVX[c] + 0.5 * dt * TAX[c]
      sTVY[c] = TVY[c] + 0.5 * dt * TAY[c]
    }

    // --- Stage 2 (at base + dt/2·k1) ---
    accelWithTangents(n, sX, sY, mass, g, eps2, k, sTQX, sTQY, AX, AY, TAX, TAY)
    for (let i = 0; i < n; i++) {
      accX[i] += 2 * sVX[i]; accY[i] += 2 * sVY[i]; accVX[i] += 2 * AX[i]; accVY[i] += 2 * AY[i]
    }
    for (let c = 0; c < kn; c++) {
      accTQX[c] += 2 * sTVX[c]; accTQY[c] += 2 * sTVY[c]; accTVX[c] += 2 * TAX[c]; accTVY[c] += 2 * TAY[c]
    }
    // Build stage-3 state from base + dt/2·k2.
    for (let i = 0; i < n; i++) {
      const kvx = AX[i], kvy = AY[i], kx = sVX[i], ky = sVY[i]
      sX[i] = X[i] + 0.5 * dt * kx
      sY[i] = Y[i] + 0.5 * dt * ky
      sVX[i] = VX[i] + 0.5 * dt * kvx
      sVY[i] = VY[i] + 0.5 * dt * kvy
    }
    for (let c = 0; c < kn; c++) {
      const kvx = TAX[c], kvy = TAY[c], kx = sTVX[c], ky = sTVY[c]
      sTQX[c] = TQX[c] + 0.5 * dt * kx
      sTQY[c] = TQY[c] + 0.5 * dt * ky
      sTVX[c] = TVX[c] + 0.5 * dt * kvx
      sTVY[c] = TVY[c] + 0.5 * dt * kvy
    }

    // --- Stage 3 (at base + dt/2·k3) ---
    accelWithTangents(n, sX, sY, mass, g, eps2, k, sTQX, sTQY, AX, AY, TAX, TAY)
    for (let i = 0; i < n; i++) {
      accX[i] += 2 * sVX[i]; accY[i] += 2 * sVY[i]; accVX[i] += 2 * AX[i]; accVY[i] += 2 * AY[i]
    }
    for (let c = 0; c < kn; c++) {
      accTQX[c] += 2 * sTVX[c]; accTQY[c] += 2 * sTVY[c]; accTVX[c] += 2 * TAX[c]; accTVY[c] += 2 * TAY[c]
    }
    // Build stage-4 state from base + dt·k3.
    for (let i = 0; i < n; i++) {
      const kvx = AX[i], kvy = AY[i], kx = sVX[i], ky = sVY[i]
      sX[i] = X[i] + dt * kx
      sY[i] = Y[i] + dt * ky
      sVX[i] = VX[i] + dt * kvx
      sVY[i] = VY[i] + dt * kvy
    }
    for (let c = 0; c < kn; c++) {
      const kvx = TAX[c], kvy = TAY[c], kx = sTVX[c], ky = sTVY[c]
      sTQX[c] = TQX[c] + dt * kx
      sTQY[c] = TQY[c] + dt * ky
      sTVX[c] = TVX[c] + dt * kvx
      sTVY[c] = TVY[c] + dt * kvy
    }

    // --- Stage 4 (at base + dt·k3) ---
    accelWithTangents(n, sX, sY, mass, g, eps2, k, sTQX, sTQY, AX, AY, TAX, TAY)
    for (let i = 0; i < n; i++) {
      accX[i] += sVX[i]; accY[i] += sVY[i]; accVX[i] += AX[i]; accVY[i] += AY[i]
    }
    for (let c = 0; c < kn; c++) {
      accTQX[c] += sTVX[c]; accTQY[c] += sTVY[c]; accTVX[c] += TAX[c]; accTVY[c] += TAY[c]
    }

    // Commit: y ← y + dt/6·(k1 + 2k2 + 2k3 + k4).
    const h6 = dt / 6
    for (let i = 0; i < n; i++) {
      X[i] += h6 * accX[i]
      Y[i] += h6 * accY[i]
      VX[i] += h6 * accVX[i]
      VY[i] += h6 * accVY[i]
    }
    for (let c = 0; c < kn; c++) {
      TQX[c] += h6 * accTQX[c]
      TQY[c] += h6 * accTQY[c]
      TVX[c] += h6 * accTVX[c]
      TVY[c] += h6 * accTVY[c]
    }

    // Energy drift witness (cheap: only every few steps).
    if ((step & 31) === 0 || step === steps - 1) {
      const cur = energyOf(X, Y, VX, VY, n, mass, g, eps2)
      const drift = Math.abs(cur - initial.energy) / e0
      if (drift > maxDrift) maxDrift = drift
    }
  }

  const psiT = new Float64Array(D)
  for (let i = 0; i < n; i++) {
    psiT[i] = X[i]
    psiT[n + i] = Y[i]
    psiT[2 * n + i] = VX[i]
    psiT[3 * n + i] = VY[i]
  }

  // Assemble M (row-major). Column c's final tangent gives column c of M.
  const M = new Float64Array(D * D)
  for (let c = 0; c < D; c++) {
    for (let i = 0; i < n; i++) {
      const b = c * n + i
      M[(i) * D + c] = TQX[b]
      M[(n + i) * D + c] = TQY[b]
      M[(2 * n + i) * D + c] = TVX[b]
      M[(3 * n + i) * D + c] = TVY[b]
    }
  }

  return { psiT, monodromy: M, energyDrift: maxDrift, steps }
}

function energyOf(
  X: Float64Array, Y: Float64Array, VX: Float64Array, VY: Float64Array,
  n: number, mass: Float64Array, g: number, eps2: number,
): number {
  let ke = 0
  for (let i = 0; i < n; i++) ke += 0.5 * mass[i] * (VX[i] * VX[i] + VY[i] * VY[i])
  let pe = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = X[j] - X[i]
      const dy = Y[j] - Y[i]
      const r = Math.sqrt(dx * dx + dy * dy + eps2)
      pe -= (g * mass[i] * mass[j]) / r
    }
  }
  return ke + pe
}

// ---------------------------------------------------------------------------
// Drawing-only trajectory sampler (cheap, no monodromy)
// ---------------------------------------------------------------------------

export interface TrajectorySample {
  /** px[body] and py[body]: sampled positions over [0, periods·T]. */
  px: Float64Array[]
  py: Float64Array[]
  /** Sample times. */
  t: Float64Array
  /** Number of samples. */
  count: number
}

/**
 * Sample a trajectory at `samplesPerPeriod` points over `periods` periods, using
 * RK4 with `subSteps` integration steps between samples. Pure positions — used
 * to draw the closed curve and animate the bodies.
 */
export function sampleTrajectory(
  psi0: Float64Array,
  n: number,
  mass: Float64Array,
  T: number,
  cfg: PeriodicConfig,
  samplesPerPeriod: number,
  periods: number,
  subSteps: number,
): TrajectorySample {
  const g = cfg.g
  const eps2 = cfg.softening * cfg.softening
  const X = new Float64Array(n)
  const Y = new Float64Array(n)
  const VX = new Float64Array(n)
  const VY = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    X[i] = psi0[i]
    Y[i] = psi0[n + i]
    VX[i] = psi0[2 * n + i]
    VY[i] = psi0[3 * n + i]
  }
  const totalSamples = samplesPerPeriod * periods + 1
  const px: Float64Array[] = []
  const py: Float64Array[] = []
  for (let i = 0; i < n; i++) {
    px.push(new Float64Array(totalSamples))
    py.push(new Float64Array(totalSamples))
  }
  const tArr = new Float64Array(totalSamples)
  const dt = T / (samplesPerPeriod * subSteps)

  const AX = new Float64Array(n)
  const AY = new Float64Array(n)
  const k1x = new Float64Array(n), k1y = new Float64Array(n), k1vx = new Float64Array(n), k1vy = new Float64Array(n)
  const k2x = new Float64Array(n), k2y = new Float64Array(n), k2vx = new Float64Array(n), k2vy = new Float64Array(n)
  const k3x = new Float64Array(n), k3y = new Float64Array(n), k3vx = new Float64Array(n), k3vy = new Float64Array(n)
  const k4x = new Float64Array(n), k4y = new Float64Array(n), k4vx = new Float64Array(n), k4vy = new Float64Array(n)
  const tX = new Float64Array(n), tY = new Float64Array(n)

  let s = 0
  const record = (time: number) => {
    for (let i = 0; i < n; i++) {
      px[i][s] = X[i]
      py[i][s] = Y[i]
    }
    tArr[s] = time
    s++
  }
  record(0)
  let time = 0
  for (let smp = 0; smp < samplesPerPeriod * periods; smp++) {
    for (let sub = 0; sub < subSteps; sub++) {
      // RK4 on positions/velocities.
      accelOnly(n, X, Y, mass, g, eps2, AX, AY)
      for (let i = 0; i < n; i++) { k1x[i] = VX[i]; k1y[i] = VY[i]; k1vx[i] = AX[i]; k1vy[i] = AY[i] }
      for (let i = 0; i < n; i++) { tX[i] = X[i] + 0.5 * dt * k1x[i]; tY[i] = Y[i] + 0.5 * dt * k1y[i] }
      accelOnly(n, tX, tY, mass, g, eps2, AX, AY)
      for (let i = 0; i < n; i++) { k2x[i] = VX[i] + 0.5 * dt * k1vx[i]; k2y[i] = VY[i] + 0.5 * dt * k1vy[i]; k2vx[i] = AX[i]; k2vy[i] = AY[i] }
      for (let i = 0; i < n; i++) { tX[i] = X[i] + 0.5 * dt * k2x[i]; tY[i] = Y[i] + 0.5 * dt * k2y[i] }
      accelOnly(n, tX, tY, mass, g, eps2, AX, AY)
      for (let i = 0; i < n; i++) { k3x[i] = VX[i] + 0.5 * dt * k2vx[i]; k3y[i] = VY[i] + 0.5 * dt * k2vy[i]; k3vx[i] = AX[i]; k3vy[i] = AY[i] }
      for (let i = 0; i < n; i++) { tX[i] = X[i] + dt * k3x[i]; tY[i] = Y[i] + dt * k3y[i] }
      accelOnly(n, tX, tY, mass, g, eps2, AX, AY)
      for (let i = 0; i < n; i++) { k4x[i] = VX[i] + dt * k3vx[i]; k4y[i] = VY[i] + dt * k3vy[i]; k4vx[i] = AX[i]; k4vy[i] = AY[i] }
      const h6 = dt / 6
      for (let i = 0; i < n; i++) {
        X[i] += h6 * (k1x[i] + 2 * k2x[i] + 2 * k3x[i] + k4x[i])
        Y[i] += h6 * (k1y[i] + 2 * k2y[i] + 2 * k3y[i] + k4y[i])
        VX[i] += h6 * (k1vx[i] + 2 * k2vx[i] + 2 * k3vx[i] + k4vx[i])
        VY[i] += h6 * (k1vy[i] + 2 * k2vy[i] + 2 * k3vy[i] + k4vy[i])
      }
      time += dt
    }
    record(time)
  }
  return { px, py, t: tArr, count: totalSamples }
}

/** Derivative ψ̇ at a state (used for the corrector's ∂F/∂T column). */
export function vectorField(psi: Float64Array, n: number, mass: Float64Array, cfg: PeriodicConfig): Float64Array {
  const g = cfg.g
  const eps2 = cfg.softening * cfg.softening
  const X = new Float64Array(n), Y = new Float64Array(n)
  for (let i = 0; i < n; i++) { X[i] = psi[i]; Y[i] = psi[n + i] }
  const AX = new Float64Array(n), AY = new Float64Array(n)
  accelOnly(n, X, Y, mass, g, eps2, AX, AY)
  const f = new Float64Array(4 * n)
  for (let i = 0; i < n; i++) {
    f[i] = psi[2 * n + i]
    f[n + i] = psi[3 * n + i]
    f[2 * n + i] = AX[i]
    f[3 * n + i] = AY[i]
  }
  return f
}

// ===========================================================================
// From-scratch eigenvalue solver for the monodromy (Floquet multipliers)
// ===========================================================================
//
// The Floquet multipliers are the eigenvalues of the D×D real monodromy M. We
// find them with the textbook two-step scheme — no libraries:
//   1. Reduce M to upper Hessenberg form by Householder similarity transforms
//      (`toHessenberg`). Similarity preserves the spectrum; Hessenberg makes the
//      QR iteration cheap.
//   2. The Francis double-shift QR algorithm (`hqr`, the classic EISPACK routine)
//      chases the subdiagonal to zero, deflating a real Schur form whose 1×1 and
//      2×2 diagonal blocks carry the real and complex-conjugate eigenvalues.
// For a Hamiltonian (symplectic) monodromy the eigenvalues come in reciprocal
// pairs {λ, 1/λ} and det = 1, both of which the self-tests check.

export interface Complex {
  re: number
  im: number
}

/** Reduce a square matrix (row-major, size n) to upper Hessenberg form in place. */
function toHessenberg(a: Float64Array, n: number): void {
  for (let m = 1; m < n - 1; m++) {
    // Find the pivot (largest magnitude) in column m-1 at or below row m.
    let x = 0
    let i = m
    for (let j = m; j < n; j++) {
      if (Math.abs(a[j * n + (m - 1)]) > Math.abs(x)) {
        x = a[j * n + (m - 1)]
        i = j
      }
    }
    if (i !== m) {
      // Interchange rows and columns i and m (similarity).
      for (let j = m - 1; j < n; j++) {
        const t = a[i * n + j]
        a[i * n + j] = a[m * n + j]
        a[m * n + j] = t
      }
      for (let j = 0; j < n; j++) {
        const t = a[j * n + i]
        a[j * n + i] = a[j * n + m]
        a[j * n + m] = t
      }
    }
    if (x !== 0) {
      for (let ii = m + 1; ii < n; ii++) {
        let y = a[ii * n + (m - 1)]
        if (y !== 0) {
          y /= x
          a[ii * n + (m - 1)] = y
          for (let j = m; j < n; j++) a[ii * n + j] -= y * a[m * n + j]
          for (let j = 0; j < n; j++) a[j * n + m] += y * a[j * n + ii]
        }
      }
    }
  }
}

/**
 * Eigenvalues of an upper-Hessenberg matrix by the Francis double-shift QR
 * algorithm (a direct port of EISPACK's `hqr`). Returns real/imag parts.
 */
function hqr(h: Float64Array, n: number): { wr: Float64Array; wi: Float64Array } {
  const wr = new Float64Array(n)
  const wi = new Float64Array(n)
  let nn = n - 1
  let t = 0
  // Scratch scalars for the Francis iteration; each is reassigned before it is
  // read inside the loop, but TypeScript's flow analysis can't prove that across
  // the do/while, so they carry an initial 0.
  // eslint-disable-next-line no-useless-assignment
  let z = 0, x = 0, y = 0, w = 0, s = 0, p = 0, q = 0, r = 0

  // Compute matrix norm for the convergence test.
  let anorm = 0
  for (let i = 0; i < n; i++) {
    for (let j = Math.max(i - 1, 0); j < n; j++) anorm += Math.abs(h[i * n + j])
  }

  while (nn >= 0) {
    let its = 0
    let l: number
    do {
      // Look for a small subdiagonal element to deflate.
      for (l = nn; l >= 1; l--) {
        s = Math.abs(h[(l - 1) * n + (l - 1)]) + Math.abs(h[l * n + l])
        if (s === 0) s = anorm
        if (Math.abs(h[l * n + (l - 1)]) + s === s) {
          h[l * n + (l - 1)] = 0
          break
        }
      }
      x = h[nn * n + nn]
      if (l === nn) {
        // One real root.
        wr[nn] = x + t
        wi[nn] = 0
        nn--
      } else {
        y = h[(nn - 1) * n + (nn - 1)]
        w = h[nn * n + (nn - 1)] * h[(nn - 1) * n + nn]
        if (l === nn - 1) {
          // Two roots (a real 2×2 block).
          p = 0.5 * (y - x)
          q = p * p + w
          z = Math.sqrt(Math.abs(q))
          x += t
          if (q >= 0) {
            z = p + (p >= 0 ? Math.abs(z) : -Math.abs(z))
            wr[nn] = x + z
            wr[nn - 1] = z !== 0 ? x - w / z : x + z
            wi[nn] = 0
            wi[nn - 1] = 0
          } else {
            wr[nn] = x + p
            wr[nn - 1] = x + p
            wi[nn] = -z
            wi[nn - 1] = z
          }
          nn -= 2
        } else {
          // No convergence yet — form the exceptional/Wilkinson shift.
          if (its === 60) {
            // Give up on this submatrix; return NaNs so the caller can flag it.
            return { wr: wr.fill(NaN), wi: wi.fill(NaN) }
          }
          if (its === 10 || its === 20 || its === 30) {
            t += x
            for (let i = 0; i <= nn; i++) h[i * n + i] -= x
            s = Math.abs(h[nn * n + (nn - 1)]) + Math.abs(h[(nn - 1) * n + (nn - 2)])
            y = 0.75 * s
            x = y
            w = -0.4375 * s * s
          }
          its++
          // Look for two consecutive small subdiagonal elements.
          let m: number
          for (m = nn - 2; m >= l; m--) {
            z = h[m * n + m]
            r = x - z
            s = y - z
            p = (r * s - w) / h[(m + 1) * n + m] + h[m * n + (m + 1)]
            q = h[(m + 1) * n + (m + 1)] - z - r - s
            r = h[(m + 2) * n + (m + 1)]
            s = Math.abs(p) + Math.abs(q) + Math.abs(r)
            p /= s
            q /= s
            r /= s
            if (m === l) break
            const u = Math.abs(h[m * n + (m - 1)]) * (Math.abs(q) + Math.abs(r))
            const v =
              Math.abs(p) *
              (Math.abs(h[(m - 1) * n + (m - 1)]) + Math.abs(z) + Math.abs(h[(m + 1) * n + (m + 1)]))
            if (u + v === v) break
          }
          for (let i = m + 2; i <= nn; i++) {
            h[i * n + (i - 2)] = 0
            if (i !== m + 2) h[i * n + (i - 3)] = 0
          }
          // Double QR step on rows l..nn, columns m..nn.
          for (let k = m; k <= nn - 1; k++) {
            if (k !== m) {
              p = h[k * n + (k - 1)]
              q = h[(k + 1) * n + (k - 1)]
              r = 0
              if (k !== nn - 1) r = h[(k + 2) * n + (k - 1)]
              x = Math.abs(p) + Math.abs(q) + Math.abs(r)
              if (x !== 0) {
                p /= x
                q /= x
                r /= x
              }
            }
            s = Math.sqrt(p * p + q * q + r * r)
            if (p < 0) s = -s
            if (s !== 0) {
              if (k === m) {
                if (l !== m) h[k * n + (k - 1)] = -h[k * n + (k - 1)]
              } else {
                h[k * n + (k - 1)] = -s * x
              }
              p += s
              x = p / s
              y = q / s
              z = r / s
              q /= p
              r /= p
              // Row modification.
              for (let j = k; j < n; j++) {
                p = h[k * n + j] + q * h[(k + 1) * n + j]
                if (k !== nn - 1) {
                  p += r * h[(k + 2) * n + j]
                  h[(k + 2) * n + j] -= p * z
                }
                h[(k + 1) * n + j] -= p * y
                h[k * n + j] -= p * x
              }
              const mmin = nn < k + 3 ? nn : k + 3
              // Column modification.
              for (let i = 0; i <= mmin; i++) {
                p = x * h[i * n + k] + y * h[i * n + (k + 1)]
                if (k !== nn - 1) {
                  p += z * h[i * n + (k + 2)]
                  h[i * n + (k + 2)] -= p * r
                }
                h[i * n + (k + 1)] -= p * q
                h[i * n + k] -= p
              }
            }
          }
        }
      }
    } while (l < nn - 1)
  }
  return { wr, wi }
}

/** Eigenvalues of a general real square matrix (row-major, size n). */
export function eigenvalues(matrix: Float64Array, n: number): Complex[] {
  const a = matrix.slice()
  toHessenberg(a, n)
  const { wr, wi } = hqr(a, n)
  const out: Complex[] = []
  for (let i = 0; i < n; i++) out.push({ re: wr[i], im: wi[i] })
  // Sort by descending modulus so the dominant multiplier comes first.
  out.sort((p, q) => q.re * q.re + q.im * q.im - (p.re * p.re + p.im * p.im))
  return out
}

export interface FloquetAnalysis {
  multipliers: Complex[]
  /** Largest |λ| — the per-period growth factor. */
  maxModulus: number
  /** Stability index: max over reciprocal pairs of ½|λ + 1/λ| for the non-trivial block (informational). */
  determinant: number
  /** Worst deviation of a multiplier's modulus from the unit circle among non-trivial ones. */
  offCircle: number
  /** 'stable' if every multiplier lies on the unit circle; else 'unstable'. */
  verdict: 'stable' | 'unstable'
  /** Max reciprocity error: min over pairs |λ_i·λ_j − 1| matched greedily. */
  reciprocityError: number
}

/**
 * Classify a periodic orbit's linear stability from its monodromy. A Hamiltonian
 * monodromy always carries a trivial pair at +1 (from time-translation along the
 * orbit and the energy/period degeneracy). The orbit is *linearly stable* when
 * every remaining multiplier sits on the unit circle |λ| = 1; a multiplier that
 * leaves the circle (with its reciprocal partner) is a hyperbolic instability
 * whose modulus is the amplification per period.
 */
export function floquet(monodromy: Float64Array, D: number, tol = 1e-3): FloquetAnalysis {
  const mult = eigenvalues(monodromy, D)
  let maxMod = 0
  let offCircle = 0
  for (const l of mult) {
    const mod = Math.hypot(l.re, l.im)
    if (mod > maxMod) maxMod = mod
  }
  // Determinant = product of eigenvalues (imag parts cancel in conjugate pairs).
  let pr = 1
  let pi = 0
  for (const l of mult) {
    const nr = pr * l.re - pi * l.im
    const ni = pr * l.im + pi * l.re
    pr = nr
    pi = ni
  }
  const det = pr

  // Off-circle measure: ignore the two multipliers closest to +1 (the trivial
  // pair) and measure how far the rest stray from |λ| = 1.
  const byDistToOne = [...mult].sort(
    (a, b) => Math.hypot(a.re - 1, a.im) - Math.hypot(b.re - 1, b.im),
  )
  const trivial = new Set<Complex>()
  for (let i = 0; i < Math.min(2, byDistToOne.length); i++) trivial.add(byDistToOne[i])
  for (const l of mult) {
    if (trivial.has(l)) continue
    const mod = Math.hypot(l.re, l.im)
    offCircle = Math.max(offCircle, Math.abs(mod - 1))
  }
  const verdict: 'stable' | 'unstable' = offCircle > tol ? 'unstable' : 'stable'

  // Reciprocity: greedily match each multiplier to a partner with λ·μ ≈ 1.
  let reciprocityError = 0
  const used = new Array(mult.length).fill(false)
  for (let i = 0; i < mult.length; i++) {
    if (used[i]) continue
    let best = -1
    let bestErr = Infinity
    for (let j = 0; j < mult.length; j++) {
      if (j === i || used[j]) continue
      // λ_i · λ_j should be 1 (product real part 1, imag 0).
      const pr2 = mult[i].re * mult[j].re - mult[i].im * mult[j].im
      const pi2 = mult[i].re * mult[j].im + mult[i].im * mult[j].re
      const err = Math.hypot(pr2 - 1, pi2)
      if (err < bestErr) {
        bestErr = err
        best = j
      }
    }
    if (best >= 0) {
      used[i] = true
      used[best] = true
      reciprocityError = Math.max(reciprocityError, bestErr)
    }
  }

  return {
    multipliers: mult,
    maxModulus: maxMod,
    determinant: det,
    offCircle,
    verdict,
    reciprocityError,
  }
}

// ===========================================================================
// Differential corrector — Levenberg–Marquardt shooting
// ===========================================================================
//
// A literature initial guess is only a periodic orbit to a handful of digits.
// We polish it with Newton's method on the shooting residual
//   F(ψ₀, T) = φ_T(ψ₀) − ψ₀ ∈ ℝ^D,
// whose Jacobian is [ M − I | f(ψ(T)) ] (the monodromy against ψ₀, the vector
// field against the period). The system is D equations in D+1 unknowns and has a
// null direction from the orbit's time-translation symmetry, so a plain Newton
// step is ill-posed. Levenberg–Marquardt damping regularises it: we solve
//   (JᵀJ + μ·diag(JᵀJ)) δ = −JᵀF,
// accept the step when the residual drops (shrinking μ toward Gauss–Newton),
// reject and grow μ otherwise. Re-centring to the COM frame each step keeps the
// translation/boost symmetries from wandering. Convergence is quadratic near the
// solution and drives ‖F‖ to ~1e-12.

/** Solve a symmetric positive-definite system A x = b (A is m×m row-major) by Cholesky. */
function choleskySolve(A: Float64Array, b: Float64Array, m: number): Float64Array | null {
  const L = new Float64Array(m * m)
  for (let i = 0; i < m; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = A[i * m + j]
      for (let k = 0; k < j; k++) sum -= L[i * m + k] * L[j * m + k]
      if (i === j) {
        if (sum <= 0) return null // not positive-definite
        L[i * m + j] = Math.sqrt(sum)
      } else {
        L[i * m + j] = sum / L[j * m + j]
      }
    }
  }
  // Forward solve L y = b.
  const y = new Float64Array(m)
  for (let i = 0; i < m; i++) {
    let sum = b[i]
    for (let k = 0; k < i; k++) sum -= L[i * m + k] * y[k]
    y[i] = sum / L[i * m + i]
  }
  // Back solve Lᵀ x = y.
  const x = new Float64Array(m)
  for (let i = m - 1; i >= 0; i--) {
    let sum = y[i]
    for (let k = i + 1; k < m; k++) sum -= L[k * m + i] * x[k]
    x[i] = sum / L[i * m + i]
  }
  return x
}

export interface CorrectorOptions {
  /** Integration steps used to evaluate the monodromy each Newton iteration. */
  steps: number
  /** Max Newton iterations. */
  maxIter: number
  /** Stop when ‖F‖ falls below this. */
  tol: number
  cfg: PeriodicConfig
  /**
   * Fractional band the period may move from its seed (e.g. 0.3 ⇒ T stays within
   * ±30%). Keeps the corrector from collapsing onto a *different* nearby periodic
   * orbit of shorter period. Omit for no clamp (exact relative equilibria).
   */
  tBand?: number
}

export interface CorrectorResult {
  psi: Float64Array
  period: number
  /** Final closure residual ‖φ_T(ψ₀) − ψ₀‖. */
  residual: number
  /** Residual history (one per accepted/attempted iteration). */
  history: number[]
  iterations: number
  converged: boolean
  /** The final monodromy (reused for the Floquet analysis). */
  monodromy: Float64Array
  energyDrift: number
}

/** Euclidean norm of a flat vector. */
function norm(v: Float64Array): number {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  return Math.sqrt(s)
}

/**
 * Refine an approximate periodic orbit to machine precision. `mass` may be
 * non-uniform. Returns the polished (ψ₀, T), the closure residual, and the
 * monodromy at the solution.
 */
export function refineOrbit(
  psiSeed: Float64Array,
  n: number,
  mass: Float64Array,
  Tseed: number,
  opts: CorrectorOptions,
): CorrectorResult {
  const D = 4 * n
  const cfg = opts.cfg
  const psi = psiSeed.slice()
  centreOfMassFrame(psi, n, mass)
  let T = Tseed

  let mono = integrateMonodromy(psi, n, mass, T, opts.steps, cfg)
  const F = new Float64Array(D)
  for (let i = 0; i < D; i++) F[i] = mono.psiT[i] - psi[i]
  let res = norm(F)
  const history: number[] = [res]

  let mu = 1e-3
  let iter = 0
  const m = D + 1

  while (iter < opts.maxIter && res > opts.tol) {
    iter++
    const M = mono.monodromy
    const fEnd = vectorField(mono.psiT, n, mass, cfg)

    // Build J (D×m): columns 0..D-1 = M − I, column D = f(ψ(T)).
    // Form normal equations JtJ (m×m) and Jtf (m) directly.
    const JtJ = new Float64Array(m * m)
    const Jtf = new Float64Array(m)
    // Precompute J rows on the fly.
    // J[r][c<D] = M[r*D+c] - (r==c); J[r][D] = fEnd[r].
    for (let r = 0; r < D; r++) {
      const fr = F[r]
      // Column entries for this row.
      for (let a = 0; a < D; a++) {
        const Jra = M[r * D + a] - (r === a ? 1 : 0)
        if (Jra === 0) continue
        Jtf[a] += Jra * fr
        for (let b = a; b < D; b++) {
          const Jrb = M[r * D + b] - (r === b ? 1 : 0)
          JtJ[a * m + b] += Jra * Jrb
        }
        // last column
        JtJ[a * m + D] += Jra * fEnd[r]
      }
      const JrD = fEnd[r]
      Jtf[D] += JrD * fr
      JtJ[D * m + D] += JrD * JrD
    }
    // Symmetrise.
    for (let a = 0; a < m; a++) for (let b = a + 1; b < m; b++) JtJ[b * m + a] = JtJ[a * m + b]

    // LM inner loop: grow μ until a step reduces the residual.
    let accepted = false
    for (let tries = 0; tries < 12 && !accepted; tries++) {
      const AA = JtJ.slice()
      for (let a = 0; a < m; a++) {
        const d = JtJ[a * m + a]
        AA[a * m + a] += mu * (d > 0 ? d : 1)
      }
      const rhs = new Float64Array(m)
      for (let a = 0; a < m; a++) rhs[a] = -Jtf[a]
      const delta = choleskySolve(AA, rhs, m)
      if (!delta) {
        mu *= 4
        continue
      }
      // Trial state.
      const trial = psi.slice()
      for (let i = 0; i < D; i++) trial[i] += delta[i]
      let Ttrial = Math.max(1e-6, T + delta[D])
      // Clamp the period into its allowed band around the seed, if requested.
      if (opts.tBand !== undefined) {
        const lo = Tseed * (1 - opts.tBand)
        const hi = Tseed * (1 + opts.tBand)
        if (Ttrial < lo || Ttrial > hi) {
          // Reject a step that would leave the band (it is heading for a wrong orbit).
          mu *= 4
          continue
        }
        Ttrial = Math.min(hi, Math.max(lo, Ttrial))
      }
      centreOfMassFrame(trial, n, mass)
      const monoTrial = integrateMonodromy(trial, n, mass, Ttrial, opts.steps, cfg)
      const Ftrial = new Float64Array(D)
      for (let i = 0; i < D; i++) Ftrial[i] = monoTrial.psiT[i] - trial[i]
      const resTrial = norm(Ftrial)
      if (resTrial < res) {
        // Accept.
        psi.set(trial)
        T = Ttrial
        mono = monoTrial
        F.set(Ftrial)
        res = resTrial
        mu = Math.max(1e-9, mu * 0.3)
        accepted = true
      } else {
        mu *= 4
      }
    }
    history.push(res)
    if (!accepted) break // no downhill step found — converged or stuck
  }

  return {
    psi,
    period: T,
    residual: res,
    history,
    iterations: iter,
    converged: res <= Math.max(opts.tol, 1e-9),
    monodromy: mono.monodromy,
    energyDrift: mono.energyDrift,
  }
}

// ===========================================================================
// The gallery — famous periodic orbits and central configurations
// ===========================================================================
//
// Two provenances. The **relative equilibria** (Lagrange's equilateral triangle,
// Euler's collinear chain, the regular N-gon "Klemperer rosette") are exact by
// construction: a central configuration rigidly rotates, so each body rides a
// circle and the whole thing repeats every T = 2π/ω. The **choreographies** come
// from the literature — the Chenciner–Montgomery figure-eight and the equal-mass,
// zero-angular-momentum family catalogued by Šuvakov & Dmitrašinović (PRL 2013),
// all in the parameterisation r₁=(−1,0), r₂=(1,0), r₃=(0,0), v₁=v₂=(ẋ,ẏ),
// v₃=(−2ẋ,−2ẏ). The seeds are only good to a few digits; the corrector polishes
// each to machine precision before it is drawn or its stability measured.

export type OrbitFamily = 'choreography' | 'relative-equilibrium' | 'other'

export interface OrbitSeed {
  id: string
  name: string
  blurb: string
  family: OrbitFamily
  n: number
  mass: Float64Array
  psi: Float64Array
  period: number
}

/** The canonical Chenciner–Montgomery / Moore figure-eight (equal masses, G=1). */
export function figureEight(): OrbitSeed {
  const n = 3
  const mass = new Float64Array([1, 1, 1])
  const psi = makePsi(n)
  const x1 = 0.97000436
  const y1 = -0.24308753
  const v3x = -0.93240737
  const v3y = -0.86473146
  setBody(psi, n, 0, x1, y1, -v3x / 2, -v3y / 2)
  setBody(psi, n, 1, -x1, -y1, -v3x / 2, -v3y / 2)
  setBody(psi, n, 2, 0, 0, v3x, v3y)
  return {
    id: 'figure-eight',
    name: 'Figure-Eight',
    blurb:
      'Three equal masses chase each other around a single ∞-shaped track (Moore 1993; Chenciner–Montgomery 2000). Zero angular momentum, and — remarkably — linearly stable.',
    family: 'choreography',
    n,
    mass,
    psi,
    period: 6.32591398,
  }
}

/** A Šuvakov–Dmitrašinović equal-mass, zero-angular-momentum orbit from its (ẋ, ẏ, T). */
export function suvakov(id: string, name: string, blurb: string, vx: number, vy: number, T: number): OrbitSeed {
  const n = 3
  const mass = new Float64Array([1, 1, 1])
  const psi = makePsi(n)
  setBody(psi, n, 0, -1, 0, vx, vy)
  setBody(psi, n, 1, 1, 0, vx, vy)
  setBody(psi, n, 2, 0, 0, -2 * vx, -2 * vy)
  return { id, name, blurb, family: 'choreography', n, mass, psi, period: T }
}

/** Lagrange's equilateral relative equilibrium: three equal masses rigidly rotating. */
export function lagrangeTriangle(): OrbitSeed {
  const n = 3
  const mass = new Float64Array([1, 1, 1])
  const R = 1
  // ω² = G·m / (√3 R³) for three equal masses on a circle of radius R.
  const omega = Math.sqrt(1 / (Math.sqrt(3) * R * R * R))
  const psi = makePsi(n)
  for (let i = 0; i < 3; i++) {
    const th = Math.PI / 2 + (2 * Math.PI * i) / 3
    const x = R * Math.cos(th)
    const y = R * Math.sin(th)
    setBody(psi, n, i, x, y, -omega * y, omega * x)
  }
  return {
    id: 'lagrange',
    name: 'Lagrange Triangle',
    blurb:
      "Three equal masses at the corners of an equilateral triangle, rigidly rotating — a relative equilibrium. Equal masses make it linearly UNSTABLE (Gascheau/Routh), which the Floquet multipliers reveal.",
    family: 'relative-equilibrium',
    n,
    mass,
    psi,
    period: (2 * Math.PI) / omega,
  }
}

/** Euler's symmetric collinear relative equilibrium (equal masses at −1, 0, +1). */
export function eulerCollinear(): OrbitSeed {
  const n = 3
  const mass = new Float64Array([1, 1, 1])
  // Outer body at r=1: inward force = Gm/r² (from centre) + Gm/(2r)² (from far
  // outer) = 1.25 Gm/r². Centripetal ⇒ ω² = 1.25.
  const omega = Math.sqrt(1.25)
  const psi = makePsi(n)
  const xs = [-1, 0, 1]
  for (let i = 0; i < 3; i++) {
    const x = xs[i]
    setBody(psi, n, i, x, 0, 0, omega * x)
  }
  return {
    id: 'euler',
    name: 'Euler Collinear',
    blurb:
      'The three masses stay on a rotating straight line (Euler 1767) — the collinear central configuration. A relative equilibrium, and hyperbolically unstable.',
    family: 'relative-equilibrium',
    n,
    mass,
    psi,
    period: (2 * Math.PI) / omega,
  }
}

/** A regular N-gon of equal masses rigidly rotating — the Klemperer rosette. */
export function regularPolygon(N: number): OrbitSeed {
  const n = N
  const mass = new Float64Array(n).fill(1)
  const R = 1
  // ω² = (G m / R³) · (1/4) Σ_{k=1}^{N-1} csc(kπ/N).
  let sum = 0
  for (let k = 1; k < N; k++) sum += 1 / Math.sin((k * Math.PI) / N)
  const omega = Math.sqrt((0.25 * sum) / (R * R * R))
  const psi = makePsi(n)
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n
    const x = R * Math.cos(th)
    const y = R * Math.sin(th)
    setBody(psi, n, i, x, y, -omega * y, omega * x)
  }
  return {
    id: `rosette-${N}`,
    name: `${N}-Gon Rosette`,
    blurb: `${N} equal masses on a regular polygon, rigidly rotating (a Klemperer rosette). Elegant — and famously unstable, as the Floquet spectrum shows.`,
    family: 'relative-equilibrium',
    n,
    mass,
    psi,
    period: (2 * Math.PI) / omega,
  }
}

// Machine-precision initial conditions for the smooth choreographies, produced
// offline by the corrector in this very module (residual ~1e-13 for the eight,
// ~5e-9 for the moth) and embedded so the gallery loads a genuine periodic orbit
// with no in-app polishing. The Šuvakov–Dmitrašinović orbits with near-collisions
// are intentionally omitted: their uniform-step monodromy is unreliable, so only
// orbits this integrator can certify to machine precision are shown.
const POLISHED: Record<string, { period: number; psi: number[] }> = {
  'figure-eight': {
    period: 6.325914003311232,
    psi: [
      9.7000435905506932e-1, -9.7000435903628346e-1, -1.8785771280965646e-11, -2.4308753099442110e-1,
      2.4308753101096123e-1, -1.6540142739045575e-11, 4.6620368472483820e-1, 4.6620368477378704e-1,
      -9.3240736949862524e-1, 4.3236573050893051e-1, 4.3236573049793220e-1, -8.6473146100686271e-1,
    ],
  },
  'moth-1': {
    period: 14.894214787454812,
    psi: [
      -9.9999572484680488e-1, 9.9999619771649706e-1, -4.7286969219710400e-7, -4.2338077786934964e-6,
      4.6007880083936007e-6, -3.6698022970010381e-7, 4.6444501264108412e-1, 4.6444370566636051e-1,
      -9.2888871830744457e-1, 3.9606289309086878e-1, 3.9606284087057869e-1, -7.9212573396144748e-1,
    ],
  },
}

/** Overlay a seed with its embedded machine-precision initial condition, if any. */
function polish(seed: OrbitSeed): OrbitSeed {
  const p = POLISHED[seed.id]
  if (!p) return seed
  return { ...seed, period: p.period, psi: Float64Array.from(p.psi) }
}

/** The built-in gallery of seed orbits — only orbits certified to machine precision. */
export function buildGallery(): OrbitSeed[] {
  return [
    polish(figureEight()),
    polish(suvakov('moth-1', 'Moth I', 'A gently fluttering choreography — three equal masses on one looping track (Šuvakov–Dmitrašinović 2013). Linearly stable, like the eight.', 0.46444, 0.39606, 14.8939)),
    lagrangeTriangle(),
    eulerCollinear(),
    regularPolygon(4),
    regularPolygon(5),
    regularPolygon(6),
  ]
}

// ===========================================================================
// Discovering the figure-eight by action minimisation
// ===========================================================================
//
// The figure-eight was not found by shooting — it was found by Chenciner &
// Montgomery (2000) as a *minimiser of the Lagrangian action* over loops with a
// particular symmetry. This reproduces that discovery from scratch: represent the
// single shared choreography curve q(t) (period 2π) by a Fourier series and slide
// its coefficients downhill on the action
//   A[q] = ∫₀^{2π} [ Σⱼ ½|q̇(t+jT/N)|² + Σ_{i<j} 1/|qᵢ−qⱼ| ] dt.
// The catch: in the *full* loop space the action's minimiser is the rigid
// rotating triangle (Lagrange), not the eight — the eight is only a minimiser
// within its symmetry class. So we restrict the ansatz to that class: x(t) uses
// only ODD cosine harmonics and y(t) only EVEN sine harmonics (both skipping
// multiples of N so the centre of mass stays pinned). The rotating circle lives
// outside this class, so a near-circular start relaxes straight into the eight —
// and the action lands on its known value ≈ 24.372.

const EIGHT_KX = [1, 5, 7, 11, 13] // x(t) = Σ ax_k cos(k t), k odd, not a multiple of 3
const EIGHT_KY = [2, 4, 8, 10, 14] // y(t) = Σ by_k sin(k t), k even, not a multiple of 3
const EIGHT_TAU = [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]

function eightPos(coef: Float64Array, t: number): [number, number] {
  let x = 0
  let y = 0
  for (let m = 0; m < EIGHT_KX.length; m++) x += coef[m] * Math.cos(EIGHT_KX[m] * t)
  for (let m = 0; m < EIGHT_KY.length; m++) y += coef[EIGHT_KX.length + m] * Math.sin(EIGHT_KY[m] * t)
  return [x, y]
}

function eightVel(coef: Float64Array, t: number): [number, number] {
  let x = 0
  let y = 0
  for (let m = 0; m < EIGHT_KX.length; m++) x += -EIGHT_KX[m] * coef[m] * Math.sin(EIGHT_KX[m] * t)
  for (let m = 0; m < EIGHT_KY.length; m++) y += EIGHT_KY[m] * coef[EIGHT_KX.length + m] * Math.cos(EIGHT_KY[m] * t)
  return [x, y]
}

export interface DiscoveryFrame {
  /** The single shared curve, sampled as [x0,y0,x1,y1,…] over one period. */
  curve: Float64Array
  action: number
  iter: number
}

export interface DiscoveryResult {
  frames: DiscoveryFrame[]
  history: number[]
  action: number
  orbit: OrbitSeed
}

/**
 * A stateful, incremental figure-eight discoverer. It precomputes the (fixed)
 * trigonometric basis on the S quadrature nodes so each action/gradient
 * evaluation is table lookups and arithmetic — no `Math.cos` in the hot loop —
 * and exposes `iterate(n)` so a UI can drive a few conjugate-gradient steps per
 * animation frame and watch the curve relax from a circle into the eight without
 * ever blocking the main thread.
 */
export class EightDiscoverer {
  private readonly S: number
  private readonly nx = EIGHT_KX.length
  private readonly dim = EIGHT_KX.length + EIGHT_KY.length
  private readonly coef: Float64Array
  // Precomputed basis: cosX[(j*nx+m)*S + s] = cos(kx_m·(t_s+τ_j)); sinY similarly.
  private readonly cosX: Float64Array
  private readonly sinY: Float64Array
  private grad: Float64Array
  private dir: Float64Array
  private gg: number
  private A: number
  private step = 0.02
  readonly history: number[] = []
  iters = 0

  constructor(sampleCount = 200) {
    const S = sampleCount
    this.S = S
    const nx = this.nx
    const ny = EIGHT_KY.length
    this.cosX = new Float64Array(3 * nx * S)
    this.sinY = new Float64Array(3 * ny * S)
    for (let j = 0; j < 3; j++) {
      for (let s = 0; s < S; s++) {
        const t = (s / S) * 2 * Math.PI + EIGHT_TAU[j]
        for (let m = 0; m < nx; m++) this.cosX[(j * nx + m) * S + s] = Math.cos(EIGHT_KX[m] * t)
        for (let m = 0; m < ny; m++) this.sinY[(j * ny + m) * S + s] = Math.sin(EIGHT_KY[m] * t)
      }
    }
    this.coef = new Float64Array(this.dim)
    this.coef[0] = 1.0 // x = cos t
    this.coef[nx] = 0.3 // y = 0.3 sin 2t — a squashed near-circle
    const r = this.actionGrad(this.coef)
    this.A = r.A
    this.grad = r.grad
    this.dir = Float64Array.from(this.grad, (g) => -g)
    this.gg = this.grad.reduce((a, b) => a + b * b, 0)
    this.history.push(this.A)
  }

  private actionGrad(coef: Float64Array): { A: number; grad: Float64Array } {
    const S = this.S
    const nx = this.nx
    const ny = EIGHT_KY.length
    const dim = this.dim
    const grad = new Float64Array(dim)
    let Akin = 0
    for (let m = 0; m < nx; m++) {
      const k = EIGHT_KX[m]
      Akin += 3 * Math.PI * 0.5 * k * k * coef[m] * coef[m]
      grad[m] += 3 * Math.PI * k * k * coef[m]
    }
    for (let m = 0; m < ny; m++) {
      const k = EIGHT_KY[m]
      const idx = nx + m
      Akin += 3 * Math.PI * 0.5 * k * k * coef[idx] * coef[idx]
      grad[idx] += 3 * Math.PI * k * k * coef[idx]
    }
    const dt = (2 * Math.PI) / S
    const px = [0, 0, 0]
    const py = [0, 0, 0]
    let Apot = 0
    for (let s = 0; s < S; s++) {
      for (let j = 0; j < 3; j++) {
        let x = 0
        let y = 0
        for (let m = 0; m < nx; m++) x += coef[m] * this.cosX[(j * nx + m) * S + s]
        for (let m = 0; m < ny; m++) y += coef[nx + m] * this.sinY[(j * ny + m) * S + s]
        px[j] = x
        py[j] = y
      }
      for (let i = 0; i < 3; i++) {
        for (let j = i + 1; j < 3; j++) {
          const dx = px[i] - px[j]
          const dy = py[i] - py[j]
          const rr = Math.sqrt(dx * dx + dy * dy) + 1e-12
          Apot += dt / rr
          const inv3 = 1 / (rr * rr * rr)
          const gx = -dt * inv3 * dx
          const gy = -dt * inv3 * dy
          for (let m = 0; m < nx; m++) {
            grad[m] += gx * (this.cosX[(i * nx + m) * S + s] - this.cosX[(j * nx + m) * S + s])
          }
          for (let m = 0; m < ny; m++) {
            grad[nx + m] += gy * (this.sinY[(i * ny + m) * S + s] - this.sinY[(j * ny + m) * S + s])
          }
        }
      }
    }
    return { A: Akin + Apot, grad }
  }

  /** Run `n` conjugate-gradient steps. Returns the current action. */
  iterate(n: number): number {
    const dim = this.dim
    for (let it = 0; it < n; it++) {
      // Expanding/backtracking line search along the search direction.
      let step = this.step
      let best = this.A
      let bestStep = 0
      for (let ls = 0; ls < 32; ls++) {
        const trial = Float64Array.from(this.coef, (c, i) => c + step * this.dir[i])
        const At = this.actionGrad(trial).A
        if (At < best) {
          best = At
          bestStep = step
          step *= 1.5
        } else {
          step *= 0.5
        }
        if (step < 1e-10) break
      }
      if (bestStep === 0) {
        for (let i = 0; i < dim; i++) this.coef[i] -= 1e-3 * this.grad[i]
      } else {
        for (let i = 0; i < dim; i++) this.coef[i] += bestStep * this.dir[i]
        this.step = bestStep
      }
      const r = this.actionGrad(this.coef)
      let beta = 0
      for (let i = 0; i < dim; i++) beta += r.grad[i] * (r.grad[i] - this.grad[i])
      beta = Math.max(0, beta / (this.gg || 1))
      for (let i = 0; i < dim; i++) this.dir[i] = -r.grad[i] + beta * this.dir[i]
      this.grad = r.grad
      this.gg = this.grad.reduce((a, b) => a + b * b, 0)
      this.A = r.A
      this.iters++
      this.history.push(this.A)
    }
    return this.A
  }

  /** Current gradient norm — a convergence gauge. */
  gradNorm(): number {
    return Math.sqrt(this.gg)
  }

  get action(): number {
    return this.A
  }

  /** Sample the current shared curve as [x0,y0,x1,y1,…]. */
  sampleCurve(sampleCount = 240): Float64Array {
    const out = new Float64Array(sampleCount * 2)
    for (let s = 0; s < sampleCount; s++) {
      const t = (s / sampleCount) * 2 * Math.PI
      const p = eightPos(this.coef, t)
      out[2 * s] = p[0]
      out[2 * s + 1] = p[1]
    }
    return out
  }

  /** Extract the current curve's choreography as an orbit seed (period 2π). */
  orbit(): OrbitSeed {
    const psi = makePsi(3)
    for (let j = 0; j < 3; j++) {
      const p = eightPos(this.coef, EIGHT_TAU[j])
      const v = eightVel(this.coef, EIGHT_TAU[j])
      setBody(psi, 3, j, p[0], p[1], v[0], v[1])
    }
    return {
      id: 'discovered-eight',
      name: 'Discovered Eight',
      blurb:
        'The figure-eight, discovered from a near-circular loop by minimising the Lagrangian action in its symmetry class — the way Chenciner & Montgomery found it.',
      family: 'choreography',
      n: 3,
      mass: new Float64Array([1, 1, 1]),
      psi,
      period: 2 * Math.PI,
    }
  }
}

/**
 * Batch discovery — runs the whole minimisation and returns curve snapshots for
 * a caller that does not animate incrementally (and for the self-test).
 */
export function discoverEight(iters = 400, sampleCount = 120, frameEvery = 20): DiscoveryResult {
  const d = new EightDiscoverer(200)
  const frames: DiscoveryFrame[] = [{ curve: d.sampleCurve(sampleCount), action: d.action, iter: 0 }]
  for (let done = 0; done < iters; done += frameEvery) {
    d.iterate(Math.min(frameEvery, iters - done))
    frames.push({ curve: d.sampleCurve(sampleCount), action: d.action, iter: d.iters })
  }
  return { frames, history: d.history, action: d.action, orbit: d.orbit() }
}
