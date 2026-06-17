// The quantifier-free theory of strings (QF_S), over a *bounded* length L — added
// with ZERO new theory solvers, by *reducing* it to the EUF + linear-integer
// arithmetic the DPLL(T) engine already has. This is the project's recurring move
// (`reduceArrays`, `reduceDatatypes`): teach the solver a whole new logic as a
// sound, satisfiability-preserving rewrite so every existing theory inherits it.
//
// Why bounded? Unbounded string/word equations are undecidable in general, so a
// from-scratch *complete* solver is out of reach. The decidable, certifiable core
// is bounded-length string solving: fix a maximum length L and search for a model
// in which every string term has length ≤ L. That is exactly what this reduction
// encodes, and exactly what the independent oracle (`strref.ts`) enumerates — so
// the two agree verdict-for-verdict, and "UNSAT" means "UNSAT up to length L".
//
// The model. Every string term s is represented by
//   • its length  |s| = str.len(s)   — the user's own `str.len` symbol, reused,
//     so a length constraint is *already* a linear-integer atom; and
//   • L integer code-units  char(s,k) = str.char$(s,k)  for k ∈ [0,L), an
//     uninterpreted String×Int→Int function. Because it is uninterpreted, EUF
//     gives congruence for free (s = t ⇒ char(s,k) = char(t,k)) and Ackermann
//     already combines it with the simplex — no new machinery.
// Well-formedness pins padding past the end to a sentinel (−1) and keeps real
// code-units ≥ 0, so a string's value is *exactly* its code-units and two strings
// are equal iff their L code-units agree. Each operator is then defined by
// unfolding it over the ≤ L positions into ordinary eq / arith atoms.
//
// Soundness & completeness within the bound rest on the small-model property: the
// alphabet is constrained only up to equality, so any model relabels into a finite
// alphabet, and any length-≤L model is found by the bounded search. We therefore
// do NOT bound the alphabet in the reduction (code-units are free integers ≥ 0) —
// only the oracle bounds it, sized large enough (literal chars + every variable
// position) that it never misses a model the solver finds.

import { Rational } from './rational'
import { type Atom, type Formula, type Sort, type Term, type TermManager } from './term'
import { collectAtoms } from './reference'

export const STRING_SORT = 'String'
const CHAR_FN = 'str.char$' // internal: (String Int) -> Int — code unit at index, −1 past the end
const STR_LIT_PREFIX = 'str.lit$'
export const SENTINEL = -1
export const DEFAULT_STRING_BOUND = 6

// Fixed-arity string operations the reduction understands (str.++ etc. are folded
// to binary in the parser). `str.char$` is the internal code-unit accessor.
const STRING_FUNS: { name: string; argSorts: Sort[]; retSort: Sort }[] = [
  { name: 'str.++', argSorts: [STRING_SORT, STRING_SORT], retSort: STRING_SORT },
  { name: 'str.len', argSorts: [STRING_SORT], retSort: 'Int' },
  { name: 'str.at', argSorts: [STRING_SORT, 'Int'], retSort: STRING_SORT },
  { name: 'str.substr', argSorts: [STRING_SORT, 'Int', 'Int'], retSort: STRING_SORT },
  { name: 'str.contains', argSorts: [STRING_SORT, STRING_SORT], retSort: 'Bool' },
  { name: 'str.prefixof', argSorts: [STRING_SORT, STRING_SORT], retSort: 'Bool' },
  { name: 'str.suffixof', argSorts: [STRING_SORT, STRING_SORT], retSort: 'Bool' },
  { name: 'str.indexof', argSorts: [STRING_SORT, STRING_SORT, 'Int'], retSort: 'Int' },
  { name: CHAR_FN, argSorts: [STRING_SORT, 'Int'], retSort: 'Int' },
]

/** The Bool-returning string predicates (handled by a ⇔ biconditional, not a value term). */
const STRING_PREDS = new Set(['str.contains', 'str.prefixof', 'str.suffixof'])

/** Declare the string theory's function symbols on a term manager (idempotent). */
export function ensureStringFuns(tm: TermManager): void {
  for (const f of STRING_FUNS) if (!tm.getFun(f.name)) tm.declareFun(f)
}

// ---- string literals ---------------------------------------------------------
/** Intern a string literal as a value-carrying 0-ary `String` constant. */
export function stringLit(tm: TermManager, value: string): Term {
  const op = STR_LIT_PREFIX + encodeURIComponent(value)
  if (!tm.getFun(op)) tm.declareFun({ name: op, argSorts: [], retSort: STRING_SORT })
  return tm.app(op)
}
export function isStrLitOp(op: string): boolean {
  return op.startsWith(STR_LIT_PREFIX)
}
export function strLitValue(op: string): string {
  return decodeURIComponent(op.slice(STR_LIT_PREFIX.length))
}

