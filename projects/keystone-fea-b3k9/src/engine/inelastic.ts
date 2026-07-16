// Inelastic (nonlinear hysteretic) seismic time-history — the capstone that
// marries the plastic hinges of the pushover chapter (plastic.ts) to the
// Newmark march of the earthquake chapter (seismic.ts).
//
// Everything the seismic solver does is **linear-elastic**: the structure rings
// under the ground motion but always returns to plumb, and the base shear it
// reports keeps climbing with intensity without limit. Real buildings do not
// survive a design earthquake elastically — they are *designed* to yield. Once a
// section reaches its plastic moment Mₚ a hinge forms, the moment saturates, and
// the structure dissipates energy in fat hysteresis loops instead of storing it
// elastically. That inelastic action is the whole basis of modern seismic design
// (the response-modification / R factor, the ductility demand, the residual
// drift a building is left with). This file computes it directly:
//
//     M·ü + C·u̇ + f_s(u) = −M·ι·a_g(t),
//
// where the restoring force f_s(u) is **nonlinear** — assembled from members
// whose end sections carry bilinear kinematic-hardening plastic hinges. The
// equation is marched by the unconditionally-stable Newmark-β average-
// acceleration scheme with **Newton–Raphson equilibrium iterations** inside each
// step: at every iterate each member does a *state determination* (a rate-
// independent plasticity return map at its two end hinges) returning both its
// resisting force and its consistent tangent stiffness, the global tangent is
// reassembled, and the effective-stiffness system is re-solved until the dynamic
// residual vanishes. The converged hinge states are then committed and the march
// steps on.
//
// The hinge law is the textbook **bilinear kinematic-hardening** moment–rotation
// model: elastic slope k up to Mₚ, a post-yield slope α·k, unloading at the full
// elastic slope, so a fully reversed cycle traces the classic parallelogram loop
// (α = 0 gives elastic–perfectly-plastic). It is validated in validate.ts against
// the closed-form single-degree-of-freedom elastoplastic oscillator, exact
// energy balance, the elastic-limit reproduction of the linear seismic solver,
// and the monotonic backbone (first yield, post-yield stiffness) — the same
// live cross-checking every other chapter carries.
//
// Pure `number` / `Float64Array` arithmetic, deterministic — no time, no globals,
// no Math.random — so the same model + record always yields the same response.

import { beamRotation, geom, transpose, type FrameModel, type NodeDisp } from './frame'
import { assemble, expand, solveModal, toNodeDisp } from './dynamics'
import { memberMp } from './plastic'
import { solveSeismic, rayleighCoeffs, type GroundMotion } from './seismic'
import { choleskyLower, forwardSolve, backSolveT, zeros, type Mat } from './eigen'

// ===========================================================================
//  bilinear kinematic-hardening spring — the fundamental hysteretic unit
// ===========================================================================
//
// One-dimensional rate-independent plasticity with linear kinematic hardening.
// State variable: the plastic offset `up` (and back-force q = H·up). The stress
// is f = k·(u − up); the yield surface |f − q| ≤ f_y translates with q. For a
// target post-yield stiffness ratio α (so the second slope is α·k), the
// hardening modulus is H = α·k/(1 − α). α = 0 is elastic–perfectly-plastic.

export interface SpringState {
  up: number // committed plastic offset
}

/** Return map for the bilinear spring: given the committed plastic offset and a
 *  trial total displacement, return the resisting force, the tangent stiffness,
 *  and the updated plastic offset. */
export function springReturn(
  u: number,
  k: number,
  fy: number,
  H: number,
  upCommitted: number,
): { f: number; kt: number; up: number; dPlastic: number } {
  const fTrial = k * (u - upCommitted)
  const q = H * upCommitted
  const F = Math.abs(fTrial - q) - fy
  if (F <= 0 || fy <= 0) {
    return { f: fTrial, kt: k, up: upCommitted, dPlastic: 0 }
  }
  const dGamma = F / (k + H)
  const sign = Math.sign(fTrial - q)
  const up = upCommitted + dGamma * sign
  const f = k * (u - up)
  const kt = (k * H) / (k + H)
  return { f, kt, up, dPlastic: dGamma * sign }
}

/**
 * Scalar Newmark-β (average-acceleration) integrator for a single-DOF bilinear
 * hysteretic oscillator  m·ü + c·u̇ + f_s(u) = p(t),  with Newton–Raphson inside
 * each step. Returns the full displacement, velocity and force histories plus
 * the cumulative energy ledger — used as the closed-form validation reference
 * and to draw a clean SDOF hysteresis loop.
 */
export interface SdofHysteretic {
  u: Float64Array
  v: Float64Array
  fs: Float64Array // resisting spring force history
  up: Float64Array // plastic offset history
  eInput: number // cumulative input work ∫ p du
  eKinetic: number // ½ m v² (final)
  eDamping: number // ∫ (c v) du
  eStrain: number // ½ f²/k recoverable (final)
  eHysteretic: number // Σ f · dup dissipated
  peak: number
  residual: number
}

