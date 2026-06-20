// A tiny Boolean-expression front-end for the BDD engine.
//
// Grammar (lowest to highest precedence):
//   iff   :  <-> | ==              (left associative)
//   imp   :  -> | =>               (right associative)
//   or    :  | | || | +
//   xor   :  ^
//   and   :  & | && | *
//   not   :  ! | ~  (prefix)
//   atom  :  identifier | 0 | 1 | true | false | ( … )
//
// Variables are bare identifiers; their order of first appearance becomes the
// initial BDD variable order.

import { Bdd } from './bdd'
import type { NodeId } from './bdd'

export type Expr =
  | { t: 'const'; v: boolean }
  | { t: 'var'; name: string }
  | { t: 'not'; a: Expr }
  | { t: 'and' | 'or' | 'xor' | 'imp' | 'iff'; a: Expr; b: Expr }

export class ExprError extends Error {}

type Tok =
  | { k: 'iff' }
  | { k: 'imp' }
  | { k: 'or' }
  | { k: 'xor' }
  | { k: 'and' }
  | { k: 'not' }
  | { k: 'lparen' }
  | { k: 'rparen' }
  | { k: 'const'; v: boolean }
  | { k: 'var'; name: string }

function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    // multi-char operators first
    if (src.startsWith('<->', i)) {
      toks.push({ k: 'iff' })
      i += 3
      continue
    }
    if (src.startsWith('->', i)) {
      toks.push({ k: 'imp' })
      i += 2
      continue
    }
    if (src.startsWith('=>', i)) {
      toks.push({ k: 'imp' })
      i += 2
      continue
    }
    if (src.startsWith('==', i)) {
      toks.push({ k: 'iff' })
      i += 2
      continue
    }
    if (src.startsWith('||', i)) {
      toks.push({ k: 'or' })
      i += 2
      continue
    }
    if (src.startsWith('&&', i)) {
      toks.push({ k: 'and' })
      i += 2
      continue
    }
    switch (c) {
      case '(':
        toks.push({ k: 'lparen' })
        i++
        continue
      case ')':
        toks.push({ k: 'rparen' })
        i++
        continue
      case '|':
      case '+':
        toks.push({ k: 'or' })
        i++
        continue
      case '^':
        toks.push({ k: 'xor' })
        i++
        continue
      case '&':
      case '*':
        toks.push({ k: 'and' })
        i++
        continue
      case '!':
      case '~':
        toks.push({ k: 'not' })
        i++
        continue
      case '=':
        toks.push({ k: 'iff' })
        i++
        continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++
      const word = src.slice(i, j)
      i = j
      const lower = word.toLowerCase()
      if (lower === 'true') toks.push({ k: 'const', v: true })
      else if (lower === 'false') toks.push({ k: 'const', v: false })
      else if (lower === 'and') toks.push({ k: 'and' })
      else if (lower === 'or') toks.push({ k: 'or' })
      else if (lower === 'xor') toks.push({ k: 'xor' })
      else if (lower === 'not') toks.push({ k: 'not' })
      else toks.push({ k: 'var', name: word })
      continue
    }
    if (c === '0') {
      toks.push({ k: 'const', v: false })
      i++
      continue
    }
    if (c === '1') {
      toks.push({ k: 'const', v: true })
      i++
      continue
    }
    throw new ExprError(`Unexpected character '${c}' at position ${i}`)
  }
  return toks
}

