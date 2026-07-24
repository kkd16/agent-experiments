// Reissner–Mindlin plate bending — the MITC4 element.
//
// Keystone's continuum so far is entirely *in-plane* (plane-stress membranes,
// frames, bars). A floor slab, a bridge deck, a pressure-vessel wall or a
// silicon die bends *out of plane*: the load is transverse and the structure
// resists it by bending and twisting moments. That is a different element
// family — 3 DOF per node (a transverse deflection w and two normal rotations
// θx, θy) — and this module builds it from scratch.
//
// We use the **Reissner–Mindlin** (thick-plate, first-order shear-deformation)
// theory, which keeps transverse shear as an independent strain, and the
// **MITC4** element of Dvorkin & Bathe (1984) to defeat *shear locking* — the
// notorious failure of a naive 4-node Mindlin plate, whose spurious shear
// stiffness makes a thin plate come out orders of magnitude too stiff. MITC4
// replaces the directly-differentiated transverse shear with an *assumed*
// covariant shear field tied at the four edge midpoints, and it converges to the
// thin-plate (Kirchhoff) answer without locking while remaining valid for thick
// plates too.
//
// Conventions (SI throughout):
//   • w  — transverse deflection, positive in the load direction.
//   • θx — rotation of the mid-surface normal toward +x  (θx ≈ ∂w/∂x thin-limit)
//   • θy — rotation of the mid-surface normal toward +y  (θy ≈ ∂w/∂y thin-limit)
//   • DOF order per node: [w, θx, θy].
//   • Curvatures  κ = [∂θx/∂x, ∂θy/∂y, ∂θx/∂y + ∂θy/∂x]ᵀ
//   • Transverse shear  γ = [∂w/∂x − θx, ∂w/∂y − θy]ᵀ
//   • Moments  M = [Mx, My, Mxy]ᵀ = D_b · κ   (N·m per m)
//   • Shear forces  Q = [Qx, Qy]ᵀ = D_s · γ   (N per m)
//
// Everything here is pure and deterministic — no globals, no time, no
// randomness — so the same plate always yields the same numbers, in Node or the
// browser, and the validation harness can pin it to closed-form Timoshenko
// solutions.

export interface PlateMaterial {
  E: number // Young's modulus (Pa)
  nu: number // Poisson's ratio
  rho: number // density (kg/m³) — only needed for modal analysis
}

/** Bending rigidity D = E t³ / (12(1−ν²)). */
export function flexuralRigidity(mat: PlateMaterial, t: number): number {
  return (mat.E * t * t * t) / (12 * (1 - mat.nu * mat.nu))
}

/** 3×3 bending constitutive matrix D_b relating curvature κ to moment M. */
export function bendingD(mat: PlateMaterial, t: number): number[][] {
  const D = flexuralRigidity(mat, t)
  const nu = mat.nu
  return [
    [D, D * nu, 0],
    [D * nu, D, 0],
    [0, 0, D * (1 - nu) / 2],
  ]
}

/** 2×2 transverse-shear constitutive matrix D_s = κs·G·t·I. */
export function shearD(mat: PlateMaterial, t: number): number[][] {
  const G = mat.E / (2 * (1 + mat.nu))
  const ks = 5 / 6 // shear correction factor for a rectangular section
  const c = ks * G * t
  return [
    [c, 0],
    [0, c],
  ]
}

// --- Q4 bilinear shape functions ------------------------------------------

/** Corner natural coordinates, local node order 0..3. */
const XI = [-1, 1, 1, -1]
const ETA = [-1, -1, 1, 1]

