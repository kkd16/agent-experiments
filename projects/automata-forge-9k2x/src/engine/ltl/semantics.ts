// The *direct* semantics of LTL over an ultimately-periodic ω-word — the textbook truth definition,
// evaluated without any automaton. It is both a UI feature (it tells you, independently of the Büchi
// machinery, whether a lasso word satisfies a formula) and the ground-truth oracle the self-test uses
// to differentially check the GPVW translation: a word should be accepted by the automaton for φ iff
// it satisfies φ here.
//
// A lasso word is a finite `prefix` followed by a forever-repeated `loop`. Positions 0…N−1 (N =
// |prefix|+|loop|) form a finite "necklace" whose successor map is functional and eventually cyclic
// (the last position jumps back to the start of the loop), so the Until/Release fixpoints converge in
// at most N steps — least fixpoint for U (eventualities must be discharged), greatest for R.

import type { Ltl } from './formula'

/** Evaluate `f` at the start of the lasso word `prefix · loopᵚ`. `loop` must be non-empty. */
export function evalLtlOnLasso(f: Ltl, prefix: Set<string>[], loop: Set<string>[]): boolean {
  if (loop.length === 0) return false
  const letters = [...prefix, ...loop]
  const N = letters.length
  const p = prefix.length
  const next = (i: number): number => (i + 1 < N ? i + 1 : p)

  const evalAll = (g: Ltl): boolean[] => {
    switch (g.k) {
      case 'true':
        return Array(N).fill(true)
      case 'false':
        return Array(N).fill(false)
      case 'atom':
        return letters.map((s) => s.has(g.name))
      case 'not': {
        const a = evalAll(g.a)
        return a.map((x) => !x)
      }
      case 'and': {
        const a = evalAll(g.a)
        const b = evalAll(g.b)
        return a.map((x, i) => x && b[i])
      }
      case 'or': {
        const a = evalAll(g.a)
        const b = evalAll(g.b)
        return a.map((x, i) => x || b[i])
      }
      case 'imp': {
        const a = evalAll(g.a)
        const b = evalAll(g.b)
        return a.map((x, i) => !x || b[i])
      }
      case 'iff': {
        const a = evalAll(g.a)
        const b = evalAll(g.b)
        return a.map((x, i) => x === b[i])
      }
      case 'next': {
        const a = evalAll(g.a)
        return letters.map((_, i) => a[next(i)])
      }
      case 'fin':
        return evalAll({ k: 'until', a: { k: 'true' }, b: g.a })
      case 'glob':
        return evalAll({ k: 'release', a: { k: 'false' }, b: g.a })
      case 'wuntil':
        // a W b ≡ (a U b) ∨ G a
        return evalAll({
          k: 'or',
          a: { k: 'until', a: g.a, b: g.b },
          b: { k: 'glob', a: g.a },
        })
      case 'until': {
        // least fixpoint of U(i) = b(i) ∨ (a(i) ∧ U(next i)), starting from all-false.
        const a = evalAll(g.a)
        const b = evalAll(g.b)
        let cur = Array(N).fill(false)
        for (let iter = 0; iter <= N; iter++) {
          const nxt = cur.map((_, i) => b[i] || (a[i] && cur[next(i)]))
          if (nxt.every((v, i) => v === cur[i])) return nxt
          cur = nxt
        }
        return cur
      }
      case 'release': {
        // greatest fixpoint of R(i) = b(i) ∧ (a(i) ∨ R(next i)), starting from all-true.
        const a = evalAll(g.a)
        const b = evalAll(g.b)
        let cur = Array(N).fill(true)
        for (let iter = 0; iter <= N; iter++) {
          const nxt = cur.map((_, i) => b[i] && (a[i] || cur[next(i)]))
          if (nxt.every((v, i) => v === cur[i])) return nxt
          cur = nxt
        }
        return cur
      }
    }
  }

  return evalAll(f)[0]
}
