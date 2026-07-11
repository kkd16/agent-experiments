// Nonlinear pushover analysis — plastic hinges and collapse.
//
// Everything else in the engine is linear-elastic: the response scales with the
// load. Real steel does not. Past first yield a cross-section keeps carrying
// load while a *plastic hinge* forms — the bending moment saturates at the
// plastic capacity Mₚ = Z·Fᵧ and the section rotates freely. Load redistributes
// to the still-elastic parts until enough hinges turn the frame into a
// *mechanism*, and it collapses. The load multiplier at that instant is the
// collapse load factor — the quantity plastic (limit) design is built on.
//
// The method here is **event-to-event elastic–plastic hinge tracking**:
//
//   1. Solve the current (partially-hinged) structure elastically for the
//      reference-load *rate* dU/dλ.
//   2. Find the smallest load increment Δλ that brings the next un-hinged
//      section to ±Mₚ; accumulate λ, the deflection, and the member end forces.
//   3. Insert a plastic hinge there — a moment release, applied by static
//      condensation of that rotational DOF, with the section's moment frozen at
//      ±Mₚ (its elastic increment thereafter is exactly zero).
//   4. Repeat until the reduced stiffness goes singular (a Cholesky that fails):
//      that is the collapse mechanism, and the accumulated λ is the collapse
//      load factor.
//
// The trace of (control deflection, load factor) is the **capacity curve** —
// rising, softening at each hinge, flat-topping at collapse. Results are
// cross-checked live in validate.ts against classical plastic limit analysis
// (4Mₚ/L, 6Mₚ/L, 8Mₚ/L, 11.66Mₚ/L², portal sway 4Mₚ/h).
//
// Concentrated plasticity: hinges form at member ends (nodes). Subdivide a
// member into several elements — as the presets do — to let a hinge appear in a
// span. Distributed member loads w are applied as work-equivalent transverse
// *nodal* forces (lumped, no fixed-end moments), which converges to the exact
// span behaviour on a fine mesh and keeps the hinge bookkeeping clean.

import {
  beamRotation,
  constrainedDofs,
  geom,
  matmul,
  transpose,
  DEFAULT_FY,
  type FrameModel,
  type FMember,
  type NodeDisp,
} from './frame'
import { findSection, fibreDistance } from './sections'
import { choleskyLower, forwardSolve, backSolveT, jacobiEig, zeros, type Mat } from './eigen'
import { toNodeDisp } from './dynamics'

// ---------------------------------------------------------------- capacity data

/** The plastic-moment capacity of a member: an explicit Mₚ override, else the
 *  section's plastic modulus × yield, else a shape-factor estimate from I and c. */
export function memberMp(m: FMember): number {
  const Fy = m.Fy ?? DEFAULT_FY
  if (m.Mp && m.Mp > 0) return m.Mp
  const sec = findSection(m.section)
  if (sec) return sec.Z * Fy
  // Fallback: plastic modulus Z ≈ shape-factor × elastic modulus S (= I/c). A
  // shape factor of 1.5 is the solid-rectangle value — a reasonable generic
  // default when the section geometry is unknown.
  const c = fibreDistance(m.A, m.I, m.c)
  const S = m.I / Math.max(c, 1e-12)
  return 1.5 * S * Fy
}

// ---------------------------------------------------------------- element matrices

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

/** Local 6×6 geometric stiffness of a beam-column carrying axial force N
 *  (tension positive). Used only for the optional second-order (P-Δ) pushover. */
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

/** Add matrix B into A in place. */
function addInto(A: Mat, B: Mat): void {
  for (let i = 0; i < A.length; i++) for (let j = 0; j < A.length; j++) A[i][j] += B[i][j]
}

// ------------------------------------------------------------- moment releases

interface ReleaseInfo {
  /** Condensed local stiffness (released rows/cols zeroed). */
  Kc: Mat
  /** Released local DOF indices (⊆ {2, 5}). */
  C: number[]
  /** Kept local DOF indices. */
  R: number[]
  /** Inverse of the released-block K_CC (|C|×|C|), for rotation recovery. */
  KccInv: Mat
  /** The original stiffness, for end-force recovery. */
  K: Mat
}

