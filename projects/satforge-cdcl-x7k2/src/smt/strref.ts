// An independent reference decision procedure for the bounded quantifier-free
// theory of strings, used ONLY by the test harness to cross-check the
// reduction-based solver (`strings.ts`). It shares NO decision logic with the
// reduction: instead of axiomatizing a code-unit model, it enumerates *concrete
// strings* (length ≤ L over a finite alphabet) and evaluates every operator with
// ordinary JavaScript string semantics (`+`, `.includes`, `.startsWith`, …). A
// formula is SAT (within the bound) iff some bounded assignment makes it true.
//
// Soundness vs. the reduction rests on the small-model property: the alphabet is
// constrained only up to equality, so the alphabet size only needs to cover the
// literal characters plus one fresh symbol per variable character position — then
// any model the (alphabet-unbounded) solver finds relabels into this finite
// alphabet, and any model found here lifts back. Every string subterm is required
// to fit in L characters (mirroring the reduction's unconditional |t| ≤ L axioms):
// an assignment under which any subterm overflows is simply not a bounded model.
//
// Scope is deliberately narrow (so the oracle stays honest and simple): string
// variables, string literals, str.++, str.at, str.substr, str.len, str.contains,
// str.prefixof, str.suffixof, and linear-integer atoms over those lengths. Free
// integer variables, user functions over strings, and anything else → `null`
// (the harness skips that instance, leaning on hand cases for those).

import { type Atom, type Formula, type Term, type TermManager } from './term'
import { collectAtoms, evalFormula } from './reference'
import { STRING_SORT, isStrLitOp, strLitValue } from './strings'

class Unsupported extends Error {}
class Overflow extends Error {}

const STRING_PREDS = new Set(['str.contains', 'str.prefixof', 'str.suffixof'])

