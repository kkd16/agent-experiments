// Linear Elastic Fracture Mechanics (LEFM) — stress-intensity factors from
// scratch, on Keystone's own isoparametric (Q4/Q8) plane-stress machinery.
//
// Everything so far measured *stress*; fracture asks a different question. At a
// sharp crack tip the elastic stress field is singular — it blows up like
// 1/√r — so the peak stress is infinite and "σ < σ_yield" is meaningless. What
// governs whether the crack *runs* is the strength of that singularity, the
// **stress-intensity factor** K, defined by the near-tip Williams field
//
//     σ_ij(r,θ) → K_I/√(2πr) · f^I_ij(θ) + K_II/√(2πr) · f^II_ij(θ) + …
//
// K has the strange unit Pa·√m and, once known, *everything* local follows.
// A crack propagates when K reaches the material's fracture toughness K_Ic.
//
// We never try to resolve the infinite stress directly. Instead we extract K by
// two energy-based methods that are provably insensitive to the tip mesh:
//
//   * the **J-integral** (Rice) in its robust *equivalent-domain* form — the
//     energy released per unit crack advance, J = (K_I² + K_II²)/E*, evaluated
//     as an area integral over a ring of elements around the tip;
//   * the **interaction (M-) integral** — superpose the computed field with a
//     known *auxiliary* Williams field of unit K and the cross-term isolates
//     K_I and K_II *separately*, the only way to split mixed mode from energy.
//
// Both are cross-checked live against handbook solutions (Feddersen, Tada) and
// against each other (J vs K²/E*, path independence, and a displacement-
// correlation estimate) — exactly the validation discipline of the rest of the
// engine. All pure `number[]`/typed-array maths: deterministic, no DOM.

import { Assembler, solveCG } from './linalg'
import {
  elementKinematics,
  planeStressD,
  extrapMatrix,
  type QOrder,
  type GaussKinematics,
} from './isoparam'
import type { QuadMesh } from './quadmesh'

export type CrackKind = 'center' | 'edge' | 'double-edge'

export interface CrackModel {
  kind: CrackKind
  /** Crack length: half-length for a center crack, tip depth for an edge crack. */
  a: number
  /** Plate width parameter W (half-width for center/double-edge, full width for edge). */
  W: number
  /** Plate half-height H (crack lies on the y = 0 symmetry plane; we model y ≥ 0). */
  H: number
  /** Remote tensile stress σ applied to the top edge (Pa). */
  sigma: number
  E: number
  nu: number
  thickness: number
  order: QOrder
  /** Mesh refinement multiplier (1 ≈ default resolution). */
  refine: number
}

// --- geometry: a graded structured mesh clustered on the crack tip ----------

/**
 * `n` intervals from x0 to x1 whose node spacing is geometrically graded so the
 * mesh clusters toward one end (`toward: 'start' | 'end'`). `ratio` is the ratio
 * of the largest to smallest interval; 1 is uniform. Returns n+1 coordinates.
 */
function gradedLine(x0: number, x1: number, n: number, toward: 'start' | 'end', ratio: number): number[] {
  const out: number[] = []
  if (n <= 0) return [x0, x1]
  // geometric series with common ratio g such that g^(n-1) = ratio
  const g = Math.pow(ratio, 1 / Math.max(1, n - 1))
  const w: number[] = []
  let s = 1
  for (let i = 0; i < n; i++) {
    w.push(s)
    s *= g
  }
  const total = w.reduce((p, c) => p + c, 0)
  // Smallest interval first => clusters near the start; reverse for 'end'.
  const seq = toward === 'start' ? w : w.slice().reverse()
  let acc = 0
  out.push(x0)
  for (let i = 0; i < n; i++) {
    acc += seq[i] / total
    out.push(x0 + acc * (x1 - x0))
  }
  out[out.length - 1] = x1
  return out
}

/** Merge two coordinate lists sharing an endpoint into one sorted unique line. */
function joinLines(a: number[], b: number[]): number[] {
  const all = [...a, ...b].sort((p, q) => p - q)
  const out: number[] = []
  for (const v of all) if (out.length === 0 || Math.abs(v - out[out.length - 1]) > 1e-12) out.push(v)
  return out
}

class NodeSet {
  xs: number[] = []
  ys: number[] = []
  private map = new Map<string, number>()
  at(x: number, y: number): number {
    const k = `${Math.round(x * 1e9)},${Math.round(y * 1e9)}`
    const found = this.map.get(k)
    if (found !== undefined) return found
    const id = this.xs.length
    this.xs.push(x)
    this.ys.push(y)
    this.map.set(k, id)
    return id
  }
}

