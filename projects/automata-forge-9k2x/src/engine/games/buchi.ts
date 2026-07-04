// Büchi games — Player 0 wins iff an accepting vertex recurs *infinitely often*.
//
// This is the McNaughton/Zielonka fixpoint that peels off Player 1's winning region in layers.
// In the current sub-arena, `Attr_0(F)` is the set from which Player 0 can at least *reach* an
// accepting vertex once. Its complement `Tr` is a region Player 0 can never escape toward F — and
// which Player 1 can trap the token in forever, seeing F only finitely often. So Player 1 wins
// `Attr_1(Tr)`; remove it and repeat. When nothing more can be removed, whatever remains is
// Player 0's: from there Player 0 forces F, and on reaching F re-attracts to F, ad infinitum.

import type { Arena, Solution, Subgame } from './types'
import { allPresent, isEmpty, maskAnd, maskAndNot } from './types'
import { attractor, trapStrategy } from './attractor'

/** Solve a Büchi game with accepting set `accept`. */
export function solveBuchi(a: Arena, accept: Subgame): Solution {
  let present = allPresent(a.n)
  const strat1 = new Array(a.n).fill(-1)

  for (;;) {
    const F = maskAnd(accept, present) // accept ∩ present
    const { region: reachF } = attractor(a, present, 0, F)
    const Tr = maskAndNot(present, reachF)
    if (isEmpty(Tr)) break

    const { region: badRegion, strat: attrStrat } = attractor(a, present, 1, Tr)
    const stayTr = trapStrategy(a, Tr, 1)
    for (let v = 0; v < a.n; v++) {
      if (badRegion[v] && strat1[v] === -1 && a.owner[v] === 1) {
        strat1[v] = attrStrat[v] !== -1 ? attrStrat[v] : stayTr[v]
      }
    }
    present = maskAndNot(present, badRegion)
  }

  // `present` is now Player 0's region W0. Build a positional strategy: attract to F, and on an
  // accepting vertex step back into W0 so the attractor fires again.
  const W0 = present
  const Fp = maskAnd(accept, W0) // accept ∩ W0
  const { strat: toF } = attractor(a, W0, 0, Fp)
  const strat0 = new Array(a.n).fill(-1)
  for (let v = 0; v < a.n; v++) {
    if (!W0[v] || a.owner[v] !== 0) continue
    if (toF[v] !== -1) strat0[v] = toF[v]
    else {
      const w = a.edges[v].find((x) => W0[x]) // v ∈ F: keep the play inside W0
      if (w !== undefined) strat0[v] = w
    }
  }

  const winner = W0.map((w) => (w ? 0 : 1)) as (0 | 1)[]
  return { winner, strat0, strat1 }
}
