// Density-based topology optimization — SIMP + Optimality Criteria.
//
// This is the discipline the catalog's FEA studio was missing: not *analysing* a
// given structure, but letting the equations *design* one. Given a rectangular
// design domain, a set of supports, a load, and a material budget (a target
// volume fraction), find the stiffest possible structure — the material layout
// that minimizes compliance C = Uᵀ K U subject to ∑ρ ≤ V*. The answer is the
// iconic organic, bone-like truss that no human draws by hand.
//
// The method is **SIMP** (Solid Isotropic Material with Penalization, Bendsøe &
// Sigmund): each element carries a continuous density ρ∈[0,1], its Young's
// modulus is interpolated E(ρ) = Emin + ρ^p (E0−Emin), and the penalty exponent
// p>1 makes intermediate ("grey") densities uneconomical so the design pushes
// toward a clean black-and-white 0/1 layout. The optimization is the textbook
// nested loop:
//
//   1. FE analysis  — assemble K(ρ), solve K U = F.
//   2. Objective    — compliance C = ∑ E(ρ_e) · uₑᵀ k⁰ uₑ  (k⁰ = unit-E element K).
//   3. Sensitivity  — ∂C/∂ρ_e = −p ρ_e^{p−1}(E0−Emin) · uₑᵀ k⁰ uₑ  (self-adjoint).
//   4. Filter       — a linear density (or sensitivity) filter of radius rmin
//                     regularizes the problem: kills the checkerboard instability
//                     and makes the result mesh-independent.
//   5. Update       — the Optimality Criteria (OC) fixed-point step with a
//                     bisection on the Lagrange multiplier enforcing the volume
//                     constraint exactly, plus move limits.
//
// It reuses the studio's own machinery: the Q4 bilinear element stiffness
// (isoparam.elementMatrices), the sparse SPD assembler and the Jacobi-PCG solver
// (linalg). Everything here is pure `number[]`/typed-array maths — deterministic,
// no DOM — so validate.ts can cross-check compliance against the energy balance
// Uᵀ K U = FᵀU and the analytic sensitivity against a finite difference, exactly
// like every other solver in the engine.

import { elementMatrices, planeStressD } from './isoparam'
import { matVec, solveCG, type CSR } from './linalg'

export type FilterKind = 'sensitivity' | 'density'

/** A fully-specified topology-optimization problem on a structured grid. */
export interface TopOptSpec {
  nelx: number
  nely: number
  /** Target material fraction V* ∈ (0,1). */
  volfrac: number
  /** SIMP penalty exponent p (≥1; 3 is standard). */
  penal: number
  /** Filter radius in element widths (≥1 kills the checkerboard). */
  rmin: number
  /** Density (Bendsøe) or classic Sigmund sensitivity filter. */
  filter: FilterKind
  /** Poisson's ratio of the base material. */
  nu: number
  /** Global DOFs held at zero (supports + symmetry planes). */
  fixedDofs: number[]
  /** Applied nodal loads, by global DOF. */
  loads: { dof: number; value: number }[]
  /** Elements forced fully solid (ρ=1) — never removed. */
  passiveSolid?: boolean[]
  /** Elements forced fully void (ρ=0) — a hole in the domain. */
  passiveVoid?: boolean[]
  /** Solid modulus E0 (default 1 — compliance is then in consistent units). */
  E0?: number
  /** Void floor Emin (default 1e-9·E0) keeping K positive-definite. */
  Emin?: number
  /** OC move limit per step (default 0.2). */
  move?: number
  /** PCG relative tolerance for the inner FE solve (default 1e-8). */
  cgTol?: number
  /** Enable the smoothed-Heaviside projection (drives grey → crisp 0/1). Density filter only. */
  heaviside?: boolean
  /** Heaviside sharpness β (1 ≈ soft, large = near-binary). Continuation raises it. */
  beta?: number
  /** Heaviside threshold η ∈ (0,1) — the density that maps to ½ (default 0.5). */
  eta?: number
}