/** Build a tensor-product Q4/Q8 mesh from explicit x/y grid lines. */
function tensorMesh(order: QOrder, xl: number[], yl: number[], label: string): QuadMesh {
  const ns = new NodeSet()
  const elems: number[] = []
  for (let j = 0; j < yl.length - 1; j++)
    for (let i = 0; i < xl.length - 1; i++) {
      const x1 = xl[i]
      const x2 = xl[i + 1]
      const y1 = yl[j]
      const y2 = yl[j + 1]
      const cx = (x1 + x2) / 2
      const cy = (y1 + y2) / 2
      const n0 = ns.at(x1, y1)
      const n1 = ns.at(x2, y1)
      const n2 = ns.at(x2, y2)
      const n3 = ns.at(x1, y2)
      if (order === 4) {
        elems.push(n0, n1, n2, n3)
      } else {
        const n4 = ns.at(cx, y1)
        const n5 = ns.at(x2, cy)
        const n6 = ns.at(cx, y2)
        const n7 = ns.at(x1, cy)
        elems.push(n0, n1, n2, n3, n4, n5, n6, n7)
      }
    }
  const x = Float64Array.from(ns.xs)
  const y = Float64Array.from(ns.ys)
  return {
    order,
    nodeCount: x.length,
    x,
    y,
    elems: Int32Array.from(elems),
    elemCount: elems.length / order,
    minX: Math.min(...ns.xs),
    maxX: Math.max(...ns.xs),
    minY: Math.min(...ns.ys),
    maxY: Math.max(...ns.ys),
    label,
  }
}

export interface CrackMesh {
  mesh: QuadMesh
  tip: number // node index of the crack tip
  tipX: number
  tipY: number
  /** Fixed DOFs as (node, dof) pairs — dof 0 = x, 1 = y. */
  fixed: [number, number][]
  /** Traction σ applied on this edge value of y (the top). */
  topY: number
  /** Crack-face node indices (traction-free, on y = 0 behind the tip). */
  crackFace: number[]
}

const EPS = 1e-9

/**
 * Mesh a cracked plate by symmetry about the crack plane y = 0 (we model the
 * y ≥ 0 half). The crack occupies x ∈ [x_c0, a) on the bottom edge (traction-
 * free); the remaining bottom edge is the uncracked ligament (u_y = 0). The tip
 * sits exactly on a node, and the mesh is graded toward it in both x and y.
 */
export function buildCrackMesh(m: CrackModel): CrackMesh {
  const { kind, a, W, H, order } = m
  const ref = Math.max(0.5, m.refine)
  // Node lines. In x we cluster on the tip at x = a from both sides; in y on the
  // crack plane at y = 0. The counts scale with the refinement multiplier.
  const nyBase = Math.round(22 * ref)
  const grade = 8 // largest/smallest interval ratio near the tip
  const yl = gradedLine(0, H, nyBase, 'start', grade)

  // Every configuration is modeled with the tip at x = a and the crack growing
  // in +x: the crack face is x ∈ [0, a) on y = 0, the tip at x = a, and the
  // ligament x ∈ [a, W] carries the crack-plane symmetry restraint u_y = 0. The
  // three configs then differ *only* in their vertical boundary conditions —
  // which is what physically distinguishes them:
  //   center       : x = 0 is the crack-centre symmetry plane  → u_x = 0
  //   edge (SENT)  : x = 0 is the free cracked surface; pin one far ligament
  //                  node in x to remove rigid-body x-translation
  //   double-edge  : the reflected quarter of a DENT specimen — x = 0 is the free
  //                  outer surface, x = W the centre symmetry plane → u_x = 0
  const tipX = a
  const nLeft = Math.round(18 * ref)
  const nRight = Math.round(18 * ref)
  const xl = joinLines(
    gradedLine(0, tipX, nLeft, 'end', grade),
    gradedLine(tipX, W, nRight, 'start', grade),
  )

  const mesh = tensorMesh(order, xl, yl, `${kind} crack`)

  const fixed: [number, number][] = []
  const crackFace: number[] = []
  let tip = 0
  let tipBest = Infinity
  for (let n = 0; n < mesh.nodeCount; n++) {
    const x = mesh.x[n]
    const y = mesh.y[n]
    const d = Math.hypot(x - tipX, y)
    if (d < tipBest) {
      tipBest = d
      tip = n
    }
    if (Math.abs(y) < EPS) {
      if (x < tipX - EPS) crackFace.push(n)
      else fixed.push([n, 1]) // ligament (incl. tip): u_y = 0
    }
    if (kind === 'center' && Math.abs(x) < EPS) fixed.push([n, 0]) // symmetry x = 0
    if (kind === 'double-edge' && Math.abs(x - W) < EPS) fixed.push([n, 0]) // centre plane x = W
  }

  // An edge crack has no x-symmetry line, so pin one ligament node in x to
  // remove the remaining rigid-body x-translation (the far bottom-right corner).
  if (kind === 'edge') {
    let corner = 0
    let best = Infinity
    for (let n = 0; n < mesh.nodeCount; n++) {
      if (Math.abs(mesh.y[n]) > EPS) continue
      const dd = Math.abs(mesh.x[n] - W)
      if (dd < best) {
        best = dd
        corner = n
      }
    }
    fixed.push([corner, 0])
  }

  return { mesh, tip, tipX, tipY: 0, fixed, topY: H, crackFace }
}

