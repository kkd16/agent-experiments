// Lights Out as linear algebra over 𝔽₂ — the studio's visual payoff.
//
// On an r×c grid, pressing a cell toggles itself and its orthogonal neighbours.
// Toggling is XOR and presses commute and self-cancel (pressing twice = not
// pressing), so "which buttons clear the board?" is *exactly* a linear system
// `A · p = b`: column `j` of `A` is the toggle footprint of button `j`, `b` is
// the starting lit pattern, and a solution `p` is a set of presses. Everything
// the puzzle asks then reads straight off the reduction:
//
//   • solvable ⇔ the system is consistent;
//   • the **quiet patterns** (press sets that change nothing) are the null space;
//   • the number of distinct solutions is 2^(nullity);
//   • the **minimum-press** solution is the lightest vector in the solution coset.
//
// The classic 5×5 board is famously always solvable with a 2-dimensional quiet
// space (4 solutions to every solvable position) — a fact this file's engine
// rediscovers from scratch, and the self-tests confirm by actually clearing the
// board with the presses it returns.

import { rref, particularSolution, nullSpaceBasis, type Gf2System } from './gf2'

export interface LightsOutSolution {
  rows: number
  cols: number
  /** The starting board (row-major; true = lit). */
  board: boolean[]
  solvable: boolean
  /** A minimum-weight set of presses (row-major boolean), or null if unsolvable. */
  minPresses: boolean[] | null
  /** Number of buttons in the minimum solution. */
  minCount: number
  /** Quiet patterns: presses that leave every light unchanged (null-space basis). */
  quietPatterns: boolean[][]
  /** Total number of distinct solutions (2^nullity), or 0 if unsolvable. */
  solutionCount: bigint
}

/** Row-major index of cell (r, c). */
const idx = (r: number, c: number, cols: number) => r * cols + c

/**
 * Build the toggle system for an r×c board. Column `j` is button j's footprint;
 * the right-hand side is the lit pattern we must cancel.
 */
export function lightsOutSystem(rows: number, cols: number, board: boolean[]): Gf2System {
  const n = rows * cols
  // Row `cell` of A: which buttons toggle this cell = the cell itself + neighbours.
  const rowsOut = new Array<{ mask: bigint; rhs: number }>(n)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = idx(r, c, cols)
      let mask = 1n << BigInt(cell)
      if (r > 0) mask |= 1n << BigInt(idx(r - 1, c, cols))
      if (r < rows - 1) mask |= 1n << BigInt(idx(r + 1, c, cols))
      if (c > 0) mask |= 1n << BigInt(idx(r, c - 1, cols))
      if (c < cols - 1) mask |= 1n << BigInt(idx(r, c + 1, cols))
      rowsOut[cell] = { mask, rhs: board[cell] ? 1 : 0 }
    }
  }
  return { numVars: n, rows: rowsOut }
}

/** Apply a press pattern to a board and return the resulting lit state. */
export function applyPresses(rows: number, cols: number, board: boolean[], presses: boolean[]): boolean[] {
  const out = board.slice()
  const toggle = (r: number, c: number) => {
    if (r >= 0 && r < rows && c >= 0 && c < cols) out[idx(r, c, cols)] = !out[idx(r, c, cols)]
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!presses[idx(r, c, cols)]) continue
      toggle(r, c)
      toggle(r - 1, c)
      toggle(r + 1, c)
      toggle(r, c - 1)
      toggle(r, c + 1)
    }
  }
  return out
}

/**
 * Solve a Lights Out position. Finds a particular solution and the quiet
 * space, then — when the quiet space is small enough to enumerate — searches
 * the whole solution coset for the fewest presses (a Gray-code walk so each
 * candidate differs by a single quiet pattern).
 */
export function solveLightsOut(rows: number, cols: number, board: boolean[]): LightsOutSolution {
  const sys = lightsOutSystem(rows, cols, board)
  const rr = rref(sys)
  const n = rows * cols
  const quiet = nullSpaceBasis(rr)
  if (rr.inconsistent) {
    return {
      rows,
      cols,
      board: board.slice(),
      solvable: false,
      minPresses: null,
      minCount: 0,
      quietPatterns: quiet,
      solutionCount: 0n,
    }
  }
  const particular = particularSolution(rr)!
  const k = quiet.length
  let best = particular
  let bestCount = particular.reduce((a, b) => a + (b ? 1 : 0), 0)
  // Enumerate the coset for the lightest solution when the quiet space is small.
  if (k > 0 && k <= 20) {
    const cur = particular.slice()
    let prevGray = 0
    const total = 1 << k
    for (let i = 1; i < total; i++) {
      const gray = i ^ (i >>> 1)
      const b = Math.log2(gray ^ prevGray) | 0
      prevGray = gray
      const vec = quiet[b]
      for (let v = 0; v < n; v++) if (vec[v]) cur[v] = !cur[v]
      const count = cur.reduce((a, x) => a + (x ? 1 : 0), 0)
      if (count < bestCount) {
        bestCount = count
        best = cur.slice()
      }
    }
  }
  return {
    rows,
    cols,
    board: board.slice(),
    solvable: true,
    minPresses: best,
    minCount: bestCount,
    quietPatterns: quiet,
    solutionCount: 1n << BigInt(rr.numVars - rr.rank),
  }
}

/** Number of independent quiet patterns for an r×c board (its nullity). */
export function quietDimension(rows: number, cols: number): number {
  const empty = new Array<boolean>(rows * cols).fill(false)
  const rr = rref(lightsOutSystem(rows, cols, empty))
  return rr.freeVars.length
}
