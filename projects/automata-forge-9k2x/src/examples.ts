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
  {
    name: 'Ends in 01',
    regex: '(0|1)*01',
    test: '11001',
    note: 'A 3-state minimal DFA — the classic "remember the last two bits" machine.',
  },
]

/** Two-regex scenarios for the Compare workbench: equivalent pairs and near-misses. */
export interface ComparePair {
  name: string
  a: string
  b: string
  note: string
}

export const COMPARE_EXAMPLES: ComparePair[] = [
  {
    name: 'Equivalent: (a|b)* vs (a*b*)*',
    a: '(a|b)*',
    b: '(a*b*)*',
    note: 'Two very different-looking regexes for "any string over {a,b}". Symmetric difference is empty.',
  },
  {
    name: 'Equivalent: (ab)*a vs a(ba)*',
    a: '(ab)*a',
    b: 'a(ba)*',
    note: 'The same language of alternating strings that start and end with a — a classic identity.',
  },
  {
    name: 'Near-miss: one-char witness',
    a: '(0|1)*0',
    b: '(0|1)*',
    note: 'Binary strings ending in 0 vs all binary strings. The shortest distinguisher is "1".',
  },
  {
    name: 'Containment: a+ ⊆ a*',
    a: 'a+',
    b: 'a*',
    note: 'One or more a’s is contained in zero or more a’s; the only difference is the empty string.',
  },
  {
    name: 'Disjoint: even vs odd a’s',
    a: 'b*(ab*ab*)*',
    b: 'b*ab*(ab*ab*)*',
    note: 'Even count of a vs odd count of a — disjoint languages whose union is everything.',
  },
  {
    name: 'Intersection: has-ab and has-ba',
    a: '.*ab.*',
    b: '.*ba.*',
    note: 'Strings containing both "ab" and "ba" somewhere. Intersection builds the combined DFA.',
  },
]