// --- solve: assemble, apply BCs + top traction, PCG solve -------------------

interface SolveOut {
  u: Float64Array
  kin: GaussKinematics[][] // per-element Gauss kinematics (reused for integrals)
  D: number[][]
  nodalVonMises: Float64Array
  nodalSyy: Float64Array
  maxVonMises: number
  strainEnergy: number
  compliance: number // uᵀf
  iterations: number
  stable: boolean
}

function solveCracked(m: CrackModel, cm: CrackMesh): SolveOut {
  const { mesh, order } = { mesh: cm.mesh, order: m.order }
  const nne = order
  const nDof = mesh.nodeCount * 2
  const D = planeStressD(m.E, m.nu)
  const asm = new Assembler(nDof)
  const kin: GaussKinematics[][] = []
  const touched = new Uint8Array(mesh.nodeCount)

  for (let e = 0; e < mesh.elemCount; e++) {
    const base = e * order
    const xs: number[] = []
    const ys: number[] = []
    const idx: number[] = []
    for (let a = 0; a < nne; a++) {
      const n = mesh.elems[base + a]
      idx.push(n)
      xs.push(mesh.x[n])
      ys.push(mesh.y[n])
      touched[n] = 1
    }
    const gk = elementKinematics(order, xs, ys)
    kin.push(gk)
    const ndofE = 2 * nne
    const Ke = Array.from({ length: ndofE }, () => new Array<number>(ndofE).fill(0))
    for (const g of gk) {
      const scale = g.w * Math.abs(g.detJ) * m.thickness
      const DB = [new Array<number>(ndofE).fill(0), new Array<number>(ndofE).fill(0), new Array<number>(ndofE).fill(0)]
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < ndofE; c++) {
          let s = 0
          for (let k = 0; k < 3; k++) s += D[r][k] * g.B[k][c]
          DB[r][c] = s
        }
      for (let aa = 0; aa < ndofE; aa++)
        for (let bb = 0; bb < ndofE; bb++) {
          let s = 0
          for (let r = 0; r < 3; r++) s += g.B[r][aa] * DB[r][bb]
          Ke[aa][bb] += s * scale
        }
    }
    const dofs: number[] = []
    for (const n of idx) dofs.push(n * 2, n * 2 + 1)
    asm.addBlock(dofs, Ke)
  }
  const K = asm.build()

  // Consistent top-edge traction σ in +y, along y = topY.
  const f = new Float64Array(nDof)
  const topEdges = topEdgeElements(mesh, cm.topY)
  for (const nodesOnEdge of topEdges) {
    const aNode = nodesOnEdge[0]
    const bNode = nodesOnEdge[nodesOnEdge.length - 1]
    const len = Math.abs(mesh.x[bNode] - mesh.x[aNode])
    const w = len * m.thickness
    if (nodesOnEdge.length === 2) {
      for (const n of nodesOnEdge) f[n * 2 + 1] += (m.sigma * w) / 2
    } else {
      const frac = [1 / 6, 2 / 3, 1 / 6]
      for (let k = 0; k < 3; k++) f[nodesOnEdge[k] * 2 + 1] += m.sigma * w * frac[k]
    }
  }

  // Free-DOF mask.
  const free = new Uint8Array(nDof).fill(1)
  for (const [n, d] of cm.fixed) free[n * 2 + d] = 0
  for (let n = 0; n < mesh.nodeCount; n++)
    if (!touched[n]) {
      free[n * 2] = 0
      free[n * 2 + 1] = 0
    }

  const sol = solveCG(K, f, free, { tol: 1e-11, maxIter: 60 * nDof })
  const u = sol.x

  // Nodal stress recovery (for drawing) + energy.
  const Emat = extrapMatrix(order)
  const accVm = new Float64Array(mesh.nodeCount)
  const accSyy = new Float64Array(mesh.nodeCount)
  const count = new Float64Array(mesh.nodeCount)
  let strainEnergy = 0
  for (let e = 0; e < mesh.elemCount; e++) {
    const base = e * order
    const ue: number[] = []
    for (let a = 0; a < nne; a++) {
      const n = mesh.elems[base + a]
      ue.push(u[n * 2], u[n * 2 + 1])
    }
    const gpVm: number[] = []
    const gpSyy: number[] = []
    for (const g of kin[e]) {
      const strain = [0, 0, 0]
      for (let r = 0; r < 3; r++) {
        let s = 0
        for (let c = 0; c < 2 * nne; c++) s += g.B[r][c] * ue[c]
        strain[r] = s
      }
      const sxx = D[0][0] * strain[0] + D[0][1] * strain[1]
      const syy = D[1][0] * strain[0] + D[1][1] * strain[1]
      const sxy = D[2][2] * strain[2]
      gpVm.push(Math.sqrt(sxx * sxx - sxx * syy + syy * syy + 3 * sxy * sxy))
      gpSyy.push(syy)
      strainEnergy += 0.5 * (sxx * strain[0] + syy * strain[1] + sxy * strain[2]) * g.w * Math.abs(g.detJ) * m.thickness
    }
    for (let a = 0; a < nne; a++) {
      let vm = 0
      let syy = 0
      for (let gi = 0; gi < gpVm.length; gi++) {
        vm += Emat[a][gi] * gpVm[gi]
        syy += Emat[a][gi] * gpSyy[gi]
      }
      const n = mesh.elems[base + a]
      accVm[n] += vm
      accSyy[n] += syy
      count[n] += 1
    }
  }
  const nodalVonMises = new Float64Array(mesh.nodeCount)
  const nodalSyy = new Float64Array(mesh.nodeCount)
  let maxVonMises = 0
  for (let n = 0; n < mesh.nodeCount; n++) {
    if (count[n] === 0) continue
    nodalVonMises[n] = accVm[n] / count[n]
    nodalSyy[n] = accSyy[n] / count[n]
    if (nodalVonMises[n] > maxVonMises) maxVonMises = nodalVonMises[n]
  }

  let compliance = 0
  for (let d = 0; d < nDof; d++) compliance += u[d] * f[d]

  return {
    u,
    kin,
    D,
    nodalVonMises,
    nodalSyy,
    maxVonMises,
    strainEnergy,
    compliance,
    iterations: sol.iterations,
    stable: sol.converged && Number.isFinite(compliance),
  }
}

