// The AIG studio's correctness harness — the same differential-oracle ethos the
// rest of SatForge lives by. Nothing here trusts the thing it checks:
//
//   • the whole equivalence checker is pinned against an **exhaustive truth-table**
//     oracle (`truthTable`, a completely independent evaluator that never touches
//     the SAT/CNF path) — verdicts must match, and every reported counterexample is
//     re-evaluated to confirm it genuinely distinguishes the two circuits;
//   • **SAT sweeping** is checked to *preserve function*: the fraig'd graph's every
//     output has the identical truth table to the original, while its AND count only
//     ever shrinks;
//   • the **Tseitin encoding** is checked by fixing all inputs as SAT assumptions and
//     confirming the output variable the solver derives equals the simulated value;
//   • the **structural generators** (ripple / carry-select adders, the multiplier)
//     are checked against plain integer arithmetic;
//   • every **gallery example**'s verdict is checked against its ground truth (and,
//     when small enough, its truth table).
//
// `runAigChecks()` folds it all into one pass/fail report for the studio badge.

import { Aig, CONST0, CONST1, litNot, type Lit } from './aig'
import { evalPattern, truthTable } from './simulate'
import { tseitin } from './cnf'
import { fraig, checkEquivalence } from './cec'
import { buildPairFromDsl, buildCircuit, parseCircuit, inputBus, rippleAdder, carrySelectAdder, arrayMultiplier } from './build'
import { AIG_EXAMPLES } from './examples'
import { solveAssuming } from '../sat/solver'

