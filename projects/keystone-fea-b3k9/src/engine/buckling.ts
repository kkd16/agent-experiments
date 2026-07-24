// Continuum linear (Euler) buckling — the stability chapter.
//
// The static solver answers "how much does it sag?" Buckling answers a
// different, non-negotiable question: "at what load does it stop being stable
// and snap sideways?" A slender column fails this way *far* below its yield
// stress — a stiffness collapse, not a strength one — and no amount of static
// stress checking sees it coming.
//
// The physics is a generalized eigenproblem. Under a reference in-plane stress
// field σ₀ (from a unit reference load) an element gains a *geometric* (a.k.a.
// initial-stress) stiffness K_g = ∫ Gᵀ τ G dΩ, where G gathers the displacement
// gradients and τ is the block-diagonal stress matrix. The structure loses
// stability when
//
//        (K + λ K_g) φ = 0     ⇔     K φ = λ (−K_g) φ ,
//
// i.e. the smallest positive load multiplier λ that makes the tangent stiffness
// singular. λ_cr · (reference load) is the buckling (critical) load and φ is the
// buckling mode shape.
//
// We reuse the isoparametric Q4/Q8 kinematics (`isoparam.ts`), the sparse CSR
// assembler + BC-aware PCG (`linalg.ts`) for K and the reference solve, and the
// dense reduced eigensolver (`eigen.ts`). The eigenproblem itself is solved by a
// Bathe-style **subspace iteration** driven by the operator A = K⁻¹(−K_g): each
// pass solves a handful of sparse systems, projects onto the iterate subspace,
// and reads the dominant Ritz pairs — the *lowest* buckling factors — from a
// tiny reduced generalized problem whose "mass" matrix Kᵣ = X̄ᵀK X̄ is guaranteed
// SPD, so the reduction never breaks on the indefinite stress stiffness. Pure,
// testable.

import { Assembler, matVec, solveCG, dot, type CSR } from './linalg'
import { jacobiEig } from './eigen'
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

export interface FixGroupB {
  edge?: EdgeName
  nodes?: number[]
  dofs: ('x' | 'y')[]
}

export interface BucklingInput {
  mesh: QuadMesh
  E: number
  nu: number
  thickness: number
  fix: FixGroupB[]
  /** Reference (unit) load whose λ multiplier the eigenproblem reports. */
  traction?: { edge: EdgeName; tx: number; ty: number }
  pointLoads?: { node: number; fx: number; fy: number }[]
  bodyForce?: { gx: number; gy: number }
  /** How many buckling modes to extract (default 4). */
  nModes?: number
}

export interface BucklingMode {
  /** Critical load multiplier λ (× reference load = buckling load). */
  loadFactor: number
  dispX: Float64Array
  dispY: Float64Array
  /** Peak nodal amplitude (for auto-scaling the drawn mode). */
  maxAmp: number
}

export interface BucklingResult {
  order: QOrder
  modes: BucklingMode[]
  freeDofCount: number
  /** Pre-buckling (reference) displacement field. */
  refDispX: Float64Array
  refDispY: Float64Array
  refMaxDisp: number
  /** Smooth nodal reference stress field (for the load-path shading). */
  refSxx: Float64Array
  refSyy: Float64Array
  refSxy: Float64Array
  refSvm: Float64Array
  /** Mean axial (σ_yy) reference stress over the mesh — a scalar handle. */
  refMeanSyy: number
  stable: boolean
  eigIterations: number
  eigConverged: boolean
}

const STEEL_RHO = 7850

