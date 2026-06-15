// A tolerant parser for a practical subset of the SMT-LIB 2 language — enough to
// write real QF_UF / QF_LRA / QF_LIA / QF_UFLIA scripts:
//
//   (set-logic QF_UF)            (declare-sort U 0)
//   (declare-const a U)          (declare-fun f (U) U)
//   (assert (= (f a) (f b)))     (check-sat)
//
// Supported terms: and or not => xor = distinct ite true false, the arithmetic
// operators + - * and comparisons <= < >= >, integer and decimal literals, and
// applications of declared functions. `=` over Bool is iff; over arithmetic
// sorts it is an arithmetic equality; otherwise an EUF equality.

import { Rational } from './rational'
import { TermManager, type Formula, type Sort, type Term } from './term'

export class SmtSyntaxError extends Error {}

// ---- s-expression tokenizer + reader ----------------------------------------
type SExpr = string | SExpr[]

function tokenize(src: string): string[] {
  const toks: string[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === ';') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (ch === '(' || ch === ')') {
      toks.push(ch)
      i++
    } else if (/\s/.test(ch)) {
      i++
    } else if (ch === '|') {
      // quoted symbol
      let j = i + 1
      while (j < src.length && src[j] !== '|') j++
      toks.push(src.slice(i, j + 1))
      i = j + 1
    } else {
      let j = i
      while (j < src.length && !/[\s()]/.test(src[j]) && src[j] !== ';') j++
      toks.push(src.slice(i, j))
      i = j
    }
  }
  return toks
}

function readSExprs(toks: string[]): SExpr[] {
  let pos = 0
  const read = (): SExpr => {
    if (pos >= toks.length) throw new SmtSyntaxError('unexpected end of input')
    const t = toks[pos++]
    if (t === '(') {
      const list: SExpr[] = []
      while (toks[pos] !== ')') {
        if (pos >= toks.length) throw new SmtSyntaxError('missing )')
        list.push(read())
      }
      pos++ // consume ')'
      return list
    }
    if (t === ')') throw new SmtSyntaxError('unexpected )')
    return t
  }
  const out: SExpr[] = []
  while (pos < toks.length) out.push(read())
  return out
}

export interface SmtScript {
  tm: TermManager
  assertions: Formula[]
  /** Expected status from (set-info :status ...), if any. */
  expected?: 'sat' | 'unsat'
}

const isSym = (e: SExpr): e is string => typeof e === 'string'

export function parseSmtLib(src: string): SmtScript {
  const tm = new TermManager()
  const assertions: Formula[] = []
  let expected: 'sat' | 'unsat' | undefined
  const forms = readSExprs(tokenize(src))

  const asSort = (e: SExpr): Sort => {
    if (!isSym(e)) throw new SmtSyntaxError('compound sorts are not supported')
    if (!tm.hasSort(e)) throw new SmtSyntaxError(`unknown sort: ${e}`)
    return e
  }

  for (const form of forms) {
    if (!Array.isArray(form) || form.length === 0) continue
    const head = form[0]
    if (!isSym(head)) throw new SmtSyntaxError('command head must be a symbol')
    switch (head) {
      case 'set-logic':
      case 'set-option':
      case 'check-sat':
      case 'get-model':
      case 'exit':
      case 'push':
      case 'pop':
        break
      case 'set-info': {
        if (form[1] === ':status' && isSym(form[2]) && (form[2] === 'sat' || form[2] === 'unsat'))
          expected = form[2]
        break
      }
      case 'declare-sort': {
        tm.declareSort(asSymbol(form[1]))
        break
      }
      case 'declare-const': {
        tm.declareFun({ name: asSymbol(form[1]), argSorts: [], retSort: asSort(form[2]) })
        break
      }
      case 'declare-fun': {
        const name = asSymbol(form[1])
        const args = (form[2] as SExpr[]) ?? []
        if (!Array.isArray(args)) throw new SmtSyntaxError('declare-fun arg list must be a list')
        tm.declareFun({ name, argSorts: args.map(asSort), retSort: asSort(form[3]) })
        break
      }
      case 'assert': {
        assertions.push(parseFormula(tm, form[1]))
        break
      }
      default:
        // Unknown command — ignore for tolerance.
        break
    }
  }
  return { tm, assertions, expected }
}

function asSymbol(e: SExpr): string {
  if (!isSym(e)) throw new SmtSyntaxError('expected a symbol')
  return e
}

