// The N-body simulation core.
//
// State is held in struct-of-arrays typed buffers (posX, posY, velX, …) sized
// to a fixed capacity. Forces are evaluated through the Barnes–Hut quadtree;
// the chosen integrator advances the state. Diagnostics (energy, momentum,
// angular momentum) are computed on demand to verify integrator quality.

import { Quadtree } from './Quadtree'
import type { Diagnostics, IntegratorId, SimParams } from './types'

export class Simulation {
  readonly capacity: number
  count = 0

  posX: Float64Array
  posY: Float64Array
  velX: Float64Array
  velY: Float64Array
  mass: Float64Array

  // Persisted accelerations (needed by Verlet/Leapfrog across steps).
  accX: Float64Array
  accY: Float64Array

  // Scratch buffers for the multi-stage RK4 integrator.
  private k1x: Float64Array
  private k1y: Float64Array
  private k2x: Float64Array
  private k2y: Float64Array
  private k3x: Float64Array
  private k3y: Float64Array
  private k4x: Float64Array
  private k4y: Float64Array
  private tmpX: Float64Array
  private tmpY: Float64Array
  private tmpVX: Float64Array
  private tmpVY: Float64Array

  private tree = new Quadtree()
  private stack = new Int32Array(4096)

  params: SimParams = {
    g: 1,
    theta: 0.7,
    softening: 2,
    dt: 0.05,
    integrator: 'velocity-verlet',
  }

  /** Total simulated time elapsed. */
  time = 0
  /** Number of steps taken since the last reset. */
  steps = 0

  private initialEnergy = NaN
  private accelDirty = true

  constructor(capacity = 30000) {
    this.capacity = capacity
    const f = () => new Float64Array(capacity)
    this.posX = f()
    this.posY = f()
    this.velX = f()
    this.velY = f()
    this.mass = f()
    this.accX = f()
    this.accY = f()
    this.k1x = f()
    this.k1y = f()
    this.k2x = f()
    this.k2y = f()
    this.k3x = f()
    this.k3y = f()
    this.k4x = f()
    this.k4y = f()
    this.tmpX = f()
    this.tmpY = f()
    this.tmpVX = f()
    this.tmpVY = f()
  }

  /** Replace all bodies. Arrays are copied into the simulation buffers. */
  setBodies(
    n: number,
    posX: Float64Array,
    posY: Float64Array,
    velX: Float64Array,
    velY: Float64Array,
    mass: Float64Array,
  ): void {
    this.count = Math.min(n, this.capacity)
    this.posX.set(posX.subarray(0, this.count))
    this.posY.set(posY.subarray(0, this.count))
    this.velX.set(velX.subarray(0, this.count))
    this.velY.set(velY.subarray(0, this.count))
    this.mass.set(mass.subarray(0, this.count))
    this.time = 0
    this.steps = 0
    this.initialEnergy = NaN
    this.accelDirty = true
  }

  /** Append a single body (e.g. from a user slingshot). Returns success. */
  addBody(x: number, y: number, vx: number, vy: number, m: number): boolean {
    if (this.count >= this.capacity) return false
    const i = this.count++
    this.posX[i] = x
    this.posY[i] = y
    this.velX[i] = vx
    this.velY[i] = vy
    this.mass[i] = m
    this.accelDirty = true
    return true
  }

  private ensureTheta2eps2(): { theta2: number; eps2: number } {
    return {
      theta2: this.params.theta * this.params.theta,
      eps2: this.params.softening * this.params.softening,
    }
  }

  /**
   * Compute accelerations for the current positions into `outX`/`outY`. Rebuilds
   * the Barnes–Hut tree from the current positions first.
   */
  private computeAccel(
    posX: Float64Array,
    posY: Float64Array,
    outX: Float64Array,
    outY: Float64Array,
  ): void {
    const n = this.count
    const { theta2, eps2 } = this.ensureTheta2eps2()
    const g = this.params.g
    this.tree.build(n, posX, posY, this.mass)
    const tree = this.tree
    const stack = this.stack
    for (let i = 0; i < n; i++) {
      const [ax, ay] = tree.acceleration(posX[i], posY[i], i, theta2, eps2, g, stack)
      outX[i] = ax
      outY[i] = ay
    }
  }

  /** Ensure `accX/accY` hold valid accelerations for the current positions. */
  private refreshAccel(): void {
    if (this.accelDirty) {
      this.computeAccel(this.posX, this.posY, this.accX, this.accY)
      this.accelDirty = false
    }
  }

