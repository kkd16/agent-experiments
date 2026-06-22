// DFA → regular expression by the state-elimination method (GNFA / Kleene's theorem).
//
// We add a fresh start and accept state, label every edge with a regular-expression *term*,
// then rip out the original states one at a time. Eliminating state k rewrites every path
// i → k → j into a direct edge  R(i,j) ∪ R(i,k) · R(k,k)* · R(k,j).  When only the new start
// and accept remain, the single label between them is a regex for the whole language.
//
// A small term algebra with smart constructors keeps the output readable (ε/∅ are folded away,
// unions dedup trivially) instead of exploding into walls of parentheses.

import type { Dfa, Sym } from './types'
import { OTHER } from './types'

// Render a single alphabet symbol as a *regex atom* — escaping metacharacters so the
// reconstructed pattern is itself a valid, re-parseable regex (e.g. a literal '.' becomes '\.').
const META = new Set(['.', '*', '+', '?', '(', ')', '|', '[', ']', '\\'])
function regexAtom(ch: string): string {
  if (ch === OTHER) return '∗' // the "any other char" sentinel has no source-text form
  if (ch === '\n') return '\\n'
  if (ch === '\t') return '\\t'
  if (ch === '\r') return '\\r'
  if (META.has(ch)) return '\\' + ch
  return ch
}

export type Re =
  | { k: 'empty' } // ∅ — matches nothing
  | { k: 'eps' } // ε — the empty string
  | { k: 'lit'; s: string } // a single alphabet symbol, already display-formatted
  | { k: 'concat'; a: Re; b: Re }
  | { k: 'union'; a: Re; b: Re }
  | { k: 'star'; a: Re }

const EMPTY: Re = { k: 'empty' }
const EPS: Re = { k: 'eps' }

function eq(a: Re, b: Re): boolean {
  if (a.k !== b.k) return false
  switch (a.k) {
    case 'empty':
    case 'eps':
      return true
    case 'lit':
      return a.s === (b as { s: string }).s
    case 'star':
      return eq(a.a, (b as { a: Re }).a)
    case 'concat':
    case 'union': {
      const bb = b as { a: Re; b: Re }
      return eq(a.a, bb.a) && eq(a.b, bb.b)
    }
  }
}

// --- smart constructors ----------------------------------------------------
function union(a: Re, b: Re): Re {
  if (a.k === 'empty') return b
  if (b.k === 'empty') return a
  if (eq(a, b)) return a
  return { k: 'union', a, b }
}

function concat(a: Re, b: Re): Re {
  if (a.k === 'empty' || b.k === 'empty') return EMPTY
  if (a.k === 'eps') return b
  if (b.k === 'eps') return a
  return { k: 'concat', a, b }
}

function star(a: Re): Re {
  if (a.k === 'empty' || a.k === 'eps') return EPS
  if (a.k === 'star') return a // (r*)* = r*
  return { k: 'star', a }
}

// --- rendering with precedence ---------------------------------------------
// union < concat < star < atom
const PREC: Record<Re['k'], number> = { union: 1, concat: 2, star: 3, empty: 4, eps: 4, lit: 4 }

// A postfix quantifier (`*` or `?`) binds at precedence 3, like an atom's suffix.
function renderQuant(inner: Re, q: string, parentMin: number): string {
  const s = render(inner, 3) + q
  return 3 < parentMin ? `(${s})` : s
}

function render(re: Re, parentMin: number): string {
  const wrap = (s: string) => (PREC[re.k] < parentMin ? `(${s})` : s)
  switch (re.k) {
    case 'empty':
      return '∅'
    case 'eps':
      return 'ε'
    case 'lit':
      return re.s
    case 'star':
      return renderQuant(re.a, '*', parentMin)
    case 'concat':
      return wrap(render(re.a, 2) + render(re.b, 2))
    case 'union':
      // `(ε|r)` is exactly the optional `r?` — render it that way (standard and re-parseable).
      if (re.a.k === 'eps') return renderQuant(re.b, '?', parentMin)
      if (re.b.k === 'eps') return renderQuant(re.a, '?', parentMin)
      return wrap(render(re.a, 1) + '|' + render(re.b, 1))
  }
}

function litUnion(syms: Sym[]): Re {
  let re: Re = EMPTY
  for (const s of syms) re = union(re, { k: 'lit', s: regexAtom(s) })
  return re
}

/**
 * Reconstruct a regular expression from a DFA. Works on a partial DFA too (pruned dead sinks
 * just contribute no edges). Returns ∅ for the empty language and ε for {ε}.
 */
export function dfaToRegex(dfa: Dfa): string {
  const n = dfa.numStates
  const START = n
  const ACCEPT = n + 1

  // R[i][j] term, defaulting to ∅.
  const R: Re[][] = Array.from({ length: n + 2 }, () => new Array<Re>(n + 2).fill(EMPTY))

  // Merge each DFA transition into an edge label (group target -> symbols already in trans).
  for (let s = 0; s < n; s++) {
    const bySym: Map<number, Sym[]> = new Map()
    for (let c = 0; c < dfa.alphabet.length; c++) {
      const t = dfa.trans[s][c]
      if (t === undefined || t < 0) continue
      const arr = bySym.get(t)
      if (arr) arr.push(dfa.alphabet[c])
      else bySym.set(t, [dfa.alphabet[c]])
    }
    for (const [t, syms] of bySym) R[s][t] = union(R[s][t], litUnion(syms))
  }

  R[START][dfa.start] = EPS
  for (const a of dfa.accepting) R[a][ACCEPT] = union(R[a][ACCEPT], EPS)

  // Eliminate original states 0..n-1 in order.
  const present = new Set<number>([START, ACCEPT])
  for (let s = 0; s < n; s++) present.add(s)

  for (let k = 0; k < n; k++) {
    present.delete(k)
    const loop = star(R[k][k])
    for (const i of present) {
      if (eq(R[i][k], EMPTY)) continue
      for (const j of present) {
        if (eq(R[k][j], EMPTY)) continue
        R[i][j] = union(R[i][j], concat(concat(R[i][k], loop), R[k][j]))
      }
    }
  }

  return render(R[START][ACCEPT], 0)
}
