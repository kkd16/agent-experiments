// Brzozowski derivatives: a second, completely different road from a regex to a DFA.
//
// The derivative ∂ₐr of a language r with respect to a symbol a is { w : aw ∈ r } — what's left to
// match after consuming a. Brzozowski gave purely syntactic rules to compute it on the regex
// itself, plus a nullability test δ(r) (does r match ε?). A DFA falls out directly: states *are*
// regexes (the residual languages), the start state is the original regex, ∂ₐ is the transition on
// a, and a state accepts iff it is nullable. The catch is keeping the state set finite — there are
// infinitely many syntactically distinct derivatives — so we normalise terms into a canonical form
// (associativity, commutativity and idempotence of union; ∅/ε folding) and key states by that form.
// With this "similarity" quotient the construction terminates and tends to land on a small DFA.

import type { Ast, Dfa, Sym } from './types'
import { showSym } from './types'
import type { Alphabet } from './alphabet'
import { matchedSymbols } from './alphabet'

export type Der =
  | { k: 'empty' } // ∅
  | { k: 'eps' } // ε
  | { k: 'sym'; s: Sym } // a single alphabet symbol
  | { k: 'cat'; xs: Der[] } // concatenation (≥ 2 factors, normalised)
  | { k: 'alt'; xs: Der[] } // union (≥ 2 alternatives, sorted + deduped)
  | { k: 'star'; a: Der }

const EMPTY: Der = { k: 'empty' }
const EPS: Der = { k: 'eps' }

/** Canonical string key — equal keys ⇒ same normalised term ⇒ the same DFA state. */
export function key(d: Der): string {
  switch (d.k) {
    case 'empty':
      return '∅'
    case 'eps':
      return 'ε'
    case 'sym':
      return 'l' + d.s
    case 'star':
      return '*(' + key(d.a) + ')'
    case 'cat':
      return '.(' + d.xs.map(key).join('·') + ')'
    case 'alt':
      return '+(' + d.xs.map(key).join('|') + ')'
  }
}

// --- smart constructors (normalising) --------------------------------------

export function sym(s: Sym): Der {
  return { k: 'sym', s }
}

/** Concatenation: flatten, absorb ∅, drop ε, collapse to ε / a single factor. */
export function cat(parts: Der[]): Der {
  const xs: Der[] = []
  for (const p of parts) {
    if (p.k === 'empty') return EMPTY
    if (p.k === 'eps') continue
    if (p.k === 'cat') xs.push(...p.xs)
    else xs.push(p)
  }
  if (xs.length === 0) return EPS
  if (xs.length === 1) return xs[0]
  return { k: 'cat', xs }
}

/** Union: flatten, drop ∅, dedup and sort by canonical key (ACI normalisation). */
export function alt(parts: Der[]): Der {
  const seen = new Map<string, Der>()
  const push = (p: Der) => {
    if (p.k === 'empty') return
    if (p.k === 'alt') {
      for (const q of p.xs) push(q)
      return
    }
    const k = key(p)
    if (!seen.has(k)) seen.set(k, p)
  }
  for (const p of parts) push(p)
  const xs = [...seen.values()].sort((a, b) => (key(a) < key(b) ? -1 : 1))
  if (xs.length === 0) return EMPTY
  if (xs.length === 1) return xs[0]
  return { k: 'alt', xs }
}

export function star(a: Der): Der {
  if (a.k === 'empty' || a.k === 'eps') return EPS
  if (a.k === 'star') return a // (r*)* = r*
  return { k: 'star', a }
}

/** δ(r): does r match the empty string? */
export function nullable(d: Der): boolean {
  switch (d.k) {
    case 'empty':
    case 'sym':
      return false
    case 'eps':
    case 'star':
      return true
    case 'cat':
      return d.xs.every(nullable)
    case 'alt':
      return d.xs.some(nullable)
  }
}