/**
 * Smoothed (tanh) Heaviside projection ρ̄(ρ̃): pushes the filtered density toward
 * 0 or 1 around the threshold η, sharper as β grows. With η=½ it fixes both
 * endpoints exactly (ρ̄(0)=0, ρ̄(1)=1) and is volume-preserving under the OC
 * bisection. This is what turns the density filter's grey transition band into a
 * crisp black-and-white manufacturable design (Guest/Wang/Sigmund).
 */
export function tanhProject(v: number, beta: number, eta: number): number {
  const a = Math.tanh(beta * eta)
  return (a + Math.tanh(beta * (v - eta))) / (a + Math.tanh(beta * (1 - eta)))
}

/** ∂ρ̄/∂ρ̃ of the tanh projection — the chain-rule factor for the sensitivities. */
export function tanhProjectDeriv(v: number, beta: number, eta: number): number {
  const denom = Math.tanh(beta * eta) + Math.tanh(beta * (1 - eta))
  const th = Math.tanh(beta * (v - eta))
  return (beta * (1 - th * th)) / denom
}

export interface TopOptStep {
  iter: number
  /** Compliance C = Uᵀ K U (the objective; lower = stiffer). */
  compliance: number
  /** Realized material fraction ∑ρ_phys / N. */
  volume: number
  /** Max design change ‖ρⁿ⁺¹ − ρⁿ‖_∞ (the OC convergence measure). */
  change: number
  /** Measure of non-discreteness M_nd = ∑4ρ(1−ρ)/N ∈ [0,1] (0 = crisp 0/1). */
  grayness: number
}

/** Node index (i,j) → id, row-major with i∈[0,nelx], j∈[0,nely]. */
export function nodeId(nelx: number, i: number, j: number): number {
  return j * (nelx + 1) + i
}

// ---------------------------------------------------------------------------
// Element connectivity and the unit-E element stiffness.
// ---------------------------------------------------------------------------

/**
 * The 8 global DOFs of element (ex,ey), in Q4 CCW order matching isoparam's
 * NODE_NAT: bottom-left, bottom-right, top-right, top-left. Physical coords are
 * unit squares with y pointing up.
 */
function elementDofs(nelx: number, ex: number, ey: number): Int32Array {
  const n0 = nodeId(nelx, ex, ey)
  const n1 = nodeId(nelx, ex + 1, ey)
  const n2 = nodeId(nelx, ex + 1, ey + 1)
  const n3 = nodeId(nelx, ex, ey + 1)
  return Int32Array.of(
    2 * n0,
    2 * n0 + 1,
    2 * n1,
    2 * n1 + 1,
    2 * n2,
    2 * n2 + 1,
    2 * n3,
    2 * n3 + 1,
  )
}

/** k⁰: the 8×8 Q4 plane-stress element stiffness for a unit square at E=1. */
export function unitElementK(nu: number): number[][] {
  const D = planeStressD(1, nu)
  const { Ke } = elementMatrices(4, [0, 1, 1, 0], [0, 0, 1, 1], D, 0, 1)
  return Ke
}

// ---------------------------------------------------------------------------
// The density / sensitivity filter (radius rmin, linear cone weights).
// ---------------------------------------------------------------------------

interface Filter {
  /** For element e: neighbor element indices within rmin. */
  neigh: Int32Array[]
  /** Matching cone weights max(0, rmin − dist). */
  weight: Float64Array[]
  /** Row sums Hs[e] = ∑ weights. */
  Hs: Float64Array
}

function buildFilter(nelx: number, nely: number, rmin: number): Filter {
  const n = nelx * nely
  const neigh: Int32Array[] = new Array(n)
  const weight: Float64Array[] = new Array(n)
  const Hs = new Float64Array(n)
  const r = Math.ceil(rmin) - 1
  for (let ey = 0; ey < nely; ey++) {
    for (let ex = 0; ex < nelx; ex++) {
      const e = ey * nelx + ex
      const ns: number[] = []
      const ws: number[] = []
      let hs = 0
      const jx0 = Math.max(ex - r, 0)
      const jx1 = Math.min(ex + r, nelx - 1)
      const jy0 = Math.max(ey - r, 0)
      const jy1 = Math.min(ey + r, nely - 1)
      for (let fy = jy0; fy <= jy1; fy++) {
        for (let fx = jx0; fx <= jx1; fx++) {
          const dist = Math.hypot(ex - fx, ey - fy)
          const w = rmin - dist
          if (w > 0) {
            ns.push(fy * nelx + fx)
            ws.push(w)
            hs += w
          }
        }
      }
      neigh[e] = Int32Array.from(ns)
      weight[e] = Float64Array.from(ws)
      Hs[e] = hs
    }
  }
  return { neigh, weight, Hs }
}

