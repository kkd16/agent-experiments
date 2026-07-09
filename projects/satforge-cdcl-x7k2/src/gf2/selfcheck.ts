// The XOR studio's correctness harness — the same differential-oracle ethos the
// rest of SatForge lives by. Nothing here shares code with the thing it checks:
//
//   • the 𝔽₂ engine is pinned against **brute-force enumeration** (exact solution
//     sets, counts, backbones) and its own **closed form** 2^(n−rank);
//   • the hybrid DPLL(⊕) solver is pinned against the project's independent
//     **clausal CDCL** on the expanded formula (same verdict, valid models) and
//     against the project's exact **#SAT** counter (SAT ⇔ count > 0, and for pure
//     parity systems the counts must be *equal*);
//   • `xorToClauses` is verified to encode the parity exactly, and
//     `recoverXors` to invert it (expand-then-recover is the identity);
//   • Tseitin formulas are checked against their free total-charge oracle;
//   • Lights Out solutions are checked by *actually clearing the board*, and the
//     5×5 quiet space against the classic dimension-2 result;
//   • recovered LFSR seeds are checked by regenerating the observed keystream.
//
// `runGf2Checks()` folds it all into one pass/fail report for the studio badge.

import { verifyModel, type CNF } from '../sat/cnf'
import { solve } from '../sat/solver'
import { countModels } from '../sat/modelCount'
import {
  rref,
  solutionCount,
  particularSolution,
  nullSpaceBasis,
  linearBackbone,
  satisfies,
  enumerateSolutions,
  type Gf2System,
} from './gf2'
import { makeXor, xorToClauses, recoverXors, xorCnfToCnf, xorSystem, verifyXors, type XorClause, type XorCnf } from './xor'
import { solveMixed } from './solver'
import { tseitinFormula, randomConnectedGraph, randomKXorSat, parityChain, mulberry32 } from './examples'
import { solveLightsOut, applyPresses, quietDimension } from './lightsout'
import { randomLfsr, runLfsr, breakLfsr } from './crypto'
import { parseXorDimacs, toXorDimacs, parseXorDsl } from './parse'

export interface Gf2CheckReport {
  pass: number
  fail: number
  messages: string[]
}

function bruteSystem(sys: Gf2System): boolean[][] {
  const n = sys.numVars
  const out: boolean[][] = []
  for (let mask = 0; mask < 1 << n; mask++) {
    const x = Array.from({ length: n }, (_, i) => (mask & (1 << i)) !== 0)
    if (satisfies(sys, x)) out.push(x)
  }
  return out
}

const keyOf = (x: boolean[], off = 0) => x.slice(off).map((b) => (b ? 1 : 0)).join('')

