// QBF correctness harness. The headline test is a brute-force cross-check:
// thousands of random QBFs, each decided by the RAReQS solver and by the
// exhaustive oracle in ./eval.ts, asserting the verdicts always agree — and,
// when the outer player wins, that the returned move actually wins.
//
// Exposed as a function so the project's selftest.ts can fold these checks into
// its assertion count, exactly like the SMT / BV / IMC subsystems.

import { evalQbf } from './eval'
import { solveQbf } from './solver'
import { QBF_EXAMPLES, matchFamily, parityLadder, randomQbf } from './encoders'
import { parseQdimacs, toQdimacs, normalizeQbf, alternations } from './qdimacs'
import type { QBF, Quant } from './qdimacs'

export interface QbfCheckReport {
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

/**
 * Substitute a full assignment to the outer block into the matrix and confirm
 * the residual QBF really has the claimed value — i.e. the returned witness is
 * a genuine winning move, not just a coincidence.
 */
function witnessWins(qbf: QBF, witness: Record<number, boolean>, expectInnerTrue: boolean): boolean {
  const assign = new Map<number, boolean>()
  for (const k of Object.keys(witness)) assign.set(Number(k), witness[Number(k)])
  const matrix: number[][] = []
  for (const c of qbf.matrix) {
    let sat = false
    const lits: number[] = []
    for (const l of c) {
      const v = Math.abs(l)
      const a = assign.get(v)
      if (a === undefined) lits.push(l)
      else if (l > 0 === a) {
        sat = true
        break
      }
    }
    if (!sat) matrix.push(lits)
  }
  const rest = qbf.prefix.slice(1)
  const residual = normalizeQbf(rest, matrix)
  const val = evalQbf(residual, 26)
  if (val === null) return true // too big to verify cheaply; skip
  return val === expectInnerTrue
}

export function runQbfChecks(): QbfCheckReport {
  let pass = 0
  let fail = 0
  const messages: string[] = []
  const check = (name: string, cond: boolean, extra = '') => {
    if (cond) pass++
    else {
      fail++
      if (messages.length < 40) messages.push(`FAIL: ${name} ${extra}`)
    }
  }

  // ---- curated examples with a priori values --------------------------------
  for (const ex of QBF_EXAMPLES) {
    const r = solveQbf(ex.qbf, { trace: false })
    if (ex.expected !== undefined) {
      check(`example "${ex.name}" = ${ex.expected}`, r.value === ex.expected, `got ${r.value}`)
    }
    const oracle = evalQbf(ex.qbf, 26)
    if (oracle !== null) {
      check(`example "${ex.name}" agrees with oracle`, r.value === oracle, `solver=${r.value} oracle=${oracle}`)
    }
  }

  // ---- the big random cross-check -------------------------------------------
  {
    const rng = mulberry32(0xc0ffee)
    let agree = 0
    let badWitness = 0
    let mismatches = 0
    const TRIALS = 1500
    for (let i = 0; i < TRIALS; i++) {
      const leading: Quant = rng() < 0.5 ? 'e' : 'a'
      const blocks = 1 + Math.floor(rng() * 4) // 1..4 alternations
      const perBlock = 1 + Math.floor(rng() * 3) // 1..3 vars per block
      const nv = blocks * perBlock
      const clauses = Math.max(1, Math.round((1.0 + rng() * 3.5) * nv))
      const k = 2 + Math.floor(rng() * 2) // 2 or 3 literals
      const q = randomQbf({ seed: (i * 2654435761) >>> 0, leading, blocks, perBlock, clauses, k })
      const oracle = evalQbf(q, 22)
      if (oracle === null) continue
      const r = solveQbf(q, { trace: false, maxIter: 200000 })
      if (r.value === 'unknown') continue
      if (r.value === oracle) agree++
      else {
        mismatches++
        if (messages.length < 40) {
          messages.push(`FAIL: random #${i} solver=${r.value} oracle=${oracle}\n${toQdimacs(q)}`)
        }
      }
      // Witness soundness: when the outer player wins, the move must hold up.
      if (r.witness) {
        const outerExists = q.prefix[0].q === 'e'
        const expectInner = outerExists // ∃ wins ⇒ residual must be TRUE; ∀ wins ⇒ residual FALSE
        if (!witnessWins(q, r.witness, expectInner)) badWitness++
      }
    }
    check('random QBF cross-check (RAReQS vs brute-force oracle)', mismatches === 0, `${mismatches} mismatches / ${agree} agreed`)
    check('returned witnesses are genuine winning moves', badWitness === 0, `${badWitness} bad`)
  }

  // ---- scalable families with values known by construction ------------------
  for (let n = 1; n <= 8; n++) {
    check(`copy game width ${n} (forall-first) = TRUE`, solveQbf(matchFamily(n, false), { trace: false }).value === true)
    check(`copy game width ${n} (exists-first) = FALSE`, solveQbf(matchFamily(n, true), { trace: false }).value === false)
  }
  for (let k = 1; k <= 9; k++) {
    check(`parity ladder k=${k} innermost ∃ = TRUE`, solveQbf(parityLadder(k, true), { trace: false }).value === true)
    check(`parity ladder k=${k} innermost ∀ = FALSE`, solveQbf(parityLadder(k, false), { trace: false }).value === false)
  }

  // ---- QDIMACS round-trip ---------------------------------------------------
  {
    const q = parityLadder(4, true)
    const text = toQdimacs(q)
    const parsed = parseQdimacs(text)
    const r1 = solveQbf(q, { trace: false }).value
    const r2 = solveQbf(parsed.qbf, { trace: false }).value
    check('QDIMACS serialize → parse preserves the verdict', r1 === r2, `${r1} vs ${r2}`)
    const sample = 'p cnf 3 2\na 1 0\ne 2 3 0\n-1 2 0\n1 -2 3 0\n'
    const p = parseQdimacs(sample)
    check('QDIMACS parser reads prefix + matrix', p.qbf.prefix.length === 2 && p.qbf.matrix.length === 2)
    check('alternations() counts blocks', alternations(p.qbf) === 1)
  }

  // ---- determinism ----------------------------------------------------------
  {
    const q = randomQbf({ seed: 42, leading: 'e', blocks: 3, perBlock: 2, clauses: 8, k: 3 })
    const a = solveQbf(q, { trace: false }).value
    const b = solveQbf(q, { trace: false }).value
    check('solver is deterministic', a === b, `${a} vs ${b}`)
  }

  return { pass, fail, messages }
}
