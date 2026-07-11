// Modal dynamics and linearized buckling — the eigenvalue side of structural
// analysis, built on the same direct-stiffness model the static solver uses.
//
//   * Modal analysis solves the free-vibration generalized eigenproblem
//         K·φ = ω²·M·φ,
//     whose eigenvalues are the squared natural frequencies and eigenvectors
//     the mode shapes. M is the *consistent* mass matrix, assembled from the
//     same shape functions as K (so a single beam element already captures the
//     exact lowest frequency of a uniform member to a few percent).
//
//   * Buckling analysis solves the stability eigenproblem
//         (K + λ·K_g)·φ = 0     ⇔     K·φ = λ·(−K_g)·φ,
//     where K_g is the geometric stiffness built from the axial-force field of
//     a reference static load. The smallest positive λ is the load multiplier
//     at which the structure buckles; P_cr = λ_cr · P_reference.
//
// Both reduce to a dense generalized symmetric eigenproblem on the free DOFs,
// solved by Cholesky reduction + cyclic Jacobi (see eigen.ts). Results are
// cross-checked live in validate.ts against beam-vibration theory and Euler's
// column formula.

import {
  beamRotation,
  constrainedDofs,
  geom,
  matmul,
  solveFrame,
  transpose,
  DEFAULT_DENSITY,
  type FrameModel,
  type NodeDisp,
} from './frame'
import { generalizedSymEig, matVecDense, quadForm, zeros, type Mat } from './eigen'

// --------------------------------------------------------------- element data

/** 4×4 consistent mass of a 2-node bar (isotropic ⇒ local = global). */
function barMass(rho: number, A: number, L: number): Mat {
  const k = (rho * A * L) / 6
  return [
    [2 * k, 0, k, 0],
    [0, 2 * k, 0, k],
    [k, 0, 2 * k, 0],
    [0, k, 0, 2 * k],
  ]
}

/** 6×6 consistent mass of a 2-node Euler–Bernoulli beam-column, local coords. */
function beamMassLocal(rho: number, A: number, L: number): Mat {
  const M = zeros(6)
  const a = (rho * A * L) / 6 // axial (translational along the member)
  M[0][0] = 2 * a
  M[0][3] = a
  M[3][0] = a
  M[3][3] = 2 * a
  // Bending/translation–rotation block on [v1, θ1, v2, θ2] = indices 1,2,4,5.
  const b = (rho * A * L) / 420
  const L2 = L * L
  const blk = [
    [156, 22 * L, 54, -13 * L],
    [22 * L, 4 * L2, 13 * L, -3 * L2],
    [54, 13 * L, 156, -22 * L],
    [-13 * L, -3 * L2, -22 * L, 4 * L2],
  ]
  const idx = [1, 2, 4, 5]
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) M[idx[i]][idx[j]] += b * blk[i][j]
  return M
}

/** 4×4 geometric ("string") stiffness of a bar carrying axial force N, local. */
function barGeometric(N: number, L: number): Mat {
  const g = N / L
  // Transverse stiffening only, on the v DOFs (indices 1, 3).
  return [
    [0, 0, 0, 0],
    [0, g, 0, -g],
    [0, 0, 0, 0],
    [0, -g, 0, g],
  ]
}

/** 6×6 geometric stiffness of a beam-column with axial force N, local coords. */
function beamGeometricLocal(N: number, L: number): Mat {
  const G = zeros(6)
  const g = N / L
  const L2 = L * L
  const blk = [
    [6 / 5, L / 10, -6 / 5, L / 10],
    [L / 10, (2 * L2) / 15, -L / 10, -L2 / 30],
    [-6 / 5, -L / 10, 6 / 5, -L / 10],
    [L / 10, -L2 / 30, -L / 10, (2 * L2) / 15],
  ]
  const idx = [1, 2, 4, 5]
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) G[idx[i]][idx[j]] += g * blk[i][j]
  return G
}