export function newmarkEPP(
  m: number,
  c: number,
  k: number,
  fy: number,
  alpha: number,
  dt: number,
  p: Float64Array,
  u0 = 0,
  v0 = 0,
): SdofHysteretic {
  const n = p.length
  const u = new Float64Array(n)
  const v = new Float64Array(n)
  const fs = new Float64Array(n)
  const upHist = new Float64Array(n)
  const H = alpha < 1 ? (alpha * k) / (1 - alpha) : 0
  const beta = 0.25
  const gamma = 0.5
  const a0 = 1 / (beta * dt * dt)
  const a1 = gamma / (beta * dt)
  const a2 = 1 / (beta * dt)
  const a3 = 1 / (2 * beta) - 1
  const a6 = dt * (1 - gamma)
  const a7 = dt * gamma

  let ui = u0
  let vi = v0
  let upC = 0
  let fi = springReturn(ui, k, fy, H, upC).f
  let ai = (p[0] - c * vi - fi) / m
  u[0] = ui
  v[0] = vi
  fs[0] = fi

  let eInput = 0
  let eDamping = 0
  let eHysteretic = 0

  for (let i = 1; i < n; i++) {
    // Newton–Raphson for u_{i} at this step.
    let un = ui + vi * dt // predictor
    let rr = springReturn(un, k, fy, H, upC)
    let converged = false
    for (let it = 0; it < 30; it++) {
      const an = a0 * (un - ui) - a2 * vi - a3 * ai
      const vn = vi + a6 * ai + a7 * an
      const R = p[i] - m * an - c * vn - rr.f
      const keff = rr.kt + a0 * m + a1 * c
      const du = R / keff
      un += du
      rr = springReturn(un, k, fy, H, upC)
      if (Math.abs(du) <= 1e-14 * (Math.abs(un) + 1e-12) || Math.abs(R) < 1e-10) {
        converged = true
        break
      }
    }
    void converged
    const an = a0 * (un - ui) - a2 * vi - a3 * ai
    const vn = vi + a6 * ai + a7 * an
    // Energy ledger over this step (mid-point work).
    const dU = un - ui
    eInput += 0.5 * (p[i] + p[i - 1]) * dU
    eDamping += 0.5 * (c * vn + c * vi) * dU
    eHysteretic += rr.f * rr.dPlastic // dissipated at the hinge this step
    // Commit.
    ui = un
    vi = vn
    ai = an
    fi = rr.f
    upC = rr.up
    u[i] = ui
    v[i] = vi
    fs[i] = fi
    upHist[i] = upC
  }

  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(u[i]))
  const eKinetic = 0.5 * m * vi * vi
  const eStrain = 0.5 * (fi * fi) / k
  return {
    u,
    v,
    fs,
    up: upHist,
    eInput,
    eKinetic,
    eDamping,
    eStrain,
    eHysteretic,
    peak,
    residual: ui,
  }
}

// ===========================================================================
//  member state determination — coupled bilinear hinges at the two beam ends
// ===========================================================================
//
// Concentrated plasticity: each frame member carries a rotational plastic hinge
// at each end (local rotational DOFs 2 and 5). Bending yields; axial and shear
// stay elastic — the standard lumped-plasticity frame model. Given the member's
// local deformation d (6-vector) and its committed end plastic rotations θp, the
// return map below returns the local resisting force S, the consistent tangent
// stiffness Kt (6×6, local), and the updated θp. Because the elastic beam
// couples the two end moments, the two hinges are solved together by a tiny
// active-set return map (there are only four hinge activity states).

/** Local 6×6 Euler–Bernoulli beam-column stiffness (axial + bending). */
function beamLocalK(E: number, A: number, I: number, L: number): Mat {
  const ax = (E * A) / L
  const b = (E * I) / (L * L * L)
  const K = zeros(6)
  K[0][0] = ax
  K[0][3] = -ax
  K[3][0] = -ax
  K[3][3] = ax
  K[1][1] = 12 * b
  K[1][2] = 6 * b * L
  K[1][4] = -12 * b
  K[1][5] = 6 * b * L
  K[2][2] = 4 * b * L * L
  K[2][4] = -6 * b * L
  K[2][5] = 2 * b * L * L
  K[4][4] = 12 * b
  K[4][5] = -6 * b * L
  K[5][5] = 4 * b * L * L
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) K[j][i] = K[i][j]
  return K
}

/** Invert a symmetric 1×1 / 2×2 (the active-hinge block). */
function invSPD(M: Mat): Mat {
  const n = M.length
  if (n === 1) return [[M[0][0] !== 0 ? 1 / M[0][0] : 0]]
  const a = M[0][0]
  const b = M[0][1]
  const c = M[1][0]
  const d = M[1][1]
  const det = a * d - b * c
  if (Math.abs(det) < 1e-300) return [[0, 0], [0, 0]]
  const k = 1 / det
  return [
    [d * k, -b * k],
    [-c * k, a * k],
  ]
}

export interface MemberHingeState {
  /** Committed end plastic rotations [θp_a, θp_b] (local rotational DOFs 2, 5). */
  thetaP: [number, number]
  /** True once the end has ever gone plastic (for drawing hinge glyphs). */
  yielded: [boolean, boolean]
  /** Peak |plastic rotation| ever reached at each end. */
  peakThetaP: [number, number]
}

interface MemberModel {
  Kl: Mat // local elastic stiffness
  T: Mat // 6×6 rotation (global → local)
  Tt: Mat
  dofs: number[]
  Mp: number // plastic moment capacity
  H: number // hinge hardening modulus (bilinear)
  /** Rotational sub-block [[Kl22,Kl25],[Kl52,Kl55]]. */
  Krr: [[number, number], [number, number]]
}

/**
 * Member state determination. Given the local deformation `d` and the committed
 * plastic rotations, run the coupled two-hinge bilinear return map and return
 * the local resisting force `S`, the consistent tangent `Kt` (local 6×6), the
 * updated plastic rotations, and the plastic-rotation increments (for the energy
 * ledger). The two rotational DOFs are indices 2 (end a) and 5 (end b).
 */
