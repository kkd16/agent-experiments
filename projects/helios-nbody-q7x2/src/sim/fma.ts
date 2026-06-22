// Frequency-Map Analysis (FMA) — the Resonance Atlas.
//
// This is Laskar's frequency-map analysis (Laskar 1990, 1993) — arguably the most
// celebrated diagnostic in modern celestial mechanics, the technique behind the
// diffusion portrait of the Solar System and the asteroid belt's resonance web
// (the "Arnold web"). The idea: a regular (quasi-periodic) orbit lives on an
// invariant torus and so keeps a *frozen* fundamental frequency; a chaotic orbit
// wanders across resonances and its frequency *drifts*. Measure the fundamental
// frequency on the first vs the second half of a finite orbit (NAFF — see
// `naff.ts`) and the relative drift |Δν/ν| is an exquisitely sensitive chaos
// indicator. Sweep that measurement across a two-dimensional family of initial
// conditions and the structure it paints IS the resonance web.
//
// We compute the Atlas in the canonical testbed: the *planar circular restricted
// three-body problem* (PCR3BP) in the dimensionless rotating frame where the two
// primaries sit fixed at (−μ, 0) and (1−μ, 0), a unit distance apart, rotating at
// unit mean motion. This is self-contained — independent of the live Barnes–Hut
// engine — so the Atlas is exactly reproducible and carries no body-count limit.
//
//   effective potential  Ω(x,y) = ½(x² + y²) + (1−μ)/r₁ + μ/r₂,
//        r₁ = |(x+μ, y)|,  r₂ = |(x−1+μ, y)|,
//   equations of motion  ẍ =  2ẏ + Ωₓ,   ÿ = −2ẋ + Ω_y
//        (the 2ẏ / −2ẋ are the Coriolis force; the +x,+y inside ∇Ω are centrifugal),
//   Jacobi integral      C  = 2Ω − (ẋ² + ẏ²)   (the lone constant of motion).
//
// A test particle is launched on an osculating Kepler ellipse about the Sun
// (primary 1, mass 1−μ) specified by its semimajor axis a and eccentricity e,
// mapped into the rotating frame by subtracting the frame rotation ω×r. We
// integrate it and record the *inertial* complex signal Z(t) = (x+iy)·e^{i t}
// whose dominant NAFF frequency is the orbit's mean motion n. (In the rotating
// frame the particle circulates at n−1; multiplying by e^{i t} restores the
// inertial n.) For a Keplerian two-body limit n = a^{-3/2}, recovered end-to-end
// by the self-test to validate the whole pipeline.

import { frequencyDiffusion, naff } from './naff'

/** Dimensionless effective potential Ω(x,y) of the rotating frame (mass ratio μ).
 *  Matches `restricted3body.omega` (½(x²+y²) + (1−μ)/r₁ + μ/r₂). */
export function effectivePotential(x: number, y: number, mu: number): number {
  const r1 = Math.hypot(x + mu, y)
  const r2 = Math.hypot(x - (1 - mu), y)
  return 0.5 * (x * x + y * y) + (1 - mu) / r1 + mu / r2
}

/** Analytic gradient ∇Ω = (Ωₓ, Ω_y), the position-force of the rotating frame
 *  (centrifugal +x,+y included). Consistent with `restricted3body.omegaGradient`. */
export function effectivePotentialGradient(x: number, y: number, mu: number): [number, number] {
  const ax = x + mu
  const bx = x - (1 - mu)
  const r1 = Math.hypot(ax, y)
  const r2 = Math.hypot(bx, y)
  const r13 = r1 * r1 * r1
  const r23 = r2 * r2 * r2
  const gx = x - ((1 - mu) * ax) / r13 - (mu * bx) / r23
  const gy = y - ((1 - mu) * y) / r13 - (mu * y) / r23
  return [gx, gy]
}

