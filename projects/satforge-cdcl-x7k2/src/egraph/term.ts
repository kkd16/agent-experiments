// The term language the e-graph reasons over: a small commutative-ring
// expression grammar (integers, variables, `+`, `-`, `*`, unary `-`, and the
// arithmetic left-shift `<<`). Everything downstream — the e-graph, the
// rewriter, the extractor and the differential oracle — speaks `Term`.
//
// Subtraction and unary minus are *desugared* at parse time into a `neg` node
// (`a - b` ⇒ `a + neg b`, `-a` ⇒ `neg a`) so the core sees a clean ring over
// `{+, *, neg}` plus the `shl` strength-reduction operator. That keeps the
// rewrite rules — commutativity, associativity, distributivity — short and
// obviously sound, and it means the extractor can re-sugar on the way out.

/** A term / pattern node. Leaves have `args: []`. */
export interface Term {
  /** Operator symbol. A decimal integer literal for constants, an identifier
   *  for variables, a leading `?` for a pattern variable, otherwise one of the
   *  operators `+ * neg shl`. */
  op: string
  args: Term[]
}

export const NUM_RE = /^-?\d+$/
export const VAR_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/

export const isNum = (op: string): boolean => NUM_RE.test(op)
export const isVar = (op: string): boolean => VAR_RE.test(op)
export const isPatternVar = (op: string): boolean => op.startsWith('?')

export const num = (n: bigint | number): Term => ({ op: String(n), args: [] })
export const mkVar = (name: string): Term => ({ op: name, args: [] })

/** Structural key for a term (used for de-duplication / equality). */
export function termKey(t: Term): string {
  if (t.args.length === 0) return t.op
  return `${t.op}(${t.args.map(termKey).join(',')})`
}

export function termEqual(a: Term, b: Term): boolean {
  return termKey(a) === termKey(b)
}

/** Number of nodes in a term (its syntactic size). */
export function termSize(t: Term): number {
  return 1 + t.args.reduce((s, a) => s + termSize(a), 0)
}

/** All variable names appearing in a term, in first-seen order. */
export function freeVars(t: Term): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const walk = (n: Term) => {
    if (n.args.length === 0 && isVar(n.op)) {
      if (!seen.has(n.op)) {
        seen.add(n.op)
        out.push(n.op)
      }
    }
    n.args.forEach(walk)
  }
  walk(t)
  return out
}

// ---------------------------------------------------------------------------
// Exact evaluation (the semantic ground truth the oracle checks against).
// ---------------------------------------------------------------------------

export class EvalError extends Error {}

/**
 * Evaluate a term to an exact integer under `env`. Uses BigInt throughout, so
 * there is no floating-point slop for the oracle to trip over. Throws
 * `EvalError` for an unbound variable or a negative shift amount — the caller
 * treats such an assignment as "skip this sample".
 */
export function evalTerm(t: Term, env: Map<string, bigint>): bigint {
  if (t.args.length === 0) {
    if (isNum(t.op)) return BigInt(t.op)
    const v = env.get(t.op)
    if (v === undefined) throw new EvalError(`unbound variable ${t.op}`)
    return v
  }
  switch (t.op) {
    case '+':
      return t.args.reduce((s, a) => s + evalTerm(a, env), 0n)
    case '*':
      return t.args.reduce((p, a) => p * evalTerm(a, env), 1n)
    case 'neg':
      return -evalTerm(t.args[0], env)
    case 'shl': {
      const base = evalTerm(t.args[0], env)
      const amt = evalTerm(t.args[1], env)
      if (amt < 0n) throw new EvalError('negative shift amount')
      return base << amt
    }
    default:
      throw new EvalError(`unknown operator ${t.op}`)
  }
}

// ---------------------------------------------------------------------------
// Parser: a precedence-climbing (Pratt) parser for the surface syntax.
// ---------------------------------------------------------------------------

type Tok =
  | { k: 'num'; v: string }
  | { k: 'id'; v: string }
  | { k: 'op'; v: '+' | '-' | '*' | '<<' }
  | { k: 'lp' }
  | { k: 'rp' }

function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    if (c === '(') {
      toks.push({ k: 'lp' })
      i++
      continue
    }
    if (c === ')') {
      toks.push({ k: 'rp' })
      i++
      continue
    }
    if (c === '<' && src[i + 1] === '<') {
      toks.push({ k: 'op', v: '<<' })
      i += 2
      continue
    }
    if (c === '+' || c === '-' || c === '*') {
      toks.push({ k: 'op', v: c })
      i++
      continue
    }
    if (c >= '0' && c <= '9') {
      let j = i
      while (j < src.length && src[j] >= '0' && src[j] <= '9') j++
      toks.push({ k: 'num', v: src.slice(i, j) })
      i = j
      continue
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i
      while (j < src.length && /[a-zA-Z0-9_]/.test(src[j])) j++
      toks.push({ k: 'id', v: src.slice(i, j) })
      i = j
      continue
    }
    throw new Error(`unexpected character '${c}' at ${i}`)
  }
  return toks
}

