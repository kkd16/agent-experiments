// The MERCURY hybrid symplectic integrator (Chambers 1999) — a Wisdom–Holman map
// that survives close encounters between massive bodies.
//
// WHY PLAIN WISDOM–HOLMAN BREAKS DURING A CLOSE ENCOUNTER
// ------------------------------------------------------
// WH (see `whfast.ts`) splits H = H_Kepler + H_interaction + H_Sun and integrates the
// dominant Keplerian part EXACTLY, treating the planet–planet interaction as a small
// perturbation applied as a single impulsive "kick" once per step. That is only valid
// while the interaction really *is* small. When two planets pass close, the 1/r term
// blows up: the kick over a fixed Δt approximates a nearly-singular force by one
// impulse and the energy error spikes catastrophically — the whole reason a naive
// symplectic map cannot be used for planetary systems that scatter.
//
// THE HYBRID FIX (Chambers 1999, "A hybrid symplectic integrator that permits close
// encounters between massive bodies")
// -----------------------------------------------------------------------------------
// Split each planet–planet term with a smooth **changeover** K(r) that is 1 when the
// bodies are far apart and 0 when they are close:
//
//   H_interaction = − Σ_{i<j} G mᵢmⱼ K(rᵢⱼ)/rᵢⱼ        ← the symplectic KICK (far field)
//   H_close       = − Σ_{i<j} G mᵢmⱼ (1−K(rᵢⱼ))/rᵢⱼ    ← folded INTO the Kepler drift
//
// The far-field remainder stays an ordinary WH kick. The near-field remainder is moved
// into the "drift" sub-map, which is then no longer a clean set of independent Kepler
// orbits, so it is advanced by a high-accuracy **Bulirsch–Stoer** integrator (a
// Gragg–Bulirsch–Stoer modified-midpoint + polynomial extrapolation). Because the two
// pieces partition the *same* pair force exactly — the kick force and the drift's pair
// force sum, at every r, to the full −Gmᵢmⱼ/r³ gradient — the composition reproduces
// the true dynamics. Far from any encounter K≡1, the close term vanishes, and the map
// is *identical* to Wisdom–Holman (machine-exact Kepler drifts, bounded energy). Only
// when bodies come within a few Hill radii does the BS drift switch on, and it resolves
// the encounter to full accuracy while the surrounding structure stays symplectic.
//
// This is the algorithm behind MERCURY (Chambers), the workhorse of Solar-System
// formation and scattering studies. Everything here is hand-written TypeScript.

import { keplerStep } from './kepler'
import type { Body } from './whfast'
import { toBarycentric, totalEnergy } from './whfast'

// ---------------------------------------------------------------------------
// The changeover function K(r) (Chambers 1999, eqs. 15–17).
//
// A dimensionless variable y = (r/r_crit − 0.1)/0.9 maps the shell
// [0.1·r_crit, r_crit] onto [0, 1]. Outside that shell K is a flat 0 (fully close)
// or 1 (fully far). On the shell K(y) = y²/(2y² − 2y + 1): a rational S-curve with
// K(0)=0, K(1)=1 and — crucially — K'(0)=K'(1)=0, so BOTH K and its first derivative
// are continuous everywhere. Continuity of K' is what keeps the *force* (which
// depends on dK/dr) continuous, so neither sub-map ever sees a kink.
// ---------------------------------------------------------------------------

/** The Chambers changeover K(r) ∈ [0,1]: 0 when the pair is close, 1 when far. */
export function changeover(r: number, rcrit: number): number {
  const y = (r / rcrit - 0.1) / 0.9
  if (y <= 0) return 0
  if (y >= 1) return 1
  return (y * y) / (2 * y * y - 2 * y + 1)
}

/** K(r) together with its radial derivative dK/dr — the force partition needs both. */
export function changeoverAndDeriv(r: number, rcrit: number): { K: number; dKdr: number } {
  const y = (r / rcrit - 0.1) / 0.9
  if (y <= 0) return { K: 0, dKdr: 0 }
  if (y >= 1) return { K: 1, dKdr: 0 }
  const den = 2 * y * y - 2 * y + 1
  const K = (y * y) / den
  // dK/dy = [2y·den − y²·(4y−2)] / den²
  const dKdy = (2 * y * den - y * y * (4 * y - 2)) / (den * den)
  const dKdr = dKdy / (0.9 * rcrit) // chain rule: dy/dr = 1/(0.9 r_crit)
  return { K, dKdr }
}

