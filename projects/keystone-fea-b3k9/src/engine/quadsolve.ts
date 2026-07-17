// Isoparametric (Q4/Q8) plane-stress solver — static and modal.
//
// Static: assemble the global stiffness from element Gauss integration, apply
// Dirichlet + traction + body/point loads, solve with the same BC-aware PCG the
// frame/CST solvers use, then recover a *smooth nodal* stress field by
// extrapolating each element's superconvergent Gauss-point stresses to its nodes
// and averaging across the mesh — the C⁰ field engineers actually read, far
// cleaner than the CST's flat-per-element picture.
//
// Modal: assemble the consistent mass matrix alongside K, reduce to the free
// DOFs, and solve the generalized eigenproblem K φ = ω² M φ with the dense
// symmetric solver from eigen.ts — the 2-D analogue of the frame modal chapter,
// giving the natural frequencies and mode shapes of a continuum part.

import { Assembler, matVec, solveCG, dot, type CSR } from './linalg'
import { generalizedSymEig } from './eigen'
import {
  elementKinematics,
  extrapMatrix,
  planeStressD,
  type QOrder,
} from './isoparam'
import {
  edgeNodesQ,
  boundaryElementEdges,
  type EdgeName,
  type QuadMesh,
} from './quadmesh'

export interface FixGroupQ {
  edge?: EdgeName
  nodes?: number[]
  dofs: ('x' | 'y')[]
}

export interface QuadInput {
  mesh: QuadMesh
  E: number
  nu: number
  thickness: number
  density?: number // kg/m³, for modal analysis (default steel)
  fix: FixGroupQ[]
  traction?: { edge: EdgeName; tx: number; ty: number }
  pointLoads?: { node: number; fx: number; fy: number }[]
  bodyForce?: { gx: number; gy: number }
}

export interface QuadResult {
  order: QOrder
  dispX: Float64Array
  dispY: Float64Array
  nodalSxx: Float64Array
  nodalSyy: Float64Array
  nodalSxy: Float64Array
  nodalVonMises: Float64Array
  nodalS1: Float64Array
  nodalS2: Float64Array
  maxVonMises: number
  minVonMises: number
  maxDisp: number
  equilibriumResidual: number
  stable: boolean
  iterations: number
  strainEnergy: number
}

const STEEL_RHO = 7850

/** Build the free-DOF mask from the fix groups and orphan (element-less) nodes. */
function freeMask(mesh: QuadMesh, fix: FixGroupQ[], touched: Uint8Array): Uint8Array {
  const nDof = mesh.nodeCount * 2
  const free = new Uint8Array(nDof).fill(1)
  for (const g of fix) {
    const nodes = g.edge ? edgeNodesQ(mesh, g.edge) : (g.nodes ?? [])
    for (const n of nodes) for (const d of g.dofs) free[n * 2 + (d === 'x' ? 0 : 1)] = 0
  }
  for (let n = 0; n < mesh.nodeCount; n++)
    if (!touched[n]) {
      free[n * 2] = 0
      free[n * 2 + 1] = 0
    }
  return free
}

/** Assemble the global stiffness (and, if requested, consistent mass). */
function assemble(input: QuadInput, withMass: boolean) {
  const { mesh, E, nu, thickness } = input
  const rho = input.density ?? STEEL_RHO
  const order = mesh.order
  const nne = order
  const nDof = mesh.nodeCount * 2
  const D = planeStressD(E, nu)
  const asmK = new Assembler(nDof)
  const asmM = withMass ? new Assembler(nDof) : null
  const touched = new Uint8Array(mesh.nodeCount)
  // Cache per-element kinematics for the stress-recovery pass.
  const elemKin: ReturnType<typeof elementKinematics>[] = []

  for (let e = 0; e < mesh.elemCount; e++) {
    const base = e * order
    const idx: number[] = []
    const xs: number[] = []
    const ys: number[] = []
    for (let a = 0; a < nne; a++) {
      const n = mesh.elems[base + a]
      idx.push(n)
      xs.push(mesh.x[n])
      ys.push(mesh.y[n])
      touched[n] = 1
    }
    const kin = elementKinematics(order, xs, ys)
    elemKin.push(kin)
    const ndofE = 2 * nne
    const Ke = Array.from({ length: ndofE }, () => new Array<number>(ndofE).fill(0))
    const Me = withMass
      ? Array.from({ length: ndofE }, () => new Array<number>(ndofE).fill(0))
      : null
    for (const g of kin) {
      const scale = g.w * Math.abs(g.detJ) * thickness
      const DB = [
        new Array<number>(ndofE).fill(0),
        new Array<number>(ndofE).fill(0),
        new Array<number>(ndofE).fill(0),
      ]
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < ndofE; c++) {
          let s = 0
          for (let m = 0; m < 3; m++) s += D[r][m] * g.B[m][c]
          DB[r][c] = s
        }
      for (let a = 0; a < ndofE; a++)
        for (let b = 0; b < ndofE; b++) {
          let s = 0
          for (let r = 0; r < 3; r++) s += g.B[r][a] * DB[r][b]
          Ke[a][b] += s * scale
        }
      if (Me) {
        const ms = scale * rho
        for (let i = 0; i < nne; i++)
          for (let j = 0; j < nne; j++) {
            const m = g.N[i] * g.N[j] * ms
            Me[2 * i][2 * j] += m
            Me[2 * i + 1][2 * j + 1] += m
          }
      }
    }
    const dofs: number[] = []
    for (const n of idx) {
      dofs.push(n * 2, n * 2 + 1)
    }
    asmK.addBlock(dofs, Ke)
    if (asmM && Me) asmM.addBlock(dofs, Me)
  }
  return { K: asmK.build(), M: asmM ? asmM.build() : null, D, touched, elemKin }
}

