// A curated gallery of Presburger formulas spanning the interesting cases: solution sets with free
// variables, closed sentences (true and false), quantifier alternation, divisibility, and the classic
// numerical-semigroup ("Chicken McNugget") set.

export interface PresburgerExample {
  name: string
  formula: string
  note: string
}

export const PRESBURGER_EXAMPLES: PresburgerExample[] = [
  {
    name: 'x is even',
    formula: 'E y. x = 2*y',
    note: 'The projection ∃y turns the equation x = 2y into the automaton for the even numbers.',
  },
  {
    name: 'addition  x + y = z',
    formula: 'x + y = z',
    note: 'The 3-track ripple-carry relation — the graph is the binary adder itself.',
  },
  {
    name: 'strict order  x < y',
    formula: 'x < y',
    note: 'Every pair of naturals with x below y, read least-significant-bit-first.',
  },
  {
    name: 'Frobenius (3, 5)',
    formula: 'E a. E b. x = 3*a + 5*b',
    note: 'The numerical semigroup ⟨3,5⟩ — every natural is representable except 1, 2, 4, 7.',
  },
  {
    name: 'divisible by 6',
    formula: '6 | x',
    note: 'A congruence atom: state = (residue mod 6, place value mod 6); accepts multiples of 6.',
  },
  {
    name: 'CRT: 2∣x ∧ 3∣(x+1)',
    formula: '(2 | x) & (3 | x + 1)',
    note: 'Intersection of two congruences — the x with x ≡ 0 (mod 2) and x ≡ 2 (mod 3), i.e. x ≡ 2 (mod 6).',
  },
  {
    name: '∀x ∃y. y = x + 1  (true)',
    formula: 'A x. E y. y = x + 1',
    note: 'A closed sentence: every natural has a successor. The final automaton is nonempty ⇒ TRUE.',
  },
  {
    name: '∃x. 2x = 1  (false)',
    formula: 'E x. 2*x = 1',
    note: 'One is not even — the projected automaton is empty ⇒ FALSE. Decidability in a picture.',
  },
  {
    name: 'parity is total  (true)',
    formula: 'A x. (2 | x) ∨ (2 | x + 1)',
    note: 'Every natural is even or odd — a true ∀ sentence built from two congruences.',
  },
  {
    name: 'no number below all  (false)',
    formula: 'E x. A y. x <= y',
    note: 'There is a least natural (0), so this is actually TRUE — flip to ∀x∃y to see a false one.',
  },
  {
    name: 'between: x < y ∧ y < x+3',
    formula: 'E y. (x < y & y < x + 3)',
    note: 'The x that admit a strictly-in-between-and-close y — every x qualifies (y = x+1).',
  },
  {
    name: '3∣x ∧ ¬(2∣x)',
    formula: '(3 | x) & ~(2 | x)',
    note: 'Odd multiples of three: 3, 9, 15, 21, … — a congruence intersected with a negated one.',
  },
]

export const DEFAULT_FORMULA = PRESBURGER_EXAMPLES[3].formula