// ---- term walking ------------------------------------------------------------
function visitAtomTerms(tm: TermManager, a: Atom, f: (t: Term) => void): void {
  if (a.kind === 'eq') {
    f(a.a)
    f(a.b)
  } else if (a.kind === 'pred') {
    f(a.term)
  } else {
    for (const id of a.lin.coeffs.keys()) {
      const t = tm.arithVars.get(id)
      if (t) f(t)
    }
  }
}

/** Does the formula mention any `String`-sorted term? */
export function hasStrings(tm: TermManager, root: Formula): boolean {
  let found = false
  const scan = (t: Term): void => {
    if (found) return
    if (t.sort === STRING_SORT) {
      found = true
      return
    }
    for (const a of t.args) scan(a)
  }
  for (const a of collectAtoms(root)) visitAtomTerms(tm, a, scan)
  return found
}

const big = (n: number): Rational => Rational.of(BigInt(n))

/** The effective length bound: never below the longest literal that appears. */
function effectiveBound(tm: TermManager, root: Formula, bound: number): number {
  let L = Math.max(1, bound)
  const scan = (t: Term): void => {
    for (const a of t.args) scan(a)
    if (t.sort === STRING_SORT && isStrLitOp(t.op)) L = Math.max(L, strLitValue(t.op).length)
  }
  for (const a of collectAtoms(root)) visitAtomTerms(tm, a, scan)
  return L
}

/**
 * Rewrite `root` into an equisatisfiable (within the bound) formula over EUF +
 * integer arithmetic, with the bounded string axioms made explicit. Additive: the
 * original formula is kept verbatim and the axioms are conjoined.
 */
