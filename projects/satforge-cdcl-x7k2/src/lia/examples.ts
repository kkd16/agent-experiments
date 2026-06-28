// Curated QF_LIA systems for the studio — each chosen to show a different face
// of integer linear arithmetic: pure Diophantine feasibility, the gap between
// the rational and integer worlds (where the dark shadow / splinters earn their
// keep), and small modelling problems.

export interface LiaExample {
  title: string
  blurb: string
  src: string
}

export const LIA_EXAMPLES: LiaExample[] = [
  {
    title: 'Chicken McNuggets (Frobenius)',
    blurb:
      'Can 43 be made from 6-, 9- and 20-piece boxes? 43 is the largest number that cannot — the Frobenius number of {6,9,20}. Change 43 to 44 and it becomes satisfiable.',
    src: '# nonnegative box counts summing to a target\n6a + 9b + 20c = 43\na >= 0\nb >= 0\nc >= 0',
  },
  {
    title: 'Diophantine line (Bézout)',
    blurb:
      'A single linear equation has integer points iff the gcd of the coefficients divides the constant. gcd(7,5)=1 divides 1, so 7x + 5y = 1 is solvable; the solver returns one Bézout witness.',
    src: '7x + 5y = 1',
  },
  {
    title: 'No integer half',
    blurb:
      'The rational relaxation is fine (x = ½) but there is no integer between the bounds. This is exactly the dark-shadow gap: the real shadow is nonempty, yet every splinter is unsatisfiable.',
    src: '2x >= 1\n2x <= 1',
  },
  {
    title: 'Tight slab (dark shadow)',
    blurb:
      'Two skew bands intersect in a sliver that nonetheless contains a lattice point. The dark shadow is wide enough to certify it directly — no splintering needed.',
    src: '11 <= 6x + 13y\n6x + 13y <= 45\n-8 <= 7x - 9y\n7x - 9y <= 6',
  },
  {
    title: 'Parity contradiction',
    blurb:
      'Sum and difference fix 2x = 13, an odd number — unsatisfiable over the integers though trivially solvable over the rationals (x = 6.5).',
    src: 'x + y = 13\nx - y = 0',
  },
  {
    title: 'Coin change feasibility',
    blurb:
      'Make exactly 99 from 5s, 7s and 11s using at most 12 coins. A bounded integer feasibility query — the kind of thing SMT solvers field constantly.',
    src: '5a + 7b + 11c = 99\na + b + c <= 12\na >= 0\nb >= 0\nc >= 0',
  },
  {
    title: 'Splinter case (3-var)',
    blurb:
      'Coefficients with no unit among them force the exact-projection theorem: when the dark shadow comes up empty, the solver enumerates equality splinters to settle the question exactly.',
    src: '3 <= 2x + 2y - z\n2x + 2y - z <= 4\n0 <= x\nx <= 3\n0 <= y\ny <= 3\n0 <= z\nz <= 3',
  },
  {
    title: 'Pythagorean-ish packing',
    blurb:
      'A small modelling system: three integers with weighted sums boxed from both sides. Feasible — the model is a lattice point inside the polytope.',
    src: '3x + 4y + 5z = 30\nx + y + z >= 6\n0 <= x\nx <= 8\n0 <= y\ny <= 8\n0 <= z\nz <= 8',
  },
  {
    title: 'Unbounded (one-sided)',
    blurb:
      'Only lower bounds on the variables, so the feasible region runs to infinity. Projection drops the variable with no shadow constraint and the solver returns a representative point.',
    src: 'x - y >= 2\ny >= 0\nx >= 0',
  },
]
