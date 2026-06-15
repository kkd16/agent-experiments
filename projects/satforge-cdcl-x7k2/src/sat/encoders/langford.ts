// Langford's pairing problem L(n), encoded to CNF.
//
// Arrange two each of the numbers 1..n in a row of 2n slots so that the two
// copies of k are exactly k slots apart (i.e. there are exactly k numbers
// between them). L(n) is solvable iff n ≡ 0 or 3 (mod 4) — so L(1), L(2), L(5),
// L(6) are UNSAT and make compact, genuinely hard refutations to certify, while
// L(3), L(4), L(7), L(8) are satisfiable. A lovely companion to the DRAT view.

import type { CNF } from '../cnf'
import { CnfBuilder } from './util'

export interface LangfordSolution {
  /** The 2n-slot sequence (1-based values); 0 marks an unfilled slot. */
  sequence: number[]
  n: number
}

export interface LangfordEncoding {
  cnf: CNF
  decode: (model: boolean[]) => LangfordSolution
  n: number
}

/**
 * Encode L(n). A placement variable P[v][i] means value `v` occupies slot `i`
 * and slot `i + v + 1` (its mandatory partner). Each value is placed exactly
 * once; each slot is covered by at most one placement (which, by counting, forces
 * a perfect tiling of the 2n slots).
 */
export function encodeLangford(n: number): LangfordEncoding {
  const b = new CnfBuilder()
  const slots = 2 * n
  // place[v][i] for v in 1..n, valid starting slot i in 0..slots-1 with i+v+1 < slots.
  const place: number[][] = Array.from({ length: n + 1 }, () => [])
  // coversBySlot[p] = list of placement vars that fill slot p.
  const coversBySlot: number[][] = Array.from({ length: slots }, () => [])

  for (let v = 1; v <= n; v++) {
    for (let i = 0; i < slots; i++) {
      const j = i + v + 1 // partner slot
      if (j >= slots) {
        place[v][i] = 0 // invalid start
        continue
      }
      const id = b.fresh()
      place[v][i] = id
      coversBySlot[i].push(id)
      coversBySlot[j].push(id)
    }
  }

  // Each value is placed exactly once among its valid start slots.
  for (let v = 1; v <= n; v++) {
    const starts: number[] = []
    for (let i = 0; i < slots; i++) if (place[v][i]) starts.push(place[v][i])
    if (starts.length === 0) {
      b.add() // no valid placement -> empty clause -> UNSAT (e.g. n = 1)
    } else {
      b.exactlyOne(starts)
    }
  }

  // Each slot is covered by at most one placement.
  for (let p = 0; p < slots; p++) {
    if (coversBySlot[p].length > 1) b.atMostOnePairwise(coversBySlot[p])
  }

  const decode = (model: boolean[]): LangfordSolution => {
    const sequence = new Array(slots).fill(0)
    for (let v = 1; v <= n; v++) {
      for (let i = 0; i < slots; i++) {
        const id = place[v][i]
        if (id && model[id]) {
          sequence[i] = v
          sequence[i + v + 1] = v
        }
      }
    }
    return { sequence, n }
  }

  return { cnf: b.build(), decode, n }
}