/** The Jacobi constant C = 2Ω − v² of a state in the rotating frame. */
export function jacobi(x: number, y: number, vx: number, vy: number, mu: number): number {
  return 2 * effectivePotential(x, y, mu) - (vx * vx + vy * vy)
}

export interface State4 {
  x: number
  y: number
  vx: number
  vy: number
}

/**
 * Build a test particle's rotating-frame initial state from osculating Kepler
 * elements about primary 1 (the Sun, mass 1−μ, sitting at (−μ,0)). The particle
 * starts at periapsis on the +ξ side: a true distance r_p = a(1−e) to the right
 * of the Sun, with the prograde inertial periapsis speed
 *   v_p = √( μ₁ (1+e)/(a(1−e)) ),   μ₁ = G·m₁ = 1−μ  (G ≡ 1).
 * The rotating-frame velocity is the inertial velocity minus the frame rotation
 * ω×r (ω = ẑ). The Sun itself, fixed in the rotating frame at (−μ,0), carries
 * inertial velocity ω×(−μ,0) = (0,−μ), which is folded in. Net result:
 *   x₀ = −μ + r_p,  y₀ = 0,  vx₀ = 0,  vy₀ = v_p − r_p.
 * Returns null for a degenerate (non-elliptic) request.
 */
export function keplerIC(a: number, e: number, mu: number): State4 | null {
  if (!(a > 0) || e < 0 || e >= 1) return null
  const mu1 = 1 - mu
  const rp = a * (1 - e)
  if (!(rp > 0)) return null
  const vp = Math.sqrt((mu1 * (1 + e)) / rp)
  const x0 = -mu + rp
  // vy = (inertial speed v_p, prograde +y) + (Sun's inertial vy = −μ) − (ω×r)_y,
  // with (ω×r)_y = x₀.  ⇒  vy = v_p − μ − x₀ = v_p − rp.
  const vy0 = vp - rp
  return { x: x0, y: 0, vx: 0, vy: vy0 }
}

/** Rotating-frame derivative ẋ = (vx, vy, 2vy+Ωₓ, −2vx+Ω_y), written into `out`. */
function deriv(s: State4, mu: number, out: State4): void {
  const [gx, gy] = effectivePotentialGradient(s.x, s.y, mu)
  out.x = s.vx
  out.y = s.vy
  out.vx = 2 * s.vy + gx
  out.vy = -2 * s.vx + gy
}

/** One classic RK4 step of size h on the 4-D rotating-frame state (in place). */
function rk4Step(s: State4, h: number, mu: number, k: State4[], tmp: State4): void {
  const [k1, k2, k3, k4] = k
  deriv(s, mu, k1)
  tmp.x = s.x + 0.5 * h * k1.x; tmp.y = s.y + 0.5 * h * k1.y
  tmp.vx = s.vx + 0.5 * h * k1.vx; tmp.vy = s.vy + 0.5 * h * k1.vy
  deriv(tmp, mu, k2)
  tmp.x = s.x + 0.5 * h * k2.x; tmp.y = s.y + 0.5 * h * k2.y
  tmp.vx = s.vx + 0.5 * h * k2.vx; tmp.vy = s.vy + 0.5 * h * k2.vy
  deriv(tmp, mu, k3)
  tmp.x = s.x + h * k3.x; tmp.y = s.y + h * k3.y
  tmp.vx = s.vx + h * k3.vx; tmp.vy = s.vy + h * k3.vy
  deriv(tmp, mu, k4)
  const sixth = h / 6
  s.x += sixth * (k1.x + 2 * k2.x + 2 * k3.x + k4.x)
  s.y += sixth * (k1.y + 2 * k2.y + 2 * k3.y + k4.y)
  s.vx += sixth * (k1.vx + 2 * k2.vx + 2 * k3.vx + k4.vx)
  s.vy += sixth * (k1.vy + 2 * k2.vy + 2 * k3.vy + k4.vy)
}

const newState = (): State4 => ({ x: 0, y: 0, vx: 0, vy: 0 })

