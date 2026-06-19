// The Wisdom–Holman symplectic integrator (democratic-heliocentric formulation),
// plus a head-to-head harness against ordinary brute-force integrators.
//
// WHY THIS IS THE RIGHT TOOL FOR PLANETARY SYSTEMS
// ------------------------------------------------
// A planetary system is "nearly Keplerian": each planet's motion is dominated by
// the star, with the other planets a tiny perturbation (mass ratio ~10⁻³). A
// brute-force stepper (Verlet, RK4) integrates the WHOLE force — including the
// enormous, fast-curving stellar term — approximately, so its error scales with
// the full dynamics. Wisdom & Holman (1991) instead SPLIT the Hamiltonian
//
//     H = H_Kepler  +  H_interaction  +  H_Sun
//
// and integrate the dominant Keplerian part EXACTLY (the universal-variable
// propagator in `kepler.ts` advances each planet analytically along its orbit),
// numerically integrating only the small interaction. The result is a symplectic,
// time-reversible map whose energy error is bounded forever and scales with the
// *perturbation* — so it holds energy ~10³–10⁵× better than Verlet at the same
// step size. It is the algorithm behind every long-term Solar-System integration
// (SWIFT, MERCURY, REBOUND's WHFast).
//
// DEMOCRATIC-HELIOCENTRIC COORDINATES (Duncan, Levison & Lee 1998)
// ----------------------------------------------------------------
// Heliocentric positions Qᵢ = xᵢ − x₀ (i ≥ 1, relative to the star), barycentric
// momenta Pᵢ = mᵢvᵢ (we work in the barycentre frame, where ΣP = 0). The split:
//
//   H_Kepler      = Σ_{i≥1} [ Pᵢ²/2mᵢ − G m₀ mᵢ / |Qᵢ| ]   → each an exact Kepler drift (μ = G m₀)
//   H_interaction = − Σ_{0<i<j} G mᵢ mⱼ / |Qᵢ − Qⱼ|          → planet–planet kicks
//   H_Sun         = |Σ_{i≥1} Pᵢ|² / 2m₀                      → a linear "drift" of every Qᵢ
//
// A symmetric (hence 2nd-order, time-reversible) step of length τ composes the
// three exact sub-maps palindromically:
//
//   Sun(τ/2) · Kick(τ/2) · Kepler(τ) · Kick(τ/2) · Sun(τ/2)
//
// and a Yoshida triple-jump of that map gives a 4th-order WH integrator for free
// (the Kepler propagator handles the negative middle sub-step without complaint).

import { keplerStep } from './kepler'

export interface Body {
  m: number
  x: number
  y: number
  vx: number
  vy: number
}

export type WHOrder = 2 | 4

const cloneBodies = (b: Body[]): Body[] => b.map((p) => ({ ...p }))

/** Exact total energy of an unsoftened N-body system, in the inertial frame. */
export function totalEnergy(bodies: Body[], G: number): number {
  let kinetic = 0
  let potential = 0
  const n = bodies.length
  for (let i = 0; i < n; i++) {
    const b = bodies[i]
    kinetic += 0.5 * b.m * (b.vx * b.vx + b.vy * b.vy)
    for (let j = i + 1; j < n; j++) {
      const c = bodies[j]
      const d = Math.hypot(c.x - b.x, c.y - b.y)
      if (d > 0) potential -= (G * b.m * c.m) / d
    }
  }
  return kinetic + potential
}

/** Total (scalar, z-axis) angular momentum about the origin. */
export function angularMomentum(bodies: Body[]): number {
  let l = 0
  for (const b of bodies) l += b.m * (b.x * b.vy - b.y * b.vx)
  return l
}

/** Total linear-momentum magnitude — a conservation probe. */
export function momentumMagnitude(bodies: Body[]): number {
  let px = 0
  let py = 0
  for (const b of bodies) {
    px += b.m * b.vx
    py += b.m * b.vy
  }
  return Math.hypot(px, py)
}

/** Shift a system into its barycentre frame (centre of mass at rest at origin). */
export function toBarycentric(bodies: Body[]): Body[] {
  let M = 0
  let cx = 0
  let cy = 0
  let vx = 0
  let vy = 0
  for (const b of bodies) {
    M += b.m
    cx += b.m * b.x
    cy += b.m * b.y
    vx += b.m * b.vx
    vy += b.m * b.vy
  }
  cx /= M; cy /= M; vx /= M; vy /= M
  return bodies.map((b) => ({ m: b.m, x: b.x - cx, y: b.y - cy, vx: b.vx - vx, vy: b.vy - vy }))
}