/** The Brzozowski derivative ∂ₐd. */
export function derivative(d: Der, a: Sym): Der {
  switch (d.k) {
    case 'empty':
    case 'eps':
      return EMPTY
    case 'sym':
      return d.s === a ? EPS : EMPTY
    case 'star':
      return cat([derivative(d.a, a), d]) // ∂(r*) = ∂r · r*
    case 'alt':
      return alt(d.xs.map((x) => derivative(x, a)))
    case 'cat': {
      // ∂(x·rest) = ∂x·rest  ∪  (δ(x) ? ∂rest : ∅), applied left to right.
      const head = d.xs[0]
      const rest = cat(d.xs.slice(1))
      const left = cat([derivative(head, a), rest])
      return nullable(head) ? alt([left, derivative(rest, a)]) : left
    }
  }
}

/** Convert a regex AST into a derivative term over the given alphabet. */
export function astToDer(ast: Ast, alpha: Alphabet): Der {
  switch (ast.type) {
    case 'epsilon':
      return EPS
    case 'char':
      return alt(matchedSymbols(ast.pred, alpha).map(sym))
    case 'concat':
      return cat(ast.parts.map((p) => astToDer(p, alpha)))
    case 'alt':
      return alt(ast.options.map((o) => astToDer(o, alpha)))
    case 'star':
      return star(astToDer(ast.node, alpha))
    case 'plus': {
      const r = astToDer(ast.node, alpha)
      return cat([r, star(r)])
    }
    case 'opt':
      return alt([EPS, astToDer(ast.node, alpha)])
  }
}

// --- rendering: a residual regex string for each state ----------------------
// Precedence: alt 1 < cat 2 < star 3 < atom 4.
const PREC: Record<Der['k'], number> = { alt: 1, cat: 2, star: 3, empty: 4, eps: 4, sym: 4 }

function render(d: Der, parentMin: number): string {
  const wrap = (s: string) => (PREC[d.k] < parentMin ? `(${s})` : s)
  switch (d.k) {
    case 'empty':
      return '∅'
    case 'eps':
      return 'ε'
    case 'sym':
      return showSym(d.s)
    case 'star':
      return render(d.a, 3) + '*'
    case 'cat':
      return wrap(d.xs.map((x) => render(x, 2)).join(''))
    case 'alt':
      return wrap(d.xs.map((x) => render(x, 1)).join('|'))
  }
}

export function show(d: Der): string {
  return render(d, 0)
}

export interface DerivativeDfa {
  dfa: Dfa
  /** Rendered residual regex for each state (index = state id). */
  regexes: string[]
}

/**
 * Build a DFA by Brzozowski derivatives. States are canonical derivative classes, discovered by
 * BFS from the start regex; a state accepts iff it is nullable. Returns the DFA together with the
 * residual-regex string of every state for display.
 */
export function buildDfaByDerivatives(ast: Ast, alpha: Alphabet): DerivativeDfa {
  const L = alpha.symbols.length
  const start = astToDer(ast, alpha)
  const idOf = new Map<string, number>()
  const terms: Der[] = []
  const intern = (d: Der): number => {
    const k = key(d)
    let id = idOf.get(k)
    if (id === undefined) {
      id = terms.length
      idOf.set(k, id)
      terms.push(d)
    }
    return id
  }

  const startId = intern(start)
  const trans: number[][] = []
  const order = [startId]
  for (let head = 0; head < order.length; head++) {
    const id = order[head]
    const term = terms[id]
    const row = new Array<number>(L)
    for (let c = 0; c < L; c++) {
      const before = terms.length
      const nid = intern(derivative(term, alpha.symbols[c]))
      row[c] = nid
      if (nid >= before) order.push(nid)
    }
    trans[id] = row
  }

  const accepting = new Set<number>()
  terms.forEach((t, id) => {
    if (nullable(t)) accepting.add(id)
  })

  return {
    dfa: {
      numStates: terms.length,
      start: startId,
      accepting,
      trans,
      alphabet: alpha.symbols,
    },
    regexes: terms.map(show),
  }
}