/** Density filter: ρ_phys = (H ρ) / Hs. Partition-of-unity ⇒ preserves constants. */
function applyDensityFilter(F: Filter, x: Float64Array, out: Float64Array): void {
  for (let e = 0; e < x.length; e++) {
    const ns = F.neigh[e]
    const ws = F.weight[e]
    let s = 0
    for (let k = 0; k < ns.length; k++) s += ws[k] * x[ns[k]]
    out[e] = s / F.Hs[e]
  }
}

/** Chain-rule transform of a field defined on ρ_phys back to ρ: (H (·/Hs)). */
function filterSensitivity(F: Filter, field: Float64Array, out: Float64Array): void {
  const tmp = new Float64Array(field.length)
  for (let e = 0; e < field.length; e++) tmp[e] = field[e] / F.Hs[e]
  for (let e = 0; e < field.length; e++) {
    const ns = F.neigh[e]
    const ws = F.weight[e]
    let s = 0
    for (let k = 0; k < ns.length; k++) s += ws[k] * tmp[ns[k]]
    out[e] = s
  }
}

// ---------------------------------------------------------------------------
// The optimizer.
// ---------------------------------------------------------------------------

export class TopOpt {
  readonly nelx: number
  readonly nely: number
  readonly nElem: number
  readonly nDof: number
  readonly spec: Required<
    Pick<TopOptSpec, 'volfrac' | 'penal' | 'rmin' | 'filter' | 'nu' | 'E0' | 'Emin' | 'move' | 'cgTol' | 'heaviside' | 'beta' | 'eta'>
  > &
    TopOptSpec

  private readonly KE: number[][]
  private readonly KEflat: Float64Array // row-major 8×8
  private readonly edof: Int32Array // nElem × 8
  private readonly free: Uint8Array
  private readonly F: Float64Array
  private readonly filter: Filter
  private readonly passiveSolid: boolean[] | null
  private readonly passiveVoid: boolean[] | null
  private readonly volTarget: number

  // Precomputed sparsity: CSR pattern + per-(element,a,b) slot into `val`.
  private readonly pattern: { n: number; rowPtr: Int32Array; col: Int32Array }
  private readonly slot: Int32Array // nElem*64 → index into val

  /** Design variables (pre-filter) and the physical (filtered/projected) densities. */
  x: Float64Array
  xPhys: Float64Array
  /** The filtered-but-unprojected field ρ̃ = H x / Hs (Heaviside chain rule needs it). */
  xTilde: Float64Array
  /** Last solved displacement field. */
  U: Float64Array
  /** Per-element strain-energy density uₑᵀ k⁰ uₑ from the last solve. */
  energy: Float64Array
  /** Reusable scratch for the OC volume bisection (avoids per-iteration allocation). */
  private readonly projBuf: Float64Array

  iter = 0
  compliance = 0
  change = 1

  constructor(spec: TopOptSpec) {
    const nelx = spec.nelx
    const nely = spec.nely
    this.nelx = nelx
    this.nely = nely
    this.nElem = nelx * nely
    this.nDof = 2 * (nelx + 1) * (nely + 1)
    this.spec = {
      ...spec,
      E0: spec.E0 ?? 1,
      Emin: spec.Emin ?? (spec.E0 ?? 1) * 1e-9,
      move: spec.move ?? 0.2,
      cgTol: spec.cgTol ?? 1e-8,
      heaviside: spec.heaviside ?? false,
      beta: spec.beta ?? 1,
      eta: spec.eta ?? 0.5,
    }

    this.KE = unitElementK(spec.nu)
    this.KEflat = new Float64Array(64)
    for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) this.KEflat[a * 8 + b] = this.KE[a][b]

