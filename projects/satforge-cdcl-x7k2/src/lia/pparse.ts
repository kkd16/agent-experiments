// A tolerant parser for Presburger formulas — full first-order linear integer
// arithmetic with quantifiers. Grammar (loosest-binding first):
//
//   formula := iff
//   iff     := implies ( ('<->' | '↔' | 'iff') implies )*
//   implies := or      ( ('->'  | '→' | 'implies') or )*        (right-assoc)
//   or      := and     ( ('||'  | '∨' | 'or') and )*
//   and     := unary   ( ('&' | '&&' | '∧' | 'and') unary )*
//   unary   := ('!' | '~' | '¬' | 'not') unary
//            | ('forall' | '∀' | 'exists' | '∃') ident+ '.' formula
//            | atom
//   atom    := '(' formula ')' | 'true' | 'false' | divis | compare
//   divis   := NUM ('|' | '∣') expr           (NUM divides expr)
//   compare := expr REL expr                  REL ∈ <= >= < > = == != ≤ ≥ ≠
//   expr    := linear integer expression (3x, 3*x, x + 2y - 5, …)
//
// `|` is reserved for divisibility, so disjunction must be written `||`, `or`,
// or `∨` — this keeps `3 | x` unambiguous. Quantifiers bind one or more names:
// `forall x y. φ` ≡ `forall x. forall y. φ`. Free variables are collected in
// first-seen order and reported so callers can name columns and enumerate models.

import { type Lin, addConst, addScaled, zero } from './lin'
import {
  type Formula,
  T,
  F,
  andF,
  orF,
  notF,
  existsF,
  forallF,
  dvdF,
  lt,
  le,
  gt,
  ge,
  eq,
  ne,
} from './presburger'

export interface PParseOk {
  ok: true
  formula: Formula
  /** id → display name, dense from 0. */
  names: string[]
  /** Free variable ids (unbound), in first-seen order. */
  free: number[]
}
export interface PParseErr {
  ok: false
  error: string
}
export type PParseResult = PParseOk | PParseErr

type Tok =
  | { k: 'num'; v: bigint }
  | { k: 'id'; v: string }
  | { k: 'op'; v: string }

const KEYWORDS = new Set([
  'forall', 'exists', 'not', 'and', 'or', 'implies', 'iff', 'true', 'false',
])

function tokenize(s: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  const two = (a: string) => s.startsWith(a, i)
  while (i < s.length) {
    const ch = s[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }
    // multi-char operators first
    if (two('<->') || two('<=>')) { out.push({ k: 'op', v: '<->' }); i += 3; continue }
    if (two('->')) { out.push({ k: 'op', v: '->' }); i += 2; continue }
    if (two('<=')) { out.push({ k: 'op', v: '<=' }); i += 2; continue }
    if (two('>=')) { out.push({ k: 'op', v: '>=' }); i += 2; continue }
    if (two('==')) { out.push({ k: 'op', v: '=' }); i += 2; continue }
    if (two('!=')) { out.push({ k: 'op', v: '!=' }); i += 2; continue }
    if (two('&&')) { out.push({ k: 'op', v: '&' }); i += 2; continue }
    if (two('||')) { out.push({ k: 'op', v: '|' }); i += 2; continue }
    if (ch >= '0' && ch <= '9') {
      let j = i
      while (j < s.length && s[j] >= '0' && s[j] <= '9') j++
      out.push({ k: 'num', v: BigInt(s.slice(i, j)) })
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++
      out.push({ k: 'id', v: s.slice(i, j) })
      i = j
      continue
    }
    // unicode + single-char operators
    const uni: Record<string, string> = {
      '∀': 'forall', '∃': 'exists', '¬': 'not', '∧': '&', '∨': '|', '→': '->',
      '↔': '<->', '≤': '<=', '≥': '>=', '≠': '!=', '∣': '|',
    }
    if (uni[ch]) {
      const m = uni[ch]
      if (m === 'forall' || m === 'exists' || m === 'not') out.push({ k: 'id', v: m })
      else out.push({ k: 'op', v: m })
      i++
      continue
    }
    if ('+-*|&<>=.()~!'.includes(ch)) {
      out.push({ k: 'op', v: ch === '~' || ch === '!' ? 'not-op' : ch })
      i++
      continue
    }
    throw new Error(`unexpected character '${ch}'`)
  }
  return out
}

class Parser {
  toks: Tok[]
  pos = 0
  // scope stack of name→id maps (innermost last)
  scopes: Map<string, number>[] = []
  names: string[] = []
  freeReg = new Map<string, number>()
  free: number[] = []

  constructor(toks: Tok[]) {
    this.toks = toks
  }

  peek(): Tok | null {
    return this.pos < this.toks.length ? this.toks[this.pos] : null
  }
  next(): Tok {
    return this.toks[this.pos++]
  }
  isOp(v: string): boolean {
    const t = this.peek()
    return t !== null && t.k === 'op' && t.v === v
  }
  isId(v: string): boolean {
    const t = this.peek()
    return t !== null && t.k === 'id' && t.v.toLowerCase() === v
  }
  eatOp(v: string): boolean {
    if (this.isOp(v)) { this.pos++; return true }
    return false
  }

