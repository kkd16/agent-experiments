// Scalar heat-conduction finite elements — the thermal half of the multiphysics
// chapter (v11).
//
// Where the continuum solver has two displacement DOFs per node, heat conduction
// has one: the temperature T. The element matrices are the scalar cousins of the
// elasticity ones, integrated on the *same* isoparametric Q4/Q8 machinery
// (`isoparam` shape functions + Gauss points) over the same `QuadMesh` domains:
//
//   * conductivity   K_c = ∫ (∇N)ᵀ κ (∇N) t dΩ    (the "stiffness" of heat flow)
//   * capacitance    C   = ∫ ρc Nᵀ N t dΩ          (thermal inertia, transient)
//   * generation     Q   = ∫ Nᵀ q''' t dΩ          (volumetric heat source)
//   * edge flux      q'' applied on a boundary edge (Neumann)
//   * edge convection h(T−T∞) on a boundary edge   (Robin — adds to *both* K and Q)
//
// Steady state solves (K_c + H)·T = Q; transient marches C·Ṫ + K_c·T = Q by the
// unconditionally-stable θ-method. Non-homogeneous Dirichlet (a prescribed face
// temperature) is folded into the right-hand side so the existing free-mask CG
// solves the reduced system unchanged.
//
// Everything here is pure — no DOM, no globals, no time — so validate.ts can
// cross-check each piece against closed-form conduction theory.

import { Assembler, matVec, solveCG, type CSR } from './linalg'
import { gaussPoints, shape, extrapMatrix, type QOrder } from './isoparam'
import {
  boundaryElementEdges,
  edgeNodesQ,
  type EdgeName,
  type QuadMesh,
} from './quadmesh'

/** A boundary condition on one named edge of the domain. */
export type EdgeThermalBC =
  | { kind: 'temp'; value: number } // Dirichlet — prescribed temperature (°C)
  | { kind: 'flux'; q: number } // Neumann — heat flux INTO the body (W/m²)
  | { kind: 'convection'; h: number; Tinf: number } // Robin — film coeff (W/m²·K), ambient
  | { kind: 'insulated' } // homogeneous Neumann (natural — the default)

export interface ThermalInput {
  mesh: QuadMesh
  /** Thermal conductivity κ (W/m·K). */
  k: number
  /** Volumetric heat capacity ρ·c (J/m³·K) — only used by the transient solver. */
  rhoc: number
  /** Out-of-plane thickness (m). */
  thickness: number
  /** Uniform volumetric heat generation q''' (W/m³), optionally over a sub-region. */
  gen?: { q: number; region?: (x: number, y: number) => boolean }
  /** Per-edge boundary conditions (any edge omitted is insulated). */
  bcs: Partial<Record<EdgeName, EdgeThermalBC>>
  /** Extra prescribed nodal temperatures (override edge BCs; used by the patch test). */
  nodeTemps?: { node: number; value: number }[]
  /** Reference / initial temperature (°C). */
  T0?: number
}

export interface ThermalFlux {
  qx: number
  qy: number
  mag: number
  cx: number
  cy: number
}

export interface ThermalResult {
  T: Float64Array // nodal temperature
  minT: number
  maxT: number
  elementFlux: ThermalFlux[] // −κ∇T at the element centroid
  nodalFluxMag: Float64Array // smooth recovered |q| field
  maxFlux: number
  /** max |K·T − Q| on free DOFs, normalised — a conduction-balance residual. */
  residual: number
  stable: boolean
  iterations: number
}

export interface ThermalTransientResult {
  ok: boolean
  dt: number
  nSteps: number
  times: Float64Array
  /** frames[i] is the nodal temperature at times[i] (sub-sampled). */
  frames: Float64Array[]
  minT: number
  maxT: number
  steady: ThermalResult | null // the t→∞ field, for comparison
}

// --- element kinematics (scalar field) ------------------------------------

interface ScalarGauss {
  /** dN/dx and dN/dy at the Gauss point (length nne each). */
  dNx: number[]
  dNy: number[]
  N: number[]
  detJ: number
  w: number
  x: number
  y: number
}