// Binding powers. Higher binds tighter. `<<` sits between +/- and * to match C.
const INFIX_BP: Record<string, number> = { '+': 10, '-': 10, '<<': 15, '*': 20 }

/** Parse the surface syntax into a desugared `Term`. Throws on a syntax error. */
export function parseTerm(src: string): Term {
  const toks = tokenize(src)
  let pos = 0
  const peek = (): Tok | undefined => toks[pos]

  const parseAtom = (): Term => {
    const t = peek()
    if (!t) throw new Error('unexpected end of input')
    if (t.k === 'op' && t.v === '-') {
      pos++
      return { op: 'neg', args: [parseUnary()] }
    }
    if (t.k === 'op' && t.v === '+') {
      pos++
      return parseUnary()
    }
    if (t.k === 'lp') {
      pos++
      const e = parseExpr(0)
      if (peek()?.k !== 'rp') throw new Error('missing )')
      pos++
      return e
    }
    if (t.k === 'num') {
      pos++
      return { op: t.v, args: [] }
    }
    if (t.k === 'id') {
      pos++
      return { op: t.v, args: [] }
    }
    throw new Error(`unexpected token '${describe(t)}'`)
  }

  const parseUnary = (): Term => parseAtom()

  function parseExpr(minBp: number): Term {
    let left = parseUnary()
    for (;;) {
      const t = peek()
      if (!t || t.k !== 'op') break
      const bp = INFIX_BP[t.v]
      if (bp === undefined || bp < minBp) break
      pos++
      const right = parseExpr(bp + 1) // left-associative
      left = combine(t.v, left, right)
    }
    return left
  }

  const e = parseExpr(0)
  if (pos !== toks.length) throw new Error(`trailing tokens after a complete expression`)
  return e
}

function combine(op: '+' | '-' | '*' | '<<', l: Term, r: Term): Term {
  if (op === '-') return { op: '+', args: [l, { op: 'neg', args: [r] }] }
  if (op === '<<') return { op: 'shl', args: [l, r] }
  return { op, args: [l, r] }
}

function describe(t: Tok): string {
  switch (t.k) {
    case 'num':
      return t.v
    case 'id':
      return t.v
    case 'op':
      return t.v
    case 'lp':
      return '('
    case 'rp':
      return ')'
  }
}

// ---------------------------------------------------------------------------
// Pretty-printer: re-sugars neg / subtraction / shift and inserts the minimum
// parentheses implied by precedence & associativity.
// ---------------------------------------------------------------------------

// Output precedence levels (higher = binds tighter), mirroring the parser.
const PREC: Record<string, number> = { '+': 10, sub: 10, shl: 15, '*': 20, neg: 30, atom: 100 }

export function printTerm(t: Term): string {
  return pp(t, 0)
}

function pp(t: Term, parentPrec: number): string {
  const [text, prec] = render(t)
  return prec < parentPrec ? `(${text})` : text
}

function render(t: Term): [string, number] {
  if (t.args.length === 0) return [t.op, PREC.atom]
  switch (t.op) {
    case '+': {
      // Re-sugar `a + neg b` as `a - b`.
      const parts: string[] = []
      t.args.forEach((a, i) => {
        if (a.op === 'neg' && a.args.length === 1) {
          parts.push(i === 0 ? `-${pp(a.args[0], PREC.neg)}` : `- ${pp(a.args[0], PREC.sub + 1)}`)
        } else {
          parts.push(i === 0 ? pp(a, PREC['+']) : `+ ${pp(a, PREC['+'] + 1)}`)
        }
      })
      return [parts.join(' '), PREC['+']]
    }
    case '*':
      return [t.args.map((a) => pp(a, PREC['*'])).join(' * '), PREC['*']]
    case 'neg':
      return [`-${pp(t.args[0], PREC.neg)}`, PREC.neg]
    case 'shl':
      return [`${pp(t.args[0], PREC.shl)} << ${pp(t.args[1], PREC.shl + 1)}`, PREC.shl]
    default:
      return [`${t.op}(${t.args.map((a) => pp(a, 0)).join(', ')})`, PREC.atom]
  }
}
