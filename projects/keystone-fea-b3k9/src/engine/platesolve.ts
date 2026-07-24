// Plate-bending solver: assemble the global MITC4 system, apply edge boundary
// conditions, solve the static problem K·u = f (transverse pressure / point
// load), and — for free vibration — the generalized eigenproblem K φ = ω² M φ by
// scalable subspace iteration. Recovers the deflected surface and a smooth nodal
// bending-moment field (Gauss-point moments extrapolated to the nodes and
// averaged), plus the principal moments.

import { Assembler, matVec, solveCG, type CSR, type Vec } from './linalg'
import { generalizedSymEig } from './eigen'
import {
  plateKe,
  plateMe,
  platePressureFe,
  plateMoments,
  principalMoments,
  CORNER_XI,
  CORNER_ETA,
  type PlateMaterial,
} from './plate'
import { edgeNodes, centreNode, type PlateEdge, type PlateMesh } from './platemesh'

export type PlateBC = 'free' | 'ss' | 'clamped'
export type PlateEdges = Record<PlateEdge, PlateBC>

export type PlateLoad =
  | { type: 'uniform'; q: number } // pressure N/m², +ve in load direction
  | { type: 'point'; P: number; node?: number } // point force N at a node (default centre)
  | { type: 'hydrostatic'; q0: number; q1: number } // linear in y: q0 at y=0 → q1 at y=Ly

export interface PlateInput {
  mesh: PlateMesh
  material: PlateMaterial
  thickness: number
  edges: PlateEdges
  load: PlateLoad
  /** extra simply-supported (w=0) nodes, e.g. corner/point supports */
  pointSupports?: number[]
}

export interface PlateStatic {
  ok: boolean
  w: Float64Array // nodal deflection
  thetaX: Float64Array
  thetaY: Float64Array
  Mx: Float64Array // smooth nodal moments
  My: Float64Array
  Mxy: Float64Array
  m1: Float64Array // principal moments
  m2: Float64Array
  wMax: number // peak |w|
  wCenter: number // deflection at the plate centre node
  mMax: number // peak |principal moment|
  freeDofCount: number
  iterations: number
  residual: number
}

export interface PlateMode {
  frequency: number // Hz
  omega: number // rad/s
  w: Float64Array // normalized deflection shape (unit peak)
}

export interface PlateModal {
  modes: PlateMode[]
  freeDofCount: number
}

const dofW = (n: number) => 3 * n
const dofTx = (n: number) => 3 * n + 1
const dofTy = (n: number) => 3 * n + 2

function elemCoords(mesh: PlateMesh, e: number): { X: number[]; Y: number[]; nodes: number[] } {
  const nodes = [mesh.elems[e * 4], mesh.elems[e * 4 + 1], mesh.elems[e * 4 + 2], mesh.elems[e * 4 + 3]]
  const X = nodes.map((n) => mesh.x[n])
  const Y = nodes.map((n) => mesh.y[n])
  return { X, Y, nodes }
}

function elemDofs(nodes: number[]): number[] {
  const d: number[] = []
  for (const n of nodes) {
    d.push(dofW(n), dofTx(n), dofTy(n))
  }
  return d
}

/** Assemble global K (and optionally M). */
function assemble(input: PlateInput, withMass: boolean): { K: CSR; M: CSR | null } {
  const { mesh, material, thickness } = input
  const ndof = mesh.nodeCount * 3
  const aK = new Assembler(ndof)
  const aM = withMass ? new Assembler(ndof) : null
  for (let e = 0; e < mesh.elemCount; e++) {
    const { X, Y, nodes } = elemCoords(mesh, e)
    const dofs = elemDofs(nodes)
    const Ke = plateKe(X, Y, material, thickness)
    aK.addBlock(dofs, Ke)
    if (aM) {
      const Me = plateMe(X, Y, material, thickness)
      aM.addBlock(dofs, Me)
    }
  }
  return { K: aK.build(), M: aM ? aM.build() : null }
}