    this.edof = new Int32Array(this.nElem * 8)
    for (let ey = 0; ey < nely; ey++) {
      for (let ex = 0; ex < nelx; ex++) {
        const e = ey * nelx + ex
        const d = elementDofs(nelx, ex, ey)
        this.edof.set(d, e * 8)
      }
    }

    // Supports / free mask.
    this.free = new Uint8Array(this.nDof).fill(1)
    for (const d of spec.fixedDofs) this.free[d] = 0
    // Load vector.
    this.F = new Float64Array(this.nDof)
    for (const { dof, value } of spec.loads) this.F[dof] += value

    this.filter = buildFilter(nelx, nely, spec.rmin)
    this.passiveSolid = spec.passiveSolid ?? null
    this.passiveVoid = spec.passiveVoid ?? null

    // Initialize the design at the target volume fraction (respecting passives),
    // then set the true volume budget to the realized initial volume.
    this.x = new Float64Array(this.nElem).fill(spec.volfrac)
    if (this.passiveSolid) for (let e = 0; e < this.nElem; e++) if (this.passiveSolid[e]) this.x[e] = 1
    if (this.passiveVoid) for (let e = 0; e < this.nElem; e++) if (this.passiveVoid[e]) this.x[e] = 0
    this.xPhys = new Float64Array(this.nElem)
    this.xTilde = new Float64Array(this.nElem)
    this.projectDensity()
    let vol = 0
    for (let e = 0; e < this.nElem; e++) vol += this.xPhys[e]
    this.volTarget = spec.volfrac * this.nElem
    // (volTarget stays the nominal target; passives are handled inside the OC bisection.)
    void vol

    this.U = new Float64Array(this.nDof)
    this.energy = new Float64Array(this.nElem)
    this.projBuf = new Float64Array(this.nElem)