/** Parse a Boolean expression into an AST. Throws ExprError on malformed input. */
export function parseExpr(src: string): Expr {
  const toks = tokenize(src)
  let p = 0
  const peek = (): Tok | undefined => toks[p]
  const eat = (): Tok => {
    const t = toks[p]
    if (!t) throw new ExprError('Unexpected end of expression')
    p++
    return t
  }

  const parseIff = (): Expr => {
    let a = parseImp()
    while (peek()?.k === 'iff') {
      eat()
      a = { t: 'iff', a, b: parseImp() }
    }
    return a
  }
  const parseImp = (): Expr => {
    const a = parseOr()
    if (peek()?.k === 'imp') {
      eat()
      return { t: 'imp', a, b: parseImp() } // right associative
    }
    return a
  }
  const parseOr = (): Expr => {
    let a = parseXor()
    while (peek()?.k === 'or') {
      eat()
      a = { t: 'or', a, b: parseXor() }
    }
    return a
  }
  const parseXor = (): Expr => {
    let a = parseAnd()
    while (peek()?.k === 'xor') {
      eat()
      a = { t: 'xor', a, b: parseAnd() }
    }
    return a
  }
  const parseAnd = (): Expr => {
    let a = parseNot()
    while (peek()?.k === 'and') {
      eat()
      a = { t: 'and', a, b: parseNot() }
    }
    return a
  }
  const parseNot = (): Expr => {
    if (peek()?.k === 'not') {
      eat()
      return { t: 'not', a: parseNot() }
    }
    return parseAtom()
  }
  const parseAtom = (): Expr => {
    const t = eat()
    if (t.k === 'lparen') {
      const e = parseIff()
      const close = eat()
      if (close.k !== 'rparen') throw new ExprError('Expected )')
      return e
    }
    if (t.k === 'const') return { t: 'const', v: t.v }
    if (t.k === 'var') return { t: 'var', name: t.name }
    throw new ExprError(`Unexpected token '${t.k}'`)
  }

  const e = parseIff()
  if (p !== toks.length) throw new ExprError('Trailing input after expression')
  return e
}

/** Variable names in order of first appearance. */
export function exprVars(e: Expr): string[] {
  const seen: string[] = []
  const set = new Set<string>()
  const go = (x: Expr) => {
    switch (x.t) {
      case 'const':
        return
      case 'var':
        if (!set.has(x.name)) {
          set.add(x.name)
          seen.push(x.name)
        }
        return
      case 'not':
        go(x.a)
        return
      default:
        go(x.a)
        go(x.b)
    }
  }
  go(e)
  return seen
}

/** Evaluate an AST under a name→boolean assignment (a brute-force oracle). */
export function evalExpr(e: Expr, env: Map<string, boolean>): boolean {
  switch (e.t) {
    case 'const':
      return e.v
    case 'var':
      return env.get(e.name) ?? false
    case 'not':
      return !evalExpr(e.a, env)
    case 'and':
      return evalExpr(e.a, env) && evalExpr(e.b, env)
    case 'or':
      return evalExpr(e.a, env) || evalExpr(e.b, env)
    case 'xor':
      return evalExpr(e.a, env) !== evalExpr(e.b, env)
    case 'imp':
      return !evalExpr(e.a, env) || evalExpr(e.b, env)
    case 'iff':
      return evalExpr(e.a, env) === evalExpr(e.b, env)
  }
}

export interface CompiledExpr {
  bdd: Bdd
  root: NodeId
  varNames: string[]
}

/** Parse + compile an expression to a BDD over its variables (first-appearance order). */
export function compileExpr(src: string): CompiledExpr {
  const ast = parseExpr(src)
  const varNames = exprVars(ast)
  const index = new Map<string, number>()
  varNames.forEach((name, i) => index.set(name, i))
  const bdd = new Bdd(varNames.length)
  const go = (e: Expr): NodeId => {
    switch (e.t) {
      case 'const':
        return e.v ? 1 : 0
      case 'var':
        return bdd.ithVar(index.get(e.name)!)
      case 'not':
        return bdd.not(go(e.a))
      case 'and':
        return bdd.and(go(e.a), go(e.b))
      case 'or':
        return bdd.or(go(e.a), go(e.b))
      case 'xor':
        return bdd.xor(go(e.a), go(e.b))
      case 'imp':
        return bdd.implies(go(e.a), go(e.b))
      case 'iff':
        return bdd.iff(go(e.a), go(e.b))
    }
  }
  const root = go(ast)
  return { bdd, root, varNames }
}
