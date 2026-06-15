// An independent BigInt reference semantics for QF_BV. It evaluates a term/formula
// under a concrete assignment, exactly as the SMT-LIB theory prescribes — every
// corner case included (division by zero, over-wide shifts, signed wrap, modulo
// sign rules). Two jobs:
//   • the self-test brute-forces every assignment with this and compares the
//     verdict against the bit-blaster — the headline correctness guarantee;
//   • after a SAT answer the solver re-checks its decoded model here, so a
//     reported model is always independently confirmed before it is shown.
//
// It is deliberately *not* shared with the blaster: agreement between two
// from-scratch implementations is the evidence.

import { mask, toSigned, type BoolForm, type BvTerm } from './ast'

export interface BvAssign {
  bv: Map<string, bigint> // name → value (already width-masked)
  bool: Map<string, boolean>
}

export function evalTerm(t: BvTerm, a: BvAssign): bigint {
  switch (t.kind) {
    case 'var': {
      const v = a.bv.get(t.name)
      if (v === undefined) throw new Error(`unassigned bit-vector ${t.name}`)
      return mask(v, t.width)
    }
    case 'const':
      return mask(t.value, t.width)
    case 'un': {
      const x = evalTerm(t.arg, a)
      return t.op === 'bvnot' ? mask(~x, t.width) : mask(-x, t.width)
    }
    case 'concat': {
      const hi = evalTerm(t.a, a)
      const lo = evalTerm(t.b, a)
      return mask((hi << BigInt(t.b.width)) | lo, t.width)
    }
    case 'extract':
      return mask(evalTerm(t.arg, a) >> BigInt(t.lo), t.width)
    case 'extend': {
      const x = evalTerm(t.arg, a)
      if (!t.signed) return mask(x, t.width)
      return mask(toSigned(x, t.arg.width), t.width)
    }
    case 'repeat': {
      const x = evalTerm(t.arg, a)
      let out = 0n
      for (let k = 0; k < t.times; k++) out = (out << BigInt(t.arg.width)) | x
      return mask(out, t.width)
    }
    case 'rotate': {
      const x = evalTerm(t.arg, a)
      const w = t.arg.width
      const k = ((t.amount % w) + w) % w
      if (t.left) return mask((x << BigInt(k)) | (x >> BigInt(w - k)), w)
      return mask((x >> BigInt(k)) | (x << BigInt(w - k)), w)
    }
    case 'bvcomp':
      return evalTerm(t.a, a) === evalTerm(t.b, a) ? 1n : 0n
    case 'ite':
      return evalForm(t.c, a) ? evalTerm(t.t, a) : evalTerm(t.e, a)
    case 'bin':
      return evalBin(t, a)
  }
}

function evalBin(t: Extract<BvTerm, { kind: 'bin' }>, a: BvAssign): bigint {
  const w = t.width
  const x = evalTerm(t.a, a)
  const y = evalTerm(t.b, a)
  const full = 1n << BigInt(w)
  switch (t.op) {
    case 'bvand': return mask(x & y, w)
    case 'bvor': return mask(x | y, w)
    case 'bvxor': return mask(x ^ y, w)
    case 'bvnand': return mask(~(x & y), w)
    case 'bvnor': return mask(~(x | y), w)
    case 'bvxnor': return mask(~(x ^ y), w)
    case 'bvadd': return mask(x + y, w)
    case 'bvsub': return mask(x - y, w)
    case 'bvmul': return mask(x * y, w)
    case 'bvudiv': return y === 0n ? full - 1n : mask(x / y, w)
    case 'bvurem': return y === 0n ? mask(x, w) : mask(x % y, w)
    case 'bvshl': return y >= BigInt(w) ? 0n : mask(x << y, w)
    case 'bvlshr': return y >= BigInt(w) ? 0n : mask(x >> y, w)
    case 'bvashr': {
      const s = toSigned(x, w)
      if (y >= BigInt(w)) return s < 0n ? full - 1n : 0n
      return mask(s >> y, w)
    }
    case 'bvsdiv': {
      const sx = toSigned(x, w)
      const sy = toSigned(y, w)
      const ax = sx < 0n ? -sx : sx
      const ay = sy < 0n ? -sy : sy
      const q = ay === 0n ? full - 1n : ax / ay // mirrors udiv-by-zero through |·|
      const neg = sx < 0n !== sy < 0n
      return mask(neg ? -q : q, w)
    }
    case 'bvsrem': {
      const sx = toSigned(x, w)
      const sy = toSigned(y, w)
      const ax = sx < 0n ? -sx : sx
      const ay = sy < 0n ? -sy : sy
      const r = ay === 0n ? ax : ax % ay
      return mask(sx < 0n ? -r : r, w)
    }
    case 'bvsmod': {
      const sx = toSigned(x, w)
      const sy = toSigned(y, w)
      const ax = sx < 0n ? -sx : sx
      const ay = sy < 0n ? -sy : sy
      const u = ay === 0n ? ax : ax % ay
      if (u === 0n) return 0n
      if (sx >= 0n && sy >= 0n) return mask(u, w)
      if (sx < 0n && sy >= 0n) return mask(-u + sy, w)
      if (sx >= 0n && sy < 0n) return mask(u + sy, w)
      return mask(-u, w)
    }
  }
}