function memberState(
  mm: MemberModel,
  d: number[],
  thetaPc: [number, number],
): { S: number[]; Kt: Mat; thetaP: [number, number]; dPlastic: [number, number] } {
  const { Kl, Mp, H, Krr } = mm
  // Elastic moments at the current deformation with θp frozen at committed value.
  //   M_i = (Kl·d)_i − Σ_j Krr_ij θp_j     (i ∈ {2→a, 5→b})
  const Kd2 = Kl[2].reduce((s, v, j) => s + v * d[j], 0)
  const Kd5 = Kl[5].reduce((s, v, j) => s + v * d[j], 0)
  const localIdx = [2, 5] as const
  // Trial (freeze θp at committed).
  const m0 = [
    Kd2 - Krr[0][0] * thetaPc[0] - Krr[0][1] * thetaPc[1],
    Kd5 - Krr[1][0] * thetaPc[0] - Krr[1][1] * thetaPc[1],
  ]
  const q = [H * thetaPc[0], H * thetaPc[1]]
  const Ftr = [Math.abs(m0[0] - q[0]) - Mp, Math.abs(m0[1] - q[1]) - Mp]

  let thetaP: [number, number] = [thetaPc[0], thetaPc[1]]
  let active: number[] = []
  if (Mp > 0) {
    // Active-set iteration over the (at most) two hinges.
    const wantA = Ftr[0] > 0
    const wantB = Ftr[1] > 0
    const trySets: number[][] = []
    if (wantA && wantB) trySets.push([0, 1], [0], [1])
    else if (wantA) trySets.push([0])
    else if (wantB) trySets.push([1])
    for (const set of trySets) {
      const sol = solveActive(set, Kd2, Kd5, Krr, H, Mp, thetaPc)
      if (sol) {
        thetaP = sol
        active = set
        break
      }
    }
  }

  // Resisting force with the returned plastic rotations.
  const dp = [0, 0, thetaP[0], 0, 0, thetaP[1]]
  const S = new Array(6).fill(0)
  for (let i = 0; i < 6; i++) {
    let s = 0
    for (let j = 0; j < 6; j++) s += Kl[i][j] * (d[j] - dp[j])
    S[i] = s
  }

  // Consistent tangent: Kt = Kl − R_Aᵀ (Krr+HI)_AA⁻¹ R_A, with R_A the active
  // rotational rows of Kl. (Symmetric; reduces to static condensation when H=0.)
  const Kt = Kl.map((row) => row.slice())
  if (active.length > 0) {
    const block: Mat = active.map((ai) => active.map((aj) => Krr[ai][aj] + (ai === aj ? H : 0)))
    const binv = invSPD(block)
    // R_A: |A| rows, each the Kl row for local DOF (2 or 5).
    const rows = active.map((ai) => Kl[localIdx[ai]])
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 6; j++) {
        let s = 0
        for (let a = 0; a < active.length; a++)
          for (let b = 0; b < active.length; b++) s += rows[a][i] * binv[a][b] * rows[b][j]
        Kt[i][j] -= s
      }
  }

  const dPlastic: [number, number] = [thetaP[0] - thetaPc[0], thetaP[1] - thetaPc[1]]
  return { S, Kt, thetaP, dPlastic }
}

/**
 * Solve the plastic consistency equations for a given active set. For active i:
 *   M_i − q_i = s_i·Mₚ,   M_i = m0d_i − Σ_j Krr_ij θp_j,   q_i = H·θp_i,
 * with m0d_i the elastic moment at the current d (θp = 0). Inactive θp stay at
 * their committed value. Returns the updated θp only if the *full* KKT
 * conditions hold — active plastic multipliers non-negative **and** every
 * inactive hinge stays inside the yield surface |M_j − q_j| ≤ Mₚ — so the
 * accepted state is genuinely admissible (a wrong active set would make f_s
 * discontinuous and stall the equilibrium iteration). Else returns null and the
 * caller tries another set.
 */
function solveActive(
  set: number[],
  Kd2: number,
  Kd5: number,
  Krr: [[number, number], [number, number]],
  H: number,
  Mp: number,
  thetaPc: [number, number],
): [number, number] | null {
  const m0d = [Kd2, Kd5] // elastic moments at θp = 0
  const inactive = [0, 1].filter((i) => !set.includes(i))
  // Signs from the trial state (using committed θp).
  const q0 = [H * thetaPc[0], H * thetaPc[1]]
  const mTrial = [
    Kd2 - Krr[0][0] * thetaPc[0] - Krr[0][1] * thetaPc[1],
    Kd5 - Krr[1][0] * thetaPc[0] - Krr[1][1] * thetaPc[1],
  ]
  const sgn = set.map((i) => Math.sign(mTrial[i] - q0[i]) || 1)
  // Build the linear system for the active θp.
  //  For active i:  Σ_{active j} (Krr_ij + H δ_ij) θp_j
  //                 = m0d_i − s_i Mₚ − Σ_{inactive j} Krr_ij θp_j
  const na = set.length
  const A: Mat = zeros(na)
  const rhs: number[] = new Array(na).fill(0)
  for (let a = 0; a < na; a++) {
    const i = set[a]
    let r = m0d[i] - sgn[a] * Mp
    for (const j of inactive) r -= Krr[i][j] * thetaPc[j]
    rhs[a] = r
    for (let b = 0; b < na; b++) {
      const j = set[b]
      A[a][b] = Krr[i][j] + (i === j ? H : 0)
    }
  }
  const Ainv = invSPD(A)
  const sol = Ainv.map((row) => row.reduce((s, v, b) => s + v * rhs[b], 0))
  const thetaP: [number, number] = [thetaPc[0], thetaPc[1]]
  set.forEach((i, a) => (thetaP[i] = sol[a]))
  // KKT admissibility (1): plastic multiplier Δγ_i = s_i (θp_i − θp_i^c) ≥ 0.
  for (let a = 0; a < na; a++) {
    const i = set[a]
    const dgamma = sgn[a] * (thetaP[i] - thetaPc[i])
    if (dgamma < -1e-12) return null
  }
  // KKT admissibility (2): every *inactive* hinge must stay inside the yield
  // surface with the newly-solved plastic rotations, |M_j − q_j| ≤ Mₚ.
  const tol = 1e-7 * Mp
  for (const j of inactive) {
    const Mj = m0d[j] - Krr[j][0] * thetaP[0] - Krr[j][1] * thetaP[1]
    const qj = H * thetaP[j]
    if (Math.abs(Mj - qj) > Mp + tol) return null
  }
  return thetaP
}

