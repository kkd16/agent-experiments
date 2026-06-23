// A gallery of grammars chosen to illuminate the parsing hierarchy — each one sits at a *different*
// rung of LL(1) / LR(0) ⊊ SLR(1) ⊊ LALR(1) ⊊ LR(1), so flipping between them in the classifier shows
// the whole tower light up one cell at a time.

export interface ParseExample {
  name: string
  text: string
  test: string
  note: string
}

export const PARSE_EXAMPLES: ParseExample[] = [
  {
    name: 'Expressions — LL(1) (left-factored)',
    text: 'E -> T X\nX -> + T X | ε\nT -> F Y\nY -> * F Y | ε\nF -> ( E ) | i',
    test: 'i+i*i',
    note: 'The dragon-book LL(1) expression grammar: left recursion removed and common prefixes factored, so one token of lookahead suffices. Predict, never backtrack.',
  },
  {
    name: 'Expressions — left-recursive, SLR(1)',
    text: 'E -> E + T | T\nT -> T * F | F\nF -> ( E ) | i',
    test: 'i+i*i',
    note: 'The natural left-recursive grammar (precedence baked in). Hopeless for LL — but a textbook SLR(1) grammar, parsed bottom-up with one FOLLOW-set lookahead.',
  },
  {
    name: 'Pointers — LALR(1), not SLR(1)',
    text: 'S -> L = R | R\nL -> * R | i\nR -> L',
    test: '*i=i',
    note: 'Knuth’s assignment grammar (i = identifier, * = dereference). SLR(1) hits a shift/reduce conflict on “=”; the sharper LALR(1) lookahead resolves it.',
  },
  {
    name: 'LR(1), not LALR(1)',
    text: 'S -> a A d | b B d | a B e | b A e\nA -> c\nB -> c',
    test: 'acd',
    note: 'The canonical grammar where merging LALR states fuses two reductions into a reduce/reduce conflict. Full canonical LR(1) keeps them apart.',
  },
  {
    name: 'Dangling else — ambiguous (shift/reduce)',
    text: 'S -> i S e S | i S | a',
    test: 'iiaea',
    note: 'if / if-else (i = “if c then”, e = “else”, a = a plain statement). Ambiguous: a shift/reduce conflict no LR table escapes — resolved “shift” to bind else to the nearest if.',
  },
  {
    name: 'Balanced parentheses — LL(1)',
    text: 'S -> ( S ) S | ε',
    test: '(()())',
    note: 'Dyck words. LL(1): FIRST tells “(” apart from the ε case, FOLLOW handles the empty tail.',
  },
  {
    name: 'aⁿbⁿ — LR(0)',
    text: 'S -> a S b | a b',
    test: 'aabb',
    note: 'Equal runs of a then b. So unambiguous and prefix-free that even LR(0) — reduce with NO lookahead — parses it.',
  },
  {
    name: 'Even palindromes — not LR(k)',
    text: 'S -> a S a | b S b | ε',
    test: 'abba',
    note: 'A deterministic stack can’t find the midpoint, so this nondeterministic grammar conflicts at every LR level — a language no shift-reduce parser handles. (Earley still parses it.)',
  },
]
