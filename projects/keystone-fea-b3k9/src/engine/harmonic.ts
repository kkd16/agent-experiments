// Forced harmonic response — the resonance side of structural dynamics.
//
// Modal analysis found the natural frequencies; buckling found the instability
// loads; the transient solver rang the structure down from a static kick. The
// question left is the one that actually destroys machines and bridges: drive
// the structure with a *steady* sinusoidal force `F·cos ωt` and, once the
// starting transient has decayed, every DOF oscillates at the same frequency ω
// with a complex amplitude. Sweeping ω traces the **frequency-response function
// (FRF)** — flat at the static compliance, then a sharp resonance spike at each
// natural frequency, its height capped only by damping.
//
// The solution is textbook **modal superposition** on the mass-normalised
// eigenbasis solveModal already computes (φᵢᵀ M φⱼ = δᵢⱼ, K φᵢ = ωᵢ² M φᵢ):
//
//     u(ω) = Σᵢ φᵢ · (φᵢᵀ F) / (ωᵢ² − ω² + 2 i ζ ωᵢ ω).
//
// Each modal coordinate is a damped single-DOF oscillator driven at ω; near
// ω = ωᵢ its denominator collapses to 2 i ζ ωᵢ² and that mode dominates — the
// resonance peak. At ω → 0 the sum reconstructs the static solution K⁻¹F, which
// validate.ts checks against the direct static solver. Everything is real dense
// linear algebra with a hand-rolled complex modal sum — deterministic, no
// globals — so the same model always yields the same resonance curve.

import { type FrameModel, type NodeDisp } from './frame'
import { generalizedSymEig, quadForm, matVecDense } from './eigen'
import { assemble, expand, reduceLoadVector, toNodeDisp } from './dynamics'

/** Cap on reduced size — the dense Jacobi eigensolver is O(n³) per sweep. */
const MAX_FREE_DOF = 360

/**
 * How the structure is shaken:
 *  - `force`     — a constant-amplitude harmonic force F·cos ωt (the FRF).
 *  - `unbalance` — a rotating-mass unbalance whose force grows as ω² (spin the
 *                  machine faster and the shaking force climbs). Response rises
 *                  from zero, peaks past resonance, and levels off — the classic
 *                  rotor signature.
 *  - `base`      — harmonic motion of the supports (an earthquake / shaker
 *                  table). The output is the *transmissibility* X/Y: how much of
 *                  the ground motion reaches the structure. Every damping curve
 *                  crosses TR = 1 at ω = √2·ωₙ — the isolation crossover.
 */
export type DriveType = 'force' | 'unbalance' | 'base'

export interface HarmonicMode {
  omega: number // natural frequency, rad/s
  hz: number
  phi: number[] // mass-normalised reduced eigenvector
  modalForce: number // fᵢ = φᵢᵀ F  (generalised force in this mode)
  participation: number // Γᵢ = φᵢᵀ M ι  (modal participation for base motion)
}

export interface HarmonicPrep {
  ok: boolean
  note?: string
  dofPerNode: number
  nNodes: number
  nDof: number
  free: number[]
  modes: HarmonicMode[]
  /** Output DOF the scalar FRF is measured at (global index), and its label. */
  outDof: number
  outNode: number
  outDir: 'x' | 'y' | 'θ'
  fundamentalHz: number
  /** True when no nodal load was placed and a unit probe force is driven instead. */
  syntheticDrive: boolean
  /** Reduced influence vector ι (1 on free x-DOFs) — the base-motion direction. */
  iota: number[]
}

/** A complex number as a plain pair. */
interface Cx {
  re: number
  im: number
}

/**
 * Assemble the reduced K, M, eigen-decompose and mass-normalise the modes, then
 * project the applied nodal-load pattern onto them. If the model carries no
 * nodal load, a unit probe force is placed on the DOF that best excites the
 * fundamental mode so the FRF still demonstrates the resonances.
 */