export interface OrbitRecord {
  /** Inertial complex signal Z(t) = (x+iy)·e^{i t}, N = 2ᵏ samples. */
  re: Float64Array
  im: Float64Array
  /** Sample spacing in dimensionless time. */
  dt: number
  /** Rotating-frame trajectory [ξ0,η0,ξ1,η1,…] (world units), for an orbit preview. */
  path: Float64Array
  /** Relative spread of the Jacobi constant over the integration — a quality check. */
  jacobiDrift: number
  /** True if the particle hit a primary or escaped (signal is unreliable). */
  escaped: boolean
  /** Number of leading samples actually integrated before any escape (≤ re.length). */
  filled: number
  valid: boolean
}

export interface FmaOptions {
  /** Power-of-two complex samples of the inertial signal (default 256). */
  samples?: number
  /** Total integrated time in units of the launch orbit's period (default 40). */
  periods?: number
  /** Minimum RK4 substeps between recorded samples (default 12). */
  minSub?: number
  /** Collision radius about either primary; below it the run is flagged escaped. */
  hitRadius?: number
  /** Escape radius from the barycentre; beyond it the run is flagged escaped. */
  escapeRadius?: number
  /** Keep the path for a preview (default false — the Atlas scan skips it). */
  keepPath?: boolean
  /** Max path vertices kept when `keepPath` is set (default 1500). */
  pathMax?: number
}

/**
 * Integrate one PCR3BP test particle launched from Kepler elements (a, e) and
 * record its inertial complex signal for NAFF, sampling N = 2ᵏ points uniformly
 * over `periods` launch-orbit periods. The RK4 substep is chosen so each orbit
 * gets at least ~`minSub` steps per sample (≈ a few hundred per period) for an
 * accurate, Jacobi-conserving integration.
 */
export function recordOrbit(a: number, e: number, mu: number, opts: FmaOptions = {}): OrbitRecord {
  const empty: OrbitRecord = {
    re: new Float64Array(0), im: new Float64Array(0), dt: 0,
    path: new Float64Array(0), jacobiDrift: NaN, escaped: true, filled: 0, valid: false,
  }
  const ic = keplerIC(a, e, mu)
  if (!ic) return empty

  const N = opts.samples ?? 256
  const periods = opts.periods ?? 40
  const minSub = Math.max(2, opts.minSub ?? 12)
  const hitR = opts.hitRadius ?? 1e-2
  const escapeR = opts.escapeRadius ?? 12
  const keepPath = opts.keepPath ?? false
  const pathMax = Math.max(8, opts.pathMax ?? 1500)

  // Launch-orbit period (Kepler third law about the Sun, μ₁ = 1−μ, G = 1).
  const T = 2 * Math.PI * Math.sqrt((a * a * a) / (1 - mu))
  const totalTime = periods * T
  const dtSample = totalTime / N
  const sub = Math.max(minSub, Math.ceil(dtSample / (T / 200))) // ≥200 steps/orbit
  const h = dtSample / sub

  const re = new Float64Array(N)
  const im = new Float64Array(N)
  const pathStride = keepPath ? Math.max(1, Math.ceil(N / pathMax)) : 0
  const path: number[] = []

  const s: State4 = { ...ic }
  const k = [newState(), newState(), newState(), newState()]
  const tmp = newState()
  const C0 = jacobi(s.x, s.y, s.vx, s.vy, mu)
  let cMin = C0
  let cMax = C0
  let escaped = false

  let t = 0
  const sampleAt = (idx: number): void => {
    // Inertial position = rotating position rotated by the frame angle +t.
    const c = Math.cos(t)
    const sn = Math.sin(t)
    const xi = s.x * c - s.y * sn
    const yi = s.x * sn + s.y * c
    re[idx] = xi
    im[idx] = yi
    if (keepPath && idx % pathStride === 0) path.push(s.x, s.y)
  }

  sampleAt(0)
  let filled = 1
  for (let i = 1; i < N && !escaped; i++) {
    for (let j = 0; j < sub; j++) {
      rk4Step(s, h, mu, k, tmp)
      t += h
      const r1 = Math.hypot(s.x + mu, s.y)
      const r2 = Math.hypot(s.x - (1 - mu), s.y)
      if (r1 < hitR || r2 < hitR || Math.hypot(s.x, s.y) > escapeR) {
        escaped = true
        break
      }
    }
    const C = jacobi(s.x, s.y, s.vx, s.vy, mu)
    if (C < cMin) cMin = C
    if (C > cMax) cMax = C
    sampleAt(i)
    filled = i + 1
  }

  const denom = Math.abs(C0) > 1e-12 ? Math.abs(C0) : 1
  const jacobiDrift = (cMax - cMin) / denom
  return {
    re, im, dt: dtSample, path: new Float64Array(path),
    jacobiDrift, escaped, filled, valid: !escaped,
  }
}

