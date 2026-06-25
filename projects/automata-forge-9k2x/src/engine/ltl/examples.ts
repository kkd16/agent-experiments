// A curated gallery of model-checking problems — a formula paired with a Kripke structure — chosen so
// the canonical reactive-systems properties (safety, liveness, fairness, response, stability) each
// appear once where they HOLD and once where they FAIL with an instructive lasso counterexample.
// Every `expect` here is differentially re-derived by the self-test (semantics oracle + model check),
// so the gallery doubles as a regression suite.

export interface LogicExample {
  name: string
  formula: string
  model: string
  note: string
  expect: 'holds' | 'fails'
}

export const LOGIC_EXAMPLES: LogicExample[] = [
  {
    name: 'Response — every request is answered ✓',
    formula: 'G (req -> F ack)',
    expect: 'holds',
    note: 'The classic liveness pattern: whenever req holds, ack eventually follows. Here the model always moves req → ack, so it holds on every path.',
    model: `# every request is eventually acknowledged
init: idle
idle { }    -> idle s_req
s_req { req } -> s_ack
s_ack { ack } -> idle`,
  },
  {
    name: 'Response — a starved request ✗',
    formula: 'G (req -> F ack)',
    expect: 'fails',
    note: 'Same property, one buggy edge: the request state may loop on itself forever, so ack never comes. The counterexample is the lasso that idles in s_req.',
    model: `# the request can be postponed forever
init: idle
idle { }    -> idle s_req
s_req { req } -> s_req s_ack
s_ack { ack } -> idle`,
  },
  {
    name: 'Mutual exclusion — safety ✓',
    formula: 'G !(c0 & c1)',
    expect: 'holds',
    note: 'Two processes share a token; at most one is in its critical section. The unsafe state c0 ∧ c1 is unreachable, so this invariant holds.',
    model: `# a token alternates which process may enter
init: neutral
neutral { }   -> crit0 crit1
crit0 { c0 }  -> neutral
crit1 { c1 }  -> neutral`,
  },
  {
    name: 'Mutual exclusion — a race ✗',
    formula: 'G !(c0 & c1)',
    expect: 'fails',
    note: 'A broken lock lets both processes hold the critical section at once. The counterexample reaches the state where c0 and c1 are both true.',
    model: `# both processes can end up critical together
init: neutral
neutral { }     -> p0
p0 { c0 }       -> both
both { c0 c1 }  -> neutral`,
  },
  {
    name: 'Fairness — p infinitely often ✓',
    formula: 'G F p',
    expect: 'holds',
    note: 'A strong-fairness/liveness assertion: p recurs forever. Every cycle of this model passes through a p-state, so GF p holds.',
    model: `init: a
a { }   -> b
b { p } -> a`,
  },
  {
    name: 'Fairness — p can stop ✗',
    formula: 'G F p',
    expect: 'fails',
    note: 'A self-loop with no p lets the system stall. The lasso that stays in the idle state forever witnesses the failure of GF p.',
    model: `init: a
a { }   -> a b
b { p } -> b`,
  },
  {
    name: 'Until — a holds until b ✓',
    formula: 'a U b',
    expect: 'holds',
    note: 'Strong until: a must hold at every step up to a (guaranteed) point where b holds. Every path here is one a-state then b forever.',
    model: `init: s0
s0 { a } -> s1
s1 { b } -> s1`,
  },
  {
    name: 'Stability — once p, always p ✓',
    formula: 'G (p -> G p)',
    expect: 'holds',
    note: 'A latching property: the moment p becomes true it stays true. The p-state has only a self-loop, so p never drops.',
    model: `init: off
off { }  -> off on
on { p } -> on`,
  },
  {
    name: 'Stability — p flickers ✗',
    formula: 'G (p -> G p)',
    expect: 'fails',
    note: 'Here the p-state can fall back to ¬p, breaking the latch. The counterexample toggles p off again.',
    model: `init: off
off { }  -> off on
on { p } -> off`,
  },
  {
    name: 'Next — p at the second step ✓',
    formula: 'X p',
    expect: 'holds',
    note: 'X looks exactly one step ahead. Every path leaves s0 into a p-state, so X p holds at the start.',
    model: `init: s0
s0 { }  -> s1
s1 { p } -> s1`,
  },
  {
    name: 'Traffic light — no green without yellow ✗',
    formula: 'G (green -> X !red)',
    expect: 'fails',
    note: 'A liveness/ordering bug: after green the very next state should not be red. This faulty controller jumps green → red, and the counterexample exhibits it.',
    model: `init: red
red { red }       -> green
green { green }   -> red yellow
yellow { yellow } -> red`,
  },
]

/** Quick-pick formulas for the Büchi tab (formula only — no model needed). */
export const FORMULA_GALLERY: { name: string; formula: string }[] = [
  { name: 'eventually', formula: 'F p' },
  { name: 'always', formula: 'G p' },
  { name: 'next', formula: 'X p' },
  { name: 'until', formula: 'p U q' },
  { name: 'release', formula: 'p R q' },
  { name: 'response', formula: 'G (p -> F q)' },
  { name: 'recurrence (GF)', formula: 'G F p' },
  { name: 'stability (FG)', formula: 'F G p' },
  { name: 'fair response', formula: 'G F p -> G F q' },
  { name: 'until chain', formula: 'p U (q U r)' },
  { name: 'strong + weak', formula: 'p W q' },
  { name: 'next-step xor', formula: 'X (p <-> !q)' },
]

export const DEFAULT_FORMULA = 'G (req -> F ack)'
export const DEFAULT_MODEL = LOGIC_EXAMPLES[0].model
