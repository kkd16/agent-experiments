// Thermoelasticity — the *coupling* half of the multiphysics chapter (v11).
//
// A temperature change makes a body want to expand by the free thermal strain
// ε₀ = αΔT[1,1,0]ᵀ. If the body is free to do so it simply grows and carries no
// stress; if any part is *restrained* — clamped edges, a stiff neighbour, a cold
// core against a hot skin — the thwarted expansion turns into stress with **no
// external load at all**. That is the everyday failure mode thermoelasticity
// captures: thermal ratcheting, bimetallic bending, a bridge that buckles in a
// heatwave, a chip that cracks its solder.
//
// The discretisation is the standard one-way coupling: solve the heat problem
// first (thermal.ts), then feed its nodal temperature field into elasticity as a
// body-equivalent **thermal load**
//     f_th = ∫ Bᵀ D ε₀ t dΩ,   ε₀ = α (T(x) − T_ref) [1,1,0]ᵀ,
// solve K·u = f_th (+ any real mechanical load), and recover the *total* stress
//     σ = D (B·u − ε₀).
//
// It reuses the exact Q4/Q8 element stiffness the continuum tab is validated on
// (`isoparam.elementMatrices` / `elementKinematics`), so the mechanical side is
// already trusted — only the thermal load and the ε₀ stress correction are new.

import { Assembler, matVec, solveCG } from './linalg'
import {
  elementKinematics,
  elementMatrices,
  extrapMatrix,
  planeStressD,
  type QOrder,
} from './isoparam'
import { edgeNodesQ, type EdgeName, type QuadMesh } from './quadmesh'

export interface MechFix {
  edge?: EdgeName
  nodes?: number[]
  dofs: ('x' | 'y')[]
}

export interface ThermoelasticInput {
  mesh: QuadMesh
  E: number
  nu: number
  /** Coefficient of thermal expansion α (1/K). */
  alpha: number
  thickness: number
  /** Nodal temperature field (from the thermal solve). */
  T: Float64Array
  /** Stress-free reference temperature (°C). */
  Tref: number
  fix: MechFix[]
  pointLoads?: { node: number; fx: number; fy: number }[]
}

export interface TeElementStress {
  sxx: number
  syy: number
  sxy: number
  vm: number
  cx: number
  cy: number
}

export interface ThermoelasticResult {
  dispX: Float64Array
  dispY: Float64Array
  maxDisp: number
  elementStress: TeElementStress[]
  nodalVonMises: Float64Array
  maxVonMises: number
  minVonMises: number
  /** Peak thermal load magnitude — a scale for the "no external load" story. */
  strainEnergy: number
  equilibriumResidual: number
  stable: boolean
  iterations: number
}

function elemNodes(mesh: QuadMesh, e: number): number[] {
  const nne = mesh.order
  const base = e * nne
  const out = new Array<number>(nne)
  for (let i = 0; i < nne; i++) out[i] = mesh.elems[base + i]
  return out
}

