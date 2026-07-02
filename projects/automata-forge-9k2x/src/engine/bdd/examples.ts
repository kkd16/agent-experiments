// A curated gallery for the Symbolic mode: a CTL formula paired with a Kripke structure, chosen so the
// symbolic checker's story lands — some hold, some fail, each with an instructive reason. The verdicts
// are re-derived live by the self-test (symbolic ≡ explicit ≡ the documented `expect`), so the gallery
// doubles as a regression suite. The headline entries are the resettability properties `AG EF …` that
// linear-time LTL cannot even express — checked here entirely on BDDs.

export interface SymbolicExample {
  name: string
  formula: string
  model: string
  note: string
  expect: 'holds' | 'fails'
}

/** A default Boolean-explorer formula that shows why *ordering* matters (see the About tab). */
export const DEFAULT_BOOL = '(a & b) | (c & d) | (e & f)'

export const SYMBOLIC_EXAMPLES: SymbolicExample[] = [
  {
    name: 'Resettability — AG EF restart ✓',
    formula: 'AG EF restart',
    expect: 'holds',
    note: 'From EVERY reachable state the system can still reach a reset. A universal-over-existential nesting with no LTL equivalent — and here the whole check runs on BDDs: the inner EF is a least fixpoint of the pre-image relation, the outer AG a greatest fixpoint, both computed symbolically.',
    model: `init: idle
idle    { }         -> work restart
work    { }         -> work done
done    { }         -> restart
restart { restart } -> idle`,
  },
  {
    name: 'Resettability — a trap ✗',
    formula: 'AG EF restart',
    expect: 'fails',
    note: 'One bad edge falls into a sink that can never reach restart. The symbolic AG fixpoint peels that sink (and everything that must pass through it) out of Sat(EF restart), so the initial state is excluded.',
    model: `init: idle
idle    { }         -> work restart
work    { }         -> trap
trap    { }         -> trap
restart { restart } -> idle`,
  },
  {
    name: 'Mutual exclusion — AG ¬(c1 ∧ c2) ✓',
    formula: 'AG !(c1 & c2)',
    expect: 'holds',
    note: 'A two-process mutual-exclusion skeleton: the two critical sections are never occupied at once. Safety as a greatest fixpoint — the invariant survives every reachable step. The transition-relation BDD is far smaller than the state graph, the symbolic advantage in miniature.',
    model: `# n=neutral, t=trying, c=critical, for processes 1 and 2
init: nn
nn { }        -> tn nt
tn { }        -> cn
nt { }        -> nc
cn { c1 }     -> nn
nc { c2 }     -> nn`,
  },
  {
    name: 'Inevitable service — AG(req → AF ack) ✓',
    formula: 'AG (req -> AF ack)',
    expect: 'holds',
    note: 'Every request is inevitably acknowledged: on all paths from any request state an ack must come. A greatest fixpoint (AG) wrapped around a least fixpoint (AF) — the canonical nested response property, checked symbolically.',
    model: `init: idle
idle { }      -> idle busy
busy { req }  -> serve
serve { }     -> ack1
ack1 { ack }  -> idle`,
  },
  {
    name: 'Possible deadlock — EF AG ¬live ✗-shaped',
    formula: 'EF AG !live',
    expect: 'holds',
    note: 'There EXISTS a path to a region from which the system is forever non-live — a symbolic search for a livelock sink. The inner AG finds the dead region as a greatest fixpoint; the outer EF grows backward to the initial state as a least fixpoint.',
    model: `init: run
run  { live } -> run stuck
stuck { }     -> stuck`,
  },
  {
    name: 'Counter mod 4 — AG EF zero ✓',
    formula: 'AG EF zero',
    expect: 'holds',
    note: 'A 4-state cyclic counter: from every value it can always return to zero. Two bits encode four states, so the current/next relation lives over four BDD variables — a compact symbolic picture of a cycle.',
    model: `init: c0
c0 { zero } -> c1
c1 { }      -> c2
c2 { }      -> c3
c3 { }      -> c0`,
  },
]

export const DEFAULT_FORMULA = SYMBOLIC_EXAMPLES[0].formula
export const DEFAULT_MODEL = SYMBOLIC_EXAMPLES[0].model