export function solveQuad(input: QuadInput): QuadResult {
  const { mesh, thickness } = input
  const order = mesh.order
  const nne = order
  const nDof = mesh.nodeCount * 2
  const { K, D, touched, elemKin } = assemble(input, false)

  // Load vector.
  const f = new Float64Array(nDof)
  if (input.bodyForce) {
    // Consistent body force ∫ Nᵀ b dΩ per element.
    for (let e = 0; e < mesh.elemCount; e++) {
      const base = e * order
      for (const g of elemKin[e]) {
        const w = g.w * Math.abs(g.detJ) * thickness
        for (let a = 0; a < nne; a++) {
          const n = mesh.elems[base + a]
          f[n * 2] += input.bodyForce.gx * g.N[a] * w
          f[n * 2 + 1] += input.bodyForce.gy * g.N[a] * w
        }
      }
    }
  }
  if (input.traction) {
    const { edge, tx, ty } = input.traction
    // Consistent edge load: 1-D quadratic (Q8) / linear (Q4) integration along
    // each boundary element edge. For a straight, equal-spaced edge this gives
    // the classic {½,½} (Q4) and {⅙,⅔,⅙} (Q8) weightings.
    for (const nodesOnEdge of boundaryElementEdges(mesh, edge)) {
      const a = nodesOnEdge[0]
      const b = nodesOnEdge[nodesOnEdge.length - 1]
      const len = Math.hypot(mesh.x[b] - mesh.x[a], mesh.y[b] - mesh.y[a])
      const w = len * thickness
      if (nodesOnEdge.length === 2) {
        for (const n of nodesOnEdge) {
          f[n * 2] += (tx * w) / 2
          f[n * 2 + 1] += (ty * w) / 2
        }
      } else {
        const frac = [1 / 6, 2 / 3, 1 / 6]
        for (let k = 0; k < 3; k++) {
          const n = nodesOnEdge[k]
          f[n * 2] += tx * w * frac[k]
          f[n * 2 + 1] += ty * w * frac[k]
        }
      }
    }
  }
  for (const pl of input.pointLoads ?? []) {
    f[pl.node * 2] += pl.fx
    f[pl.node * 2 + 1] += pl.fy
  }

  const free = freeMask(mesh, input.fix, touched)
  const sol = solveCG(K, f, free, { tol: 1e-10, maxIter: 60 * nDof })
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

  // --- smooth nodal stress recovery ---
  const E = extrapMatrix(order)
  const accSxx = new Float64Array(mesh.nodeCount)
  const accSyy = new Float64Array(mesh.nodeCount)
  const accSxy = new Float64Array(mesh.nodeCount)
  const count = new Float64Array(mesh.nodeCount)
  let strainEnergy = 0
  for (let e = 0; e < mesh.elemCount; e++) {
    const base = e * order
    const kin = elemKin[e]
    // element nodal displacements
    const ue: number[] = []
    for (let a = 0; a < nne; a++) {
      const n = mesh.elems[base + a]
      ue.push(u[n * 2], u[n * 2 + 1])
    }
    // stress at each Gauss point: σ = D·B·ue
    const gpS: number[][] = []
    for (const g of kin) {
      const strain = [0, 0, 0]
      for (let r = 0; r < 3; r++) {
        let s = 0
        for (let c = 0; c < 2 * nne; c++) s += g.B[r][c] * ue[c]
        strain[r] = s
      }
      const sxx = D[0][0] * strain[0] + D[0][1] * strain[1]
      const syy = D[1][0] * strain[0] + D[1][1] * strain[1]
      const sxy = D[2][2] * strain[2]
      gpS.push([sxx, syy, sxy])
      strainEnergy += 0.5 * (sxx * strain[0] + syy * strain[1] + sxy * strain[2]) *
        g.w * Math.abs(g.detJ) * thickness
    }
    // extrapolate to nodes and accumulate
    for (let a = 0; a < nne; a++) {
      let sxx = 0
      let syy = 0
      let sxy = 0
      for (let gi = 0; gi < gpS.length; gi++) {
        sxx += E[a][gi] * gpS[gi][0]
        syy += E[a][gi] * gpS[gi][1]
        sxy += E[a][gi] * gpS[gi][2]
      }
      const n = mesh.elems[base + a]
      accSxx[n] += sxx
      accSyy[n] += syy
      accSxy[n] += sxy
      count[n] += 1
    }
  }

  const nodalSxx = new Float64Array(mesh.nodeCount)
  const nodalSyy = new Float64Array(mesh.nodeCount)
  const nodalSxy = new Float64Array(mesh.nodeCount)
  const nodalVonMises = new Float64Array(mesh.nodeCount)
  const nodalS1 = new Float64Array(mesh.nodeCount)
  const nodalS2 = new Float64Array(mesh.nodeCount)
  let maxVonMises = 0
  let minVonMises = Infinity
  for (let n = 0; n < mesh.nodeCount; n++) {
    if (count[n] === 0) continue
    const sxx = accSxx[n] / count[n]
    const syy = accSyy[n] / count[n]
    const sxy = accSxy[n] / count[n]
    nodalSxx[n] = sxx
    nodalSyy[n] = syy
    nodalSxy[n] = sxy
    const vm = Math.sqrt(sxx * sxx - sxx * syy + syy * syy + 3 * sxy * sxy)
    nodalVonMises[n] = vm
    const avg = (sxx + syy) / 2
    const rad = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy)
    nodalS1[n] = avg + rad
    nodalS2[n] = avg - rad
    maxVonMises = Math.max(maxVonMises, vm)
    minVonMises = Math.min(minVonMises, vm)
  }
  if (!Number.isFinite(minVonMises)) minVonMises = 0

  const stable = sol.converged && Number.isFinite(maxDisp) && equilibriumResidual < 1e-3

  return {
    order,
    dispX,
    dispY,
    nodalSxx,
    nodalSyy,
    nodalSxy,
    nodalVonMises,
    nodalS1,
    nodalS2,
    maxVonMises,
    minVonMises,
    maxDisp,
    equilibriumResidual,
    stable,
    iterations: sol.iterations,
    strainEnergy,
  }
}

