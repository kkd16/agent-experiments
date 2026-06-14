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
    collide: false,
    collisionScale: 0.8,
  }

  /** Total simulated time elapsed. */
  time = 0
  /** Number of steps taken since the last reset. */
  steps = 0

  /** Total number of merge events since the last reset. */
  mergeCount = 0
  /**
   * Recent accretion flashes for the renderer: world position, an age counted in
   * steps (older = more faded), and the merged mass (drives the flash radius).
   * Kept as parallel plain arrays — the list is short and the renderer only reads.
   */
  readonly flashX: number[] = []
  readonly flashY: number[] = []
  readonly flashAge: number[] = []
  readonly flashMass: number[] = []

  private initialEnergy = NaN
  private accelDirty = true
  private dead: Uint8Array
  // A lazily-built second engine used only to forecast trajectories.
  private predictor: Simulation | null = null

  constructor(capacity = 30000) {
    this.capacity = capacity
    this.dead = new Uint8Array(capacity)
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
    this.mergeCount = 0
    this.clearFlashes()
    this.initialEnergy = NaN
    this.accelDirty = true
  }

  private clearFlashes(): void {
    this.flashX.length = 0
    this.flashY.length = 0
    this.flashAge.length = 0
    this.flashMass.length = 0
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

    // Age and prune accretion flashes before any new merges spawn fresh ones.
    if (this.flashAge.length > 0) this.ageFlashes()

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

    if (this.params.collide && this.count > 1) this.handleCollisions()

    this.time += dt
    this.steps++
  }

  /** Flash lifetime in steps; older flashes are dropped. */
  private static readonly FLASH_LIFE = 28

  private ageFlashes(): void {
    const age = this.flashAge
    for (let i = 0; i < age.length; i++) age[i]++
    // Oldest flashes sit at the front (FIFO); drop those past their lifetime.
    let drop = 0
    while (drop < age.length && age[drop] > Simulation.FLASH_LIFE) drop++
    if (drop > 0) {
      this.flashX.splice(0, drop)
      this.flashY.splice(0, drop)
      this.flashAge.splice(0, drop)
      this.flashMass.splice(0, drop)
    }
  }

  private pushFlash(x: number, y: number, m: number): void {
    this.flashX.push(x)
    this.flashY.push(y)
    this.flashAge.push(0)
    this.flashMass.push(m)
    const MAX = 200
    if (this.flashX.length > MAX) {
      const over = this.flashX.length - MAX
      this.flashX.splice(0, over)
      this.flashY.splice(0, over)
      this.flashAge.splice(0, over)
      this.flashMass.splice(0, over)
    }
  }

  /**
   * Perfectly-inelastic collisions. Each body has a capture radius
   * R = collisionScale · mass^(1/3); two bodies merge when their centres fall
   * within R_i + R_j. Neighbours are found with a uniform spatial hash whose cell
   * size is twice the largest capture radius, so any colliding pair lies within a
   * 3×3 block of cells. Merges conserve total mass, momentum and the centre of
   * mass; the surviving array is then compacted in place. Returns the merge count.
   */
  private handleCollisions(): number {
    const n = this.count
    if (n < 2) return 0
    const scale = this.params.collisionScale
    if (scale <= 0) return 0
    const { posX, posY, velX, velY, mass } = this
    const dead = this.dead
    for (let i = 0; i < n; i++) dead[i] = 0

    let maxMass = 0
    for (let i = 0; i < n; i++) if (mass[i] > maxMass) maxMass = mass[i]
    const maxR = scale * Math.cbrt(maxMass)
    const cell = Math.max(maxR * 2, 1e-6)
    const inv = 1 / cell
    // Pack a signed cell coordinate into one positive number; the offset keeps
    // both axes non-negative for the spatial-coordinate ranges we ever simulate.
    const OFF = 1 << 20
    const STRIDE = 1 << 21
    const key = (gx: number, gy: number) => (gx + OFF) * STRIDE + (gy + OFF)

    const grid = new Map<number, number[]>()
    for (let i = 0; i < n; i++) {
      const gx = Math.floor(posX[i] * inv)
      const gy = Math.floor(posY[i] * inv)
      const k = key(gx, gy)
      let bucket = grid.get(k)
      if (!bucket) {
        bucket = []
        grid.set(k, bucket)
      }
      bucket.push(i)
    }

    let merges = 0
    for (let i = 0; i < n; i++) {
      if (dead[i]) continue
      const gx = Math.floor(posX[i] * inv)
      const gy = Math.floor(posY[i] * inv)
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const bucket = grid.get(key(gx + ox, gy + oy))
          if (!bucket) continue
          for (let t = 0; t < bucket.length; t++) {
            const j = bucket[t]
            if (j === i || dead[j]) continue
            const dx = posX[j] - posX[i]
            const dy = posY[j] - posY[i]
            const d2 = dx * dx + dy * dy
            const sum = scale * (Math.cbrt(mass[i]) + Math.cbrt(mass[j]))
            if (d2 < sum * sum) {
              const mi = mass[i]
              const mj = mass[j]
              const M = mi + mj
              posX[i] = (posX[i] * mi + posX[j] * mj) / M
              posY[i] = (posY[i] * mi + posY[j] * mj) / M
              velX[i] = (velX[i] * mi + velX[j] * mj) / M
              velY[i] = (velY[i] * mi + velY[j] * mj) / M
              mass[i] = M
              dead[j] = 1
              merges++
              this.pushFlash(posX[i], posY[i], M)
            }
          }
        }
      }
    }

    if (merges > 0) {
      let w = 0
      for (let r = 0; r < n; r++) {
        if (dead[r]) continue
        if (w !== r) {
          posX[w] = posX[r]
          posY[w] = posY[r]
          velX[w] = velX[r]
          velY[w] = velY[r]
          mass[w] = mass[r]
          this.accX[w] = this.accX[r]
          this.accY[w] = this.accY[r]
        }
        w++
      }
      this.count = w
      this.accelDirty = true
      this.mergeCount += merges
    }
    return merges
  }

  /** The `k` heaviest bodies, by descending mass — used to seed orbit forecasts. */
  heaviestIndices(k: number): number[] {
    const n = this.count
    const idx = new Array<number>(n)
    for (let i = 0; i < n; i++) idx[i] = i
    idx.sort((a, b) => this.mass[b] - this.mass[a])
    return idx.slice(0, Math.min(k, n))
  }

  /**
   * Forecast the future paths of the given bodies by evolving a private copy of
   * the whole system forward `steps` timesteps and sampling every `stride`
   * steps. Gravity from all bodies is included, so the forecast is faithful (up
   * to numerical error and any future collisions, which the shadow run ignores so
   * that body indices stay stable). Returns one flat [x0,y0,x1,y1,…] path per
   * index, in world coordinates.
   */
  predict(indices: number[], steps: number, stride: number): Float64Array[] {
    if (this.count === 0 || indices.length === 0 || steps <= 0) return []
    if (!this.predictor) this.predictor = new Simulation(this.capacity)
    const p = this.predictor
    p.setBodies(this.count, this.posX, this.posY, this.velX, this.velY, this.mass)
    p.params = { ...this.params, collide: false }

    const m = indices.length
    const maxSamples = Math.floor(steps / stride) + 2
    const paths = indices.map(() => new Float64Array(maxSamples * 2))
    for (let k = 0; k < m; k++) {
      const idx = indices[k]
      paths[k][0] = p.posX[idx]
      paths[k][1] = p.posY[idx]
    }
    let s = 1
    for (let step = 1; step <= steps; step++) {
      p.step()
      if (step % stride === 0 && s < maxSamples) {
        for (let k = 0; k < m; k++) {
          const idx = indices[k]
          paths[k][s * 2] = p.posX[idx]
          paths[k][s * 2 + 1] = p.posY[idx]
        }
        s++
      }
    }
    return paths.map((path) => path.subarray(0, s * 2))
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
