// GF(2) linear algebra — the substrate of the XOR-reasoning studio.
//
// A system is a set of parity equations over the two-element field 𝔽₂:
//
//     ⊕_{i ∈ support} xᵢ  =  b      (b ∈ {0,1})
//
// Every operation here is exact: rows are packed into a `bigint` bitset (bit i
// present ⇔ variable i appears in the equation) so the whole engine is
// arbitrary-width and allocation-light on the hot path. Variables are 0-based
// internally (0 … numVars-1); the DIMACS/1-based bridge lives in `xor.ts`.
//
// The headline is Gauss–Jordan reduction to *reduced row echelon form* (RREF),
// from which everything else falls out in closed form: the rank, an exact
// solution count (2^(n−rank) when consistent), a particular solution, a basis
// of the null space (so the whole affine solution set is `particular ⊕ span`),
// the *linear backbone* (variables forced to a constant by the linear part
// alone), and an inconsistency certificate (a 0 = 1 row). This is the same
// machinery that lets real SAT solvers — CryptoMiniSat and friends — annihilate
// parity structure that pure clause search blows up on exponentially.

/** One parity equation: `⊕ (vars in mask) = rhs`. */
export interface Gf2Row {
  /** Bit i set ⇔ variable i appears in this equation. */
  mask: bigint
  /** Right-hand side, 0 or 1. */
  rhs: number
}

/** A linear system over 𝔽₂ in `numVars` variables (0-based). */
export interface Gf2System {
  numVars: number
  rows: Gf2Row[]
}

/** The result of Gauss–Jordan reduction. */
export interface RrefResult {
  /** The `rank` reduced pivot rows (each a distinct leading column). */
  rows: Gf2Row[]
  /** `pivotCol[r]` is the leading column of reduced row `r`. */
  pivotCol: number[]
  /** For each variable, its pivot row index, or -1 if the variable is free. */
  rowOfVar: number[]
  /** Number of independent equations. */
  rank: number
  /** True when the system reduces to a `0 = 1` contradiction (no solutions). */
  inconsistent: boolean
  /** Variables that are *not* a pivot (each doubles the solution count). */
  freeVars: number[]
  numVars: number
}

/** Population count of a non-negative bigint (number of variables in a row). */
export function popcountBig(x: bigint): number {
  let n = 0
  while (x > 0n) {
    x &= x - 1n
    n++
  }
  return n
}

/** Index of the lowest set bit, or -1 if `x` is zero. */
export function lowestSetBit(x: bigint): number {
  if (x === 0n) return -1
  let i = 0
  while ((x & 1n) === 0n) {
    x >>= 1n
    i++
  }
  return i
}

/** Deep-copy a system so reduction never mutates the caller's rows. */
export function cloneSystem(sys: Gf2System): Gf2System {
  return { numVars: sys.numVars, rows: sys.rows.map((r) => ({ mask: r.mask, rhs: r.rhs })) }
}

/**
 * Gauss–Jordan elimination to reduced row echelon form.
 *
 * Processing columns left to right, we maintain the invariant that the rows
 * below the current pivot count have *zeros in every processed column*; picking
 * a pivot and XOR-eliminating its column from **all** other rows preserves it
 * (the pivot row is itself zero in the earlier columns, so it never disturbs an
 * established pivot). When the sweep ends, the rows past `rank` are therefore
 * identically zero — a zero row with rhs = 1 is the `0 = 1` contradiction.
 */
export function rref(system: Gf2System): RrefResult {
  const numVars = system.numVars
  const rows: Gf2Row[] = system.rows.map((r) => ({ mask: r.mask, rhs: r.rhs & 1 }))
  const pivotCol: number[] = []
  let r = 0
  for (let col = 0; col < numVars && r < rows.length; col++) {
    const bit = 1n << BigInt(col)
    // Find a pivot for this column among the not-yet-pivoted rows.
    let sel = -1
    for (let i = r; i < rows.length; i++) {
      if ((rows[i].mask & bit) !== 0n) {
        sel = i
        break
      }
    }
    if (sel === -1) continue // free column
    if (sel !== r) {
      const tmp = rows[r]
      rows[r] = rows[sel]
      rows[sel] = tmp
    }
    const piv = rows[r]
    // Eliminate `col` from every other row (Jordan: above and below).
    for (let i = 0; i < rows.length; i++) {
      if (i !== r && (rows[i].mask & bit) !== 0n) {
        rows[i].mask ^= piv.mask
        rows[i].rhs ^= piv.rhs
      }
    }
    pivotCol.push(col)
    r++
  }
  const rank = r
  let inconsistent = false
  for (let i = rank; i < rows.length; i++) {
    // mask is guaranteed zero here; a nonzero rhs is 0 = 1.
    if (rows[i].rhs === 1) {
      inconsistent = true
      break
    }
  }
  const pivotRows = rows.slice(0, rank)
  const rowOfVar = new Array<number>(numVars).fill(-1)
  for (let i = 0; i < rank; i++) rowOfVar[pivotCol[i]] = i
  const freeVars: number[] = []
  for (let v = 0; v < numVars; v++) if (rowOfVar[v] === -1) freeVars.push(v)
  return { rows: pivotRows, pivotCol, rowOfVar, rank, inconsistent, freeVars, numVars }
}