export function prepareHarmonic(model: FrameModel, maxModes = 12): HarmonicPrep {
  const dpn = model.type === 'truss' ? 2 : 3
  const empty: HarmonicPrep = {
    ok: false,
    dofPerNode: dpn,
    nNodes: model.nodes.length,
    nDof: model.nodes.length * dpn,
    free: [],
    modes: [],
    outDof: 0,
    outNode: 0,
    outDir: 'y',
    fundamentalHz: 0,
    syntheticDrive: false,
    iota: [],
  }
  if (model.members.length === 0) return { ...empty, note: 'Add members to drive a harmonic response.' }

  const asm = assemble(model, { withMass: true })
  if (asm.free.length === 0) return { ...empty, note: 'No free DOFs — fully constrained.' }
  if (asm.free.length > MAX_FREE_DOF)
    return { ...empty, note: `Model too large for dense harmonic (${asm.free.length} DOF).` }

  const eig = generalizedSymEig(asm.Kr, asm.Mr)
  if (!eig) return { ...empty, note: 'Mass matrix not positive-definite.' }

  // Mass-normalise the elastic modes (skip rigid-body ~zero eigenvalues).
  const maxEv = Math.max(...eig.values.map((v) => Math.abs(v)), 1)
  const modesRaw: { omega: number; phi: number[] }[] = []
  for (let k = 0; k < eig.values.length && modesRaw.length < maxModes; k++) {
    const lam = eig.values[k]
    if (lam <= 1e-8 * maxEv) continue
    const xr = eig.vectors.map((row) => row[k])
    const mNorm = Math.sqrt(Math.max(quadForm(asm.Mr, xr), 1e-300))
    modesRaw.push({ omega: Math.sqrt(lam), phi: xr.map((v) => v / mNorm) })
  }
  if (modesRaw.length === 0) return { ...empty, note: 'No elastic modes found.' }

  // Forcing pattern: the placed nodal loads, reduced to free DOFs.
  let Fr = reduceLoadVector(model, asm.free, dpn)
  let syntheticDrive = false
  const loadNorm = Math.hypot(...Fr)
  if (loadNorm < 1e-30) {
    // No load placed — drive a unit probe force on the DOF that most strongly
    // participates in the fundamental mode, so the sweep still shows resonance.
    syntheticDrive = true
    const phi1 = modesRaw[0].phi
    let best = 0
    for (let i = 1; i < phi1.length; i++) if (Math.abs(phi1[i]) > Math.abs(phi1[best])) best = i
    Fr = asm.free.map((_, i) => (i === best ? 1 : 0))
  }

  // Base-motion influence vector ι: unit ground translation along +x. The modal
  // participation Γᵢ = φᵢᵀ M ι drives the seismic (support-excitation) response.
  const iota = asm.free.map((g) => (g % dpn === 0 ? 1 : 0))
  const Miota = matVecDense(asm.Mr, iota)

  const modes: HarmonicMode[] = modesRaw.map((m) => ({
    omega: m.omega,
    hz: m.omega / (2 * Math.PI),
    phi: m.phi,
    modalForce: dot(m.phi, Fr),
    participation: dot(m.phi, Miota),
  }))

  // Scalar output DOF: the free translational DOF with the largest static
  // response |Σ (fᵢ/ωᵢ²) φᵢ[dof]| — i.e. where the structure moves most.
  const uStatic = new Array(asm.free.length).fill(0)
  for (const m of modes) {
    const q = m.modalForce / (m.omega * m.omega)
    for (let i = 0; i < uStatic.length; i++) uStatic[i] += q * m.phi[i]
  }
  let outIdx = 0
  let outBest = -1
  for (let i = 0; i < asm.free.length; i++) {
    const local = asm.free[i] % dpn
    if (local === 2) continue // prefer a translation, not a rotation
    const v = Math.abs(uStatic[i])
    if (v > outBest) {
      outBest = v
      outIdx = i
    }
  }
  const outDofGlobal = asm.free[outIdx]
  const outNode = Math.floor(outDofGlobal / dpn)
  const outLocal = outDofGlobal % dpn

  return {
    ok: true,
    dofPerNode: dpn,
    nNodes: model.nodes.length,
    nDof: asm.nDof,
    free: asm.free,
    modes,
    outDof: outIdx, // index into the reduced/free vector
    outNode,
    outDir: outLocal === 0 ? 'x' : outLocal === 1 ? 'y' : 'θ',
    fundamentalHz: modes[0].hz,
    syntheticDrive,
    iota,
  }
}