/** Per-Gauss-point scalar shape gradients for one physical element. */
function scalarKinematics(order: QOrder, xs: number[], ys: number[]): ScalarGauss[] {
  const nne = order
  const out: ScalarGauss[] = []
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
    const dNx = new Array<number>(nne)
    const dNy = new Array<number>(nne)
    for (let i = 0; i < nne; i++) {
      dNx[i] = iJ00 * dxi[i] + iJ01 * deta[i]
      dNy[i] = iJ10 * dxi[i] + iJ11 * deta[i]
    }
    out.push({ dNx, dNy, N, detJ, w: gp.w, x, y })
  }
  return out
}

/** Element node coordinates gathered from the mesh. */
function elemCoords(mesh: QuadMesh, e: number): { nodes: number[]; xs: number[]; ys: number[] } {
  const nne = mesh.order
  const base = e * nne
  const nodes = new Array<number>(nne)
  const xs = new Array<number>(nne)
  const ys = new Array<number>(nne)
  for (let i = 0; i < nne; i++) {
    const n = mesh.elems[base + i]
    nodes[i] = n
    xs[i] = mesh.x[n]
    ys[i] = mesh.y[n]
  }
  return { nodes, xs, ys }
}

// --- edge integrals -------------------------------------------------------

// Closed-form 1-D consistent integrals over a *straight* element edge of length
// L (all Keystone meshes are straight-sided). Node ordering matches
// `boundaryElementEdges`: [c1, c2] for Q4, [c1, mid, c2] for Q8.

/** ∫ N ds over the edge — distributes a uniform edge quantity to its nodes. */
function edgeShapeIntegral(nEdge: number, L: number): number[] {
  if (nEdge === 2) return [L / 2, L / 2]
  // Quadratic: ∫N_end = L/6, ∫N_mid = 2L/3.
  return [L / 6, (2 * L) / 3, L / 6]
}

/** ∫ Nᵀ N ds over the edge — the boundary "mass" matrix (for convection). */
function edgeMassMatrix(nEdge: number, L: number): number[][] {
  if (nEdge === 2) {
    const c = L / 6
    return [
      [2 * c, c],
      [c, 2 * c],
    ]
  }
  // Quadratic, node order [end, mid, end]: (L/30)·[[4,2,-1],[2,16,2],[-1,2,4]].
  const c = L / 30
  return [
    [4 * c, 2 * c, -1 * c],
    [2 * c, 16 * c, 2 * c],
    [-1 * c, 2 * c, 4 * c],
  ]
}

interface Assembled {
  Kc: CSR
  Q: Float64Array // steady load (generation + edge flux + convective ambient)
  hasRobin: boolean
}

/**
 * Assemble the conductivity matrix (with any convective edge terms folded in)
 * and the steady load vector. The capacitance matrix, when requested, is
 * returned via `capAsm` for the transient solver.
 */
function assemble(input: ThermalInput, capAsm?: Assembler): Assembled {
  const { mesh, k, thickness } = input
  const n = mesh.nodeCount
  const asm = new Assembler(n)
  const Q = new Float64Array(n)
  let hasRobin = false

  for (let e = 0; e < mesh.elemCount; e++) {
    const { nodes, xs, ys } = elemCoords(mesh, e)
    const nne = mesh.order
    const kin = scalarKinematics(mesh.order, xs, ys)
    const ke: number[][] = Array.from({ length: nne }, () => new Array<number>(nne).fill(0))
    const ce: number[][] | null = capAsm
      ? Array.from({ length: nne }, () => new Array<number>(nne).fill(0))
      : null
    for (const g of kin) {
      const scale = g.w * Math.abs(g.detJ) * thickness
      // K_c += (∇N)ᵀ κ (∇N) · scale
      for (let a = 0; a < nne; a++)
        for (let b = 0; b < nne; b++)
          ke[a][b] += k * (g.dNx[a] * g.dNx[b] + g.dNy[a] * g.dNy[b]) * scale
      // Volumetric generation (optionally masked to a sub-region).
      if (input.gen) {
        const inside = input.gen.region ? input.gen.region(g.x, g.y) : true
        if (inside) for (let a = 0; a < nne; a++) Q[nodes[a]] += input.gen.q * g.N[a] * scale
      }
      // Consistent capacitance C += ρc Nᵀ N · scale.
      if (ce) {
        const cs = input.rhoc * scale
        for (let a = 0; a < nne; a++)
          for (let b = 0; b < nne; b++) ce[a][b] += g.N[a] * g.N[b] * cs
      }
    }
    asm.addBlock(nodes, ke)
    if (capAsm && ce) capAsm.addBlock(nodes, ce)
  }

  // Edge boundary conditions: flux (Neumann) and convection (Robin).
  const edges: EdgeName[] = ['left', 'right', 'top', 'bottom']
  for (const edge of edges) {
    const bc = input.bcs[edge]
    if (!bc || bc.kind === 'temp' || bc.kind === 'insulated') continue
    for (const en of boundaryElementEdges(mesh, edge)) {
      const nE = en.length
      const c1 = en[0]
      const c2 = en[nE - 1]
      const L = Math.hypot(mesh.x[c2] - mesh.x[c1], mesh.y[c2] - mesh.y[c1])
      if (bc.kind === 'flux') {
        const w = edgeShapeIntegral(nE, L)
        for (let a = 0; a < nE; a++) Q[en[a]] += bc.q * thickness * w[a]
      } else {
        // Convection: H_edge = h·∫NᵀN ds adds to K; load += h·T∞·∫N ds.
        hasRobin = true
        const M = edgeMassMatrix(nE, L)
        for (let a = 0; a < nE; a++)
          for (let b = 0; b < nE; b++) asm.add(en[a], en[b], bc.h * thickness * M[a][b])
        const w = edgeShapeIntegral(nE, L)
        for (let a = 0; a < nE; a++) Q[en[a]] += bc.h * bc.Tinf * thickness * w[a]
      }
    }
  }

  return { Kc: asm.build(), Q, hasRobin }
}