export function runGf2Checks(): Gf2CheckReport {
  let pass = 0
  let fail = 0
  const messages: string[] = []
  const ok = (label: string) => {
    pass++
    messages.push(`✓ ${label}`)
  }
  const bad = (label: string) => {
    fail++
    messages.push(`✗ ${label}`)
  }
  const rng = mulberry32(0xc0ffee)
  const rowMask = (vars: number[]) => vars.reduce((m, v) => m | (1n << BigInt(v)), 0n)

  // 1. 𝔽₂ core vs brute force: count, particular, null space, enumeration, backbone.
  {
    let good = true
    for (let t = 0; t < 500 && good; t++) {
      const n = 1 + Math.floor(rng() * 7)
      const m = Math.floor(rng() * 8)
      const rows = Array.from({ length: m }, () => {
        const vars: number[] = []
        for (let v = 0; v < n; v++) if (rng() < 0.5) vars.push(v)
        return { mask: rowMask(vars), rhs: rng() < 0.5 ? 1 : 0 }
      })
      const sys: Gf2System = { numVars: n, rows }
      const brute = bruteSystem(sys)
      if (solutionCount(sys) !== BigInt(brute.length)) good = false
      if (brute.length > 0) {
        const rr = rref(sys)
        const ps = particularSolution(rr)!
        if (!satisfies(sys, ps)) good = false
        const homo: Gf2System = { numVars: n, rows: rows.map((r) => ({ mask: r.mask, rhs: 0 })) }
        if (!nullSpaceBasis(rr).every((b) => satisfies(homo, b))) good = false
        const en = new Set(enumerateSolutions(sys).map((x) => keyOf(x)))
        const br = new Set(brute.map((x) => keyOf(x)))
        if (en.size !== br.size || [...en].some((k) => !br.has(k))) good = false
        for (const { var: v, value } of linearBackbone(rr)) if (brute.some((s) => s[v] !== value)) good = false
      }
    }
    if (good) ok('𝔽₂ core ≡ brute force over 500 random systems (count, particular, null-space, enumeration, backbone)')
    else bad('𝔽₂ core disagreed with brute force')
  }

  // 2. xorToClauses encodes the parity exactly (brute over the variables).
  {
    let good = true
    for (let t = 0; t < 200 && good; t++) {
      const k = 1 + Math.floor(rng() * 6)
      const x: XorClause = { vars: Array.from({ length: k }, (_, i) => i + 1), rhs: rng() < 0.5 ? 1 : 0 }
      const cnf: CNF = { numVars: k, clauses: xorToClauses(x) }
      if (cnf.clauses.length !== 1 << (k - 1)) good = false
      for (let mask = 0; mask < 1 << k && good; mask++) {
        const model = new Array<boolean>(k + 1).fill(false)
        let par = 0
        for (let i = 0; i < k; i++) {
          const b = (mask & (1 << i)) !== 0
          model[i + 1] = b
          if (b) par ^= 1
        }
        if (verifyModel(cnf, model).ok !== (par === x.rhs)) good = false
      }
    }
    if (good) ok('xorToClauses ≡ the parity it encodes (2^(k−1) clauses, exact truth table)')
    else bad('xorToClauses encoded the wrong parity')
  }

  // 3. expand → recover is the identity on random XOR sets.
  {
    let good = true
    for (let t = 0; t < 300 && good; t++) {
      const n = 3 + Math.floor(rng() * 6)
      const xors: XorClause[] = []
      const clauses: number[][] = []
      const nx = 1 + Math.floor(rng() * 4)
      for (let i = 0; i < nx; i++) {
        let k = 2 + Math.floor(rng() * 4)
        if (k > n) k = n
        const vs = new Set<number>()
        let guard = 0
        while (vs.size < k && guard++ < 40) vs.add(1 + Math.floor(rng() * n))
        const x = makeXor([...vs], rng() < 0.5 ? 1 : 0)
        if (x.vars.length >= 2) {
          xors.push(x)
          for (const c of xorToClauses(x)) clauses.push(c)
        }
      }
      const rec = recoverXors({ numVars: n, clauses })
      const orig = new Set(xors.map((x) => `${x.vars.join('|')}=${x.rhs}`))
      const got = new Set(rec.xors.map((x) => `${x.vars.join('|')}=${x.rhs}`))
      if (orig.size !== got.size || [...orig].some((k) => !got.has(k))) good = false
    }
    if (good) ok('recoverXors ∘ xorToClauses = identity over 300 random systems')
    else bad('expand-then-recover was not the identity')
  }

  // 4. Hybrid DPLL(⊕) vs the project's clausal CDCL, and models are valid.
  {
    let good = true
    let sat = 0
    let unsat = 0
    for (let t = 0; t < 400 && good; t++) {
      const n = 2 + Math.floor(rng() * 6)
      const xors: XorClause[] = []
      for (let i = 0, nx = Math.floor(rng() * 4); i < nx; i++) {
        let k = 1 + Math.floor(rng() * 4)
        if (k > n) k = n
        const vs = new Set<number>()
        let guard = 0
        while (vs.size < k && guard++ < 40) vs.add(1 + Math.floor(rng() * n))
        const x = makeXor([...vs], rng() < 0.5 ? 1 : 0)
        if (x.vars.length > 0) xors.push(x)
      }
      const clauses: number[][] = []
      for (let i = 0, nc = Math.floor(rng() * 5); i < nc; i++) {
        const k = 1 + Math.floor(rng() * 3)
        const lits = new Set<number>()
        let guard = 0
        while (lits.size < k && guard++ < 40) {
          const v = 1 + Math.floor(rng() * n)
          const l = rng() < 0.5 ? v : -v
          if (!lits.has(-l)) lits.add(l)
        }
        if (lits.size > 0) clauses.push([...lits])
      }
      const p: XorCnf = { numVars: n, clauses, xors }
      const cnf = xorCnfToCnf(p)
      const ref = solve(cnf)
      const mine = solveMixed(p)
      if (mine.status !== ref.status) good = false
      else if (mine.status === 'sat') {
        sat++
        if (!verifyModel(cnf, mine.model!).ok || !verifyXors(xors, mine.model!).ok) good = false
      } else unsat++
    }
    if (good) ok(`hybrid DPLL(⊕) ≡ clausal CDCL over 400 mixed instances (${sat} SAT / ${unsat} UNSAT), every model valid`)
    else bad('hybrid solver disagreed with the clausal CDCL')
  }

  // 5. #SAT agreement: pure-XOR count = closed form = project #SAT counter.
  {
    let good = true
    for (let t = 0; t < 150 && good; t++) {
      const n = 2 + Math.floor(rng() * 6)
      const p = randomKXorSat(n, 1 + Math.floor(rng() * 5), 2 + Math.floor(rng() * 2), (t + 1) * 7)
      const closed = solutionCount(xorSystem(p))
      const cnf = xorCnfToCnf(p)
      const counted = countModels(cnf)
      if (!counted.exact || counted.count !== closed) good = false
      // ... and the hybrid solver agrees on the yes/no.
      const mine = solveMixed(p)
      if ((mine.status === 'sat') !== (closed > 0n)) good = false
    }
    if (good) ok('#SAT agreement: 2^(n−rank) = project counter = hybrid verdict (150 XOR systems)')
    else bad('#SAT counts disagreed')
  }

  // 6. Tseitin free-charge oracle vs solver vs closed form.
  {
    let good = true
    for (let s = 0; s < 120 && good; s++) {
      const g = randomConnectedGraph(5 + (s % 6), 3, s + 1)
      for (const odd of [true, false]) {
        const tr = tseitinFormula(g, odd, s + 100)
        if ((solveMixed(tr.problem).status === 'sat') !== tr.satisfiable) good = false
        if (solutionCount(xorSystem(tr.problem)) > 0n !== tr.satisfiable) good = false
      }
    }
    // parity chains too
    for (let n = 3; n <= 30 && good; n++) for (const u of [true, false]) if ((solveMixed(parityChain(n, u)).status === 'unsat') !== u) good = false
    if (good) ok('Tseitin total-charge oracle ≡ solver ≡ closed form; parity chains SAT/UNSAT exact')
    else bad('Tseitin/parity oracle mismatch')
  }

  // 7. Lights Out: solved presses clear the board; classic 5×5 quiet dimension.
  {
    let good = true
    for (let t = 0; t < 200 && good; t++) {
      const R = 2 + Math.floor(rng() * 4)
      const C = 2 + Math.floor(rng() * 4)
      const n = R * C
      const presses = Array.from({ length: n }, () => rng() < 0.4)
      const board = applyPresses(R, C, new Array(n).fill(false), presses)
      const sol = solveLightsOut(R, C, board)
      if (!sol.solvable) good = false
      else {
        if (applyPresses(R, C, board, sol.minPresses!).some((x) => x)) good = false
        if (sol.minCount > presses.reduce((a, b) => a + (b ? 1 : 0), 0)) good = false
      }
    }
    if (quietDimension(5, 5) !== 2) good = false
    if (good) ok('Lights Out: 200 boards cleared by the returned presses; 5×5 quiet space = 2 (⇒ 4 solutions)')
    else bad('Lights Out solution did not clear the board')
  }

  // 8. LFSR: recovered seed regenerates the keystream and equals the secret.
  {
    let good = true
    let broke = 0
    for (let t = 0; t < 200 && good; t++) {
      const L = 4 + Math.floor(rng() * 12)
      const spec = randomLfsr(L, t + 1)
      const ks = runLfsr(spec, 2 * L + 4)
      const br = breakLfsr(L, spec.taps, ks)
      if (br.unique) {
        broke++
        const regen = runLfsr({ length: L, taps: spec.taps, seed: br.seed! }, ks.length)
        if (regen.join('') !== ks.join('') || br.seed!.join('') !== spec.seed.join('')) good = false
      }
    }
    if (good) ok(`LFSR: ${broke} secret seeds recovered by Gauss and confirmed by keystream regeneration`)
    else bad('LFSR recovery reconstructed the wrong seed')
  }

  // 9. Parser round-trips (DIMACS out→in) preserve the problem's verdict & count.
  {
    let good = true
    for (let t = 0; t < 120 && good; t++) {
      const n = 2 + Math.floor(rng() * 5)
      const p = randomKXorSat(n, 1 + Math.floor(rng() * 4), 2, (t + 3) * 5)
      const text = toXorDimacs(p)
      const back = parseXorDimacs(text)
      if (!back.ok) good = false
      else if (solutionCount(xorSystem(back.problem)) !== solutionCount(xorSystem(p))) good = false
    }
    // DSL sanity: a hand-written system parses to the intended constraints.
    const dsl = parseXorDsl('x1 ^ x2 ^ x3 = 1\n-x1 xor x2 = 0\nx1 | -x2 | x3')
    if (!dsl.ok || dsl.problem.xors.length !== 2 || dsl.problem.clauses.length !== 1) good = false
    if (good) ok('DIMACS round-trip preserves count over 120 systems; DSL parses XORs & clauses')
    else bad('parser round-trip changed the problem')
  }

  return { pass, fail, messages }
}
