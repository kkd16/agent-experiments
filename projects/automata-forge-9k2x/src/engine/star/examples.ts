// A curated gallery of CTL* model-checking problems — chosen to walk the line between the fragments:
// a couple that live in CTL (to show CTL ⊂ CTL*), several that are *proper* CTL* (a temporal operator
// nested under a quantifier, expressible in neither CTL nor LTL alone), and one that fails so the
// counterexample machinery has something to replay.

import type { Fragment } from './formula'

export interface StarExample {
  name: string
  blurb: string
  fragment: Fragment
  formula: string
  model: string
  expect: 'holds' | 'fails'
}

export const STAR_EXAMPLES: StarExample[] = [
  {
    name: 'Existential fairness — E[G F p]',
    blurb:
      'Some path visits p infinitely often. EGFp is the textbook formula with NO CTL equivalent — a quantifier over an unbounded “infinitely often”, which CTL’s one-step-at-a-time quantifiers cannot pin down.',
    fragment: 'star',
    formula: 'E[G F p]',
    model: ['init: s0', 's0 { } -> s1 s2', 's1 { p } -> s0', 's2 { } -> s2'].join('\n'),
    expect: 'holds',
  },
  {
    name: 'Strong fairness response — A[(G F enabled) → (G F served)]',
    blurb:
      'On every path, if a process is enabled infinitely often it is served infinitely often. The premise and conclusion are each unbounded liveness, nested under a single A — pure CTL*.',
    fragment: 'star',
    formula: 'A[(G F enabled) -> (G F served)]',
    model: ['init: idle', 'idle { } -> idle req', 'req { enabled } -> serve', 'serve { served } -> idle'].join('\n'),
    expect: 'holds',
  },
  {
    name: 'Some path stabilises — E[F G p]',
    blurb:
      'There is a path that eventually settles into p forever. EFGp ≠ EF EG p; the “eventually, then always” must hold along ONE path, which only CTL* can require.',
    fragment: 'star',
    formula: 'E[F G p]',
    model: ['init: s0', 's0 { } -> s0 s1', 's1 { p } -> s1'].join('\n'),
    expect: 'holds',
  },
  {
    name: 'Every path stabilises — A[F G p]',
    blurb:
      'Along every path, p eventually holds forever. AFGp is the canonical CTL* property that is provably inexpressible in CTL — the witness that the two logics are incomparable.',
    fragment: 'star',
    formula: 'A[F G p]',
    model: ['init: a', 'a { } -> a2 b', 'a2 { } -> b', 'b { p } -> b'].join('\n'),
    expect: 'holds',
  },
  {
    name: 'Stable until — E[(G p) U q]',
    blurb:
      'Some path keeps p invariantly true until q arrives. A temporal operator (G p) sits inside an until inside a quantifier — three levels CTL flattens but CTL* keeps.',
    fragment: 'star',
    formula: 'E[(G p) U q]',
    model: ['init: a', 'a { p } -> a b', 'b { p q } -> b'].join('\n'),
    expect: 'holds',
  },
  {
    name: 'Reach a stable region — E F A G p',
    blurb:
      'Some path reaches a state from which p holds on all futures forever. The outer E F is branching, the inner A G is branching — CTL* lets them stack without an LTL flattening.',
    fragment: 'ctl',
    formula: 'E F A G p',
    model: ['init: s0', 's0 { } -> s0 s1', 's1 { p } -> s1'].join('\n'),
    expect: 'holds',
  },
  {
    name: 'Recoverable — A G E F reset',
    blurb:
      'From every reachable state the system can still be reset. A classic CTL property (and so a CTL* one) with no LTL equivalent — LTL cannot say “some future” mid-formula.',
    fragment: 'ctl',
    formula: 'A G E F reset',
    model: [
      'init: ready',
      'ready { } -> work',
      'work { } -> work ready resetphase',
      'resetphase { reset } -> ready',
    ].join('\n'),
    expect: 'holds',
  },
  {
    name: 'Response on all paths — A[G(req → F ack)]',
    blurb:
      'Along every path, every request is eventually acknowledged. The G…→F… body is a single LTL path formula under A — an ACTL* property that the automata engine checks via E of its negation.',
    fragment: 'star',
    formula: 'A[G(req -> F ack)]',
    model: ['init: idle', 'idle { } -> idle req', 'req { req } -> ack', 'ack { ack } -> idle'].join('\n'),
    expect: 'holds',
  },
  {
    name: 'Fairness violated — A[G F p] (counterexample)',
    blurb:
      'Claims p recurs forever on every path — but a path can fall into a p-free sink. The check refutes it with a lasso s0·(s2)ᵚ that satisfies the negation F G ¬p, replayed by the direct semantics.',
    fragment: 'star',
    formula: 'A[G F p]',
    model: ['init: s0', 's0 { } -> s1 s2', 's1 { p } -> s0', 's2 { } -> s2'].join('\n'),
    expect: 'fails',
  },
]

/** Quick-insert chips for the formula box. */
export const FORMULA_GALLERY: { name: string; formula: string }[] = [
  { name: '∃ fair path', formula: 'E[G F p]' },
  { name: 'strong fairness', formula: 'A[(G F req) -> (G F ack)]' },
  { name: '∃ stabilises', formula: 'E[F G p]' },
  { name: '∀ stabilise', formula: 'A[F G p]' },
  { name: 'recoverable', formula: 'A G E F reset' },
  { name: 'stable-until', formula: 'E[(G p) U q]' },
  { name: 'response', formula: 'A[G(req -> F ack)]' },
  { name: 'reach stable', formula: 'E F A G p' },
]

export const DEFAULT_FORMULA = 'E[G F p]'
export const DEFAULT_MODEL = STAR_EXAMPLES[0].model
