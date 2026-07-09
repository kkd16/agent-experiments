// A recorded Gauss–Jordan reduction, for the studio's "watch the matrix reduce"
// panel. This mirrors `rref` in gf2.ts step for step but snapshots the whole
// augmented matrix after every pivot so the UI can animate the elimination and
// highlight each pivot cell. It is display-only — the solving core never calls
// it — so the fast path stays allocation-light.

import type { Gf2System } from './gf2'

export interface RrefStep {
  /** Row index chosen as the pivot at this step. */
  pivotRow: number
  /** Column the pivot lives in. */
  pivotCol: number
  /** Whether a row swap happened to bring the pivot into place. */
  swapped: boolean
  /** Augmented matrix (each row = bits over variables, then the rhs bit) after eliminating this column. */
  matrix: number[][]
  /** Human note describing the step. */
  note: string
}

export interface RrefTrace {
  numVars: number
  /** The augmented matrix before any reduction. */
  initial: number[][]
  steps: RrefStep[]
  pivotCols: number[]
  rank: number
  inconsistent: boolean
  freeVars: number[]
}

function snapshot(masks: bigint[], rhs: number[], numVars: number): number[][] {
  return masks.map((m, r) => {
    const row: number[] = []
    for (let c = 0; c < numVars; c++) row.push(Number((m >> BigInt(c)) & 1n))
    row.push(rhs[r] & 1)
    return row
  })
}

/** Reduce a system while recording every pivot and the matrix after it. */
export function rrefTrace(system: Gf2System): RrefTrace {
  const numVars = system.numVars
  const masks = system.rows.map((r) => r.mask)
  const rhs = system.rows.map((r) => r.rhs & 1)
  const initial = snapshot(masks, rhs, numVars)
  const steps: RrefStep[] = []
  const pivotCols: number[] = []
  let r = 0
  for (let col = 0; col < numVars && r < masks.length; col++) {
    const bit = 1n << BigInt(col)
    let sel = -1
    for (let i = r; i < masks.length; i++) {
      if ((masks[i] & bit) !== 0n) {
        sel = i
        break
      }
    }
    if (sel === -1) continue
    const swapped = sel !== r
    if (swapped) {
      ;[masks[r], masks[sel]] = [masks[sel], masks[r]]
      ;[rhs[r], rhs[sel]] = [rhs[sel], rhs[r]]
    }
    for (let i = 0; i < masks.length; i++) {
      if (i !== r && (masks[i] & bit) !== 0n) {
        masks[i] ^= masks[r]
        rhs[i] ^= rhs[r]
      }
    }
    steps.push({
      pivotRow: r,
      pivotCol: col,
      swapped,
      matrix: snapshot(masks, rhs, numVars),
      note: `pivot on x${col + 1}${swapped ? ' (after a row swap)' : ''}, eliminate it from every other equation`,
    })
    pivotCols.push(col)
    r++
  }
  const rank = r
  let inconsistent = false
  for (let i = rank; i < masks.length; i++) if (masks[i] === 0n && rhs[i] === 1) inconsistent = true
  const pivotSet = new Set(pivotCols)
  const freeVars: number[] = []
  for (let v = 0; v < numVars; v++) if (!pivotSet.has(v)) freeVars.push(v)
  return { numVars, initial, steps, pivotCols, rank, inconsistent, freeVars }
}