/**
 * A Wisdom–Holman integrator over a fixed set of bodies. Body 0 must be the
 * central star (the most massive body). State is held internally in
 * democratic-heliocentric variables and only converted back to inertial
 * coordinates on demand, so step-to-step there is no round-trip error.
 */
export class WisdomHolman {
  readonly G: number
  readonly n: number
  private readonly m: Float64Array
  private readonly m0: number
  private readonly M: number
  // Heliocentric positions and barycentric momenta for planets (index 1..n-1).
  private readonly Qx: Float64Array
  private readonly Qy: Float64Array
  private readonly Px: Float64Array
  private readonly Py: Float64Array

  constructor(bodies: Body[], G: number) {
    this.G = G
    this.n = bodies.length
    const bary = toBarycentric(bodies)
    this.m = Float64Array.from(bary.map((b) => b.m))
    this.m0 = this.m[0]
    let M = 0
    for (const v of this.m) M += v
    this.M = M
    const n = this.n
    this.Qx = new Float64Array(n)
    this.Qy = new Float64Array(n)
    this.Px = new Float64Array(n)
    this.Py = new Float64Array(n)
    const x0 = bary[0].x
    const y0 = bary[0].y
    for (let i = 1; i < n; i++) {
      this.Qx[i] = bary[i].x - x0
      this.Qy[i] = bary[i].y - y0
      this.Px[i] = this.m[i] * bary[i].vx
      this.Py[i] = this.m[i] * bary[i].vy
    }
  }

  /** Linear "Sun" drift: every heliocentric position shifts by h·(ΣP)/m₀. */
  private driftSun(h: number): void {
    let sx = 0
    let sy = 0
    for (let i = 1; i < this.n; i++) { sx += this.Px[i]; sy += this.Py[i] }
    const fx = (h * sx) / this.m0
    const fy = (h * sy) / this.m0
    for (let i = 1; i < this.n; i++) { this.Qx[i] += fx; this.Qy[i] += fy }
  }

  /** Planet–planet interaction kick: Pᵢ += h·Σ_{j≠i} G mᵢmⱼ (Qⱼ−Qᵢ)/|·|³. */
  private kick(h: number): void {
    const { n, m, G, Qx, Qy, Px, Py } = this
    for (let i = 1; i < n; i++) {
      let ax = 0
      let ay = 0
      const xi = Qx[i]
      const yi = Qy[i]
      for (let j = 1; j < n; j++) {
        if (j === i) continue
        const dx = Qx[j] - xi
        const dy = Qy[j] - yi
        const d2 = dx * dx + dy * dy
        const inv = 1 / (d2 * Math.sqrt(d2))
        const s = G * m[i] * m[j] * inv
        ax += s * dx
        ay += s * dy
      }
      Px[i] += h * ax
      Py[i] += h * ay
    }
  }

  /** Exact Kepler drift: each planet advances analytically about the star (μ = G m₀). */
  private driftKepler(h: number): void {
    const mu = this.G * this.m0
    for (let i = 1; i < this.n; i++) {
      const mi = this.m[i]
      const s = keplerStep(
        { r: { x: this.Qx[i], y: this.Qy[i] }, v: { x: this.Px[i] / mi, y: this.Py[i] / mi } },
        mu,
        h,
      )
      this.Qx[i] = s.r.x
      this.Qy[i] = s.r.y
      this.Px[i] = mi * s.v.x
      this.Py[i] = mi * s.v.y
    }
  }

  /** One symmetric 2nd-order Wisdom–Holman step of length τ. */
  private step2(tau: number): void {
    const h = 0.5 * tau
    this.driftSun(h)
    this.kick(h)
    this.driftKepler(tau)
    this.kick(h)
    this.driftSun(h)
  }

  // Yoshida 4th-order triple-jump weights (Forest–Ruth), reusing step2 as the base map.
  private static readonly W1 = 1 / (2 - Math.cbrt(2))
  private static readonly W0 = 1 - 2 * WisdomHolman.W1