/** Element edges lying on the top boundary y = topY (ordered node lists). */
function topEdgeElements(mesh: QuadMesh, topY: number): number[][] {
  const eps = 1e-7 * Math.max(mesh.maxX - mesh.minX, mesh.maxY - mesh.minY)
  const local =
    mesh.order === 4
      ? [
          [0, 1],
          [1, 2],
          [2, 3],
          [3, 0],
        ]
      : [
          [0, 4, 1],
          [1, 5, 2],
          [2, 6, 3],
          [3, 7, 0],
        ]
  const out: number[][] = []
  for (let e = 0; e < mesh.elemCount; e++) {
    const base = e * mesh.order
    for (const le of local) {
      const c1 = mesh.elems[base + le[0]]
      const c2 = mesh.elems[base + le[le.length - 1]]
      if (Math.abs(mesh.y[c1] - topY) <= eps && Math.abs(mesh.y[c2] - topY) <= eps) {
        out.push(le.map((li) => mesh.elems[base + li]))
      }
    }
  }
  return out
}

// --- Williams auxiliary near-tip fields (unit K), plane stress --------------

interface AuxSample {
  /** Auxiliary stress σ^aux = [σxx, σyy, σxy]. */
  s: [number, number, number]
  /** Auxiliary displacement gradient ∂u_i^aux/∂x_j, [[du1/dx1, du1/dx2],[du2/dx1, du2/dx2]]. */
  du: [[number, number], [number, number]]
}

/** Auxiliary displacement (unit K) at local (r,θ) for the given mode. */
function auxDisp(mode: 1 | 2, r: number, theta: number, mu: number, kappa: number): [number, number] {
  const c = Math.sqrt(r / (2 * Math.PI)) / (2 * mu)
  const h = theta / 2
  if (mode === 1) {
    const f = kappa - Math.cos(theta)
    return [c * Math.cos(h) * f, c * Math.sin(h) * f]
  }
  const ux = c * Math.sin(h) * (kappa + 2 + Math.cos(theta))
  const uy = -c * Math.cos(h) * (kappa - 2 + Math.cos(theta))
  return [ux, uy]
}

