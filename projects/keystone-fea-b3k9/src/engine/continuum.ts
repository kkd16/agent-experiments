// 2-D plane-stress linear elasticity by constant-strain triangles (CST).
//
// For each triangle we form the strain–displacement matrix B (constant over the
// element), the plane-stress constitutive matrix D, and the element stiffness
// Kᵉ = t·A·Bᵀ·D·B. These scatter into a global 2-DOF-per-node system solved by
// the same preconditioned conjugate gradient used for frames. Element stresses
// come straight from σ = D·B·uᵉ; we also average them to nodes for a smooth
// field and reduce them to von Mises and principal stresses.

import { Assembler, matVec, solveCG } from './linalg'
import { edgeNodes, edgeSegments, type EdgeName, type Mesh } from './mesh'

export interface FixGroup {
  edge?: EdgeName
  nodes?: number[]
  dofs: ('x' | 'y')[]
}
export interface ContinuumInput {
  mesh: Mesh
  E: number
  nu: number
  thickness: number
  fix: FixGroup[]
  traction?: { edge: EdgeName; tx: number; ty: number }
  pointLoads?: { node: number; fx: number; fy: number }[]
  bodyForce?: { gx: number; gy: number } // force per unit volume (N/m³)
}

export interface ElementStress {
  sxx: number
  syy: number
  sxy: number
  vm: number // von Mises
  s1: number // major principal
  s2: number // minor principal
  angle: number // principal direction (rad)
  cx: number // centroid, for plotting
  cy: number
}

export interface ContinuumResult {
  dispX: Float64Array
  dispY: Float64Array
  elementStress: ElementStress[]
  nodalVonMises: Float64Array
  maxVonMises: number
  minVonMises: number
  maxDisp: number
  equilibriumResidual: number
  stable: boolean
  iterations: number
  strainEnergy: number
}

/** Constant strain-displacement matrix B (3×6) and area for one triangle. */
function triBandArea(
  xi: number,
  yi: number,
  xj: number,
  yj: number,
  xk: number,
  yk: number,
) {
  const b = [yj - yk, yk - yi, yi - yj]
  const c = [xk - xj, xi - xk, xj - xi]
  const area2 = xi * (yj - yk) + xj * (yk - yi) + xk * (yi - yj)
  const area = area2 / 2
  const inv = 1 / area2
  // B rows: εxx, εyy, γxy
  const B = [
    [b[0] * inv, 0, b[1] * inv, 0, b[2] * inv, 0],
    [0, c[0] * inv, 0, c[1] * inv, 0, c[2] * inv],
    [c[0] * inv, b[0] * inv, c[1] * inv, b[1] * inv, c[2] * inv, b[2] * inv],
  ]
  return { B, area }
}

function planeStressD(E: number, nu: number): number[][] {
  const f = E / (1 - nu * nu)
  return [
    [f, f * nu, 0],
    [f * nu, f, 0],
    [0, 0, (f * (1 - nu)) / 2],
  ]
}

