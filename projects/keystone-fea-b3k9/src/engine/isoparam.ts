// Isoparametric plane-stress finite elements — the higher-order continuum core.
//
// The original continuum solver used constant-strain triangles (CST): one B
// matrix per element, stress constant over the element, and a notorious *stiff*
// bending response (a coarse CST cantilever is ~12 % too stiff). This module
// adds the workhorses of real 2-D FEA:
//
//   * Q4 — the bilinear isoparametric quadrilateral (4 nodes, 2×2 Gauss),
//   * Q8 — the quadratic serendipity quadrilateral (8 nodes, 3×3 Gauss),
//
// integrated numerically over the parent square [-1,1]² and mapped to the
// physical element by the isoparametric Jacobian. Q8 reproduces pure bending
// exactly in the limit and matches beam theory to a fraction of a percent on a
// mesh where CST is off by double digits — the whole point of going quadratic.
//
// Everything here is pure `number[]`/`number[][]` maths — deterministic, no DOM,
// no globals — so validate.ts can cross-check every element against closed-form
// elasticity, exactly like the rest of the engine.

export type QOrder = 4 | 8

/** Natural (ξ,η) coordinates of each local node, in connectivity order. */
export const NODE_NAT: Record<QOrder, [number, number][]> = {
  4: [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ],
  8: [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ],
}

/** Local node indices along each edge (corner, [mid,] corner). */
export const EDGE_NODES: Record<QOrder, number[][]> = {
  4: [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
  ],
  8: [
    [0, 4, 1],
    [1, 5, 2],
    [2, 6, 3],
    [3, 7, 0],
  ],
}

export interface GaussPoint {
  xi: number
  eta: number
  w: number
}

const INV_SQRT3 = 1 / Math.sqrt(3)
const SQRT35 = Math.sqrt(3 / 5)

/** Tensor-product Gauss rule: 2×2 for Q4, 3×3 for Q8. */
export function gaussPoints(order: QOrder): GaussPoint[] {
  const pts: GaussPoint[] = []
  if (order === 4) {
    const g = [-INV_SQRT3, INV_SQRT3]
    for (const a of g) for (const b of g) pts.push({ xi: a, eta: b, w: 1 })
  } else {
    const g = [-SQRT35, 0, SQRT35]
    const w = [5 / 9, 8 / 9, 5 / 9]
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) pts.push({ xi: g[i], eta: g[j], w: w[i] * w[j] })
  }
  return pts
}

export interface ShapeVals {
  N: number[]
  dxi: number[]
  deta: number[]
}

/** Shape functions and their natural derivatives at (ξ,η). */
export function shape(order: QOrder, xi: number, eta: number): ShapeVals {
  if (order === 4) {
    const N = [
      0.25 * (1 - xi) * (1 - eta),
      0.25 * (1 + xi) * (1 - eta),
      0.25 * (1 + xi) * (1 + eta),
      0.25 * (1 - xi) * (1 + eta),
    ]
    const dxi = [
      -0.25 * (1 - eta),
      0.25 * (1 - eta),
      0.25 * (1 + eta),
      -0.25 * (1 + eta),
    ]
    const deta = [
      -0.25 * (1 - xi),
      -0.25 * (1 + xi),
      0.25 * (1 + xi),
      0.25 * (1 - xi),
    ]
    return { N, dxi, deta }
  }
  // Q8 serendipity.
  const N = new Array<number>(8)
  const dxi = new Array<number>(8)
  const deta = new Array<number>(8)
  const nat = NODE_NAT[8]
  // Corner nodes 0..3.
  for (let i = 0; i < 4; i++) {
    const x0 = nat[i][0]
    const y0 = nat[i][1]
    const a = 1 + xi * x0
    const b = 1 + eta * y0
    N[i] = 0.25 * a * b * (xi * x0 + eta * y0 - 1)
    dxi[i] = 0.25 * x0 * b * (2 * xi * x0 + eta * y0)
    deta[i] = 0.25 * y0 * a * (xi * x0 + 2 * eta * y0)
  }
  // Mid-side nodes on ξ = 0 edges (local 4 and 6): N = ½(1-ξ²)(1+η·η0).
  for (const i of [4, 6]) {
    const y0 = nat[i][1]
    N[i] = 0.5 * (1 - xi * xi) * (1 + eta * y0)
    dxi[i] = -xi * (1 + eta * y0)
    deta[i] = 0.5 * (1 - xi * xi) * y0
  }
  // Mid-side nodes on η = 0 edges (local 5 and 7): N = ½(1+ξ·ξ0)(1-η²).
  for (const i of [5, 7]) {
    const x0 = nat[i][0]
    N[i] = 0.5 * (1 + xi * x0) * (1 - eta * eta)
    dxi[i] = 0.5 * x0 * (1 - eta * eta)
    deta[i] = -eta * (1 + xi * x0)
  }
  return { N, dxi, deta }
}

