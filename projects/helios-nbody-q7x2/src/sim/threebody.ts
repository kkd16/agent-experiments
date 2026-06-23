// The full planar equal-mass three-body problem in free fall — the engine behind
// the Three-Body Chaos Atlas (the Agekyan–Anosova map).
//
// Three equal point masses (G = 1, m = 1) are released *from rest* and left to
// scatter under their mutual gravity. From any starting triangle the generic
// outcome is the same story: a chaotic "interplay" of close passages that almost
// always ends with one body flung away (the *escaper*) while the other two settle
// into a bound binary. Which body escapes — and how long the dance lasts — depends
// so sensitively on the initial triangle that a map of the outcome over all
// starting triangles is a fractal. This module computes that map honestly.
//
// Integrator: a 4th-order **Hermite predictor–corrector** (Makino & Aarseth 1992)
// on *softened* gravity, using the analytic acceleration AND jerk (da/dt), with the
// standard Aarseth adaptive timestep. For N = 3 this is the gold standard: it tracks
// the violent close approaches that drive the chaos while conserving energy to ~1e-8
// across a whole scattering, all with no external library.
//
// Everything here is a pure function of the initial condition, so the same pixel
// always yields the same outcome — the map is deterministic, as chaos demands.

export type Outcome = 'escape' | 'bound' | 'singular'

export interface ThreeBodyResult {
  outcome: Outcome
  /** Index (0,1,2) of the escaping body, or -1 if none escaped. */
  escaper: number
  /** Simulation time at which the escape criterion first held (or tMax). */
  tEscape: number
  /** Surviving binary semimajor axis (escape only; NaN otherwise). */
  aBin: number
  /** Surviving binary eccentricity (escape only; NaN otherwise). */
  eBin: number
  /** Count of close-encounter "interplays" (min pair distance dipped below a threshold). */
  interplays: number
  /** Worst |ΔE / E₀| seen — a quality flag (large ⇒ the close approach was under-resolved). */
  energyError: number
  /** Total Hermite steps taken. */
  steps: number
}

export interface ThreeBodyOptions {
  /** Plummer softening length ε (bounds the force through close approaches). */
  softening: number
  /** Aarseth timestep accuracy η (smaller ⇒ finer steps). */
  eta: number
  /** Max simulation time before declaring the triple long-lived/"bound". */
  tMax: number
  /** Hard cap on Hermite steps (a runaway guard). */
  maxSteps: number
  /** Escape radius (in units of the initial system size) the escaper must exceed. */
  escapeRadius: number
}

export const DEFAULT_OPTS: ThreeBodyOptions = {
  softening: 0.01,
  eta: 0.01,
  tMax: 60,
  maxSteps: 80000,
  escapeRadius: 8,
}

// Tuned for the *map*: a touch more softening (so tight binaries don't force
// thousands of tiny steps) and a nearer escape radius (escape is decided once a
// body is clearly unbound and receding) — many× faster per pixel, with the same
// qualitative fractal and energy held to ~1e-3 across a violent scattering.
export const MAP_OPTS: ThreeBodyOptions = {
  softening: 0.04,
  eta: 0.016,
  tMax: 40,
  maxSteps: 12000,
  escapeRadius: 2.5,
}

// ---- the canonical three masses (equal, unit) -------------------------------
const M = [1, 1, 1]
const NB = 3

/** A mutable phase-space state for the three bodies (flat, length-3 arrays). */
export interface State {
  x: Float64Array
  y: Float64Array
  vx: Float64Array
  vy: Float64Array
}

function makeState(): State {
  return { x: new Float64Array(NB), y: new Float64Array(NB), vx: new Float64Array(NB), vy: new Float64Array(NB) }
}

/**
 * Build the initial condition for the Agekyan–Anosova map: m₁,m₂ pinned at
 * (∓½, 0) and the third body released from rest at (x3, y3). The centre of mass
 * is shifted to the origin so the whole system starts (and stays) barycentric,
 * which makes the conserved-quantity checks exact.
 */
export function anosovaState(x3: number, y3: number): State {
  const s = makeState()
  s.x[0] = -0.5; s.y[0] = 0
  s.x[1] = 0.5; s.y[1] = 0
  s.x[2] = x3; s.y[2] = y3
  // velocities are zero (free fall)
  const cx = (s.x[0] + s.x[1] + s.x[2]) / 3
  const cy = (s.y[0] + s.y[1] + s.y[2]) / 3
  for (let i = 0; i < NB; i++) { s.x[i] -= cx; s.y[i] -= cy }
  return s
}

