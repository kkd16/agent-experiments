// Curated Presburger sentences and open formulas for the studio. Each shows a
// different face of quantifier elimination: the ∀∃ truths that QF_LIA cannot
// state, the modular constraints Cooper manufactures, and open formulas whose
// elimination yields a quantifier-free divisibility condition.

export interface PresburgerExample {
  title: string
  blurb: string
  src: string
}

export const PRESBURGER_EXAMPLES: PresburgerExample[] = [
  {
    title: 'Every integer is even or odd',
    blurb:
      'A ∀∃ truth no quantifier-free query can state: for every x there is a y with 2y = x or 2y = x + 1. Cooper eliminates the inner ∃y into a divisibility, then the outer ∀x, collapsing the whole sentence to ⊤.',
    src: 'forall x. exists y. (2y = x || 2y = x + 1)',
  },
  {
    title: 'No greatest integer',
    blurb:
      'For every x there is a strictly larger y — the integers have no maximum. The inner ∃y. y > x is true for all x (the −∞/unbounded branch of Cooper), so the sentence is ⊤. Swap the quantifiers (∃y ∀x. x ≤ y) and it becomes ⊥.',
    src: 'forall x. exists y. y > x',
  },
  {
    title: 'No integer one-half',
    blurb:
      'There is no integer x with 2x = 1. A one-line existential whose elimination leaves an unsatisfiable divisibility — the integer/rational gap, as a sentence.',
    src: 'exists x. 2x = 1',
  },
  {
    title: 'Chicken McNuggets, quantified',
    blurb:
      'Is 43 expressible as 6a + 9b + 20c with a, b, c ≥ 0? The Frobenius gap says no. Change 43 to 44 and the sentence flips to ⊤.',
    src: 'exists a. exists b. exists c. (6a + 9b + 20c = 43 & a >= 0 & b >= 0 & c >= 0)',
  },
  {
    title: 'Every integer mod 3',
    blurb:
      'For all x there is a y placing x in one of the three residue classes 3y, 3y+1, 3y+2. The quotient–remainder theorem for 3, as a ∀∃ sentence — true.',
    src: 'forall x. exists y. (x = 3y || x = 3y + 1 || x = 3y + 2)',
  },
  {
    title: 'Common multiple in a window',
    blurb:
      'Is there an x divisible by both 3 and 5 with 1 ≤ x ≤ 15? Yes — x = 15. Narrow the window to x ≤ 14 and it becomes ⊥. Divisibility predicates are first-class here.',
    src: 'exists x. (3 | x & 5 | x & x >= 1 & x <= 15)',
  },
  {
    title: 'Open formula → divisibility (free x)',
    blurb:
      'Leave x free: ∃y. x = 2y says "x is even". Cooper eliminates y and returns the quantifier-free condition 2 | x. The studio shows the resulting formula and lets you test it against x.',
    src: 'exists y. x = 2y',
  },
  {
    title: 'Frobenius as an open formula',
    blurb:
      'For which n is n = 6a + 9b + 20c solvable with a, b, c ≥ 0? Eliminating a, b, c leaves a quantifier-free condition on n — a union of residue classes above the Frobenius number 43.',
    src: 'exists a. exists b. exists c. (6a + 9b + 20c = n & a >= 0 & b >= 0 & c >= 0)',
  },
  {
    title: 'Density: a multiple of 7 in every window of 7',
    blurb:
      'For every x there is a y with x ≤ 7y and 7y ≤ x + 6 — every length-7 window holds a multiple of 7. True for all integers.',
    src: 'forall x. exists y. (x <= 7y & 7y <= x + 6)',
  },
  {
    title: 'A false ∀∃ (off-by-one)',
    blurb:
      'Claim: every x has a y with 2y = x (every integer is even). False — the odd integers are the counterexamples, and Cooper returns ⊥.',
    src: 'forall x. exists y. 2y = x',
  },
]
