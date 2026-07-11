// 2-D truss and frame analysis by the direct stiffness method.
//
//   * truss  — pin-jointed bars carrying axial force only (2 DOF/node: u, v)
//   * frame  — Euler–Bernoulli beam-columns carrying axial force, shear, and
//              bending moment (3 DOF/node: u, v, θ)
//
// The math is the textbook direct-stiffness method: build each element's
// stiffness in local coordinates, rotate it to global coordinates, scatter it
// into the global matrix, apply supports, solve K·u = f, then recover member
// end forces and support reactions. Results are cross-checked in validate.ts
// against closed-form solutions (cantilever PL³/3EI, etc.).

import { Assembler, matVec, solveCG, type Vec } from './linalg'

export type SupportKind = 'free' | 'pin' | 'roller-x' | 'roller-y' | 'fixed'
export type AnalysisType = 'truss' | 'frame'

export interface FNode {
  x: number
  y: number
  support: SupportKind
}
export interface FMember {
  a: number
  b: number
  E: number // Young's modulus (Pa)
  A: number // cross-sectional area (m²)
  I: number // second moment of area (m⁴) — frame mode only
  rho?: number // material mass density (kg/m³) — modal analysis; defaults to steel
  w?: number // uniform transverse distributed load (N/m), +ve along local +v — frame mode
}

/** Default material mass density: structural steel, kg/m³. */
export const DEFAULT_DENSITY = 7850
export interface FLoad {
  node: number
  fx: number
  fy: number
  mz: number // applied moment (N·m) — frame mode only
}
export interface FrameModel {
  type: AnalysisType
  nodes: FNode[]
  members: FMember[]
  loads: FLoad[]
}

export interface MemberResult {
  axial: number // N, tension positive
  stress: number // Pa, axial stress (tension positive)
  bendingStress: number // Pa, peak bending stress ±Mc/I (0 for trusses)
  maxFiberStress: number // Pa, |axial/A| + |M|max·c/I — the governing normal stress
  shearA: number
  shearB: number
  momentA: number
  momentB: number
  length: number
}
export interface NodeDisp {
  ux: number
  uy: number
  rot: number
}
export interface Reaction {
  node: number
  fx: number
  fy: number
  mz: number
}
export interface FrameResult {
  type: AnalysisType
  dofPerNode: number
  displacements: Vec
  nodeDisp: NodeDisp[]
  members: MemberResult[]
  reactions: Reaction[]
  maxDisp: number
  maxStress: number
  maxAxial: number
  equilibriumResidual: number
  stable: boolean
  iterations: number
}

/** Which local DOFs (u, v, θ) a support fixes, as a 3-tuple of booleans. */
export function constrainedDofs(support: SupportKind): [boolean, boolean, boolean] {
  switch (support) {
    case 'pin':
      return [true, true, false]
    case 'fixed':
      return [true, true, true]
    case 'roller-x': // rolls horizontally → vertical reaction only
      return [false, true, false]
    case 'roller-y': // rolls vertically → horizontal reaction only
      return [true, false, false]
    default:
      return [false, false, false]
  }
}

export function geom(model: FrameModel, m: FMember) {
  const na = model.nodes[m.a]
  const nb = model.nodes[m.b]
  const dx = nb.x - na.x
  const dy = nb.y - na.y
  const L = Math.hypot(dx, dy)
  return { L, c: dx / L, s: dy / L }
}

/** Global 4×4 bar stiffness (axial only). DOF order [ua, va, ub, vb]. */
function barStiffness(E: number, A: number, L: number, c: number, s: number): number[][] {
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

/** Local 6×6 beam-column stiffness. DOF order [u1, v1, θ1, u2, v2, θ2]. */
function beamLocal(E: number, A: number, I: number, L: number): number[][] {
  const ax = (E * A) / L
  const b = (E * I) / (L * L * L)
  const K = Array.from({ length: 6 }, () => new Array(6).fill(0))
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
  // mirror the lower triangle
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) K[j][i] = K[i][j]
  return K
}

/**
 * Work-equivalent (consistent) local load vector for a uniform transverse
 * intensity `w` (N/m, local +v) on a 2-node beam element of length L.
 * DOF order [u1, v1, θ1, u2, v2, θ2].
 */
export function equivLoadLocal(w: number, L: number): number[] {
  return [0, (w * L) / 2, (w * L * L) / 12, 0, (w * L) / 2, -(w * L * L) / 12]
}

/**
 * Peak |bending moment| along a beam element. `m1`, `m2` are the nodal end
 * moments (fl[2], fl[5]); `w` the uniform transverse intensity. With no span
 * load the extremum is at an end; with one, the internal moment is the linear
 * end-moment field plus the simply-supported parabola, whose peak may be
 * interior — so we scan the span.
 */