    const { pattern, slot } = this.buildPattern()
    this.pattern = pattern
    this.slot = slot
  }

  /**
   * Map a design field `xIn` to physical densities `out` (filter → optional
   * Heaviside projection → passive overrides). Optionally records the
   * intermediate filtered field ρ̃ in `tilde` for the chain rule. This is the
   * single source of truth used both to refresh the state and inside the OC
   * volume bisection, so the constraint is enforced on exactly what the FE
   * solve sees.
   */
  private computePhys(xIn: Float64Array, out: Float64Array, tilde?: Float64Array): void {
    if (this.spec.filter === 'density') {
      const t = tilde ?? new Float64Array(this.nElem)
      applyDensityFilter(this.filter, xIn, t)
      if (this.spec.heaviside) {
        const { beta, eta } = this.spec
        for (let e = 0; e < this.nElem; e++) out[e] = tanhProject(t[e], beta, eta)
      } else {
        out.set(t)
      }
    } else {
      out.set(xIn)
      if (tilde) tilde.set(xIn)
    }
    // Passive overrides survive filtering and projection.
    if (this.passiveSolid) for (let e = 0; e < this.nElem; e++) if (this.passiveSolid[e]) out[e] = 1
    if (this.passiveVoid) for (let e = 0; e < this.nElem; e++) if (this.passiveVoid[e]) out[e] = 0
  }

  /** Refresh xPhys (and xTilde) from the current design variables x. */
  private projectDensity(): void {
    this.computePhys(this.x, this.xPhys, this.xTilde)
  }

  /** Public re-projection hook (used by the validation harness). */
  reproject(): void {
    this.projectDensity()
  }

  /** Build the constant CSR sparsity pattern and the per-element scatter slots. */
  private buildPattern(): { pattern: { n: number; rowPtr: Int32Array; col: Int32Array }; slot: Int32Array } {
    const n = this.nDof
    const rowSets: Map<number, number>[] = Array.from({ length: n }, () => new Map())
    for (let e = 0; e < this.nElem; e++) {
      const base = e * 8
      for (let a = 0; a < 8; a++) {
        const ia = this.edof[base + a]
        const row = rowSets[ia]
        for (let b = 0; b < 8; b++) {
          const ib = this.edof[base + b]
          if (!row.has(ib)) row.set(ib, row.size)
        }
      }
    }
    const rowPtr = new Int32Array(n + 1)
    for (let i = 0; i < n; i++) rowPtr[i + 1] = rowPtr[i] + rowSets[i].size
    const nnz = rowPtr[n]
    const col = new Int32Array(nnz)
    // Column index → slot within each row (sorted ascending for a clean CSR).
    const colSlot: Map<number, number>[] = Array.from({ length: n }, () => new Map())
    for (let i = 0; i < n; i++) {
      const cols = [...rowSets[i].keys()].sort((a, b) => a - b)
      let p = rowPtr[i]
      for (const c of cols) {
        col[p] = c
        colSlot[i].set(c, p)
        p++
      }
    }
    const slot = new Int32Array(this.nElem * 64)
    for (let e = 0; e < this.nElem; e++) {
      const base = e * 8
      for (let a = 0; a < 8; a++) {
        const ia = this.edof[base + a]
        for (let b = 0; b < 8; b++) {
          const ib = this.edof[base + b]
          slot[e * 64 + a * 8 + b] = colSlot[ia].get(ib)!
        }
      }
    }
    return { pattern: { n, rowPtr, col }, slot }
  }

  /** Assemble K(ρ_phys) into a fresh CSR using the precomputed pattern. */
  private assemble(): CSR {
    const { n, rowPtr, col } = this.pattern
    const val = new Float64Array(col.length)
    const { E0, Emin, penal } = this.spec
    for (let e = 0; e < this.nElem; e++) {
      const rho = this.xPhys[e]
      const scale = Emin + Math.pow(rho, penal) * (E0 - Emin)
      const sBase = e * 64
      for (let ab = 0; ab < 64; ab++) {
        val[this.slot[sBase + ab]] += scale * this.KEflat[ab]
      }
    }
    const diag = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      for (let p = rowPtr[i], end = rowPtr[i + 1]; p < end; p++) {
        if (col[p] === i) {
          diag[i] = val[p]
          break
        }
      }
    }
    return { n, rowPtr, col, val, diag }
  }

  /** One FE solve at the current ρ_phys: fills U, per-element energy, compliance. */
  solveFE(): number {
    const K = this.assemble()
    // Warm-start from the previous displacement: between OC steps the design —
    // and hence U — changes little, so the prior solution is an excellent guess.
    const warm = this.iter > 0 ? this.U : undefined
    const res = solveCG(K, this.F, this.free, { tol: this.spec.cgTol, maxIter: 50 * this.nDof, x0: warm })
    this.U = res.x
    // Compliance and per-element self-adjoint energy.
    let c = 0
    const { E0, Emin, penal } = this.spec
    const u = this.U
    for (let e = 0; e < this.nElem; e++) {
      const base = e * 8
      // ue = U[edof]; ce0 = ueᵀ k⁰ ue
      let ce0 = 0
      for (let a = 0; a < 8; a++) {
        const ua = u[this.edof[base + a]]
        let row = 0
        for (let b = 0; b < 8; b++) row += this.KEflat[a * 8 + b] * u[this.edof[base + b]]
        ce0 += ua * row
      }
      this.energy[e] = ce0
      const Ee = Emin + Math.pow(this.xPhys[e], penal) * (E0 - Emin)
      c += Ee * ce0
    }
    this.compliance = c
    return c
  }

  /** ∂C/∂ρ_phys (negative) and the raw per-element sensitivities. */
  private sensitivity(dc: Float64Array): void {
    const { E0, Emin, penal } = this.spec
    for (let e = 0; e < this.nElem; e++) {
      const rho = this.xPhys[e]
      dc[e] = -penal * Math.pow(rho, penal - 1) * (E0 - Emin) * this.energy[e]
    }
  }

  /**
   * The compliance and volume gradients with respect to the *design* variables
   * x — i.e. the raw ∂C/∂ρ_phys and ∂V/∂ρ_phys pushed back through the Heaviside
   * projection (∂ρ̄/∂ρ̃) and the density filter (H(·/Hs)). Assumes solveFE() ran.
   * Exposed so the harness can check the whole chain against a finite difference.
   */
  filteredSensitivity(): { dc: Float64Array; dv: Float64Array } {
    const dc = new Float64Array(this.nElem)
    const dv = new Float64Array(this.nElem).fill(1)
    this.sensitivity(dc) // ∂C/∂ρ_phys

    if (this.spec.filter === 'sensitivity') {
      // Sigmund's sensitivity filter: weighted average of ρ·∂C, normalized.
      const dcNew = new Float64Array(this.nElem)
      for (let e = 0; e < this.nElem; e++) {
        const ns = this.filter.neigh[e]
        const ws = this.filter.weight[e]
        let s = 0
        for (let k = 0; k < ns.length; k++) s += ws[k] * this.x[ns[k]] * dc[ns[k]]
        dcNew[e] = s / (this.filter.Hs[e] * Math.max(1e-3, this.x[e]))
      }
      return { dc: dcNew, dv }
    }

    // Density filter (+ optional Heaviside): apply the projection chain-rule
    // factor ∂ρ̄/∂ρ̃ *before* the filter transpose.
    if (this.spec.heaviside) {
      const { beta, eta } = this.spec
      for (let e = 0; e < this.nElem; e++) {
        const d = tanhProjectDeriv(this.xTilde[e], beta, eta)
        dc[e] *= d
        dv[e] *= d
      }
    }
    const dcF = new Float64Array(this.nElem)
    const dvF = new Float64Array(this.nElem)
    filterSensitivity(this.filter, dc, dcF)
    filterSensitivity(this.filter, dv, dvF)
    return { dc: dcF, dv: dvF }
  }

  /**
   * One full optimization iteration: FE solve, sensitivity, filter, OC update.
   * Returns the step diagnostics. Call repeatedly until `change` is small.
   */
  step(): TopOptStep {
    this.solveFE()
    const { dc, dv } = this.filteredSensitivity()
    const change = this.ocUpdate(dc, dv)

    // Realized volume + grayness on the physical densities.
    let vol = 0
    let gray = 0
    for (let e = 0; e < this.nElem; e++) {
      vol += this.xPhys[e]
      gray += 4 * this.xPhys[e] * (1 - this.xPhys[e])
    }
    this.iter++
    this.change = change
    return {
      iter: this.iter,
      compliance: this.compliance,
      volume: vol / this.nElem,
      change,
      grayness: gray / this.nElem,
    }
  }

  /** Optimality-Criteria fixed-point update with a bisection on the multiplier. */
  private ocUpdate(dc: Float64Array, dv: Float64Array): number {
    const move = this.spec.move
    const xnew = new Float64Array(this.nElem)
    let l1 = 1e-9
    let l2 = 1e9
    const target = this.volTarget
    // Bisection to satisfy the volume constraint ∑ρ_phys(xnew) = target.
    while ((l2 - l1) / (l1 + l2) > 1e-6) {
      const lmid = 0.5 * (l1 + l2)
      for (let e = 0; e < this.nElem; e++) {
        if (this.passiveSolid && this.passiveSolid[e]) {
          xnew[e] = 1
          continue
        }
        if (this.passiveVoid && this.passiveVoid[e]) {
          xnew[e] = 0
          continue
        }
        // OC: xnew = x·√(−dc/(λ·dv)), clamped by the move limit and [0,1].
        const be = Math.max(0, -dc[e] / (dv[e] * lmid))
        let cand = this.x[e] * Math.sqrt(be)
        if (cand > this.x[e] + move) cand = this.x[e] + move
        if (cand < this.x[e] - move) cand = this.x[e] - move
        if (cand > 1) cand = 1
        if (cand < 0) cand = 0
        xnew[e] = cand
      }
      // Realized volume after filtering + projection — exactly what the FE solve
      // will see, so the constraint binds on the physical densities.
      this.computePhys(xnew, this.projBuf)
      let vol = 0
      for (let e = 0; e < this.nElem; e++) vol += this.projBuf[e]
      if (vol > target) l1 = lmid
      else l2 = lmid
    }
    // Commit.
    let change = 0
    for (let e = 0; e < this.nElem; e++) {
      const d = Math.abs(xnew[e] - this.x[e])
      if (d > change) change = d
      this.x[e] = xnew[e]
    }
    this.projectDensity()
    return change
  }

  /** Verify the internal energy balance Uᵀ K U = FᵀU at the current solve. */
  energyBalance(): { UKU: number; FU: number; rel: number } {
    const K = this.assemble()
    const KU = new Float64Array(this.nDof)
    matVec(K, this.U, KU)
    let UKU = 0
    let FU = 0
    for (let i = 0; i < this.nDof; i++) {
      UKU += this.U[i] * KU[i]
      FU += this.F[i] * this.U[i]
    }
    return { UKU, FU, rel: Math.abs(UKU - FU) / (Math.abs(FU) + 1e-30) }
  }
}

