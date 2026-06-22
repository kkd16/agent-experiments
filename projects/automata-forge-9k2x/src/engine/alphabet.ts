// Derive a finite alphabet from a regex AST, and decide which alphabet symbols a character
// predicate matches. See the note on OTHER in types.ts for the core idea.

import type { Ast, CharPred, ClassItem, Sym } from './types'
import { OTHER } from './types'

/** Cap on how many characters a single `a-z`-style range may contribute, to stay bounded. */
const RANGE_CAP = 95

export interface Alphabet {
  /** All symbols, OTHER last. Stable order = symbol index used by the DFA tables. */
  symbols: Sym[]
  index: Map<Sym, number>
  /** True if a range had to be truncated by RANGE_CAP. */
  truncated: boolean
}

function expandRange(lo: string, hi: string, out: Set<string>): boolean {
  const a = lo.charCodeAt(0)
  const b = hi.charCodeAt(0)
  let truncated = false
  let n = 0
  for (let c = a; c <= b; c++) {
    if (n >= RANGE_CAP) {
      truncated = true
      break
    }
    out.add(String.fromCharCode(c))
    n++
  }
  return truncated
}

function collectClassChars(items: ClassItem[], out: Set<string>): boolean {
  let truncated = false
  for (const it of items) {
    if (it.kind === 'char') out.add(it.char)
    else truncated = expandRange(it.lo, it.hi, out) || truncated
  }
  return truncated
}

/** Walk the AST collecting every explicitly named character. */
export function deriveAlphabet(ast: Ast): Alphabet {
  const explicit = new Set<string>()
  let truncated = false

  const visit = (node: Ast): void => {
    switch (node.type) {
      case 'epsilon':
        break
      case 'char': {
        const p = node.pred
        if (p.kind === 'lit') explicit.add(p.char)
        else if (p.kind === 'class') truncated = collectClassChars(p.items, explicit) || truncated
        // `any` and negated classes contribute no *new* explicit symbol; they rely on OTHER.
        break
      }
      case 'concat':
        node.parts.forEach(visit)
        break
      case 'alt':
        node.options.forEach(visit)
        break
      case 'star':
      case 'plus':
      case 'opt':
        visit(node.node)
        break
    }
  }
  visit(ast)

  // Deterministic order: sort explicit chars, then OTHER.
  const symbols: Sym[] = [...explicit].sort((a, b) => a.charCodeAt(0) - b.charCodeAt(0))
  symbols.push(OTHER)
  const index = new Map<Sym, number>()
  symbols.forEach((s, i) => index.set(s, i))
  return { symbols, index, truncated }
}

/** Does a class (its raw items) contain a concrete character? */
function classContainsChar(items: ClassItem[], ch: string): boolean {
  for (const it of items) {
    if (it.kind === 'char' && it.char === ch) return true
    if (it.kind === 'range') {
      const c = ch.charCodeAt(0)
      if (c >= it.lo.charCodeAt(0) && c <= it.hi.charCodeAt(0)) return true
    }
  }
  return false
}

/**
 * Whether a predicate matches a given alphabet symbol. OTHER stands for "some character not in
 * the explicit set", so: `.` matches it, a *negated* class matches it (it's definitionally not
 * one of the listed chars), and a positive class / literal never does.
 */
export function predMatches(pred: CharPred, sym: Sym): boolean {
  if (pred.kind === 'any') return true
  if (sym === OTHER) {
    return pred.kind === 'class' && pred.neg
  }
  if (pred.kind === 'lit') return pred.char === sym
  // class
  const inSet = classContainsChar(pred.items, sym)
  return pred.neg ? !inSet : inSet
}

/** All alphabet symbols a predicate matches (used to label NFA edges). */
export function matchedSymbols(pred: CharPred, alphabet: Alphabet): Sym[] {
  return alphabet.symbols.filter((s) => predMatches(pred, s))
}

/** Map a real input character onto an alphabet symbol (unseen chars collapse to OTHER). */
export function symbolOf(ch: string, alphabet: Alphabet): Sym {
  return alphabet.index.has(ch) ? ch : OTHER
}