/** Nodes with a prescribed (Dirichlet) temperature, and the prescribed vector. */
function dirichlet(input: ThermalInput): { fixed: Uint8Array; Tp: Float64Array } {
  const n = input.mesh.nodeCount
  const fixed = new Uint8Array(n)
  const Tp = new Float64Array(n)
  const edges: EdgeName[] = ['left', 'right', 'top', 'bottom']
  for (const edge of edges) {
    const bc = input.bcs[edge]
    if (bc && bc.kind === 'temp') {
      for (const node of edgeNodesQ(input.mesh, edge)) {
        fixed[node] = 1
        Tp[node] = bc.value
      }
    }
  }
  for (const nt of input.nodeTemps ?? []) {
    fixed[nt.node] = 1
    Tp[nt.node] = nt.value
  }
  return { fixed, Tp }
}

/** Solve A·T = b with prescribed values folded in (T fixed = Tp, else free). */
function solvePrescribed(
  A: CSR,
  b: Float64Array,
  fixed: Uint8Array,
  Tp: Float64Array,
  x0?: Float64Array,
): { T: Float64Array; iterations: number; converged: boolean; residual: number } {
  const n = A.n
  const free = new Uint8Array(n)
  for (let i = 0; i < n; i++) free[i] = fixed[i] ? 0 : 1
  // f' = b − A·Tp, then the free-mask CG solves A_ff·ΔT = f'_f with ΔT_fixed = 0.
  const ATp = new Float64Array(n)
  matVec(A, Tp, ATp)
  const rhs = new Float64Array(n)
  for (let i = 0; i < n; i++) rhs[i] = free[i] ? b[i] - ATp[i] : 0
  const guess = x0 ? new Float64Array(n) : undefined
  if (guess && x0) for (let i = 0; i < n; i++) guess[i] = free[i] ? x0[i] - Tp[i] : 0
  const sol = solveCG(A, rhs, free, { tol: 1e-11, maxIter: 40 * n, x0: guess })
  const T = new Float64Array(n)
  for (let i = 0; i < n; i++) T[i] = Tp[i] + sol.x[i]
  return { T, iterations: sol.iterations, converged: sol.converged, residual: sol.residual }
}

// --- heat-flux recovery ---------------------------------------------------

