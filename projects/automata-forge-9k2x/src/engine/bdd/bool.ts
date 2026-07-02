// A small propositional-logic front end for the BDD explorer: a tolerant precedence-climbing parser
// (in the same spirit as the CTL / LTL parsers), a compiler from the AST into a BDD, and an
// independent truth-table evaluator used both to display the function and to cross-check the BDD.
//
// Surface syntax (both Unicode and ASCII, so the box is comfortable to type into):
//
//   ¬ ! ~            negation           ∧ & && ·        conjunction
//   ∨ | ||           disjunction        ⊕ ^ xor         exclusive or
//   → -> =>          implication        ↔ <-> <=>       bi-implication
//   ⊤ 1 true         top                ⊥ 0 false       bottom
//
// Identifiers (a lower/upper letter then alphanumerics) are propositional variables. Precedence,
// tightest first: ¬ > ∧ > ⊕ > ∨ > → > ↔ ; ∧ ∨ ⊕ associate left, → ↔ right.

export type Bool =
  | { k: 'var'; name: string }
  | { k: 'const'; val: boolean }
  | { k: 'not'; a: Bool }
  | { k: 'and'; a: Bool; b: Bool }
  | { k: 'or'; a: Bool; b: Bool }
  | { k: 'xor'; a: Bool; b: Bool }
  | { k: 'imp'; a: Bool; b: Bool }
  | { k: 'iff'; a: Bool; b: Bool }

interface ParseOk {
  ok: true
  formula: Bool
}
interface ParseErr {
  ok: false
  message: string
  pos: number
}
export type BoolParse = ParseOk | ParseErr

type Tok =
  | { t: 'lp' | 'rp' | 'not' | 'and' | 'or' | 'xor' | 'imp' | 'iff' | 'true' | 'false' | 'eof' }
  | { t: 'var'; name: string }
interface Token {
  tok: Tok
  pos: number
}

const ID_START = /[A-Za-z_]/
const ID_CONT = /[A-Za-z0-9_]/

class PErr extends Error {
  pos: number
  constructor(m: string, pos: number) {
    super(m)
    this.pos = pos
  }
}

function lex(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  const push = (t: Tok, pos: number) => out.push({ tok: t, pos })
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    const start = i
    // Multi-character ASCII operators first.
    if (src.startsWith('<->', i) || src.startsWith('<=>', i)) {
      push({ t: 'iff' }, start)
      i += 3
      continue
    }
    if (src.startsWith('->', i) || src.startsWith('=>', i)) {
      push({ t: 'imp' }, start)
      i += 2
      continue
    }
    if (src.startsWith('&&', i)) {
      push({ t: 'and' }, start)
      i += 2
      continue
    }
    if (src.startsWith('||', i)) {
      push({ t: 'or' }, start)
      i += 2
      continue
    }
    switch (c) {
      case '(':
        push({ t: 'lp' }, start)
        i++
        continue
      case ')':
        push({ t: 'rp' }, start)
        i++
        continue
      case '¬':
      case '!':
      case '~':
        push({ t: 'not' }, start)
        i++
        continue
      case '∧':
      case '&':
      case '·':
      case '*':
        push({ t: 'and' }, start)
        i++
        continue
      case '∨':
      case '|':
      case '+':
        push({ t: 'or' }, start)
        i++
        continue
      case '⊕':
      case '^':
        push({ t: 'xor' }, start)
        i++
        continue
      case '→':
        push({ t: 'imp' }, start)
        i++
        continue
      case '↔':
        push({ t: 'iff' }, start)
        i++
        continue
      case '⊤':
        push({ t: 'true' }, start)
        i++
        continue
      case '⊥':
        push({ t: 'false' }, start)
        i++
        continue
    }
    if (ID_START.test(c)) {
      let j = i + 1
      while (j < src.length && ID_CONT.test(src[j])) j++
      const name = src.slice(i, j)
      i = j
      if (name === 'true' || name === 'T') push({ t: 'true' }, start)
      else if (name === 'false' || name === 'F') push({ t: 'false' }, start)
      else if (name === 'xor') push({ t: 'xor' }, start)
      else if (name === 'and') push({ t: 'and' }, start)
      else if (name === 'or') push({ t: 'or' }, start)
      else if (name === 'not') push({ t: 'not' }, start)
      else push({ t: 'var', name }, start)
      continue
    }
    if (c === '0') {
      push({ t: 'false' }, start)
      i++
      continue
    }
    if (c === '1') {
      push({ t: 'true' }, start)
      i++
      continue
    }
    throw new PErr(`unexpected character “${c}”`, start)
  }
  out.push({ tok: { t: 'eof' }, pos: src.length })
  return out
}