export interface CellResult {
  /** Mean motion n = |fundamental| measured by NAFF over the full record. */
  freq: number
  /** Signed fundamental (prograde +, retrograde − in the inertial frame). */
  freqSigned: number
  /** log₁₀|Δn/n| frequency diffusion between the two halves — the chaos index. */
  logDiffusion: number
  /** Relative Jacobi-constant spread over the integration (integrator quality). */
  jacobiDrift: number
  /** The particle hit a primary / escaped — no reliable frequency. */
  escaped: boolean
  valid: boolean
}

/**
 * Compute one Atlas cell: integrate the (a, e) orbit, run NAFF for its mean motion
 * and the frequency-map diffusion. The headline outputs are `freq` (→ the
 * resonance/frequency map) and `logDiffusion` (→ the chaos/diffusion map).
 */
export function computeCell(a: number, e: number, mu: number, opts: FmaOptions = {}): CellResult {
  const dead: CellResult = {
    freq: NaN, freqSigned: NaN, logDiffusion: NaN, jacobiDrift: NaN, escaped: true, valid: false,
  }
  const rec = recordOrbit(a, e, mu, opts)
  if (!rec.valid) return { ...dead, jacobiDrift: rec.jacobiDrift, escaped: rec.escaped }

  const full = naff(rec.re, rec.im, rec.dt, { maxTerms: 4 })
  const diff = frequencyDiffusion(rec.re, rec.im, rec.dt, 4)
  if (!(full.fundamental > 0)) return { ...dead, jacobiDrift: rec.jacobiDrift, escaped: false, valid: false }

  return {
    freq: full.fundamental,
    freqSigned: full.fundamentalSigned,
    logDiffusion: diff.valid ? diff.logDiffusion : NaN,
    jacobiDrift: rec.jacobiDrift,
    escaped: false,
    valid: true,
  }
}

// ---------------------------------------------------------------------------
// Atlas scan model + presets.
// ---------------------------------------------------------------------------

export interface AtlasModel {
  id: string
  name: string
  blurb: string
  /** Mass ratio μ = m₂/(m₁+m₂). */
  mu: number
  /** Semimajor-axis range (the x-axis of the Atlas). */
  aMin: number
  aMax: number
  /** Eccentricity range (the y-axis of the Atlas). */
  eMin: number
  eMax: number
}

