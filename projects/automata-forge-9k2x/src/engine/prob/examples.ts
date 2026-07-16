// The gallery — curated Markov models, each a piece of the classic probabilistic-model-checking
// canon with a KNOWN closed-form answer, so the lab both teaches and self-checks. Every model is
// stored as its textual source (the same thing the URL hash carries), and ships with a few suggested
// PCTL queries that showcase a different operator.

export interface ProbExample {
  id: string
  name: string
  kind: 'dtmc' | 'mdp'
  blurb: string
  source: string
  queries: string[]
}

export const PROB_EXAMPLES: ProbExample[] = [
  {
    id: 'dice',
    name: "Knuth–Yao die",
    kind: 'dtmc',
    blurb:
      "Simulate a fair six-sided die using only a fair coin. Each face comes out with probability exactly 1/6, and it takes 11/3 flips on average — the textbook DTMC where exact rational analysis shines.",
    source: `dtmc
# Knuth & Yao's optimal simulation of a d6 from fair coin flips.
init s0
s0 -> 1/2: s1, 1/2: s2
s1 -> 1/2: s3, 1/2: s4
s2 -> 1/2: s5, 1/2: s6
s3 -> 1/2: s1, 1/2: d1
s4 -> 1/2: d2, 1/2: d3
s5 -> 1/2: d4, 1/2: d5
s6 -> 1/2: s2, 1/2: d6
d1 -> 1: d1
d2 -> 1: d2
d3 -> 1: d3
d4 -> 1: d4
d5 -> 1: d5
d6 -> 1: d6
label done = d1 d2 d3 d4 d5 d6
label six = d6`,
    queries: ['P=? [ F six ]', 'P=? [ F done ]', 'P>=1 [ F done ]', 'P=? [ F<=6 done ]'],
  },
  {
    id: 'craps',
    name: 'Craps',
    kind: 'dtmc',
    blurb:
      "The casino dice game as a Markov chain: win on a come-out 7/11, lose on 2/3/12, otherwise chase your 'point' before a 7. The house wins because P(win) = 244/495 ≈ 0.4929 < 1/2 — a number no arithmetic shortcut gives you, only the linear solve.",
    source: `dtmc
# Come-out roll then point phase. Probabilities are out of 36 (two dice).
init come
come -> 8/36: won, 4/36: lost, 3/36: p4, 4/36: p5, 5/36: p6, 5/36: p8, 4/36: p9, 3/36: p10
p4  -> 3/36: won, 6/36: lost, 27/36: p4
p5  -> 4/36: won, 6/36: lost, 26/36: p5
p6  -> 5/36: won, 6/36: lost, 25/36: p6
p8  -> 5/36: won, 6/36: lost, 25/36: p8
p9  -> 4/36: won, 6/36: lost, 26/36: p9
p10 -> 3/36: won, 6/36: lost, 27/36: p10
won  -> 1: won
lost -> 1: lost
label win = won
label lose = lost`,
    queries: ['P=? [ F win ]', 'P=? [ F lose ]', 'P<1/2 [ F win ]', 'R'],
  },
  {
    id: 'ruin',
    name: "Gambler's ruin",
    kind: 'dtmc',
    blurb:
      "A symmetric random walk on 0…6 starting at 3: step up or down with equal chance until you go broke (0) or hit the target (6). The probability of reaching the target from state i is exactly i/6 — a martingale identity the engine recovers as a fraction.",
    source: `dtmc
init g3
g0 -> 1: g0
g1 -> 1/2: g0, 1/2: g2
g2 -> 1/2: g1, 1/2: g3
g3 -> 1/2: g2, 1/2: g4
g4 -> 1/2: g3, 1/2: g5
g5 -> 1/2: g4, 1/2: g6
g6 -> 1: g6
label target = g6
label broke = g0`,
    queries: ['P=? [ F target ]', 'P=? [ !broke U target ]', 'P=? [ F broke ]'],
  },
  {
    id: 'retry',
    name: 'Unreliable channel',
    kind: 'dtmc',
    blurb:
      "A sender retransmits until an ack arrives; each attempt succeeds with probability 9/10. Delivery is certain in the limit (P = 1), but the step-bounded probability P(F≤k delivered) = 1 − (1/10)ᵏ climbs toward it — the operator that separates 'eventually' from 'soon'.",
    source: `dtmc
init send
send -> 9/10: delivered, 1/10: send
delivered -> 1: delivered
label ok = delivered`,
    queries: ['P=? [ F ok ]', 'P=? [ F<=1 ok ]', 'P=? [ F<=3 ok ]', 'P>=0.99 [ F<=2 ok ]'],
  },
  {
    id: 'weather',
    name: 'Weather (steady state)',
    kind: 'dtmc',
    blurb:
      "A two-state ergodic chain: sunny days stay sunny 4/5 of the time, rainy days clear up 1/2 the time. Whatever today is, in the long run it rains a fraction 2/7 of the days — the stationary distribution, reported as S=? [ rain ].",
    source: `dtmc
init sunny
sunny -> 4/5: sunny, 1/5: rainy
rainy -> 1/2: sunny, 1/2: rainy
label rain = rainy
label sun = sunny`,
    queries: ['S=? [ rain ]', 'S=? [ sun ]', 'P=? [ F<=3 rain ]'],
  },
  {
    id: 'corridor',
    name: 'Frozen corridor (MDP)',
    kind: 'mdp',
    blurb:
      "A robot edges down a slippery corridor to the goal; each 'forward' step advances with probability 7/10 but falls in a hole with 3/10, while 'back' retreats safely. Pmax asks for the best driver's success odds; Pmin exposes the worst — the scheduler is the whole story.",
    source: `mdp
init c0
c0 -fwd-> 7/10: c1, 3/10: hole
c0 -back-> 1: c0
c1 -fwd-> 7/10: c2, 3/10: hole
c1 -back-> 1: c0
c2 -fwd-> 7/10: goal, 3/10: hole
c2 -back-> 1: c1
goal -> 1: goal
hole -> 1: hole
label goal = goal
label hole = hole`,
    queries: ['Pmax=? [ F goal ]', 'Pmin=? [ F goal ]', 'Pmax=? [ !hole U goal ]'],
  },
  {
    id: 'gambler',
    name: 'Betting gambler (MDP)',
    kind: 'mdp',
    blurb:
      "Wealth 0…4, target 4, each bet won with probability 2/5. At each fortune the gambler chooses a stake; with an unfair coin, 'bold play' (stake as much as it takes to reach the goal in one shot) maximises the chance of getting rich. Pmax=? finds it and the strategy tab shows the optimal stakes.",
    source: `mdp
init w1
w1 -s1-> 2/5: w2, 3/5: w0
w2 -s1-> 2/5: w3, 3/5: w1
w2 -s2-> 2/5: w4, 3/5: w0
w3 -s1-> 2/5: w4, 3/5: w2
w0 -> 1: w0
w4 -> 1: w4
label rich = w4
label broke = w0`,
    queries: ['Pmax=? [ F rich ]', 'Pmin=? [ F rich ]', 'Pmax=? [ !broke U rich ]'],
  },
]

export const DEFAULT_PROB = PROB_EXAMPLES[0]

export function findProbExample(id: string): ProbExample | undefined {
  return PROB_EXAMPLES.find((e) => e.id === id)
}
