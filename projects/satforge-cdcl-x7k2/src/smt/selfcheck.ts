// SMT correctness harness. The headline test is a brute-force cross-check:
// thousands of random ground formulas, each decided by the DPLL(T) solver and by
// an independent reference procedure (congruence enumeration for EUF,
// Fourier–Motzkin for arithmetic), asserting the verdicts always agree.
//
// Exposed as a function so the project's main selftest.ts can fold these checks
// into its assertion count.

import { TermManager, type Formula, type Term, type Atom } from './term'
import { EufSolver } from './euf'
import { solveSmt, type Theory } from './dpllt'
import { referenceSatEUF, referenceSatArith, collectAtoms, evalFormula } from './reference'
import { checkSat } from './smt'
import { Rational, R } from './rational'

export interface SmtCheckReport {
  pass: number
  fail: number
  messages: string[]
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function runSmtChecks(): SmtCheckReport {
  let pass = 0
  let fail = 0
  const messages: string[] = []
  const check = (name: string, cond: boolean, extra = '') => {
    if (cond) pass++
    else {
      fail++
      messages.push(`FAIL: ${name} ${extra}`)
    }
  }

  const eufSat = (tm: TermManager, f: Formula): boolean => {
    const euf = new EufSolver(tm)
    return solveSmt(f, [euf as unknown as Theory]).status === 'sat'
  }

  // ---- hand-written EUF sanity cases ----------------------------------------
  {
    const tm = new TermManager()
    tm.declareSort('U')
    for (const c of ['a', 'b', 'c']) tm.declareFun({ name: c, argSorts: [], retSort: 'U' })
    tm.declareFun({ name: 'f', argSorts: ['U'], retSort: 'U' })
    const a = tm.app('a')
    const b = tm.app('b')
    const c = tm.app('c')
    const fa = tm.app('f', [a])
    const fb = tm.app('f', [b])
    const fc = tm.app('f', [c])
    // a=b ∧ b=c ∧ f(a)≠f(c)  → UNSAT (congruence)
    const u = tm.and([tm.eq(a, b), tm.eq(b, c), tm.not(tm.eq(fa, fc))])
    check('EUF: transitivity+congruence is UNSAT', !eufSat(tm, u))
    // a=b ∧ f(a)≠f(b) → UNSAT
    check('EUF: congruence f(a)=f(b) forced', !eufSat(tm, tm.and([tm.eq(a, b), tm.not(tm.eq(fa, fb))])))
    // a=b ∧ f(b)=c → SAT
    check('EUF: consistent chain SAT', eufSat(tm, tm.and([tm.eq(a, b), tm.eq(fb, c)])))
    // f(f(a))=a ∧ f(f(f(a)))=a ∧ f(a)≠a → UNSAT (f(a)=a derivable)
    const ffa = tm.app('f', [fa])
    const fffa = tm.app('f', [ffa])
    check(
      'EUF: f²a=a ∧ f³a=a ⇒ fa=a, so fa≠a UNSAT',
      !eufSat(tm, tm.and([tm.eq(ffa, a), tm.eq(fffa, a), tm.not(tm.eq(fa, a))])),
    )
    void fc
  }

  // ---- predicate (uninterpreted Bool function) cases ------------------------
  {
    const tm = new TermManager()
    tm.declareSort('U')
    tm.declareFun({ name: 'a', argSorts: [], retSort: 'U' })
    tm.declareFun({ name: 'b', argSorts: [], retSort: 'U' })
    tm.declareFun({ name: 'p', argSorts: ['U'], retSort: 'Bool' })
    const a = tm.app('a')
    const b = tm.app('b')
    const pa = tm.pred(tm.app('p', [a]))
    const pb = tm.pred(tm.app('p', [b]))
    // a=b ∧ p(a) ∧ ¬p(b) → UNSAT
    check('EUF pred: a=b ∧ p(a) ∧ ¬p(b) UNSAT', !eufSat(tm, tm.and([tm.eq(a, b), pa, tm.not(pb)])))
    // a=b ∧ p(a) ∧ p(b) → SAT
    check('EUF pred: a=b ∧ p(a) ∧ p(b) SAT', eufSat(tm, tm.and([tm.eq(a, b), pa, pb])))
  }

  // ---- random EUF cross-check vs congruence enumeration ---------------------
  {
    const rng = mulberry32(0xc0ffee)
    let mism = 0
    let unsatSeen = 0
    const N = 3000
    for (let i = 0; i < N; i++) {
      const tm = new TermManager()
      tm.declareSort('U')
      const consts = ['a', 'b', 'c']
      for (const c of consts) tm.declareFun({ name: c, argSorts: [], retSort: 'U' })
      tm.declareFun({ name: 'f', argSorts: ['U'], retSort: 'U' })
      // build a small term pool (keep subterm count ≤ ~7 for the reference)
      const pool: Term[] = consts.map((c) => tm.app(c))
      const extra = 1 + Math.floor(rng() * 2)
      for (let k = 0; k < extra; k++) {
        const t = pool[Math.floor(rng() * pool.length)]
        pool.push(tm.app('f', [t]))
      }
      // random formula: 2–4 eq atoms combined with and/or/not
      const numAtoms = 2 + Math.floor(rng() * 3)
      const lits: Formula[] = []
      for (let k = 0; k < numAtoms; k++) {
        const x = pool[Math.floor(rng() * pool.length)]
        const y = pool[Math.floor(rng() * pool.length)]
        let atom: Formula = tm.eq(x, y)
        if (rng() < 0.5) atom = tm.not(atom)
        lits.push(atom)
      }
      const f = rng() < 0.6 ? tm.and(lits) : tm.or(lits)
      const got = eufSat(tm, f)
      const want = referenceSatEUF(f)
      if (got !== want) {
        mism++
        if (mism <= 3) messages.push(`  EUF mismatch: got ${got}, want ${want}`)
      }
      if (!want) unsatSeen++
    }
    check(`EUF: ${N} random formulas match congruence-enumeration reference`, mism === 0, `mismatches=${mism}`)
    check('EUF: random suite exercised some UNSAT instances', unsatSeen > N / 20, `unsat=${unsatSeen}`)
  }

  // ---- hand-written linear real arithmetic ----------------------------------
  {
    const tm = new TermManager()
    for (const v of ['x', 'y', 'z']) tm.declareFun({ name: v, argSorts: [], retSort: 'Real' })
    const x = tm.app('x')
    const y = tm.app('y')
    const z = tm.app('z')
    const n = (k: number) => tm.num(R(k), 'Real')
    const arSat = (f: Formula) => checkSat(tm, f).status === 'sat'
    // x < y ∧ y < z ∧ z < x → UNSAT
    check('LRA: x<y ∧ y<z ∧ z<x UNSAT', !arSat(tm.and([tm.rel('lt', x, y), tm.rel('lt', y, z), tm.rel('lt', z, x)])))
    // x ≤ y ∧ y ≤ x ∧ x ≠ y → UNSAT
    check('LRA: x≤y ∧ y≤x ∧ x≠y UNSAT', !arSat(tm.and([tm.rel('le', x, y), tm.rel('le', y, x), tm.not(tm.eq(x, y))])))
    // 2x + 3y = 6 ∧ x = 0 → SAT (y=2)
    const lhs = tm.add(tm.mul(n(2), x), tm.mul(n(3), y))
    check('LRA: 2x+3y=6 ∧ x=0 SAT', arSat(tm.and([tm.eq(lhs, n(6)), tm.eq(x, n(0))])))
    // x > 0 ∧ x < 1 → SAT over reals (e.g. 1/2)
    check('LRA: 0<x<1 SAT over ℝ', arSat(tm.and([tm.rel('gt', x, n(0)), tm.rel('lt', x, n(1))])))
    // x ≥ 1 ∧ x ≤ 1 ∧ x ≠ 1 → UNSAT
    check('LRA: 1≤x≤1 ∧ x≠1 UNSAT', !arSat(tm.and([tm.rel('ge', x, n(1)), tm.rel('le', x, n(1)), tm.not(tm.eq(x, n(1)))])))
  }

  // ---- hand-written integer arithmetic (LIA) ---------------------------------
  {
    const tm = new TermManager()
    for (const v of ['x', 'y']) tm.declareFun({ name: v, argSorts: [], retSort: 'Int' })
    const x = tm.app('x')
    const y = tm.app('y')
    const n = (k: number) => tm.num(R(k), 'Int')
    const arSat = (f: Formula) => checkSat(tm, f).status === 'sat'
    // 0 < x < 1 over integers → UNSAT
    check('LIA: 0<x<1 UNSAT over ℤ', !arSat(tm.and([tm.rel('gt', x, n(0)), tm.rel('lt', x, n(1))])))
    // 2x = 1 over integers → UNSAT
    check('LIA: 2x=1 UNSAT over ℤ', !arSat(tm.eq(tm.mul(n(2), x), n(1))))
    // x + y = 3 ∧ 0 ≤ x ≤ 3 ∧ 0 ≤ y ≤ 3 → SAT
    check(
      'LIA: x+y=3 with bounds SAT',
      arSat(
        tm.and([
          tm.eq(tm.add(x, y), n(3)),
          tm.rel('ge', x, n(0)),
          tm.rel('le', x, n(3)),
          tm.rel('ge', y, n(0)),
          tm.rel('le', y, n(3)),
        ]),
      ),
    )
  }

  // ---- random LRA cross-check vs Fourier–Motzkin ----------------------------
  {
    const rng = mulberry32(0x1234abcd)
    let mism = 0
    let unsatSeen = 0
    const N = 2500
    for (let i = 0; i < N; i++) {
      const tm = new TermManager()
      const vnames = ['x', 'y', 'z']
      for (const v of vnames) tm.declareFun({ name: v, argSorts: [], retSort: 'Real' })
      const vars = vnames.map((v) => tm.app(v))
      const n = (k: number) => tm.num(R(k), 'Real')
      const mkAtom = (): Formula => {
        // random linear combination over 1–2 vars with small coeffs
        const k = 1 + Math.floor(rng() * 2)
        let lhs: Term | null = null
        const used = new Set<number>()
        for (let j = 0; j < k; j++) {
          const vi = Math.floor(rng() * vars.length)
          if (used.has(vi)) continue
          used.add(vi)
          const coeff = Math.floor(rng() * 5) - 2 // [-2,2]
          const term = tm.mul(n(coeff), vars[vi])
          lhs = lhs ? tm.add(lhs, term) : term
        }
        if (!lhs) lhs = tm.mul(n(1), vars[0])
        const rhs = n(Math.floor(rng() * 7) - 3)
        const rels = ['le', 'lt', 'ge', 'gt'] as const
        if (rng() < 0.25) return tm.eq(lhs, rhs)
        return tm.rel(rels[Math.floor(rng() * rels.length)], lhs, rhs)
      }
      const numAtoms = 2 + Math.floor(rng() * 3)
      const lits: Formula[] = []
      for (let j = 0; j < numAtoms; j++) {
        let at = mkAtom()
        if (rng() < 0.4) at = tm.not(at)
        lits.push(at)
      }
      const f = rng() < 0.6 ? tm.and(lits) : tm.or(lits)
      const r = checkSat(tm, f)
      if (r.status === 'unknown') continue
      const got = r.status === 'sat'
      const want = referenceSatArith(f)
      if (got !== want) {
        mism++
        if (mism <= 4) messages.push(`  LRA mismatch: got ${got}, want ${want}`)
      }
      if (!want) unsatSeen++
    }
    check(`LRA: ${N} random formulas match Fourier–Motzkin reference`, mism === 0, `mismatches=${mism}`)
    check('LRA: random suite exercised some UNSAT instances', unsatSeen > N / 20, `unsat=${unsatSeen}`)
  }

  void Rational
  void ((): Atom | undefined => undefined)
  void collectAtoms
  void evalFormula
  return { pass, fail, messages }
}
