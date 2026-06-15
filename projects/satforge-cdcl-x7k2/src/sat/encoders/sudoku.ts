// Sudoku as SAT. Supports any box size (box=3 -> classic 9×9).
import type { CNF } from '../cnf'
import { CnfBuilder } from './util'

export interface SudokuSolution {
  size: number
  grid: number[] // length size*size, 1..size, 0 = blank
}

/**
 * Parse a puzzle string. Digits 1..9 are clues; '.', '0' or '-' are blanks.
 * Whitespace and newlines are ignored. Must contain exactly size*size cells.
 */
export function parseSudoku(text: string, size = 9): number[] {
  const grid: number[] = []
  for (const ch of text) {
    if (/\s/.test(ch)) continue
    if (ch === '.' || ch === '0' || ch === '-' || ch === '_') grid.push(0)
    else if (/[1-9]/.test(ch)) grid.push(Number(ch))
    else continue
  }
  if (grid.length !== size * size)
    throw new Error(`expected ${size * size} cells, got ${grid.length}`)
  return grid
}

export function encodeSudoku(
  clues: number[],
  box = 3,
): { cnf: CNF; decode: (model: boolean[]) => SudokuSolution } {
  const size = box * box
  if (clues.length !== size * size) throw new Error('clue grid has the wrong length')
  const b = new CnfBuilder()
  // x(r,c,d): variable for "cell (r,c) holds digit d" (d in 1..size).
  const v = (r: number, c: number, d: number) => (r * size + c) * size + d
  b.reserve(size * size * size)
  b.comments.push(`Sudoku (${size}x${size}, box ${box})`)

  // Each cell holds exactly one digit.
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++) {
      const cell: number[] = []
      for (let d = 1; d <= size; d++) cell.push(v(r, c, d))
      b.exactlyOne(cell)
    }
  // Each digit appears exactly once in each row, column and box.
  for (let d = 1; d <= size; d++) {
    for (let r = 0; r < size; r++) {
      const row: number[] = []
      for (let c = 0; c < size; c++) row.push(v(r, c, d))
      b.exactlyOne(row)
    }
    for (let c = 0; c < size; c++) {
      const col: number[] = []
      for (let r = 0; r < size; r++) col.push(v(r, c, d))
      b.exactlyOne(col)
    }
    for (let br = 0; br < box; br++)
      for (let bc = 0; bc < box; bc++) {
        const cells: number[] = []
        for (let dr = 0; dr < box; dr++)
          for (let dc = 0; dc < box; dc++) cells.push(v(br * box + dr, bc * box + dc, d))
        b.exactlyOne(cells)
      }
  }
  // Clues become unit clauses.
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++) {
      const d = clues[r * size + c]
      if (d >= 1 && d <= size) b.add(v(r, c, d))
    }

  return {
    cnf: b.build(),
    decode: (model) => {
      const grid = new Array<number>(size * size).fill(0)
      for (let r = 0; r < size; r++)
        for (let c = 0; c < size; c++)
          for (let d = 1; d <= size; d++) if (model[v(r, c, d)]) grid[r * size + c] = d
      return { size, grid }
    },
  }
}