/** Auxiliary stress (unit K) at local (r,θ) for the given mode. */
function auxStress(mode: 1 | 2, r: number, theta: number): [number, number, number] {
  const k = 1 / Math.sqrt(2 * Math.PI * r)
  const h = theta / 2
  const s = Math.sin(h)
  const cco = Math.cos(h)
  const s3 = Math.sin(1.5 * theta)
  const c3 = Math.cos(1.5 * theta)
  if (mode === 1) {
    return [
      k * cco * (1 - s * s3),
      k * cco * (1 + s * s3),
      k * cco * s * c3,
    ]
  }
  return [
    -k * s * (2 + cco * c3),
    k * s * cco * c3,
    k * cco * (1 - s * s3),
  ]
}

/**
 * Auxiliary field sample at global point (x,y) for a tip at (tx,ty) whose crack
 * grows in +x. The displacement gradient is obtained by a central finite
 * difference of the analytic displacement (robust: the domain excludes the tip
 * so r is bounded away from 0), and the stress analytically.
 */
function auxAt(mode: 1 | 2, x: number, y: number, tx: number, ty: number, mu: number, kappa: number, hStep: number): AuxSample {
  const local = (gx: number, gy: number): [number, number] => {
    const dx = gx - tx
    const dy = gy - ty
    const r = Math.max(Math.hypot(dx, dy), 1e-30)
    const th = Math.atan2(dy, dx)
    return auxDisp(mode, r, th, mu, kappa)
  }
  const dxp = local(x + hStep, y)
  const dxm = local(x - hStep, y)
  const dyp = local(x, y + hStep)
  const dym = local(x, y - hStep)
  const du11 = (dxp[0] - dxm[0]) / (2 * hStep)
  const du21 = (dxp[1] - dxm[1]) / (2 * hStep)
  const du12 = (dyp[0] - dym[0]) / (2 * hStep)
  const du22 = (dyp[1] - dym[1]) / (2 * hStep)
  const r = Math.max(Math.hypot(x - tx, y - ty), 1e-30)
  const th = Math.atan2(y - ty, x - tx)
  return { s: auxStress(mode, r, th), du: [[du11, du12], [du21, du22]] }
}

// --- q weight function + the domain integrals -------------------------------

/** Smooth ring weight q(node): 1 for r ≤ rin, ramps to 0 at r ≥ rout. */
function qWeights(mesh: QuadMesh, tx: number, ty: number, rin: number, rout: number): Float64Array {
  const q = new Float64Array(mesh.nodeCount)
  for (let n = 0; n < mesh.nodeCount; n++) {
    const r = Math.hypot(mesh.x[n] - tx, mesh.y[n] - ty)
    q[n] = r <= rin ? 1 : r >= rout ? 0 : (rout - r) / (rout - rin)
  }
  return q
}

export interface FractureResult {
  ok: boolean
  order: QOrder
  mesh: QuadMesh
  tipX: number
  tipY: number
  crackFace: number[]
  dispX: Float64Array
  dispY: Float64Array
  nodalVonMises: Float64Array
  nodalSyy: Float64Array
  maxVonMises: number
  /** Mode-I / mode-II stress-intensity factors from the interaction integral (Pa·√m). */
  KI: number
  KII: number
  /** J-integral (energy release rate, J/m²) from the equivalent-domain integral. */
  J: number
  /** J reconstructed from K: (K_I²+K_II²)/E* — should equal J. */
  JfromK: number
  /** Handbook reference K_I for this configuration (Pa·√m). */
  KIref: number
  /** Geometry factor Y = K_I/(σ√(πa)) — computed and handbook. */
  Y: number
  Yref: number
  /** Displacement-correlation estimate of K_I (independent cross-check). */
  KIdcm: number
  /** J over each evaluation ring (path-independence check). */
  ringJ: number[]
  /** Mesh statistics. */
  nodes: number
  elems: number
  iterations: number
  /** Domain-integral radii used (rin, rout). */
  rin: number
  rout: number
}

/** E* for plane stress (= E). */
function eStar(E: number): number {
  return E
}

/**
 * The full fracture analysis: mesh, solve, and extract K_I, K_II and J by the
 * domain forms of the J- and interaction integrals over a ring of elements
 * around the tip. Because we model the y ≥ 0 half, each domain integral is
 * doubled to recover the whole-plate value (the mode-I field is symmetric about
 * the crack plane).
 */
