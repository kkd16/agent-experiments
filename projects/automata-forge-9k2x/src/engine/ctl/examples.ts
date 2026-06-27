// A curated gallery of CTL model-checking problems — a branching-time formula paired with a Kripke
// structure — chosen so each canonical pattern (reachability, invariance, resettability, inevitability,
// possibility, response) appears once where it HOLDS and once where it FAILS with an instructive
// witness or counterexample. Every `expect` is differentially re-derived by the self-test (the
// fixpoint checker and the independent SCC/reachability oracle must agree), so the gallery doubles as
// a regression suite. The headline entries are the ones LTL *cannot* express — `AG EF restart` and
// `AG EF up` — the whole reason branching time earns its own mode.

export interface CtlExample {
  name: string
  formula: string
  model: string
  note: string
  expect: 'holds' | 'fails'
}

export const CTL_EXAMPLES: CtlExample[] = [
  {
    name: 'Resettability — AG EF restart ✓ (CTL-only)',
    formula: 'AG EF restart',
    expect: 'holds',
    note: 'From EVERY reachable state the system can still be reset. This nesting of a universal over an existential — "on all futures, some future reaches restart" — has no LTL equivalent: it is the canonical property that needs branching time.',
    model: `# every state can always get back to a reset
init: idle
idle    { }        -> work restart
work    { }        -> work done
done    { }        -> restart
restart { restart } -> idle`,
  },
  {
    name: 'Resettability — a trap ✗',
    formula: 'AG EF restart',
    expect: 'fails',
    note: 'One bad edge leads to a sink that can never reach restart. The counterexample is the path into the trap — a reachable state from which EF restart is false.',
    model: `# the work state can fall into a dead trap
init: idle
idle    { }        -> work restart
work    { }        -> trap
trap    { }        -> trap
restart { restart } -> idle`,
  },
  {
    name: 'Reachability — EF goal ✓',
    formula: 'EF goal',
    expect: 'holds',
    note: 'Possibility: SOME path reaches the goal. A least fixpoint grows backward from the goal state until it covers the initial state.',
    model: `init: s0
s0 { } -> s0 s1
s1 { } -> s2
s2 { goal } -> s2`,
  },
  {
    name: 'Reachability — unreachable goal ✗',
    formula: 'EF goal',
    expect: 'fails',
    note: 'The goal proposition is never labelled on any reachable state, so the EF fixpoint stays empty at the initial state.',
    model: `init: s0
s0 { } -> s1
s1 { } -> s0`,
  },
  {
    name: 'Invariance — AG ¬bad ✓',
    formula: 'AG !bad',
    expect: 'holds',
    note: 'Safety: on all paths, forever, the bad state is avoided. AG ¬bad is the greatest fixpoint of "¬bad and all successors stay safe".',
    model: `init: a
a { } -> b
b { } -> a`,
  },
  {
    name: 'Invariance — a reachable fault ✗',
    formula: 'AG !bad',
    expect: 'fails',
    note: 'The fault is reachable, so the safety invariant breaks. The counterexample is the concrete path from the start to the bad state.',
    model: `init: a
a   { }    -> a bad
bad { bad } -> bad`,
  },
  {
    name: 'Inevitability — AF done ✓',
    formula: 'AF done',
    expect: 'holds',
    note: 'Liveness: on EVERY path the task eventually completes. Each path is forced into the done state.',
    model: `init: s0
s0 { } -> s1
s1 { done } -> s1`,
  },
  {
    name: 'Inevitability — a stalling loop ✗',
    formula: 'AF done',
    expect: 'fails',
    note: 'A self-loop lets one path idle forever without finishing. The counterexample is the done-avoiding lasso (a witness for EG ¬done).',
    model: `init: s0
s0 { } -> s0 s1
s1 { done } -> s1`,
  },
  {
    name: 'Possibility — EG running ✓',
    formula: 'EG running',
    expect: 'holds',
    note: 'Some path keeps the system running forever — a greatest fixpoint, witnessed by a lasso that stays inside the running region.',
    model: `init: s0
s0 { running } -> s0 s1
s1 { } -> s1`,
  },
  {
    name: 'Response — AG(req → AF ack) ✓',
    formula: 'AG (req -> AF ack)',
    expect: 'holds',
    note: 'The branching reading of the classic response pattern: from every request state, ALL futures eventually acknowledge. Here req always leads straight to ack.',
    model: `init: idle
idle  { }    -> idle q
q     { req } -> ackS
ackS  { ack } -> idle`,
  },
  {
    name: 'Response — a starved request ✗',
    formula: 'AG (req -> AF ack)',
    expect: 'fails',
    note: 'The request state may loop on itself forever, so some future never acknowledges. The counterexample reaches a req-state and then loops avoiding ack.',
    model: `init: idle
idle  { }    -> idle q
q     { req } -> q ackS
ackS  { ack } -> idle`,
  },
  {
    name: 'Recoverability — AG EF up ✓ (CTL-only)',
    formula: 'AG EF up',
    expect: 'holds',
    note: 'However the system goes down, it can always come back up. Like resettability, "AG EF up" is provably inexpressible in LTL — branching time is essential.',
    model: `init: up
up   { up } -> up down
down { }    -> up`,
  },
  {
    name: 'Stabilization — AF AG stable ✓',
    formula: 'AF AG stable',
    expect: 'holds',
    note: 'Every path eventually reaches a region it never leaves where stable holds forever — an "eventually-always" nested across the branching.',
    model: `init: boot
boot   { }       -> run
run    { }       -> stableS
stableS { stable } -> stableS`,
  },
]

/** Quick-pick formulas for the editor (formula only — they read against whatever model is loaded). */
export const FORMULA_GALLERY: { name: string; formula: string }[] = [
  { name: 'EF (reachable)', formula: 'EF goal' },
  { name: 'AG (invariant)', formula: 'AG !bad' },
  { name: 'EX (some next)', formula: 'EX p' },
  { name: 'AX (all next)', formula: 'AX p' },
  { name: 'AF (inevitable)', formula: 'AF done' },
  { name: 'EG (possible)', formula: 'EG running' },
  { name: 'E[· U ·]', formula: 'E[a U b]' },
  { name: 'A[· U ·]', formula: 'A[a U b]' },
  { name: 'resettable', formula: 'AG EF restart' },
  { name: 'response', formula: 'AG (req -> AF ack)' },
  { name: 'stabilizes', formula: 'AF AG stable' },
  { name: 'release', formula: 'E[a R b]' },
]

export const DEFAULT_FORMULA = CTL_EXAMPLES[0].formula
export const DEFAULT_MODEL = CTL_EXAMPLES[0].model