export interface QuadMode {
  frequency: number // Hz
  omega: number // rad/s
  dispX: Float64Array
  dispY: Float64Array
}

export interface QuadModalResult {
  modes: QuadMode[]
  freeDofCount: number
}

/**
 * Lowest `p` eigenpairs of K φ = λ M φ by **subspace (Bathe) iteration** — the
 * scalable alternative to a full dense eigensolve. A continuum mesh has
 * thousands of DOFs, far too many for the O(n³) Jacobi solver; but only the
 * first handful of modes matter, so we iterate a small subspace of q ≈ p+6
 * vectors:
 *
 *   1. solve K X̄ = M X   (q sparse CG solves — reusing the static solver),
 *   2. project: K_r = X̄ᵀM X,  M_r = X̄ᵀM X̄   (small q×q),
 *   3. solve the reduced generalized eigenproblem (dense Jacobi, q×q),
 *   4. rotate X ← X̄ Q, repeat until the Ritz values settle.
 *
 * The subspace converges to the p lowest modes from above. Everything runs on
 * the sparse CSR matrices, so it scales to the meshes the studio actually uses.
 */
function subspaceModal(
  K: CSR,
  M: CSR,
  free: Uint8Array,
  p: number,
): { values: number[]; vectors: Float64Array[] } {
  const n = K.n
  const nf = free.reduce((s, v) => s + v, 0)
  const q = Math.min(nf, p + 6)
  if (q === 0) return { values: [], vectors: [] }

  const mv = (A: CSR, x: Float64Array) => {
    const y = new Float64Array(n)
    matVec(A, x, y)
    for (let i = 0; i < n; i++) if (!free[i]) y[i] = 0
    return y
  }

  // Deterministic starting subspace (Bathe): first vector ~ M diagonal, the
  // rest unit vectors at the free DOFs with the largest M_ii/K_ii ratio.
  const X: Float64Array[] = []
  const first = new Float64Array(n)
  for (let i = 0; i < n; i++) first[i] = free[i] ? M.diag[i] : 0
  X.push(first)
  const ratio: { i: number; r: number }[] = []
  for (let i = 0; i < n; i++)
    if (free[i] && K.diag[i] !== 0) ratio.push({ i, r: M.diag[i] / K.diag[i] })
  ratio.sort((a, b) => b.r - a.r)
  for (let c = 1; c < q; c++) {
    const v = new Float64Array(n)
    if (c - 1 < ratio.length) v[ratio[c - 1].i] = 1
    else v[ratio[(c - 1) % Math.max(1, ratio.length)].i] = 1
    X.push(v)
  }

  let values = new Array<number>(q).fill(0)
  let vectors: Float64Array[] = X
  const maxIter = 40
  for (let iter = 0; iter < maxIter; iter++) {
    // 1. X̄ = K⁻¹ (M X)
    const Xbar: Float64Array[] = []
    const MX: Float64Array[] = []
    for (let c = 0; c < q; c++) {
      const mx = mv(M, vectors[c])
      MX.push(mx)
      const sol = solveCG(K, mx, free, { tol: 1e-9, maxIter: 20 * n })
      Xbar.push(sol.x)
    }
    // 2. reduced K_r = X̄ᵀ M X, M_r = X̄ᵀ M X̄
    const MXbar = Xbar.map((xb) => mv(M, xb))
    const Kr = Array.from({ length: q }, () => new Array<number>(q).fill(0))
    const Mr = Array.from({ length: q }, () => new Array<number>(q).fill(0))
    for (let i = 0; i < q; i++)
      for (let j = i; j < q; j++) {
        let kr = 0
        let mr = 0
        for (let d = 0; d < n; d++) {
          kr += Xbar[i][d] * MX[j][d]
          mr += Xbar[i][d] * MXbar[j][d]
        }
        Kr[i][j] = Kr[j][i] = kr
        Mr[i][j] = Mr[j][i] = mr
      }
    // 3. reduced generalized eigenproblem
    const eig = generalizedSymEig(Kr, Mr)
    if (!eig) break
    // 4. rotate X ← X̄ Q
    const next: Float64Array[] = []
    for (let k = 0; k < q; k++) {
      const v = new Float64Array(n)
      for (let j = 0; j < q; j++) {
        const w = eig.vectors[j][k]
        if (w !== 0) for (let d = 0; d < n; d++) v[d] += Xbar[j][d] * w
      }
      next.push(v)
    }
    vectors = next
    // convergence: relative change of the tracked eigenvalues
    let maxRel = 0
    for (let k = 0; k < Math.min(p, q); k++) {
      const nv = eig.values[k]
      const ov = values[k]
      if (nv > 1e-30) maxRel = Math.max(maxRel, Math.abs(nv - ov) / Math.abs(nv))
    }
    values = eig.values.slice()
    if (iter > 2 && maxRel < 1e-7) break
  }
  return { values, vectors }
}

