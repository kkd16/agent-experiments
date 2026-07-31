// The model-checking pipeline, end to end.
//
//   φ ⊨? K   ≡   K ⊨ φ on *all* runs
//     1. build B(¬φ) — the Büchi automaton for the negated spec (GPVW tableau),
//     2. take the product K × B(¬φ) (degeneralized to ordinary Büchi),
//     3. test emptiness by nested DFS.
//   Empty product ⇒ no run of K violates φ ⇒ φ HOLDS.
//   Non-empty     ⇒ an accepting lasso is a concrete counterexample run.
//
// The counterexample is projected back onto K as a stem + repeating loop of
// system states, ready to animate and to hand to the independent semantic oracle
// for validation.

import type { Ltl } from './ast'
import type { Gba } from './buchi'
import { buildGba } from './buchi'
import { findLasso, nestedDfs } from './emptiness'
import type { Kripke } from './kripke'
import type { ProductBa } from './product'
import { buildProduct } from './product'

export interface Counterexample {
  /** Kripke state ids before the loop (may be empty). */
  stem: number[]
  /** Kripke state ids of the repeating block; loop[0] is the cycle entry. */
  loop: number[]
}

export interface ModelCheckStats {
  buchiStates: number
  buchiEdges: number
  buchiAcceptSets: number
  productStates: number
  productEdges: number
  productCopies: number
  outerVisited: number
  innerVisited: number
}

export interface ModelCheckResult {
  /** True iff every run of K satisfies φ. */
  holds: boolean
  counterexample: Counterexample | null
  stats: ModelCheckStats
  /** The Büchi automaton for ¬φ (for the automaton view). */
  gba: Gba
  product: ProductBa
}

/** Check whether every run of `k` satisfies `phi`. */
export function modelCheck(k: Kripke, phi: Ltl, maxNodes = 20000): ModelCheckResult {
  const gba = buildGba({ k: 'not', a: phi }, maxNodes)
  const product = buildProduct(k, gba)
  const nd = nestedDfs(product)

  let counterexample: Counterexample | null = null
  if (!nd.empty) {
    const lasso = findLasso(product)
    if (lasso) {
      counterexample = {
        stem: lasso.stem.map((s) => product.kripkeOf[s]),
        loop: lasso.loop.map((s) => product.kripkeOf[s]),
      }
    }
  }

  const buchiEdges = gba.edges.reduce((a, e) => a + e.length, 0)
  const productEdges = product.edges.reduce((a, e) => a + e.length, 0)

  return {
    holds: nd.empty,
    counterexample,
    stats: {
      buchiStates: gba.states.length,
      buchiEdges,
      buchiAcceptSets: gba.accept.length,
      productStates: product.n,
      productEdges,
      productCopies: product.copies,
      outerVisited: nd.outerVisited,
      innerVisited: nd.innerVisited,
    },
    gba,
    product,
  }
}

/** The ω-word of a counterexample: the label sets along stem then loop. */
export function counterexampleWord(k: Kripke, cex: Counterexample): { letters: Set<string>[]; loopStart: number } {
  const letters = [...cex.stem, ...cex.loop].map((s) => new Set(k.states[s].labels))
  return { letters, loopStart: cex.stem.length }
}