  /** Advance the simulation by one timestep using the selected integrator. */
  step(): void {
    const n = this.count
    if (n === 0) return
    const dt = this.params.dt

    switch (this.params.integrator) {
      case 'euler':
        this.stepEuler(n, dt)
        break
      case 'symplectic-euler':
        this.stepSymplecticEuler(n, dt)
        break
      case 'velocity-verlet':
      case 'leapfrog':
        this.stepVerlet(n, dt)
        break
      case 'rk4':
        this.stepRk4(n, dt)
        break
    }

    this.time += dt
    this.steps++
  }

  // Explicit (forward) Euler — uses the acceleration at the *start* of the step
  // for both position and velocity updates. Non-symplectic; energy grows.
  private stepEuler(n: number, dt: number): void {
    this.refreshAccel()
    const { posX, posY, velX, velY, accX, accY } = this
    for (let i = 0; i < n; i++) {
      posX[i] += velX[i] * dt
      posY[i] += velY[i] * dt
      velX[i] += accX[i] * dt
      velY[i] += accY[i] * dt
    }
    this.accelDirty = true
  }

  // Symplectic (semi-implicit) Euler — update velocity first, then drift with
  // the *new* velocity. First-order but symplectic, so it is well-behaved.
  private stepSymplecticEuler(n: number, dt: number): void {
    this.refreshAccel()
    const { posX, posY, velX, velY, accX, accY } = this
    for (let i = 0; i < n; i++) {
      velX[i] += accX[i] * dt
      velY[i] += accY[i] * dt
      posX[i] += velX[i] * dt
      posY[i] += velY[i] * dt
    }
    this.accelDirty = true
  }

  // Velocity Verlet / Leapfrog (kick–drift–kick). One force evaluation per step
  // by reusing the stored acceleration from the previous step.
  private stepVerlet(n: number, dt: number): void {
    this.refreshAccel()
    const { posX, posY, velX, velY, accX, accY } = this
    const halfDt = dt * 0.5

    // Drift positions using current velocity + half-step from current accel.
    for (let i = 0; i < n; i++) {
      velX[i] += accX[i] * halfDt
      velY[i] += accY[i] * halfDt
      posX[i] += velX[i] * dt
      posY[i] += velY[i] * dt
    }
    // Recompute accelerations at the new positions, then finish the kick.
    this.computeAccel(posX, posY, accX, accY)
    for (let i = 0; i < n; i++) {
      velX[i] += accX[i] * halfDt
      velY[i] += accY[i] * halfDt
    }
    // accX/accY are now valid for the new positions.
    this.accelDirty = false
  }

  // Classic 4th-order Runge–Kutta on the first-order system
  //   x' = v,  v' = a(x).
  // Accurate but non-symplectic and 4× the force cost.
  private stepRk4(n: number, dt: number): void {
    const {
      posX, posY, velX, velY,
      k1x, k1y, k2x, k2y, k3x, k3y, k4x, k4y,
      tmpX, tmpY, tmpVX, tmpVY,
    } = this

    // k1: derivative at the start.
    this.computeAccel(posX, posY, k1x, k1y) // dv/dt
    // dx/dt = v (current velocity).

    // Stage 2 at t + dt/2 using k1.
    const h = dt * 0.5
    for (let i = 0; i < n; i++) {
      tmpX[i] = posX[i] + velX[i] * h
      tmpY[i] = posY[i] + velY[i] * h
      tmpVX[i] = velX[i] + k1x[i] * h
      tmpVY[i] = velY[i] + k1y[i] * h
    }
    this.computeAccel(tmpX, tmpY, k2x, k2y)

    // Stage 3 at t + dt/2 using k2.
    for (let i = 0; i < n; i++) {
      tmpX[i] = posX[i] + tmpVX[i] * h
      tmpY[i] = posY[i] + tmpVY[i] * h
      tmpVX[i] = velX[i] + k2x[i] * h
      tmpVY[i] = velY[i] + k2y[i] * h
    }
    this.computeAccel(tmpX, tmpY, k3x, k3y)

    // Stage 4 at t + dt using k3.
    for (let i = 0; i < n; i++) {
      tmpX[i] = posX[i] + tmpVX[i] * dt
      tmpY[i] = posY[i] + tmpVY[i] * dt
      tmpVX[i] = velX[i] + k3x[i] * dt
      tmpVY[i] = velY[i] + k3y[i] * dt
    }
    this.computeAccel(tmpX, tmpY, k4x, k4y)

    // Combine. The velocity slopes for position are v, v2, v3, v4 (stored in
    // tmpV* progressively); we reconstruct them inline below.
    const sixth = dt / 6
    for (let i = 0; i < n; i++) {
      // Position slopes: v1 = velX, v2 = velX + k1*h, v3 = velX + k2*h,
      // v4 = velX + k3*dt.
      const v1x = velX[i]
      const v1y = velY[i]
      const v2x = velX[i] + k1x[i] * h
      const v2y = velY[i] + k1y[i] * h
      const v3x = velX[i] + k2x[i] * h
      const v3y = velY[i] + k2y[i] * h
      const v4x = velX[i] + k3x[i] * dt
      const v4y = velY[i] + k3y[i] * dt

      posX[i] += sixth * (v1x + 2 * v2x + 2 * v3x + v4x)
      posY[i] += sixth * (v1y + 2 * v2y + 2 * v3y + v4y)
      velX[i] += sixth * (k1x[i] + 2 * k2x[i] + 2 * k3x[i] + k4x[i])
      velY[i] += sixth * (k1y[i] + 2 * k2y[i] + 2 * k3y[i] + k4y[i])
    }
    this.accelDirty = true
  }