/**
 * Exact number of solutions of the system: `2^(numVars − rank)` when
 * consistent, `0n` otherwise. Returned as a `bigint` — the count can be
 * astronomically larger than a double can hold.
 */
export function solutionCount(system: Gf2System): bigint {
  const rr = rref(system)
  if (rr.inconsistent) return 0n
  return 1n << BigInt(rr.numVars - rr.rank)
}

/** Same as {@link solutionCount} but reusing an existing reduction. */
export function solutionCountOf(rr: RrefResult): bigint {
  if (rr.inconsistent) return 0n
  return 1n << BigInt(rr.numVars - rr.rank)
}

/**
 * One particular solution (free variables pinned to 0), or `null` if the
 * system is inconsistent. Returns a 0-based boolean vector of length numVars.
 */
export function particularSolution(rr: RrefResult): boolean[] | null {
  if (rr.inconsistent) return null
  const x = new Array<boolean>(rr.numVars).fill(false)
  // With every free var = 0, a reduced pivot row's only remaining set bit is
  // its own pivot column, so the pivot variable equals the row's rhs.
  for (let i = 0; i < rr.rank; i++) x[rr.pivotCol[i]] = rr.rows[i].rhs === 1
  return x
}

/**
 * A basis of the null space (the homogeneous solutions). One vector per free
 * variable: set that free variable, then back-substitute the pivots. Any XOR
 * of these vectors added to a particular solution is again a solution, so the
 * whole solution set is `particular ⊕ span(basis)`.
 */
export function nullSpaceBasis(rr: RrefResult): boolean[][] {
  const basis: boolean[][] = []
  for (const f of rr.freeVars) {
    const v = new Array<boolean>(rr.numVars).fill(false)
    v[f] = true
    const fbit = 1n << BigInt(f)
    for (let i = 0; i < rr.rank; i++) {
      if ((rr.rows[i].mask & fbit) !== 0n) v[rr.pivotCol[i]] = true
    }
    basis.push(v)
  }
  return basis
}

/** Does `x` (0-based boolean vector) satisfy every equation of the system? */
export function satisfies(system: Gf2System, x: boolean[]): boolean {
  for (const row of system.rows) {
    let parity = 0
    let m = row.mask
    let v = 0
    while (m > 0n) {
      if ((m & 1n) !== 0n && x[v]) parity ^= 1
      m >>= 1n
      v++
    }
    if (parity !== (row.rhs & 1)) return false
  }
  return true
}

/**
 * Enumerate up to `limit` solutions as `particular ⊕ subset-XOR(basis)`. With
 * `k` free variables there are `2^k` solutions in all; the walk is a Gray-code
 * order so each successive vector differs from the last by a single basis XOR.
 */
export function enumerateSolutions(system: Gf2System, limit = 1024): boolean[][] {
  const rr = rref(system)
  const base = particularSolution(rr)
  if (!base) return []
  const basis = nullSpaceBasis(rr)
  const k = basis.length
  const out: boolean[][] = []
  const cur = base.slice()
  const total = k >= 30 ? Infinity : 1 << k
  out.push(cur.slice())
  let prevGray = 0
  for (let i = 1; i < total && out.length < limit; i++) {
    const gray = i ^ (i >>> 1)
    const changed = gray ^ prevGray // exactly one bit
    prevGray = gray
    const b = Math.log2(changed) | 0
    const vec = basis[b]
    for (let v = 0; v < rr.numVars; v++) if (vec[v]) cur[v] = !cur[v]
    out.push(cur.slice())
  }
  return out
}

/**
 * The *linear backbone*: variables forced to a fixed value by the parity
 * equations alone (a reduced pivot row whose only variable is its pivot). Each
 * is returned as a 0-based variable index and its forced boolean value. Empty
 * when the system is inconsistent.
 */
export function linearBackbone(rr: RrefResult): { var: number; value: boolean }[] {
  if (rr.inconsistent) return []
  const out: { var: number; value: boolean }[] = []
  for (let i = 0; i < rr.rank; i++) {
    if (popcountBig(rr.rows[i].mask) === 1) {
      out.push({ var: rr.pivotCol[i], value: rr.rows[i].rhs === 1 })
    }
  }
  return out
}
