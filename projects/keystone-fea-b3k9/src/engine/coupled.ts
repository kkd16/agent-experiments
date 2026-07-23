// Transient thermo-mechanical coupling (v12) — the stress *movie*.
//
// v11 gave the steady thermal stress: feed the final temperature field into
// elasticity and read off the self-stress. But the interesting engineering
// question is the *transient*: as a part heats unevenly, the hot skin wants to
// grow against a still-cold core, and the stress can spike *during* the warm-up
// before relaxing toward its (often smaller) steady value — thermal shock. This
// module runs the θ-method conduction transient, then solves the one-way
// thermoelastic problem at a handful of stored instants, so the studio can
// animate the von-Mises field and the deformation climbing in real time.
//
// The mechanical stiffness K and every element's kinematics are assembled *once*
// and reused across all frames — only the thermal load f_th(T(t)) changes — so a
// two-dozen-frame stress movie costs about as much as two dozen CG solves, not
// two dozen full re-assemblies.

import { Assembler, solveCG, type CSR } from './linalg'
import {
  elementMatrices,
  extrapMatrix,
  planeStressD,
  type GaussKinematics,
  type QOrder,
} from './isoparam'
import { edgeNodesQ } from './quadmesh'
import { solveThermalTransient, type ThermalInput, type TransientOptions } from './thermal'
import type { MechFix } from './thermoelastic'

export interface CoupledMech {
  E: number
  nu: number
  alpha: number
  thickness: number
  Tref: number
  fix: MechFix[]
}

export interface TeFrame {
  t: number
  nodalVonMises: Float64Array
  dispX: Float64Array
  dispY: Float64Array
  maxVonMises: number
  maxDisp: number
}

export interface TransientTeResult {
  ok: boolean
  frames: TeFrame[]
  /** Stable colour / deflection scales across the whole movie. */
  maxVonMisesOverall: number
  maxDispOverall: number
  /** Instant (s) at which the von-Mises peak occurs — the thermal-shock moment. */
  peakTime: number
}