  lookupVar(name: string): number {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const id = this.scopes[i].get(name)
      if (id !== undefined) return id
    }
    // free variable
    let id = this.freeReg.get(name)
    if (id === undefined) {
      id = this.names.length
      this.names.push(name)
      this.freeReg.set(name, id)
      this.free.push(id)
    }
    return id
  }

  bindVar(name: string): number {
    const id = this.names.length
    this.names.push(name)
    return id
  }

  parseFormula(): Formula {
    return this.parseIff()
  }

  parseIff(): Formula {
    let left = this.parseImplies()
    while (this.isOp('<->') || this.isId('iff')) {
      this.next()
      const right = this.parseImplies()
      left = andF(orF(notF(left), right), orF(notF(right), left))
    }
    return left
  }

  parseImplies(): Formula {
    const left = this.parseOr()
    if (this.isOp('->') || this.isId('implies')) {
      this.next()
      const right = this.parseImplies() // right-assoc
      return orF(notF(left), right)
    }
    return left
  }

  parseOr(): Formula {
    const left = this.parseAnd()
    const xs = [left]
    while (this.isOp('|') || this.isId('or')) {
      // single '|' between formulas means disjunction ONLY when not divisibility;
      // divisibility is `NUM | expr` and is consumed inside parseAtom, so any '|'
      // reaching here is a connective.
      this.next()
      xs.push(this.parseAnd())
    }
    if (xs.length === 1) return left
    return orF(...xs)
  }

  parseAnd(): Formula {
    const left = this.parseUnary()
    const xs = [left]
    while (this.isOp('&') || this.isId('and')) {
      this.next()
      xs.push(this.parseUnary())
    }
    if (xs.length === 1) return left
    return andF(...xs)
  }

  parseUnary(): Formula {
    if (this.isOp('not-op') || this.isId('not')) {
      this.next()
      return notF(this.parseUnary())
    }
    if (this.isId('forall') || this.isId('exists')) {
      const isAll = this.isId('forall')
      this.next()
      const vars: string[] = []
      while (this.peek() && this.peek()!.k === 'id' && !KEYWORDS.has((this.peek() as { v: string }).v.toLowerCase())) {
        vars.push((this.next() as { v: string }).v)
      }
      if (vars.length === 0) throw new Error('quantifier needs at least one variable')
      if (!this.eatOp('.')) throw new Error("expected '.' after quantified variables")
      const scope = new Map<string, number>()
      const ids: number[] = []
      for (const name of vars) {
        const id = this.bindVar(name)
        scope.set(name, id)
        ids.push(id)
      }
      this.scopes.push(scope)
      const body = this.parseFormula()
      this.scopes.pop()
      let f = body
      for (let i = ids.length - 1; i >= 0; i--) f = isAll ? forallF(ids[i], f) : existsF(ids[i], f)
      return f
    }
    return this.parseAtom()
  }

  parseAtom(): Formula {
    if (this.eatOp('(')) {
      const f = this.parseFormula()
      if (!this.eatOp(')')) throw new Error("expected ')'")
      return f
    }
    if (this.isId('true')) { this.next(); return T }
    if (this.isId('false')) { this.next(); return F }

    // Divisibility:  NUM | expr   (lookahead: number then '|')
    if (this.peek()?.k === 'num' && this.toks[this.pos + 1]?.k === 'op' && this.toks[this.pos + 1].v === '|') {
      const d = (this.next() as { v: bigint }).v
      this.next() // consume '|'
      const t = this.parseExpr()
      if (d <= 0n) throw new Error('divisor must be positive')
      return dvdF(d, t)
    }

    // Comparison: expr REL expr
    const left = this.parseExpr()
    const t = this.peek()
    if (t === null || t.k !== 'op' || !['<=', '>=', '<', '>', '=', '!='].includes(t.v)) {
      throw new Error('expected a comparison operator (<=, >=, <, >, =, !=) or divisibility')
    }
    const rel = (this.next() as { v: string }).v
    const right = this.parseExpr()
    switch (rel) {
      case '<': return lt(left, right)
      case '>': return gt(left, right)
      case '<=': return le(left, right)
      case '>=': return ge(left, right)
      case '=': return eq(left, right)
      case '!=': return ne(left, right)
      default: throw new Error(`bad relation ${rel}`)
    }
  }

  // ----- linear expressions -----
  parseExpr(): Lin {
    let sign = this.readSign()
    let lin = this.readTerm(sign)
    for (;;) {
      const t = this.peek()
      if (t === null || t.k !== 'op' || (t.v !== '+' && t.v !== '-')) break
      sign = this.readSign()
      lin = addScaled(lin, this.readTerm(1n), sign)
    }
    return lin
  }

  readSign(): bigint {
    let net = 1n
    while (this.isOp('+') || this.isOp('-')) {
      if (this.isOp('-')) net = -net
      this.next()
    }
    return net
  }

  readTerm(sign: bigint): Lin {
    let coef: bigint | null = null
    if (this.peek()?.k === 'num') {
      coef = (this.next() as { v: bigint }).v
      this.eatOp('*')
    }
    if (this.peek()?.k === 'id' && !KEYWORDS.has((this.peek() as { v: string }).v.toLowerCase())) {
      const name = (this.next() as { v: string }).v
      const id = this.lookupVar(name)
      const out = zero()
      out.t.set(id, sign * (coef ?? 1n))
      return out
    }
    if (coef === null) throw new Error('expected a number or variable')
    return addConst(zero(), sign * coef)
  }
}

export function parsePresburger(text: string): PParseResult {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, error: 'empty formula' }
  let toks: Tok[]
  try {
    toks = tokenize(trimmed)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'tokenize error' }
  }
  const p = new Parser(toks)
  try {
    const formula = p.parseFormula()
    if (p.pos !== p.toks.length) {
      const t = p.toks[p.pos]
      return { ok: false, error: `unexpected trailing input near '${t.k === 'op' ? t.v : t.v.toString()}'` }
    }
    return { ok: true, formula, names: p.names, free: p.free }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'parse error' }
  }
}