/** Global 4×4 bar stiffness (axial), duplicated here to keep assembly local. */
function barStiffness(E: number, A: number, L: number, c: number, s: number): Mat {
  const k = (E * A) / L
  const cc = c * c
  const ss = s * s
  const cs = c * s
  return [
    [k * cc, k * cs, -k * cc, -k * cs],
    [k * cs, k * ss, -k * cs, -k * ss],
    [-k * cc, -k * cs, k * cc, k * cs],
    [-k * cs, -k * ss, k * cs, k * ss],
  ]
}

/** Local 6×6 beam-column stiffness (axial + bending). */
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

function barRotation(c: number, s: number): Mat {
  return [
    [c, s, 0, 0],
    [-s, c, 0, 0],
    [0, 0, c, s],
    [0, 0, -s, c],
  ]
}

// --------------------------------------------------------------- assembly core

interface Assembled {
  dpn: number
  nDof: number
  free: number[] // list of free global DOF indices
  /** Reduced (free×free) matrices. */
  Kr: Mat
  Mr: Mat // consistent mass (only when withMass)
  Kgr: Mat // geometric stiffness (only when withGeom, from axial forces)
}

/** Free-DOF mask identical to solveFrame: supports + untouched-node clamp. */
function freeDofList(model: FrameModel, dpn: number): number[] {
  const nNodes = model.nodes.length
  const nDof = nNodes * dpn
  const free = new Uint8Array(nDof).fill(1)
  for (let i = 0; i < nNodes; i++) {
    const con = constrainedDofs(model.nodes[i].support)
    for (let d = 0; d < dpn; d++) if (con[d]) free[i * dpn + d] = 0
  }
  const touched = new Uint8Array(nNodes)
  for (const m of model.members) {
    touched[m.a] = 1
    touched[m.b] = 1
  }
  for (let i = 0; i < nNodes; i++)
    if (!touched[i]) for (let d = 0; d < dpn; d++) free[i * dpn + d] = 0
  const list: number[] = []
  for (let i = 0; i < nDof; i++) if (free[i]) list.push(i)
  return list
}

function memberDofs(m: FrameModel['members'][number], dpn: number): number[] {
  return dpn === 2
    ? [m.a * 2, m.a * 2 + 1, m.b * 2, m.b * 2 + 1]
    : [m.a * 3, m.a * 3 + 1, m.a * 3 + 2, m.b * 3, m.b * 3 + 1, m.b * 3 + 2]
}

/**
 * Assemble the reduced stiffness, and optionally mass and geometric-stiffness,
 * matrices over the free DOFs. `axial` (member axial forces, tension +) is
 * required when withGeom is set.
 */
function assemble(
  model: FrameModel,
  opts: { withMass?: boolean; withGeom?: boolean; axial?: number[] },
): Assembled {
  const dpn = model.type === 'truss' ? 2 : 3
  const nDof = model.nodes.length * dpn
  const K = zeros(nDof)
  const M = opts.withMass ? zeros(nDof) : []
  const Kg = opts.withGeom ? zeros(nDof) : []

  model.members.forEach((m, mi) => {
    const { L, c, s } = geom(model, m)
    const rho = m.rho ?? DEFAULT_DENSITY
    let ke: Mat
    let me: Mat | null = null
    let kge: Mat | null = null
    const dofs = memberDofs(m, dpn)
    if (dpn === 2) {
      ke = barStiffness(m.E, m.A, L, c, s)
      const R = barRotation(c, s)
      if (opts.withMass) me = barMass(rho, m.A, L) // isotropic
      if (opts.withGeom) {
        const N = opts.axial?.[mi] ?? 0
        kge = matmul(matmul(transpose(R), barGeometric(N, L)), R)
      }
    } else {
      const T = beamRotation(c, s)
      const Tt = transpose(T)
      ke = matmul(matmul(Tt, beamLocalK(m.E, m.A, m.I, L)), T)
      if (opts.withMass) me = matmul(matmul(Tt, beamMassLocal(rho, m.A, L)), T)
      if (opts.withGeom) {
        const N = opts.axial?.[mi] ?? 0
        kge = matmul(matmul(Tt, beamGeometricLocal(N, L)), T)
      }
    }
    for (let a = 0; a < dofs.length; a++)
      for (let b = 0; b < dofs.length; b++) {
        K[dofs[a]][dofs[b]] += ke[a][b]
        if (me) M[dofs[a]][dofs[b]] += me[a][b]
        if (kge) Kg[dofs[a]][dofs[b]] += kge[a][b]
      }
  })

  const free = freeDofList(model, dpn)
  const reduce = (Full: Mat): Mat => {
    const r = zeros(free.length)
    for (let i = 0; i < free.length; i++)
      for (let j = 0; j < free.length; j++) r[i][j] = Full[free[i]][free[j]]
    return r
  }
  return {
    dpn,
    nDof,
    free,
    Kr: reduce(K),
    Mr: opts.withMass ? reduce(M) : [],
    Kgr: opts.withGeom ? reduce(Kg) : [],
  }
}