// ---- term/formula parsing ----------------------------------------------------
function parseFormula(tm: TermManager, e: SExpr): Formula {
  if (isSym(e)) {
    if (e === 'true') return tm.tt
    if (e === 'false') return tm.ff
    // a Bool-sorted symbol used as an atom
    const sig = tm.getFun(e)
    if (sig && sig.argSorts.length === 0 && sig.retSort === 'Bool') return tm.pred(tm.app(e))
    throw new SmtSyntaxError(`'${e}' is not a Boolean atom`)
  }
  const head = e[0]
  if (!isSym(head)) throw new SmtSyntaxError('application head must be a symbol')
  const args = e.slice(1)
  switch (head) {
    case 'and':
      return tm.and(args.map((a) => parseFormula(tm, a)))
    case 'or':
      return tm.or(args.map((a) => parseFormula(tm, a)))
    case 'not':
      return tm.not(parseFormula(tm, args[0]))
    case '=>': {
      // right-associative chain
      const fs = args.map((a) => parseFormula(tm, a))
      let acc = fs[fs.length - 1]
      for (let i = fs.length - 2; i >= 0; i--) acc = tm.imp(fs[i], acc)
      return acc
    }
    case 'xor': {
      const fs = args.map((a) => parseFormula(tm, a))
      return fs.reduce((x, y) => tm.xor(x, y))
    }
    case 'ite':
      return tm.ite(parseFormula(tm, args[0]), parseFormula(tm, args[1]), parseFormula(tm, args[2]))
    case '=': {
      // Sort-dispatched: Bool → iff, else equality of two terms.
      const t0 = parseTermOrBool(tm, args[0])
      if (t0.kind === 'bool') {
        const fs = args.map((a) => parseFormula(tm, a))
        return chain(fs, (x, y) => tm.iff(x, y), tm)
      }
      const terms = args.map((a) => parseTerm(tm, a))
      return chainTerms(terms, (x, y) => tm.eq(x, y), tm)
    }
    case 'distinct': {
      const terms = args.map((a) => parseTerm(tm, a))
      return tm.distinct(terms)
    }
    case '<=':
    case '<':
    case '>=':
    case '>': {
      const terms = args.map((a) => parseTerm(tm, a))
      const rel = head === '<=' ? 'le' : head === '<' ? 'lt' : head === '>=' ? 'ge' : 'gt'
      // chain: a R b R c  →  (a R b) ∧ (b R c)
      const parts: Formula[] = []
      for (let i = 0; i + 1 < terms.length; i++) parts.push(tm.rel(rel, terms[i], terms[i + 1]))
      return tm.and(parts)
    }
    default: {
      // a predicate application (Bool-returning function)
      const sig = tm.getFun(head)
      if (sig && sig.retSort === 'Bool') return tm.pred(tm.app(head, args.map((a) => parseTerm(tm, a))))
      throw new SmtSyntaxError(`'${head}' is not a known predicate or connective`)
    }
  }
}

function chain(fs: Formula[], op: (a: Formula, b: Formula) => Formula, tm: TermManager): Formula {
  const parts: Formula[] = []
  for (let i = 0; i + 1 < fs.length; i++) parts.push(op(fs[i], fs[i + 1]))
  return tm.and(parts)
}
function chainTerms(ts: Term[], op: (a: Term, b: Term) => Formula, tm: TermManager): Formula {
  const parts: Formula[] = []
  for (let i = 0; i + 1 < ts.length; i++) parts.push(op(ts[i], ts[i + 1]))
  return tm.and(parts)
}

function parseTermOrBool(tm: TermManager, e: SExpr): { kind: 'bool' } | { kind: 'term'; term: Term } {
  if (isSym(e)) {
    if (e === 'true' || e === 'false') return { kind: 'bool' }
    const sig = tm.getFun(e)
    if (sig && sig.argSorts.length === 0) return sig.retSort === 'Bool' ? { kind: 'bool' } : { kind: 'term', term: tm.app(e) }
    if (/^-?\d/.test(e)) return { kind: 'term', term: parseTerm(tm, e) }
    throw new SmtSyntaxError(`unknown symbol: ${e}`)
  }
  const head = e[0]
  if (isSym(head) && ['and', 'or', 'not', '=>', 'xor', '=', 'distinct', '<=', '<', '>=', '>'].includes(head))
    return { kind: 'bool' }
  if (isSym(head)) {
    const sig = tm.getFun(head)
    if (sig && sig.retSort === 'Bool') return { kind: 'bool' }
  }
  return { kind: 'term', term: parseTerm(tm, e) }
}

function parseTerm(tm: TermManager, e: SExpr): Term {
  if (isSym(e)) {
    if (/^-?\d+$/.test(e)) return tm.num(Rational.parse(e), 'Int')
    if (/^-?\d*\.\d+$/.test(e) || /^-?\d+\.\d*$/.test(e)) return tm.num(Rational.parse(e), 'Real')
    const sig = tm.getFun(e)
    if (!sig) throw new SmtSyntaxError(`unknown symbol: ${e}`)
    if (sig.argSorts.length !== 0) throw new SmtSyntaxError(`'${e}' needs arguments`)
    return tm.app(e)
  }
  const head = e[0]
  if (!isSym(head)) throw new SmtSyntaxError('term head must be a symbol')
  const args = e.slice(1)
  switch (head) {
    case '+': {
      const ts = args.map((a) => parseTerm(tm, a))
      return ts.reduce((x, y) => tm.add(x, y))
    }
    case '-': {
      const ts = args.map((a) => parseTerm(tm, a))
      if (ts.length === 1) return tm.negTerm(ts[0])
      return ts.reduce((x, y) => tm.sub(x, y))
    }
    case '*': {
      const ts = args.map((a) => parseTerm(tm, a))
      return ts.reduce((x, y) => tm.mul(x, y))
    }
    case '/': {
      // division by a numeric literal → scale (keeps things linear)
      const ts = args.map((a) => parseTerm(tm, a))
      if (ts.length === 2 && ts[1].kind === 'num') return tm.mul(ts[0], tm.num(Rational.ONE.div(ts[1].num!), 'Real'))
      throw new SmtSyntaxError('only division by a numeric constant is supported')
    }
    default: {
      const sig = tm.getFun(head)
      if (!sig) throw new SmtSyntaxError(`unknown function: ${head}`)
      return tm.app(head, args.map((a) => parseTerm(tm, a)))
    }
  }
}