  /** Advance by `tau` using a 2nd- or 4th-order Wisdom–Holman composition. */
  step(tau: number, order: WHOrder = 2): void {
    if (order === 4) {
      this.step2(WisdomHolman.W1 * tau)
      this.step2(WisdomHolman.W0 * tau)
      this.step2(WisdomHolman.W1 * tau)
    } else {
      this.step2(tau)
    }
  }

  /** Reconstruct inertial (barycentre-frame) bodies from the current DH state. */
  toInertial(): Body[] {
    const { n, m, Qx, Qy, Px, Py } = this
    // x₀ = −Σ_{i≥1} mᵢQᵢ / M (barycentre at the origin); v₀ = −Σ Pᵢ / m₀.
    let mqx = 0
    let mqy = 0
    let spx = 0
    let spy = 0
    for (let i = 1; i < n; i++) {
      mqx += m[i] * Qx[i]
      mqy += m[i] * Qy[i]
      spx += Px[i]
      spy += Py[i]
    }
    const x0 = -mqx / this.M
    const y0 = -mqy / this.M
    const out: Body[] = [
      { m: m[0], x: x0, y: y0, vx: -spx / this.m0, vy: -spy / this.m0 },
    ]
    for (let i = 1; i < n; i++) {
      out.push({ m: m[i], x: x0 + Qx[i], y: y0 + Qy[i], vx: Px[i] / m[i], vy: Py[i] / m[i] })
    }
    return out
  }

  energy(): number {
    return totalEnergy(this.toInertial(), this.G)
  }
}

// ---------------------------------------------------------------------------
// Brute-force reference integrators (exact pairwise forces, no softening) —
// the head-to-head opponents WH is measured against. Kept self-contained so the
// Symplectic Lab compares apples to apples on the very same Hamiltonian.
// ---------------------------------------------------------------------------

function accelerations(bodies: Body[], G: number): { ax: Float64Array; ay: Float64Array } {
  const n = bodies.length
  const ax = new Float64Array(n)
  const ay = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const bi = bodies[i]
    let axi = 0
    let ayi = 0
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      const bj = bodies[j]
      const dx = bj.x - bi.x
      const dy = bj.y - bi.y
      const d2 = dx * dx + dy * dy
      const inv = 1 / (d2 * Math.sqrt(d2))
      const s = G * bj.m * inv
      axi += s * dx
      ayi += s * dy
    }
    ax[i] = axi
    ay[i] = ayi
  }
  return { ax, ay }
}

/** In-place velocity-Verlet (kick–drift–kick) step over the inertial bodies. */
export function verletStep(bodies: Body[], G: number, dt: number): void {
  const n = bodies.length
  let { ax, ay } = accelerations(bodies, G)
  const h = 0.5 * dt
  for (let i = 0; i < n; i++) {
    bodies[i].vx += ax[i] * h
    bodies[i].vy += ay[i] * h
    bodies[i].x += bodies[i].vx * dt
    bodies[i].y += bodies[i].vy * dt
  }
  ;({ ax, ay } = accelerations(bodies, G))
  for (let i = 0; i < n; i++) {
    bodies[i].vx += ax[i] * h
    bodies[i].vy += ay[i] * h
  }
}

/** In-place classical RK4 step (4th order, NOT symplectic — for the contrast). */
export function rk4Step(bodies: Body[], G: number, dt: number): void {
  const n = bodies.length
  const state = (b: Body[]) => b
  const k1 = accelerations(bodies, G)
  const v1x = bodies.map((b) => b.vx)
  const v1y = bodies.map((b) => b.vy)

  const stage = (h: number, vx: number[], vy: number[], a: { ax: Float64Array; ay: Float64Array }) =>
    bodies.map((b, i) => ({ m: b.m, x: b.x + vx[i] * h, y: b.y + vy[i] * h, vx: b.vx + a.ax[i] * h, vy: b.vy + a.ay[i] * h }))

  const s2 = stage(0.5 * dt, v1x, v1y, k1)
  const k2 = accelerations(s2, G)
  const v2x = s2.map((b) => b.vx)
  const v2y = s2.map((b) => b.vy)

  const s3 = stage(0.5 * dt, v2x, v2y, k2)
  const k3 = accelerations(s3, G)
  const v3x = s3.map((b) => b.vx)
  const v3y = s3.map((b) => b.vy)

  const s4 = stage(dt, v3x, v3y, k3)
  const k4 = accelerations(s4, G)
  const v4x = s4.map((b) => b.vx)
  const v4y = s4.map((b) => b.vy)

  const sixth = dt / 6
  const b = state(bodies)
  for (let i = 0; i < n; i++) {
    b[i].x += sixth * (v1x[i] + 2 * v2x[i] + 2 * v3x[i] + v4x[i])
    b[i].y += sixth * (v1y[i] + 2 * v2y[i] + 2 * v3y[i] + v4y[i])
    b[i].vx += sixth * (k1.ax[i] + 2 * k2.ax[i] + 2 * k3.ax[i] + k4.ax[i])
    b[i].vy += sixth * (k1.ay[i] + 2 * k2.ay[i] + 2 * k3.ay[i] + k4.ay[i])
  }
}