/** Scatter a reduced free-DOF vector back into a full nodal-DOF layout. */
function expand(free: number[], nDof: number, xr: number[]): Float64Array {
  const x = new Float64Array(nDof)
  for (let i = 0; i < free.length; i++) x[free[i]] = xr[i]
  return x
}

/** Split a full DOF vector into per-node {ux, uy, rot}. */
function toNodeDisp(x: Float64Array, dpn: number, nNodes: number): NodeDisp[] {
  const out: NodeDisp[] = []
  for (let i = 0; i < nNodes; i++)
    out.push({
      ux: x[i * dpn],
      uy: x[i * dpn + 1],
      rot: dpn === 3 ? x[i * dpn + 2] : 0,
    })
  return out
}

/** Normalise a mode so its largest nodal translation is 1 (for display). */
function normalizeShape(nd: NodeDisp[]): { nd: NodeDisp[]; maxTrans: number } {
  let mx = 0
  for (const d of nd) mx = Math.max(mx, Math.hypot(d.ux, d.uy))
  if (mx < 1e-30) return { nd, maxTrans: 0 }
  return { nd: nd.map((d) => ({ ux: d.ux / mx, uy: d.uy / mx, rot: d.rot / mx })), maxTrans: mx }
}

// -------------------------------------------------------------------- results

export interface Mode {
  index: number
  /** Eigenvalue (ω² for modal, load factor λ for buckling). */
  eigenvalue: number
  /** Natural frequency (rad/s) — modal only. */
  omega: number
  /** Natural frequency (Hz) — modal only. */
  hz: number
  /** Critical load factor — buckling only. */
  loadFactor: number
  /** Effective modal mass fraction along X / Y — modal only. */
  massX: number
  massY: number
  shape: NodeDisp[]
}

export interface ModalResult {
  kind: 'modal'
  dofPerNode: number
  modes: Mode[]
  totalMassX: number
  totalMassY: number
  ok: boolean
  note?: string
}

export interface BucklingResult {
  kind: 'buckling'
  dofPerNode: number
  modes: Mode[]
  referenceMaxAxial: number
  ok: boolean
  note?: string
}

/** Cap on reduced size — the dense Jacobi solver is O(n³) per sweep. */
const MAX_FREE_DOF = 360

// --------------------------------------------------------------------- modal