// ---------------------------------------------------------------------------
// A self-contained Gragg–Bulirsch–Stoer integrator for an autonomous first-order
// system y' = f(y). Used for the hybrid's "close" drift sub-map. It advances a
// macro-step of length H by taking the modified-midpoint method with an increasing
// sequence of substep counts and extrapolating the result to zero step size; if the
// extrapolation error exceeds the tolerance it bisects the interval and recurses.
// ---------------------------------------------------------------------------

export type Deriv = (y: Float64Array, out: Float64Array) => void

/** Modified midpoint: advance y0 across `htot` in `nstep` substeps into `out`. */
function modifiedMidpoint(
  y0: Float64Array,
  dydt0: Float64Array,
  htot: number,
  nstep: number,
  deriv: Deriv,
  out: Float64Array,
  scratch: { ym: Float64Array; yn: Float64Array; d: Float64Array },
): void {
  const dim = y0.length
  const h = htot / nstep
  const { ym, yn, d } = scratch
  for (let i = 0; i < dim; i++) {
    ym[i] = y0[i]
    yn[i] = y0[i] + h * dydt0[i]
  }
  deriv(yn, d)
  const h2 = 2 * h
  for (let n = 2; n <= nstep; n++) {
    for (let i = 0; i < dim; i++) {
      const swap = ym[i] + h2 * d[i]
      ym[i] = yn[i]
      yn[i] = swap
    }
    deriv(yn, d)
  }
  for (let i = 0; i < dim; i++) out[i] = 0.5 * (ym[i] + yn[i] + h * d[i])
}

/** Bookkeeping for the recursive BS driver so we can report the substep budget. */
export interface BSStats {
  steps: number // accepted macro-steps
  rejections: number // bisections forced by the error test
  derivEvals: number
}

// The classic GBS substep sequence n = 2,4,6,8,… (each mmid call uses one of these).
const BS_SEQ = [2, 4, 6, 8, 10, 12, 14, 16]

/**
 * Integrate y' = f(y) from the current `y` across `H` in place, to a mixed
 * absolute/relative tolerance `tol`. Returns nothing; mutates `y`.
 */
export function bulirschStoer(
  y: Float64Array,
  deriv: Deriv,
  H: number,
  tol: number,
  stats: BSStats,
): void {
  const dim = y.length
  const dydt0 = new Float64Array(dim)
  const scratch = { ym: new Float64Array(dim), yn: new Float64Array(dim), d: new Float64Array(dim) }
  // Extrapolation tableau: one candidate vector per sequence entry + its x = (H/n)².
  const cand: Float64Array[] = BS_SEQ.map(() => new Float64Array(dim))
  const xs = new Float64Array(BS_SEQ.length)
  // Neville tableau reused across a macro-step.
  const P: Float64Array[] = BS_SEQ.map(() => new Float64Array(dim))
  const prevExtrap = new Float64Array(dim)

  // Try a single macro-step of length h; returns true and writes into `yout` on success.
  const tryStep = (y0: Float64Array, h: number, yout: Float64Array): boolean => {
    deriv(y0, dydt0)
    stats.derivEvals++
    for (let k = 0; k < BS_SEQ.length; k++) {
      modifiedMidpoint(y0, dydt0, h, BS_SEQ[k], deriv, cand[k], scratch)
      stats.derivEvals += BS_SEQ[k]
      xs[k] = (h / BS_SEQ[k]) ** 2
      // Neville extrapolation of the k+1 candidates to x = 0. The tableau P must be
      // re-seeded from the raw candidates each pass (the previous pass reduced it).
      for (let idx = 0; idx <= k; idx++) P[idx].set(cand[idx])
      for (let m = 1; m <= k; m++) {
        for (let idx = 0; idx <= k - m; idx++) {
          const x0 = xs[idx]
          const x1 = xs[idx + m]
          const inv = 1 / (x0 - x1)
          const a = P[idx]
          const b = P[idx + 1]
          for (let i = 0; i < dim; i++) a[i] = (-x1 * a[i] + x0 * b[i]) * inv
        }
      }
      const extrap = P[0] // extrapolant using points 0..k, at x=0
      if (k >= 2) {
        // Error = change from the previous (lower-order) extrapolant.
        let err = 0
        for (let i = 0; i < dim; i++) {
          const scale = tol * (1 + Math.abs(y0[i]))
          const e = Math.abs(extrap[i] - prevExtrap[i]) / scale
          if (e > err) err = e
        }
        if (err < 1) {
          yout.set(extrap)
          return true
        }
      }
      prevExtrap.set(extrap)
    }
    return false
  }

  // Recursive bisection driver: integrate `h` from y0, subdividing on failure.
  const drive = (y0: Float64Array, h: number, depth: number): void => {
    const yout = new Float64Array(dim)
    if (depth < 42 && tryStep(y0, h, yout)) {
      y0.set(yout)
      stats.steps++
      return
    }
    if (depth >= 42) {
      // Give up subdividing — accept the best extrapolant to avoid an infinite recursion.
      tryStep(y0, h, yout)
      y0.set(yout)
      stats.steps++
      stats.rejections++
      return
    }
    stats.rejections++
    const half = h / 2
    drive(y0, half, depth + 1)
    drive(y0, half, depth + 1)
  }

  drive(y, H, 0)
}