function dot(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/**
 * Effective *real* modal force amplitude for mode i at drive frequency ω under a
 * given drive type. The complex modal coordinate is then Feff / (denominator).
 *   - force:     Feff = fᵢ                      (constant amplitude)
 *   - unbalance: Feff = (ω/ω₁)² · fᵢ            (rotor force ∝ speed², scaled so
 *                                                it equals fᵢ at the fundamental)
 *   - base:      Feff = ω² · Γᵢ · Y (Y = 1)     (seismic effective force)
 */
function effForce(prep: HarmonicPrep, m: HarmonicMode, omega: number, drive: DriveType): number {
  if (drive === 'unbalance') {
    const r = omega / prep.modes[0].omega
    return r * r * m.modalForce
  }
  if (drive === 'base') return omega * omega * m.participation
  return m.modalForce
}

/**
 * Complex steady-state response (reduced free-DOF vector) at drive frequency ω
 * and modal damping ζ. For base excitation the returned vector is the *absolute*
 * response u_abs = u_rel + ι·Y (Y = 1), so the output reads as transmissibility.
 */
export function harmonicResponse(
  prep: HarmonicPrep,
  zeta: number,
  omega: number,
  drive: DriveType = 'force',
): { re: number[]; im: number[] } {
  const n = prep.free.length
  const re = new Array(n).fill(0)
  const im = new Array(n).fill(0)
  const z = Math.max(0, zeta)
  for (const m of prep.modes) {
    const denRe = m.omega * m.omega - omega * omega
    const denIm = 2 * z * m.omega * omega
    const d2 = denRe * denRe + denIm * denIm || 1e-300
    const F = effForce(prep, m, omega, drive)
    const qRe = (F * denRe) / d2
    const qIm = (-F * denIm) / d2
    for (let j = 0; j < n; j++) {
      re[j] += qRe * m.phi[j]
      im[j] += qIm * m.phi[j]
    }
  }
  if (drive === 'base') for (let j = 0; j < n; j++) re[j] += prep.iota[j] // + ι·Y, Y = 1
  return { re, im }
}

/** Complex response of the scalar output DOF only (cheap, for the FRF sweep). */
function outputResponse(prep: HarmonicPrep, zeta: number, omega: number, drive: DriveType): Cx {
  let re = 0
  let im = 0
  const z = Math.max(0, zeta)
  const j = prep.outDof
  for (const m of prep.modes) {
    const denRe = m.omega * m.omega - omega * omega
    const denIm = 2 * z * m.omega * omega
    const d2 = denRe * denRe + denIm * denIm || 1e-300
    const F = effForce(prep, m, omega, drive)
    re += (F * denRe * m.phi[j]) / d2
    im += (-F * denIm * m.phi[j]) / d2
  }
  if (drive === 'base') re += prep.iota[j]
  return { re, im }
}

export interface FrfSample {
  omega: number
  hz: number
  mag: number // |U_out(ω)|
  phase: number // arg U_out(ω), radians in (−π, π]
}

export interface ResonancePeak {
  modeIndex: number
  hz: number
  omega: number
  mag: number
  amplification: number // peak |U| / static |U|
}

export interface FrfCurve {
  samples: FrfSample[]
  peaks: ResonancePeak[]
  refMag: number // reference amplitude the peaks are compared against (see below)
  omegaMin: number
  omegaMax: number
  magMax: number
  outNode: number
  outDir: 'x' | 'y' | 'θ'
  drive: DriveType
  unit: string // 'm' for force/unbalance amplitude, '' for base transmissibility
}

/**
 * Sweep the drive frequency and build the FRF of the scalar output DOF. The grid
 * is log-spaced (resonance curves span decades of amplitude) and additionally
 * seeded with a point exactly at every natural frequency and at each single-DOF
 * peak ωᵢ√(1−2ζ²), so no sharp spike is stepped over.
 */
export function frfSweep(prep: HarmonicPrep, zeta: number, drive: DriveType = 'force', n = 480): FrfCurve {
  const unit = drive === 'base' ? '' : 'm'
  if (!prep.ok || prep.modes.length === 0) {
    return {
      samples: [],
      peaks: [],
      refMag: 0,
      omegaMin: 0,
      omegaMax: 1,
      magMax: 1,
      outNode: prep.outNode,
      outDir: prep.outDir,
      drive,
      unit,
    }
  }
  const wTop = prep.modes[prep.modes.length - 1].omega
  const w1 = prep.modes[0].omega
  const omegaMin = Math.max(1e-4, 0.03 * w1)
  const omegaMax = 1.35 * wTop
  const z = Math.max(1e-4, zeta)

  const omegas = new Set<number>()
  const logMin = Math.log(omegaMin)
  const logMax = Math.log(omegaMax)
  for (let i = 0; i < n; i++) omegas.add(Math.exp(logMin + ((logMax - logMin) * i) / (n - 1)))
  // Seed exact resonance neighbourhoods.
  for (const m of prep.modes) {
    const wr = m.omega * Math.sqrt(Math.max(0, 1 - 2 * z * z))
    for (const w of [m.omega, wr, m.omega * (1 - z), m.omega * (1 + z)]) {
      if (w > omegaMin && w < omegaMax) omegas.add(w)
    }
  }
  const list = Array.from(omegas).sort((a, b) => a - b)

  const samples: FrfSample[] = list.map((w) => {
    const c = outputResponse(prep, z, w, drive)
    return { omega: w, hz: w / (2 * Math.PI), mag: Math.hypot(c.re, c.im), phase: Math.atan2(c.im, c.re) }
  })

  // Reference amplitude the peaks are measured against:
  //  - force: the static compliance |U(ω→0)|;
  //  - unbalance: the high-speed asymptote |U(ω→∞)| (force → ω², response levels);
  //  - base: unit input (transmissibility is already the ratio X/Y).
  const refMag = drive === 'base' ? 1 : drive === 'unbalance'
    ? Math.hypot(...vec(outputResponse(prep, z, wTop * 50, drive))) || 1e-300
    : Math.hypot(...vec(outputResponse(prep, z, omegaMin * 0.01, drive))) || 1e-300
  const peaks: ResonancePeak[] = prep.modes.map((m, i) => {
    const wr = m.omega * Math.sqrt(Math.max(1e-6, 1 - 2 * z * z))
    const c = outputResponse(prep, z, wr, drive)
    const mag = Math.hypot(c.re, c.im)
    return { modeIndex: i, hz: m.hz, omega: m.omega, mag, amplification: mag / refMag }
  })

  let magMax = refMag
  for (const s of samples) magMax = Math.max(magMax, s.mag)
  return { samples, peaks, refMag, omegaMin, omegaMax, magMax, outNode: prep.outNode, outDir: prep.outDir, drive, unit }
}

function vec(c: Cx): [number, number] {
  return [c.re, c.im]
}

/** Magnitude, phase and dynamic amplification of the output DOF at a single ω. */
export function frfAt(
  prep: HarmonicPrep,
  zeta: number,
  omega: number,
  drive: DriveType = 'force',
): { mag: number; phase: number; amplification: number } {
  if (!prep.ok || prep.modes.length === 0) return { mag: 0, phase: 0, amplification: 1 }
  const z = Math.max(1e-4, zeta)
  const c = outputResponse(prep, z, omega, drive)
  const mag = Math.hypot(c.re, c.im)
  const wTop = prep.modes[prep.modes.length - 1].omega
  const cRef =
    drive === 'base'
      ? null
      : drive === 'unbalance'
        ? outputResponse(prep, z, wTop * 50, drive)
        : outputResponse(prep, z, prep.modes[0].omega * 1e-4, drive)
  const staticMag = drive === 'base' ? 1 : Math.hypot(cRef!.re, cRef!.im) || 1e-300
  return { mag, phase: Math.atan2(c.im, c.re), amplification: mag / staticMag }
}

/**
 * Steady-state deformed shape at drive frequency ω and phase angle θ = ωt:
 *     u(θ) = Re( U e^{iθ} ) = U_re cos θ − U_im sin θ,
 * expanded to nodes and normalised so the largest nodal translation is 1 (the
 * renderer shares the mode-shape scale; the true amplification is reported
 * numerically). Also returns the peak translation *before* normalisation so the
 * caller can show how violently the structure is actually moving.
 */
export function harmonicShape(
  prep: HarmonicPrep,
  zeta: number,
  omega: number,
  theta: number,
  drive: DriveType = 'force',
): { shape: NodeDisp[]; peak: number } {
  const { re, im } = harmonicResponse(prep, zeta, omega, drive)
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const ur = re.map((v, i) => v * cos - im[i] * sin)
  const full = expand(prep.free, prep.nDof, ur)
  const nd = toNodeDisp(full, prep.dofPerNode, prep.nNodes)
  // Peak translation across the whole cycle (envelope), for the amplitude read-out.
  let env = 0
  for (let i = 0; i < prep.nNodes; i++) {
    const ax = Math.hypot(re[dofOf(prep, i, 0)] ?? 0, im[dofOf(prep, i, 0)] ?? 0)
    const ay = Math.hypot(re[dofOf(prep, i, 1)] ?? 0, im[dofOf(prep, i, 1)] ?? 0)
    env = Math.max(env, Math.hypot(ax, ay))
  }
  // Normalise the drawn shape to unit peak translation.
  let mx = 0
  for (const d of nd) mx = Math.max(mx, Math.hypot(d.ux, d.uy))
  const shape = mx > 1e-30 ? nd.map((d) => ({ ux: d.ux / mx, uy: d.uy / mx, rot: d.rot / mx })) : nd
  return { shape, peak: env }
}

/** Reduced index of node `node`'s local DOF `local`, or -1 if constrained. */
function dofOf(prep: HarmonicPrep, node: number, local: number): number {
  const g = node * prep.dofPerNode + local
  const i = prep.free.indexOf(g)
  return i
}
