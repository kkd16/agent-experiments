// Top-level QF_BV decision procedure: parse → bit-blast → CDCL → decode. Because
// bit-blasting is a *complete* reduction (the propositional model is a bit-vector
// model and vice-versa), the SAT verdict is the SMT verdict outright — no
// refinement loop. On SAT we decode each variable's bits and independently
// re-check the model with the BigInt reference before handing it back.

import { solve, type SolveResult } from '../../sat/solver'
import { checkProof } from '../../sat/drat'
import { BitBlaster } from './blast'
import { evalForm, type BvAssign } from './reference'
import { toSigned, type BoolForm, type BvScript } from './ast'
import type { Bits } from './bvops'

export interface BvVarValue {
  name: string
  width: number
  bin: string
  hex: string
  dec: string // unsigned decimal
  sdec: string // signed (two's-complement) decimal
}

export interface BvProofInfo {
  /** The independent RUP/RAT checker re-derived the empty clause from the CNF. */
  verified: boolean
  steps: number
  rupSteps: number
  ratSteps: number
  truncated?: boolean
}

export interface BvResult {
  status: 'sat' | 'unsat' | 'unknown'
  values?: BvVarValue[]
  boolValues?: { name: string; value: boolean }[]
  stats: { vars: number; clauses: number; conflicts: number; decisions: number }
  timeMs: number
  modelVerified?: boolean
  proof?: BvProofInfo
  message?: string
  expected?: 'sat' | 'unsat'
  assertionCount: number
}

export interface BvSolveOptions {
  maxConflicts?: number
  maxTimeMs?: number
  /** Record a DRAT proof of an UNSAT encoding and re-verify it independently. */
  certify?: boolean
}

function litValue(l: number, model: boolean[]): boolean {
  return l > 0 ? model[l] : !model[-l]
}

function bitsToBig(bits: Bits, model: boolean[]): bigint {
  let v = 0n
  for (let i = 0; i < bits.length; i++) if (litValue(bits[i], model)) v |= 1n << BigInt(i)
  return v
}

function formatValue(name: string, width: number, v: bigint): BvVarValue {
  const bin = '#b' + v.toString(2).padStart(width, '0')
  const hexDigits = Math.ceil(width / 4)
  const hex = '#x' + v.toString(16).padStart(hexDigits, '0')
  return { name, width, bin, hex, dec: v.toString(), sdec: toSigned(v, width).toString() }
}

export function solveBv(script: BvScript, opts: BvSolveOptions = {}): BvResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const bb = new BitBlaster()
  const { blaster, bvLits, boolLits } = bb.finish(script.assertions)
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

  if (script.assertions.length === 0) {
    return {
      status: 'sat',
      values: [],
      boolValues: [],
      stats: { vars: blaster.numVars, clauses: blaster.clauses.length, conflicts: 0, decisions: 0 },
      timeMs: now() - t0,
      modelVerified: true,
      assertionCount: 0,
    }
  }

  const cnf = { numVars: blaster.numVars, clauses: blaster.clauses }
  const res: SolveResult = solve(cnf, {
    maxConflicts: opts.maxConflicts ?? 0,
    maxTimeMs: opts.maxTimeMs ?? 0,
    randomSeed: 0x5a7f,
    proof: opts.certify === true,
  })
  const stats = {
    vars: blaster.numVars,
    clauses: blaster.clauses.length,
    conflicts: res.stats.conflicts,
    decisions: res.stats.decisions,
  }

  if (res.status === 'unknown')
    return { status: 'unknown', stats, timeMs: now() - t0, message: res.message, expected: script.expected, assertionCount: script.assertions.length }
  if (res.status === 'unsat') {
    // Independently certify the refutation: replay the DRAT proof through the
    // from-scratch RUP/RAT checker, which re-derives the empty clause from the
    // CNF alone — so an UNSAT bit-vector answer is machine-checked, not trusted.
    let proof: BvProofInfo | undefined
    if (opts.certify && res.proof) {
      const dr = checkProof(cnf, res.proof)
      proof = { verified: dr.ok && dr.derivedEmpty, steps: dr.steps, rupSteps: dr.rupSteps, ratSteps: dr.ratSteps, truncated: res.proofTruncated }
    }
    return { status: 'unsat', stats, timeMs: now() - t0, proof, expected: script.expected, assertionCount: script.assertions.length }
  }

  // SAT — decode the model.
  const model = res.model!
  const assign: BvAssign = { bv: new Map(), bool: new Map() }
  const values: BvVarValue[] = []
  for (const [name, width] of script.bvVars) {
    const bits = bvLits.get(name)
    const v = bits ? bitsToBig(bits, model) : 0n
    assign.bv.set(name, v)
    values.push(formatValue(name, width, v))
  }
  const boolValues: { name: string; value: boolean }[] = []
  for (const name of script.boolVars) {
    const l = boolLits.get(name)
    const val = l === undefined ? false : litValue(l, model)
    assign.bool.set(name, val)
    boolValues.push({ name, value: val })
  }
  values.sort((a, b) => a.name.localeCompare(b.name))
  boolValues.sort((a, b) => a.name.localeCompare(b.name))

  // Independent re-check: the decoded model must satisfy every assertion.
  let verified = true
  try {
    for (const f of script.assertions as BoolForm[]) if (!evalForm(f, assign)) verified = false
  } catch {
    verified = false
  }

  return {
    status: 'sat',
    values,
    boolValues,
    stats,
    timeMs: now() - t0,
    modelVerified: verified,
    expected: script.expected,
    assertionCount: script.assertions.length,
  }
}