/** Decide a bounded QF_S formula by concrete-string enumeration; null if out of scope / too large. */
export function referenceSatStrings(tm: TermManager, f: Formula, L: number, sizeCap = 3_000_000): boolean | null {
  const atoms = collectAtoms(f)

  // Gather string variables, literal characters, and every string subterm; reject
  // anything outside the supported fragment.
  const vars = new Map<string, Term>()
  const litChars = new Set<string>()
  const strTerms = new Map<number, Term>()
  let unsupported = false
  const scan = (t: Term): void => {
    for (const a of t.args) scan(a)
    if (t.sort === STRING_SORT) {
      if (!strTerms.has(t.id)) strTerms.set(t.id, t)
      if (isStrLitOp(t.op)) for (const c of strLitValue(t.op)) litChars.add(c)
      else if (t.kind === 'app' && t.args.length === 0) vars.set(t.op, t)
      else if (t.op !== 'str.++' && t.op !== 'str.at' && t.op !== 'str.substr') unsupported = true
    } else if (t.sort === 'Int') {
      const ok =
        t.kind === 'num' ||
        t.arith ||
        (t.op === 'str.len' && t.args.length === 1) ||
        (t.op === 'str.indexof' && t.args.length === 3)
      if (!ok) unsupported = true
    } else {
      unsupported = true
    }
  }
  for (const a of atoms) {
    if (a.kind === 'eq') {
      if (a.a.sort !== STRING_SORT) return null // EUF over non-string sorts is out of scope
      scan(a.a)
      scan(a.b)
    } else if (a.kind === 'pred') {
      if (!STRING_PREDS.has(a.term.op)) return null
      for (const arg of a.term.args) scan(arg)
    } else {
      for (const id of a.lin.coeffs.keys()) {
        const t = tm.arithVars.get(id)
        if (t) scan(t)
      }
    }
  }
  if (unsupported) return null

  // Finite alphabet: the literal characters plus one fresh (private-use) symbol per
  // variable character position — enough to realize any equality-distinct model.
  const literalAlphabet = [...litChars].sort()
  const fresh = vars.size * L + 1
  const alphabet = [...literalAlphabet]
  for (let i = 0; i < fresh; i++) alphabet.push(String.fromCharCode(0xe000 + i))

  // All strings of length ≤ L over the alphabet (capped).
  const pool: string[] = []
  const gen = (prefix: string): void => {
    pool.push(prefix)
    if (prefix.length < L) for (const c of alphabet) gen(prefix + c)
  }
  gen('')
  if (pool.length > 50_000) return null

  const varList = [...vars.values()]
  let total = 1
  for (let i = 0; i < varList.length; i++) {
    total *= pool.length
    if (total > sizeCap) return null
  }

  const assign = new Map<string, string>()
  const evalStr = (t: Term): string => {
    if (isStrLitOp(t.op)) return strLitValue(t.op)
    if (t.kind === 'app' && t.args.length === 0) return assign.get(t.op)!
    if (t.op === 'str.++') {
      const r = evalStr(t.args[0]) + evalStr(t.args[1])
      if (r.length > L) throw new Overflow()
      return r
    }
    if (t.op === 'str.at') {
      const s = evalStr(t.args[0])
      const i = evalInt(t.args[1])
      return i >= 0 && i < s.length ? s[i] : ''
    }
    if (t.op === 'str.substr') {
      const s = evalStr(t.args[0])
      const off = evalInt(t.args[1])
      const ln = evalInt(t.args[2])
      if (off < 0 || off >= s.length) return ''
      const end = ln <= 0 ? off : Math.min(off + ln, s.length)
      return s.slice(off, end)
    }
    throw new Unsupported()
  }
  const evalInt = (t: Term): number => {
    if (t.kind === 'num') {
      if (t.num!.d !== 1n) throw new Unsupported()
      return Number(t.num!.n)
    }
    if (t.op === 'str.len' && !t.arith) return evalStr(t.args[0]).length
    if (t.op === 'str.indexof' && !t.arith) {
      const s = evalStr(t.args[0])
      const sub = evalStr(t.args[1])
      const i = evalInt(t.args[2])
      if (i < 0 || i > s.length) return -1
      return s.indexOf(sub, i)
    }
    if (t.arith) {
      const a = t.args.map(evalInt)
      if (t.op === '+') return a.reduce((x, y) => x + y, 0)
      if (t.op === '-') return a.length === 1 ? -a[0] : a.reduce((x, y) => x - y)
      if (t.op === '*') return a.reduce((x, y) => x * y, 1)
    }
    throw new Unsupported()
  }
  const atomVal = (a: Atom): boolean => {
    if (a.kind === 'pred') {
      const c = a.term
      if (c.op === 'str.contains') return evalStr(c.args[0]).includes(evalStr(c.args[1]))
      if (c.op === 'str.prefixof') return evalStr(c.args[1]).startsWith(evalStr(c.args[0]))
      if (c.op === 'str.suffixof') return evalStr(c.args[1]).endsWith(evalStr(c.args[0]))
      throw new Unsupported()
    }
    if (a.kind === 'eq') return evalStr(a.a) === evalStr(a.b)
    // arithmetic: Σ cᵢ·xᵢ + k  {≤,<,=} 0
    if (a.lin.constant.d !== 1n) throw new Unsupported()
    let v = Number(a.lin.constant.n)
    for (const [id, c] of a.lin.coeffs) {
      if (c.d !== 1n) throw new Unsupported()
      const t = tm.arithVars.get(id)!
      v += Number(c.n) * evalInt(t)
    }
    return a.rel === 'le' ? v <= 0 : a.rel === 'lt' ? v < 0 : v === 0
  }

  const allStr = [...strTerms.values()]
  const radices = varList.map(() => pool.length)
  const digit = new Array(varList.length).fill(0)
  try {
    do {
      varList.forEach((v, i) => assign.set(v.op, pool[digit[i]]))
      try {
        // Enforce |t| ≤ L on every string subterm (mirrors the reduction's
        // unconditional length axioms); an overflow means "not a bounded model".
        for (const st of allStr) evalStr(st)
        if (evalFormula(f, atomVal)) return true
      } catch (e) {
        if (e instanceof Overflow) continue
        throw e
      }
    } while (inc(digit, radices))
  } catch (e) {
    if (e instanceof Unsupported) return null
    throw e
  }
  return false
}

/** Increment a mixed-radix odometer in place; false when it wraps to all-zero. */
function inc(digit: number[], radices: number[]): boolean {
  for (let i = 0; i < digit.length; i++) {
    digit[i]++
    if (digit[i] < radices[i]) return true
    digit[i] = 0
  }
  return false
}