// ===========================================================================
//  MDOF nonlinear seismic time-history
// ===========================================================================

/** Target integration step (s): resample the ground motion to keep the per-step
 *  Newton cost tractable for the dense factorisation. */
const TARGET_DT = 0.02
const MAX_FREE_DOF = 150
const MAX_STEPS = 2400
const NEWTON_TOL = 5e-6
const MAX_NEWTON = 40

export interface HingeReport {
  member: number
  end: 'a' | 'b'
  node: number
  x: number
  y: number
  peakThetaP: number
}

export interface EnergyPoint {
  t: number
  input: number
  kinetic: number
  damping: number
  hysteretic: number
}

export interface InelasticResult {
  kind: 'inelastic'
  ok: boolean
  note?: string
  dofPerNode: number
  nNodes: number
  ground: GroundMotion
  zeta: number
  alpha: number
  strengthFactor: number
  // time-history
  nSteps: number
  dt: number
  free: number[]
  nDof: number
  U: Float64Array[] // reduced relative-displacement history (stored steps)
  ugNorm: Float64Array
  shapePeak: number
  outReduced: number
  outNode: number
  outDir: 'x' | 'y' | 'θ'
  roof: Float64Array // output-DOF relative displacement history, m
  baseShear: Float64Array // nonlinear base shear ιᵀf_s, N
  /** Per-stored-step yielded-hinge flags, for the shaking animation glyphs. */
  hingeActive: Uint8Array[]
  hinges: HingeReport[] // hinges that yielded (peak plastic rotation)
  energy: EnergyPoint[]
  // scalar demands
  T1: number
  peakRoof: number
  residualRoof: number // permanent drift at the end of shaking
  peakDrift: number
  peakBaseShear: number
  ductility: number // peak roof / first-yield roof
  yieldRoof: number // roof displacement at global first yield
  hystEnergy: number // total hysteretic energy dissipated, J
  inputEnergy: number
  nHingesYielded: number
  // elastic reference (same record, no yielding)
  elasticPeakRoof: number
  elasticPeakBaseShear: number
  Rfactor: number // elastic peak base shear / inelastic peak base shear (force reduction)
  converged: boolean
  nonConverged: number // count of steps that hit the Newton iteration cap
  worstResidual: number // worst relative dynamic residual over the march
}

/** Reduced influence vector ι (unit horizontal ground translation). */
function influence(free: number[], dpn: number): number[] {
  return free.map((g) => (g % dpn === 0 ? 1 : 0))
}

/** Resample a ground motion's acceleration to a coarser step by linear interp. */
function resampleAg(ground: GroundMotion, dt: number): { ag: Float64Array; ug: Float64Array; n: number } {
  const n = Math.floor(ground.duration / dt) + 1
  const ag = new Float64Array(n)
  const ug = new Float64Array(n)
  const src = ground.ag
  const srcU = ground.ug
  const sdt = ground.dt
  for (let i = 0; i < n; i++) {
    const t = i * dt
    const x = t / sdt
    const j = Math.min(src.length - 2, Math.floor(x))
    const f = x - j
    ag[i] = src[j] + (src[j + 1] - src[j]) * f
    ug[i] = srcU[j] + (srcU[j + 1] - srcU[j]) * f
  }
  return { ag, ug, n }
}

/**
 * Full nonlinear (inelastic) seismic time-history of a plane frame under a
 * ground motion. Members yield at bilinear plastic hinges; the equation of
 * motion is marched by Newmark-β with Newton–Raphson equilibrium iterations and
 * committed hinge states. Reports the inelastic response, the yielded-hinge set,
 * ductility demand, residual drift, dissipated hysteretic energy, and — for the
 * force-reduction (R) story — the elastic response of the same record.
 *
 * `strengthFactor` scales every member Mₚ (a knob for how strong the frame is
 * relative to the demand: < 1 makes it yield sooner and harder). `alpha` is the
 * post-yield stiffness ratio (0 = elastic–perfectly-plastic).
 */