/** Plane-stress constitutive matrix D (3×3). */
export function planeStressD(E: number, nu: number): number[][] {
  const f = E / (1 - nu * nu)
  return [
    [f, f * nu, 0],
    [f * nu, f, 0],
    [0, 0, (f * (1 - nu)) / 2],
  ]
}

export interface GaussKinematics {
  /** Strain–displacement matrix B (3 × 2·nne) at this Gauss point. */
  B: number[][]
  /** Shape values N (length nne). */
  N: number[]
  detJ: number
  w: number
  /** Physical coordinates of the Gauss point (for plotting). */
  x: number
  y: number
}

/**
 * Per-Gauss-point kinematics for one physical element with node coordinates
 * (xs, ys). Builds the Jacobian, its inverse, the physical shape-function
 * gradients, and the B matrix. `detJ ≤ 0` at any point flags an inverted /
 * badly distorted element (the caller skips it defensively).
 */
export function elementKinematics(
  order: QOrder,
  xs: number[],
  ys: number[],
): GaussKinematics[] {
  const nne = order
  const out: GaussKinematics[] = []
  for (const gp of gaussPoints(order)) {
    const { N, dxi, deta } = shape(order, gp.xi, gp.eta)
    let J00 = 0
    let J01 = 0
    let J10 = 0
    let J11 = 0
    let x = 0
    let y = 0
    for (let i = 0; i < nne; i++) {
      J00 += dxi[i] * xs[i]
      J01 += dxi[i] * ys[i]
      J10 += deta[i] * xs[i]
      J11 += deta[i] * ys[i]
      x += N[i] * xs[i]
      y += N[i] * ys[i]
    }
    const detJ = J00 * J11 - J01 * J10
    const inv = detJ !== 0 ? 1 / detJ : 0
    const iJ00 = J11 * inv
    const iJ01 = -J01 * inv
    const iJ10 = -J10 * inv
    const iJ11 = J00 * inv
    const ndof = 2 * nne
    const B = [
      new Array<number>(ndof).fill(0),
      new Array<number>(ndof).fill(0),
      new Array<number>(ndof).fill(0),
    ]
    for (let i = 0; i < nne; i++) {
      const dNx = iJ00 * dxi[i] + iJ01 * deta[i]
      const dNy = iJ10 * dxi[i] + iJ11 * deta[i]
      B[0][2 * i] = dNx
      B[1][2 * i + 1] = dNy
      B[2][2 * i] = dNy
      B[2][2 * i + 1] = dNx
    }
    out.push({ B, N, detJ, w: gp.w, x, y })
  }
  return out
}

/**
 * Element stiffness Kᵉ = ∫ Bᵀ D B t dΩ and consistent mass
 * Mᵉ = ∫ ρ t Nᵀ N dΩ, both by Gauss quadrature over the parent element.
 */
