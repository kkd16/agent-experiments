// N-Queens as SAT: place N non-attacking queens on an N×N board.
import type { CNF } from '../cnf'
import { CnfBuilder } from './util'

export interface NQueensSolution {
  n: number
  queens: number[] // queens[r] = column of the queen in row r, or -1
}

export function encodeNQueens(n: number): {
  cnf: CNF
  decode: (model: boolean[]) => NQueensSolution
} {
  const b = new CnfBuilder()
  // x(r,c) — variable id r*n + c + 1 — is true iff a queen sits at row r, col c.
  const v = (r: number, c: number) => r * n + c + 1
  b.reserve(n * n)
  b.comments.push(`${n}-Queens: place ${n} non-attacking queens on a ${n}x${n} board`)

  // Exactly one queen per row.
  for (let r = 0; r < n; r++) {
    const row: number[] = []
    for (let c = 0; c < n; c++) row.push(v(r, c))
    b.exactlyOne(row)
  }
  // At most one per column.
  for (let c = 0; c < n; c++) {
    const col: number[] = []
    for (let r = 0; r < n; r++) col.push(v(r, c))
    b.atMostOnePairwise(col)
  }
  // At most one per ↘ diagonal (constant r-c) and ↙ diagonal (constant r+c).
  for (let d = -(n - 1); d <= n - 1; d++) {
    const diag: number[] = []
    for (let r = 0; r < n; r++) {
      const c = r - d
      if (c >= 0 && c < n) diag.push(v(r, c))
    }
    if (diag.length > 1) b.atMostOnePairwise(diag)
  }
  for (let s = 0; s <= 2 * (n - 1); s++) {
    const anti: number[] = []
    for (let r = 0; r < n; r++) {
      const c = s - r
      if (c >= 0 && c < n) anti.push(v(r, c))
    }
    if (anti.length > 1) b.atMostOnePairwise(anti)
  }

  return {
    cnf: b.build(),
    decode: (model) => {
      const queens = new Array<number>(n).fill(-1)
      for (let r = 0; r < n; r++)
        for (let c = 0; c < n; c++) if (model[v(r, c)]) queens[r] = c
      return { n, queens }
    },
  }
}