export function reduceStrings(tm: TermManager, root: Formula, bound = DEFAULT_STRING_BOUND): Formula {
  ensureStringFuns(tm)
  const L = effectiveBound(tm, root, bound)

  // Collect every string-sorted subterm, the distinct literal characters, and the
  // Int-returning `str.indexof` terms (whose value we pin with extra axioms).
  const strTerms = new Map<number, Term>()
  const idxTerms = new Map<number, Term>()
  const litChars = new Set<string>()
  const collect = (t: Term): void => {
    for (const a of t.args) collect(a)
    if (t.sort === STRING_SORT && !strTerms.has(t.id)) {
      strTerms.set(t.id, t)
      if (isStrLitOp(t.op)) for (const c of strLitValue(t.op)) litChars.add(c)
    }
    if (t.op === 'str.indexof' && t.args.length === 3) idxTerms.set(t.id, t)
  }
  for (const a of collectAtoms(root)) visitAtomTerms(tm, a, collect)

  // Canonical small code for each literal character (0..m−1), order-stable.
  const codeOf = new Map<string, number>()
  ;[...litChars].sort().forEach((c, i) => codeOf.set(c, i))

  const N = (n: number): Term => tm.num(big(n))
  const len = (s: Term): Term => tm.app('str.len', [s])
  const ch = (s: Term, k: number): Term => tm.app(CHAR_FN, [s, N(k)])
  const aux: Formula[] = []

  // t occurs in s starting at offset k: k + |t| ≤ |s| and s[k+j] = t[j] for j < |t|.
  const occursAt = (s: Term, t: Term, k: number): Formula => {
    const parts: Formula[] = [tm.rel('le', tm.add(N(k), len(t)), len(s))]
    for (let j = 0; j < L; j++)
      if (k + j <= L - 1) parts.push(tm.imp(tm.rel('lt', N(j), len(t)), tm.eq(ch(s, k + j), ch(t, j))))
    return tm.and(parts)
  }

  // Well-formedness for every string term: 0 ≤ |s| ≤ L; in-range chars ≥ 0;
  // padding past the end = −1 (so a real char never equals padding, and equal
  // code-units across all L slots ⟺ equal strings).
  for (const s of strTerms.values()) {
    aux.push(tm.rel('ge', len(s), N(0)))
    aux.push(tm.rel('le', len(s), N(L)))
    for (let k = 0; k < L; k++) {
      aux.push(tm.imp(tm.rel('lt', N(k), len(s)), tm.rel('ge', ch(s, k), N(0))))
      aux.push(tm.imp(tm.rel('ge', N(k), len(s)), tm.eq(ch(s, k), N(SENTINEL))))
    }
  }

  // Per-operator defining axioms.
  for (const s of strTerms.values()) {
    if (isStrLitOp(s.op)) {
      const w = strLitValue(s.op)
      aux.push(tm.eq(len(s), N(w.length)))
      for (let k = 0; k < L; k++) aux.push(tm.eq(ch(s, k), N(k < w.length ? codeOf.get(w[k])! : SENTINEL)))
      continue
    }
    if (s.op === 'str.++') {
      const [a, b] = s.args
      aux.push(tm.eq(len(s), tm.add(len(a), len(b))))
      // char(s,k) = (k < |a|) ? char(a,k) : char(b, k−|a|), unfolded over |a| = la.
      for (let k = 0; k < L; k++)
        for (let la = 0; la <= L; la++) {
          const rhs = k < la ? ch(a, k) : ch(b, k - la)
          aux.push(tm.imp(tm.eq(len(a), N(la)), tm.eq(ch(s, k), rhs)))
        }
      continue
    }
    if (s.op === 'str.at') {
      const [base, i] = s.args
      aux.push(tm.imp(tm.or([tm.rel('lt', i, N(0)), tm.rel('ge', i, len(base))]), tm.eq(len(s), N(0))))
      for (let ii = 0; ii < L; ii++) {
        const guard = tm.and([tm.eq(i, N(ii)), tm.rel('lt', N(ii), len(base))])
        aux.push(tm.imp(guard, tm.and([tm.eq(len(s), N(1)), tm.eq(ch(s, 0), ch(base, ii))])))
      }
      continue
    }
    if (s.op === 'str.substr') {
      const [base, off, ln] = s.args
      aux.push(tm.imp(tm.or([tm.rel('lt', off, N(0)), tm.rel('ge', off, len(base))]), tm.eq(len(s), N(0))))
      for (let m = 0; m < L; m++) {
        const gm = tm.and([tm.eq(off, N(m)), tm.rel('lt', N(m), len(base))])
        const avail = tm.sub(len(base), N(m)) // |base| − m, ≥ 1 under gm
        // |s| = clamp(ln, 0, avail).
        aux.push(tm.imp(tm.and([gm, tm.rel('le', ln, N(0))]), tm.eq(len(s), N(0))))
        aux.push(tm.imp(tm.and([gm, tm.rel('gt', ln, N(0)), tm.rel('le', ln, avail)]), tm.eq(len(s), ln)))
        aux.push(tm.imp(tm.and([gm, tm.rel('gt', ln, avail)]), tm.eq(len(s), avail)))
        for (let j = 0; j < L; j++)
          if (m + j <= L - 1)
            aux.push(tm.imp(tm.and([gm, tm.rel('lt', N(j), len(s))]), tm.eq(ch(s, j), ch(base, m + j))))
      }
      continue
    }
  }

  // str.indexof(s, t, i): the least offset k ≥ i at which t occurs in s, or −1 if
  // none (or i is out of [0,|s|]). The result term r is pinned by a biconditional
  // per candidate value over the occurrence predicate.
  for (const r of idxTerms.values()) {
    const [s, t, i] = r.args
    const validStart = tm.and([tm.rel('ge', i, N(0)), tm.rel('le', i, len(s))])
    const occ: Formula[] = []
    for (let k = 0; k <= L; k++) occ.push(occursAt(s, t, k))
    aux.push(tm.rel('ge', r, N(SENTINEL)))
    aux.push(tm.rel('le', r, N(L)))
    for (let k = 0; k <= L; k++) {
      const before: Formula[] = []
      for (let kp = 0; kp < k; kp++) before.push(tm.imp(tm.rel('ge', N(kp), i), tm.not(occ[kp])))
      aux.push(tm.iff(tm.eq(r, N(k)), tm.and([validStart, tm.rel('ge', N(k), i), occ[k], ...before])))
    }
    const none: Formula[] = []
    for (let k = 0; k <= L; k++) none.push(tm.imp(tm.rel('ge', N(k), i), tm.not(occ[k])))
    aux.push(tm.iff(tm.eq(r, N(SENTINEL)), tm.or([tm.not(validStart), tm.and(none)])))
  }

  // String equality as *content* equality: keep the EUF atom (so functions over
  // strings still get congruence) AND tie it to position-wise code-unit agreement.
  const charEq = (a: Term, b: Term): Formula => {
    const parts: Formula[] = [tm.eq(len(a), len(b))]
    for (let k = 0; k < L; k++) parts.push(tm.eq(ch(a, k), ch(b, k)))
    return tm.and(parts)
  }
  for (const a of collectAtoms(root)) {
    if (a.kind === 'eq' && a.a.sort === STRING_SORT) aux.push(tm.iff(tm.eq(a.a, a.b), charEq(a.a, a.b)))
    if (a.kind === 'pred' && STRING_PREDS.has(a.term.op)) aux.push(definePredicate(tm, a.term, L, len, ch, N))
  }

  return aux.length ? tm.and([root, ...aux]) : root
}

