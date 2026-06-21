// Curated CNFs for the Simplify Studio — each one dramatizes a specific
// preprocessing technique so the before/after reduction is visible at a glance.
import type { CNF } from '../sat/cnf'
import { encodePigeonhole } from '../sat/encoders/pigeonhole'
import { randomKSat } from '../sat/encoders/random3sat'

export interface PreprocessExample {
  name: string
  blurb: string
  build: () => CNF
}

function cnf(numVars: number, clauses: number[][], comment: string): CNF {
  return { numVars, clauses, comments: [comment] }
}

// A "definitional" gate y ↔ (a ∨ b) as three clauses. BVE resolves y away cleanly.
function orGate(y: number, a: number, b: number): number[][] {
  return [
    [-y, a, b],
    [y, -a],
    [y, -b],
  ]
}

export const EXAMPLES: PreprocessExample[] = [
  {
    name: 'Unit & pure cascade',
    blurb:
      'A handful of unit clauses fire a propagation cascade; the variables left over appear in only one polarity and are eliminated as pure literals. The whole formula collapses to nothing — trivially SAT — and reconstruction rebuilds the forced model.',
    build: () =>
      cnf(
        8,
        [
          [1], // x1 forced
          [-1, 2], // ⇒ x2
          [-2, 3], // ⇒ x3
          [-3, 4], // ⇒ x4
          [4, 5, 6], // x5,x6 become pure once x4 is set
          [5, 7], // x7 pure
          [6, -8], // x8 pure
        ],
        'Unit propagation followed by pure-literal elimination',
      ),
  },
  {
    name: 'Equivalence chain (SCC collapse)',
    blurb:
      'Binary clauses encode x1 ⇔ x2 ⇔ … ⇔ x8, a single strongly-connected component of the binary implication graph. Equivalent-literal substitution folds all eight variables onto one representative; the unit and ternary constraints come along for the ride.',
    build: () => {
      const clauses: number[][] = []
      for (let i = 1; i < 8; i++) {
        clauses.push([-i, i + 1]) // xi → x(i+1)
        clauses.push([i, -(i + 1)]) // x(i+1) → xi
      }
      clauses.push([1, -8, 3]) // a constraint over members — survives the rewrite
      clauses.push([-4, 6]) // redundant once everything is equal
      return cnf(8, clauses, 'Eight variables tied into one equivalence class')
    },
  },
  {
    name: 'Variable elimination (gate network)',
    blurb:
      'A small circuit of OR-gates with internal (Tseitin) variables g1…g4. None of the gate outputs is observed except through one another, so bounded variable elimination resolves every auxiliary variable away, leaving a tiny core over the primary inputs.',
    build: () => {
      // inputs: 1..4 ; gates: g1=5 (1∨2), g2=6 (3∨4), g3=7 (g1∨g2), g4=8 (g3∨1)
      const clauses: number[][] = [
        ...orGate(5, 1, 2),
        ...orGate(6, 3, 4),
        ...orGate(7, 5, 6),
        ...orGate(8, 7, 1),
        [8], // assert the top gate is true
      ]
      return cnf(8, clauses, 'OR-gate network; BVE removes the internal gate variables')
    },
  },
  {
    name: 'Blocked clauses',
    blurb:
      'The clause (x1 ∨ x2 ∨ x3) is blocked on x3: every clause containing ¬x3 also contains ¬x1 or ¬x2, so each resolvent on x3 is a tautology. Blocked-clause elimination removes it without affecting satisfiability (reconstruction restores the model). Its removal then cascades.',
    build: () =>
      cnf(
        5,
        [
          [1, 2, 3], // blocked on x3 (see ¬3 clauses below)
          [-3, -1, 4], // contains ¬1
          [-3, -2, 5], // contains ¬2
          [1, -4, 5],
          [2, -5, 4],
          [-1, -2, -4, -5],
        ],
        'A clause whose every resolvent on x3 is a tautology',
      ),
  },
  {
    name: 'Subsumption forest',
    blurb:
      'Many long clauses are each implied by a shorter one already present (C ⊆ D ⇒ D is redundant). Subsumption deletes the long clauses; self-subsuming resolution then strengthens what remains by shaving off provably-redundant literals.',
    build: () =>
      cnf(
        6,
        [
          [1, 2],
          [1, 2, 3], // subsumed by [1,2]
          [1, 2, 3, 4], // subsumed by [1,2]
          [1, 2, 4, 5, 6], // subsumed by [1,2]
          [-1, 3],
          [-1, 3, 4], // subsumed by [-1,3]
          [3, 4, 5],
          [-3, 4, 5], // with [3,4,5] → self-subsumes to [4,5]
          [2, 5, 6],
          [2, 5, 6, 1], // subsumed by [2,5,6]
        ],
        'A forest of clauses subsumed (or strengthened) by shorter ones',
      ),
  },
  {
    name: 'Pigeonhole 6→5 (UNSAT)',
    blurb:
      'Six pigeons, five holes — unsatisfiable. Preprocessing alone will not refute it (that needs search, or cutting planes), but BVE and subsumption still reshape the formula. A good stress test that simplification preserves UNSAT exactly.',
    build: () => {
      const { cnf: c } = encodePigeonhole(6)
      return { ...c, comments: ['Pigeonhole principle PHP(6,5) — unsatisfiable'] }
    },
  },
  {
    name: 'Random 3-SAT (α = 3.0)',
    blurb:
      'A uniform random 3-SAT instance below the phase transition (almost surely satisfiable). Real-world preprocessing on random formulas is modest, but you can watch each technique chip away — and verify the reconstructed model satisfies the original.',
    build: () => randomKSat(40, 3.0, 3, 7),
  },
]