export function solveModal(model: FrameModel, maxModes = 8): ModalResult {
  const dpn = model.type === 'truss' ? 2 : 3
  const empty: ModalResult = {
    kind: 'modal',
    dofPerNode: dpn,
    modes: [],
    totalMassX: 0,
    totalMassY: 0,
    ok: false,
  }
  if (model.members.length === 0) return { ...empty, note: 'Add members to analyse vibration.' }

  const asm = assemble(model, { withMass: true })
  if (asm.free.length === 0) return { ...empty, note: 'No free DOFs — fully constrained.' }
  if (asm.free.length > MAX_FREE_DOF)
    return { ...empty, note: `Model too large for dense modal (${asm.free.length} DOF).` }

  const eig = generalizedSymEig(asm.Kr, asm.Mr)
  if (!eig) return { ...empty, note: 'Mass matrix not positive-definite.' }

  // Total mass (for effective-mass fractions): sum of translational lumped mass.
  const totalMass = memberTotalMass(model)
  const totalMassX = totalMass
  const totalMassY = totalMass

  // Rigid-body / mechanism modes show up as ~zero eigenvalues; skip them.
  const maxEv = Math.max(...eig.values.map((v) => Math.abs(v)), 1)
  const modes: Mode[] = []
  for (let k = 0; k < eig.values.length && modes.length < maxModes; k++) {
    const lam = eig.values[k]
    if (lam <= 1e-8 * maxEv) continue // rigid body
    const omega = Math.sqrt(lam)
    const xr = eig.vectors.map((row) => row[k])
    // M-normalise so φᵀMφ = 1, then effective modal mass along each axis.
    const mNorm = Math.sqrt(Math.max(quadForm(asm.Mr, xr), 1e-300))
    const phiR = xr.map((v) => v / mNorm)
    const phi = expand(asm.free, asm.nDof, phiR)
    const nd = toNodeDisp(phi, dpn, model.nodes.length)
    // Participation Γ = φᵀ M r  with r the rigid unit-translation vector.
    const { gammaX, gammaY } = participation(asm, phiR)
    const { nd: shape } = normalizeShape(nd)
    modes.push({
      index: modes.length,
      eigenvalue: lam,
      omega,
      hz: omega / (2 * Math.PI),
      loadFactor: 0,
      massX: totalMassX > 0 ? (gammaX * gammaX) / totalMassX : 0,
      massY: totalMassY > 0 ? (gammaY * gammaY) / totalMassY : 0,
      shape,
    })
  }
  return {
    kind: 'modal',
    dofPerNode: dpn,
    modes,
    totalMassX,
    totalMassY,
    ok: modes.length > 0,
    note: modes.length === 0 ? 'No elastic modes found.' : undefined,
  }
}

/** Lumped translational mass of the whole model (½ of each member to each end). */
function memberTotalMass(model: FrameModel): number {
  let m = 0
  for (const mem of model.members) {
    const { L } = geom(model, mem)
    m += (mem.rho ?? DEFAULT_DENSITY) * mem.A * L
  }
  return m
}

/** Modal participation factors Γx, Γy = φᵀ M r for rigid unit translations. */
function participation(asm: Assembled, phiR: number[]): { gammaX: number; gammaY: number } {
  const dpn = asm.dpn
  const rx = new Float64Array(asm.free.length)
  const ry = new Float64Array(asm.free.length)
  for (let i = 0; i < asm.free.length; i++) {
    const g = asm.free[i]
    const local = g % dpn
    if (local === 0) rx[i] = 1
    else if (local === 1) ry[i] = 1
  }
  const Mphi = matVecDense(asm.Mr, phiR)
  let gx = 0
  let gy = 0
  for (let i = 0; i < asm.free.length; i++) {
    gx += rx[i] * Mphi[i]
    gy += ry[i] * Mphi[i]
  }
  return { gammaX: gx, gammaY: gy }
}

// ------------------------------------------------------------------ buckling

