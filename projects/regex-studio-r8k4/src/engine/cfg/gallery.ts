// A curated gallery of context-free grammars, spanning the classic lessons:
// non-regular languages, ambiguity, precedence, and finite / empty edge cases.

export interface CfgExample {
  name: string;
  note: string;
  source: string;
  sample: string; // a suggested test string
}

export const CFG_EXAMPLES: CfgExample[] = [
  {
    name: 'aⁿbⁿ',
    note: 'The canonical non-regular language — a matched count no DFA can keep.',
    source: 'S → a S b | ε',
    sample: 'aaabbb',
  },
  {
    name: 'balanced parens (Dyck)',
    note: 'Well-nested brackets — the shape of every parser’s job.',
    source: 'S → ( S ) S | ε',
    sample: '(()())',
  },
  {
    name: 'palindromes',
    note: 'Even/odd palindromes over {a,b} — context-free, not regular.',
    source: 'S → a S a | b S b | a | b | ε',
    sample: 'abba',
  },
  {
    name: 'equal a’s and b’s',
    note: '{ w : #a = #b } — a two-sided count, still context-free.',
    source: 'S → a S b S | b S a S | ε',
    sample: 'abba',
  },
  {
    name: 'ambiguous expressions',
    note: 'E → E+E | E*E | (E) | a — genuinely ambiguous: a+a*a has two trees.',
    source: 'E → E + E | E * E | ( E ) | a',
    sample: 'a+a*a',
  },
  {
    name: 'precedence (unambiguous)',
    note: 'The same arithmetic, disambiguated by precedence + associativity layers. Left-recursive ⇒ not LL(1).',
    source: ['E → E + T | T', 'T → T * F | F', 'F → ( E ) | a'].join('\n'),
    sample: 'a+a*a',
  },
  {
    name: 'LL(1) expressions',
    note: 'The right-factored expression grammar — no left recursion, a conflict-free LL(1) table.',
    source: ['E → T X', 'X → + T X | ε', 'T → F Y', 'Y → * F Y | ε', 'F → ( E ) | a'].join('\n'),
    sample: 'a+a*a',
  },
  {
    name: 'aⁿbⁿ ∪ aⁿb²ⁿ',
    note: 'Inherently ambiguous — every string derivable two ways at the seam.',
    source: ['S → A | B', 'A → a A b | ε', 'B → a B b b | ε'].join('\n'),
    sample: 'aabb',
  },
  {
    name: 'ε-heavy (nullable)',
    note: 'Nullable nonterminals everywhere — stresses ε-elimination and Earley.',
    source: ['S → A B A B', 'A → a | ε', 'B → b | ε'].join('\n'),
    sample: 'ab',
  },
  {
    name: 'unit chain',
    note: 'A ladder of unit productions — collapsed by UNIT-elimination in CNF.',
    source: ['S → A', 'A → B', 'B → C', 'C → a | ( S )'].join('\n'),
    sample: '((a))',
  },
  {
    name: 'finite language',
    note: 'No recursion — a finite set of words the finiteness test recognises.',
    source: 'S → a b | b a | a a b',
    sample: 'aab',
  },
  {
    name: 'empty language',
    note: 'The start can never generate a terminal string — L = ∅.',
    source: ['S → a S', 'S → S b'].join('\n'),
    sample: '',
  },
];

export const DEFAULT_CFG_SOURCE = CFG_EXAMPLES[0].source;
export const DEFAULT_CFG_SAMPLE = CFG_EXAMPLES[0].sample;