// ---------------------------------------------------------------------------
// Problem builders — the canonical topology-optimization benchmarks.
// ---------------------------------------------------------------------------

export interface ProblemDef {
  id: string
  name: string
  blurb: string
  /** Default grid + budget the UI seeds; the user can override. */
  defaults: { nelx: number; nely: number; volfrac: number; rmin: number }
  /** If set, the design is a half-model; the viewer mirrors it for display. */
  symmetry?: 'left'
  build: (nelx: number, nely: number, volfrac: number, rmin: number, filter: FilterKind) => TopOptSpec
}

const NU = 0.3
const PENAL = 3

/** MBB beam (half domain by symmetry): the "hello world" of topology optimization. */
function mbb(nelx: number, nely: number, volfrac: number, rmin: number, filter: FilterKind): TopOptSpec {
  const fixed: number[] = []
  // Symmetry plane on the left edge: u_x = 0 for every node at i=0.
  for (let j = 0; j <= nely; j++) fixed.push(2 * nodeId(nelx, 0, j))
  // Roller at the bottom-right corner: u_y = 0.
  fixed.push(2 * nodeId(nelx, nelx, 0) + 1)
  // Downward point load at the top-left corner.
  const loads = [{ dof: 2 * nodeId(nelx, 0, nely) + 1, value: -1 }]
  return { nelx, nely, volfrac, penal: PENAL, rmin, filter, nu: NU, fixedDofs: fixed, loads }
}