export function peakMoment(m1: number, m2: number, w: number, L: number): number {
  if (w === 0) return Math.max(Math.abs(m1), Math.abs(m2))
  // Sagging-positive bending: M_bend(0) = −m1, M_bend(L) = +m2; a +v load hogs.
  const b0 = -m1
  const bL = m2
  const qs = -w
  let peak = 0
  for (let k = 0; k <= 20; k++) {
    const xi = k / 20
    const M = b0 * (1 - xi) + bL * xi + qs * (L * L * 0.5) * xi * (1 - xi)
    peak = Math.max(peak, Math.abs(M))
  }
  return peak
}

/** Rotation matrix (global → local) for a 2-node beam element. */
export function beamRotation(c: number, s: number): number[][] {
  const T = Array.from({ length: 6 }, () => new Array(6).fill(0))
  const r = [
    [c, s, 0],
    [-s, c, 0],
    [0, 0, 1],
  ]
  for (let n = 0; n < 2; n++)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) T[n * 3 + i][n * 3 + j] = r[i][j]
  return T
}

export function matmul(A: number[][], B: number[][]): number[][] {
  const n = A.length
  const m = B[0].length
  const k = B.length
  const C = Array.from({ length: n }, () => new Array(m).fill(0))
  for (let i = 0; i < n; i++)
    for (let p = 0; p < k; p++) {
      const aip = A[i][p]
      if (aip === 0) continue
      for (let j = 0; j < m; j++) C[i][j] += aip * B[p][j]
    }
  return C
}

export function transpose(A: number[][]): number[][] {
  const n = A.length
  const m = A[0].length
  const T = Array.from({ length: m }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) T[j][i] = A[i][j]
  return T
}

function matVecDense(A: number[][], x: number[]): number[] {
  return A.map((row) => row.reduce((s, v, j) => s + v * x[j], 0))
}