/** Build the free-DOF mask from the per-edge boundary conditions. */
function freeMask(input: PlateInput): Uint8Array {
  const { mesh, edges } = input
  const ndof = mesh.nodeCount * 3
  const free = new Uint8Array(ndof).fill(1)
  const constrain = (n: number, w: boolean, rot: boolean) => {
    if (w) free[dofW(n)] = 0
    if (rot) {
      free[dofTx(n)] = 0
      free[dofTy(n)] = 0
    }
  }
  ;(['left', 'right', 'bottom', 'top'] as PlateEdge[]).forEach((edge) => {
    const bc = edges[edge]
    if (bc === 'free') return
    for (const n of edgeNodes(mesh, edge)) constrain(n, true, bc === 'clamped')
  })
  for (const n of input.pointSupports ?? []) constrain(n, true, false)
  return free
}

/** Global load vector. */
function buildLoad(input: PlateInput): Vec {
  const { mesh, load } = input
  const ndof = mesh.nodeCount * 3
  const f = new Float64Array(ndof)
  if (load.type === 'uniform' || load.type === 'hydrostatic') {
    for (let e = 0; e < mesh.elemCount; e++) {
      const { X, Y, nodes } = elemCoords(mesh, e)
      let q: number
      if (load.type === 'uniform') q = load.q
      else {
        const yc = (Y[0] + Y[1] + Y[2] + Y[3]) / 4
        q = load.q0 + (load.q1 - load.q0) * (yc / mesh.Ly)
      }
      const fe = platePressureFe(X, Y, q)
      for (let a = 0; a < 4; a++) f[dofW(nodes[a])] += fe[3 * a]
    }
  } else {
    const node = load.node ?? centreNode(mesh)
    f[dofW(node)] += load.P
  }
  return f
}

/** Gauss→node extrapolation weights: corner k value = Σ_g P[k][g]·(Gauss g value). */
const SQRT3 = Math.sqrt(3)
function cornerExtrap(): number[][] {
  // Same corner sign pattern as the Gauss ordering in plate.ts.
  const N = (xi: number, eta: number) => [
    0.25 * (1 - xi) * (1 - eta),
    0.25 * (1 + xi) * (1 - eta),
    0.25 * (1 + xi) * (1 + eta),
    0.25 * (1 - xi) * (1 + eta),
  ]
  const P: number[][] = []
  for (let k = 0; k < 4; k++) P.push(N(SQRT3 * CORNER_XI[k], SQRT3 * CORNER_ETA[k]))
  return P
}
const EXTRAP = cornerExtrap()
// The four Gauss points, in plate.ts ordering, for moment sampling.
const GP = 1 / SQRT3
const GAUSS_PTS: [number, number][] = [
  [-GP, -GP],
  [GP, -GP],
  [GP, GP],
  [-GP, GP],
]