export function evalForm(f: BoolForm, a: BvAssign): boolean {
  switch (f.kind) {
    case 'true': return true
    case 'false': return false
    case 'boolvar': {
      const v = a.bool.get(f.name)
      if (v === undefined) throw new Error(`unassigned Bool ${f.name}`)
      return v
    }
    case 'not': return !evalForm(f.arg, a)
    case 'and': return f.args.every((g) => evalForm(g, a))
    case 'or': return f.args.some((g) => evalForm(g, a))
    case 'xor': return f.args.reduce((acc, g) => acc !== evalForm(g, a), false)
    case 'iff': return evalForm(f.a, a) === evalForm(f.b, a)
    case 'imp': return !evalForm(f.a, a) || evalForm(f.b, a)
    case 'iteb': return evalForm(f.c, a) ? evalForm(f.t, a) : evalForm(f.e, a)
    case 'eq': return evalTerm(f.a, a) === evalTerm(f.b, a)
    case 'distinct': {
      const vals = f.args.map((t) => evalTerm(t, a))
      for (let i = 0; i < vals.length; i++)
        for (let j = i + 1; j < vals.length; j++) if (vals[i] === vals[j]) return false
      return true
    }
    case 'cmp': {
      const x = evalTerm(f.a, a)
      const y = evalTerm(f.b, a)
      const w = f.a.width
      switch (f.op) {
        case 'bvult': return x < y
        case 'bvule': return x <= y
        case 'bvugt': return x > y
        case 'bvuge': return x >= y
        case 'bvslt': return toSigned(x, w) < toSigned(y, w)
        case 'bvsle': return toSigned(x, w) <= toSigned(y, w)
        case 'bvsgt': return toSigned(x, w) > toSigned(y, w)
        case 'bvsge': return toSigned(x, w) >= toSigned(y, w)
      }
    }
  }
}

/** Collect the bit-vector and Bool variable names appearing in a formula. */
export function collectVars(f: BoolForm, bv: Map<string, number>, bools: Set<string>): void {
  const visitT = (t: BvTerm) => {
    switch (t.kind) {
      case 'var': bv.set(t.name, t.width); break
      case 'const': break
      case 'un': visitT(t.arg); break
      case 'extract': case 'extend': case 'repeat': case 'rotate': visitT(t.arg); break
      case 'concat': case 'bin': case 'bvcomp': visitT(t.a); visitT(t.b); break
      case 'ite': visitF(t.c); visitT(t.t); visitT(t.e); break
    }
  }
  const visitF = (g: BoolForm) => {
    switch (g.kind) {
      case 'true': case 'false': break
      case 'boolvar': bools.add(g.name); break
      case 'not': visitF(g.arg); break
      case 'and': case 'or': case 'xor': g.args.forEach(visitF); break
      case 'iff': case 'imp': visitF(g.a); visitF(g.b); break
      case 'iteb': visitF(g.c); visitF(g.t); visitF(g.e); break
      case 'eq': case 'cmp': visitT(g.a); visitT(g.b); break
      case 'distinct': g.args.forEach(visitT); break
    }
  }
  visitF(f)
}
