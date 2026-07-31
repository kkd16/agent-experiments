// The independent semantic oracle: exact LTL satisfaction over an ultimately
// periodic word (a "lasso"). This shares no machinery with the tableau/product
// pipeline — it interprets the *surface* operators directly by their fixpoint
// definitions — so agreement between the two is a genuine cross-check of the
// whole automaton construction, not a tautology.
//
// A lasso word is `letters[0…u-1]` followed by `letters[u…n-1]` repeated
// forever, where u = loopStart. Positions therefore live on a ρ-shaped graph of
// n nodes with successor next(i) = i+1 if i+1 < n else u. Every temporal
// operator is a fixpoint over these n positions:
//   X φ         · shift by next
//   φ U ψ       · least fixpoint of  ψ ∨ (φ ∧ X·)
//   φ R ψ       · greatest fixpoint of  ψ ∧ (φ ∨ X·)
// and F/G/W reduce to those. Least fixpoints start all-false, greatest all-true;
// on n positions each converges in ≤ n sweeps.

import type { Ltl } from './ast'
import { key } from './ast'

export interface LassoWord {
  /** Label set at each position, stem then loop, length n = stem+loop. */
  letters: Set<string>[]
  /** Index where the loop begins; must satisfy 0 ≤ loopStart < letters.length. */
  loopStart: number
}

class Evaluator {
  private letters: Set<string>[]
  private n: number
  private loopStart: number
  private memo = new Map<string, boolean[]>()

  constructor(word: LassoWord) {
    this.letters = word.letters
    this.n = word.letters.length
    this.loopStart = word.loopStart
  }

  private succ(i: number): number {
    return i + 1 < this.n ? i + 1 : this.loopStart
  }

  /** Truth of `f` at every position, memoized by structural key. */
  holdsVec(f: Ltl): boolean[] {
    const k = key(f)
    const cached = this.memo.get(k)
    if (cached) return cached
    const res = this.compute(f)
    this.memo.set(k, res)
    return res
  }

  private compute(f: Ltl): boolean[] {
    const n = this.n
    switch (f.k) {
      case 'true':
        return new Array<boolean>(n).fill(true)
      case 'false':
        return new Array<boolean>(n).fill(false)
      case 'atom': {
        const out = new Array<boolean>(n)
        for (let i = 0; i < n; i++) out[i] = this.letters[i].has(f.name)
        return out
      }
      case 'not': {
        const a = this.holdsVec(f.a)
        return a.map((v) => !v)
      }
      case 'and': {
        const a = this.holdsVec(f.a)
        const b = this.holdsVec(f.b)
        return a.map((v, i) => v && b[i])
      }
      case 'or': {
        const a = this.holdsVec(f.a)
        const b = this.holdsVec(f.b)
        return a.map((v, i) => v || b[i])
      }
      case 'imp': {
        const a = this.holdsVec(f.a)
        const b = this.holdsVec(f.b)
        return a.map((v, i) => !v || b[i])
      }
      case 'iff': {
        const a = this.holdsVec(f.a)
        const b = this.holdsVec(f.b)
        return a.map((v, i) => v === b[i])
      }
      case 'X': {
        const a = this.holdsVec(f.a)
        const out = new Array<boolean>(n)
        for (let i = 0; i < n; i++) out[i] = a[this.succ(i)]
        return out
      }
      case 'F': {
        // F a = true U a  (least fixpoint of  a ∨ X·)
        const a = this.holdsVec(f.a)
        return this.lfp((cur, i) => a[i] || cur[this.succ(i)])
      }
      case 'G': {
        // G a = false R a  (greatest fixpoint of  a ∧ X·)
        const a = this.holdsVec(f.a)
        return this.gfp((cur, i) => a[i] && cur[this.succ(i)])
      }
      case 'U': {
        const a = this.holdsVec(f.a)
        const b = this.holdsVec(f.b)
        return this.lfp((cur, i) => b[i] || (a[i] && cur[this.succ(i)]))
      }
      case 'R': {
        const a = this.holdsVec(f.a)
        const b = this.holdsVec(f.b)
        return this.gfp((cur, i) => b[i] && (a[i] || cur[this.succ(i)]))
      }
      case 'W': {
        // a W b = (a U b) ∨ G a
        const u = this.holdsVec({ k: 'U', a: f.a, b: f.b })
        const g = this.holdsVec({ k: 'G', a: f.a })
        return u.map((v, i) => v || g[i])
      }
    }
  }

  private lfp(step: (cur: boolean[], i: number) => boolean): boolean[] {
    let cur = new Array<boolean>(this.n).fill(false)
    for (;;) {
      const nextV = new Array<boolean>(this.n)
      let changed = false
      for (let i = 0; i < this.n; i++) {
        nextV[i] = step(cur, i)
        if (nextV[i] !== cur[i]) changed = true
      }
      cur = nextV
      if (!changed) return cur
    }
  }

  private gfp(step: (cur: boolean[], i: number) => boolean): boolean[] {
    let cur = new Array<boolean>(this.n).fill(true)
    for (;;) {
      const nextV = new Array<boolean>(this.n)
      let changed = false
      for (let i = 0; i < this.n; i++) {
        nextV[i] = step(cur, i)
        if (nextV[i] !== cur[i]) changed = true
      }
      cur = nextV
      if (!changed) return cur
    }
  }
}

/** Does the ultimately-periodic word satisfy `f` (evaluated at position 0)? */
export function satisfiesLasso(f: Ltl, word: LassoWord): boolean {
  return new Evaluator(word).holdsVec(f)[0]
}