export function solveTransientThermoelastic(
  input: ThermalInput,
  mech: CoupledMech,
  opts: TransientOptions & { stressFrames?: number } = {},
): TransientTeResult {
  const tr = solveThermalTransient(input, opts)
  if (!tr.ok || tr.frames.length === 0) {
    return { ok: false, frames: [], maxVonMisesOverall: 0, maxDispOverall: 0, peakTime: 0 }
  }

  const mesh = input.mesh
  const order: QOrder = mesh.order
  const nne = order
  const nDof = mesh.nodeCount * 2
  const D = planeStressD(mech.E, mech.nu)

  // --- assemble K + cache kinematics once ---------------------------------
  const asm = new Assembler(nDof)
  const elemNodes: number[][] = []
  const elemKin: GaussKinematics[][] = []
  const touched = new Uint8Array(mesh.nodeCount)
  for (let e = 0; e < mesh.elemCount; e++) {
    const base = e * nne
    const nodes = new Array<number>(nne)
    for (let i = 0; i < nne; i++) nodes[i] = mesh.elems[base + i]
    const xs = nodes.map((n) => mesh.x[n])
    const ys = nodes.map((n) => mesh.y[n])
    const { Ke, kin } = elementMatrices(order, xs, ys, D, 0, mech.thickness)
    const dofs: number[] = []
    for (const n of nodes) {
      dofs.push(n * 2, n * 2 + 1)
      touched[n] = 1
    }
    asm.addBlock(dofs, Ke)
    elemNodes.push(nodes)
    elemKin.push(kin)
  }
  const K: CSR = asm.build()

  // Free-DOF mask (shared by every frame).
  const free = new Uint8Array(nDof).fill(1)
  for (let n = 0; n < mesh.nodeCount; n++)
    if (!touched[n]) {
      free[n * 2] = 0
      free[n * 2 + 1] = 0
    }
  for (const g of mech.fix) {
    const nodes = g.edge ? edgeNodesQ(mesh, g.edge) : (g.nodes ?? [])
    for (const n of nodes) for (const d of g.dofs) free[n * 2 + (d === 'x' ? 0 : 1)] = 0
  }

  const extrap = extrapMatrix(order)

  // --- solve each stored temperature frame --------------------------------
  const nStore = tr.frames.length
  const want = Math.max(2, Math.min(opts.stressFrames ?? 30, nStore))
  // Explicit indices spanning first→last so the movie always ends on the
  // steady field (needed for the consistency benchmark and a clean loop).
  const idxList: number[] = []
  for (let i = 0; i < want; i++) {
    const idx = Math.round((i * (nStore - 1)) / (want - 1))
    if (idxList[idxList.length - 1] !== idx) idxList.push(idx)
  }
  const frames: TeFrame[] = []
  let maxVonMisesOverall = 0
  let maxDispOverall = 0
  let peakTime = 0
  let warm: Float64Array | undefined

  for (const fi of idxList) {
    const T = tr.frames[fi]
    const t = tr.times[fi]
    // Thermal load f_th(T) = ∫ Bᵀ D ε₀ dΩ.
    const f = new Float64Array(nDof)
    for (let e = 0; e < mesh.elemCount; e++) {
      const nodes = elemNodes[e]
      const dofs: number[] = []
      for (const n of nodes) dofs.push(n * 2, n * 2 + 1)
      for (const gk of elemKin[e]) {
        let Tg = 0
        for (let i = 0; i < nne; i++) Tg += gk.N[i] * T[nodes[i]]
        const e0 = mech.alpha * (Tg - mech.Tref)
        const s0 = D[0][0] * e0 + D[0][1] * e0
        const s1 = D[1][0] * e0 + D[1][1] * e0
        const scale = gk.w * Math.abs(gk.detJ) * mech.thickness
        const ndof = 2 * nne
        for (let a = 0; a < ndof; a++) f[dofs[a]] += (gk.B[0][a] * s0 + gk.B[1][a] * s1) * scale
      }
    }
    const sol = solveCG(K, f, free, { tol: 1e-10, maxIter: 40 * nDof, x0: warm })
    warm = sol.x
    const u = sol.x

    const dispX = new Float64Array(mesh.nodeCount)
    const dispY = new Float64Array(mesh.nodeCount)
    let maxDisp = 0
    for (let n = 0; n < mesh.nodeCount; n++) {
      dispX[n] = u[n * 2]
      dispY[n] = u[n * 2 + 1]
      maxDisp = Math.max(maxDisp, Math.hypot(dispX[n], dispY[n]))
    }

    // Recover the smooth nodal von-Mises field (with the thermal ε₀ correction).
    const nodalAccum = new Float64Array(mesh.nodeCount)
    const nodalCount = new Float64Array(mesh.nodeCount)
    let maxVm = 0
    for (let e = 0; e < mesh.elemCount; e++) {
      const nodes = elemNodes[e]
      const ue: number[] = []
      for (const n of nodes) ue.push(u[n * 2], u[n * 2 + 1])
      const kin = elemKin[e]
      const gVm: number[] = []
      for (const gk of kin) {
        let Tg = 0
        for (let i = 0; i < nne; i++) Tg += gk.N[i] * T[nodes[i]]
        const e0 = mech.alpha * (Tg - mech.Tref)
        const ndof = 2 * nne
        const strain = [0, 0, 0]
        for (let r = 0; r < 3; r++) {
          let s = 0
          for (let c = 0; c < ndof; c++) s += gk.B[r][c] * ue[c]
          strain[r] = s
        }
        const m0 = [strain[0] - e0, strain[1] - e0, strain[2]]
        const sxx = D[0][0] * m0[0] + D[0][1] * m0[1]
        const syy = D[1][0] * m0[0] + D[1][1] * m0[1]
        const sxy = D[2][2] * m0[2]
        gVm.push(Math.sqrt(sxx * sxx - sxx * syy + syy * syy + 3 * sxy * sxy))
      }
      const ng = kin.length
      for (let a = 0; a < nne; a++) {
        let s = 0
        for (let gi = 0; gi < ng; gi++) s += extrap[a][gi] * gVm[gi]
        nodalAccum[nodes[a]] += s
        nodalCount[nodes[a]] += 1
      }
    }
    const nodalVonMises = new Float64Array(mesh.nodeCount)
    for (let n = 0; n < mesh.nodeCount; n++) {
      const v = nodalCount[n] > 0 ? nodalAccum[n] / nodalCount[n] : 0
      nodalVonMises[n] = v
      if (v > maxVm) maxVm = v
    }

    frames.push({ t, nodalVonMises, dispX, dispY, maxVonMises: maxVm, maxDisp })
    if (maxVm > maxVonMisesOverall) {
      maxVonMisesOverall = maxVm
      peakTime = t
    }
    maxDispOverall = Math.max(maxDispOverall, maxDisp)
  }

  const ok = frames.length > 0 && Number.isFinite(maxVonMisesOverall) && Number.isFinite(maxDispOverall)
  return { ok, frames, maxVonMisesOverall, maxDispOverall, peakTime }
}
