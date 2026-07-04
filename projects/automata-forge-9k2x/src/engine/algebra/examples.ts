// A guided tour of the algebra–language correspondence. Each regex is chosen to land its
// syntactic monoid in a different structural class, so switching between them walks the variety
// ladder from trivial → star-free → counting.

export interface AlgebraExample {
  name: string
  regex: string
  note: string
}

export const ALGEBRA_EXAMPLES: AlgebraExample[] = [
  {
    name: 'Second symbol from the end is a',
    regex: '(a|b)*a(a|b)',
    note: 'Star-free & aperiodic, but neither J-trivial nor commutative — a rich egg-box that still counts nothing.',
  },
  {
    name: 'aⁿbᵐ — the textbook star-free language',
    regex: 'a*b*',
    note: 'Aperiodic; the syntactic monoid is a small "ordered" chain with a zero (the trap).',
  },
  {
    name: 'Contains the letter a',
    regex: '(a|b)*a(a|b)*',
    note: 'A commutative idempotent monoid (a semilattice) — piecewise testable by a single subword.',
  },
  {
    name: 'Contains the factor aa',
    regex: '(a|b)*aa(a|b)*',
    note: 'Aperiodic and star-free, but NOT piecewise testable: a factor is not a scattered subword. Contrast with "contains a".',
  },
  {
    name: 'Ends with ab',
    regex: '(a|b)*ab',
    note: 'Star-free; a suffix test. Its monoid is aperiodic with a small skeleton of idempotents.',
  },
  {
    name: 'Even number of a\'s',
    regex: 'b*(ab*ab*)*',
    note: 'NOT star-free: the syntactic monoid hides a ℤ/2 subgroup that counts a\'s modulo 2. No first-order formula can express it.',
  },
  {
    name: 'Length divisible by 3',
    regex: '(...)*',
    note: 'The syntactic monoid is the cyclic group ℤ/3 (over any letter) — pure modular counting, the maximally non-star-free shape.',
  },
  {
    name: 'Alternating (ab)*',
    regex: '(ab)*',
    note: 'Aperiodic (star-free) but non-commutative, with a zero element. A clean small egg-box.',
  },
  {
    name: 'Everything — Σ*',
    regex: '.*',
    note: 'The trivial one-element monoid. ∅ and Σ* are the only languages whose algebra collapses to a point.',
  },
]

export const DEFAULT_REGEX = ALGEBRA_EXAMPLES[0].regex