/** Shape functions N_i(ξ,η). */
function shape(xi: number, eta: number): number[] {
  return [
    0.25 * (1 - xi) * (1 - eta),
    0.25 * (1 + xi) * (1 - eta),
    0.25 * (1 + xi) * (1 + eta),
    0.25 * (1 - xi) * (1 + eta),
  ]
}
/** ∂N/∂ξ. */
function dShapeXi(eta: number): number[] {
  return [
    -0.25 * (1 - eta),
    0.25 * (1 - eta),
    0.25 * (1 + eta),
    -0.25 * (1 + eta),
  ]
}
/** ∂N/∂η. */
function dShapeEta(xi: number): number[] {
  return [
    -0.25 * (1 - xi),
    -0.25 * (1 + xi),
    0.25 * (1 + xi),
    0.25 * (1 - xi),
  ]
}

/** 2×2 Jacobian J = [[x_ξ, y_ξ],[x_η, y_η]] and its determinant/inverse. */
interface Jac {
  detJ: number
  // inverse J⁻¹ entries
  i00: number
  i01: number
  i10: number
  i11: number
  // forward entries (needed by MITC assumed strain)
  xXi: number
  yXi: number
  xEta: number
  yEta: number
}

function jacobian(xi: number, eta: number, X: number[], Y: number[]): Jac {
  const dXi = dShapeXi(eta)
  const dEta = dShapeEta(xi)
  let xXi = 0
  let yXi = 0
  let xEta = 0
  let yEta = 0
  for (let i = 0; i < 4; i++) {
    xXi += dXi[i] * X[i]
    yXi += dXi[i] * Y[i]
    xEta += dEta[i] * X[i]
    yEta += dEta[i] * Y[i]
  }
  const detJ = xXi * yEta - yXi * xEta
  const inv = 1 / detJ
  return {
    detJ,
    i00: yEta * inv,
    i01: -yXi * inv,
    i10: -xEta * inv,
    i11: xXi * inv,
    xXi,
    yXi,
    xEta,
    yEta,
  }
}

/** Physical shape-function derivatives [∂N/∂x, ∂N/∂y] at a point. */
function cartDeriv(xi: number, eta: number, J: Jac): { dx: number[]; dy: number[] } {
  const dXi = dShapeXi(eta)
  const dEta = dShapeEta(xi)
  const dx = new Array<number>(4)
  const dy = new Array<number>(4)
  for (let i = 0; i < 4; i++) {
    dx[i] = J.i00 * dXi[i] + J.i01 * dEta[i]
    dy[i] = J.i10 * dXi[i] + J.i11 * dEta[i]
  }
  return { dx, dy }
}

/** 2×2 Gauss points/weights (weights are 1 each). */
const G = 1 / Math.sqrt(3)
const GAUSS: [number, number][] = [
  [-G, -G],
  [G, -G],
  [G, G],
  [-G, G],
]

// --- Bending B-matrix (3×12) ----------------------------------------------

function bendingB(xi: number, eta: number, J: Jac): number[][] {
  const { dx, dy } = cartDeriv(xi, eta, J)
  // rows: κx, κy, κxy ; cols: [w0,θx0,θy0, w1,θx1,θy1, ...]
  const B = [new Array(12).fill(0), new Array(12).fill(0), new Array(12).fill(0)]
  for (let i = 0; i < 4; i++) {
    const cθx = 3 * i + 1
    const cθy = 3 * i + 2
    B[0][cθx] = dx[i] // κx = ∂θx/∂x
    B[1][cθy] = dy[i] // κy = ∂θy/∂y
    B[2][cθx] = dy[i] // κxy = ∂θx/∂y + ∂θy/∂x
    B[2][cθy] = dx[i]
  }
  return B
}

// --- MITC4 assumed transverse-shear B-matrix (2×12) ------------------------
//
// The covariant shear strains at a point are
//   γ_ξ = w_ξ − (x_ξ·θx + y_ξ·θy),   γ_η = w_η − (x_η·θx + y_η·θy),
// each a linear function of the 12 nodal DOFs. MITC4 does NOT evaluate these at
// the Gauss points directly (that is what locks); instead it *ties* them at the
// four edge midpoints and interpolates:
//   γ_ξ(ξ,η) = ½(1−η)·γ_ξ|_A + ½(1+η)·γ_ξ|_C     A=(0,−1)  C=(0,+1)
//   γ_η(ξ,η) = ½(1−ξ)·γ_η|_D + ½(1+ξ)·γ_η|_B     B=(+1,0)  D=(−1,0)
// Then the Cartesian shear at the Gauss point follows from [γxz;γyz]=J⁻¹[γ_ξ;γ_η].