// ---------------------------------------------------------------------------
// The hybrid integrator itself — same democratic-heliocentric state as
// WisdomHolman, but with the changeover-partitioned kick and a BS "close" drift.
// ---------------------------------------------------------------------------

export interface HybridOptions {
  /** Bulirsch–Stoer relative/absolute tolerance for the close drift. Default 1e-13. */
  bsTol?: number
  /** r_crit as a multiple of the pair's mutual Hill radius. Default 3. */
  nHill?: number
}

export interface StepInfo {
  /** Did this step use the Bulirsch–Stoer close drift (an encounter was active)? */
  usedBS: boolean
  /** The smallest planet–planet separation seen at the step boundaries. */
  minSep: number
}

export class HybridSymplectic {
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
  private readonly bsTol: number
  private readonly nHill: number
  readonly bsStats: BSStats = { steps: 0, rejections: 0, derivEvals: 0 }

  /** Smallest planet–planet separation seen over the whole run so far. */
  minSeparation = Infinity
  /** How many steps triggered the BS close drift. */
  bsSteps = 0

  constructor(bodies: Body[], G: number, opts: HybridOptions = {}) {
    this.G = G
    this.n = bodies.length
    this.bsTol = opts.bsTol ?? 1e-13
    this.nHill = opts.nHill ?? 3
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

  /**
   * Critical radius for the pair (i, j): a few mutual Hill radii — the scale on which
   * the star stops dominating the pair's relative motion. Whether the coarse step can
   * actually resolve an approach on this scale is handled separately, by the
   * closest-approach prediction in `encounterActive` (so a fast fly-by is never
   * stepped over, yet distant non-encountering planets never trip the BS drift).
   */
  private rcrit(i: number, j: number): number {
    const ai = Math.hypot(this.Qx[i], this.Qy[i]) || 1e-12
    const aj = Math.hypot(this.Qx[j], this.Qy[j]) || 1e-12
    const hillI = ai * Math.cbrt(this.m[i] / (3 * this.m0))
    const hillJ = aj * Math.cbrt(this.m[j] / (3 * this.m0))
    return this.nHill * (hillI + hillJ) + 1e-9
  }

  /** Linear "Sun" drift: every heliocentric position shifts by h·(ΣP)/m₀. */
  private driftSun(h: number): void {
    let sx = 0
    let sy = 0
    for (let i = 1; i < this.n; i++) {
      sx += this.Px[i]
      sy += this.Py[i]
    }
    const fx = (h * sx) / this.m0
    const fy = (h * sy) / this.m0
    for (let i = 1; i < this.n; i++) {
      this.Qx[i] += fx
      this.Qy[i] += fy
    }
  }

  /**
   * The changeover-weighted interaction kick (far field). For each pair the impulse
   * uses the K-weighted force, whose coefficient is G·mⱼ·(K'/r − K/r²)/r. Far apart
   * (K=1, K'=0) this reduces to the ordinary −Gmⱼ/r³ interaction of Wisdom–Holman;
   * during a close pass (K→0) it fades to nothing, leaving the encounter to the drift.
   */
  private kick(h: number): void {
    const { n, m, G, Qx, Qy, Px, Py } = this
    const ax = new Float64Array(n)
    const ay = new Float64Array(n)
    for (let i = 1; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = Qx[i] - Qx[j]
        const dy = Qy[i] - Qy[j]
        const r = Math.hypot(dx, dy)
        if (r === 0) continue
        const rc = this.rcrit(i, j)
        const { K, dKdr } = changeoverAndDeriv(r, rc)
        // coefficient c such that a_kick_i = c · (Q_i − Q_j), a_kick_j = −c · (…)·(m_i/m_j swap)
        const coeff = G * (dKdr / r - K / (r * r)) / r
        ax[i] += coeff * m[j] * dx
        ay[i] += coeff * m[j] * dy
        ax[j] -= coeff * m[i] * dx
        ay[j] -= coeff * m[i] * dy
      }
    }
    for (let i = 1; i < n; i++) {
      Px[i] += h * m[i] * ax[i]
      Py[i] += h * m[i] * ay[i]
    }
  }

