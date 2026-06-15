// The bit-blaster: lower a QF_BV formula to one propositional circuit. Every
// bit-vector term becomes a `Bits` (array of SAT literals) and every Boolean
// formula a single literal; the root literal is asserted true. Results are
// memoized by node identity so a shared subterm is blasted once. The output is a
// plain {numVars, clauses} CNF plus the literal layout of each variable, ready
// for the CDCL core and for decoding a model back into bit-vector values.

import { Blaster, type Lit } from './bits'
import * as ops from './bvops'
import type { Bits } from './bvops'
import type { BoolForm, BvTerm } from './ast'

export interface BlastResult {
  blaster: Blaster
  rootLit: Lit
  /** name → its bit literals (LSB-first), for decoding the model. */
  bvLits: Map<string, Bits>
  boolLits: Map<string, Lit>
}

export class BitBlaster {
  readonly B = new Blaster()
  private bvLits = new Map<string, Bits>()
  private boolLits = new Map<string, Lit>()
  private termCache = new Map<BvTerm, Bits>()
  private formCache = new Map<BoolForm, Lit>()

  private varBits(name: string, width: number): Bits {
    let b = this.bvLits.get(name)
    if (!b) {
      b = ops.freshBits(this.B, width)
      this.bvLits.set(name, b)
    }
    return b
  }

  private boolVar(name: string): Lit {
    let l = this.boolLits.get(name)
    if (l === undefined) {
      l = this.B.newVar()
      this.boolLits.set(name, l)
    }
    return l
  }

  term(t: BvTerm): Bits {
    const hit = this.termCache.get(t)
    if (hit) return hit
    const out = this.buildTerm(t)
    this.termCache.set(t, out)
    return out
  }

  private buildTerm(t: BvTerm): Bits {
    const B = this.B
    switch (t.kind) {
      case 'var': return this.varBits(t.name, t.width)
      case 'const': return ops.constBits(B, t.value, t.width)
      case 'un':
        return t.op === 'bvnot' ? ops.bvnot(B, this.term(t.arg)) : ops.bvneg(B, this.term(t.arg))
      case 'concat': return ops.concat(this.term(t.a), this.term(t.b))
      case 'extract': return ops.extract(this.term(t.arg), t.hi, t.lo)
      case 'extend':
        return t.signed ? ops.signExtend(this.term(t.arg), t.by) : ops.zeroExtend(B, this.term(t.arg), t.by)
      case 'repeat': return ops.repeat(this.term(t.arg), t.times)
      case 'rotate':
        return t.left ? ops.rotateLeft(this.term(t.arg), t.amount) : ops.rotateRight(this.term(t.arg), t.amount)
      case 'bvcomp': return ops.bvcomp(B, this.term(t.a), this.term(t.b))
      case 'ite': {
        const c = this.form(t.c)
        const a = this.term(t.t)
        const b = this.term(t.e)
        return a.map((bit, j) => B.mux(c, bit, b[j]))
      }
      case 'bin': return this.buildBin(t)
    }
  }

  private buildBin(t: Extract<BvTerm, { kind: 'bin' }>): Bits {
    const B = this.B
    const a = this.term(t.a)
    const b = this.term(t.b)
    switch (t.op) {
      case 'bvand': return ops.bvand(B, a, b)
      case 'bvor': return ops.bvor(B, a, b)
      case 'bvxor': return ops.bvxor(B, a, b)
      case 'bvnand': return ops.bvnand(B, a, b)
      case 'bvnor': return ops.bvnor(B, a, b)
      case 'bvxnor': return ops.bvxnor(B, a, b)
      case 'bvadd': return ops.bvadd(B, a, b)
      case 'bvsub': return ops.bvsub(B, a, b)
      case 'bvmul': return ops.bvmul(B, a, b)
      case 'bvudiv': return ops.udivurem(B, a, b).q
      case 'bvurem': return ops.udivurem(B, a, b).r
      case 'bvsdiv': return ops.bvsdiv(B, a, b)
      case 'bvsrem': return ops.bvsrem(B, a, b)
      case 'bvsmod': return ops.bvsmod(B, a, b)
      case 'bvshl': return ops.shl(B, a, b)
      case 'bvlshr': return ops.lshr(B, a, b)
      case 'bvashr': return ops.ashr(B, a, b)
    }
  }

  form(f: BoolForm): Lit {
    const hit = this.formCache.get(f)
    if (hit !== undefined) return hit
    const out = this.buildForm(f)
    this.formCache.set(f, out)
    return out
  }

  private buildForm(f: BoolForm): Lit {
    const B = this.B
    switch (f.kind) {
      case 'true': return B.TRUE
      case 'false': return B.FALSE
      case 'boolvar': return this.boolVar(f.name)
      case 'not': return B.not(this.form(f.arg))
      case 'and': return f.args.map((g) => this.form(g)).reduce((x, y) => B.and(x, y), B.TRUE)
      case 'or': return f.args.map((g) => this.form(g)).reduce((x, y) => B.or(x, y), B.FALSE)
      case 'xor': return f.args.map((g) => this.form(g)).reduce((x, y) => B.xor(x, y), B.FALSE)
      case 'iff': return B.iff(this.form(f.a), this.form(f.b))
      case 'imp': return B.or(B.not(this.form(f.a)), this.form(f.b))
      case 'iteb': return B.mux(this.form(f.c), this.form(f.t), this.form(f.e))
      case 'eq': return ops.eqBits(B, this.term(f.a), this.term(f.b))
      case 'distinct': {
        const ts = f.args.map((t) => this.term(t))
        let acc = B.TRUE
        for (let i = 0; i < ts.length; i++)
          for (let j = i + 1; j < ts.length; j++) acc = B.and(acc, B.not(ops.eqBits(B, ts[i], ts[j])))
        return acc
      }
      case 'cmp': return this.buildCmp(f)
    }
  }

  private buildCmp(f: Extract<BoolForm, { kind: 'cmp' }>): Lit {
    const B = this.B
    const a = this.term(f.a)
    const b = this.term(f.b)
    switch (f.op) {
      case 'bvult': return ops.ult(B, a, b)
      case 'bvule': return ops.ule(B, a, b)
      case 'bvugt': return ops.ult(B, b, a)
      case 'bvuge': return ops.ule(B, b, a)
      case 'bvslt': return ops.slt(B, a, b)
      case 'bvsle': return ops.sle(B, a, b)
      case 'bvsgt': return ops.slt(B, b, a)
      case 'bvsge': return ops.sle(B, b, a)
    }
  }

  /** Blast a conjunction of assertions and pin the result true. */
  finish(assertions: BoolForm[]): BlastResult {
    const lits = assertions.map((f) => this.form(f))
    let root = this.B.TRUE
    for (const l of lits) root = this.B.and(root, l)
    this.B.assertTrue(root)
    return { blaster: this.B, rootLit: root, bvLits: this.bvLits, boolLits: this.boolLits }
  }
}