/** Coefficient row (length 12) of the covariant γ_ξ at natural point (xi,eta). */
function covXiRow(xi: number, eta: number, X: number[], Y: number[]): number[] {
  const N = shape(xi, eta)
  const dXi = dShapeXi(eta)
  // x_ξ, y_ξ at this point
  let xXi = 0
  let yXi = 0
  for (let i = 0; i < 4; i++) {
    xXi += dXi[i] * X[i]
    yXi += dXi[i] * Y[i]
  }
  const row = new Array<number>(12).fill(0)
  for (let i = 0; i < 4; i++) {
    row[3 * i] = dXi[i] // w_ξ term
    row[3 * i + 1] = -xXi * N[i] // −x_ξ·θx
    row[3 * i + 2] = -yXi * N[i] // −y_ξ·θy
  }
  return row
}

/** Coefficient row (length 12) of the covariant γ_η at natural point (xi,eta). */
function covEtaRow(xi: number, eta: number, X: number[], Y: number[]): number[] {
  const N = shape(xi, eta)
  const dEta = dShapeEta(xi)
  let xEta = 0
  let yEta = 0
  for (let i = 0; i < 4; i++) {
    xEta += dEta[i] * X[i]
    yEta += dEta[i] * Y[i]
  }
  const row = new Array<number>(12).fill(0)
  for (let i = 0; i < 4; i++) {
    row[3 * i] = dEta[i]
    row[3 * i + 1] = -xEta * N[i]
    row[3 * i + 2] = -yEta * N[i]
  }
  return row
}

function shearB(xi: number, eta: number, J: Jac, X: number[], Y: number[]): number[][] {
  // Tying-point covariant rows.
  const gA = covXiRow(0, -1, X, Y) // A=(0,−1)
  const gC = covXiRow(0, 1, X, Y) // C=(0,+1)
  const gB = covEtaRow(1, 0, X, Y) // B=(+1,0)
  const gD = covEtaRow(-1, 0, X, Y) // D=(−1,0)

  const wA = 0.5 * (1 - eta)
  const wC = 0.5 * (1 + eta)
  const wB = 0.5 * (1 + xi)
  const wD = 0.5 * (1 - xi)

  // Assumed covariant strains (length-12 coefficient rows).
  const bXi = new Array<number>(12)
  const bEta = new Array<number>(12)
  for (let k = 0; k < 12; k++) {
    bXi[k] = wA * gA[k] + wC * gC[k]
    bEta[k] = wD * gD[k] + wB * gB[k]
  }

  // Cartesian: [γxz;γyz] = J⁻¹ [γ_ξ;γ_η].
  const B = [new Array(12).fill(0), new Array(12).fill(0)]
  for (let k = 0; k < 12; k++) {
    B[0][k] = J.i00 * bXi[k] + J.i01 * bEta[k]
    B[1][k] = J.i10 * bXi[k] + J.i11 * bEta[k]
  }
  return B
}

// --- Element stiffness / mass / load --------------------------------------

/** 12×12 element stiffness = bending + (MITC) shear, both 2×2 Gauss. */
export function plateKe(X: number[], Y: number[], mat: PlateMaterial, t: number): number[][] {
  const Db = bendingD(mat, t)
  const Ds = shearD(mat, t)
  const Ke = Array.from({ length: 12 }, () => new Array<number>(12).fill(0))
  for (const [xi, eta] of GAUSS) {
    const J = jacobian(xi, eta, X, Y)
    const wgt = J.detJ // Gauss weight 1×1
    const Bb = bendingB(xi, eta, J)
    const Bs = shearB(xi, eta, J, X, Y)
    // Bending: Ke += Bbᵀ Db Bb · w
    accumulate(Ke, Bb, Db, wgt, 3)
    // Shear: Ke += Bsᵀ Ds Bs · w
    accumulate(Ke, Bs, Ds, wgt, 2)
  }
  return Ke
}

