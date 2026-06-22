// The context-free grammar data model, a tolerant text parser, and a pretty-printer.
//
// Convention (the classic theory-of-computation one): a **single uppercase letter** A–Z is a
// nonterminal (variable); every other non-whitespace character is a terminal. So `S -> a S b` and
// `S -> aSb` parse identically. Alternatives are separated by `|`; the empty word is written `ε`,
// `epsilon`, `λ`, or an empty right-hand side. Productions may use `->`, `→`, or `::=`. Lines after
// `#` or `//` are comments. The start symbol is the left-hand side of the first production.
//
// The data model itself is more general than the parser: a symbol is a nonterminal iff it is listed
// in `nonterminals`, so the normaliser is free to mint multi-character helper names (`S0`, `T_a`, …)
// that the parser would never accept.

/** A single production `lhs -> rhs`. An empty `rhs` array is the ε-production `lhs -> ε`. */
export interface Production {
  lhs: string
  rhs: string[]
}

/** A context-free grammar. `nonterminals` is the authoritative set of variables. */
export interface Grammar {
  start: string
  nonterminals: string[]
  terminals: string[]
  productions: Production[]
}

export interface GrammarError {
  line: number // 1-based
  col: number // 1-based
  message: string
}

export interface ParseResult {
  grammar?: Grammar
  errors: GrammarError[]
}

/** Is `sym` a nonterminal of `g`? (For hot loops, build a {@link ntSetOf} once instead.) */
export function isNonterminal(g: Grammar, sym: string): boolean {
  return g.nonterminals.includes(sym)
}

/** Build a fast nonterminal-membership predicate for a grammar. */
export function ntSetOf(g: Grammar): Set<string> {
  return new Set(g.nonterminals)
}

/** All productions whose left-hand side is `nt`. */
export function bodiesOf(g: Grammar, nt: string): string[][] {
  const out: string[][] = []
  for (const p of g.productions) if (p.lhs === nt) out.push(p.rhs)
  return out
}

const ARROW = /->|→|::=/

/** Tokenise one alternative's text into a list of grammar symbols (each char is one symbol). */
function lexRhs(text: string): string[] {
  const t = text.trim()
  if (t === '' || t === 'ε' || t === 'λ' || t.toLowerCase() === 'epsilon' || t === '""' || t === "''") {
    return []
  }
  const syms: string[] = []
  for (const ch of t) {
    if (ch === ' ' || ch === '\t') continue
    syms.push(ch)
  }
  return syms
}

const isUpper = (c: string) => c.length === 1 && c >= 'A' && c <= 'Z'

/**
 * Parse grammar source text. Always returns whatever it could recover plus a list of errors; a
 * grammar with zero productions yields `grammar: undefined`.
 */
export function parseGrammar(src: string): ParseResult {
  const errors: GrammarError[] = []
  const productions: Production[] = []
  const ntOrder: string[] = []
  const ntSeen = new Set<string>()
  const termOrder: string[] = []
  const termSeen = new Set<string>()
  let start: string | undefined

  const registerNt = (c: string) => {
    if (!ntSeen.has(c)) {
      ntSeen.add(c)
      ntOrder.push(c)
    }
  }
  const registerTerm = (c: string) => {
    if (!termSeen.has(c)) {
      termSeen.add(c)
      termOrder.push(c)
    }
  }

  const rawLines = src.split('\n')
  rawLines.forEach((raw, i) => {
    const lineNo = i + 1
    // Strip comments.
    let line = raw
    const hash = line.indexOf('#')
    const slash = line.indexOf('//')
    const cut = [hash, slash].filter((x) => x >= 0).sort((a, b) => a - b)[0]
    if (cut !== undefined) line = line.slice(0, cut)
    if (line.trim() === '') return

    const m = ARROW.exec(line)
    if (!m) {
      errors.push({ line: lineNo, col: 1, message: `missing "->" — write e.g. "S -> a S b"` })
      return
    }
    const lhsText = line.slice(0, m.index).trim()
    if (lhsText.length !== 1 || !isUpper(lhsText)) {
      errors.push({
        line: lineNo,
        col: 1,
        message: `left-hand side must be a single uppercase letter (A–Z), got "${lhsText}"`,
      })
      return
    }
    const lhs = lhsText
    registerNt(lhs)
    if (start === undefined) start = lhs

    const rhsText = line.slice(m.index + m[0].length)
    const alts = rhsText.split('|')
    for (const alt of alts) {
      const syms = lexRhs(alt)
      for (const s of syms) {
        if (isUpper(s)) registerNt(s)
        else registerTerm(s)
      }
      productions.push({ lhs, rhs: syms })
    }
  })

  if (productions.length === 0) {
    if (errors.length === 0) errors.push({ line: 1, col: 1, message: 'empty grammar — add a production like "S -> a S b"' })
    return { errors }
  }

  const grammar: Grammar = {
    start: start!,
    nonterminals: ntOrder,
    terminals: termOrder,
    productions,
  }
  return { grammar, errors }
}

/** Group a grammar's productions by left-hand side, preserving nonterminal order. */
export function groupByLhs(g: Grammar): { lhs: string; rhss: string[][] }[] {
  const order = [...g.nonterminals]
  // Ensure any LHS not in nonterminals (shouldn't happen) still appears.
  for (const p of g.productions) if (!order.includes(p.lhs)) order.push(p.lhs)
  return order
    .map((lhs) => ({ lhs, rhss: bodiesOf(g, lhs) }))
    .filter((entry) => entry.rhss.length > 0)
}

/** Render one right-hand side as a string (`ε` for the empty body). */
export function showRhs(rhs: string[]): string {
  if (rhs.length === 0) return 'ε'
  // Insert spaces only when a multi-letter (minted) nonterminal would otherwise run together.
  const needsSpace = rhs.some((s) => s.length > 1)
  return needsSpace ? rhs.join(' ') : rhs.join('')
}

/** Pretty-print a grammar back into the editor's text format. */
export function prettyGrammar(g: Grammar): string {
  return groupByLhs(g)
    .map(({ lhs, rhss }) => `${lhs} -> ${rhss.map(showRhs).join(' | ')}`)
    .join('\n')
}

/** Deep-clone a grammar (productions included). */
export function cloneGrammar(g: Grammar): Grammar {
  return {
    start: g.start,
    nonterminals: [...g.nonterminals],
    terminals: [...g.terminals],
    productions: g.productions.map((p) => ({ lhs: p.lhs, rhs: [...p.rhs] })),
  }
}

/** A fresh-nonterminal-name generator that avoids any name already present in `used`. */
export function freshNamer(used: Iterable<string>) {
  const taken = new Set(used)
  return (base: string): string => {
    if (!taken.has(base)) {
      taken.add(base)
      return base
    }
    let i = 0
    // base, base1, base2, … then base' if all else fails.
    for (;;) {
      const cand = `${base}${i === 0 ? '*' : i}`
      if (!taken.has(cand)) {
        taken.add(cand)
        return cand
      }
      i++
    }
  }
}
