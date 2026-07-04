// Jurdziński's Small Progress Measures — a second, completely different parity-game solver.
//
// Zielonka's recursion (parity.ts) attacks the game top-down; small progress measures attack it
// bottom-up, as a least fixpoint over a lattice of tuples. Each vertex carries a measure — for each
// *odd* priority i, "how many priority-i vertices can still be seen before an even priority must
// dominate". Player Even (0) tries to keep every measure finite; Player Odd (1) tries to push it to
// ⊤. Lifting to the least fixpoint, Even's winning region is exactly the vertices whose measure
// stays below ⊤. Running it beside Zielonka and demanding they agree on every arena is a fourth
// independent witness (alongside the certificate and the brute-force oracle) — two famous algorithms
// that share no code, forced to the same answer.
//
// Reference: M. Jurdziński, "Small Progress Measures for Solving Parity Games", STACS 2000.

import type { Arena, Player } from './types'

/** A measure is a tuple over the odd priorities, or ⊤ (the loss marker). `null` encodes ⊤. */
type Measure = number[] | null

/** Lexicographic order with the *highest* priority most significant; ⊤ is the greatest. */
function cmp(a: Measure, b: Measure): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  for (let k = a.length - 1; k >= 0; k--) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1
  }
  return 0
}

/** Solve a parity game with small progress measures; returns Player 0's winning region as a mask. */
export function spmWinner(a: Arena): Player[] {
  const d = a.priority.reduce((m, p) => Math.max(m, p), 0)

  // The odd priorities 1,3,…,≤d are the measure's coordinates (ascending ⇒ least significant first).
  const oddList: number[] = []
  for (let i = 1; i <= d; i += 2) oddList.push(i)
  const pos = new Map<number, number>() // odd priority → coordinate index
  oddList.forEach((i, k) => pos.set(i, k))
  const bound = oddList.map((i) => a.priority.filter((p) => p === i).length) // n_i

  const L = oddList.length
  const zero = (): number[] => new Array(L).fill(0)

  // prog(ρ, v, w): the least measure dominating (even p(v)) or strictly exceeding (odd p(v)) ρ(w) on
  // the coordinates for odd priorities ≥ p(v); coordinates below p(v) are 0.
  const prog = (rw: Measure, v: number): Measure => {
    if (rw === null) return null
    const pv = a.priority[v]
    const out = zero()
    // Copy ρ(w)'s coordinates for odd priorities ≥ pv.
    for (let k = 0; k < L; k++) if (oddList[k] >= pv) out[k] = rw[k]
    if (pv % 2 === 1) {
      // Strictly greater: increment starting at the coordinate for pv, carrying upward.
      let k = pos.get(pv) as number
      for (;;) {
        if (k >= L) return null // overflow past the top coordinate ⇒ ⊤
        if (out[k] < bound[k]) {
          out[k]++
          break
        }
        out[k] = 0
        k++
      }
    }
    return out
  }

  const rho: Measure[] = Array.from({ length: a.n }, () => zero())

  // Lift to the least fixpoint. Even (owner 0) minimises over successors, Odd (owner 1) maximises.
  let changed = true
  while (changed) {
    changed = false
    for (let v = 0; v < a.n; v++) {
      let target: Measure = a.owner[v] === 0 ? null : zero() // min starts high, max starts low
      for (const w of a.edges[v]) {
        const p = prog(rho[w], v)
        if (a.owner[v] === 0) {
          if (cmp(p, target) < 0) target = p
        } else if (cmp(p, target) > 0) target = p
      }
      if (cmp(target, rho[v]) > 0) {
        rho[v] = target
        changed = true
      }
    }
  }

  return rho.map((m) => (m === null ? 1 : 0)) as Player[]
}