export function solveInelasticSeismic(
  model: FrameModel,
  ground: GroundMotion,
  opts: { zeta?: number; alpha?: number; strengthFactor?: number } = {},
): InelasticResult {
  const zeta = opts.zeta ?? 0.05
  const alpha = opts.alpha ?? 0.03
  const strengthFactor = opts.strengthFactor ?? 1
  const dpn = 3
  const nNodes = model.nodes.length
  const nDof = nNodes * dpn

  const base: InelasticResult = {
    kind: 'inelastic',
    ok: false,
    dofPerNode: dpn,
    nNodes,
    ground,
    zeta,
    alpha,
    strengthFactor,
    nSteps: 0,
    dt: TARGET_DT,
    free: [],
    nDof,
    U: [],
    ugNorm: new Float64Array(0),
    shapePeak: 1,
    outReduced: 0,
    outNode: 0,
    outDir: 'x',
    roof: new Float64Array(0),
    baseShear: new Float64Array(0),
    hingeActive: [],
    hinges: [],
    energy: [],
    T1: 0,
    peakRoof: 0,
    residualRoof: 0,
    peakDrift: 0,
    peakBaseShear: 0,
    ductility: 0,
    yieldRoof: 0,
    hystEnergy: 0,
    inputEnergy: 0,
    nHingesYielded: 0,
    elasticPeakRoof: 0,
    elasticPeakBaseShear: 0,
    Rfactor: 0,
    converged: true,
    nonConverged: 0,
    worstResidual: 0,
  }

  if (model.type !== 'frame') return { ...base, note: 'Inelastic time-history needs a frame (bending hinges).' }
  if (model.members.length === 0) return { ...base, note: 'Add members to shake the structure inelastically.' }

  // Reduced elastic K and consistent M over the free DOFs.
  const asm = assemble(model, { withMass: true })
  const free = asm.free
  const n = free.length
  if (n === 0) return { ...base, note: 'No free DOFs — fully constrained.' }
  if (n > MAX_FREE_DOF)
    return { ...base, note: `Model too large for the nonlinear march (${n} DOF > ${MAX_FREE_DOF}).` }

  const K = asm.Kr
  const M = asm.Mr

  // Modal frequencies for Rayleigh damping targets + T1.
  const modal = solveModal(model, 6)
  const omegas = modal.modes.map((m) => m.omega).filter((w) => w > 1e-6)
  if (omegas.length === 0) return { ...base, note: 'No elastic modes found.' }
  const w1 = omegas[0]
  const w2 = omegas[Math.min(omegas.length - 1, 2)] || w1 * 3
  const T1 = (2 * Math.PI) / w1
  const { a0: ray0, a1: ray1 } = rayleighCoeffs(zeta, w1, w2)
  // Initial-stiffness Rayleigh damping (constant through the analysis).
  const C: Mat = M.map((row, i) => row.map((mv, j) => ray0 * mv + ray1 * K[i][j]))

  // Member models (local stiffness, rotation, capacity, hardening).
  const members: MemberModel[] = model.members.map((m) => {
    const { L, c, s } = geom(model, m)
    const Kl = beamLocalK(m.E, m.A, m.I, L)
    const T = beamRotation(c, s)
    const Mp = memberMp(m) * strengthFactor
    const H = alpha < 1 ? (alpha * Kl[2][2]) / (1 - alpha) : 0 // hinge hardening from bending stiffness scale
    return {
      Kl,
      T,
      Tt: transpose(T),
      dofs: [m.a * 3, m.a * 3 + 1, m.a * 3 + 2, m.b * 3, m.b * 3 + 1, m.b * 3 + 2],
      Mp,
      H,
      Krr: [
        [Kl[2][2], Kl[2][5]],
        [Kl[5][2], Kl[5][5]],
      ],
    }
  })

  // Map full DOF → reduced index (−1 if constrained).
  const red = new Int32Array(nDof).fill(-1)
  free.forEach((g, i) => (red[g] = i))

  // Ground motion resampled to the integration step.
  const dt = Math.max(TARGET_DT, ground.dt)
  const { ag, ug, n: nSteps0 } = resampleAg(ground, dt)
  const nSteps = nSteps0

  const iota = influence(free, dpn)
  // Mι (reduced) — the seismic load direction.
  const Miota = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let j = 0; j < n; j++) s += M[i][j] * iota[j]
    Miota[i] = s
  }
  // A representative seismic force scale (peak of the effective load), for the
  // absolute floor in the Newton convergence test — so near-rest steps (where
  // every force is ~0 and a purely relative test can never be met) still
  // converge cleanly instead of burning every iteration.
  let fScale = 0
  for (let i = 0; i < n; i++) fScale = Math.max(fScale, Math.abs(Miota[i]) * ground.pga)
  fScale = Math.max(fScale, 1e-6)

  // Newmark constants.
  const beta = 0.25
  const gamma = 0.5
  const b0 = 1 / (beta * dt * dt)
  const b1 = gamma / (beta * dt)
  const b2 = 1 / (beta * dt)
  const b3 = 1 / (2 * beta) - 1
  const b6 = dt * (1 - gamma)
  const b7 = dt * gamma

  // Initial-stiffness (modified-Newton) effective stiffness, factored ONCE:
  //   K̂₀ = K_elastic + b0·M + b1·C.
  // Elastoplastic tangents are discontinuous when a hinge yields or unloads, so
  // a true tangent-Newton chatters between active sets and can diverge. The
  // initial-stiffness iteration u_{k+1} = u_k + K̂₀⁻¹R(u_k) uses the (constant,
  // SPD, stiffest-possible) elastic tangent, so it never diverges on those
  // discontinuities — it only converges more slowly — and, being constant, it is
  // Cholesky-factored a single time and reused for the whole march.
  const Keff0: Mat = zeros(n)
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) Keff0[i][j] = K[i][j] + b0 * M[i][j] + b1 * C[i][j]
  const Lc0 = choleskyLower(Keff0)
  if (!Lc0) return { ...base, note: 'Effective stiffness not positive-definite.' }

  // State.
  let u = new Float64Array(n)
  let v = new Float64Array(n)
  let acc = new Float64Array(n)
  for (let i = 0; i < n; i++) acc[i] = -iota[i] * ag[0]
  const hinge: MemberHingeState[] = members.map(() => ({
    thetaP: [0, 0],
    yielded: [false, false],
    peakThetaP: [0, 0],
  }))

  // Storage / striding.
  const stride = Math.max(1, Math.ceil(nSteps / MAX_STEPS))
  const U: Float64Array[] = []
  const kept: number[] = []
  const hingeActive: Uint8Array[] = []
  const baseShearArr: number[] = []
  const energy: EnergyPoint[] = []

  // Restoring-force assembly (member state determination) for a reduced
  // displacement `ur` and committed hinge states. Returns the reduced resisting
  // force fs, the trial plastic rotations, and the plastic increments (for the
  // energy ledger). The tangent is *not* assembled — the initial-stiffness march
  // reuses the once-factored elastic effective stiffness for every correction.
  const assembleInternal = (
    ur: Float64Array,
    states: [number, number][],
  ): { fs: Float64Array; trialStates: [number, number][]; dPlastic: [number, number][] } => {
    const fsFull = new Float64Array(nDof)
    const trialStates: [number, number][] = []
    const dPlastic: [number, number][] = []
    members.forEach((mm, mi) => {
      // Global element displacement → local.
      const ug6 = mm.dofs.map((g) => (red[g] >= 0 ? ur[red[g]] : 0))
      const dl = matVec6(mm.T, ug6)
      const st = memberState(mm, dl, states[mi])
      trialStates.push(st.thetaP)
      dPlastic.push(st.dPlastic)
      // Local force → global, scatter.
      const Sg = matVec6(mm.Tt, st.S)
      for (let a = 0; a < 6; a++) fsFull[mm.dofs[a]] += Sg[a]
    })
    const fs = new Float64Array(n)
    for (let i = 0; i < n; i++) fs[i] = fsFull[free[i]]
    return { fs, trialStates, dPlastic }
  }

  let eInput = 0
  let eDamping = 0
  let eHysteretic = 0
  let allConverged = true
  let nonConverged = 0
  let worstResidual = 0
  let peakRoof = 0
  let yieldRoof = 0
  let firstYield = false

  // Output DOF chosen after a short scan of the first strong-motion window; use
  // the free translational DOF with the largest running peak.
  const runPeak = new Float64Array(n)

  const committed = hinge.map((h) => [h.thetaP[0], h.thetaP[1]] as [number, number])

  for (let step = 0; step < nSteps; step++) {
    let dPlasticStep: [number, number][] = members.map(() => [0, 0])
    let internal: { fs: Float64Array; trialStates: [number, number][]; dPlastic: [number, number][] }
    if (step === 0) {
      internal = assembleInternal(u, committed)
    } else {
      const agv = ag[step]
      // Residual R(un) = p − M·aN − C·vN − f_s(un), with the Newmark kinematics
      // aN, vN linear in un. Returns the ∞-norm residual, the force scale (the
      // largest individual force contribution at any DOF — inertial and damping
      // included, since they dominate during fast motion), and the state.
      const residual = (
        un: Float64Array,
      ): { R: Float64Array; rnorm: number; pnorm: number; internal: ReturnType<typeof assembleInternal> } => {
        const intl = assembleInternal(un, committed)
        const R = new Float64Array(n)
        let rnorm = 0
        let pnorm = 0
        // Newmark kinematics for every DOF (aN, vN linear in un).
        const aN = new Float64Array(n)
        const vN = new Float64Array(n)
        for (let i = 0; i < n; i++) {
          aN[i] = b0 * (un[i] - u[i]) - b2 * v[i] - b3 * acc[i]
          vN[i] = v[i] + b6 * acc[i] + b7 * aN[i]
        }
        for (let i = 0; i < n; i++) {
          const pi = -Miota[i] * agv
          let Ma = 0
          let Cv = 0
          for (let j = 0; j < n; j++) {
            Ma += M[i][j] * aN[j]
            Cv += C[i][j] * vN[j]
          }
          R[i] = pi - Ma - Cv - intl.fs[i]
          rnorm = Math.max(rnorm, Math.abs(R[i]))
          pnorm = Math.max(pnorm, Math.abs(pi), Math.abs(intl.fs[i]), Math.abs(Ma), Math.abs(Cv))
        }
        return { R, rnorm, pnorm, internal: intl }
      }

      // Newton–Raphson for u_{step}, initial-stiffness corrections with a
      // backtracking line search that guarantees a monotone residual decrease —
      // the search is what tames the active-set chatter when a hinge yields or
      // unloads mid-step (an undamped step can 2-cycle across the yield kink).
      let un = new Float64Array(u)
      for (let i = 0; i < n; i++) un[i] = u[i] + v[i] * dt // predictor
      let cur = residual(un)
      internal = cur.internal
      let ok = false
      let lastRel = cur.rnorm / (cur.pnorm + fScale)
      for (let it = 0; it < MAX_NEWTON; it++) {
        lastRel = cur.rnorm / (cur.pnorm + fScale)
        if (cur.rnorm <= NEWTON_TOL * (cur.pnorm + fScale)) {
          ok = true
          break
        }
        // Initial-stiffness correction from the once-factored effective stiffness.
        const du = backSolveT(Lc0, forwardSolve(Lc0, Array.from(cur.R)))
        // Backtracking: accept the largest ω ∈ {1, ½, ¼, …} that reduces the
        // residual; if none does within a few halvings take the smallest step.
        let omega = 1
        let next = cur
        let accepted = false
        for (let bt = 0; bt < 6; bt++) {
          const trial = new Float64Array(n)
          for (let i = 0; i < n; i++) trial[i] = un[i] + omega * du[i]
          const rTrial = residual(trial)
          if (rTrial.rnorm < cur.rnorm) {
            un = trial
            next = rTrial
            accepted = true
            break
          }
          omega *= 0.5
        }
        if (!accepted) {
          // Even a tiny step didn't help — take it anyway and let the next
          // iteration re-evaluate (the state is at a yield kink; ω is small).
          for (let i = 0; i < n; i++) un[i] += omega * du[i]
          next = residual(un)
        }
        let duNorm = 0
        let uNorm = 0
        for (let i = 0; i < n; i++) {
          duNorm = Math.max(duNorm, Math.abs(omega * du[i]))
          uNorm = Math.max(uNorm, Math.abs(un[i]))
        }
        cur = next
        internal = cur.internal
        // A negligible correction is as good as a zero residual.
        if (duNorm <= 1e-11 * (uNorm + 1e-9)) {
          ok = true
          break
        }
      }
      if (!ok) {
        allConverged = false
        nonConverged++
        worstResidual = Math.max(worstResidual, lastRel)
      }
      // Finalise step kinematics.
      const aN = new Float64Array(n)
      const vN = new Float64Array(n)
      for (let i = 0; i < n; i++) {
        aN[i] = b0 * (un[i] - u[i]) - b2 * v[i] - b3 * acc[i]
        vN[i] = v[i] + b6 * acc[i] + b7 * aN[i]
      }
      // Energy ledger (mid-point work over the step).
      const pPrev = ag[step - 1]
      for (let i = 0; i < n; i++) {
        const dU = un[i] - u[i]
        eInput += 0.5 * (-Miota[i] * agv - Miota[i] * pPrev) * dU
        let cvPrev = 0
        let cvNow = 0
        for (let j = 0; j < n; j++) {
          cvPrev += C[i][j] * v[j]
          cvNow += C[i][j] * vN[j]
        }
        eDamping += 0.5 * (cvNow + cvPrev) * dU
      }
      dPlasticStep = internal.dPlastic
      u = un
      v = vN
      acc = aN
    }

    // Commit hinge states + accumulate hysteretic energy and peak plastic rot.
    members.forEach((mm, mi) => {
      const th = internal.trialStates[mi]
      committed[mi][0] = th[0]
      committed[mi][1] = th[1]
      hinge[mi].thetaP = [th[0], th[1]]
      for (const e of [0, 1] as const) {
        if (Math.abs(th[e]) > 1e-14) hinge[mi].yielded[e] = true
        hinge[mi].peakThetaP[e] = Math.max(hinge[mi].peakThetaP[e], Math.abs(th[e]))
      }
      // dissipation = |M_end| · |Δθp| ; recover end moments from the local force.
      const dP = dPlasticStep[mi]
      if (dP[0] !== 0 || dP[1] !== 0) {
        const ug6 = mm.dofs.map((g) => (red[g] >= 0 ? u[red[g]] : 0))
        const dl = matVec6(mm.T, ug6)
        // Local resisting moment at each end from committed θp.
        const dp = [0, 0, committed[mi][0], 0, 0, committed[mi][1]]
        const Ma2 = mm.Kl[2].reduce((s, val, j) => s + val * (dl[j] - dp[j]), 0)
        const Mb2 = mm.Kl[5].reduce((s, val, j) => s + val * (dl[j] - dp[j]), 0)
        eHysteretic += Math.abs(Ma2 * dP[0]) + Math.abs(Mb2 * dP[1])
      }
    })

    // Track running peak for output-DOF selection.
    for (let i = 0; i < n; i++) runPeak[i] = Math.max(runPeak[i], Math.abs(u[i]))

    // Detect global first yield (for the ductility reference), by any yielded end.
    if (!firstYield && members.some((_, mi) => hinge[mi].yielded[0] || hinge[mi].yielded[1])) {
      firstYield = true
    }

    if (step % stride === 0) {
      U.push(u.slice())
      kept.push(step)
      const flags = new Uint8Array(members.length * 2)
      members.forEach((_, mi) => {
        flags[mi * 2] = hinge[mi].yielded[0] ? 1 : 0
        flags[mi * 2 + 1] = hinge[mi].yielded[1] ? 1 : 0
      })
      hingeActive.push(flags)
      // base shear = ιᵀ f_s (nonlinear restoring force in ground direction)
      let shear = 0
      for (let i = 0; i < n; i++) shear += iota[i] * internal.fs[i]
      baseShearArr.push(shear)
      energy.push({ t: step * dt, input: eInput, kinetic: 0.5 * quad(M, v), damping: eDamping, hysteretic: eHysteretic })
    }
  }

  // Output (roof) DOF = translational free DOF with the largest peak.
  let outReduced = 0
  let bestPeak = -1
  for (let i = 0; i < n; i++) {
    if (free[i] % dpn === 2) continue
    if (runPeak[i] > bestPeak) {
      bestPeak = runPeak[i]
      outReduced = i
    }
  }
  const outGlobal = free[outReduced]
  const outNode = Math.floor(outGlobal / dpn)
  const outLocal = outGlobal % dpn

  const roof = new Float64Array(U.length)
  for (let s = 0; s < U.length; s++) roof[s] = U[s][outReduced]
  // First-yield roof (approx): the roof displacement at the stored frame where a
  // hinge first shows as yielded.
  for (let s = 0; s < hingeActive.length; s++) {
    let any = false
    for (let k = 0; k < hingeActive[s].length; k++) if (hingeActive[s][k]) any = true
    if (any) {
      yieldRoof = Math.abs(roof[s])
      break
    }
  }
  for (let s = 0; s < roof.length; s++) peakRoof = Math.max(peakRoof, Math.abs(roof[s]))

  // Peak inter-level drift over stored frames.
  let peakDrift = 0
  for (const uf of U) {
    let mn = Infinity
    let mx = -Infinity
    for (let i = 0; i < n; i++)
      if (free[i] % dpn === 0) {
        mn = Math.min(mn, uf[i])
        mx = Math.max(mx, uf[i])
      }
    if (mx > mn) peakDrift = Math.max(peakDrift, mx - mn)
  }

  // Shape normalisation.
  let shapePeak = 0
  for (const uf of U) {
    const full = expand(free, nDof, Array.from(uf))
    for (let i = 0; i < nNodes; i++) shapePeak = Math.max(shapePeak, Math.hypot(full[i * dpn], full[i * dpn + 1]))
  }

  // Ground displacement at stored steps, normalised for the sway.
  const ugNorm = new Float64Array(U.length)
  let ugMax = 1e-30
  for (const kk of kept) ugMax = Math.max(ugMax, Math.abs(ug[kk]))
  kept.forEach((kk, s) => (ugNorm[s] = ug[kk] / ugMax))

  let peakBaseShear = 0
  for (const b of baseShearArr) peakBaseShear = Math.max(peakBaseShear, Math.abs(b))

  // Yielded-hinge report.
  const hinges: HingeReport[] = []
  members.forEach((_mm, mi) => {
    const m = model.members[mi]
    for (const e of [0, 1] as const) {
      if (hinge[mi].yielded[e]) {
        const node = e === 0 ? m.a : m.b
        hinges.push({
          member: mi,
          end: e === 0 ? 'a' : 'b',
          node,
          x: model.nodes[node].x,
          y: model.nodes[node].y,
          peakThetaP: hinge[mi].peakThetaP[e],
        })
      }
    }
  })

  // Elastic reference (same record) for the R-factor / force-reduction story.
  let elasticPeakRoof = 0
  let elasticPeakBaseShear = 0
  try {
    const el = solveSeismic(model, ground, zeta)
    if (el.ok) {
      elasticPeakRoof = el.peakRoof
      elasticPeakBaseShear = el.peakBaseShear
    }
  } catch {
    /* ignore — elastic reference is optional */
  }

  const ductility = yieldRoof > 1e-12 ? peakRoof / yieldRoof : 0
  const Rfactor = peakBaseShear > 1e-9 ? elasticPeakBaseShear / peakBaseShear : 0

  return {
    ...base,
    ok: true,
    note: undefined,
    nSteps: U.length,
    dt: dt * stride,
    free,
    U,
    ugNorm,
    shapePeak: shapePeak || 1,
    outReduced,
    outNode,
    outDir: outLocal === 0 ? 'x' : outLocal === 1 ? 'y' : 'θ',
    roof,
    baseShear: Float64Array.from(baseShearArr),
    hingeActive,
    hinges,
    energy,
    T1,
    peakRoof,
    residualRoof: roof.length ? roof[roof.length - 1] : 0,
    peakDrift,
    peakBaseShear,
    ductility,
    yieldRoof,
    hystEnergy: eHysteretic,
    inputEnergy: eInput,
    nHingesYielded: hinges.length,
    elasticPeakRoof,
    elasticPeakBaseShear,
    Rfactor,
    converged: allConverged,
    nonConverged,
    worstResidual,
  }
}

