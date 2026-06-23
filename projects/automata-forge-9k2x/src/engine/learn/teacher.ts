// The Minimally Adequate Teacher (MAT) for Angluin's L*.
//
// L* learns an unknown regular language by *asking questions* of a teacher that can answer two
// kinds:
//
//   • a **membership** query  — "is the string w in the language?"           (yes / no)
//   • an **equivalence** query — "is this hypothesis DFA exactly the language?" If not, the teacher
//     must hand back a **counterexample**: a string the hypothesis and the target disagree on.
//
// Angluin proved that with just these two oracles a learner converges, in a polynomial number of
// queries, to the *minimal* DFA of the target. Here the teacher is backed by a concrete DFA the
// learner never sees: membership is one simulation, and — beautifully — the equivalence oracle is
// the project's own product-automaton equivalence check, which already returns the **shortest**
// distinguishing string as its witness. So the learner is taught by the very machinery the Compare
// view uses to *prove* two languages differ.

import type { Dfa, Sym } from '../types'
import { acceptsSyms, relations } from '../product'

/** A Minimally Adequate Teacher: a membership oracle + an equivalence oracle with witnesses. */
export interface Teacher {
  /** The fixed alphabet the target is defined over (the same Σ every hypothesis must use). */
  alphabet: Sym[]
  /** Membership oracle: does the target accept this word? */
  member(word: Sym[]): boolean
  /**
   * Equivalence oracle: if `hyp` is exactly the target language, return null; otherwise return a
   * counterexample — a word on which `hyp` and the target disagree (here, always the shortest one).
   */
  equiv(hyp: Dfa): Sym[] | null
}

/** Join a word into a cache key. OTHER is '' so we need an explicit separator. */
const keyOf = (w: Sym[]): string => w.join('')

/**
 * A teacher backed by a concrete target DFA, instrumented with query counters.
 *
 * Membership answers are **cached**, so the counters report *distinct* membership queries — the
 * honest measure the L* complexity bounds are stated in (the algorithm fills a table whose every
 * distinct cell is one membership query; recomputing a cell it already knows costs nothing).
 */
export class DfaTeacher implements Teacher {
  readonly alphabet: Sym[]
  /** Distinct membership queries actually put to the target (cache misses). */
  membershipQueries = 0
  /** Equivalence queries (each is one product-construction equivalence check). */
  equivalenceQueries = 0
  /** Membership lookups served from the cache (table re-reads). */
  cacheHits = 0
  private readonly cache = new Map<string, boolean>()
  private readonly target: Dfa

  constructor(target: Dfa) {
    this.target = target
    this.alphabet = target.alphabet
  }

  member(word: Sym[]): boolean {
    const k = keyOf(word)
    const cached = this.cache.get(k)
    if (cached !== undefined) {
      this.cacheHits++
      return cached
    }
    this.membershipQueries++
    const r = acceptsSyms(this.target, word)
    this.cache.set(k, r)
    return r
  }

  equiv(hyp: Dfa): Sym[] | null {
    this.equivalenceQueries++
    return relations(hyp, this.target).witness
  }

  /** Forget all counters and the cache (used when the target changes). */
  reset(): void {
    this.membershipQueries = 0
    this.equivalenceQueries = 0
    this.cacheHits = 0
    this.cache.clear()
  }
}