/** Ke += Bᵀ D B · w, where B is (m×12) and D is (m×m). */
function accumulate(Ke: number[][], B: number[][], D: number[][], w: number, m: number): void {
  // DB = D·B  (m×12)
  const DB = Array.from({ length: m }, () => new Array<number>(12).fill(0))
  for (let a = 0; a < m; a++)
    for (let k = 0; k < 12; k++) {
      let s = 0
      for (let b = 0; b < m; b++) s += D[a][b] * B[b][k]
      DB[a][k] = s
    }
  for (let i = 0; i < 12; i++)
    for (let j = 0; j < 12; j++) {
      let s = 0
      for (let a = 0; a < m; a++) s += B[a][i] * DB[a][j]
      Ke[i][j] += s * w
    }
}

/** 12×12 consistent mass: translational ρt on w, rotary ρt³/12 on rotations. */
export function plateMe(X: number[], Y: number[], mat: PlateMaterial, t: number): number[][] {
  const mT = mat.rho * t
  const mR = (mat.rho * t * t * t) / 12
  const Me = Array.from({ length: 12 }, () => new Array<number>(12).fill(0))
  for (const [xi, eta] of GAUSS) {
    const J = jacobian(xi, eta, X, Y)
    const wgt = J.detJ
    const N = shape(xi, eta)
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++) {
        const nn = N[i] * N[j] * wgt
        Me[3 * i][3 * j] += mT * nn
        Me[3 * i + 1][3 * j + 1] += mR * nn
        Me[3 * i + 2][3 * j + 2] += mR * nn
      }
  }
  return Me
}

/** Consistent nodal w-forces from a uniform transverse pressure q (N/m²). */
export function platePressureFe(X: number[], Y: number[], q: number): number[] {
  const fe = new Array<number>(12).fill(0)
  for (const [xi, eta] of GAUSS) {
    const J = jacobian(xi, eta, X, Y)
    const wgt = J.detJ
    const N = shape(xi, eta)
    for (let i = 0; i < 4; i++) fe[3 * i] += N[i] * q * wgt
  }
  return fe
}

/** Bending moments [Mx,My,Mxy] at natural (xi,eta) from element DOFs d (len 12). */
export function plateMoments(
  xi: number,
  eta: number,
  X: number[],
  Y: number[],
  mat: PlateMaterial,
  t: number,
  d: number[],
): [number, number, number] {
  const J = jacobian(xi, eta, X, Y)
  const Bb = bendingB(xi, eta, J)
  const kap = [0, 0, 0]
  for (let a = 0; a < 3; a++) {
    let s = 0
    for (let k = 0; k < 12; k++) s += Bb[a][k] * d[k]
    kap[a] = s
  }
  const Db = bendingD(mat, t)
  return [
    Db[0][0] * kap[0] + Db[0][1] * kap[1],
    Db[1][0] * kap[0] + Db[1][1] * kap[1],
    Db[2][2] * kap[2],
  ]
}

/** Principal moments and their orientation (radians) from [Mx,My,Mxy]. */
export function principalMoments(
  Mx: number,
  My: number,
  Mxy: number,
): { m1: number; m2: number; angle: number } {
  const avg = (Mx + My) / 2
  const R = Math.hypot((Mx - My) / 2, Mxy)
  return { m1: avg + R, m2: avg - R, angle: 0.5 * Math.atan2(2 * Mxy, Mx - My) }
}

/** Local node natural coordinates, exported for Gauss→node recovery. */
export const CORNER_XI = XI
export const CORNER_ETA = ETA