// ---------------------------------------------------------------------------
// Comparison harness used by the Symplectic Lab.
// ---------------------------------------------------------------------------

export type MethodId = 'wh2' | 'wh4' | 'verlet' | 'rk4'

export interface MethodTrace {
  id: MethodId
  label: string
  symplectic: boolean
  /** Sampled |ΔE/E₀| over time (one entry per output sample). */
  energyErr: number[]
  /** Worst |ΔE/E₀| over the whole run. */
  maxEnergyErr: number
  /** Per-body trajectories in the inertial frame: [x0,y0,x1,y1,…] per body. */
  paths: Float64Array[]
  /** Wall-clock milliseconds to integrate (rough; for the speed story). */
  ms: number
}

export interface SimConfig {
  bodies: Body[]
  G: number
  dt: number
  /** Total integrated time. */
  duration: number
  /** Number of (x,y) samples to record per body for plotting. */
  samples: number
  methods: MethodId[]
}

export interface SimResult {
  traces: MethodTrace[]
  /** Sample times, shared across methods. */
  times: number[]
  /** Reference orbital period of the innermost planet (for context). */
  innerPeriod: number
}

const METHOD_LABEL: Record<MethodId, string> = {
  wh2: 'Wisdom–Holman (2nd)',
  wh4: 'Wisdom–Holman (4th)',
  verlet: 'Velocity Verlet',
  rk4: 'Runge–Kutta 4',
}
const METHOD_SYMPLECTIC: Record<MethodId, boolean> = { wh2: true, wh4: true, verlet: true, rk4: false }

/**
 * Integrate the same system with several methods at the same step size and
 * record their energy error and trajectories. This is the lab's core experiment:
 * at a deliberately coarse Δt, WH stays flat while Verlet ripples (bounded) and
 * RK4 drifts (secular) — the textbook demonstration of symplectic integration.
 */
export function runComparison(cfg: SimConfig): SimResult {
  const { G, dt, duration, samples } = cfg
  const nSteps = Math.max(1, Math.round(duration / dt))
  const sampleEvery = Math.max(1, Math.floor(nSteps / samples))
  const bary = toBarycentric(cfg.bodies)
  const E0 = totalEnergy(bary, G)
  const nBodies = bary.length

  // Inner planet period (body 1 assumed innermost) for labelling.
  const star = bary[0]
  let innerPeriod = NaN
  if (nBodies > 1) {
    const p = bary[1]
    const r = Math.hypot(p.x - star.x, p.y - star.y)
    const mu = G * (star.m + p.m)
    innerPeriod = 2 * Math.PI * Math.sqrt((r * r * r) / mu)
  }

  const times: number[] = []
  const traces: MethodTrace[] = []

  for (const id of cfg.methods) {
    const energyErr: number[] = []
    const paths: Float64Array[] = Array.from({ length: nBodies }, () => new Float64Array((Math.floor(nSteps / sampleEvery) + 2) * 2))
    let sIdx = 0
    let maxErr = 0
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now())

    const record = (bodies: Body[], t: number) => {
      const e = totalEnergy(bodies, G)
      const rel = E0 !== 0 ? Math.abs((e - E0) / E0) : Math.abs(e)
      if (rel > maxErr) maxErr = rel
      energyErr.push(rel)
      for (let b = 0; b < nBodies; b++) {
        paths[b][sIdx * 2] = bodies[b].x
        paths[b][sIdx * 2 + 1] = bodies[b].y
      }
      if (id === cfg.methods[0]) times.push(t)
      sIdx++
    }

    if (id === 'wh2' || id === 'wh4') {
      const wh = new WisdomHolman(bary, G)
      const order: WHOrder = id === 'wh4' ? 4 : 2
      record(wh.toInertial(), 0)
      for (let step = 1; step <= nSteps; step++) {
        wh.step(dt, order)
        if (step % sampleEvery === 0) record(wh.toInertial(), step * dt)
      }
    } else {
      const bodies = cloneBodies(bary)
      record(bodies, 0)
      for (let step = 1; step <= nSteps; step++) {
        if (id === 'verlet') verletStep(bodies, G, dt)
        else rk4Step(bodies, G, dt)
        if (step % sampleEvery === 0) record(bodies, step * dt)
      }
    }

    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0
    traces.push({
      id,
      label: METHOD_LABEL[id],
      symplectic: METHOD_SYMPLECTIC[id],
      energyErr,
      maxEnergyErr: maxErr,
      paths: paths.map((p) => p.subarray(0, sIdx * 2)),
      ms,
    })
  }

  return { traces, times, innerPeriod }
}