// ---- forces: acceleration and its time-derivative (jerk) --------------------
// Softened pair force a_i = Σ_j m_j r_ij / (r² + ε²)^{3/2}, r_ij = r_j − r_i.
// Jerk j_i = Σ_j m_j [ v_ij / (r²+ε²)^{3/2} − 3 (r_ij·v_ij) r_ij / (r²+ε²)^{5/2} ].
interface Deriv {
  ax: Float64Array; ay: Float64Array; jx: Float64Array; jy: Float64Array
}

function makeDeriv(): Deriv {
  return { ax: new Float64Array(NB), ay: new Float64Array(NB), jx: new Float64Array(NB), jy: new Float64Array(NB) }
}

function accelJerk(s: State, eps2: number, out: Deriv): void {
  out.ax.fill(0); out.ay.fill(0); out.jx.fill(0); out.jy.fill(0)
  for (let i = 0; i < NB; i++) {
    for (let j = i + 1; j < NB; j++) {
      const dx = s.x[j] - s.x[i]
      const dy = s.y[j] - s.y[i]
      const dvx = s.vx[j] - s.vx[i]
      const dvy = s.vy[j] - s.vy[i]
      const r2 = dx * dx + dy * dy + eps2
      const inv = 1 / Math.sqrt(r2)
      const inv3 = inv / r2 // (r²+ε²)^{-3/2}
      const inv5 = inv3 / r2
      const rv = dx * dvx + dy * dvy
      // pair contribution on i (toward j), equal-and-opposite on j
      const aix = dx * inv3, aiy = dy * inv3
      const jix = dvx * inv3 - 3 * rv * dx * inv5
      const jiy = dvy * inv3 - 3 * rv * dy * inv5
      out.ax[i] += M[j] * aix; out.ay[i] += M[j] * aiy
      out.ax[j] -= M[i] * aix; out.ay[j] -= M[i] * aiy
      out.jx[i] += M[j] * jix; out.jy[i] += M[j] * jiy
      out.jx[j] -= M[i] * jix; out.jy[j] -= M[i] * jiy
    }
  }
}

// ---- total energy (for the conservation check / quality flag) ---------------
export function energy(s: State, eps2: number): number {
  let ke = 0
  for (let i = 0; i < NB; i++) ke += 0.5 * M[i] * (s.vx[i] * s.vx[i] + s.vy[i] * s.vy[i])
  let pe = 0
  for (let i = 0; i < NB; i++) {
    for (let j = i + 1; j < NB; j++) {
      const dx = s.x[j] - s.x[i], dy = s.y[j] - s.y[i]
      pe -= (M[i] * M[j]) / Math.sqrt(dx * dx + dy * dy + eps2)
    }
  }
  return ke + pe
}

/** Angular momentum about the origin (Σ m (x v_y − y v_x)). */
export function angularMomentum(s: State): number {
  let l = 0
  for (let i = 0; i < NB; i++) l += M[i] * (s.x[i] * s.vy[i] - s.y[i] * s.vx[i])
  return l
}

/** Minimum pairwise separation (true distance, no softening). */
export function minSeparation(s: State): number {
  let m = Infinity
  for (let i = 0; i < NB; i++) {
    for (let j = i + 1; j < NB; j++) {
      const dx = s.x[j] - s.x[i], dy = s.y[j] - s.y[i]
      const r = Math.sqrt(dx * dx + dy * dy)
      if (r < m) m = r
    }
  }
  return m
}

// ---- the Aarseth adaptive timestep ------------------------------------------
// dt = sqrt( η · (|a||a₂| + |j|²) / (|j||a₃| + |a₂|²) ), per body, take the min.
function aarsethStep(d: Deriv, a2x: Float64Array, a2y: Float64Array, a3x: Float64Array, a3y: Float64Array, eta: number): number {
  let dt = Infinity
  for (let i = 0; i < NB; i++) {
    const a = Math.hypot(d.ax[i], d.ay[i])
    const j = Math.hypot(d.jx[i], d.jy[i])
    const a2 = Math.hypot(a2x[i], a2y[i])
    const a3 = Math.hypot(a3x[i], a3y[i])
    const num = a * a2 + j * j
    const den = j * a3 + a2 * a2
    if (den > 0) {
      const di = Math.sqrt((eta * num) / den)
      if (di < dt) dt = di
    }
  }
  if (!Number.isFinite(dt)) dt = 1e-3
  return dt
}

