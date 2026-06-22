// A curated gallery of context-free grammars that show off different shapes of CFL.

export interface GrammarExample {
  name: string
  text: string
  test: string
  note: string
}

export const GRAMMAR_EXAMPLES: GrammarExample[] = [
  {
    name: 'aⁿbⁿ',
    text: 'S -> a S b | ε',
    test: 'aabb',
    note: 'The canonical non-regular language: equal runs of a then b. A regex cannot count — this grammar can.',
  },
  {
    name: 'Balanced parentheses (Dyck)',
    text: 'S -> ( S ) S | ε',
    test: '(()())',
    note: 'Well-nested brackets. The PDA’s stack mirrors the nesting depth exactly.',
  },
  {
    name: 'Palindromes over {a,b}',
    text: 'S -> a S a | b S b | a | b | ε',
    test: 'abba',
    note: 'Even and odd palindromes. Inherently non-deterministic: the machine must guess the midpoint.',
  },
  {
    name: 'Equal a’s and b’s',
    text: 'S -> a S b S | b S a S | ε',
    test: 'abba',
    note: 'Every string with #a = #b (in any order). A classic ambiguous grammar.',
  },
  {
    name: 'Arithmetic — ambiguous',
    text: 'E -> E + E | E * E | ( E ) | i',
    test: 'i+i*i',
    note: 'The textbook ambiguous expression grammar: i+i*i has two parse trees (precedence is undefined).',
  },
  {
    name: 'Arithmetic — unambiguous',
    text: 'E -> E + T | T\nT -> T * F | F\nF -> ( E ) | i',
    test: 'i+i*i',
    note: 'The layered fix: levels for +, * and atoms force a single parse with correct precedence.',
  },
  {
    name: 'Right-linear (= a regex)',
    text: 'S -> a S | b S | a B\nB -> b',
    test: 'abab',
    note: 'Right-linear ⇒ regular. This is (a|b)*ab — the bridge down to the regular world.',
  },
  {
    name: 'aⁿb²ⁿ',
    text: 'S -> a S b b | ε',
    test: 'aabbbb',
    note: 'Twice as many b’s as a’s — still context-free, the count just scales.',
  },
]
