// Negation normal form. The GPVW tableau in `buchi.ts` works over the reduced
// core {true, false, atom, ¬atom, ∧, ∨, X, U, R}: negation appears only on
// atoms, and the derived operators F/G/W and the boolean connectives →/↔ are
// gone. `toNnf` drives negation inward in one pass using the standard dualities:
//
//   ¬(a ∧ b) ≡ ¬a ∨ ¬b        ¬X a ≡ X ¬a
//   ¬(a ∨ b) ≡ ¬a ∧ ¬b        ¬(a U b) ≡ ¬a R ¬b
//   ¬F a ≡ G ¬a               ¬(a R b) ≡ ¬a U ¬b
//   ¬G a ≡ F ¬a
//   F a ≡ true U a            G a ≡ false R a
//   a → b ≡ ¬a ∨ b            a ↔ b ≡ (a ∧ b) ∨ (¬a ∧ ¬b)
//   a W b ≡ b R (a ∨ b)
//
// The result contains only the node kinds true/false/atom/not(atom)/and/or/X/U/R.

import type { Ltl } from './ast'
import { and, FALSE, key, not, or, release, TRUE, until } from './ast'

/** Rewrite `f` (optionally under a top-level negation) into negation normal form. */
export function toNnf(f: Ltl, neg = false): Ltl {
  switch (f.k) {
    case 'true':
      return neg ? FALSE : TRUE
    case 'false':
      return neg ? TRUE : FALSE
    case 'atom':
      return neg ? not(f) : f
    case 'not':
      return toNnf(f.a, !neg)
    case 'and':
      return neg ? or(toNnf(f.a, true), toNnf(f.b, true)) : and(toNnf(f.a, false), toNnf(f.b, false))
    case 'or':
      return neg ? and(toNnf(f.a, true), toNnf(f.b, true)) : or(toNnf(f.a, false), toNnf(f.b, false))
    case 'imp':
      // a → b ≡ ¬a ∨ b
      return toNnf(or(not(f.a), f.b), neg)
    case 'iff':
      // a ↔ b ≡ (a ∧ b) ∨ (¬a ∧ ¬b)
      return toNnf(or(and(f.a, f.b), and(not(f.a), not(f.b))), neg)
    case 'X':
      return { k: 'X', a: toNnf(f.a, neg) }
    case 'F':
      // F a ≡ true U a ; ¬F a ≡ G ¬a ≡ false R ¬a
      return neg ? release(FALSE, toNnf(f.a, true)) : until(TRUE, toNnf(f.a, false))
    case 'G':
      // G a ≡ false R a ; ¬G a ≡ F ¬a ≡ true U ¬a
      return neg ? until(TRUE, toNnf(f.a, true)) : release(FALSE, toNnf(f.a, false))
    case 'U':
      // ¬(a U b) ≡ ¬a R ¬b
      return neg ? release(toNnf(f.a, true), toNnf(f.b, true)) : until(toNnf(f.a, false), toNnf(f.b, false))
    case 'R':
      // ¬(a R b) ≡ ¬a U ¬b
      return neg ? until(toNnf(f.a, true), toNnf(f.b, true)) : release(toNnf(f.a, false), toNnf(f.b, false))
    case 'W':
      // a W b ≡ b R (a ∨ b)
      return toNnf(release(f.b, or(f.a, f.b)), neg)
  }
}

// Constant folding over the NNF core. Besides shrinking the automaton, this is
// what keeps the acceptance test in `buchi.ts` honest: the eventuality of an
// `a U b` is discharged in a state exactly when `b ∈ Old`, but a right-hand side
// of literal `true` is dropped rather than recorded — so any `_ U true` / `_ R
// false` degeneracy must be simplified away *before* the tableau runs.
// Identities (all standard): a U true ≡ true, a U false ≡ false, false U b ≡ b,
// a R false ≡ false, a R true ≡ true, true R b ≡ b, plus boolean absorption.
export function simplify(f: Ltl): Ltl {
  switch (f.k) {
    case 'true':
    case 'false':
    case 'atom':
      return f
    case 'not':
      // In NNF, `not` wraps only atoms; nothing to fold.
      return f
    case 'X': {
      const a = simplify(f.a)
      if (a.k === 'true' || a.k === 'false') return a // X true ≡ true, X false ≡ false
      return { k: 'X', a }
    }
    case 'and': {
      const a = simplify(f.a)
      const b = simplify(f.b)
      if (a.k === 'false' || b.k === 'false') return FALSE
      if (a.k === 'true') return b
      if (b.k === 'true') return a
      if (key(a) === key(b)) return a
      return and(a, b)
    }
    case 'or': {
      const a = simplify(f.a)
      const b = simplify(f.b)
      if (a.k === 'true' || b.k === 'true') return TRUE
      if (a.k === 'false') return b
      if (b.k === 'false') return a
      if (key(a) === key(b)) return a
      return or(a, b)
    }
    case 'U': {
      const a = simplify(f.a)
      const b = simplify(f.b)
      if (b.k === 'true') return TRUE // a U true ≡ true
      if (b.k === 'false') return FALSE // a U false ≡ false
      if (a.k === 'false') return b // false U b ≡ b
      return until(a, b)
    }
    case 'R': {
      const a = simplify(f.a)
      const b = simplify(f.b)
      if (b.k === 'false') return FALSE // a R false ≡ false
      if (b.k === 'true') return TRUE // a R true ≡ true
      if (a.k === 'true') return b // true R b ≡ b
      return release(a, b)
    }
    default:
      return f
  }
}