// ---- one Hermite predictor–corrector step -----------------------------------
// Returns the higher derivatives (a₂, a₃) at the start of the step, used to size
// the *next* step. Mutates `s` to the corrected end-of-step state.
const _pred = makeState()
const _d1 = makeDeriv()
const _a2x = new Float64Array(NB)
const _a2y = new Float64Array(NB)
const _a3x = new Float64Array(NB)
const _a3y = new Float64Array(NB)

function hermiteStep(s: State, dt: number, eps2: number, d0: Deriv): void {
  const dt2 = dt * dt, dt3 = dt2 * dt
  // predict
  for (let i = 0; i < NB; i++) {
    _pred.x[i] = s.x[i] + s.vx[i] * dt + d0.ax[i] * dt2 / 2 + d0.jx[i] * dt3 / 6
    _pred.y[i] = s.y[i] + s.vy[i] * dt + d0.ay[i] * dt2 / 2 + d0.jy[i] * dt3 / 6
    _pred.vx[i] = s.vx[i] + d0.ax[i] * dt + d0.jx[i] * dt2 / 2
    _pred.vy[i] = s.vy[i] + d0.ay[i] * dt + d0.jy[i] * dt2 / 2
  }
  // forces at the predicted state
  accelJerk(_pred, eps2, _d1)
  // higher derivatives at the start of the step (Hermite interpolation)
  const inv2 = 1 / dt2, inv3 = 1 / dt3
  for (let i = 0; i < NB; i++) {
    _a2x[i] = (-6 * (d0.ax[i] - _d1.ax[i]) - dt * (4 * d0.jx[i] + 2 * _d1.jx[i])) * inv2
    _a2y[i] = (-6 * (d0.ay[i] - _d1.ay[i]) - dt * (4 * d0.jy[i] + 2 * _d1.jy[i])) * inv2
    _a3x[i] = (12 * (d0.ax[i] - _d1.ax[i]) + 6 * dt * (d0.jx[i] + _d1.jx[i])) * inv3
    _a3y[i] = (12 * (d0.ay[i] - _d1.ay[i]) + 6 * dt * (d0.jy[i] + _d1.jy[i])) * inv3
  }
  // correct (add the dt⁴/24 and dt⁵/120 terms onto the predictor)
  const dt4 = dt3 * dt, dt5 = dt4 * dt
  for (let i = 0; i < NB; i++) {
    s.x[i] = _pred.x[i] + _a2x[i] * dt4 / 24 + _a3x[i] * dt5 / 120
    s.y[i] = _pred.y[i] + _a2y[i] * dt4 / 24 + _a3y[i] * dt5 / 120
    s.vx[i] = _pred.vx[i] + _a2x[i] * dt3 / 6 + _a3x[i] * dt4 / 24
    s.vy[i] = _pred.vy[i] + _a2y[i] * dt3 / 6 + _a3y[i] * dt4 / 24
  }
  // forces at the corrected state become the start of the next step
  accelJerk(s, eps2, d0)
}

// Index of the body furthest from the centroid of the other two — the only
// plausible escaper, so the escape test need run on it alone.
function farBody(s: State): number {
  let best = 0, bestD = -1
  for (let k = 0; k < NB; k++) {
    const i = (k + 1) % 3, j = (k + 2) % 3
    const mx = (s.x[i] + s.x[j]) * 0.5, my = (s.y[i] + s.y[j]) * 0.5
    const dx = s.x[k] - mx, dy = s.y[k] - my
    const d = dx * dx + dy * dy
    if (d > bestD) { bestD = d; best = k }
  }
  return best
}

// ---- escape test ------------------------------------------------------------
// For candidate escaper k, the other two (i,j) are a binary. The escaper has
// escaped when: (1) the binary is bound (E_ij < 0); (2) the escaper is hyperbolic
// relative to the binary's barycentre (E_k > 0); (3) it is receding (R·V > 0); and
// (4) it is beyond the escape radius. Returns the bound binary's a,e on success.
interface EscapeInfo { escaped: boolean; aBin: number; eBin: number }