/**
 * Continuum modal analysis: the lowest natural frequencies and mode shapes of a
 * 2-D part from K φ = ω² M φ, solved by scalable subspace iteration. Mode shapes
 * are normalised to unit peak displacement for animation.
 */
export function solveQuadModal(input: QuadInput, nModes = 6): QuadModalResult {
  const { mesh } = input
  const { K, M, touched } = assemble(input, true)
  if (!M) return { modes: [], freeDofCount: 0 }
  const free = freeMask(mesh, input.fix, touched)
  const nf = free.reduce((s, v) => s + v, 0)
  if (nf === 0) return { modes: [], freeDofCount: 0 }

  const { values, vectors } = subspaceModal(K, M, free, nModes)

  const modes: QuadMode[] = []
  for (let k = 0; k < values.length && modes.length < nModes; k++) {
    const lam = values[k]
    if (!(lam > 1e-6)) continue // skip rigid-body / spurious modes
    const omega = Math.sqrt(lam)
    const vec = vectors[k]
    const dispX = new Float64Array(mesh.nodeCount)
    const dispY = new Float64Array(mesh.nodeCount)
    let peak = 1e-30
    for (let nnode = 0; nnode < mesh.nodeCount; nnode++) {
      dispX[nnode] = vec[nnode * 2]
      dispY[nnode] = vec[nnode * 2 + 1]
      peak = Math.max(peak, Math.hypot(dispX[nnode], dispY[nnode]))
    }
    const inv = 1 / peak
    for (let nnode = 0; nnode < mesh.nodeCount; nnode++) {
      dispX[nnode] *= inv
      dispY[nnode] *= inv
    }
    modes.push({ frequency: omega / (2 * Math.PI), omega, dispX, dispY })
  }
  return { modes, freeDofCount: nf }
}

/** Strain energy convenience (½ uᵀf) exposed for tests. */
export function quadStrainEnergyCheck(u: Float64Array, f: Float64Array): number {
  return 0.5 * dot(u, f)
}
