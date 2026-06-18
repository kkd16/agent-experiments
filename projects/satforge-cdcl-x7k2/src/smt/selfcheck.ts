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
import { checkSat, smtUnsatCore } from './smt'
import { optimize, maxsmt, type MaxSmtSoft } from './omt'
import { referenceSatArrays } from './arrayref'
import { referenceSatDatatypes } from './dtref'
import { referenceSatStrings } from './strref'
import { ensureStringFuns, stringLit } from './strings'
import { testerName, type DtSort } from './term'
import { parseSmtLib } from './parse'
import { ackermannize } from './ackermann'
import { SMT_EXAMPLES } from './examples'
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

  // ---- SMT-LIB parser ---------------------------------------------------------
  {
    const solveScript = (src: string) => {
      const s = parseSmtLib(src)
      return checkSat(s.tm, s.tm.and(s.assertions))
    }
    check(
      'parse: QF_UF unsat script',
      solveScript(`(declare-sort U 0)(declare-fun a () U)(declare-fun b () U)(declare-fun f (U) U)
        (assert (= a b)) (assert (not (= (f a) (f b)))) (check-sat)`).status === 'unsat',
    )
    check(
      'parse: QF_LRA sat script',
      solveScript(`(declare-const x Real)(declare-const y Real)
        (assert (< x y)) (assert (< y (+ x 1))) (check-sat)`).status === 'sat',
    )
    check(
      'parse: QF_LIA unsat (0<x<1 over Int)',
      solveScript(`(declare-const x Int) (assert (> x 0)) (assert (< x 1)) (check-sat)`).status === 'unsat',
    )
    check(
      'parse: distinct + arithmetic',
      solveScript(`(declare-const x Int)(declare-const y Int)(declare-const z Int)
        (assert (distinct x y z)) (assert (<= 0 x)) (assert (<= x 1))
        (assert (<= 0 y)) (assert (<= y 1)) (assert (<= 0 z)) (assert (<= z 1)) (check-sat)`).status === 'unsat',
    )
  }

  // ---- mixed UF + arithmetic (Ackermann combination) -------------------------
  {
    const tm = new TermManager()
    for (const v of ['x', 'y']) tm.declareFun({ name: v, argSorts: [], retSort: 'Real' })
    tm.declareFun({ name: 'f', argSorts: ['Real'], retSort: 'Real' })
    const x = tm.app('x')
    const y = tm.app('y')
    const fx = tm.app('f', [x])
    const fy = tm.app('f', [y])
    const n = (k: number) => tm.num(R(k), 'Real')
    const sat = (f: Formula) => checkSat(tm, f).status === 'sat'
    // x = y ∧ f(x) ≠ f(y) → UNSAT (congruence through arithmetic equality)
    check('UFLRA: x=y ∧ f(x)≠f(y) UNSAT', !sat(tm.and([tm.eq(x, y), tm.not(tm.eq(fx, fy))])))
    // x ≤ y ∧ y ≤ x ∧ f(x) ≠ f(y) → UNSAT (x=y derived from arithmetic)
    check(
      'UFLRA: x≤y ∧ y≤x ∧ f(x)≠f(y) UNSAT',
      !sat(tm.and([tm.rel('le', x, y), tm.rel('le', y, x), tm.not(tm.eq(fx, fy))])),
    )
    // f(x) > 0 ∧ f(y) < 0 ∧ x = y → UNSAT
    check(
      'UFLRA: f(x)>0 ∧ f(y)<0 ∧ x=y UNSAT',
      !sat(tm.and([tm.rel('gt', fx, n(0)), tm.rel('lt', fy, n(0)), tm.eq(x, y)])),
    )
    // x = y ∧ f(x) = f(y) → SAT (consistent)
    check('UFLRA: x=y ∧ f(x)=f(y) SAT', sat(tm.and([tm.eq(x, y), tm.eq(fx, fy)])))
    // f(x) ≠ f(y) ∧ x < y → SAT (x≠y allowed)
    check('UFLRA: f(x)≠f(y) ∧ x<y SAT', sat(tm.and([tm.not(tm.eq(fx, fy)), tm.rel('lt', x, y)])))
  }

  // ---- random mixed UFLRA cross-check vs FM on the Ackermann reduction -------
  {
    const rng = mulberry32(0x9e3a17)
    let mism = 0
    const N = 1200
    for (let i = 0; i < N; i++) {
      const tm = new TermManager()
      const vnames = ['x', 'y', 'z']
      for (const v of vnames) tm.declareFun({ name: v, argSorts: [], retSort: 'Real' })
      tm.declareFun({ name: 'f', argSorts: ['Real'], retSort: 'Real' })
      const vars = vnames.map((v) => tm.app(v))
      const fapps = vars.map((v) => tm.app('f', [v]))
      const pool = [...vars, ...fapps]
      const n = (k: number) => tm.num(R(k), 'Real')
      const lits: Formula[] = []
      const numAtoms = 2 + Math.floor(rng() * 3)
      for (let j = 0; j < numAtoms; j++) {
        const a = pool[Math.floor(rng() * pool.length)]
        let atom: Formula
        if (rng() < 0.5) {
          const b = pool[Math.floor(rng() * pool.length)]
          atom = tm.eq(a, b)
        } else {
          const rels = ['le', 'lt', 'ge', 'gt'] as const
          atom = tm.rel(rels[Math.floor(rng() * rels.length)], a, n(Math.floor(rng() * 5) - 2))
        }
        if (rng() < 0.4) atom = tm.not(atom)
        lits.push(atom)
      }
      const f = rng() < 0.6 ? tm.and(lits) : tm.or(lits)
      const r = checkSat(tm, f)
      if (r.status === 'unknown') continue
      const got = r.status === 'sat'
      // Independent reference: decide the Ackermann reduction (pure arithmetic) by FM.
      const want = referenceSatArith(ackermannize(tm, f))
      if (got !== want) {
        mism++
        if (mism <= 4) messages.push(`  UFLRA mismatch: got ${got}, want ${want}`)
      }
    }
    check(`UFLRA: ${N} random mixed formulas match the Ackermann+FM reference`, mism === 0, `mismatches=${mism}`)
  }

  // ---- every shipped example decides to its expected verdict -----------------
  {
    let bad = 0
    for (const ex of SMT_EXAMPLES) {
      const s = parseSmtLib(ex.src)
      const r = checkSat(s.tm, s.tm.and(s.assertions))
      if (r.status !== ex.expected) {
        bad++
        messages.push(`  example "${ex.name}": got ${r.status}, expected ${ex.expected}`)
      }
    }
    check('examples: all shipped SMT examples match expected verdict', bad === 0, `bad=${bad}`)
  }

  // ---- SMT unsat core is genuinely minimal ----------------------------------
  {
    // x ≤ y ∧ y ≤ z ∧ z < x  is UNSAT; the (irrelevant) extra assertion w ≥ 0
    // must NOT be in the core, and the core must itself be UNSAT and minimal.
    const tm = new TermManager()
    for (const v of ['x', 'y', 'z', 'w']) tm.declareFun({ name: v, argSorts: [], retSort: 'Real' })
    const [x, y, z, w] = ['x', 'y', 'z', 'w'].map((v) => tm.app(v))
    const asserts = [
      tm.rel('le', x, y),
      tm.rel('le', y, z),
      tm.rel('lt', z, x),
      tm.rel('ge', w, tm.num(R(0), 'Real')),
    ]
    const core = smtUnsatCore(tm, asserts)
    const coreF = core.map((i) => asserts[i])
    const coreUnsat = checkSat(tm, tm.and(coreF)).status === 'unsat'
    let minimal = coreF.length > 0
    for (let i = 0; i < coreF.length; i++) {
      const without = coreF.filter((_, j) => j !== i)
      if (checkSat(tm, tm.and(without)).status === 'unsat') minimal = false
    }
    check('SMT core: is itself UNSAT', coreUnsat)
    check('SMT core: is minimal (drop any → SAT)', minimal, `size=${coreF.length}`)
    check('SMT core: excludes the irrelevant assertion', core.length === 3)
  }

  // ---- theory of arrays: hand-written cases ---------------------------------
  {
    const tm = new TermManager()
    tm.declareSort('Idx')
    tm.declareSort('Elem')
    const A = tm.arraySort('Idx', 'Elem')
    for (const c of ['a', 'b']) tm.declareFun({ name: c, argSorts: [], retSort: A })
    for (const c of ['i', 'j']) tm.declareFun({ name: c, argSorts: [], retSort: 'Idx' })
    for (const c of ['v', 'w']) tm.declareFun({ name: c, argSorts: [], retSort: 'Elem' })
    const [a, b, i, j, v, w] = ['a', 'b', 'i', 'j', 'v', 'w'].map((s) => tm.app(s))
    const sel = (ar: Term, ix: Term) => tm.select(ar, ix)
    const st = (ar: Term, ix: Term, val: Term) => tm.store(ar, ix, val)
    const aSat = (f: Formula) => checkSat(tm, f).status === 'sat'

    // Read-over-write 1: reading a freshly written cell yields the written value.
    check('Array RoW1: select(store(a,i,v),i)=v consistent', aSat(tm.eq(sel(st(a, i, v), i), v)))
    check('Array RoW1: ≠ is UNSAT', !aSat(tm.not(tm.eq(sel(st(a, i, v), i), v))))
    // Read-over-write 2: a write at i is invisible at a different index j.
    check(
      'Array RoW2: i≠j ⇒ select(store(a,i,v),j)=select(a,j)',
      !aSat(tm.and([tm.not(tm.eq(i, j)), tm.not(tm.eq(sel(st(a, i, v), j), sel(a, j)))])),
    )
    // The last write wins.
    check('Array: last write wins', !aSat(tm.not(tm.eq(sel(st(st(a, i, v), i, w), i), w))))
    // Extensionality, positive direction (via congruence): a=b ⇒ reads agree.
    check('Array ext: a=b ⇒ select(a,i)=select(b,i)', !aSat(tm.and([tm.eq(a, b), tm.not(tm.eq(sel(a, i), sel(b, i)))])))
    // store(a,i,v)=a forces select(a,i)=v.
    check('Array ext: store(a,i,v)=a ⇒ select(a,i)=v', !aSat(tm.and([tm.eq(st(a, i, v), a), tm.not(tm.eq(sel(a, i), v))])))
    // Distinct arrays are satisfiable — a witness index where they differ exists.
    check('Array ext: a≠b is SAT', aSat(tm.not(tm.eq(a, b))))
    // Writing the value already there is a no-op: store(a,i,select(a,i)) = a.
    check('Array: idempotent write store(a,i,a[i])=a', aSat(tm.eq(st(a, i, sel(a, i)), a)))
    check('Array: idempotent write ≠ a is UNSAT', !aSat(tm.not(tm.eq(st(a, i, sel(a, i)), a))))
    // Commuting independent writes: i≠j ⇒ store(store(a,i,v),j,w)=store(store(a,j,w),i,v).
    check(
      'Array: independent writes commute (i≠j)',
      !aSat(tm.and([tm.not(tm.eq(i, j)), tm.not(tm.eq(st(st(a, i, v), j, w), st(st(a, j, w), i, v)))])),
    )
    // Constant arrays: every cell reads back the constant value.
    const cv = tm.constArray(A, v)
    check('Array const: select(const(v), i) = v', !aSat(tm.not(tm.eq(sel(cv, i), v))))
    check('Array const: two reads of a const array agree', !aSat(tm.not(tm.eq(sel(cv, i), sel(cv, j)))))
    // store(const(v), i, w) ≠ const(v) requires v ≠ w somewhere — SAT, and writing v is a no-op.
    check('Array const: store(const(v),i,v) = const(v)', !aSat(tm.not(tm.eq(st(cv, i, v), cv))))
  }

  // ---- arrays + integer arithmetic (QF_ALIA) --------------------------------
  {
    const tm = new TermManager()
    const A = tm.arraySort('Int', 'Int')
    tm.declareFun({ name: 'a', argSorts: [], retSort: A })
    for (const c of ['i', 'j']) tm.declareFun({ name: c, argSorts: [], retSort: 'Int' })
    const a = tm.app('a')
    const i = tm.app('i')
    const j = tm.app('j')
    const n = (k: number) => tm.num(R(k), 'Int')
    const aSat = (f: Formula) => checkSat(tm, f).status === 'sat'
    // i=j ∧ select(store(a,i,5),j) ≠ 5 → UNSAT (index equality drives read-over-write).
    check(
      'QF_ALIA: i=j ⇒ select(store(a,i,5),j)=5',
      !aSat(tm.and([tm.eq(i, j), tm.not(tm.eq(tm.select(tm.store(a, i, n(5)), j), n(5)))])),
    )
    // select(a,i) used arithmetically: store, then read, then compare.
    check(
      'QF_ALIA: write 7 then the cell is > 6',
      aSat(tm.rel('gt', tm.select(tm.store(a, i, n(7)), i), n(6))),
    )
    check(
      'QF_ALIA: write 7 then claiming the cell < 7 is UNSAT',
      !aSat(tm.rel('lt', tm.select(tm.store(a, i, n(7)), i), n(7))),
    )
  }

  // ---- SMT-LIB array parser --------------------------------------------------
  {
    const solveScript = (src: string) => {
      const s = parseSmtLib(src)
      return checkSat(s.tm, s.tm.and(s.assertions))
    }
    check(
      'parse: QF_AX read-over-write unsat',
      solveScript(`(declare-sort I 0)(declare-sort E 0)
        (declare-const a (Array I E))(declare-const i I)(declare-const v E)
        (assert (not (= (select (store a i v) i) v))) (check-sat)`).status === 'unsat',
    )
    check(
      'parse: QF_AX extensionality unsat',
      solveScript(`(declare-sort I 0)(declare-sort E 0)
        (declare-const a (Array I E))(declare-const b (Array I E))(declare-const i I)
        (assert (= a b)) (assert (not (= (select a i) (select b i)))) (check-sat)`).status === 'unsat',
    )
    check(
      'parse: QF_ALIA read-over-write sat',
      solveScript(`(declare-const a (Array Int Int))(declare-const i Int)
        (assert (= (select (store a i 9) i) 9)) (check-sat)`).status === 'sat',
    )
  }

  // ---- random QF_AX cross-check vs finite-model enumeration ------------------
  // Two batches: a NON-EXTENSIONAL batch (no array equalities — the fragment the
  // reduction decides on EUF alone) and an EXTENSIONAL batch (array =/distinct,
  // exercising the witness + agreement instantiation).
  const arrayBatch = (label: string, seed: number, N: number, extensional: boolean) => {
    const rng = mulberry32(seed)
    let mism = 0
    let decided = 0
    let unsatSeen = 0
    for (let it = 0; it < N; it++) {
      const tm = new TermManager()
      tm.declareSort('I')
      tm.declareSort('E')
      const A = tm.arraySort('I', 'E')
      const arrNames = ['a', 'b']
      for (const c of arrNames) tm.declareFun({ name: c, argSorts: [], retSort: A })
      const idxNames = ['i', 'j']
      for (const c of idxNames) tm.declareFun({ name: c, argSorts: [], retSort: 'I' })
      const elemNames = ['u', 'v']
      for (const c of elemNames) tm.declareFun({ name: c, argSorts: [], retSort: 'E' })
      const arrs = arrNames.map((c) => tm.app(c))
      const idxs = idxNames.map((c) => tm.app(c))
      const elems = elemNames.map((c) => tm.app(c))
      const pick = <T,>(xs: T[]) => xs[Math.floor(rng() * xs.length)]

      // Build a small array term (depth ≤ 2): a variable, a constant array, or a
      // store of one.
      const mkArray = (depth: number): Term => {
        const r = rng()
        if (r < 0.12) return tm.constArray(A, pick(elems))
        if (depth <= 0 || r < 0.5) return pick(arrs)
        return tm.store(mkArray(depth - 1), pick(idxs), mkElem(0))
      }
      // Build an element term: a constant or a select.
      const mkElem = (depth: number): Term => {
        if (depth <= 0 || rng() < 0.5) return pick(elems)
        return tm.select(mkArray(1), pick(idxs))
      }
      const mkAtom = (): Formula => {
        const r = rng()
        if (extensional && r < 0.3) return tm.eq(mkArray(1), mkArray(1)) // array equality
        if (r < 0.6) return tm.eq(mkElem(1), mkElem(1)) // element equality
        return tm.eq(pick(idxs), pick(idxs)) // index equality
      }
      const numAtoms = 2 + Math.floor(rng() * 2)
      const lits: Formula[] = []
      for (let k = 0; k < numAtoms; k++) {
        let at = mkAtom()
        if (rng() < 0.45) at = tm.not(at)
        lits.push(at)
      }
      const f = rng() < 0.6 ? tm.and(lits) : tm.or(lits)
      const want = referenceSatArrays(f, 'I', 'E', 900_000)
      if (want === null) continue // enumeration too large / out of scope — skip
      decided++
      const got = checkSat(tm, f).status === 'sat'
      if (got !== want) {
        mism++
        if (mism <= 4) messages.push(`  ${label} mismatch: got ${got}, want ${want}`)
      }
      if (!want) unsatSeen++
    }
    check(`Array (${label}): ${decided} random formulas match finite-model reference`, mism === 0, `mismatches=${mism}`)
    check(`Array (${label}): suite exercised some UNSAT instances`, unsatSeen > decided / 25, `unsat=${unsatSeen}`)
  }
  arrayBatch('non-extensional', 0xa17a, 2500, false)
  arrayBatch('extensional', 0xb33f, 1200, true)

  // ---- theory of datatypes (QF_DT): hand-written cases -----------------------
  {
    // Lst = nil | cons(head: Elem, tail: Lst) over an uninterpreted Elem sort.
    const tm = new TermManager()
    tm.declareSort('Elem')
    const Lst: DtSort = {
      name: 'Lst',
      ctors: [
        { name: 'nil', tester: testerName('nil'), selectors: [] },
        {
          name: 'cons',
          tester: testerName('cons'),
          selectors: [
            { name: 'head', sort: 'Elem' },
            { name: 'tail', sort: 'Lst' },
          ],
        },
      ],
    }
    tm.declareDatatypes([Lst])
    for (const c of ['x', 'y']) tm.declareFun({ name: c, argSorts: [], retSort: 'Lst' })
    for (const c of ['a', 'b']) tm.declareFun({ name: c, argSorts: [], retSort: 'Elem' })
    const [x, y] = ['x', 'y'].map((s) => tm.app(s))
    const [a, b] = ['a', 'b'].map((s) => tm.app(s))
    const nil = tm.app('nil')
    const cons = (h: Term, t: Term) => tm.app('cons', [h, t])
    const isC = (ctor: string, t: Term) => tm.pred(tm.app(testerName(ctor), [t]))
    const head = (t: Term) => tm.app('head', [t])
    const tail = (t: Term) => tm.app('tail', [t])
    const sat = (f: Formula) => checkSat(tm, f).status === 'sat'

    // Constructor read-back + injectivity.
    check('DT: select head(cons(a,nil))=a', !sat(tm.not(tm.eq(head(cons(a, nil)), a))))
    check('DT: select tail(cons(a,nil))=nil', !sat(tm.not(tm.eq(tail(cons(a, nil)), nil))))
    check('DT: injectivity heads — cons(a,x)=cons(b,x) ∧ a≠b UNSAT', !sat(tm.and([tm.eq(cons(a, x), cons(b, x)), tm.not(tm.eq(a, b))])))
    check('DT: injectivity tails — cons(a,x)=cons(a,y) ∧ x≠y UNSAT', !sat(tm.and([tm.eq(cons(a, x), cons(a, y)), tm.not(tm.eq(x, y))])))
    check('DT: cons(a,x)=cons(a,x) SAT', sat(tm.eq(cons(a, x), cons(a, x))))

    // Disjointness + exhaustiveness of testers.
    check('DT: is-nil(x) ∧ is-cons(x) UNSAT', !sat(tm.and([isC('nil', x), isC('cons', x)])))
    check('DT: ¬is-nil(x) ∧ ¬is-cons(x) UNSAT (exhaustive)', !sat(tm.and([tm.not(isC('nil', x)), tm.not(isC('cons', x))])))
    check('DT: is-cons(cons(a,nil)) forced', !sat(tm.not(isC('cons', cons(a, nil)))))
    check('DT: is-nil(cons(a,nil)) UNSAT', !sat(isC('nil', cons(a, nil))))
    check('DT: is-cons(x) is SAT', sat(isC('cons', x)))

    // Different constructors are distinct.
    check('DT: nil = cons(a,nil) UNSAT', !sat(tm.eq(nil, cons(a, nil))))
    check('DT: nil ≠ cons(a,nil) SAT', sat(tm.not(tm.eq(nil, cons(a, nil)))))

    // Acyclicity — a finite list is never its own tail.
    check('DT: x = cons(a,x) UNSAT (acyclic)', !sat(tm.eq(x, cons(a, x))))
    check('DT: x=cons(a,y) ∧ y=cons(b,x) UNSAT (2-cycle)', !sat(tm.and([tm.eq(x, cons(a, y)), tm.eq(y, cons(b, x))])))
    check('DT: x=cons(a,y) ∧ y=cons(b,nil) SAT (finite)', sat(tm.and([tm.eq(x, cons(a, y)), tm.eq(y, cons(b, nil))])))

    // Selector reasoning through the tester link (selector on a variable).
    check(
      'DT: is-cons(x) ∧ x=cons(b,nil) ∧ head(x)=a ∧ a≠b UNSAT',
      !sat(tm.and([isC('cons', x), tm.eq(x, cons(b, nil)), tm.eq(head(x), a), tm.not(tm.eq(a, b))])),
    )
    check('DT: is-cons(x) ∧ tail(x)=x UNSAT (acyclic via link)', !sat(tm.and([isC('cons', x), tm.eq(tail(x), x)])))
  }

  // ---- datatypes over integers (QF_DTLIA) ------------------------------------
  {
    const tm = new TermManager()
    const IL: DtSort = {
      name: 'IL',
      ctors: [
        { name: 'lnil', tester: testerName('lnil'), selectors: [] },
        {
          name: 'lcons',
          tester: testerName('lcons'),
          selectors: [
            { name: 'hd', sort: 'Int' },
            { name: 'tl', sort: 'IL' },
          ],
        },
      ],
    }
    tm.declareDatatypes([IL])
    tm.declareFun({ name: 'x', argSorts: [], retSort: 'IL' })
    const x = tm.app('x')
    const n = (k: number) => tm.num(R(k), 'Int')
    const lcons = (h: Term, t: Term) => tm.app('lcons', [h, t])
    const hd = (t: Term) => tm.app('hd', [t])
    const lnil = tm.app('lnil')
    const sat = (f: Formula) => checkSat(tm, f).status === 'sat'
    // The head of a known cons is its integer value — claiming otherwise is UNSAT.
    check('DTLIA: x=lcons(5,lnil) ∧ hd(x)<5 UNSAT', !sat(tm.and([tm.eq(x, lcons(n(5), lnil)), tm.rel('lt', hd(x), n(5))])))
    check('DTLIA: x=lcons(7,lnil) ∧ hd(x)>6 SAT', sat(tm.and([tm.eq(x, lcons(n(7), lnil)), tm.rel('gt', hd(x), n(6))])))
  }

  // ---- enum datatype (exhaustiveness rules out a fourth value) ---------------
  {
    const tm = new TermManager()
    const Color: DtSort = {
      name: 'Color',
      ctors: ['red', 'green', 'blue'].map((c) => ({ name: c, tester: testerName(c), selectors: [] })),
    }
    tm.declareDatatypes([Color])
    tm.declareFun({ name: 'c', argSorts: [], retSort: 'Color' })
    const c = tm.app('c')
    const lit = (s: string) => tm.app(s)
    const sat = (f: Formula) => checkSat(tm, f).status === 'sat'
    check(
      'enum: c≠red ∧ c≠green ∧ c≠blue UNSAT (only three colors)',
      !sat(tm.and([tm.not(tm.eq(c, lit('red'))), tm.not(tm.eq(c, lit('green'))), tm.not(tm.eq(c, lit('blue')))])),
    )
    check('enum: red, green, blue are distinct', !sat(tm.eq(lit('red'), lit('green'))))
    check('enum: c≠red ∧ c≠green SAT (c can be blue)', sat(tm.and([tm.not(tm.eq(c, lit('red'))), tm.not(tm.eq(c, lit('green')))])))
  }

  // ---- SMT-LIB datatype parser ----------------------------------------------
  {
    const solveScript = (src: string) => {
      const s = parseSmtLib(src)
      return checkSat(s.tm, s.tm.and(s.assertions))
    }
    check(
      'parse: declare-datatype list read-back UNSAT',
      solveScript(`(declare-sort Elem 0)
        (declare-datatype Lst ((nil) (cons (head Elem) (tail Lst))))
        (declare-const a Elem)
        (assert (not (= (head (cons a nil)) a))) (check-sat)`).status === 'unsat',
    )
    check(
      'parse: tester ((_ is cons) (cons a nil)) UNSAT to deny',
      solveScript(`(declare-sort Elem 0)(declare-datatype Lst ((nil) (cons (head Elem) (tail Lst))))
        (declare-const a Elem)
        (assert (not ((_ is cons) (cons a nil)))) (check-sat)`).status === 'unsat',
    )
    check(
      'parse: cyclic list x=cons(a,x) UNSAT',
      solveScript(`(declare-sort Elem 0)(declare-datatype Lst ((nil) (cons (head Elem) (tail Lst))))
        (declare-const x Lst)(declare-const a Elem)
        (assert (= x (cons a x))) (check-sat)`).status === 'unsat',
    )
    check(
      'parse: declare-datatypes mutual Nat order SAT',
      solveScript(`(declare-datatypes ((Nat 0)) (((zero) (succ (pred Nat)))))
        (declare-const n Nat)
        (assert ((_ is succ) n)) (assert (not (= n (succ n)))) (check-sat)`).status === 'sat',
    )
  }

  // ---- random QF_DT cross-check vs finite-tree-model enumeration -------------
  // Discipline: atoms are testers / equalities over variables and constructor
  // terms (no bare selectors — those are out of the oracle's scope), so the
  // finite-tree oracle stays honest and shares no code with the reduction.
  {
    const rng = mulberry32(0xda7a)
    let mism = 0
    let decided = 0
    let unsatSeen = 0
    const N = 1500
    for (let it = 0; it < N; it++) {
      const tm = new TermManager()
      tm.declareSort('Elem')
      tm.declareDatatypes([
        {
          name: 'Lst',
          ctors: [
            { name: 'nil', tester: testerName('nil'), selectors: [] },
            {
              name: 'cons',
              tester: testerName('cons'),
              selectors: [
                { name: 'head', sort: 'Elem' },
                { name: 'tail', sort: 'Lst' },
              ],
            },
          ],
        },
      ])
      const lstNames = ['x', 'y']
      for (const c of lstNames) tm.declareFun({ name: c, argSorts: [], retSort: 'Lst' })
      const elemNames = ['u', 'v']
      for (const c of elemNames) tm.declareFun({ name: c, argSorts: [], retSort: 'Elem' })
      const lsts = lstNames.map((c) => tm.app(c))
      const elems = elemNames.map((c) => tm.app(c))
      const nil = tm.app('nil')
      const pick = <T,>(xs: T[]) => xs[Math.floor(rng() * xs.length)]
      const mkElem = (): Term => pick(elems)
      const mkList = (depth: number): Term => {
        const r = rng()
        if (depth <= 0 || r < 0.45) return pick(lsts)
        if (r < 0.6) return nil
        return tm.app('cons', [mkElem(), mkList(depth - 1)])
      }
      const mkAtom = (): Formula => {
        const r = rng()
        if (r < 0.3) return tm.pred(tm.app(testerName(pick(['nil', 'cons'])), [mkList(1)]))
        if (r < 0.65) return tm.eq(mkList(1), mkList(1))
        return tm.eq(mkElem(), mkElem())
      }
      const numAtoms = 2 + Math.floor(rng() * 2)
      const lits: Formula[] = []
      for (let k = 0; k < numAtoms; k++) {
        let at = mkAtom()
        if (rng() < 0.45) at = tm.not(at)
        lits.push(at)
      }
      const f = rng() < 0.6 ? tm.and(lits) : tm.or(lits)
      const want = referenceSatDatatypes(tm, f, 700_000)
      if (want === null) continue
      const r = checkSat(tm, f)
      if (r.status === 'unknown') continue
      decided++
      const got = r.status === 'sat'
      if (got !== want) {
        mism++
        if (mism <= 4) messages.push(`  DT mismatch: got ${got}, want ${want}`)
      }
      if (!want) unsatSeen++
    }
    check(`DT: ${decided} random formulas match finite-tree-model reference`, mism === 0, `mismatches=${mism}`)
    check('DT: random suite exercised some UNSAT instances', unsatSeen > decided / 25, `unsat=${unsatSeen}`)
  }

  // ---- bounded theory of strings (QF_S): hand cases + brute-force cross-check ----
  // Hand cases go through the *parser* (so they exercise it too); the headline test
  // is a brute-force cross-check of thousands of random string formulas against the
  // independent concrete-string enumerator (`strref.ts`).
  {
    const handCases: { name: string; src: string; expect: 'sat' | 'unsat' }[] = [
      { name: 'concat identity (x·"" = x)', expect: 'sat', src: `(declare-fun x () String)(assert (= (str.++ x "") x))(check-sat)` },
      { name: 'concat split', expect: 'sat', src: `(declare-fun x () String)(declare-fun y () String)(assert (= (str.++ x y) "ab"))(assert (= (str.len x) 1))(check-sat)` },
      { name: 'no tail-fixpoint', expect: 'unsat', src: `(declare-fun x () String)(assert (= x (str.++ "a" x)))(check-sat)` },
      { name: 'associativity (negated)', expect: 'unsat', src: `(declare-fun x () String)(declare-fun y () String)(declare-fun z () String)(assert (distinct (str.++ (str.++ x y) z) (str.++ x (str.++ y z))))(check-sat)` },
      { name: 'length additivity (negated)', expect: 'unsat', src: `(declare-fun x () String)(declare-fun y () String)(assert (not (= (str.len (str.++ x y)) (+ (str.len x) (str.len y)))))(check-sat)` },
      { name: 'contains literal', expect: 'sat', src: `(assert (str.contains "abc" "bc"))(check-sat)` },
      { name: 'contains literal (denied)', expect: 'unsat', src: `(assert (not (str.contains "abc" "bc")))(check-sat)` },
      { name: 'prefixof literal', expect: 'sat', src: `(assert (str.prefixof "ab" "abc"))(check-sat)` },
      { name: 'suffixof literal', expect: 'sat', src: `(assert (str.suffixof "bc" "abc"))(check-sat)` },
      { name: 'at read-back', expect: 'unsat', src: `(assert (not (= (str.at "abc" 1) "b")))(check-sat)` },
      { name: 'substr read-back', expect: 'unsat', src: `(assert (not (= (str.substr "abcd" 1 2) "bc")))(check-sat)` },
      { name: 'substr clamps past end', expect: 'unsat', src: `(assert (not (= (str.substr "abc" 2 9) "c")))(check-sat)` },
      { name: 'value not identity', expect: 'unsat', src: `(assert (distinct (str.++ "ab" "c") "abc"))(check-sat)` },
      { name: 'indexof finds', expect: 'unsat', src: `(assert (not (= (str.indexof "abcabc" "bc" 0) 1)))(check-sat)` },
      { name: 'indexof from offset', expect: 'unsat', src: `(assert (not (= (str.indexof "abcabc" "bc" 2) 4)))(check-sat)` },
      { name: 'indexof not found', expect: 'unsat', src: `(assert (not (= (str.indexof "abc" "x" 0) (- 1))))(check-sat)` },
      { name: 'indexof empty needle', expect: 'unsat', src: `(assert (not (= (str.indexof "abc" "" 2) 2)))(check-sat)` },
      { name: 'indexof constrains a hole', expect: 'sat', src: `(declare-fun x () String)(assert (= (str.len x) 3))(assert (= (str.indexof x "b" 0) 1))(check-sat)` },
      { name: 'commuting append', expect: 'sat', src: `(declare-fun x () String)(assert (= (str.++ x "a") (str.++ "a" x)))(assert (= (str.len x) 2))(check-sat)` },
      { name: 'distinct one-char strings need >1 char', expect: 'sat', src: `(declare-fun x () String)(declare-fun y () String)(assert (= (str.len x) 1))(assert (= (str.len y) 1))(assert (distinct x y))(check-sat)` },
      { name: 'length forces empty', expect: 'sat', src: `(declare-fun x () String)(assert (= (str.len x) 0))(assert (= x ""))(check-sat)` },
    ]
    let bad = 0
    for (const hc of handCases) {
      const s = parseSmtLib(hc.src)
      const r = checkSat(s.tm, s.tm.and(s.assertions), { stringBound: 4 })
      if (r.status !== hc.expect) {
        bad++
        messages.push(`  QF_S hand case "${hc.name}": got ${r.status}, expected ${hc.expect}`)
      }
    }
    check('QF_S: hand cases (concat/len/at/substr/contains/prefix/suffix) all decide correctly', bad === 0, `bad=${bad}`)

    // A model the solver returns must be re-checkable: the concat-split should read
    // back x = "a", y = "b".
    {
      const s = parseSmtLib(`(declare-fun x () String)(declare-fun y () String)(assert (= (str.++ x y) "ab"))(assert (= (str.len x) 1))(check-sat)`)
      const r = checkSat(s.tm, s.tm.and(s.assertions), { stringBound: 4 })
      const m = new Map((r.stringModel ?? []).map((e) => [e.name, e.value]))
      check('QF_S: concat-split model reads back x="a", y="b"', m.get('x') === '"a"' && m.get('y') === '"b"', JSON.stringify(r.stringModel))
    }

    // Headline: random formulas decided by the DPLL(T) reduction and by the
    // independent bounded-string enumerator must agree, verdict-for-verdict.
    {
      const L = 2
      const rng = mulberry32(0x57a21f)
      let mism = 0
      let decided = 0
      let unsatSeen = 0
      const lits = ['', 'a', 'b', 'aa', 'ab', 'ba']
      const N = 600
      for (let it = 0; it < N; it++) {
        const tm = new TermManager()
        ensureStringFuns(tm)
        for (const v of ['x', 'y']) tm.declareFun({ name: v, argSorts: [], retSort: 'String' })
        const xs = ['x', 'y'].map((v) => tm.app(v))
        const pick = <T,>(a: T[]): T => a[Math.floor(rng() * a.length)]
        const num = (n: number): Term => tm.num(Rational.of(BigInt(n)))
        const mkStr = (depth: number): Term => {
          const r = rng()
          if (depth <= 0 || r < 0.42) return pick(xs)
          if (r < 0.62) return stringLit(tm, pick(lits))
          if (r < 0.82) return tm.app('str.++', [mkStr(depth - 1), mkStr(depth - 1)])
          if (r < 0.91) return tm.app('str.at', [mkStr(depth - 1), num(Math.floor(rng() * 3))])
          return tm.app('str.substr', [mkStr(depth - 1), num(Math.floor(rng() * 3)), num(Math.floor(rng() * 3))])
        }
        const rels: ('le' | 'lt' | 'ge' | 'gt' | 'eq')[] = ['le', 'lt', 'ge', 'gt', 'eq']
        const mkAtom = (): Formula => {
          const r = rng()
          if (r < 0.4) return tm.eq(mkStr(2), mkStr(2))
          if (r < 0.52) return tm.pred(tm.app('str.contains', [mkStr(1), mkStr(1)]))
          if (r < 0.63) return tm.pred(tm.app('str.prefixof', [mkStr(1), mkStr(1)]))
          if (r < 0.74) return tm.pred(tm.app('str.suffixof', [mkStr(1), mkStr(1)]))
          if (r < 0.86) {
            const idx = tm.app('str.indexof', [mkStr(1), mkStr(1), num(Math.floor(rng() * 3))])
            return tm.eq(idx, num(Math.floor(rng() * 4) - 1))
          }
          const rel = pick(rels)
          const lenTerm = tm.app('str.len', [mkStr(1)])
          const k = num(Math.floor(rng() * 4))
          if (rel === 'eq') return tm.eq(lenTerm, k)
          return tm.rel(rel, lenTerm, k)
        }
        const numAtoms = 2 + Math.floor(rng() * 2)
        const parts: Formula[] = []
        for (let i = 0; i < numAtoms; i++) {
          let at = mkAtom()
          if (rng() < 0.4) at = tm.not(at)
          parts.push(at)
        }
        const f = rng() < 0.6 ? tm.and(parts) : tm.or(parts)
        const want = referenceSatStrings(tm, f, L)
        if (want === null) continue
        const r = checkSat(tm, f, { stringBound: L })
        if (r.status === 'unknown') continue
        decided++
        const got = r.status === 'sat'
        if (got !== want) {
          mism++
          if (mism <= 4) messages.push(`  QF_S mismatch: got ${got}, want ${want}`)
        }
        if (!want) unsatSeen++
      }
      check(`QF_S: ${decided} random formulas match the bounded-string reference`, mism === 0, `mismatches=${mism}`)
      check('QF_S: random suite exercised some UNSAT instances', unsatSeen > decided / 20, `unsat=${unsatSeen}`)
    }

    // A deeper single-variable batch at bound L = 3 — longer words, deeper
    // concat/substr/indexof nesting — again cross-checked against the enumerator.
    {
      const L = 3
      const rng = mulberry32(0x9e1ec)
      let mism = 0
      let decided = 0
      let satSeen = 0
      const lits = ['', 'a', 'b', 'ab', 'ba', 'aba']
      for (let it = 0; it < 300; it++) {
        const tm = new TermManager()
        ensureStringFuns(tm)
        tm.declareFun({ name: 'x', argSorts: [], retSort: 'String' })
        const x = tm.app('x')
        const num = (n: number): Term => tm.num(Rational.of(BigInt(n)))
        const pick = <T,>(a: T[]): T => a[Math.floor(rng() * a.length)]
        const mkStr = (depth: number): Term => {
          const r = rng()
          if (depth <= 0 || r < 0.45) return x
          if (r < 0.65) return stringLit(tm, pick(lits))
          if (r < 0.82) return tm.app('str.++', [mkStr(depth - 1), stringLit(tm, pick(lits))])
          if (r < 0.92) return tm.app('str.at', [mkStr(depth - 1), num(Math.floor(rng() * 4))])
          return tm.app('str.substr', [mkStr(depth - 1), num(Math.floor(rng() * 4)), num(Math.floor(rng() * 4))])
        }
        const mkAtom = (): Formula => {
          const r = rng()
          if (r < 0.4) return tm.eq(mkStr(2), stringLit(tm, pick(lits)))
          if (r < 0.55) return tm.pred(tm.app('str.contains', [x, stringLit(tm, pick(lits))]))
          if (r < 0.72) return tm.eq(tm.app('str.indexof', [x, stringLit(tm, pick(lits)), num(Math.floor(rng() * 3))]), num(Math.floor(rng() * 4) - 1))
          return tm.rel(pick(['le', 'lt', 'ge', 'gt'] as ('le' | 'lt' | 'ge' | 'gt')[]), tm.app('str.len', [x]), num(Math.floor(rng() * 4)))
        }
        const parts: Formula[] = []
        const k = 2 + Math.floor(rng() * 2)
        for (let i = 0; i < k; i++) {
          let at = mkAtom()
          if (rng() < 0.35) at = tm.not(at)
          parts.push(at)
        }
        const f = rng() < 0.7 ? tm.and(parts) : tm.or(parts)
        const want = referenceSatStrings(tm, f, L)
        if (want === null) continue
        const r = checkSat(tm, f, { stringBound: L })
        if (r.status === 'unknown') continue
        decided++
        if ((r.status === 'sat') !== want) {
          mism++
          if (mism <= 4) messages.push(`  QF_S(L=3) mismatch: got ${r.status === 'sat'}, want ${want}`)
        }
        if (want) satSeen++
      }
      check(`QF_S: ${decided} deeper (L=3) random formulas match the reference`, mism === 0, `mismatches=${mism}`)
      check('QF_S: deeper suite exercised some SAT instances', satSeen > decided / 20, `sat=${satSeen}`)
    }

    // The commuting append x·"a" = "a"·x with |x| = 2 reads back x = "aa".
    {
      const s = parseSmtLib(`(declare-fun x () String)(assert (= (str.++ x "a") (str.++ "a" x)))(assert (= (str.len x) 2))(check-sat)`)
      const r = checkSat(s.tm, s.tm.and(s.assertions), { stringBound: 4 })
      const v = (r.stringModel ?? []).find((e) => e.name === 'x')?.value
      check('QF_S: commuting-append model reads back x="aa"', r.status === 'sat' && v === '"aa"', String(v))
    }

    // indexof + suffix: a length-3 word whose first "b" is at index 1 and that ends
    // in "c". The reconstructed model must respect every constraint.
    {
      const s = parseSmtLib(`(declare-fun x () String)(assert (= (str.len x) 3))(assert (= (str.indexof x "b" 0) 1))(assert (str.suffixof "c" x))(check-sat)`)
      const r = checkSat(s.tm, s.tm.and(s.assertions), { stringBound: 5 })
      const v = (r.stringModel ?? []).find((e) => e.name === 'x')?.value
      let ok = r.status === 'sat' && typeof v === 'string'
      if (ok) {
        const w = JSON.parse(v!) as string
        ok = w.length === 3 && w[1] === 'b' && w[2] === 'c' && w[0] !== 'b'
      }
      check('QF_S: indexof+suffix model is internally consistent', ok, String(v))
    }
  }

  // ---- OMT (Optimization Modulo Theories) + MaxSMT --------------------------
  {
    const linTerm = (tm: TermManager, coeffs: number[], vars: Term[]): Term => {
      let acc: Term = tm.num(R(0n), 'Int')
      for (let i = 0; i < vars.length; i++) acc = tm.add(acc, tm.mul(tm.num(R(BigInt(coeffs[i])), 'Int'), vars[i]))
      return acc
    }

    // (A) Integer OMT vs brute force over a bounded box. The strongest check:
    // hundreds of random QF_LIA programs whose true min/max we compute by
    // exhaustive enumeration, asserting the solver returns *exactly* those.
    {
      const rng = mulberry32(91237)
      const ri = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1))
      let mism = 0
      let infeas = 0
      let ran = 0
      for (let t = 0; t < 200; t++) {
        const n = ri(2, 3)
        const B = 4
        const tm = new TermManager()
        const vars: Term[] = []
        const conj: Formula[] = []
        for (let i = 0; i < n; i++) {
          tm.declareFun({ name: `x${i}`, argSorts: [], retSort: 'Int' })
          const v = tm.app(`x${i}`)
          vars.push(v)
          conj.push(tm.rel('le', tm.num(R(0n), 'Int'), v))
          conj.push(tm.rel('le', v, tm.num(R(BigInt(B)), 'Int')))
        }
        const cons: { a: number[]; c: number }[] = []
        for (let k = 0, nc = ri(1, 3); k < nc; k++) {
          const a = Array.from({ length: n }, () => ri(-2, 2))
          const c = ri(-2, 8)
          cons.push({ a, c })
          conj.push(tm.rel('le', linTerm(tm, a, vars), tm.num(R(BigInt(c)), 'Int')))
        }
        const root = tm.and(conj)
        const obj = Array.from({ length: n }, () => ri(-2, 2))
        const objTerm = linTerm(tm, obj, vars)

        let feas = false
        let bmin = 0
        let bmax = 0
        const total = (B + 1) ** n
        for (let m = 0; m < total; m++) {
          const xs: number[] = []
          let mm = m
          for (let i = 0; i < n; i++) {
            xs.push(mm % (B + 1))
            mm = Math.floor(mm / (B + 1))
          }
          let ok = true
          for (const cc of cons) {
            let s = 0
            for (let i = 0; i < n; i++) s += cc.a[i] * xs[i]
            if (s > cc.c) {
              ok = false
              break
            }
          }
          if (!ok) continue
          let z = 0
          for (let i = 0; i < n; i++) z += obj[i] * xs[i]
          if (!feas) {
            feas = true
            bmin = z
            bmax = z
          } else {
            bmin = Math.min(bmin, z)
            bmax = Math.max(bmax, z)
          }
        }

        ran++
        const rMin = optimize(tm, root, objTerm, 'min')
        const rMax = optimize(tm, root, objTerm, 'max')
        if (!feas) {
          infeas++
          if (rMin.status !== 'infeasible') mism++
          continue
        }
        const okMin = rMin.status === 'optimal' && rMin.value!.eq(R(BigInt(bmin)))
        const okMax = rMax.status === 'optimal' && rMax.value!.eq(R(BigInt(bmax)))
        if (!okMin || !okMax) mism++
      }
      check(`OMT(LIA): ${ran} random integer programs match brute-force optima (${infeas} infeasible)`, mism === 0, `mism=${mism}`)
    }

    // (B) MaxSMT vs brute force over Boolean assignments.
    {
      const rng = mulberry32(0xc0ffee)
      const ri = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1))
      let mism = 0
      let ran = 0
      const evalBool = (f: Formula, val: (i: number) => boolean): boolean => {
        switch (f.kind) {
          case 'const':
            return f.val
          case 'not':
            return !evalBool(f.arg, val)
          case 'and':
            return f.args.every((g) => evalBool(g, val))
          case 'or':
            return f.args.some((g) => evalBool(g, val))
          case 'pred':
            return val(Number(f.term.op.slice(1)))
          default:
            throw new Error('unexpected ' + f.kind)
        }
      }
      for (let t = 0; t < 200; t++) {
        const n = ri(2, 4)
        const tm = new TermManager()
        const bools: Formula[] = []
        for (let i = 0; i < n; i++) {
          tm.declareFun({ name: `b${i}`, argSorts: [], retSort: 'Bool' })
          bools.push(tm.pred(tm.app(`b${i}`)))
        }
        const hardClauses: Formula[] = []
        for (let k = 0, nh = ri(0, 2); k < nh; k++) {
          const lits: Formula[] = []
          for (let i = 0; i < n; i++) if (rng() < 0.5) lits.push(rng() < 0.5 ? bools[i] : tm.not(bools[i]))
          if (lits.length) hardClauses.push(tm.or(lits))
        }
        const hard = tm.and(hardClauses)
        const soft: MaxSmtSoft[] = []
        for (let k = 0, ns = ri(2, 4); k < ns; k++) {
          const i = ri(0, n - 1)
          soft.push({ formula: rng() < 0.5 ? bools[i] : tm.not(bools[i]), weight: ri(1, 4), id: `s${k}` })
        }

        let bfCost = Infinity
        let feasible = false
        for (let m = 0; m < 1 << n; m++) {
          const val = (i: number) => (m & (1 << i)) !== 0
          if (!evalBool(hard, val)) continue
          feasible = true
          let cost = 0
          for (const s of soft) if (!evalBool(s.formula, val)) cost += Math.round(s.weight)
          bfCost = Math.min(bfCost, cost)
        }

        ran++
        const r = maxsmt(tm, hard, soft)
        if (!feasible) {
          if (r.status !== 'infeasible') mism++
          continue
        }
        if (r.status !== 'optimal' || !r.cost!.eq(R(BigInt(bfCost)))) mism++
      }
      check(`MaxSMT: ${ran} random instances match brute-force minimum violated weight`, mism === 0, `mism=${mism}`)
    }

    // (C) Real (QF_LRA) OMT: exact vertex optima, open infima, unboundedness.
    {
      const real = (tm: TermManager, k: bigint, d = 1n) => tm.num(R(k, d), 'Real')
      // min x s.t. 2x ≥ 3 → 3/2 (attained)
      {
        const tm = new TermManager()
        tm.declareFun({ name: 'x', argSorts: [], retSort: 'Real' })
        const x = tm.app('x')
        const r = optimize(tm, tm.rel('ge', tm.mul(real(tm, 2n), x), real(tm, 3n)), x, 'min')
        check('OMT(LRA): min x, 2x≥3 = 3/2 (attained)', r.status === 'optimal' && r.value!.eq(R(3n, 2n)) && r.attained === true, `${r.value?.toString()}`)
      }
      // LP: max x+y s.t. x+2y≤14, 3x≤y, x,y≥0 → vertex (2,6), optimum 8.
      {
        const tm = new TermManager()
        tm.declareFun({ name: 'x', argSorts: [], retSort: 'Real' })
        tm.declareFun({ name: 'y', argSorts: [], retSort: 'Real' })
        const x = tm.app('x')
        const y = tm.app('y')
        const z = real(tm, 0n)
        const root = tm.and([
          tm.rel('le', tm.add(x, tm.mul(real(tm, 2n), y)), real(tm, 14n)),
          tm.rel('le', tm.sub(tm.mul(real(tm, 3n), x), y), z),
          tm.rel('ge', x, z),
          tm.rel('ge', y, z),
        ])
        const obj = tm.add(x, y)
        const r = optimize(tm, root, obj, 'max')
        check('OMT(LRA): linear program max x+y = 8 (vertex)', r.status === 'optimal' && r.value!.eq(R(8n)), `${r.value?.toString()}`)
        if (r.status === 'optimal') {
          const gt = checkSat(tm, tm.and([root, tm.rel('gt', obj, real(tm, r.value!.n, r.value!.d))]))
          check('OMT(LRA): LP optimality certificate (obj>opt UNSAT)', gt.status === 'unsat', gt.status)
        }
      }
      // open infimum: min x s.t. x > 1 → 1, not attained
      {
        const tm = new TermManager()
        tm.declareFun({ name: 'x', argSorts: [], retSort: 'Real' })
        const x = tm.app('x')
        const r = optimize(tm, tm.rel('gt', x, real(tm, 1n)), x, 'min')
        check('OMT(LRA): min x, x>1 = 1 (open infimum)', r.status === 'optimal' && r.value!.eq(R(1n)) && r.attained === false, `${r.value?.toString()} att=${r.attained}`)
      }
      // unbounded: max y s.t. y ≥ x
      {
        const tm = new TermManager()
        tm.declareFun({ name: 'x', argSorts: [], retSort: 'Real' })
        tm.declareFun({ name: 'y', argSorts: [], retSort: 'Real' })
        const r = optimize(tm, tm.rel('ge', tm.sub(tm.app('y'), tm.app('x')), real(tm, 0n)), tm.app('y'), 'max')
        check('OMT(LRA): unbounded objective detected', r.status === 'unbounded', r.status)
      }
      // disjunctive structure: min x s.t. (x≥5 ∨ x≥3) → 3
      {
        const tm = new TermManager()
        tm.declareFun({ name: 'x', argSorts: [], retSort: 'Real' })
        const x = tm.app('x')
        const r = optimize(tm, tm.or([tm.rel('ge', x, real(tm, 5n)), tm.rel('ge', x, real(tm, 3n))]), x, 'min')
        check('OMT(LRA): disjunctive min x = 3', r.status === 'optimal' && r.value!.eq(R(3n)), `${r.value?.toString()}`)
      }
    }

    // (D) End-to-end through the SMT-LIB parser: the coin-change example.
    {
      const s = parseSmtLib(`(set-logic QF_LIA)
        (declare-const a Int)(declare-const b Int)(declare-const c Int)(declare-const d Int)
        (assert (>= a 0))(assert (>= b 0))(assert (>= c 0))(assert (>= d 0))
        (assert (= (+ a (* 5 b) (* 10 c) (* 25 d)) 47))
        (minimize (+ a b c d))(check-sat)`)
      const obj = s.objectives[0]
      const r = optimize(s.tm, s.tm.and(s.assertions), obj.term, obj.dir)
      check('OMT: parsed coin-change minimizes to 5 coins', r.status === 'optimal' && r.value!.eq(R(5n)), `${r.value?.toString()}`)
    }

    // (E) MaxSMT across the theory of equality (QF_UF) via the parser.
    {
      const s = parseSmtLib(`(set-logic QF_UF)
        (declare-sort U 0)(declare-fun a () U)(declare-fun b () U)(declare-fun c () U)(declare-fun f (U) U)
        (assert (not (= (f a) (f c))))
        (assert-soft (= a b) :weight 2 :id ab)
        (assert-soft (= b c) :weight 2 :id bc)
        (assert-soft (= a c) :weight 1 :id ac)
        (check-sat)`)
      const r = maxsmt(s.tm, s.tm.and(s.assertions), s.softs)
      // f(a)≠f(c) forbids a=c (congruence). a=c can never hold (drop weight 1), and
      // at most one of a=b / b=c can (both ⇒ a=c). So the most weight we can keep is
      // a single weight-2 equality; the minimum violated weight is 2 + 1 = 3.
      check('MaxSMT(QF_UF): equality MaxSMT optimum = 3', r.status === 'optimal' && r.cost!.eq(R(3n)), `${r.cost?.toString()}`)
    }
  }

  void Rational
  void ((): Atom | undefined => undefined)
  void collectAtoms
  void evalFormula
  return { pass, fail, messages }
}