  /**
   * Energy + momentum diagnostics, used to verify integrator behaviour.
   * Momentum, angular momentum and the centre of mass are always O(n). The
   * potential energy is O(n²); pass `includePotential = false` for large N to
   * skip it (the energy fields then come back as NaN). This is the only O(n²)
   * routine in the engine, so the caller should throttle it.
   */
  diagnostics(includePotential = true): Diagnostics {
    const n = this.count
    const { posX, posY, velX, velY, mass } = this
    const g = this.params.g
    const eps2 = this.params.softening * this.params.softening

    let kinetic = 0
    let px = 0
    let py = 0
    let angular = 0
    let comX = 0
    let comY = 0
    let totalMass = 0

    for (let i = 0; i < n; i++) {
      const m = mass[i]
      const vx = velX[i]
      const vy = velY[i]
      kinetic += 0.5 * m * (vx * vx + vy * vy)
      px += m * vx
      py += m * vy
      angular += m * (posX[i] * vy - posY[i] * vx)
      comX += m * posX[i]
      comY += m * posY[i]
      totalMass += m
    }
    if (totalMass > 0) {
      comX /= totalMass
      comY /= totalMass
    }

    // Softened pairwise potential energy: U = -Σ_{i<j} G m_i m_j / √(r² + ε²).
    let potential = 0
    let total = NaN
    let drift = NaN
    if (includePotential) {
      for (let i = 0; i < n; i++) {
        const xi = posX[i]
        const yi = posY[i]
        const mi = mass[i]
        for (let j = i + 1; j < n; j++) {
          const dx = posX[j] - xi
          const dy = posY[j] - yi
          const r = Math.sqrt(dx * dx + dy * dy + eps2)
          potential -= (g * mi * mass[j]) / r
        }
      }
      total = kinetic + potential
      if (Number.isNaN(this.initialEnergy)) this.initialEnergy = total
      drift =
        this.initialEnergy !== 0 ? (total - this.initialEnergy) / Math.abs(this.initialEnergy) : 0
    } else {
      potential = NaN
    }

    return {
      kinetic,
      potential,
      total,
      energyDrift: drift,
      momentumX: px,
      momentumY: py,
      angularMomentum: angular,
      comX,
      comY,
    }
  }

  /** O(n) centre of mass, for the camera "follow" mode. */
  centerOfMass(): [number, number] {
    const n = this.count
    let cx = 0
    let cy = 0
    let tm = 0
    for (let i = 0; i < n; i++) {
      const m = this.mass[i]
      cx += m * this.posX[i]
      cy += m * this.posY[i]
      tm += m
    }
    if (tm > 0) {
      cx /= tm
      cy /= tm
    }
    return [cx, cy]
  }

  /** Reset the energy baseline (used after parameter changes that alter energy). */
  resetEnergyBaseline(): void {
    this.initialEnergy = NaN
  }

  /** Mark accelerations stale, e.g. after the user edits params mid-pause. */
  invalidateAccel(): void {
    this.accelDirty = true
  }

  /** Expose the tree for the debug overlay (valid after a step). */
  get quadtree(): Quadtree {
    return this.tree
  }

  setIntegrator(id: IntegratorId): void {
    this.params.integrator = id
    this.accelDirty = true
  }
}