/** Recover −κ∇T at element centroids and a smooth nodal |q| field. */
function recoverFlux(
  mesh: QuadMesh,
  k: number,
  T: Float64Array,
): { elementFlux: ThermalFlux[]; nodalFluxMag: Float64Array; maxFlux: number } {
  const elementFlux: ThermalFlux[] = []
  const nodalAccum = new Float64Array(mesh.nodeCount)
  const nodalCount = new Float64Array(mesh.nodeCount)
  const extrap = extrapMatrix(mesh.order)
  let maxFlux = 0
  for (let e = 0; e < mesh.elemCount; e++) {
    const { nodes, xs, ys } = elemCoords(mesh, e)
    const kin = scalarKinematics(mesh.order, xs, ys)
    // Flux magnitude at each Gauss point, and the centroid average for a glyph.
    const gMag: number[] = []
    let cqx = 0
    let cqy = 0
    let cx = 0
    let cy = 0
    for (let gi = 0; gi < kin.length; gi++) {
      const g = kin[gi]
      let gx = 0
      let gy = 0
      for (let a = 0; a < nodes.length; a++) {
        gx += g.dNx[a] * T[nodes[a]]
        gy += g.dNy[a] * T[nodes[a]]
      }
      const qx = -k * gx
      const qy = -k * gy
      gMag.push(Math.hypot(qx, qy))
      cqx += qx
      cqy += qy
      cx += g.x
      cy += g.y
    }
    const ng = kin.length
    cqx /= ng
    cqy /= ng
    cx /= ng
    cy /= ng
    const cmag = Math.hypot(cqx, cqy)
    elementFlux.push({ qx: cqx, qy: cqy, mag: cmag, cx, cy })
    maxFlux = Math.max(maxFlux, cmag)
    // Extrapolate the (superconvergent) Gauss-point magnitudes to the nodes.
    for (let a = 0; a < nodes.length; a++) {
      let s = 0
      for (let gi = 0; gi < ng; gi++) s += extrap[a][gi] * gMag[gi]
      nodalAccum[nodes[a]] += s
      nodalCount[nodes[a]] += 1
    }
  }
  const nodalFluxMag = new Float64Array(mesh.nodeCount)
  for (let n = 0; n < mesh.nodeCount; n++)
    nodalFluxMag[n] = nodalCount[n] > 0 ? nodalAccum[n] / nodalCount[n] : 0
  return { elementFlux, nodalFluxMag, maxFlux }
}

// --- public solvers -------------------------------------------------------

/** Steady-state heat conduction: (K_c + H)·T = Q. */
export function solveThermalSteady(input: ThermalInput): ThermalResult {
  const { Kc, Q } = assemble(input)
  const { fixed, Tp } = dirichlet(input)
  const sol = solvePrescribed(Kc, Q, fixed, Tp)
  const T = sol.T
  let minT = Infinity
  let maxT = -Infinity
  for (let i = 0; i < T.length; i++) {
    if (T[i] < minT) minT = T[i]
    if (T[i] > maxT) maxT = T[i]
  }
  // Conduction-balance residual on the free DOFs: |K·T − Q| should vanish there
  // (heat in = heat out at every interior node). Normalise by the scale of the
  // nodal fluxes themselves — the boundary rows of K·T carry the real reaction
  // heat flow — so the metric stays meaningful even for a pure-Dirichlet problem
  // whose load vector Q is identically zero.
  const KT = new Float64Array(T.length)
  matVec(Kc, T, KT)
  let scale = 1e-30
  for (let i = 0; i < T.length; i++) scale = Math.max(scale, Math.abs(KT[i]), Math.abs(Q[i]))
  let resid = 0
  for (let i = 0; i < T.length; i++) if (!fixed[i]) resid = Math.max(resid, Math.abs(KT[i] - Q[i]))
  const residual = resid / scale
  const flux = recoverFlux(input.mesh, input.k, T)
  const stable = sol.converged && Number.isFinite(maxT) && Number.isFinite(minT)
  return {
    T,
    minT,
    maxT,
    elementFlux: flux.elementFlux,
    nodalFluxMag: flux.nodalFluxMag,
    maxFlux: flux.maxFlux,
    residual,
    stable,
    iterations: sol.iterations,
  }
}

export interface TransientOptions {
  /** Total simulated time (s). Auto if omitted (a few thermal time constants). */
  totalTime?: number
  /** Number of θ-method steps. */
  steps?: number
  /** θ ∈ [0,1]: 1 = backward Euler, ½ = Crank–Nicolson. */
  theta?: number
  /** Frames to store for animation. */
  frameCount?: number
}

/**
 * Transient conduction C·Ṫ + K_c·T = Q by the θ-method:
 *   (C + θΔt K)·Tⁿ⁺¹ = (C − (1−θ)Δt K)·Tⁿ + Δt·Q
 * with the Dirichlet faces held at their prescribed temperature every step. The
 * part starts uniform at T0 and warms toward its steady field.
 */