export function analyzeFracture(m: CrackModel): FractureResult {
  const cm = buildCrackMesh(m)
  const { mesh } = cm
  const sol = solveCracked(m, cm)
  const nne = m.order
  const u = sol.u
  const D = sol.D
  const Estar = eStar(m.E)
  const mu = m.E / (2 * (1 + m.nu))
  const kappa = (3 - m.nu) / (1 + m.nu)

  const dispX = new Float64Array(mesh.nodeCount)
  const dispY = new Float64Array(mesh.nodeCount)
  for (let n = 0; n < mesh.nodeCount; n++) {
    dispX[n] = u[n * 2]
    dispY[n] = u[n * 2 + 1]
  }

  // Domain radii: several concentric rings for path independence. The disc must
  // stay inside the geometry — bounded by the distance from the tip to the
  // vertical boundaries (x = 0 and x = W) and to the top (y = H).
  const rmax = Math.min(cm.tipX, m.W - cm.tipX, m.H) * 0.6
  const rings = [0.28, 0.42, 0.58, 0.72].map((f) => f * rmax)
  const hStep = rmax * 0.01 // finite-difference step for the aux gradient

  const ringJ: number[] = []
  const ringKI: number[] = []
  for (let ri = 0; ri < rings.length; ri++) {
    const rout = rings[ri]
    const rin = rout * 0.35
    const q = qWeights(mesh, cm.tipX, cm.tipY, rin, rout)
    const { J, KI } = domainIntegrals(m, cm, sol, q, mu, kappa, hStep, Estar, D, nne)
    ringJ.push(J)
    ringKI.push(KI)
  }
  // Report the median-ish ring (drop the innermost, most mesh-sensitive one).
  const pick = Math.min(rings.length - 1, 2)
  const J = ringJ[pick]
  const KI = ringKI[pick]
  // These symmetry (half-plane) models are pure mode I by construction; K_II ≡ 0.
  // (A genuinely mixed-mode SIF split needs a full model — see the journal.)
  const KII = 0
  const JfromK = (KI * KI + KII * KII) / Estar

  // Handbook reference.
  const { KIref, Yref } = handbookK(m)
  const Y = m.sigma > 0 ? KI / (m.sigma * Math.sqrt(Math.PI * m.a)) : 0

  const KIdcm = dcmKI(m, cm, dispY, mu, kappa)

  return {
    ok: sol.stable && Number.isFinite(KI),
    order: m.order,
    mesh,
    tipX: cm.tipX,
    tipY: cm.tipY,
    crackFace: cm.crackFace,
    dispX,
    dispY,
    nodalVonMises: sol.nodalVonMises,
    nodalSyy: sol.nodalSyy,
    maxVonMises: sol.maxVonMises,
    KI,
    KII,
    J,
    JfromK,
    KIref,
    Y,
    Yref,
    KIdcm,
    ringJ,
    nodes: mesh.nodeCount,
    elems: mesh.elemCount,
    iterations: sol.iterations,
    rin: rings[pick] * 0.35,
    rout: rings[pick],
  }
}