/** Invert a 1×1 or 2×2 symmetric matrix (safe for the released rotational block). */
function invSmall(M: Mat): Mat {
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

/**
 * Static condensation of the released rotational DOFs from a local element
 * stiffness. `rel[i]` marks a released DOF (only indices 2, 5 are ever set).
 * The condensed matrix K_RR − K_RC·K_CC⁻¹·K_CR is scattered back into a 6×6 with
 * the released rows/cols zeroed, so a hinged end contributes no rotational
 * stiffness to the assembly. The released rotation is recovered afterwards from
 *   θ_C = −K_CC⁻¹·K_CR·u_R.
 */
function releaseInfo(K: Mat, rel: boolean[]): ReleaseInfo {
  const C: number[] = []
  const R: number[] = []
  for (let i = 0; i < 6; i++) (rel[i] ? C : R).push(i)
  const Kc = K.map((row) => row.slice())
  if (C.length === 0) return { Kc, C, R, KccInv: [], K }
  const Kcc: Mat = C.map((ci) => C.map((cj) => K[ci][cj]))
  const KccInv = invSmall(Kcc)
  // Kc_RR -= K_RC · K_CC⁻¹ · K_CR
  for (let ri = 0; ri < R.length; ri++) {
    for (let rj = 0; rj < R.length; rj++) {
      let s = 0
      for (let a = 0; a < C.length; a++)
        for (let b = 0; b < C.length; b++) s += K[R[ri]][C[a]] * KccInv[a][b] * K[C[b]][R[rj]]
      Kc[R[ri]][R[rj]] -= s
    }
  }
  // Zero the released rows/cols.
  for (const c of C)
    for (let j = 0; j < 6; j++) {
      Kc[c][j] = 0
      Kc[j][c] = 0
    }
  return { Kc, C, R, KccInv, K }
}

/** Recover the released rotations into a full local displacement vector dl. */
function recoverReleased(info: ReleaseInfo, dl: number[]): void {
  const { C, R, KccInv, K } = info
  if (C.length === 0) return
  const rhs = C.map((ci) => {
    let s = 0
    for (const r of R) s += K[ci][r] * dl[r]
    return s
  })
  for (let a = 0; a < C.length; a++) {
    let s = 0
    for (let b = 0; b < C.length; b++) s += KccInv[a][b] * rhs[b]
    dl[C[a]] = -s
  }
}

// --------------------------------------------------------------------- results

export interface HingeEvent {
  /** 1-based order in which this hinge formed. */
  order: number
  /** Load factor at which it formed. */
  lambda: number
  /** Control-DOF deflection at formation (signed positive). */
  disp: number
  member: number
  end: 'a' | 'b'
  node: number
  /** Undeformed hinge location, for drawing. */
  x: number
  y: number
  /** Sign of the plastic moment (+sagging / −hogging in local terms). */
  sign: number
  Mp: number
}

export interface CapacityPoint {
  /** Control-DOF deflection (signed positive). */
  disp: number
  /** Load factor. */
  lambda: number
  /** Hinges formed by this point. */
  hinges: number
}

export interface PushoverResult {
  kind: 'pushover'
  ok: boolean
  note?: string
  dofPerNode: number
  nNodes: number
  events: HingeEvent[]
  /** Capacity (pushover) curve, origin first, collapse plateau last. */
  curve: CapacityPoint[]
  /** Accumulated deflected shape at each capacity point (same length as curve). */
  states: NodeDisp[][]
  collapse: boolean
  collapseLambda: number
  collapseDisp: number
  /** First-yield load factor (the elastic limit) — the first hinge. */
  firstYieldLambda: number
  /** Reserve = collapseLambda / firstYieldLambda (redistribution capacity). */
  reserve: number
  controlNode: number
  controlDir: 'x' | 'y'
  controlLabel: string
  refLoadMag: number
  secondOrder: boolean
}

/** Cap on total DOFs for the dense pushover solver. */
const MAX_DOF = 360

const EPS = 1e-9
/** Relative smallest/largest eigenvalue floor below which the tangent stiffness
 *  is treated as singular (a collapse mechanism). */
const SINGULAR_TOL = 1e-9

export interface PushoverOpts {
  /** Include the geometric (P-Δ) stiffness from the current axial forces. */
  secondOrder?: boolean
  /** Safety cap on hinge events. */
  maxEvents?: number
}

/**
 * Incremental elastic–plastic pushover of a plane frame. Returns the capacity
 * curve, the ordered hinge sequence, the collapse load factor, and the deflected
 * shape at every event (for animation).
 */
export function solvePushover(model: FrameModel, opts: PushoverOpts = {}): PushoverResult {
  const dpn = 3
  const nNodes = model.nodes.length
  const nDof = nNodes * dpn
  const secondOrder = !!opts.secondOrder
  const empty: PushoverResult = {
    kind: 'pushover',
    ok: false,
    dofPerNode: dpn,
    nNodes,
    events: [],
    curve: [],
    states: [],
    collapse: false,
    collapseLambda: 0,
    collapseDisp: 0,
    firstYieldLambda: 0,
    reserve: 0,
    controlNode: 0,
    controlDir: 'x',
    controlLabel: '',
    refLoadMag: 0,
    secondOrder,
  }

  if (model.type !== 'frame')
    return { ...empty, note: 'Pushover needs a frame (bending members) — switch to a frame model.' }
  if (model.members.length === 0) return { ...empty, note: 'Add members to run a pushover.' }
  if (nDof > MAX_DOF) return { ...empty, note: `Model too large for the dense pushover (${nDof} DOF).` }

  // ---- reference load vector (nodal loads + lumped transverse member loads) ----
  const F = new Float64Array(nDof)
  for (const l of model.loads) {
    F[l.node * 3] += l.fx
    F[l.node * 3 + 1] += l.fy
    F[l.node * 3 + 2] += l.mz
  }
  let refLoadMag = 0
  for (const l of model.loads) refLoadMag = Math.max(refLoadMag, Math.hypot(l.fx, l.fy))
  // Distributed member loads → work-equivalent transverse nodal forces (lumped).
  const memGeom = model.members.map((m) => geom(model, m))
  model.members.forEach((m, mi) => {
    const w = m.w ?? 0
    if (w === 0) return
    const { L, c, s } = memGeom[mi]
    const half = (w * L) / 2 // local +v transverse force at each end
    // Rotate local +v (0, half) to global: gx = -s*half? local axes: t=(c,s), n=(-s,c).
    const gx = -s * half
    const gy = c * half
    F[m.a * 3] += gx
    F[m.a * 3 + 1] += gy
    F[m.b * 3] += gx
    F[m.b * 3 + 1] += gy
    refLoadMag = Math.max(refLoadMag, Math.abs(w * L))
  })

  let anyLoad = false
  for (let i = 0; i < nDof; i++) if (Math.abs(F[i]) > 0) anyLoad = true
  if (!anyLoad) return { ...empty, note: 'Apply a load to push the structure over.' }

  // ---- free-DOF list (supports + untouched-node clamp), identical to solveFrame ----
  const freeMask = new Uint8Array(nDof).fill(1)
  for (let i = 0; i < nNodes; i++) {
    const con = constrainedDofs(model.nodes[i].support)
    for (let d = 0; d < 3; d++) if (con[d]) freeMask[i * 3 + d] = 0
  }
  const touched = new Uint8Array(nNodes)
  for (const m of model.members) {
    touched[m.a] = 1
    touched[m.b] = 1
  }
  for (let i = 0; i < nNodes; i++)
    if (!touched[i]) for (let d = 0; d < 3; d++) freeMask[i * 3 + d] = 0
  const free: number[] = []
  for (let i = 0; i < nDof; i++) if (freeMask[i]) free.push(i)
  if (free.length === 0) return { ...empty, note: 'No free DOFs — the structure is fully constrained.' }

  const memberDofs = model.members.map((m) => [
    m.a * 3, m.a * 3 + 1, m.a * 3 + 2, m.b * 3, m.b * 3 + 1, m.b * 3 + 2,
  ])
  const Ts = model.members.map((_, mi) => beamRotation(memGeom[mi].c, memGeom[mi].s))
  const Tts = Ts.map((T) => transpose(T))
  const Mp = model.members.map((m) => memberMp(m))

  // ---- incremental state ----
  const relA = new Array(model.members.length).fill(false) // end-a rotation released
  const relB = new Array(model.members.length).fill(false) // end-b rotation released
  const Sacc = model.members.map(() => new Float64Array(6)) // accumulated local end forces
  const uAcc = new Float64Array(nDof)
  let lambda = 0
  const events: HingeEvent[] = []
  const curve: CapacityPoint[] = [{ disp: 0, lambda: 0, hinges: 0 }]
  const states: NodeDisp[][] = [toNodeDisp(new Float64Array(nDof), 3, nNodes)]

  // Control DOF fixed after the first solve.
  let controlDof = -1
  let controlSign = 1

  const maxEvents = opts.maxEvents ?? free.length + model.members.length * 2 + 40

  // Assemble the reduced free×free stiffness for the current release/axial state.
  const assembleReduced = (): { Kr: Mat; infos: ReleaseInfo[] } => {
    const full = zeros(nDof)
    const infos: ReleaseInfo[] = []
    model.members.forEach((m, mi) => {
      const { L } = memGeom[mi]
      const Kl = beamLocalK(m.E, m.A, m.I, L)
      if (secondOrder) addInto(Kl, beamGeometricLocal(Sacc[mi][3], L))
      const info = releaseInfo(Kl, [false, false, relA[mi], false, false, relB[mi]])
      infos.push(info)
      const Ke = matmul(matmul(Tts[mi], info.Kc), Ts[mi])
      const dofs = memberDofs[mi]
      for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) full[dofs[a]][dofs[b]] += Ke[a][b]
    })
    const Kr = zeros(free.length)
    for (let i = 0; i < free.length; i++)
      for (let j = 0; j < free.length; j++) Kr[i][j] = full[free[i]][free[j]]
    return { Kr, infos }
  }

  let collapse = false
  let mechShape: NodeDisp[] | null = null

  for (let step = 0; step < maxEvents; step++) {
    const { Kr, infos } = assembleReduced()

    // Guard: free DOFs with (near-)zero diagonal carry no stiffness — a fully
    // released node rotation. Solve only over the active DOFs; the rest stay 0.
    let maxDiag = 0
    for (let i = 0; i < Kr.length; i++) maxDiag = Math.max(maxDiag, Math.abs(Kr[i][i]))
    const diagTol = EPS * (maxDiag || 1)
    const active: number[] = []
    for (let i = 0; i < Kr.length; i++) if (Math.abs(Kr[i][i]) > diagTol) active.push(i)

    const Ksub = active.map((i) => active.map((j) => Kr[i][j]))

    // Singularity / stability test by the spectrum, not the Cholesky pivot sign.
    // A stable tangent stiffness keeps its smallest eigenvalue a healthy fraction
    // of its largest (empirically ≥ ~1e-5 here); at collapse the mechanism drives
    // it to ~0 (or negative, once P-Δ softening is included). A relative floor of
    // 1e-9 separates the two by many orders and never trips on the natural
    // axial-vs-bending stiffness spread.
    const eig = jacobiEig(Ksub)
    const eigMax = eig.values[eig.values.length - 1]
    if (!(eigMax > 0) || eig.values[0] < SINGULAR_TOL * eigMax) {
      collapse = true
      mechShape = expandMechanism(eig.vectors, active, free, nDof, nNodes)
      break
    }
    const L = choleskyLower(Ksub)!
    const Fsub = active.map((i) => F[free[i]])
    const ysub = backSolveT(L, forwardSolve(L, Fsub))
    // Expand incremental displacement rate to the full DOF layout.
    const du = new Float64Array(nDof)
    active.forEach((ai, k) => (du[free[ai]] = ysub[k]))

    if (controlDof < 0) {
      // Pick the translational DOF that moves most in the first elastic step.
      let best = -1
      let bestMag = 0
      for (const g of free) {
        if (g % 3 === 2) continue // skip rotations
        if (Math.abs(du[g]) > bestMag) {
          bestMag = Math.abs(du[g])
          best = g
        }
      }
      controlDof = best >= 0 ? best : free[0]
      controlSign = du[controlDof] < 0 ? -1 : 1
    }

    // Incremental member end-force rates dS, and the next hinge to yield.
    const dS = model.members.map((_, mi) => {
      const dofs = memberDofs[mi]
      const due = dofs.map((g) => du[g])
      const dl = matVec6(Ts[mi], due)
      recoverReleased(infos[mi], dl)
      return matVec6(infos[mi].K, dl)
    })

    let bestDl = Infinity
    let winMi = -1
    let winIdx = -1 // 2 (end a) or 5 (end b)
    for (let mi = 0; mi < model.members.length; mi++) {
      const cap = Mp[mi]
      if (cap <= 0) continue
      for (const idx of [2, 5]) {
        const released = idx === 2 ? relA[mi] : relB[mi]
        if (released) continue
        const dM = dS[mi][idx]
        if (Math.abs(dM) < 1e-12) continue
        const Mcur = Sacc[mi][idx]
        const target = dM > 0 ? cap : -cap
        let dl = (target - Mcur) / dM
        if (dl < 0) dl = 0 // numerical overshoot → yield immediately
        if (dl < bestDl) {
          bestDl = dl
          winMi = mi
          winIdx = idx
        }
      }
    }

    if (winMi < 0 || !Number.isFinite(bestDl)) {
      // No section can reach Mₚ under increasing load: the structure shakes down
      // / stays elastic. No collapse mechanism within reach.
      break
    }

    // Accumulate this increment.
    lambda += bestDl
    for (let i = 0; i < nDof; i++) uAcc[i] += bestDl * du[i]
    for (let mi = 0; mi < model.members.length; mi++)
      for (let k = 0; k < 6; k++) Sacc[mi][k] += bestDl * dS[mi][k]

    // Insert the hinge; snap its moment exactly to ±Mₚ.
    const sign = Math.sign(Sacc[winMi][winIdx]) || 1
    Sacc[winMi][winIdx] = sign * Mp[winMi]
    if (winIdx === 2) relA[winMi] = true
    else relB[winMi] = true

    const m = model.members[winMi]
    const node = winIdx === 2 ? m.a : m.b
    const disp = uAcc[controlDof] * controlSign
    events.push({
      order: events.length + 1,
      lambda,
      disp,
      member: winMi,
      end: winIdx === 2 ? 'a' : 'b',
      node,
      x: model.nodes[node].x,
      y: model.nodes[node].y,
      sign,
      Mp: Mp[winMi],
    })
    curve.push({ disp, lambda, hinges: events.length })
    states.push(toNodeDisp(uAcc, 3, nNodes))
  }

  if (events.length === 0)
    return {
      ...empty,
      note: collapse
        ? 'The structure is a mechanism as drawn (unstable before any load).'
        : 'No plastic hinge forms under this load — check supports, loads and Mₚ.',
    }

  const firstYieldLambda = events[0].lambda
  const collapseLambda = lambda
  let collapseDisp = uAcc[controlDof] * controlSign

  // Collapse plateau: sweep the structure along the mechanism at constant load.
  if (collapse) {
    const mech = mechShape
    if (mech) {
      // Scale so the control deflection grows by ~half its value again (visible).
      const growth = Math.max(Math.abs(collapseDisp) * 0.8, 0.02)
      const mechAtControl = mech[Math.floor(controlDof / 3)]
      const mc = controlDof % 3 === 0 ? mechAtControl.ux : mechAtControl.uy
      const scale = Math.abs(mc) > 1e-9 ? (growth / Math.abs(mc)) * Math.sign(mc || 1) * controlSign : growth
      const plateau = new Float64Array(nDof)
      for (let i = 0; i < nNodes; i++) {
        plateau[i * 3] = uAcc[i * 3] + mech[i].ux * scale
        plateau[i * 3 + 1] = uAcc[i * 3 + 1] + mech[i].uy * scale
        plateau[i * 3 + 2] = uAcc[i * 3 + 2] + mech[i].rot * scale
      }
      collapseDisp = plateau[controlDof] * controlSign
      curve.push({ disp: collapseDisp, lambda: collapseLambda, hinges: events.length })
      states.push(toNodeDisp(plateau, 3, nNodes))
    }
  }

  const cnode = Math.floor(controlDof / 3)
  const cdir: 'x' | 'y' = controlDof % 3 === 0 ? 'x' : 'y'

  return {
    kind: 'pushover',
    ok: true,
    dofPerNode: dpn,
    nNodes,
    events,
    curve,
    states,
    collapse,
    collapseLambda,
    collapseDisp,
    firstYieldLambda,
    reserve: firstYieldLambda > 0 ? collapseLambda / firstYieldLambda : 0,
    controlNode: cnode,
    controlDir: cdir,
    controlLabel: `joint ${cnode} ${cdir === 'x' ? 'uₓ' : 'u_y'}`,
    refLoadMag,
    secondOrder,
    note: collapse
      ? undefined
      : 'No mechanism formed — the load pattern shakes down (the structure stabilises after the hinges shown).',
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

/** Expand the singular tangent's null eigenvector (over active free DOFs) into a
 *  full nodal collapse-mechanism shape, normalised to unit peak translation. The
 *  first ascending eigenvalue is the (near-zero) mechanism mode. */
function expandMechanism(
  vectors: Mat,
  active: number[],
  free: number[],
  nDof: number,
  nNodes: number,
): NodeDisp[] | null {
  const x = new Float64Array(nDof)
  active.forEach((ai, k) => (x[free[ai]] = vectors[k][0]))
  let peak = 0
  for (let i = 0; i < nNodes; i++) peak = Math.max(peak, Math.hypot(x[i * 3], x[i * 3 + 1]))
  if (peak < 1e-30) return null
  for (let i = 0; i < nDof; i++) x[i] /= peak
  return toNodeDisp(x, 3, nNodes)
}

/**
 * Sample the pushover at a pseudo-time s ∈ [0, curve.length−1]: the deflected
 * shape (linearly interpolated between stored states), the load factor, the
 * control deflection, and how many hinges have formed. Drives the animation.
 */
export function pushoverAt(res: PushoverResult, s: number): {
  shape: NodeDisp[]
  lambda: number
  disp: number
  hinges: number
} {
  const n = res.curve.length
  if (n === 0) return { shape: [], lambda: 0, disp: 0, hinges: 0 }
  const clamped = Math.max(0, Math.min(n - 1, s))
  const i0 = Math.floor(clamped)
  const i1 = Math.min(n - 1, i0 + 1)
  const f = clamped - i0
  const a = res.states[i0]
  const b = res.states[i1]
  const shape = a.map((d, k) => ({
    ux: d.ux + (b[k].ux - d.ux) * f,
    uy: d.uy + (b[k].uy - d.uy) * f,
    rot: d.rot + (b[k].rot - d.rot) * f,
  }))
  const lambda = res.curve[i0].lambda + (res.curve[i1].lambda - res.curve[i0].lambda) * f
  const disp = res.curve[i0].disp + (res.curve[i1].disp - res.curve[i0].disp) * f
  return { shape, lambda, disp, hinges: res.curve[i0].hinges }
}