/** Free-DOF mask: fixed groups + orphan (element-less) nodes clamped. */
function freeMask(mesh: QuadMesh, fix: FixGroupB[], touched: Uint8Array): Uint8Array {
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

/** Reference load vector: consistent edge traction + point/body loads. */
function buildLoad(input: BucklingInput): Float64Array {
  const { mesh, thickness } = input
  const order = mesh.order
  const nne = order
  const f = new Float64Array(mesh.nodeCount * 2)
  if (input.bodyForce) {
    for (let e = 0; e < mesh.elemCount; e++) {
      const base = e * order
      const xs: number[] = []
      const ys: number[] = []
      for (let a = 0; a < nne; a++) {
        const n = mesh.elems[base + a]
        xs.push(mesh.x[n])
        ys.push(mesh.y[n])
      }
      for (const g of elementKinematics(order, xs, ys)) {
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
  return f
}

/**
 * Assemble the elastic stiffness K and cache the per-element Gauss kinematics
 * (so the reference-stress and geometric-stiffness passes never recompute the
 * Jacobian / B matrices).
 */
function assembleElastic(input: BucklingInput) {
  const { mesh, E, nu, thickness } = input
  const order = mesh.order
  const nne = order
  const nDof = mesh.nodeCount * 2
  const D = planeStressD(E, nu)
  const asmK = new Assembler(nDof)
  const touched = new Uint8Array(mesh.nodeCount)
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
    }
    const dofs: number[] = []
    for (const n of idx) dofs.push(n * 2, n * 2 + 1)
    asmK.addBlock(dofs, Ke)
  }
  return { K: asmK.build(), D, touched, elemKin }
}

/** Gauss-point reference stresses [σxx, σyy, σxy] per element, from u_ref. */
function gaussStresses(
  mesh: QuadMesh,
  D: number[][],
  elemKin: ReturnType<typeof elementKinematics>[],
  u: Float64Array,
): number[][][] {
  const order = mesh.order
  const nne = order
  const out: number[][][] = []
  for (let e = 0; e < mesh.elemCount; e++) {
    const base = e * order
    const ue: number[] = []
    for (let a = 0; a < nne; a++) {
      const n = mesh.elems[base + a]
      ue.push(u[n * 2], u[n * 2 + 1])
    }
    const perGP: number[][] = []
    for (const g of elemKin[e]) {
      const strain = [0, 0, 0]
      for (let r = 0; r < 3; r++) {
        let s = 0
        for (let c = 0; c < 2 * nne; c++) s += g.B[r][c] * ue[c]
        strain[r] = s
      }
      const sxx = D[0][0] * strain[0] + D[0][1] * strain[1]
      const syy = D[1][0] * strain[0] + D[1][1] * strain[1]
      const sxy = D[2][2] * strain[2]
      perGP.push([sxx, syy, sxy])
    }
    out.push(perGP)
  }
  return out
}

/**
 * Assemble the **stress stiffness** S = −K_g from the reference Gauss stresses,
 * so the eigenproblem reads K φ = λ S φ with the critical multiplier λ > 0 in
 * compression. For plane elasticity S is block-diagonal in the x/y DOFs with an
 * identical scalar block, because the stress matrix τ couples only ∇u with ∇u
 * and ∇v with ∇v:
 *
 *     S_e[2i][2j] = S_e[2i+1][2j+1] =
 *         −∫ (Nᵢ,ₓ(σxx Nⱼ,ₓ + σxy Nⱼ,ᵧ) + Nᵢ,ᵧ(σxy Nⱼ,ₓ + σyy Nⱼ,ᵧ)) t dΩ
 */
function assembleStressStiffness(
  input: BucklingInput,
  elemKin: ReturnType<typeof elementKinematics>[],
  gpS: number[][][],
): CSR {
  const { mesh, thickness } = input
  const order = mesh.order
  const nne = order
  const nDof = mesh.nodeCount * 2
  const asm = new Assembler(nDof)
  for (let e = 0; e < mesh.elemCount; e++) {
    const base = e * order
    const kin = elemKin[e]
    const ndofE = 2 * nne
    const Se = Array.from({ length: ndofE }, () => new Array<number>(ndofE).fill(0))
    for (let gi = 0; gi < kin.length; gi++) {
      const g = kin[gi]
      const [sxx, syy, sxy] = gpS[e][gi]
      const scale = g.w * Math.abs(g.detJ) * thickness
      // Recover the physical shape-function gradients from the B matrix:
      //   dNx_i = B[0][2i]   (∂u/∂x row),  dNy_i = B[1][2i+1]  (∂v/∂y row).
      const dNx: number[] = new Array(nne)
      const dNy: number[] = new Array(nne)
      for (let i = 0; i < nne; i++) {
        dNx[i] = g.B[0][2 * i]
        dNy[i] = g.B[1][2 * i + 1]
      }
      for (let i = 0; i < nne; i++)
        for (let j = 0; j < nne; j++) {
          const t =
            dNx[i] * (sxx * dNx[j] + sxy * dNy[j]) +
            dNy[i] * (sxy * dNx[j] + syy * dNy[j])
          const v = -t * scale // S = −K_g
          Se[2 * i][2 * j] += v
          Se[2 * i + 1][2 * j + 1] += v
        }
    }
    const dofs: number[] = []
    for (let a = 0; a < nne; a++) {
      const n = mesh.elems[base + a]
      dofs.push(n * 2, n * 2 + 1)
    }
    asm.addBlock(dofs, Se)
  }
  return asm.build()
}

/**
 * Lowest `p` buckling factors of K φ = λ S φ (S = −K_g, symmetric indefinite),
 * by subspace iteration on the operator A = K⁻¹ S. The operator A is
 * self-adjoint in the K-inner-product ⟨a,b⟩_K = aᵀK b, so we work entirely in
 * that metric. Each pass:
 *
 *   1. Z = A X = K⁻¹ (S X)             — q sparse PCG solves,
 *   2. K-orthonormalise Z → Q          — modified Gram–Schmidt in ⟨·,·⟩_K, with
 *                                        rank-revealing deflation of null-stress
 *                                        (rigid) directions,
 *   3. reduced Rayleigh–Ritz operator  Hᵣ = Qᵀ S Q  (r×r symmetric; equals
 *      Qᵀ K A Q because Q is K-orthonormal), solved by dense Jacobi,
 *   4. rotate X ← Q V (Ritz vectors), refill to q with fresh seeds.
 *
 * The subspace converges to the dominant eigenvectors of A (largest |μ|), whose
 * μ = 1/λ are the *smallest* |λ| — exactly the modes that buckle first. Because
 * the reduced problem is a *standard* symmetric eigenproblem, it never trips on
 * the indefinite / rank-deficient stress stiffness. We keep the positive λ
 * (compression instability) and sort ascending.
 */
function subspaceBuckling(
  K: CSR,
  S: CSR,
  free: Uint8Array,
  p: number,
): { factors: number[]; vectors: Float64Array[]; iterations: number; converged: boolean } {
  const n = K.n
  let nf = 0
  for (let i = 0; i < n; i++) if (free[i]) nf++
  const q = Math.min(nf, p + 4)
  if (q <= 0) return { factors: [], vectors: [], iterations: 0, converged: false }

  const freeIdx: number[] = []
  for (let i = 0; i < n; i++) if (free[i]) freeIdx.push(i)

  const maskFree = (y: Float64Array) => {
    for (let i = 0; i < n; i++) if (!free[i]) y[i] = 0
  }
  const mul = (A: CSR, x: Float64Array) => {
    const y = new Float64Array(n)
    matVec(A, x, y)
    maskFree(y)
    return y
  }
  const seed = (c: number) => {
    const v = new Float64Array(n)
    for (let k = 0; k < freeIdx.length; k++)
      v[freeIdx[k]] = Math.sin((k + 1) * 0.6180339 + (c + 1) * 1.31459)
    return v
  }

  /**
   * K-orthonormalise a block of vectors (modified Gram–Schmidt in the
   * K-inner-product). Returns the accepted basis Q and the cached K·qⱼ. Vectors
   * whose residual K-norm falls below a relative floor are deflated (dropped) —
   * these are the rigid / zero-stress directions the stress stiffness ignores.
   */
  const kOrthonormalise = (block: Float64Array[]) => {
    const Q: Float64Array[] = []
    const KQ: Float64Array[] = []
    for (const raw of block) {
      const v = raw.slice()
      maskFree(v)
      const Kv = mul(K, v)
      const nrm0 = Math.sqrt(Math.max(dot(v, Kv), 0)) // K-norm before projecting out
      for (let j = 0; j < Q.length; j++) {
        const coef = dot(v, KQ[j])
        if (coef === 0) continue
        for (let i = 0; i < n; i++) {
          v[i] -= coef * Q[j][i]
          Kv[i] -= coef * KQ[j][i]
        }
      }
      const nrm = Math.sqrt(Math.max(dot(v, Kv), 0))
      // Rank-revealing deflation is *relative*: a direction that all but
      // vanishes against the already-accepted basis (or was numerically zero to
      // begin with) is dropped. Absolute floors fail because the working K-norms
      // here are ~1e-11 in SI units.
      if (nrm0 <= 0 || nrm / nrm0 < 1e-8) continue // deflate
      const inv = 1 / nrm
      for (let i = 0; i < n; i++) {
        v[i] *= inv
        Kv[i] *= inv
      }
      Q.push(v)
      KQ.push(Kv)
    }
    return Q
  }

  const dominant = (mu: number[]) =>
    mu
      .slice()
      .sort((a, b) => Math.abs(b) - Math.abs(a))
      .slice(0, p)

  // Initial K-orthonormal subspace from deterministic seeds.
  let X = kOrthonormalise(Array.from({ length: q }, (_, c) => seed(c)))

  let prev: number[] = []
  let iterations = 0
  let converged = false
  const maxIter = 40
  let lastMu: number[] = []
  let lastQ: Float64Array[] = X
  let lastV: number[][] = []

  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1
    // 1. Z = A X = K⁻¹ (S X). CG tolerance is loose here — the subspace only
    // needs eigenvector *directions*, and the reduced Rayleigh–Ritz step
    // recovers the eigenvalues to full accuracy from those.
    const Z: Float64Array[] = X.map((x) => {
      const rhs = mul(S, x)
      const sol = solveCG(K, rhs, free, { tol: 1e-8, maxIter: Math.max(1500, 20 * n) })
      return sol.x
    })
    // 2. K-orthonormalise → Q
    const Q = kOrthonormalise(Z)
    if (Q.length === 0) break
    const r = Q.length
    // 3. reduced Rayleigh–Ritz: Hᵣ = Qᵀ S Q
    const SQ = Q.map((qv) => mul(S, qv))
    const H = Array.from({ length: r }, () => new Array<number>(r).fill(0))
    for (let a = 0; a < r; a++)
      for (let b = a; b < r; b++) {
        const v = dot(Q[a], SQ[b])
        H[a][b] = H[b][a] = v
      }
    const eig = jacobiEig(H)
    lastMu = eig.values
    lastQ = Q
    lastV = eig.vectors
    // 4. new block = Ritz vectors (Q·V), refilled to q with fresh seeds.
    const ritz: Float64Array[] = []
    for (let k = 0; k < r; k++) {
      const v = new Float64Array(n)
      for (let l = 0; l < r; l++) {
        const c = eig.vectors[l][k]
        const qv = Q[l]
        for (let i = 0; i < n; i++) v[i] += c * qv[i]
      }
      ritz.push(v)
    }
    const refill = [...ritz]
    for (let c = 0; refill.length < q; c++) refill.push(seed(q + iter * 7 + c))
    X = kOrthonormalise(refill)

    const cur = dominant(lastMu)
    if (prev.length === cur.length && cur.length > 0) {
      let maxRel = 0
      for (let i = 0; i < cur.length; i++)
        maxRel = Math.max(maxRel, Math.abs(cur[i] - prev[i]) / (Math.abs(cur[i]) + 1e-300))
      if (maxRel < 1e-7) {
        converged = true
        break
      }
    }
    prev = cur
  }

  // Assemble final Ritz pairs from the last reduced solve.
  const pairs: { lambda: number; vec: Float64Array }[] = []
  const r = lastQ.length
  for (let k = 0; k < lastMu.length; k++) {
    const mu = lastMu[k]
    if (!Number.isFinite(mu) || Math.abs(mu) < 1e-300) continue
    const lambda = 1 / mu
    if (!Number.isFinite(lambda) || lambda <= 0) continue
    const vec = new Float64Array(n)
    for (let l = 0; l < r; l++) {
      const c = lastV[l]?.[k] ?? 0
      const qv = lastQ[l]
      for (let i = 0; i < n; i++) vec[i] += c * qv[i]
    }
    maskFree(vec)
    pairs.push({ lambda, vec })
  }
  pairs.sort((a, b) => a.lambda - b.lambda)
  const top = pairs.slice(0, p)
  return {
    factors: top.map((t) => t.lambda),
    vectors: top.map((t) => t.vec),
    iterations,
    converged,
  }
}

/** Smooth nodal stress recovery (Gauss→node extrapolation + averaging). */
function recoverNodalStress(
  mesh: QuadMesh,
  gpS: number[][][],
): { sxx: Float64Array; syy: Float64Array; sxy: Float64Array; svm: Float64Array; meanSyy: number } {
  const order = mesh.order
  const nne = order
  const Emat = extrapMatrix(order)
  const accSxx = new Float64Array(mesh.nodeCount)
  const accSyy = new Float64Array(mesh.nodeCount)
  const accSxy = new Float64Array(mesh.nodeCount)
  const count = new Float64Array(mesh.nodeCount)
  for (let e = 0; e < mesh.elemCount; e++) {
    const base = e * order
    const perGP = gpS[e]
    for (let a = 0; a < nne; a++) {
      let sxx = 0
      let syy = 0
      let sxy = 0
      for (let gi = 0; gi < perGP.length; gi++) {
        sxx += Emat[a][gi] * perGP[gi][0]
        syy += Emat[a][gi] * perGP[gi][1]
        sxy += Emat[a][gi] * perGP[gi][2]
      }
      const n = mesh.elems[base + a]
      accSxx[n] += sxx
      accSyy[n] += syy
      accSxy[n] += sxy
      count[n] += 1
    }
  }
  const sxx = new Float64Array(mesh.nodeCount)
  const syy = new Float64Array(mesh.nodeCount)
  const sxy = new Float64Array(mesh.nodeCount)
  const svm = new Float64Array(mesh.nodeCount)
  let sumSyy = 0
  let nn = 0
  for (let n = 0; n < mesh.nodeCount; n++) {
    if (count[n] === 0) continue
    const a = accSxx[n] / count[n]
    const b = accSyy[n] / count[n]
    const c = accSxy[n] / count[n]
    sxx[n] = a
    syy[n] = b
    sxy[n] = c
    svm[n] = Math.sqrt(a * a - a * b + b * b + 3 * c * c)
    sumSyy += b
    nn++
  }
  return { sxx, syy, sxy, svm, meanSyy: nn ? sumSyy / nn : 0 }
}

/**
 * Full linear-buckling pipeline: assemble K, solve the reference static problem
 * for the pre-buckling stress field, build the stress stiffness S = −K_g, and
 * solve the generalized eigenproblem for the lowest critical load factors and
 * their mode shapes.
 */
export function solveBuckling(input: BucklingInput): BucklingResult {
  const order = input.mesh.order
  const nModes = input.nModes ?? 4
  const { mesh } = input
  const nDof = mesh.nodeCount * 2

  const { K, D, touched, elemKin } = assembleElastic(input)
  const free = freeMask(mesh, input.fix, touched)
  let freeDofCount = 0
  for (let i = 0; i < nDof; i++) if (free[i]) freeDofCount++

  // Reference static solve → pre-buckling stress field.
  const f = buildLoad(input)
  const sol = solveCG(K, f, free, { tol: 1e-11, maxIter: Math.max(2000, 60 * nDof) })
  const u = sol.x

  const refDispX = new Float64Array(mesh.nodeCount)
  const refDispY = new Float64Array(mesh.nodeCount)
  let refMaxDisp = 0
  for (let n = 0; n < mesh.nodeCount; n++) {
    refDispX[n] = u[n * 2]
    refDispY[n] = u[n * 2 + 1]
    refMaxDisp = Math.max(refMaxDisp, Math.hypot(refDispX[n], refDispY[n]))
  }

  const gpS = gaussStresses(mesh, D, elemKin, u)
  const nodal = recoverNodalStress(mesh, gpS)
  const S = assembleStressStiffness(input, elemKin, gpS)

  const eig = subspaceBuckling(K, S, free, nModes)

  const modes: BucklingMode[] = eig.factors.map((loadFactor, k) => {
    const vec = eig.vectors[k]
    const dispX = new Float64Array(mesh.nodeCount)
    const dispY = new Float64Array(mesh.nodeCount)
    let maxAmp = 0
    for (let n = 0; n < mesh.nodeCount; n++) {
      dispX[n] = vec[n * 2]
      dispY[n] = vec[n * 2 + 1]
      maxAmp = Math.max(maxAmp, Math.hypot(dispX[n], dispY[n]))
    }
    // Normalise the mode shape to unit peak amplitude for stable drawing.
    if (maxAmp > 0)
      for (let n = 0; n < mesh.nodeCount; n++) {
        dispX[n] /= maxAmp
        dispY[n] /= maxAmp
      }
    return { loadFactor, dispX, dispY, maxAmp: 1 }
  })

  const stable =
    sol.converged &&
    Number.isFinite(refMaxDisp) &&
    modes.length > 0 &&
    Number.isFinite(modes[0].loadFactor)

  return {
    order,
    modes,
    freeDofCount,
    refDispX,
    refDispY,
    refMaxDisp,
    refSxx: nodal.sxx,
    refSyy: nodal.syy,
    refSxy: nodal.sxy,
    refSvm: nodal.svm,
    refMeanSyy: nodal.meanSyy,
    stable,
    eigIterations: eig.iterations,
    eigConverged: eig.converged,
  }
}

/**
 * Euler critical load for an ideal prismatic column:
 *   P_cr = π² E I / (K_eff L)²
 * K_eff is the effective-length factor for the end conditions (2.0 cantilever
 * fixed-free, 1.0 pinned-pinned, 0.5 fixed-fixed, 0.699… fixed-pinned).
 */
export function eulerLoad(E: number, I: number, L: number, kEff: number): number {
  return (Math.PI * Math.PI * E * I) / (kEff * L * (kEff * L))
}

export { STEEL_RHO }