export function solveBuckling(model: FrameModel, maxModes = 6): BucklingResult {
  const dpn = model.type === 'truss' ? 2 : 3
  const empty: BucklingResult = {
    kind: 'buckling',
    dofPerNode: dpn,
    modes: [],
    referenceMaxAxial: 0,
    ok: false,
  }
  if (model.members.length === 0) return { ...empty, note: 'Add members to analyse stability.' }

  // Reference static solve → axial force field that drives K_g.
  const stat = solveFrame(model)
  const axial = stat.members.map((r) => r.axial)
  const refMax = Math.max(...axial.map((a) => Math.abs(a)), 0)
  if (refMax < 1e-9) return { ...empty, note: 'No axial force under the current load.' }

  const asm = assemble(model, { withGeom: true, axial })
  if (asm.free.length === 0) return { ...empty, note: 'No free DOFs — fully constrained.' }
  if (asm.free.length > MAX_FREE_DOF)
    return { ...empty, note: `Model too large for dense buckling (${asm.free.length} DOF).` }

  // Solve (−K_g)·x = θ·K·x ; buckling factor λ = 1/θ. K must be SPD (stable).
  const negKg = asm.Kgr.map((row) => row.map((v) => -v))
  const eig = generalizedSymEig(negKg, asm.Kr)
  if (!eig) return { ...empty, note: 'Stiffness not positive-definite (mechanism).' }

  // Collect positive load factors λ = 1/θ (θ > 0), smallest first.
  const cands: { lam: number; k: number }[] = []
  for (let k = 0; k < eig.values.length; k++) {
    const theta = eig.values[k]
    if (theta > 1e-9) cands.push({ lam: 1 / theta, k })
  }
  cands.sort((a, b) => a.lam - b.lam)

  const modes: Mode[] = []
  for (const { lam, k } of cands.slice(0, maxModes)) {
    const xr = eig.vectors.map((row) => row[k])
    const phi = expand(asm.free, asm.nDof, xr)
    const nd = toNodeDisp(phi, dpn, model.nodes.length)
    const { nd: shape } = normalizeShape(nd)
    modes.push({
      index: modes.length,
      eigenvalue: lam,
      omega: 0,
      hz: 0,
      loadFactor: lam,
      massX: 0,
      massY: 0,
      shape,
    })
  }
  return {
    kind: 'buckling',
    dofPerNode: dpn,
    modes,
    referenceMaxAxial: refMax,
    ok: modes.length > 0,
    note: modes.length === 0 ? 'No positive buckling factor (structure stiffens under this load).' : undefined,
  }
}

// ------------------------------------------------------------- transient (modal superposition)

export interface TransientMode {
  omega: number
  /** Mass-normalised mode shape over the full DOF layout (φᵀ M φ = 1). */
  phi: Float64Array
  /** Initial modal coordinate q(0) = φᵀ M u₀ for the seed displacement. */
  q0: number
}

export interface TransientResult {
  kind: 'transient'
  dofPerNode: number
  nNodes: number
  modes: TransientMode[]
  /** Natural frequency of the dominant (largest |q0|) mode, Hz. */
  dominantHz: number
  ok: boolean
  note?: string
}

/**
 * Prepare a **modal-superposition transient**: the free-vibration response of
 * the structure released from a static-load deflection. Each natural mode
 * becomes a decaying oscillator, and the physical motion is their sum
 *     u(t) = Σᵢ φᵢ · qᵢ(t),   qᵢ(t) = e^{−ζωᵢt}( qᵢ(0)cos ω_dᵢt + … sin ω_dᵢt ).
 * The seed is normalised so the initial peak translation is 1, matching the
 * mode-shape renderer; damping ζ and time are applied later by `evalTransient`.
 */
