// A curated gallery of targets for the Learn (L*) mode. Each is a regular language the learner is
// never shown — it only gets membership answers and counterexamples and must reconstruct the
// minimal DFA. Small alphabets keep the observation table legible.

export interface LearnExample {
  name: string
  regex: string
  /** What the language is, in words. */
  blurb: string
}

export const LEARN_EXAMPLES: LearnExample[] = [
  {
    name: 'ends with abb',
    regex: '(a|b)*abb',
    blurb: 'all strings over {a,b} ending in abb — Angluin’s textbook target',
  },
  {
    name: 'second-to-last is a',
    regex: '(a|b)*a(a|b)',
    blurb: 'the a-is-second-from-the-end language — a tiny NFA, but the DFA needs 4 states',
  },
  {
    name: 'contains aa',
    regex: '(a|b)*aa(a|b)*',
    blurb: 'strings with a double-a somewhere',
  },
  {
    name: 'even number of a’s',
    regex: 'b*(ab*ab*)*',
    blurb: 'a parity language — two states, learned from a single counterexample',
  },
  {
    name: 'alternating (ab)*',
    regex: '(ab)*',
    blurb: 'perfectly alternating ab…ab, including the empty string',
  },
  {
    name: 'a’s then b’s',
    regex: 'a*b*',
    blurb: 'every a precedes every b',
  },
  {
    name: 'binary ≡ 0 (mod 3)',
    regex: '(0|1(01*0)*1)*',
    blurb: 'binary numbers divisible by three — the classic three-state residue automaton',
  },
  {
    name: 'third-from-last is a',
    regex: '(a|b)*a(a|b)(a|b)',
    blurb: 'the exponential-gap language: a small NFA whose DFA needs 8 states',
  },
  {
    name: 'everything (a|b)*',
    regex: '(a|b)*',
    blurb: 'the universal language over {a,b} — one accepting state, plus the trap any other char hits',
  },
  {
    name: 'the word "cafe"',
    regex: 'cafe',
    blurb: 'a finite, single-string language — a straight chain of states',
  },
]