/** Evaluate the J- and interaction integrals over the ring defined by q. */
function domainIntegrals(
  m: CrackModel,
  cm: CrackMesh,
  sol: SolveOut,
  q: Float64Array,
  mu: number,
  kappa: number,
  hStep: number,
  Estar: number,
  D: number[][],
  nne: number,
): { J: number; KI: number } {
  const mesh = cm.mesh
  const u = sol.u
  let Jd = 0
  let I1 = 0 // interaction integral with mode-I aux
  const Dinv = compliance2D(D)

  for (let e = 0; e < mesh.elemCount; e++) {
    const base = e * m.order
    // Skip elements entirely outside the ring (all q = 0) or entirely inside
    // (all q = 1 → ∇q = 0): they contribute nothing.
    let anyNz = false
    let allOne = true
    for (let a = 0; a < nne; a++) {
      const qn = q[mesh.elems[base + a]]
      if (qn !== 0) anyNz = true
      if (qn !== 1) allOne = false
    }
    if (!anyNz || allOne) continue

    const ue: number[] = []
    const qe: number[] = []
    for (let a = 0; a < nne; a++) {
      const n = mesh.elems[base + a]
      ue.push(u[n * 2], u[n * 2 + 1])
      qe.push(q[n])
    }
    for (const g of sol.kin[e]) {
      const scale = g.w * Math.abs(g.detJ) * m.thickness
      // dN/dx, dN/dy from B (B[0][2i]=dNx, B[1][2i+1]=dNy).
      // Actual displacement gradient ∂u_i/∂x_j.
      let du11 = 0
      let du12 = 0
      let du21 = 0
      let du22 = 0
      let dq1 = 0
      let dq2 = 0
      for (let a = 0; a < nne; a++) {
        const dNx = g.B[0][2 * a]
        const dNy = g.B[1][2 * a + 1]
        const ux = ue[2 * a]
        const uy = ue[2 * a + 1]
        du11 += dNx * ux
        du12 += dNy * ux
        du21 += dNx * uy
        du22 += dNy * uy
        dq1 += dNx * qe[a]
        dq2 += dNy * qe[a]
      }
      // Actual strain + stress.
      const exx = du11
      const eyy = du22
      const exy = du12 + du21
      const sxx = D[0][0] * exx + D[0][1] * eyy
      const syy = D[1][0] * exx + D[1][1] * eyy
      const sxy = D[2][2] * exy
      const Wstrain = 0.5 * (sxx * exx + syy * eyy + sxy * exy)

      // --- J-integral integrand: (σ_ij ∂u_j/∂x_1 − W δ_{1i}) ∂q/∂x_i ---
      // i = 1 term: (σ_11 u_{1,1} + σ_12 u_{2,1} − W) · ∂q/∂x_1
      // i = 2 term: (σ_21 u_{1,1} + σ_22 u_{2,1}) · ∂q/∂x_2
      const P11 = sxx * du11 + sxy * du21 - Wstrain
      const P21 = sxy * du11 + syy * du21
      Jd += (P11 * dq1 + P21 * dq2) * scale

      // --- interaction integral (mode-I aux, unit K) ---
      I1 += interactionIntegrand(1, g.x, g.y, cm.tipX, cm.tipY, mu, kappa, hStep, sxx, syy, sxy, du11, du21, Dinv, dq1, dq2) * scale
    }
  }

  // Double for the modeled half; convert to physical whole-plate quantities.
  const J = 2 * Jd
  // I_full = 2·I_half = (2/E*)·K_I·K_aux(=1) ⇒ K_I = E*·I_half.
  const KI = Estar * I1
  return { J, KI }
}

/**
 * Interaction-integral integrand at one Gauss point for the given aux mode.
 *   [ σ_ij ∂u_i^aux/∂x_1 + σ_ij^aux ∂u_i/∂x_1 − σ_kl ε_kl^aux δ_{1j} ] ∂q/∂x_j
 * (actual stress σ, actual gradient du·1, aux stress/gradient/strain from the
 * unit-K Williams field). ε^aux = D⁻¹ σ^aux.
 */
function interactionIntegrand(
  mode: 1 | 2,
  x: number,
  y: number,
  tx: number,
  ty: number,
  mu: number,
  kappa: number,
  hStep: number,
  sxx: number,
  syy: number,
  sxy: number,
  du11: number,
  du21: number,
  Dinv: number[][],
  dq1: number,
  dq2: number,
): number {
  const aux = auxAt(mode, x, y, tx, ty, mu, kappa, hStep)
  const [axx, ayy, axy] = aux.s
  const auxDu11 = aux.du[0][0]
  const auxDu21 = aux.du[1][0]
  // Aux strain from aux stress (plane-stress compliance).
  const aexx = Dinv[0][0] * axx + Dinv[0][1] * ayy
  const aeyy = Dinv[1][0] * axx + Dinv[1][1] * ayy
  const aexy = Dinv[2][2] * axy // engineering shear strain γ = τ/G
  // Mutual strain energy W_M = σ_kl ε_kl^aux (tensor sum: γ already engineering).
  const Wm = sxx * aexx + syy * aeyy + sxy * aexy
  // j = 1: σ_i1(∂u_i^aux/∂x_1) + σ_i1^aux(∂u_i/∂x_1) − W_M
  const t1 =
    (sxx * auxDu11 + sxy * auxDu21) + (axx * du11 + axy * du21) - Wm
  // j = 2: σ_i2(∂u_i^aux/∂x_1) + σ_i2^aux(∂u_i/∂x_1)
  const t2 = (sxy * auxDu11 + syy * auxDu21) + (axy * du11 + ayy * du21)
  return t1 * dq1 + t2 * dq2
}