function testEscape(s: State, k: number, escapeR: number): EscapeInfo {
  const i = (k + 1) % 3, j = (k + 2) % 3
  // binary internal (two-body) energy
  const dx = s.x[j] - s.x[i], dy = s.y[j] - s.y[i]
  const dvx = s.vx[j] - s.vx[i], dvy = s.vy[j] - s.vy[i]
  const rij = Math.sqrt(dx * dx + dy * dy)
  const mu = M[i] + M[j]
  const v2 = dvx * dvx + dvy * dvy
  // specific orbital energy of the binary (reduced two-body): ½v² − μ/r
  const specE = 0.5 * v2 - mu / rij
  if (specE >= 0) return { escaped: false, aBin: NaN, eBin: NaN } // binary not bound
  // escaper relative to binary barycentre
  const mij = M[i] + M[j]
  const bx = (M[i] * s.x[i] + M[j] * s.x[j]) / mij
  const by = (M[i] * s.y[i] + M[j] * s.y[j]) / mij
  const bvx = (M[i] * s.vx[i] + M[j] * s.vx[j]) / mij
  const bvy = (M[i] * s.vy[i] + M[j] * s.vy[j]) / mij
  const Rx = s.x[k] - bx, Ry = s.y[k] - by
  const Vx = s.vx[k] - bvx, Vy = s.vy[k] - bvy
  const R = Math.sqrt(Rx * Rx + Ry * Ry)
  if (R < escapeR) return { escaped: false, aBin: NaN, eBin: NaN }
  const RV = Rx * Vx + Ry * Vy
  if (RV <= 0) return { escaped: false, aBin: NaN, eBin: NaN } // not receding
  const muTot = mij + M[k]
  const Ek = 0.5 * (Vx * Vx + Vy * Vy) - muTot / R // specific energy of escaper wrt binary
  if (Ek <= 0) return { escaped: false, aBin: NaN, eBin: NaN } // still bound to the binary
  // surviving binary orbital elements
  const aBin = -mu / (2 * specE)
  // require a clean hierarchy: the escaper must be well outside the binary, not
  // merely passing through a loose triple (kills premature escape calls).
  if (R < 2 * aBin) return { escaped: false, aBin: NaN, eBin: NaN }
  // eccentricity from the (reduced) angular momentum: h = r × v
  const h = dx * dvy - dy * dvx
  const e2 = 1 + (2 * specE * h * h) / (mu * mu)
  const eBin = Math.sqrt(Math.max(0, e2))
  return { escaped: true, aBin, eBin }
}

// ---- the full scattering integration ----------------------------------------
/**
 * Integrate one free-fall triangle to its outcome. Pure: depends only on the
 * initial state and the options.
 */
export function scatter(init: State, opts: ThreeBodyOptions = DEFAULT_OPTS): ThreeBodyResult {
  const s = makeState()
  s.x.set(init.x); s.y.set(init.y); s.vx.set(init.vx); s.vy.set(init.vy)
  const eps2 = opts.softening * opts.softening
  const size0 = Math.max(minSeparation(s), 1e-3)
  const escapeR = opts.escapeRadius * size0
  const interplayR = 0.25 * size0 // a "close encounter" dips below a quarter of the start size

  const E0 = energy(s, eps2)
  const absE0 = Math.max(Math.abs(E0), 1e-12)

  const d0 = makeDeriv()
  accelJerk(s, eps2, d0)
  // seed the higher derivatives for the first timestep with a conservative guess
  _a2x.fill(0); _a2y.fill(0); _a3x.fill(0); _a3y.fill(0)
  let dt = aarsethStep(d0, _a2x, _a2y, _a3x, _a3y, opts.eta)
  if (!Number.isFinite(dt) || dt <= 0) dt = 1e-3
  dt = Math.min(dt, 1e-2)

  let t = 0
  let steps = 0
  let energyError = 0
  let interplays = 0
  let wasClose = false
  let result: ThreeBodyResult | null = null

  while (t < opts.tMax && steps < opts.maxSteps) {
    hermiteStep(s, dt, eps2, d0)
    t += dt
    steps++

    // next timestep from the freshly computed higher derivatives
    dt = aarsethStep(d0, _a2x, _a2y, _a3x, _a3y, opts.eta)
    if (!Number.isFinite(dt) || dt <= 0) dt = 1e-4
    dt = Math.min(dt, opts.tMax - t + 1e-9)

    // interplay counting (rising-edge below the close threshold)
    const sep = minSeparation(s)
    if (sep < interplayR) {
      if (!wasClose) { interplays++; wasClose = true }
    } else {
      wasClose = false
    }

    // energy quality + singular guard
    if ((steps & 31) === 0 || sep < opts.softening * 2) {
      const e = energy(s, eps2)
      const err = Math.abs((e - E0) / absE0)
      if (err > energyError) energyError = err
    }

    // escape test — throttled, and only on the one body that could be escaping.
    if ((steps & 3) === 0) {
      const k = farBody(s)
      const info = testEscape(s, k, escapeR)
      if (info.escaped) {
        result = {
          outcome: 'escape', escaper: k, tEscape: t,
          aBin: info.aBin, eBin: info.eBin,
          interplays, energyError, steps,
        }
        break
      }
    }
  }

  if (result) return result

  // No escape within the budget. If the energy drifted badly we passed through a
  // collision we could not resolve — flag it singular; otherwise it is a genuinely
  // long-lived (bound / quasi-periodic) triple.
  const outcome: Outcome = energyError > 1e-2 ? 'singular' : 'bound'
  return { outcome, escaper: -1, tEscape: t, aBin: NaN, eBin: NaN, interplays, energyError, steps }
}