/** Tip-loaded cantilever: fully fixed left edge, point load at the free-end mid-height. */
function cantilever(nelx: number, nely: number, volfrac: number, rmin: number, filter: FilterKind): TopOptSpec {
  const fixed: number[] = []
  for (let j = 0; j <= nely; j++) {
    const n = nodeId(nelx, 0, j)
    fixed.push(2 * n, 2 * n + 1)
  }
  const midJ = Math.round(nely / 2)
  const loads = [{ dof: 2 * nodeId(nelx, nelx, midJ) + 1, value: -1 }]
  return { nelx, nely, volfrac, penal: PENAL, rmin, filter, nu: NU, fixedDofs: fixed, loads }
}

/** Michell-type mid-span: simply supported bottom corners, central bottom load. */
function michell(nelx: number, nely: number, volfrac: number, rmin: number, filter: FilterKind): TopOptSpec {
  const fixed: number[] = []
  // Pin the bottom-left corner (both DOFs); roller the bottom-right (u_y only).
  const bl = nodeId(nelx, 0, 0)
  fixed.push(2 * bl, 2 * bl + 1)
  fixed.push(2 * nodeId(nelx, nelx, 0) + 1)
  const loads = [{ dof: 2 * nodeId(nelx, Math.round(nelx / 2), 0) + 1, value: -1 }]
  return { nelx, nely, volfrac, penal: PENAL, rmin, filter, nu: NU, fixedDofs: fixed, loads }
}