/** Biconditional defining a Boolean string predicate over the bounded char model. */
function definePredicate(
  tm: TermManager,
  c: Term,
  L: number,
  len: (s: Term) => Term,
  ch: (s: Term, k: number) => Term,
  N: (n: number) => Term,
): Formula {
  const p = tm.pred(c)
  if (c.op === 'str.contains') {
    // ∃ offset k ≤ |s|−|t| with s[k+j] = t[j] for all j < |t|.
    const [s, t] = c.args
    const windows: Formula[] = []
    for (let k = 0; k <= L; k++) {
      const lenOk = tm.rel('le', tm.add(N(k), len(t)), len(s))
      const match: Formula[] = [lenOk]
      for (let j = 0; j < L; j++)
        if (k + j <= L - 1) match.push(tm.imp(tm.rel('lt', N(j), len(t)), tm.eq(ch(s, k + j), ch(t, j))))
      windows.push(tm.and(match))
    }
    return tm.iff(p, tm.or(windows))
  }
  if (c.op === 'str.prefixof') {
    // prefixof(t, s): |t| ≤ |s| and s[j] = t[j] for all j < |t|.
    const [t, s] = c.args
    const match: Formula[] = [tm.rel('le', len(t), len(s))]
    for (let j = 0; j < L; j++) match.push(tm.imp(tm.rel('lt', N(j), len(t)), tm.eq(ch(s, j), ch(t, j))))
    return tm.iff(p, tm.and(match))
  }
  // suffixof(t, s): |t| ≤ |s| and s[d+j] = t[j] for all j < |t|, with d = |s|−|t|.
  const [t, s] = c.args
  const disj: Formula[] = []
  for (let d = 0; d <= L; d++) {
    const match: Formula[] = [tm.eq(tm.sub(len(s), len(t)), N(d)), tm.rel('le', len(t), len(s))]
    for (let j = 0; j < L; j++)
      if (d + j <= L - 1) match.push(tm.imp(tm.rel('lt', N(j), len(t)), tm.eq(ch(s, d + j), ch(t, j))))
    disj.push(tm.and(match))
  }
  return tm.iff(p, tm.or(disj))
}

// ---- model reconstruction (UI display only) ----------------------------------
/**
 * Reconstruct each string *variable*'s solved text from the solver's numeric model
 * (length + code-units). Best-effort: after Ackermannization the code-unit/length
 * applications become fresh constants named after their term (`str.len(x)`,
 * `str.char$(x, 0)`), which we look up by that name. Display-only — never affects
 * a verdict, and silently skips anything it can't resolve.
 */
export function reconstructStringModel(
  tm: TermManager,
  root: Formula,
  numModel: Map<number, Rational> | undefined,
): { name: string; value: string }[] {
  if (!numModel) return []

  // String variables (0-ary String constants that are not literals).
  const vars = new Map<string, Term>()
  const litChars = new Set<string>()
  const collect = (t: Term): void => {
    for (const a of t.args) collect(a)
    if (t.sort === STRING_SORT) {
      if (isStrLitOp(t.op)) for (const c of strLitValue(t.op)) litChars.add(c)
      else if (t.kind === 'app' && t.args.length === 0) vars.set(t.op, t)
    }
  }
  for (const a of collectAtoms(root)) visitAtomTerms(tm, a, collect)

  // Invert the literal code map; fresh codes (≥ m) get readable placeholder letters.
  const sortedChars = [...litChars].sort()
  const filler = 'abcdefghijklmnopqrstuvwxyz'.split('').filter((c) => !litChars.has(c))
  const codeToChar = (code: number): string => {
    if (code >= 0 && code < sortedChars.length) return sortedChars[code]
    const idx = code - sortedChars.length
    return idx >= 0 && idx < filler.length ? filler[idx] : `\\u${code}`
  }
  const lookup = (term: Term): number | undefined => {
    const name = tm.termToString(term)
    const f = tm.getFun(name)
    if (!f) return undefined
    const v = numModel.get(tm.app(name).id)
    if (!v || v.d !== 1n) return undefined
    return Number(v.n)
  }

  const N = (n: number): Term => tm.num(big(n))
  const out: { name: string; value: string }[] = []
  for (const [name, sv] of vars) {
    const lv = lookup(tm.app('str.len', [sv]))
    if (lv === undefined || lv < 0) continue
    let str = ''
    let ok = true
    for (let k = 0; k < lv; k++) {
      const cv = lookup(tm.app(CHAR_FN, [sv, N(k)]))
      if (cv === undefined || cv < 0) {
        ok = false
        break
      }
      str += codeToChar(cv)
    }
    if (ok) out.push({ name, value: JSON.stringify(str) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
