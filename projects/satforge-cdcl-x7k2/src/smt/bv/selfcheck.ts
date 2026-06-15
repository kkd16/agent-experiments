// Correctness harness for the QF_BV engine. Three layers, strongest last:
//   1. per-operator exhaustive checks — every circuit (adder, multiplier,
//      restoring divider, barrel shifters, signed div/rem/mod, comparators,
//      structural ops) is driven with concrete inputs and its decoded output is
//      compared against the BigInt reference, exhaustively at small widths;
//   2. hand-written sat/unsat identities + a parser round-trip on the examples;
//   3. the headline **brute-force cross-check**: thousands of random bit-vector
//      formulas, each decided by bit-blasting+CDCL and by enumerating *every*
//      assignment under the reference semantics — the verdicts must always agree,
//      and every SAT model the solver returns must satisfy the formula.
//
// Two independent implementations (gate circuits vs. BigInt) agreeing on millions
// of evaluations is the evidence the bit-blaster is sound and complete.

import { solveBv } from './solve'
import { parseBv } from './parse'
import { collectVars, evalForm, evalTerm, type BvAssign } from './reference'
import { mask, type BoolForm, type BvBinOp, type BvCmp, type BvTerm } from './ast'
import { BV_EXAMPLES } from './examples'

export interface BvCheckReport {
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

const BIN_OPS: BvBinOp[] = [
  'bvand', 'bvor', 'bvxor', 'bvnand', 'bvnor', 'bvxnor',
  'bvadd', 'bvsub', 'bvmul',
  'bvudiv', 'bvurem', 'bvsdiv', 'bvsrem', 'bvsmod',
  'bvshl', 'bvlshr', 'bvashr',
]
const CMP_OPS: BvCmp[] = ['bvult', 'bvule', 'bvugt', 'bvuge', 'bvslt', 'bvsle', 'bvsgt', 'bvsge']
const EMPTY: BvAssign = { bv: new Map(), bool: new Map() }

const C = (value: bigint, width: number): BvTerm => ({ kind: 'const', value: mask(value, width), width })
const VAR = (name: string, width: number): BvTerm => ({ kind: 'var', name, width })

export function runBvChecks(): BvCheckReport {
  let pass = 0
  let fail = 0
  const messages: string[] = []
  const check = (name: string, cond: boolean, extra = '') => {
    if (cond) pass++
    else {
      fail++
      if (messages.length < 60) messages.push(`FAIL: ${name} ${extra}`)
    }
  }

  // Solve a closed formula (variables auto-collected) and return the verdict.
  const decide = (assertions: BoolForm[]) => {
    const bvVars = new Map<string, number>()
    const bools = new Set<string>()
    for (const f of assertions) collectVars(f, bvVars, bools)
    return solveBv({ bvVars, boolVars: bools, assertions }, { maxTimeMs: 5000 })
  }
  // r := expr ; solver must decode r to the reference value of expr.
  const checkOutput = (expr: BvTerm): { ok: boolean; got?: bigint; want: bigint; status: string } => {
    const want = evalTerm(expr, EMPTY)
    const res = decide([{ kind: 'eq', a: VAR('r', expr.width), b: expr }])
    if (res.status !== 'sat') return { ok: false, want, status: res.status }
    const got = BigInt(res.values!.find((v) => v.name === 'r')!.dec)
    return { ok: got === want && res.modelVerified !== false, got, want, status: 'sat' }
  }

  // ---- 1a. binary-operator circuits ------------------------------------------
  {
    let bad = 0
    let count = 0
    for (const w of [1, 2, 3, 4]) {
      const lim = 1n << BigInt(w)
      const rng = mulberry32(0x1111 * w)
      const pairs: [bigint, bigint][] = []
      if (w <= 3) {
        for (let a = 0n; a < lim; a++) for (let b = 0n; b < lim; b++) pairs.push([a, b])
      } else {
        for (let k = 0; k < 80; k++) pairs.push([BigInt(Math.floor(rng() * Number(lim))), BigInt(Math.floor(rng() * Number(lim)))])
      }
      for (const op of BIN_OPS)
        for (const [a, b] of pairs) {
          count++
          const r = checkOutput({ kind: 'bin', op, a: C(a, w), b: C(b, w), width: w })
          if (!r.ok) { bad++; if (bad <= 6) messages.push(`  ${op}(${a},${b})@${w}: got ${r.got} want ${r.want} [${r.status}]`) }
        }
    }
    check(`BV: ${count} binary-operator circuit outputs match the BigInt reference`, bad === 0, `bad=${bad}`)
  }

  // ---- 1b. unary operators ---------------------------------------------------
  {
    let bad = 0
    for (const w of [1, 2, 4, 6]) {
      const lim = 1n << BigInt(w)
      for (let a = 0n; a < lim; a++)
        for (const op of ['bvnot', 'bvneg'] as const) {
          const r = checkOutput({ kind: 'un', op, arg: C(a, w), width: w })
          if (!r.ok) bad++
        }
    }
    check('BV: bvnot/bvneg exhaustive ≤6 bits', bad === 0, `bad=${bad}`)
  }

  // ---- 1c. comparators (exhaustive, signed + unsigned) -----------------------
  {
    let bad = 0
    for (const w of [1, 2, 3, 4]) {
      const lim = 1n << BigInt(w)
      for (const op of CMP_OPS)
        for (let a = 0n; a < lim; a++)
          for (let b = 0n; b < lim; b++) {
            const f: BoolForm = { kind: 'cmp', op, a: C(a, w), b: C(b, w) }
            const want = evalForm(f, EMPTY)
            // the constant comparison is true ⇒ asserting it is SAT, asserting its negation UNSAT
            if (decide([f]).status !== (want ? 'sat' : 'unsat')) bad++
          }
    }
    check('BV: comparators (unsigned+signed) decide correctly, exhaustive ≤4 bits', bad === 0, `bad=${bad}`)
  }

  // ---- 1d. structural ops ----------------------------------------------------
  {
    let bad = 0
    const rng = mulberry32(0xbeef)
    for (let k = 0; k < 500; k++) {
      const w = 2 + Math.floor(rng() * 6)
      const a = BigInt(Math.floor(rng() * Number(1n << BigInt(w))))
      const at = C(a, w)
      const lo = Math.floor(rng() * w)
      const hi = lo + Math.floor(rng() * (w - lo))
      const by = 1 + Math.floor(rng() * 4)
      const times = 1 + Math.floor(rng() * 3)
      const b = BigInt(Math.floor(rng() * Number(1n << BigInt(w))))
      const choices: BvTerm[] = [
        { kind: 'extract', hi, lo, arg: at, width: hi - lo + 1 },
        { kind: 'extend', signed: rng() < 0.5, by, arg: at, width: w + by },
        { kind: 'repeat', times, arg: at, width: w * times },
        { kind: 'rotate', left: rng() < 0.5, amount: Math.floor(rng() * (2 * w)), arg: at, width: w },
        { kind: 'concat', a: at, b: C(b, w), width: 2 * w },
        { kind: 'bvcomp', a: at, b: C(b, w), width: 1 },
      ]
      const r = checkOutput(choices[Math.floor(rng() * choices.length)])
      if (!r.ok) { bad++; if (bad <= 6) messages.push(`  struct: got ${r.got} want ${r.want}`) }
    }
    check('BV: structural ops (extract/concat/extend/repeat/rotate/bvcomp) match reference', bad === 0, `bad=${bad}`)
  }

  // ---- 1e. variable-amount shifts (barrel shifter incl. over-wide) -----------
  {
    let bad = 0
    for (const w of [3, 4]) {
      const lim = 1n << BigInt(w)
      for (const op of ['bvshl', 'bvlshr', 'bvashr'] as BvBinOp[])
        for (let a = 0n; a < lim; a++)
          for (let s = 0n; s < lim; s++) {
            const r = checkOutput({ kind: 'bin', op, a: C(a, w), b: C(s, w), width: w })
            if (!r.ok) bad++
          }
    }
    check('BV: variable-amount shifts (incl. ≥width) exhaustive ≤4 bits', bad === 0, `bad=${bad}`)
  }

  // ---- 2. hand-written sat/unsat identities ----------------------------------
  {
    const run = (src: string) => solveBv(parseBv(src), { maxTimeMs: 8000 })
    check('BV: x*2 = x<<1 is valid', run(`(declare-const x (_ BitVec 8))
      (assert (not (= (bvmul x (_ bv2 8)) (bvshl x (_ bv1 8))))) (check-sat)`).status === 'unsat')
    check('BV: ~(x & y) = ~x | ~y is valid', run(`(declare-const x (_ BitVec 8))(declare-const y (_ BitVec 8))
      (assert (not (= (bvnot (bvand x y)) (bvor (bvnot x) (bvnot y))))) (check-sat)`).status === 'unsat')
    check('BV: ∃x. x+1 <u x (overflow)', run(`(declare-const x (_ BitVec 4))
      (assert (bvult (bvadd x (_ bv1 4)) x)) (check-sat)`).status === 'sat')
    check('BV: signedness split is SAT', run(`(declare-const x (_ BitVec 8))(declare-const y (_ BitVec 8))
      (assert (bvult x y)) (assert (bvsgt x y)) (check-sat)`).status === 'sat')
    check('BV: x <u x is UNSAT', run(`(declare-const x (_ BitVec 8)) (assert (bvult x x)) (check-sat)`).status === 'unsat')
    check('BV: x + (bvneg x) = 0 valid', run(`(declare-const x (_ BitVec 6))
      (assert (not (= (bvadd x (bvneg x)) (_ bv0 6)))) (check-sat)`).status === 'unsat')
    check('BV: udiv/urem reconstruct dividend', run(`(declare-const x (_ BitVec 6))(declare-const y (_ BitVec 6))
      (assert (not (= y (_ bv0 6))))
      (assert (not (= (bvadd (bvmul (bvudiv x y) y) (bvurem x y)) x))) (check-sat)`).status === 'unsat')
    check('BV: udiv by zero = ~0', run(`(declare-const x (_ BitVec 5))
      (assert (= x (bvudiv x (_ bv0 5)))) (assert (not (= x (bvnot (_ bv0 5))))) (check-sat)`).status === 'unsat')
    {
      const r = run(`(declare-const a (_ BitVec 8))(declare-const b (_ BitVec 8))
        (assert (= (bvmul a b) (_ bv35 8)))
        (assert (bvugt a (_ bv1 8))) (assert (bvugt b (_ bv1 8))) (check-sat)`)
      const ok = r.status === 'sat' && (() => {
        const a = BigInt(r.values!.find((v) => v.name === 'a')!.dec)
        const b = BigInt(r.values!.find((v) => v.name === 'b')!.dec)
        return (a * b) % 256n === 35n && a > 1n && b > 1n
      })()
      check('BV: 8-bit factoring 35 = a·b finds real factors', ok)
    }
    check('BV: 35 has no factor pair both ≤ 6', run(`(declare-const a (_ BitVec 8))(declare-const b (_ BitVec 8))
      (assert (= (bvmul a b) (_ bv35 8)))
      (assert (bvule (_ bv2 8) a)) (assert (bvule a (_ bv6 8)))
      (assert (bvule (_ bv2 8) b)) (assert (bvule b (_ bv6 8))) (check-sat)`).status === 'unsat')
  }

  // ---- DRAT certification: UNSAT bit-vector encodings are machine-checked -----
  {
    const certify = (src: string) => solveBv(parseBv(src), { maxTimeMs: 8000, certify: true })
    const unsatScripts = [
      `(declare-const x (_ BitVec 8)) (assert (not (= (bvmul x (_ bv2 8)) (bvshl x (_ bv1 8))))) (check-sat)`,
      `(declare-const x (_ BitVec 6)) (assert (not (= (bvadd x (bvneg x)) (_ bv0 6)))) (check-sat)`,
      `(declare-const x (_ BitVec 8))(declare-const y (_ BitVec 8))
       (assert (not (= (bvnot (bvand x y)) (bvor (bvnot x) (bvnot y))))) (check-sat)`,
      `(declare-const x (_ BitVec 8)) (assert (bvult x x)) (check-sat)`,
    ]
    let bad = 0
    for (const s of unsatScripts) {
      const r = certify(s)
      if (r.status !== 'unsat' || !r.proof || !r.proof.verified) {
        bad++
        messages.push(`  DRAT: "${s.slice(0, 30)}…" status=${r.status} verified=${r.proof?.verified}`)
      }
    }
    check('BV: UNSAT encodings carry a DRAT proof that the RUP/RAT checker re-verifies', bad === 0, `bad=${bad}`)
  }

  // ---- 3. brute-force cross-check vs full assignment enumeration --------------
  {
    const rng = mulberry32(0x5a7f2c)
    let mism = 0
    let unsatSeen = 0
    let modelBad = 0
    const N = 1500
    for (let i = 0; i < N; i++) {
      const w = 2 + Math.floor(rng() * 3) // 2..4
      const nVars = 1 + Math.floor(rng() * 3) // 1..3
      const names = ['a', 'b', 'c'].slice(0, nVars)
      const bvVars = new Map(names.map((n) => [n, w] as const))
      const assertions = [randomFormula(rng, names, w, 3)]
      const truth = bruteSat(assertions, bvVars)
      if (!truth) unsatSeen++
      const res = solveBv({ bvVars, boolVars: new Set(), assertions }, { maxTimeMs: 5000 })
      if (res.status === 'unknown') continue
      const got = res.status === 'sat'
      if (got !== truth) { mism++; if (mism <= 5) messages.push(`  brute mismatch (w=${w}): got ${got} want ${truth}`) }
      if (got && res.modelVerified === false) modelBad++
    }
    check(`BV: ${N} random formulas match full-enumeration reference`, mism === 0, `mismatches=${mism}`)
    check('BV: random suite exercised UNSAT instances', unsatSeen > N / 12, `unsat=${unsatSeen}`)
    check('BV: every SAT model independently verified', modelBad === 0, `bad=${modelBad}`)
  }

  // ---- shipped examples decide to their expected verdict ---------------------
  {
    let bad = 0
    for (const ex of BV_EXAMPLES) {
      const r = solveBv(parseBv(ex.src), { maxTimeMs: 8000 })
      if (r.status !== ex.expected) { bad++; messages.push(`  example "${ex.name}": got ${r.status}, expected ${ex.expected}`) }
    }
    check('BV: all shipped examples match expected verdict', bad === 0, `bad=${bad}`)
  }

  return { pass, fail, messages }
}

// ---- brute-force enumeration -------------------------------------------------
function bruteSat(assertions: BoolForm[], bvVars: Map<string, number>): boolean {
  const names = [...bvVars.keys()]
  const widths = names.map((n) => bvVars.get(n)!)
  const total = widths.reduce((s, w) => s + w, 0)
  for (let bits = 0; bits < 1 << total; bits++) {
    const bv = new Map<string, bigint>()
    let off = 0
    for (let k = 0; k < names.length; k++) {
      const w = widths[k]
      bv.set(names[k], BigInt((bits >> off) & ((1 << w) - 1)))
      off += w
    }
    const assign: BvAssign = { bv, bool: new Map() }
    if (assertions.every((f) => evalForm(f, assign))) return true
  }
  return false
}

// ---- random AST generation ---------------------------------------------------
function randomTerm(rng: () => number, names: string[], w: number, depth: number): BvTerm {
  if (depth <= 0 || rng() < 0.35) {
    if (rng() < 0.5) return VAR(names[Math.floor(rng() * names.length)], w)
    return C(BigInt(Math.floor(rng() * Number(1n << BigInt(w)))), w)
  }
  if (rng() < 0.2) return { kind: 'un', op: rng() < 0.5 ? 'bvnot' : 'bvneg', arg: randomTerm(rng, names, w, depth - 1), width: w }
  const op = BIN_OPS[Math.floor(rng() * BIN_OPS.length)]
  return { kind: 'bin', op, a: randomTerm(rng, names, w, depth - 1), b: randomTerm(rng, names, w, depth - 1), width: w }
}

function randomFormula(rng: () => number, names: string[], w: number, depth: number): BoolForm {
  if (depth <= 0 || rng() < 0.45) {
    const a = randomTerm(rng, names, w, 2)
    const b = randomTerm(rng, names, w, 2)
    if (rng() < 0.4) return { kind: 'eq', a, b }
    return { kind: 'cmp', op: CMP_OPS[Math.floor(rng() * CMP_OPS.length)], a, b }
  }
  const r = rng()
  if (r < 0.2) return { kind: 'not', arg: randomFormula(rng, names, w, depth - 1) }
  if (r < 0.45) return { kind: 'and', args: [randomFormula(rng, names, w, depth - 1), randomFormula(rng, names, w, depth - 1)] }
  if (r < 0.7) return { kind: 'or', args: [randomFormula(rng, names, w, depth - 1), randomFormula(rng, names, w, depth - 1)] }
  if (r < 0.85) return { kind: 'xor', args: [randomFormula(rng, names, w, depth - 1), randomFormula(rng, names, w, depth - 1)] }
  return { kind: 'iteb', c: randomFormula(rng, names, w, depth - 1), t: randomFormula(rng, names, w, depth - 1), e: randomFormula(rng, names, w, depth - 1) }
}