/** Plane-stress compliance D⁻¹ (so ε = D⁻¹σ, with γ_xy the engineering shear). */
function compliance2D(D: number[][]): number[][] {
  // For plane stress: ε_xx = (σxx − ν σyy)/E, etc. Recover E, ν from D.
  // D[0][0] = E/(1−ν²), D[0][1] = νE/(1−ν²) ⇒ ν = D01/D00, E = D00(1−ν²).
  const nu = D[0][1] / D[0][0]
  const E = D[0][0] * (1 - nu * nu)
  const G = D[2][2]
  return [
    [1 / E, -nu / E, 0],
    [-nu / E, 1 / E, 0],
    [0, 0, 1 / G],
  ]
}

/**
 * Displacement-correlation estimate of K_I: the crack opening a short distance
 * r behind the tip is u_y = (K_I/(2μ))√(r/2π)(κ+1) on the modeled (upper) face,
 * so K_I ≈ 2μ/(κ+1)·√(2π/r)·u_y. Averaged over the few nearest crack-face nodes.
 */
function dcmKI(m: CrackModel, cm: CrackMesh, dispY: Float64Array, mu: number, kappa: number): number {
  // Near the tip the modeled (upper) crack face opens as u_y(r) = C·√r with
  // C = K_I(κ+1)/(2μ√(2π)). Fit C by least squares through the origin over a
  // window of crack-face nodes (skip the very-near-tip node — a regular element
  // under-resolves the √r there — and the far field where the asymptotics fade).
  const aLen = m.a // crack length (the SIF-normalising length in every config)
  const rlo = 0.06 * aLen
  const rhi = 0.5 * aLen
  const pts = cm.crackFace
    .map((n) => ({ r: Math.abs(cm.mesh.x[n] - cm.tipX), uy: Math.abs(dispY[n]) }))
    .filter((o) => o.r >= rlo && o.r <= rhi)
  if (pts.length < 2) return 0
  // C = Σ(√r·u) / Σ(r)
  let num = 0
  let den = 0
  for (const { r, uy } of pts) {
    num += Math.sqrt(r) * uy
    den += r
  }
  const C = den > 0 ? num / den : 0
  return (C * 2 * mu * Math.sqrt(2 * Math.PI)) / (kappa + 1)
}

// --- handbook geometry factors ----------------------------------------------

/**
 * Handbook K_I = σ√(πa)·Y for the modeled configuration.
 *   center crack (Feddersen): Y = √(sec(πa/2W))            [W = half-width]
 *   single edge crack (Tada):  Y = 1.12 − 0.231α + 10.55α² − 21.72α³ + 30.39α⁴
 *   double edge crack (Tada):  Y = (1.122 − 0.561α − 0.205α² + 0.471α³ − 0.190α⁴)/√(1−α)
 * with α = a/W.
 */
export function handbookK(m: CrackModel): { KIref: number; Yref: number } {
  const alpha = m.a / m.W
  let Y: number
  if (m.kind === 'center') {
    Y = Math.sqrt(1 / Math.cos((Math.PI * m.a) / (2 * m.W)))
  } else if (m.kind === 'edge') {
    Y = 1.12 - 0.231 * alpha + 10.55 * alpha ** 2 - 21.72 * alpha ** 3 + 30.39 * alpha ** 4
  } else {
    Y = (1.122 - 0.561 * alpha - 0.205 * alpha ** 2 + 0.471 * alpha ** 3 - 0.19 * alpha ** 4) / Math.sqrt(1 - alpha)
  }
  const KIref = m.sigma * Math.sqrt(Math.PI * m.a) * Y
  return { KIref, Yref: Y }
}

/**
 * Sweep the crack length a/W and return the computed vs handbook geometry factor
 * Y(a/W) — the live "does the FE match the handbook curve?" plot. Uses a coarser
 * mesh (fast) since only K is needed, not the field.
 */
export function sweepGeometryFactor(
  base: CrackModel,
  samples = 11,
): { alpha: number; Ycomputed: number; Yhandbook: number }[] {
  const out: { alpha: number; Ycomputed: number; Yhandbook: number }[] = []
  const lo = 0.1
  const hi = base.kind === 'double-edge' ? 0.6 : 0.6
  for (let i = 0; i < samples; i++) {
    const alpha = lo + ((hi - lo) * i) / (samples - 1)
    const mm: CrackModel = { ...base, a: alpha * base.W, refine: Math.min(base.refine, 0.85) }
    let Yc: number
    try {
      Yc = analyzeFracture(mm).Y
    } catch {
      Yc = NaN
    }
    const { Yref } = handbookK(mm)
    out.push({ alpha, Ycomputed: Yc, Yhandbook: Yref })
  }
  return out
}