export function solveThermalTransient(
  input: ThermalInput,
  opts: TransientOptions = {},
): ThermalTransientResult {
  const capAsm = new Assembler(input.mesh.nodeCount)
  const { Kc, Q } = assemble(input, capAsm)
  const C = capAsm.build()
  const { fixed, Tp } = dirichlet(input)
  const n = Kc.n

  // Estimate a thermal time constant to pick a sensible horizon: τ ≈ ρc·A / (κ·perimeter-ish).
  // A robust proxy is the domain diffusion time L²·ρc/κ over the shorter span.
  const Lx = input.mesh.maxX - input.mesh.minX
  const Ly = input.mesh.maxY - input.mesh.minY
  // The horizon must cover diffusion across the *largest* extent that carries a
  // gradient — using the short span badly underruns a wall heated end-to-end.
  const Lchar = Math.max(Lx, Ly) || 1
  const alpha = input.k / Math.max(input.rhoc, 1e-30) // thermal diffusivity m²/s
  const tau = (Lchar * Lchar) / Math.max(alpha, 1e-30)
  const totalTime = opts.totalTime ?? Math.max(tau * 1.5, 1e-9)
  const steps = Math.max(20, opts.steps ?? 160)
  const theta = opts.theta ?? 0.5
  const dt = totalTime / steps
  const frameCount = Math.min(opts.frameCount ?? 120, steps + 1)

  // Effective system matrix A = C + θΔt·K (constant → assemble once).
  const A: CSR = {
    n,
    rowPtr: Kc.rowPtr,
    col: Kc.col,
    val: new Float64Array(Kc.val.length),
    diag: new Float64Array(n),
  }
  // C and Kc share the same sparsity (same mesh/assembler order), but to be safe
  // we combine by index lookup on Kc's pattern using a scatter of C.
  // Build a fast (row,col)->value map for C via its own CSR.
  for (let i = 0; i < n; i++) {
    for (let p = Kc.rowPtr[i], e = Kc.rowPtr[i + 1]; p < e; p++) {
      const j = Kc.col[p]
      const cij = csrGet(C, i, j)
      const v = cij + theta * dt * Kc.val[p]
      A.val[p] = v
      if (j === i) A.diag[i] = v
    }
  }

  const T0 = input.T0 ?? 0
  let T: Float64Array = new Float64Array(n).fill(T0)
  // Seed Dirichlet faces immediately.
  for (let i = 0; i < n; i++) if (fixed[i]) T[i] = Tp[i]

  const frames: Float64Array[] = []
  const times: number[] = []
  const storeEvery = Math.max(1, Math.floor(steps / (frameCount - 1)))
  const pushFrame = (t: number, arr: Float64Array) => {
    frames.push(Float64Array.from(arr))
    times.push(t)
  }
  pushFrame(0, T)

  let minT = Infinity
  let maxT = -Infinity
  const upd = (arr: Float64Array) => {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] < minT) minT = arr[i]
      if (arr[i] > maxT) maxT = arr[i]
    }
  }
  upd(T)

  // Right-hand-side scratch and previous increment for CG warm start.
  const KT = new Float64Array(n)
  const CTn = new Float64Array(n)
  let prevT: Float64Array = Float64Array.from(T)
  let ok = true
  for (let s = 1; s <= steps; s++) {
    matVec(Kc, T, KT)
    matVec(C, T, CTn)
    const b = new Float64Array(n)
    for (let i = 0; i < n; i++) b[i] = CTn[i] - (1 - theta) * dt * KT[i] + dt * Q[i]
    const sol = solvePrescribed(A, b, fixed, Tp, prevT)
    if (!sol.converged) ok = false
    prevT = T
    T = sol.T
    upd(T)
    if (s % storeEvery === 0 || s === steps) pushFrame(s * dt, T)
    if (!Number.isFinite(maxT)) {
      ok = false
      break
    }
  }

  const steady = ok ? solveThermalSteady(input) : null
  return {
    ok,
    dt,
    nSteps: steps,
    times: Float64Array.from(times),
    frames,
    minT,
    maxT,
    steady,
  }
}

/** Random-access CSR element read (linear scan of a short row). */
function csrGet(A: CSR, i: number, j: number): number {
  for (let p = A.rowPtr[i], e = A.rowPtr[i + 1]; p < e; p++) if (A.col[p] === j) return A.val[p]
  return 0
}