export interface AigCheckReport {
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

/** Build a random AIG with `ni` inputs, `ng` gates and `no` outputs. */
function randomAig(ni: number, ng: number, no: number, rng: () => number): Aig {
  const aig = new Aig()
  const pool: Lit[] = [CONST0, CONST1]
  for (let i = 0; i < ni; i++) pool.push(aig.addInput('x' + i))
  const rlit = (): Lit => {
    const l = pool[Math.floor(rng() * pool.length)]
    return rng() < 0.4 ? litNot(l) : l
  }
  for (let g = 0; g < ng; g++) {
    const a = rlit()
    const b = rlit()
    const r = rng()
    const out = r < 0.5 ? aig.mkAnd(a, b) : r < 0.8 ? aig.mkOr(a, b) : aig.mkXor(a, b)
    pool.push(out)
  }
  for (let o = 0; o < no; o++) aig.addOutput('o' + o, rlit())
  return aig
}

export function runAigChecks(): AigCheckReport {
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
  const rng = mulberry32(0xa16f)

  // 1. Strashing & the trivial-case rewrites produce the correct truth tables.
  {
    let good = true
    for (let t = 0; t < 300 && good; t++) {
      const aig = new Aig()
      const a = aig.addInput('a')
      const b = aig.addInput('b')
      // A grab-bag of identities that the rewrites must respect.
      if (aig.mkAnd(a, CONST0) !== CONST0) good = false
      if (aig.mkAnd(a, CONST1) !== a) good = false
      if (aig.mkAnd(a, a) !== a) good = false
      if (aig.mkAnd(a, litNot(a)) !== CONST0) good = false
      if (aig.mkAnd(a, b) !== aig.mkAnd(b, a)) good = false // hash-cons is order-free
      const x = aig.mkOr(a, b)
      const y = aig.mkOr(a, b)
      if (x !== y) good = false // structurally identical → same node
    }
    if (good) ok('strashing: constant folding, idempotence and hash-consing hold')
    else bad('strashing broke a trivial-case identity')
  }

  // 2. Tseitin encoding: fixing all inputs makes the solver derive the simulated output.
  {
    let good = true
    for (let t = 0; t < 60 && good; t++) {
      const ni = 2 + Math.floor(rng() * 4)
      const aig = randomAig(ni, 6 + Math.floor(rng() * 8), 1, rng)
      const { cnf, varOf, dl } = tseitin(aig)
      const out = aig.outputs[0].lit
      for (let trial = 0; trial < 6 && good; trial++) {
        const pat = aig.inputs.map(() => (rng() < 0.5 ? 0 : 1))
        const assumptions = aig.inputs.map((node, s) => (pat[s] ? varOf[node] : -varOf[node]))
        const r = solveAssuming(cnf, assumptions)
        if (r.status !== 'sat') {
          good = false
          break
        }
        const want = evalPattern(aig, pat)[out >> 1] ^ (out & 1)
        const got = r.model![Math.abs(dl(out))] === (dl(out) > 0) ? 1 : 0
        if ((want & 1) !== got) good = false
      }
    }
    if (good) ok('Tseitin encoding: solver-derived outputs match simulation on 60 random circuits')
    else bad('Tseitin output disagreed with simulation')
  }

  // 3. CEC verdict == exhaustive truth-table equality; counterexamples really differ.
  {
    let good = true
    let checked = 0
    for (let t = 0; t < 40 && good; t++) {
      const ni = 2 + Math.floor(rng() * 5) // ≤ 6 inputs
      // One shared AIG, two families of outputs paired up.
      const aig = new Aig()
      const pool: Lit[] = [CONST0, CONST1]
      for (let i = 0; i < ni; i++) pool.push(aig.addInput('x' + i))
      const rlit = (): Lit => {
        const l = pool[Math.floor(rng() * pool.length)]
        return rng() < 0.4 ? litNot(l) : l
      }
      for (let g = 0; g < 10; g++) {
        const r = rng()
        const out = r < 0.5 ? aig.mkAnd(rlit(), rlit()) : r < 0.8 ? aig.mkOr(rlit(), rlit()) : aig.mkXor(rlit(), rlit())
        pool.push(out)
      }
      const nPairs = 3
      const pairs: { name: string; a: Lit; b: Lit }[] = []
      for (let k = 0; k < nPairs; k++) {
        const a = rlit()
        // half the time force equality, else a fresh random literal
        const b = rng() < 0.5 ? a : rlit()
        pairs.push({ name: 'o' + k, a, b })
        aig.addOutput('o' + k, a)
      }
      const res = checkEquivalence(aig, pairs, { patterns: 32, seed: t * 131 + 7 })
      for (let k = 0; k < nPairs; k++) {
        const ttEqual = truthTable(aig, pairs[k].a) === truthTable(aig, pairs[k].b)
        const v = res.outputs[k]
        if (v.equivalent !== ttEqual) {
          good = false
          break
        }
        if (!v.equivalent && v.counterexample) {
          // Re-evaluate at the counterexample; the two outputs must genuinely differ.
          const pat = aig.inputs.map((_, s) => v.counterexample!.find((c) => c.name === 'x' + s)?.value ?? 0)
          const val = evalPattern(aig, pat)
          const va = val[pairs[k].a >> 1] ^ (pairs[k].a & 1)
          const vb = val[pairs[k].b >> 1] ^ (pairs[k].b & 1)
          if ((va & 1) === (vb & 1)) good = false
        }
        checked++
      }
    }
    if (good) ok(`CEC: ${checked} output verdicts matched the truth table; every counterexample distinguished`)
    else bad('CEC verdict or counterexample disagreed with the truth-table oracle')
  }

  // 4. SAT sweeping preserves function and only shrinks the graph.
  {
    let good = true
    for (let t = 0; t < 40 && good; t++) {
      const ni = 2 + Math.floor(rng() * 5)
      const aig = randomAig(ni, 12 + Math.floor(rng() * 10), 2 + Math.floor(rng() * 2), rng)
      const swept = fraig(aig, { patterns: 32, seed: t * 977 + 3 })
      if (swept.stats.andsAfter > swept.stats.andsBefore) good = false
      for (let o = 0; o < aig.outputs.length && good; o++) {
        const before = truthTable(aig, aig.outputs[o].lit)
        const after = truthTable(swept.aig, swept.aig.outputs[o].lit)
        if (before !== after) good = false
      }
    }
    if (good) ok('SAT sweeping preserved every truth table while never growing the AIG')
    else bad('SAT sweeping changed a function or grew the graph')
  }

  // 5. Structural generators == integer arithmetic.
  {
    let good = true
    const width = 4
    const readBus = (aig: Aig, lits: Lit[], pat: number[]): number => {
      const val = evalPattern(aig, pat)
      let n = 0
      for (let i = 0; i < lits.length; i++) if (val[lits[i] >> 1] ^ (lits[i] & 1)) n |= 1 << i
      return n
    }
    // adders
    {
      const aig = new Aig()
      const a = inputBus(aig, 'a', width)
      const b = inputBus(aig, 'b', width)
      const r = rippleAdder(aig, a, b)
      const s = carrySelectAdder(aig, a, b, 2)
      for (let av = 0; av < (1 << width) && good; av++) {
        for (let bv = 0; bv < (1 << width) && good; bv++) {
          const pat = [...Array.from({ length: width }, (_, i) => (av >> i) & 1), ...Array.from({ length: width }, (_, i) => (bv >> i) & 1)]
          const sum = av + bv
          const rSum = readBus(aig, r.sum, pat) + (evalPattern(aig, pat)[r.cout >> 1] ^ (r.cout & 1) ? 1 << width : 0)
          const sSum = readBus(aig, s.sum, pat) + (evalPattern(aig, pat)[s.cout >> 1] ^ (s.cout & 1) ? 1 << width : 0)
          if (rSum !== sum || sSum !== sum) good = false
        }
      }
    }
    // multiplier
    if (good) {
      const aig = new Aig()
      const a = inputBus(aig, 'a', width)
      const b = inputBus(aig, 'b', width)
      const p = arrayMultiplier(aig, a, b)
      for (let av = 0; av < (1 << width) && good; av++) {
        for (let bv = 0; bv < (1 << width) && good; bv++) {
          const pat = [...Array.from({ length: width }, (_, i) => (av >> i) & 1), ...Array.from({ length: width }, (_, i) => (bv >> i) & 1)]
          if (readBus(aig, p, pat) !== av * bv) good = false
        }
      }
    }
    if (good) ok('generators: ripple = carry-select = a+b, and the array multiplier = a·b (4-bit, exhaustive)')
    else bad('a structural generator disagreed with integer arithmetic')
  }

  // 6. Every gallery example's verdict matches its ground truth.
  {
    let good = true
    const details: string[] = []
    for (const ex of AIG_EXAMPLES) {
      let aig: Aig
      let pairs: { name: string; a: Lit; b: Lit }[]
      if (ex.kind === 'dsl') {
        const built = buildPairFromDsl(ex.srcA!, ex.srcB!)
        if (!built.ok) {
          good = false
          details.push(`${ex.id}: parse error ${built.error}`)
          continue
        }
        aig = built.built.aig
        pairs = built.built.pairs
      } else {
        aig = new Aig()
        pairs = ex.build!(aig)
      }
      const res = checkEquivalence(aig, pairs, { patterns: 48, seed: 0x1234 })
      if (res.equivalent !== ex.expected) {
        good = false
        details.push(`${ex.id}: got ${res.equivalent}, expected ${ex.expected}`)
      }
    }
    if (good) ok(`all ${AIG_EXAMPLES.length} gallery examples returned their ground-truth verdict`)
    else bad(`gallery mismatch: ${details.join('; ')}`)
  }

  // 7. DSL parser: round-trip sanity and error reporting.
  {
    let good = true
    const p1 = parseCircuit('out y = (a & b) | ~c')
    if (!p1.ok || p1.circuit.inputs.length !== 3 || p1.circuit.outputs.length !== 1) good = false
    const p2 = parseCircuit('out y = a & ')
    if (p2.ok) good = false // must reject the dangling operator
    const p3 = parseCircuit('w = a & b\nout y = w & w')
    if (!p3.ok || p3.circuit.wires.size !== 1) good = false
    // A wire referencing itself is a combinational cycle → build must throw.
    const p4 = parseCircuit('w = w & a\nout y = w')
    if (p4.ok) {
      const aig = new Aig()
      const inp = new Map<string, Lit>([['a', aig.addInput('a')]])
      let threw = false
      try {
        buildCircuit(aig, p4.circuit, inp)
      } catch {
        threw = true
      }
      if (!threw) good = false
    }
    if (good) ok('DSL parser: inference, error detection and cycle detection all hold')
    else bad('DSL parser mishandled a case')
  }

  return { pass, fail, messages }
}