// ---------------------------------------------------------------------------
// Planetary-system presets for the lab.
// ---------------------------------------------------------------------------

export interface LabPreset {
  id: string
  label: string
  description: string
  G: number
  /** Suggested coarse step for the head-to-head (where WH shines, Verlet ripples). */
  dt: number
  /** Suggested integration span. */
  duration: number
  build: () => Body[]
}

/** A planet on a circular orbit of radius `a` about a star at the origin (CCW). */
function planet(starMass: number, m: number, a: number, G: number, phase = 0): Body {
  const mu = G * (starMass + m)
  const v = Math.sqrt(mu / a)
  return { m, x: a * Math.cos(phase), y: a * Math.sin(phase), vx: -v * Math.sin(phase), vy: v * Math.cos(phase) }
}

/** A planet on an eccentric orbit launched from periapsis along +x. */
function eccentricPlanet(starMass: number, m: number, a: number, e: number, G: number): Body {
  const mu = G * (starMass + m)
  const rp = a * (1 - e)
  const vp = Math.sqrt((mu / a) * ((1 + e) / (1 - e)))
  return { m, x: rp, y: 0, vx: 0, vy: vp }
}

export const LAB_PRESETS: LabPreset[] = [
  {
    id: 'inner-system',
    label: 'Four inner planets',
    description:
      'A Sun with four well-separated near-circular planets — the canonical near-Keplerian system where Wisdom–Holman is at its best.',
    G: 1,
    dt: 0.35,
    duration: 900,
    build: () => {
      const G = 1
      const star = 1
      return [
        { m: star, x: 0, y: 0, vx: 0, vy: 0 },
        planet(star, 3e-6, 1.0, G, 0),
        planet(star, 9e-6, 1.7, G, 1.1),
        planet(star, 4e-6, 2.6, G, 2.3),
        planet(star, 1.2e-5, 3.9, G, 4.0),
      ]
    },
  },
  {
    id: 'resonant-pair',
    label: '2:1 resonant pair',
    description:
      'Two Jupiter-mass planets near a 2:1 mean-motion resonance — strong mutual perturbations, yet WH still keeps energy bounded where Verlet visibly ripples.',
    G: 1,
    dt: 0.3,
    duration: 700,
    build: () => {
      const G = 1
      const star = 1
      return [
        { m: star, x: 0, y: 0, vx: 0, vy: 0 },
        planet(star, 1e-3, 1.0, G, 0),
        planet(star, 1e-3, 1.587, G, Math.PI), // a≈2^(2/3) ⇒ period ratio ≈ 2:1
      ]
    },
  },
  {
    id: 'eccentric',
    label: 'Eccentric comet + planet',
    description:
      'A massive planet on a near-circular orbit and a light body on an e=0.6 ellipse — the eccentric orbit stress-tests the universal-variable Kepler drift across its fast periapsis passage.',
    G: 1,
    dt: 0.25,
    duration: 600,
    build: () => {
      const G = 1
      const star = 1
      return [
        { m: star, x: 0, y: 0, vx: 0, vy: 0 },
        planet(star, 1e-3, 2.2, G, 0),
        eccentricPlanet(star, 1e-6, 1.4, 0.6, G),
      ]
    },
  },
]

export function presetById(id: string): LabPreset {
  return LAB_PRESETS.find((p) => p.id === id) ?? LAB_PRESETS[0]
}