export function solveTransient(model: FrameModel, maxModes = 10): TransientResult {
  const dpn = model.type === 'truss' ? 2 : 3
  const empty: TransientResult = {
    kind: 'transient',
    dofPerNode: dpn,
    nNodes: model.nodes.length,
    modes: [],
    dominantHz: 0,
    ok: false,
  }
  if (model.members.length === 0) return { ...empty, note: 'Add members to analyse response.' }

  const asm = assemble(model, { withMass: true })
  if (asm.free.length === 0) return { ...empty, note: 'No free DOFs — fully constrained.' }
  if (asm.free.length > MAX_FREE_DOF)
    return { ...empty, note: `Model too large for dense transient (${asm.free.length} DOF).` }

  const eig = generalizedSymEig(asm.Kr, asm.Mr)
  if (!eig) return { ...empty, note: 'Mass matrix not positive-definite.' }

  // Seed: static deflection under the applied load (zero initial velocity).
  const stat = solveFrame(model)
  const u0R = asm.free.map((g) => stat.displacements[g])
  const Mv = matVecDense(asm.Mr, u0R) // M·u₀ (reduced)

  const maxEv = Math.max(...eig.values.map((v) => Math.abs(v)), 1)
  const raw: TransientMode[] = []
  for (let k = 0; k < eig.values.length && raw.length < maxModes; k++) {
    const lam = eig.values[k]
    if (lam <= 1e-8 * maxEv) continue // rigid body
    const xr = eig.vectors.map((row) => row[k])
    const mNorm = Math.sqrt(Math.max(quadForm(asm.Mr, xr), 1e-300))
    const phiR = xr.map((v) => v / mNorm)
    let q0 = 0
    for (let i = 0; i < phiR.length; i++) q0 += phiR[i] * Mv[i]
    const phi = expand(asm.free, asm.nDof, phiR)
    raw.push({ omega: Math.sqrt(lam), phi, q0 })
  }
  if (raw.length === 0) return { ...empty, note: 'No elastic modes found.' }

  // Find the peak nodal translation at t=0 (u₀ reconstructed from Σ φ q0) and
  // rescale q0 so it is 1 — the renderer then shares the mode-shape scale.
  const nNodes = model.nodes.length
  const u0 = new Float64Array(asm.nDof)
  for (const m of raw) for (let i = 0; i < asm.nDof; i++) u0[i] += m.phi[i] * m.q0
  let peak = 0
  for (let i = 0; i < nNodes; i++) peak = Math.max(peak, Math.hypot(u0[i * dpn], u0[i * dpn + 1]))
  if (peak < 1e-30) {
    // No static deflection (unloaded): seed the fundamental mode directly.
    const p0 = modePeakTranslation(raw[0].phi, dpn, nNodes)
    raw.forEach((m, i) => (m.q0 = i === 0 && p0 > 0 ? 1 / p0 : 0))
  } else {
    for (const m of raw) m.q0 /= peak
  }

  let dom = raw[0]
  for (const m of raw) if (Math.abs(m.q0) > Math.abs(dom.q0)) dom = m
  return {
    kind: 'transient',
    dofPerNode: dpn,
    nNodes,
    modes: raw,
    dominantHz: dom.omega / (2 * Math.PI),
    ok: true,
  }
}

function modePeakTranslation(phi: Float64Array, dpn: number, nNodes: number): number {
  let p = 0
  for (let i = 0; i < nNodes; i++) p = Math.max(p, Math.hypot(phi[i * dpn], phi[i * dpn + 1]))
  return p
}

/**
 * Evaluate the transient displacement u(t) for a damping ratio ζ, returning the
 * per-node shape (already normalised to an initial unit peak by solveTransient).
 */
export function evalTransient(res: TransientResult, zeta: number, t: number): NodeDisp[] {
  const dpn = res.dofPerNode
  const u = new Float64Array(res.nNodes * dpn)
  const z = Math.max(0, Math.min(0.999, zeta))
  for (const m of res.modes) {
    const w = m.omega
    const wd = w * Math.sqrt(1 - z * z)
    const e = Math.exp(-z * w * t)
    // q(t) with q(0)=q0, q̇(0)=0.
    const q = e * (m.q0 * Math.cos(wd * t) + ((z * w * m.q0) / wd) * Math.sin(wd * t))
    for (let i = 0; i < u.length; i++) u[i] += m.phi[i] * q
  }
  return toNodeDisp(u, dpn, res.nNodes)
}