export function solveThermoelastic(input: ThermoelasticInput): ThermoelasticResult {
  const { mesh, E, nu, alpha, thickness, T, Tref } = input
  const order: QOrder = mesh.order
  const nne = order
  const nDof = mesh.nodeCount * 2
  const D = planeStressD(E, nu)
  const asm = new Assembler(nDof)
  const f = new Float64Array(nDof)

  for (let e = 0; e < mesh.elemCount; e++) {
    const nodes = elemNodes(mesh, e)
    const xs = nodes.map((n) => mesh.x[n])
    const ys = nodes.map((n) => mesh.y[n])
    const { Ke, kin } = elementMatrices(order, xs, ys, D, 0, thickness)
    const dofs: number[] = []
    for (const n of nodes) dofs.push(n * 2, n * 2 + 1)
    asm.addBlock(dofs, Ke)
    // Thermal load f_th += Bᵀ D ε₀ · (w|J|t) at each Gauss point.
    for (const g of kin) {
      let Tg = 0
      for (let i = 0; i < nne; i++) Tg += g.N[i] * T[nodes[i]]
      const dT = Tg - Tref
      const e0 = alpha * dT
      // ε₀ = [e0, e0, 0]; D·ε₀:
      const s0 = D[0][0] * e0 + D[0][1] * e0
      const s1 = D[1][0] * e0 + D[1][1] * e0
      const scale = g.w * Math.abs(g.detJ) * thickness
      const ndof = 2 * nne
      for (let a = 0; a < ndof; a++) {
        // Bᵀ(:,a) · [s0, s1, 0]
        f[dofs[a]] += (g.B[0][a] * s0 + g.B[1][a] * s1) * scale
      }
    }
  }

  for (const pl of input.pointLoads ?? []) {
    f[pl.node * 2] += pl.fx
    f[pl.node * 2 + 1] += pl.fy
  }

  const K = asm.build()

  // Free-DOF mask.
  const free = new Uint8Array(nDof).fill(1)
  const touched = new Uint8Array(mesh.nodeCount)
  for (let e = 0; e < mesh.elemCount; e++) for (const n of elemNodes(mesh, e)) touched[n] = 1
  for (let n = 0; n < mesh.nodeCount; n++)
    if (!touched[n]) {
      free[n * 2] = 0
      free[n * 2 + 1] = 0
    }
  for (const g of input.fix) {
    const nodes = g.edge ? edgeNodesQ(mesh, g.edge) : (g.nodes ?? [])
    for (const n of nodes) for (const d of g.dofs) free[n * 2 + (d === 'x' ? 0 : 1)] = 0
  }

  const sol = solveCG(K, f, free, { tol: 1e-11, maxIter: 40 * nDof })
  const u = sol.x

  const dispX = new Float64Array(mesh.nodeCount)
  const dispY = new Float64Array(mesh.nodeCount)
  let maxDisp = 0
  for (let n = 0; n < mesh.nodeCount; n++) {
    dispX[n] = u[n * 2]
    dispY[n] = u[n * 2 + 1]
    maxDisp = Math.max(maxDisp, Math.hypot(dispX[n], dispY[n]))
  }

  // Stress recovery with the thermal correction σ = D(Bu − ε₀).
  const extrap = extrapMatrix(order)
  const elementStress: TeElementStress[] = []
  const nodalAccum = new Float64Array(mesh.nodeCount)
  const nodalCount = new Float64Array(mesh.nodeCount)
  let maxVonMises = 0
  let minVonMises = Infinity
  let strainEnergy = 0
  for (let e = 0; e < mesh.elemCount; e++) {
    const nodes = elemNodes(mesh, e)
    const xs = nodes.map((n) => mesh.x[n])
    const ys = nodes.map((n) => mesh.y[n])
    const kin = elementKinematics(order, xs, ys)
    const ue: number[] = []
    for (const n of nodes) ue.push(u[n * 2], u[n * 2 + 1])
    const gVm: number[] = []
    let cxx = 0
    let cyy = 0
    let cxy = 0
    let cx = 0
    let cy = 0
    for (const g of kin) {
      let Tg = 0
      for (let i = 0; i < nne; i++) Tg += g.N[i] * T[nodes[i]]
      const e0 = alpha * (Tg - Tref)
      const strain = [0, 0, 0]
      const ndof = 2 * nne
      for (let r = 0; r < 3; r++) {
        let s = 0
        for (let c = 0; c < ndof; c++) s += g.B[r][c] * ue[c]
        strain[r] = s
      }
      const me0 = [strain[0] - e0, strain[1] - e0, strain[2]] // mechanical strain
      const sxx = D[0][0] * me0[0] + D[0][1] * me0[1]
      const syy = D[1][0] * me0[0] + D[1][1] * me0[1]
      const sxy = D[2][2] * me0[2]
      const vm = Math.sqrt(sxx * sxx - sxx * syy + syy * syy + 3 * sxy * sxy)
      gVm.push(vm)
      cxx += sxx
      cyy += syy
      cxy += sxy
      cx += g.x
      cy += g.y
      const dens = 0.5 * (sxx * me0[0] + syy * me0[1] + sxy * me0[2])
      strainEnergy += dens * g.w * Math.abs(g.detJ) * thickness
    }
    const ng = kin.length
    cxx /= ng
    cyy /= ng
    cxy /= ng
    cx /= ng
    cy /= ng
    const cvm = Math.sqrt(cxx * cxx - cxx * cyy + cyy * cyy + 3 * cxy * cxy)
    elementStress.push({ sxx: cxx, syy: cyy, sxy: cxy, vm: cvm, cx, cy })
    maxVonMises = Math.max(maxVonMises, cvm)
    minVonMises = Math.min(minVonMises, cvm)
    for (let a = 0; a < nne; a++) {
      let s = 0
      for (let gi = 0; gi < ng; gi++) s += extrap[a][gi] * gVm[gi]
      nodalAccum[nodes[a]] += s
      nodalCount[nodes[a]] += 1
    }
  }
  const nodalVonMises = new Float64Array(mesh.nodeCount)
  for (let n = 0; n < mesh.nodeCount; n++)
    nodalVonMises[n] = nodalCount[n] > 0 ? nodalAccum[n] / nodalCount[n] : 0
  if (!Number.isFinite(minVonMises)) minVonMises = 0

  // Equilibrium residual on free DOFs.
  const Ku = new Float64Array(nDof)
  matVec(K, u, Ku)
  let maxLoad = 1e-30
  for (let d = 0; d < nDof; d++) maxLoad = Math.max(maxLoad, Math.abs(f[d]))
  let resid = 0
  for (let d = 0; d < nDof; d++) if (free[d]) resid = Math.max(resid, Math.abs(Ku[d] - f[d]))
  const equilibriumResidual = resid / maxLoad

  const stable = sol.converged && Number.isFinite(maxDisp)
  return {
    dispX,
    dispY,
    maxDisp,
    elementStress,
    nodalVonMises,
    maxVonMises,
    minVonMises,
    strainEnergy,
    equilibriumResidual,
    stable,
    iterations: sol.iterations,
  }
}