export function solveFrame(model: FrameModel): FrameResult {
  const dpn = model.type === 'truss' ? 2 : 3
  const nNodes = model.nodes.length
  const nDof = nNodes * dpn
  const asm = new Assembler(nDof)

  // Assemble global stiffness element by element.
  for (const m of model.members) {
    const { L, c, s } = geom(model, m)
    if (model.type === 'truss') {
      const ke = barStiffness(m.E, m.A, L, c, s)
      const dofs = [m.a * 2, m.a * 2 + 1, m.b * 2, m.b * 2 + 1]
      asm.addBlock(dofs, ke)
    } else {
      const kl = beamLocal(m.E, m.A, m.I, L)
      const T = beamRotation(c, s)
      const ke = matmul(matmul(transpose(T), kl), T)
      const dofs = [m.a * 3, m.a * 3 + 1, m.a * 3 + 2, m.b * 3, m.b * 3 + 1, m.b * 3 + 2]
      asm.addBlock(dofs, ke)
    }
  }
  const K = asm.build()

  // Load vector and free-DOF mask.
  const f = new Float64Array(nDof)
  for (const load of model.loads) {
    f[load.node * dpn] += load.fx
    f[load.node * dpn + 1] += load.fy
    if (dpn === 3) f[load.node * dpn + 2] += load.mz
  }
  // Distributed member loads (frame only): a uniform transverse intensity w
  // (N/m, local +v) becomes the work-equivalent consistent nodal load vector
  //   r = w·[0, L/2, L²/12, 0, L/2, −L²/12]   (local),
  // rotated to global and scattered onto the member's DOFs. Member end forces
  // later subtract this same r to recover true internal actions.
  if (dpn === 3) {
    for (const m of model.members) {
      const w = m.w ?? 0
      if (w === 0) continue
      const { L, c, s } = geom(model, m)
      const rl = equivLoadLocal(w, L)
      const T = beamRotation(c, s)
      const rg = matVecDense(transpose(T), rl)
      const dofs = [m.a * 3, m.a * 3 + 1, m.a * 3 + 2, m.b * 3, m.b * 3 + 1, m.b * 3 + 2]
      for (let k = 0; k < 6; k++) f[dofs[k]] += rg[k]
    }
  }
  const free = new Uint8Array(nDof).fill(1)
  for (let i = 0; i < nNodes; i++) {
    const con = constrainedDofs(model.nodes[i].support)
    for (let d = 0; d < dpn; d++) if (con[d]) free[i * dpn + d] = 0
  }
  // Any node with zero attached members would leave a floating DOF; clamp it so
  // the system stays solvable (the node simply carries no load path).
  const touched = new Uint8Array(nNodes)
  for (const m of model.members) {
    touched[m.a] = 1
    touched[m.b] = 1
  }
  for (let i = 0; i < nNodes; i++)
    if (!touched[i]) for (let d = 0; d < dpn; d++) free[i * dpn + d] = 0

  const sol = solveCG(K, f, free, { tol: 1e-11 })
  const u = sol.x

  // Equilibrium residual on free DOFs and reactions on constrained DOFs.
  const Ku = new Float64Array(nDof)
  matVec(K, u, Ku)
  let maxLoad = 1e-30
  for (let i = 0; i < nDof; i++) maxLoad = Math.max(maxLoad, Math.abs(f[i]))
  let resid = 0
  for (let i = 0; i < nDof; i++) if (free[i]) resid = Math.max(resid, Math.abs(Ku[i] - f[i]))
  const equilibriumResidual = resid / maxLoad

  const nodeDisp: NodeDisp[] = []
  let maxDisp = 0
  for (let i = 0; i < nNodes; i++) {
    const ux = u[i * dpn]
    const uy = u[i * dpn + 1]
    const rot = dpn === 3 ? u[i * dpn + 2] : 0
    nodeDisp.push({ ux, uy, rot })
    maxDisp = Math.max(maxDisp, Math.hypot(ux, uy))
  }

  // Reactions: at each constrained DOF, R = (K·u − f).
  const reactions: Reaction[] = []
  for (let i = 0; i < nNodes; i++) {
    const con = constrainedDofs(model.nodes[i].support)
    if (!con[0] && !con[1] && !con[2]) continue
    const fx = con[0] ? Ku[i * dpn] - f[i * dpn] : 0
    const fy = con[1] ? Ku[i * dpn + 1] - f[i * dpn + 1] : 0
    const mz = dpn === 3 && con[2] ? Ku[i * dpn + 2] - f[i * dpn + 2] : 0
    reactions.push({ node: i, fx, fy, mz })
  }

  // Member end forces.
  const members: MemberResult[] = []
  let maxStress = 0
  let maxAxial = 0
  for (const m of model.members) {
    const { L, c, s } = geom(model, m)
    if (model.type === 'truss') {
      const ua = u[m.a * 2]
      const va = u[m.a * 2 + 1]
      const ub = u[m.b * 2]
      const vb = u[m.b * 2 + 1]
      const da = ua * c + va * s // local axial displacement at a
      const db = ub * c + vb * s // local axial displacement at b
      const axial = ((m.E * m.A) / L) * (db - da)
      const stress = axial / m.A
      members.push({
        axial,
        stress,
        bendingStress: 0,
        maxFiberStress: Math.abs(stress),
        shearA: 0,
        shearB: 0,
        momentA: 0,
        momentB: 0,
        length: L,
      })
      maxStress = Math.max(maxStress, Math.abs(stress))
      maxAxial = Math.max(maxAxial, Math.abs(axial))
    } else {
      const kl = beamLocal(m.E, m.A, m.I, L)
      const T = beamRotation(c, s)
      const ue = [
        u[m.a * 3],
        u[m.a * 3 + 1],
        u[m.a * 3 + 2],
        u[m.b * 3],
        u[m.b * 3 + 1],
        u[m.b * 3 + 2],
      ]
      const dl = matVecDense(T, ue) // local displacements
      const w = m.w ?? 0
      const rl = w !== 0 ? equivLoadLocal(w, L) : null
      // Element end forces: S = k·d − r_eq (subtract the consistent span load).
      const fl = matVecDense(kl, dl)
      if (rl) for (let k = 0; k < 6; k++) fl[k] -= rl[k]
      // fl = [N1, V1, M1, N2, V2, M2]; axial tension positive uses node-2 axial.
      const axial = fl[3]
      const stress = axial / m.A
      // Extreme-fibre distance from a rectangular-section assumption:
      // I = b·h³/12 and A = b·h ⇒ h = √(12I/A), c = h/2 = √(3I/A).
      const cDist = Math.sqrt((3 * m.I) / m.A)
      // Peak bending moment along the span. For a member carrying a uniform
      // load the extremum can fall inside the span, so superpose the linear
      // end-moment field with the simply-supported parabola and scan it.
      const mMax = peakMoment(fl[2], fl[5], w, L)
      const bendingStress = (mMax * cDist) / m.I
      const maxFiberStress = Math.abs(stress) + bendingStress
      members.push({
        axial,
        stress,
        bendingStress,
        maxFiberStress,
        shearA: fl[1],
        shearB: fl[4],
        momentA: fl[2],
        momentB: fl[5],
        length: L,
      })
      maxStress = Math.max(maxStress, maxFiberStress)
      maxAxial = Math.max(maxAxial, Math.abs(axial))
    }
  }

  const stable = sol.converged && Number.isFinite(maxDisp) && equilibriumResidual < 1e-4

  return {
    type: model.type,
    dofPerNode: dpn,
    displacements: u,
    nodeDisp,
    members,
    reactions,
    maxDisp,
    maxStress,
    maxAxial,
    equilibriumResidual,
    stable,
    iterations: sol.iterations,
  }
}
