// The one primitive CTL* model checking is built on:  given a Kripke model M and a *pure LTL* path
// formula ρ over the (possibly extended) atom set, decide for EVERY state s whether
//
//        ∃ a path π starting at s with  π ⊨ ρ.
//
// This is exactly LTL emptiness, asked per start state. The Logic mode already builds, from an NNF
// `Core` formula, a Büchi automaton accepting precisely the ω-words satisfying ρ (the GPVW tableau)
// and searches the synchronous product M ⊗ A(ρ) for an accepting lasso. We reuse that verbatim: build
// A(ρ) once, then run the product emptiness check with the initial state pinned to each s in turn.
// A non-empty product gives both the verdict (some path from s satisfies ρ) and a concrete witnessing
// lasso, which the model checker shows as a certificate.
//
// CTL* interprets formulas over a TOTAL transition relation (deadlocks self-loop), so we drive the
// product off the CTL module's `CtlModel` (already totalized) rather than the raw Kripke edges — that
// is what makes the CTL fragment of CTL* agree, state for state, with the labelling engine.

import type { Core, Ltl } from '../ltl/formula'
import type { BA } from '../ltl/buchi'
import { buildBuchi, checkEmptiness } from '../ltl/modelcheck'
import type { System } from '../ltl/modelcheck'
import type { CtlModel } from '../ctl/modelcheck'

/** Truth of an atom (real proposition or a fresh label introduced by quantifier elimination) at a state. */
export type Holds = (state: number, atom: string) => boolean

/** An ultimately-periodic path of the model: the `prefix` stem leads into the forever-repeated `loop`. */
export interface Lasso {
  prefix: number[]
  loop: number[]
}

export interface PathExistResult {
  /** `sat[s]` ⇔ some path from `s` satisfies the (positive) path formula. */
  sat: boolean[]
  /** A witnessing lasso for each satisfying state (`null` where `sat[s]` is false). */
  witness: (Lasso | null)[]
  /** Peak number of product states explored (a rough cost read-out for the UI). */
  productStates: number
}

/**
 * A pluggable path-existence engine. The model checker is parameterised over this so the production
 * engine (`pathExistGPVW`) and the independent differential oracle (`pathExistOracle`) drive the very
 * same Emerson–Lei elimination — the only thing that differs between them is HOW emptiness is decided.
 */
export type PathExistFn = (core: Core, ltl: Ltl, model: CtlModel, holds: Holds) => PathExistResult

/** Wrap a CtlModel as a `System` whose single initial state is `s` (the per-start-state product seed). */
function systemFrom(model: CtlModel, holds: Holds, s: number): System {
  return {
    n: model.n,
    initial: [s],
    succ: (i) => model.succ[i],
    holds,
  }
}

/** Run a prebuilt Büchi automaton's product-emptiness from every state; collect verdicts + witnesses. */
export function perStateEmptiness(ba: BA, model: CtlModel, holds: Holds): PathExistResult {
  const n = model.n
  const sat = new Array<boolean>(n).fill(false)
  const witness: (Lasso | null)[] = new Array(n).fill(null)
  let productStates = 0
  for (let s = 0; s < n; s++) {
    const res = checkEmptiness(ba, systemFrom(model, holds, s))
    productStates = Math.max(productStates, res.productStates)
    if (!res.empty) {
      sat[s] = true
      witness[s] = {
        prefix: (res.prefix ?? []).map((p) => p.m),
        loop: (res.loop ?? []).map((p) => p.m),
      }
    }
  }
  return { sat, witness, productStates }
}

/**
 * The production path-existence engine: GPVW Büchi automaton for ρ, then the Logic mode's on-the-fly
 * product-emptiness search (a BFS stem + a BFS loop) from each start state.
 */
export const pathExistGPVW: PathExistFn = (core, _ltl, model, holds) => {
  const { ba } = buildBuchi(core)
  return perStateEmptiness(ba, model, holds)
}
