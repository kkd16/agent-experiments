// The QF_BV abstract syntax: width-indexed bit-vector terms and the Boolean
// formulas over them. Kept deliberately small and explicit — every node carries
// its bit width so the blaster and the reference evaluator never have to re-infer
// it. Constructed by the parser (parse.ts), consumed by both the bit-blaster
// (blast.ts) and the BigInt reference (reference.ts).

export type BvUnOp = 'bvnot' | 'bvneg'
export type BvBinOp =
  | 'bvand' | 'bvor' | 'bvxor' | 'bvnand' | 'bvnor' | 'bvxnor'
  | 'bvadd' | 'bvsub' | 'bvmul'
  | 'bvudiv' | 'bvurem' | 'bvsdiv' | 'bvsrem' | 'bvsmod'
  | 'bvshl' | 'bvlshr' | 'bvashr'

export type BvTerm =
  | { kind: 'var'; name: string; width: number }
  | { kind: 'const'; value: bigint; width: number }
  | { kind: 'un'; op: BvUnOp; arg: BvTerm; width: number }
  | { kind: 'bin'; op: BvBinOp; a: BvTerm; b: BvTerm; width: number }
  | { kind: 'concat'; a: BvTerm; b: BvTerm; width: number }
  | { kind: 'extract'; hi: number; lo: number; arg: BvTerm; width: number }
  | { kind: 'extend'; signed: boolean; by: number; arg: BvTerm; width: number }
  | { kind: 'repeat'; times: number; arg: BvTerm; width: number }
  | { kind: 'rotate'; left: boolean; amount: number; arg: BvTerm; width: number }
  | { kind: 'bvcomp'; a: BvTerm; b: BvTerm; width: number } // width === 1
  | { kind: 'ite'; c: BoolForm; t: BvTerm; e: BvTerm; width: number }

export type BvCmp = 'bvult' | 'bvule' | 'bvugt' | 'bvuge' | 'bvslt' | 'bvsle' | 'bvsgt' | 'bvsge'

export type BoolForm =
  | { kind: 'true' }
  | { kind: 'false' }
  | { kind: 'boolvar'; name: string }
  | { kind: 'not'; arg: BoolForm }
  | { kind: 'and'; args: BoolForm[] }
  | { kind: 'or'; args: BoolForm[] }
  | { kind: 'xor'; args: BoolForm[] }
  | { kind: 'iff'; a: BoolForm; b: BoolForm }
  | { kind: 'imp'; a: BoolForm; b: BoolForm }
  | { kind: 'iteb'; c: BoolForm; t: BoolForm; e: BoolForm }
  | { kind: 'eq'; a: BvTerm; b: BvTerm }
  | { kind: 'distinct'; args: BvTerm[] }
  | { kind: 'cmp'; op: BvCmp; a: BvTerm; b: BvTerm }

export interface BvScript {
  /** Declared bit-vector constants: name → width. */
  bvVars: Map<string, number>
  /** Declared Bool constants. */
  boolVars: Set<string>
  assertions: BoolForm[]
  expected?: 'sat' | 'unsat'
  logic?: string
}

/** width-mask helper: keep a BigInt to its low `width` bits (two's-complement wrap). */
export function mask(value: bigint, width: number): bigint {
  const m = (1n << BigInt(width)) - 1n
  return ((value & m) + (m + 1n)) & m
}

/** Interpret a width-bit pattern as a signed two's-complement integer. */
export function toSigned(value: bigint, width: number): bigint {
  const v = mask(value, width)
  const half = 1n << BigInt(width - 1)
  return v >= half ? v - (1n << BigInt(width)) : v
}