export function solveContinuum(input: ContinuumInput): ContinuumResult {
  const { mesh, E, nu, thickness } = input
  const nDof = mesh.nodeCount * 2
  const asm = new Assembler(nDof)
  const D = planeStressD(E, nu)
  const touched = new Uint8Array(mesh.nodeCount)
  const bodyAcc = new Float64Array(nDof) // lumped body-force contributions

  // Cache B and area per element for the stress-recovery pass.
  const elemB: number[][][] = []
  const elemArea: number[] = []

  for (let e = 0; e < mesh.triCount; e++) {
    const i = mesh.tris[e * 3]
    const j = mesh.tris[e * 3 + 1]
    const k = mesh.tris[e * 3 + 2]
    touched[i] = touched[j] = touched[k] = 1
    const { B, area } = triBandArea(
      mesh.x[i], mesh.y[i], mesh.x[j], mesh.y[j], mesh.x[k], mesh.y[k],
    )
    elemB.push(B)
    elemArea.push(area)
    // Kᵉ = t·A·Bᵀ·D·B
    const DB = [
      [0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0],
    ]
    for (let r = 0; r < 3; r++)
      for (let col = 0; col < 6; col++) {
        let s = 0
        for (let m = 0; m < 3; m++) s += D[r][m] * B[m][col]
        DB[r][col] = s
      }
    const ke: number[][] = Array.from({ length: 6 }, () => new Array(6).fill(0))
    const w = thickness * Math.abs(area)
    for (let a = 0; a < 6; a++)
      for (let bb = 0; bb < 6; bb++) {
        let s = 0
        for (let m = 0; m < 3; m++) s += B[m][a] * DB[m][bb]
        ke[a][bb] = w * s
      }
    const dofs = [i * 2, i * 2 + 1, j * 2, j * 2 + 1, k * 2, k * 2 + 1]
    asm.addBlock(dofs, ke)
    // Body force (lumped equally to the three nodes).
    if (input.bodyForce) {
      const fb = (thickness * Math.abs(area)) / 3
      for (const n of [i, j, k]) {
        // accumulated below via f vector; store in a side array
        bodyAcc[n * 2] += input.bodyForce.gx * fb
        bodyAcc[n * 2 + 1] += input.bodyForce.gy * fb
      }
    }
  }
  const K = asm.build()

  // Load vector.
  const f = new Float64Array(nDof)
  for (let d = 0; d < nDof; d++) f[d] += bodyAcc[d]
  if (input.traction) {
    const { edge, tx, ty } = input.traction
    for (const [n1, n2] of edgeSegments(mesh, edge)) {
      const len = Math.hypot(mesh.x[n2] - mesh.x[n1], mesh.y[n2] - mesh.y[n1])
      const half = (len * thickness) / 2
      f[n1 * 2] += tx * half
      f[n1 * 2 + 1] += ty * half
      f[n2 * 2] += tx * half
      f[n2 * 2 + 1] += ty * half
    }
  }
  for (const pl of input.pointLoads ?? []) {
    f[pl.node * 2] += pl.fx
    f[pl.node * 2 + 1] += pl.fy
  }

  // Free-DOF mask from the fix groups.
  const free = new Uint8Array(nDof).fill(1)
  for (const g of input.fix) {
    const nodes = g.edge ? edgeNodes(mesh, g.edge) : (g.nodes ?? [])
    for (const n of nodes)
      for (const d of g.dofs) free[n * 2 + (d === 'x' ? 0 : 1)] = 0
  }
  for (let n = 0; n < mesh.nodeCount; n++)
    if (!touched[n]) {
      free[n * 2] = 0
      free[n * 2 + 1] = 0
    }

  const sol = solveCG(K, f, free, { tol: 1e-10, maxIter: 40 * nDof })
  const u = sol.x

  // Equilibrium residual on free DOFs.
  const Ku = new Float64Array(nDof)
  matVec(K, u, Ku)
  let maxLoad = 1e-30
  for (let d = 0; d < nDof; d++) maxLoad = Math.max(maxLoad, Math.abs(f[d]))
  let resid = 0
  for (let d = 0; d < nDof; d++) if (free[d]) resid = Math.max(resid, Math.abs(Ku[d] - f[d]))
  const equilibriumResidual = resid / maxLoad

  const dispX = new Float64Array(mesh.nodeCount)
  const dispY = new Float64Array(mesh.nodeCount)
  let maxDisp = 0
  for (let n = 0; n < mesh.nodeCount; n++) {
    dispX[n] = u[n * 2]
    dispY[n] = u[n * 2 + 1]
    maxDisp = Math.max(maxDisp, Math.hypot(dispX[n], dispY[n]))
  }

  // Stress recovery: σ = D·B·uᵉ per element.
  const elementStress: ElementStress[] = []
  const nodalAccum = new Float64Array(mesh.nodeCount)
  const nodalCount = new Float64Array(mesh.nodeCount)
  let maxVonMises = 0
  let minVonMises = Infinity
  let strainEnergy = 0
  for (let e = 0; e < mesh.triCount; e++) {
    const i = mesh.tris[e * 3]
    const j = mesh.tris[e * 3 + 1]
    const k = mesh.tris[e * 3 + 2]
    const ue = [u[i * 2], u[i * 2 + 1], u[j * 2], u[j * 2 + 1], u[k * 2], u[k * 2 + 1]]
    const B = elemB[e]
    const strain = [0, 0, 0]
    for (let r = 0; r < 3; r++) {
      let s = 0
      for (let col = 0; col < 6; col++) s += B[r][col] * ue[col]
      strain[r] = s
    }
    const sxx = D[0][0] * strain[0] + D[0][1] * strain[1]
    const syy = D[1][0] * strain[0] + D[1][1] * strain[1]
    const sxy = D[2][2] * strain[2]
    const vm = Math.sqrt(sxx * sxx - sxx * syy + syy * syy + 3 * sxy * sxy)
    const avg = (sxx + syy) / 2
    const rad = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy)
    const s1 = avg + rad
    const s2 = avg - rad
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy)
    const cx = (mesh.x[i] + mesh.x[j] + mesh.x[k]) / 3
    const cy = (mesh.y[i] + mesh.y[j] + mesh.y[k]) / 3
    elementStress.push({ sxx, syy, sxy, vm, s1, s2, angle, cx, cy })
    maxVonMises = Math.max(maxVonMises, vm)
    minVonMises = Math.min(minVonMises, vm)
    for (const n of [i, j, k]) {
      nodalAccum[n] += vm
      nodalCount[n] += 1
    }
    // Strain energy density × volume = ½ σᵀε · (t·A)
    const dens = 0.5 * (sxx * strain[0] + syy * strain[1] + sxy * strain[2])
    strainEnergy += dens * thickness * Math.abs(elemArea[e])
  }
  const nodalVonMises = new Float64Array(mesh.nodeCount)
  for (let n = 0; n < mesh.nodeCount; n++)
    nodalVonMises[n] = nodalCount[n] > 0 ? nodalAccum[n] / nodalCount[n] : 0

  if (!Number.isFinite(minVonMises)) minVonMises = 0

  const stable = sol.converged && Number.isFinite(maxDisp) && equilibriumResidual < 1e-3

  return {
    dispX,
    dispY,
    elementStress,
    nodalVonMises,
    maxVonMises,
    minVonMises,
    maxDisp,
    equilibriumResidual,
    stable,
    iterations: sol.iterations,
    strainEnergy,
  }
}