export function solvePlateStatic(input: PlateInput): PlateStatic {
  const { mesh, material, thickness } = input
  const { K } = assemble(input, false)
  const free = freeMask(input)
  const f = buildLoad(input)
  const freeDofCount = free.reduce((s, v) => s + v, 0)
  const res = solveCG(K, f, free, { tol: 1e-11, maxIter: 40 * K.n })
  const u = res.x

  const nC = mesh.nodeCount
  const w = new Float64Array(nC)
  const thetaX = new Float64Array(nC)
  const thetaY = new Float64Array(nC)
  for (let n = 0; n < nC; n++) {
    w[n] = u[dofW(n)]
    thetaX[n] = u[dofTx(n)]
    thetaY[n] = u[dofTy(n)]
  }

  // Smooth nodal moments: sample the four Gauss points per element, extrapolate
  // to the corners, and average the contributions arriving at each node.
  const Mx = new Float64Array(nC)
  const My = new Float64Array(nC)
  const Mxy = new Float64Array(nC)
  const count = new Float64Array(nC)
  for (let e = 0; e < mesh.elemCount; e++) {
    const { X, Y, nodes } = elemCoords(mesh, e)
    const d = elemDofs(nodes).map((g) => u[g])
    // Moments at the four Gauss points.
    const gm: [number, number, number][] = GAUSS_PTS.map(([xi, eta]) =>
      plateMoments(xi, eta, X, Y, material, thickness, d),
    )
    for (let k = 0; k < 4; k++) {
      let mx = 0
      let my = 0
      let mxy = 0
      for (let g = 0; g < 4; g++) {
        mx += EXTRAP[k][g] * gm[g][0]
        my += EXTRAP[k][g] * gm[g][1]
        mxy += EXTRAP[k][g] * gm[g][2]
      }
      const n = nodes[k]
      Mx[n] += mx
      My[n] += my
      Mxy[n] += mxy
      count[n] += 1
    }
  }
  const m1 = new Float64Array(nC)
  const m2 = new Float64Array(nC)
  let mMax = 0
  for (let n = 0; n < nC; n++) {
    const c = count[n] || 1
    Mx[n] /= c
    My[n] /= c
    Mxy[n] /= c
    const p = principalMoments(Mx[n], My[n], Mxy[n])
    m1[n] = p.m1
    m2[n] = p.m2
    mMax = Math.max(mMax, Math.abs(p.m1), Math.abs(p.m2))
  }

  let wMax = 0
  for (let n = 0; n < nC; n++) wMax = Math.max(wMax, Math.abs(w[n]))
  const wCenter = w[centreNode(mesh)]

  return {
    ok: res.converged,
    w,
    thetaX,
    thetaY,
    Mx,
    My,
    Mxy,
    m1,
    m2,
    wMax,
    wCenter,
    mMax,
    freeDofCount,
    iterations: res.iterations,
    residual: res.residual,
  }
}

// --- Modal analysis: subspace (Bathe) iteration ----------------------------

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
  const X: Float64Array[] = []
  const first = new Float64Array(n)
  for (let i = 0; i < n; i++) first[i] = free[i] ? M.diag[i] : 0
  X.push(first)
  const ratio: { i: number; r: number }[] = []
  for (let i = 0; i < n; i++) if (free[i] && K.diag[i] !== 0) ratio.push({ i, r: M.diag[i] / K.diag[i] })
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
    const Xbar: Float64Array[] = []
    const MX: Float64Array[] = []
    for (let c = 0; c < q; c++) {
      const mx = mv(M, vectors[c])
      MX.push(mx)
      const sol = solveCG(K, mx, free, { tol: 1e-9, maxIter: 20 * n })
      Xbar.push(sol.x)
    }
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
    const eig = generalizedSymEig(Kr, Mr)
    if (!eig) break
    const next: Float64Array[] = []
    for (let k = 0; k < q; k++) {
      const v = new Float64Array(n)
      for (let j = 0; j < q; j++) {
        const wgt = eig.vectors[j][k]
        if (wgt !== 0) for (let d = 0; d < n; d++) v[d] += Xbar[j][d] * wgt
      }
      next.push(v)
    }
    vectors = next
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

export function solvePlateModal(input: PlateInput, nModes = 6): PlateModal {
  const { mesh } = input
  const { K, M } = assemble(input, true)
  if (!M) return { modes: [], freeDofCount: 0 }
  const free = freeMask(input)
  const nf = free.reduce((s, v) => s + v, 0)
  if (nf === 0) return { modes: [], freeDofCount: 0 }
  const { values, vectors } = subspaceModal(K, M, free, nModes)
  const modes: PlateMode[] = []
  for (let k = 0; k < values.length && modes.length < nModes; k++) {
    const lam = values[k]
    if (!(lam > 1e-8)) continue
    const omega = Math.sqrt(lam)
    const vec = vectors[k]
    const w = new Float64Array(mesh.nodeCount)
    let peak = 1e-30
    for (let n = 0; n < mesh.nodeCount; n++) {
      w[n] = vec[dofW(n)]
      peak = Math.max(peak, Math.abs(w[n]))
    }
    const inv = 1 / peak
    for (let n = 0; n < mesh.nodeCount; n++) w[n] *= inv
    modes.push({ frequency: omega / (2 * Math.PI), omega, w })
  }
  return { modes, freeDofCount: nf }
}