export const ATLAS_MODELS: AtlasModel[] = [
  {
    id: 'belt',
    name: 'Asteroid belt',
    blurb:
      "Sun–Jupiter (μ≈0.001). Test particles exterior of the Sun out toward Jupiter's orbit (a=1): " +
      'the mean-motion resonances n/n_J = p/q carve the Kirkwood gaps — chaotic strips in the diffusion map.',
    mu: 0.001,
    aMin: 0.4,
    aMax: 0.8,
    eMin: 0.0,
    eMax: 0.4,
  },
  {
    id: 'strong',
    name: 'Strong perturber',
    blurb:
      'A heavier secondary (μ=0.01) widens every resonance until neighbours overlap (Chirikov) — the ' +
      'regular tori dissolve into a broad chaotic sea, the textbook resonance-overlap route to chaos.',
    mu: 0.01,
    aMin: 0.45,
    aMax: 0.95,
    eMin: 0.0,
    eMax: 0.45,
  },
  {
    id: 'inner',
    name: 'Inner web',
    blurb:
      'A close-in band (μ=0.003) where high-order resonances crowd together — a fine, lacy Arnold web ' +
      'of thin chaotic threads separating nested regular tori.',
    mu: 0.003,
    aMin: 0.3,
    aMax: 0.62,
    eMin: 0.0,
    eMax: 0.5,
  },
]

export function atlasModelById(id: string): AtlasModel {
  return ATLAS_MODELS.find((m) => m.id === id) ?? ATLAS_MODELS[0]
}

/** Map an Atlas column/row (0…cols−1, 0…rows−1) to its (a, e) initial condition.
 *  Cells are sampled at their centres so the grid tiles the parameter rectangle. */
export function cellToAE(
  model: AtlasModel, col: number, row: number, cols: number, rows: number,
): { a: number; e: number } {
  const a = model.aMin + ((col + 0.5) / cols) * (model.aMax - model.aMin)
  // Row 0 is the TOP of the canvas (highest e), so invert for screen-space.
  const e = model.eMin + ((rows - 0.5 - row) / rows) * (model.eMax - model.eMin)
  return { a, e }
}

/**
 * Mean-motion resonance lines n = p/q (Jupiter's mean motion is 1 in these units)
 * that fall inside a semimajor-axis range, returned as { a, label } for overlay
 * guides. A resonance p:q sits at the a where n(a) = a^{-3/2} = p/q.
 */
export function resonanceLines(aMin: number, aMax: number): Array<{ a: number; p: number; q: number }> {
  const out: Array<{ a: number; p: number; q: number }> = []
  for (let p = 1; p <= 7; p++) {
    for (let q = 1; q <= 7; q++) {
      if (p === q) continue
      const g = gcd(p, q)
      if (g !== 1) continue
      const n = p / q
      const a = Math.pow(n, -2 / 3) // n = a^{-3/2}
      if (a >= aMin && a <= aMax) out.push({ a, p, q })
    }
  }
  out.sort((u, v) => u.a - v.a)
  return out
}

function gcd(a: number, b: number): number {
  while (b) {
    ;[a, b] = [b, a % b]
  }
  return a
}

export interface ProfilePoint {
  a: number
  /** Measured mean motion n (NaN if the orbit escaped / NAFF failed). */
  freq: number
  /** Frequency diffusion log₁₀|Δn/n| (NaN if unavailable). */
  logDiff: number
  valid: boolean
}

/**
 * A 1-D Laskar frequency map: sweep the semimajor axis a across the model's band
 * at a *fixed* eccentricity, returning the measured mean motion n(a) (a monotone
 * staircase whose flats are the resonance plateaus) and the diffusion D(a) (whose
 * spikes mark the chaotic resonances). The classic cross-section that complements
 * the 2-D atlas. `onProgress` (if given) is called with each completed index so a
 * caller can fill a plot live.
 */
export function frequencyProfile(
  model: AtlasModel,
  e: number,
  count: number,
  opts: FmaOptions = {},
  onProgress?: (i: number, p: ProfilePoint) => void,
): ProfilePoint[] {
  const out: ProfilePoint[] = []
  for (let i = 0; i < count; i++) {
    const a = model.aMin + ((i + 0.5) / count) * (model.aMax - model.aMin)
    const c = computeCell(a, e, model.mu, opts)
    const p: ProfilePoint = {
      a,
      freq: c.valid ? c.freq : NaN,
      logDiff: c.valid ? c.logDiffusion : NaN,
      valid: c.valid,
    }
    out.push(p)
    onProgress?.(i, p)
  }
  return out
}