/** Deck bridge: pinned bottom corners, a distributed downward load across the top deck. */
function bridge(nelx: number, nely: number, volfrac: number, rmin: number, filter: FilterKind): TopOptSpec {
  const fixed: number[] = []
  const bl = nodeId(nelx, 0, 0)
  const br = nodeId(nelx, nelx, 0)
  fixed.push(2 * bl, 2 * bl + 1, 2 * br, 2 * br + 1)
  // Uniform downward load along the top edge (a road deck carried by the structure).
  const loads: { dof: number; value: number }[] = []
  const total = -1
  for (let i = 0; i <= nelx; i++) {
    const w = i === 0 || i === nelx ? 0.5 : 1
    loads.push({ dof: 2 * nodeId(nelx, i, nely) + 1, value: (total * w) / nelx })
  }
  return { nelx, nely, volfrac, penal: PENAL, rmin, filter, nu: NU, fixedDofs: fixed, loads }
}

/** L-bracket: the domain's upper-right quadrant is void; fixed top edge, tip load. */
function lbracket(nelx: number, nely: number, volfrac: number, rmin: number, filter: FilterKind): TopOptSpec {
  const cutX = Math.round(nelx * 0.5)
  const cutY = Math.round(nely * 0.5)
  const passiveVoid: boolean[] = new Array(nelx * nely).fill(false)
  for (let ey = 0; ey < nely; ey++) {
    for (let ex = 0; ex < nelx; ex++) {
      if (ex >= cutX && ey >= cutY) passiveVoid[ey * nelx + ex] = true
    }
  }
  const fixed: number[] = []
  // Fully fixed along the top edge (the bracket hangs from the wall/ceiling).
  for (let i = 0; i <= nelx; i++) {
    const n = nodeId(nelx, i, nely)
    fixed.push(2 * n, 2 * n + 1)
  }
  // Downward load at the tip of the horizontal arm (right edge, at the re-entrant height).
  const loads = [{ dof: 2 * nodeId(nelx, nelx, cutY) + 1, value: -1 }]
  return { nelx, nely, volfrac, penal: PENAL, rmin, filter, nu: NU, fixedDofs: fixed, loads, passiveVoid }
}

export const PROBLEMS: ProblemDef[] = [
  {
    id: 'mbb',
    name: 'MBB beam',
    blurb:
      'The Messerschmitt–Bölkow–Blohm beam — the canonical benchmark. Half the beam is modeled ' +
      'by symmetry; the optimizer discovers a fanned interior truss under a point load.',
    defaults: { nelx: 100, nely: 34, volfrac: 0.5, rmin: 2.4 },
    symmetry: 'left',
    build: mbb,
  },
  {
    id: 'cantilever',
    name: 'Cantilever',
    blurb:
      'A tip-loaded cantilever fixed to a wall. Compliance minimization grows the iconic ' +
      'branching, bone-like arm that carries the end load back to the support.',
    defaults: { nelx: 80, nely: 48, volfrac: 0.4, rmin: 2.4 },
    build: cantilever,
  },
  {
    id: 'michell',
    name: 'Michell span',
    blurb:
      'A simply-supported span under a central load. The optimum approaches the analytic ' +
      'Michell truss — an X of tension and compression members.',
    defaults: { nelx: 84, nely: 42, volfrac: 0.35, rmin: 2.4 },
    build: michell,
  },
  {
    id: 'bridge',
    name: 'Deck bridge',
    blurb:
      'A deck carried between two pinned abutments under a distributed load. The optimizer ' +
      'raises an arch (or a tied truss) beneath the road.',
    defaults: { nelx: 100, nely: 36, volfrac: 0.35, rmin: 2.4 },
    build: bridge,
  },
  {
    id: 'lbracket',
    name: 'L-bracket',
    blurb:
      'The classic re-entrant-corner bracket: a void upper-right quadrant, hung from the top, ' +
      'loaded at the arm tip. The design rounds the sharp corner away to relieve the stress.',
    defaults: { nelx: 64, nely: 64, volfrac: 0.4, rmin: 2.4 },
    build: lbracket,
  },
]

export function problemById(id: string): ProblemDef {
  return PROBLEMS.find((p) => p.id === id) ?? PROBLEMS[0]
}