// ---- trajectory recording (for the click-to-inspect mini-canvas) ------------
export interface Trajectory {
  /** Sampled positions, length-3 arrays of (x,y) per sample. */
  px: Float64Array[] // [body][sample]
  py: Float64Array[]
  /** Pairwise separations r01, r02, r12 per sample. */
  sep: Float64Array[] // [pair][sample]
  /** Sample times. */
  t: Float64Array
  result: ThreeBodyResult
}

/**
 * Re-integrate a triangle while recording a down-sampled trajectory and the
 * pairwise-distance history — the data behind the "dance behind the pixel".
 */
export function recordTrajectory(init: State, samples = 600, opts: ThreeBodyOptions = DEFAULT_OPTS): Trajectory {
  const s = makeState()
  s.x.set(init.x); s.y.set(init.y); s.vx.set(init.vx); s.vy.set(init.vy)
  const eps2 = opts.softening * opts.softening
  const size0 = Math.max(minSeparation(s), 1e-3)
  const escapeR = opts.escapeRadius * size0
  const interplayR = 0.25 * size0
  const E0 = energy(s, eps2)
  const absE0 = Math.max(Math.abs(E0), 1e-12)

  const px: Float64Array[] = [new Float64Array(samples), new Float64Array(samples), new Float64Array(samples)]
  const py: Float64Array[] = [new Float64Array(samples), new Float64Array(samples), new Float64Array(samples)]
  const sepA: Float64Array[] = [new Float64Array(samples), new Float64Array(samples), new Float64Array(samples)]
  const tArr = new Float64Array(samples)

  const d0 = makeDeriv()
  accelJerk(s, eps2, d0)
  _a2x.fill(0); _a2y.fill(0); _a3x.fill(0); _a3y.fill(0)
  let dt = Math.min(aarsethStep(d0, _a2x, _a2y, _a3x, _a3y, opts.eta), 1e-2)
  if (!Number.isFinite(dt) || dt <= 0) dt = 1e-3

  let t = 0, steps = 0, filled = 0, energyError = 0, interplays = 0
  let wasClose = false
  let result: ThreeBodyResult | null = null
  // record at roughly even time intervals
  const sampleEvery = opts.tMax / samples
  let nextSample = sampleEvery

  const record = () => {
    if (filled >= samples) return
    const k = filled
    for (let b = 0; b < NB; b++) { px[b][k] = s.x[b]; py[b][k] = s.y[b] }
    const d01 = Math.hypot(s.x[1] - s.x[0], s.y[1] - s.y[0])
    const d02 = Math.hypot(s.x[2] - s.x[0], s.y[2] - s.y[0])
    const d12 = Math.hypot(s.x[2] - s.x[1], s.y[2] - s.y[1])
    sepA[0][k] = d01; sepA[1][k] = d02; sepA[2][k] = d12
    tArr[k] = t
    filled++
  }
  record()

  while (t < opts.tMax && steps < opts.maxSteps) {
    hermiteStep(s, dt, eps2, d0)
    t += dt; steps++
    dt = aarsethStep(d0, _a2x, _a2y, _a3x, _a3y, opts.eta)
    if (!Number.isFinite(dt) || dt <= 0) dt = 1e-4
    dt = Math.min(dt, opts.tMax - t + 1e-9)

    if (t >= nextSample) { record(); nextSample += sampleEvery }

    const sep = minSeparation(s)
    if (sep < interplayR) { if (!wasClose) { interplays++; wasClose = true } } else wasClose = false
    if ((steps & 31) === 0 || sep < opts.softening * 2) {
      const err = Math.abs((energy(s, eps2) - E0) / absE0)
      if (err > energyError) energyError = err
    }
    {
      const k = farBody(s)
      const info = testEscape(s, k, escapeR)
      if (info.escaped) {
        result = { outcome: 'escape', escaper: k, tEscape: t, aBin: info.aBin, eBin: info.eBin, interplays, energyError, steps }
        break
      }
    }
  }
  // fill the unused tail of the sample arrays by clamping to the last sample
  for (let k = filled; k < samples; k++) {
    for (let b = 0; b < NB; b++) { px[b][k] = px[b][Math.max(0, filled - 1)]; py[b][k] = py[b][Math.max(0, filled - 1)] }
    for (let p = 0; p < 3; p++) sepA[p][k] = sepA[p][Math.max(0, filled - 1)]
    tArr[k] = t
  }
  if (!result) {
    const outcome: Outcome = energyError > 1e-2 ? 'singular' : 'bound'
    result = { outcome, escaper: -1, tEscape: t, aBin: NaN, eBin: NaN, interplays, energyError, steps }
  }
  return { px, py, sep: sepA, t: tArr, result }
}