  /** Analytic Kepler drift (no encounter active): each planet advances exactly. */
  private driftKeplerExact(h: number): void {
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

  /**
   * The "close" drift: the Kepler term about the star PLUS the (1−K)-weighted pair
   * forces, integrated together by Bulirsch–Stoer. State layout is (Qx,Qy,Vx,Vy) per
   * planet, with V = P/m the heliocentric velocity conjugate to Q in H_drift.
   */
  private driftClose(h: number): void {
    const P = this.n - 1
    const dim = 4 * P
    const y = new Float64Array(dim)
    for (let p = 0; p < P; p++) {
      const i = p + 1
      y[4 * p] = this.Qx[i]
      y[4 * p + 1] = this.Qy[i]
      y[4 * p + 2] = this.Px[i] / this.m[i]
      y[4 * p + 3] = this.Py[i] / this.m[i]
    }
    const mu = this.G * this.m0
    const G = this.G
    const m = this.m
    // Precompute r_crit per pair (held fixed across the macro-step, like MERCURY).
    const rc: number[][] = []
    for (let i = 1; i < this.n; i++) {
      rc[i] = []
      for (let j = i + 1; j < this.n; j++) rc[i][j] = this.rcrit(i, j)
    }
    const deriv: Deriv = (yv, out) => {
      for (let p = 0; p < P; p++) {
        const qx = yv[4 * p]
        const qy = yv[4 * p + 1]
        const vx = yv[4 * p + 2]
        const vy = yv[4 * p + 3]
        const r = Math.hypot(qx, qy) || 1e-15
        const inv3 = 1 / (r * r * r)
        out[4 * p] = vx
        out[4 * p + 1] = vy
        out[4 * p + 2] = -mu * qx * inv3 // Kepler acceleration about the star
        out[4 * p + 3] = -mu * qy * inv3
      }
      // (1−K)-weighted planet–planet pair accelerations.
      for (let pi = 0; pi < P; pi++) {
        const i = pi + 1
        for (let pj = pi + 1; pj < P; pj++) {
          const j = pj + 1
          const dx = yv[4 * pi] - yv[4 * pj]
          const dy = yv[4 * pi + 1] - yv[4 * pj + 1]
          const r = Math.hypot(dx, dy)
          if (r === 0) continue
          const { K, dKdr } = changeoverAndDeriv(r, rc[i][j])
          // a_drift_i = G·mⱼ·[ −(1−K)/r³ − K'/r² ]·(Q_i − Q_j)
          const coeff = G * (-(1 - K) / (r * r * r) - dKdr / (r * r))
          out[4 * pi + 2] += coeff * m[j] * dx
          out[4 * pi + 3] += coeff * m[j] * dy
          out[4 * pj + 2] -= coeff * m[i] * dx
          out[4 * pj + 3] -= coeff * m[i] * dy
        }
      }
    }
    bulirschStoer(y, deriv, h, this.bsTol, this.bsStats)
    for (let p = 0; p < P; p++) {
      const i = p + 1
      this.Qx[i] = y[4 * p]
      this.Qy[i] = y[4 * p + 1]
      this.Px[i] = this.m[i] * y[4 * p + 2]
      this.Py[i] = this.m[i] * y[4 * p + 3]
    }
  }

  /**
   * Is any pair within — or, along a straight-line prediction over this step, about to
   * enter — its changeover shell? Uses the exact closest approach of the relative
   * position + velocity over t ∈ [0, τ], so a fast fly-by that would clear its Hill
   * shell inside a single coarse step is still caught and handed to the BS drift.
   */
  private encounterActive(tau: number): { active: boolean; minSep: number } {
    let minSep = Infinity
    let active = false
    for (let i = 1; i < this.n; i++) {
      for (let j = i + 1; j < this.n; j++) {
        const dx = this.Qx[i] - this.Qx[j]
        const dy = this.Qy[i] - this.Qy[j]
        const r = Math.hypot(dx, dy)
        if (r < minSep) minSep = r
        const rc = this.rcrit(i, j)
        const rvx = this.Px[i] / this.m[i] - this.Px[j] / this.m[j]
        const rvy = this.Py[i] / this.m[i] - this.Py[j] / this.m[j]
        const v2 = rvx * rvx + rvy * rvy
        // Time of closest approach along the linear prediction, clamped to the step.
        let tc = 0
        if (v2 > 0) tc = Math.max(0, Math.min(Math.abs(tau), -(dx * rvx + dy * rvy) / v2))
        const cx = dx + rvx * tc
        const cy = dy + rvy * tc
        const dmin = Math.hypot(cx, cy)
        if (r < rc || dmin < rc) active = true
      }
    }
    return { active, minSep }
  }

  /** One symmetric 2nd-order hybrid step of length τ. */
  private step2(tau: number): StepInfo {
    const { active, minSep } = this.encounterActive(tau)
    if (minSep < this.minSeparation) this.minSeparation = minSep
    const h = 0.5 * tau
    this.driftSun(h)
    this.kick(h)
    if (active) {
      this.driftClose(tau)
      this.bsSteps++
    } else {
      this.driftKeplerExact(tau)
    }
    this.kick(h)
    this.driftSun(h)
    return { usedBS: active, minSep }
  }

  private static readonly W1 = 1 / (2 - Math.cbrt(2))
  private static readonly W0 = 1 - 2 * HybridSymplectic.W1

  /** Advance by τ using a 2nd- or 4th-order (Yoshida) composition. */
  step(tau: number, order: 2 | 4 = 2): StepInfo {
    if (order === 4) {
      const a = this.step2(HybridSymplectic.W1 * tau)
      const b = this.step2(HybridSymplectic.W0 * tau)
      const c = this.step2(HybridSymplectic.W1 * tau)
      return { usedBS: a.usedBS || b.usedBS || c.usedBS, minSep: Math.min(a.minSep, b.minSep, c.minSep) }
    }
    return this.step2(tau)
  }

  /** Reconstruct inertial (barycentre-frame) bodies from the current DH state. */
  toInertial(): Body[] {
    const { n, m, Qx, Qy, Px, Py } = this
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
    const out: Body[] = [{ m: m[0], x: x0, y: y0, vx: -spx / this.m0, vy: -spy / this.m0 }]
    for (let i = 1; i < n; i++) {
      out.push({ m: m[i], x: x0 + Qx[i], y: y0 + Qy[i], vx: Px[i] / m[i], vy: Py[i] / m[i] })
    }
    return out
  }

  energy(): number {
    return totalEnergy(this.toInertial(), this.G)
  }
}