/** 6-vector = A(6×6)·x(6). */
function matVec6(A: Mat, x: number[]): number[] {
  const y = new Array(6).fill(0)
  for (let i = 0; i < 6; i++) {
    let s = 0
    for (let j = 0; j < 6; j++) s += A[i][j] * x[j]
    y[i] = s
  }
  return y
}

/** vᵀ A v for a dense symmetric A. */
function quad(A: Mat, v: Float64Array): number {
  let s = 0
  for (let i = 0; i < v.length; i++) {
    let row = 0
    for (let j = 0; j < v.length; j++) row += A[i][j] * v[j]
    s += v[i] * row
  }
  return s
}

/**
 * The drawn shape at stored step `s`: the relative structural deformation
 * (normalised to unit peak so the shared mode-shape scale renders it) plus a
 * rigid ground sway, exactly like the elastic seismic view — but here the frame
 * carries permanent (residual) deformation and its hinges have popped.
 */
export function inelasticShape(res: InelasticResult, s: number): NodeDisp[] {
  const dpn = res.dofPerNode
  const idx = Math.max(0, Math.min(res.U.length - 1, Math.round(s)))
  const uf = res.U[idx] ?? new Float64Array(res.free.length)
  const full = expand(res.free, res.nDof, Array.from(uf))
  const nd = toNodeDisp(full, dpn, res.nNodes)
  const sway = 0.55 * (res.ugNorm[idx] ?? 0)
  const inv = 1 / res.shapePeak
  return nd.map((d) => ({ ux: d.ux * inv + sway, uy: d.uy * inv, rot: d.rot * inv }))
}

/** The hinges that have yielded by stored step `s` — as {node, sign} for the
 *  draw layer, so amber glyphs pop in on the frame as it is driven past its
 *  capacity (sign is unused by the glyph but matches the pushover hinge type). */
export function inelasticHinges(res: InelasticResult, s: number): { node: number; sign: number }[] {
  const idx = Math.max(0, Math.min(res.hingeActive.length - 1, Math.round(s)))
  const flags = res.hingeActive[idx]
  if (!flags) return []
  const out: { node: number; sign: number }[] = []
  for (const h of res.hinges) {
    const flagIdx = h.member * 2 + (h.end === 'a' ? 0 : 1)
    if (flags[flagIdx]) out.push({ node: h.node, sign: 1 })
  }
  return out
}