/** Parse a propositional formula. Never throws — errors come back as `{ ok: false, message, pos }`. */
export function parseBool(src: string): BoolParse {
  let toks: Token[]
  try {
    toks = lex(src)
  } catch (e) {
    const pe = e as PErr
    return { ok: false, message: pe.message, pos: pe.pos }
  }
  let p = 0
  const peek = () => toks[p].tok
  const at = () => toks[p].pos
  const eat = (t: Tok['t']) => {
    if (peek().t !== t) throw new PErr(`expected ${t}`, at())
    return toks[p++]
  }

  // Precedence climb: iff (loosest) → imp → or → xor → and → not/atom (tightest).
  const parseIff = (): Bool => {
    const a = parseImp()
    if (peek().t === 'iff') {
      p++
      return { k: 'iff', a, b: parseIff() } // right assoc
    }
    return a
  }
  const parseImp = (): Bool => {
    const a = parseOr()
    if (peek().t === 'imp') {
      p++
      return { k: 'imp', a, b: parseImp() }
    }
    return a
  }
  const parseOr = (): Bool => {
    let a = parseXor()
    while (peek().t === 'or') {
      p++
      a = { k: 'or', a, b: parseXor() }
    }
    return a
  }
  const parseXor = (): Bool => {
    let a = parseAnd()
    while (peek().t === 'xor') {
      p++
      a = { k: 'xor', a, b: parseAnd() }
    }
    return a
  }
  const parseAnd = (): Bool => {
    let a = parseUnary()
    while (peek().t === 'and') {
      p++
      a = { k: 'and', a, b: parseUnary() }
    }
    return a
  }
  const parseUnary = (): Bool => {
    if (peek().t === 'not') {
      p++
      return { k: 'not', a: parseUnary() }
    }
    return parseAtom()
  }
  const parseAtom = (): Bool => {
    const tk = peek()
    switch (tk.t) {
      case 'lp': {
        p++
        const inner = parseIff()
        eat('rp')
        return inner
      }
      case 'true':
        p++
        return { k: 'const', val: true }
      case 'false':
        p++
        return { k: 'const', val: false }
      case 'var':
        p++
        return { k: 'var', name: tk.name }
      default:
        throw new PErr('expected a variable, constant or “(”', at())
    }
  }

  try {
    const formula = parseIff()
    if (peek().t !== 'eof') throw new PErr('unexpected trailing input', at())
    return { ok: true, formula }
  } catch (e) {
    const pe = e as PErr
    return { ok: false, message: pe.message, pos: pe.pos }
  }
}

/** All variable names in a formula, deduped and returned in first-appearance order. */
export function varsOf(f: Bool): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const walk = (x: Bool) => {
    switch (x.k) {
      case 'var':
        if (!seen.has(x.name)) {
          seen.add(x.name)
          out.push(x.name)
        }
        break
      case 'const':
        break
      case 'not':
        walk(x.a)
        break
      default:
        walk(x.a)
        walk(x.b)
    }
  }
  walk(f)
  return out
}

import { Bdd } from './bdd'
import type { BddId } from './bdd'

/** Compile a formula into a BDD over `manager`, mapping variable names to levels via `level`. */
export function toBdd(f: Bool, m: Bdd, level: (name: string) => number): BddId {
  switch (f.k) {
    case 'const':
      return m.constant(f.val)
    case 'var':
      return m.ithVar(level(f.name))
    case 'not':
      return m.not(toBdd(f.a, m, level))
    case 'and':
      return m.and(toBdd(f.a, m, level), toBdd(f.b, m, level))
    case 'or':
      return m.or(toBdd(f.a, m, level), toBdd(f.b, m, level))
    case 'xor':
      return m.xor(toBdd(f.a, m, level), toBdd(f.b, m, level))
    case 'imp':
      return m.imp(toBdd(f.a, m, level), toBdd(f.b, m, level))
    case 'iff':
      return m.iff(toBdd(f.a, m, level), toBdd(f.b, m, level))
  }
}

/**
 * Directly evaluate a formula under an assignment (names → bool) — the independent oracle the BDD is
 * checked against, and the source of the truth-table view.
 */
export function evalBool(f: Bool, env: (name: string) => boolean): boolean {
  switch (f.k) {
    case 'const':
      return f.val
    case 'var':
      return env(f.name)
    case 'not':
      return !evalBool(f.a, env)
    case 'and':
      return evalBool(f.a, env) && evalBool(f.b, env)
    case 'or':
      return evalBool(f.a, env) || evalBool(f.b, env)
    case 'xor':
      return evalBool(f.a, env) !== evalBool(f.b, env)
    case 'imp':
      return !evalBool(f.a, env) || evalBool(f.b, env)
    case 'iff':
      return evalBool(f.a, env) === evalBool(f.b, env)
  }
}

/** Pretty-print a Boolean formula with Unicode glyphs, parenthesising only where precedence needs it. */
export function showBool(f: Bool): string {
  const PREC: Record<Bool['k'], number> = {
    iff: 1,
    imp: 2,
    or: 3,
    xor: 4,
    and: 5,
    not: 6,
    var: 7,
    const: 7,
  }
  const GLYPH: Partial<Record<Bool['k'], string>> = {
    and: ' ∧ ',
    or: ' ∨ ',
    xor: ' ⊕ ',
    imp: ' → ',
    iff: ' ↔ ',
  }
  const rightAssoc = new Set<Bool['k']>(['imp', 'iff'])
  const go = (x: Bool, parentPrec: number): string => {
    const s = render(x)
    return PREC[x.k] < parentPrec ? `(${s})` : s // looser than the context ⇒ wrap
  }
  const render = (x: Bool): string => {
    switch (x.k) {
      case 'const':
        return x.val ? '⊤' : '⊥'
      case 'var':
        return x.name
      case 'not':
        return '¬' + go(x.a, PREC.not)
      default: {
        const p = PREC[x.k]
        const ra = rightAssoc.has(x.k)
        const l = go(x.a, ra ? p + 1 : p)
        const r = go(x.b, ra ? p : p + 1)
        return l + GLYPH[x.k] + r
      }
    }
  }
  return render(f)
}