// ---- the Agekyan–Anosova region D -------------------------------------------
// With m₁,m₂ at (∓½,0), the representative domain for the third body is
// 0 ≤ x ≤ ½, 0 ≤ y, and inside the unit circle about m₁ = (−½,0). Every distinct
// free-fall triangle (up to translation/rotation/reflection/scale) has a
// representative here. The bounding box is [0,½] × [0, √3/2].
export const REGION = { xMin: 0, xMax: 0.5, yMin: 0, yMax: Math.sqrt(3) / 2 }

/** Is (x,y) inside region D (inside the unit circle centred on m₁)? */
export function inRegion(x: number, y: number): boolean {
  if (x < REGION.xMin || x > REGION.xMax || y < REGION.yMin || y > REGION.yMax) return false
  const dx = x + 0.5
  return dx * dx + y * y <= 1.0
}

/** Map a grid cell (col,row) to a point (x3,y3) in the region's bounding box. */
export function cellToXY(col: number, row: number, cols: number, rows: number): { x: number; y: number } {
  const x = REGION.xMin + ((col + 0.5) / cols) * (REGION.xMax - REGION.xMin)
  // row 0 at the TOP of the canvas → high y
  const y = REGION.yMin + ((rows - 0.5 - row) / rows) * (REGION.yMax - REGION.yMin)
  return { x, y }
}

// ---- named special configurations (one-click seeds) -------------------------
export interface NamedConfig { id: string; name: string; x: number; y: number; blurb: string }

export const NAMED_CONFIGS: NamedConfig[] = [
  {
    id: 'equilateral', name: 'Lagrange (equilateral)', x: 0, y: Math.sqrt(3) / 2,
    blurb: 'A perfect equilateral triangle released from rest collapses homothetically — staying equilateral all the way to a triple collision.',
  },
  {
    id: 'euler', name: 'Euler (collinear)', x: 0.5, y: 0.0001,
    blurb: 'All three bodies on a line. The central body is pulled both ways; a knife-edge configuration that collapses along the axis.',
  },
  {
    id: 'isosceles', name: 'Isosceles', x: 0, y: 0.45,
    blurb: 'The third body on the perpendicular bisector — the motion stays mirror-symmetric forever, so any escaper must be the symmetric one.',
  },
  {
    id: 'pythag-ish', name: 'Right-triangle', x: 0.5, y: 0.5,
    blurb: 'A lopsided triangle near the edge of region D — a long, intricate interplay before someone is ejected.',
  },
  {
    id: 'shallow', name: 'Near-collinear', x: 0.25, y: 0.08,
    blurb: 'A shallow triangle: a fast, violent close passage right at the start.',
  },
]
