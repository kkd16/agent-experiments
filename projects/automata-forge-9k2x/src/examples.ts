// A curated gallery of regexes that show off different shapes of regular language.

export interface Example {
  name: string
  regex: string
  test: string
  note: string
}

export const EXAMPLES: Example[] = [
  {
    name: 'Even number of a',
    regex: 'b*(ab*ab*)*',
    test: 'abba',
    note: 'Strings over {a,b} with an even count of a — a classic two-state DFA.',
  },
  {
    name: 'Binary, multiple of 3',
    regex: '(0|1(01*0)*1)+',
    test: '110',
    note: 'Binary numerals divisible by 3. Minimization reveals the 3-residue cycle.',
  },
  {
    name: 'C identifier',
    regex: '[a-zA-Z_][a-zA-Z0-9_]*',
    test: 'forge_42',
    note: 'A letter or underscore, then any run of word characters.',
  },
  {
    name: 'Floating point',
    regex: '-?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?',
    test: '-3.14e10',
    note: 'Optional sign, digits, optional fraction, optional exponent.',
  },
  {
    name: 'Contains "ab"',
    regex: '.*ab.*',
    test: 'xxaby',
    note: 'The wildcard . becomes Σ (every alphabet symbol, including "any other").',
  },
  {
    name: 'a then b, equal? (no)',
    regex: '(ab)+',
    test: 'abab',
    note: 'Only matched pairs — a regex cannot count, so aⁿbⁿ is out of reach.',
  },
  {
    name: 'Optional & alternation',
    regex: 'colou?r|colour',
    test: 'color',
    note: 'Both spellings; minimization merges the redundant paths.',
  },
  {
    name: 'Hex literal',
    regex: '0x[0-9a-fA-F]+',
    test: '0x1F',
    note: 'A character-class range over three disjoint runs.',
  },
]