export function elementMatrices(
  order: QOrder,
  xs: number[],
  ys: number[],
  D: number[][],
  rho: number,
  thickness: number,
): { Ke: number[][]; Me: number[][]; kin: GaussKinematics[] } {
  const nne = order
  const ndof = 2 * nne
  const Ke = Array.from({ length: ndof }, () => new Array<number>(ndof).fill(0))
  const Me = Array.from({ length: ndof }, () => new Array<number>(ndof).fill(0))
  const kin = elementKinematics(order, xs, ys)
  for (const g of kin) {
    const scale = g.w * Math.abs(g.detJ) * thickness
    // Kᵉ += Bᵀ D B · (w·|J|·t)
    const DB = [
      new Array<number>(ndof).fill(0),
      new Array<number>(ndof).fill(0),
      new Array<number>(ndof).fill(0),
    ]
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < ndof; c++) {
        let s = 0
        for (let m = 0; m < 3; m++) s += D[r][m] * g.B[m][c]
        DB[r][c] = s
      }
    for (let a = 0; a < ndof; a++)
      for (let b = 0; b < ndof; b++) {
        let s = 0
        for (let r = 0; r < 3; r++) s += g.B[r][a] * DB[r][b]
        Ke[a][b] += s * scale
      }
    // Mᵉ += ρ Nᵀ N · (w·|J|·t), block-diagonal in x/y.
    const ms = scale * rho
    for (let i = 0; i < nne; i++)
      for (let j = 0; j < nne; j++) {
        const m = g.N[i] * g.N[j] * ms
        Me[2 * i][2 * j] += m
        Me[2 * i + 1][2 * j + 1] += m
      }
  }
  return { Ke, Me, kin }
}

// --- stress recovery: Gauss-point → nodal extrapolation -------------------

/** Gauss–Jordan inverse of a small dense square matrix. */
function denseInverse(A: number[][]): number[][] {
  const n = A.length
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    ;[M[c], M[p]] = [M[p], M[c]]
    const pv = M[c][c]
    for (let k = 0; k < 2 * n; k++) M[c][k] /= pv
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = M[r][c]
      if (f === 0) continue
      for (let k = 0; k < 2 * n; k++) M[r][k] -= f * M[c][k]
    }
  }
  return M.map((row) => row.slice(n))
}

/** Monomial basis at (ξ,η): bilinear for Q4, biquadratic for Q8. */
function stressBasis(order: QOrder, xi: number, eta: number): number[] {
  if (order === 4) return [1, xi, eta, xi * eta]
  return [1, xi, eta, xi * eta, xi * xi, eta * eta, xi * xi * eta, xi * eta * eta, xi * xi * eta * eta]
}

/**
 * Extrapolation matrix E (nne × nGauss) mapping stress *samples at the Gauss
 * points* to *values at the nodes*, in natural coordinates. Fitting a monomial
 * field through the (superconvergent) Gauss-point stresses and evaluating it at
 * the nodes is the standard nodal-stress recovery that turns FEA's jumpy
 * element stresses into a smooth C⁰ field. Computed once per order.
 */
function buildExtrap(order: QOrder): number[][] {
  const gps = gaussPoints(order)
  const ng = gps.length
  const nodes = NODE_NAT[order]
  // A[g] = basis(gauss g); invert (square: ng basis terms = ng gauss points).
  const A = gps.map((g) => stressBasis(order, g.xi, g.eta))
  const Ainv = denseInverse(A)
  // E[node][g] = basis(node) · Ainv[:,g]
  const E: number[][] = []
  for (const [nx, ny] of nodes) {
    const bn = stressBasis(order, nx, ny)
    const row = new Array<number>(ng).fill(0)
    for (let g = 0; g < ng; g++) {
      let s = 0
      for (let k = 0; k < bn.length; k++) s += bn[k] * Ainv[k][g]
      row[g] = s
    }
    E.push(row)
  }
  return E
}

const EXTRAP: Record<QOrder, number[][]> = {
  4: buildExtrap(4),
  8: buildExtrap(8),
}

/** Nodal-value extrapolation matrix for the given order (nne × nGauss). */
export function extrapMatrix(order: QOrder): number[][] {
  return EXTRAP[order]
}
