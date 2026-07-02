// A curated gallery of alternating automata, chosen to show off the two things
// alternation buys you: **universal (∧) branching** — which makes intersection
// and the "divisible by 2 *and* 3 *and* 5" languages linear-size where a DFA is
// their product — and **existential (∨) branching** — the guess-the-position
// classics whose DFA is exponential. Each entry is written in the textual format
// (`parse.ts`) and carries the language it should recognise, which the panel and
// the fuzzer check against the minimised DFA.

export interface GalleryEntry {
  name: string;
  note: string;
  source: string;
}

export const AFA_GALLERY: GalleryEntry[] = [
  {
    name: 'contains an a',
    note: 'The plain existential (∨) automaton — a warm-up. One run needs to find an a.',
    source: `# w ∈ L  ⇔  w contains at least one 'a'
alphabet: a b
init: q
q, a -> acc
q, b -> q
acc, a -> acc
acc, b -> acc
final: acc`,
  },
  {
    name: '3rd symbol from the END is a',
    note:
      'Existential guess-and-check: the AFA/NFA has 5 states, but a DFA must remember the last three symbols — 2³ = 8 states. The classic reversal blow-up.',
    source: `# the third symbol from the end is an 'a'  (needs |w| ≥ 3)
alphabet: a b
init: s
s, a -> s | m1
s, b -> s
m1, a -> m2
m1, b -> m2
m2, a -> f
m2, b -> f
final: f`,
  },
  {
    name: 'length divisible by 2 and 3 and 5',
    note:
      'Universal (∧) branching splits the word to three independent modular counters. The AFA has 2+3+5 = 10 states; the equivalent DFA has lcm(2,3,5) = 30. Sum beats product.',
    source: `# |w| ≡ 0 (mod 2) AND (mod 3) AND (mod 5)  — over the unary alphabet {a}
alphabet: a
init: two0 & thr0 & fiv0
two0, a -> two1
two1, a -> two0
thr0, a -> thr1
thr1, a -> thr2
thr2, a -> thr0
fiv0, a -> fiv1
fiv1, a -> fiv2
fiv2, a -> fiv3
fiv3, a -> fiv4
fiv4, a -> fiv0
final: two0 thr0 fiv0`,
  },
  {
    name: 'length divisible by 2 and 3',
    note: 'The gentle version: two counter chains under one ∧. AFA 5 states, min-DFA 6 (= lcm 2·3).',
    source: `# |w| ≡ 0 (mod 6), built as (mod 2) AND (mod 3)
alphabet: a
init: two0 & thr0
two0, a -> two1
two1, a -> two0
thr0, a -> thr1
thr1, a -> thr2
thr2, a -> thr0
final: two0 thr0`,
  },
  {
    name: 'even #a AND contains a b',
    note:
      'Two sub-machines run at once under the initial ∧ — a parity counter over the a’s and a "seen a b yet?" chain. Load it and hit complement to see the dual recognise the negation with the same states.',
    source: `# an even number of a's, and at least one b
alphabet: a b
init: par0 & seen
par0, a -> par1
par0, b -> par0
par1, a -> par0
par1, b -> par1
seen, a -> seen
seen, b -> acc
acc, a -> acc
acc, b -> acc
final: par0 acc`,
  },
];

export const DEFAULT_AFA_SOURCE = AFA_GALLERY[2].source;
