// Correctness harness for the e-graph engine, in the house style: an
// **independent semantic oracle** that shares no code with the rewriter. The
// rewrites are claims about *equality*; the oracle is exact BigInt *evaluation*.
// It hammers on four fronts:
//
//   1. Invariance — an extracted (optimized) term must evaluate identically to
//      the original on every random assignment, and never cost more.
//   2. Structural — checkInvariants() (congruence closure + hashcons + analysis)
//      must hold after every saturation.
//   3. Soundness — whenever the prover says a ≡ b, the two must in fact agree on
//      every assignment; an unsound rule would be caught here.
//   4. Completeness spot-checks — reflexivity and hand-built sound rewrites must
//      actually be proved, and the curated examples must land on their answers.

import type { Term } from './term'
import { evalTerm, freeVars, printTerm } from './term'
import { optimize, prove } from './rewrite'
import { ALL_RULES, rulesFor } from './rules'
import { OPT_EXAMPLES, PROVE_EXAMPLES, mulberry32, randomTerm, tryParse } from './examples'

export interface EgraphCheckReport {
  pass: number
  fail: number
  messages: string[]
}

// The fuzz oracles (invariance, soundness) are valid at *any* saturation depth —
// they judge whatever the graph derived — so a shallow, cheap cap keeps them
// fast. Only the completeness spot-checks need to saturate enough to succeed.
const FUZZ_OPTS = { maxIters: 5, maxNodes: 120 }
const FULL_OPTS = { maxIters: 10, maxNodes: 300 }

/** Evaluate `t` on `trials` random assignments; return the list of values. */
function sampleValues(t: Term, rng: () => number, trials: number): bigint[] {
  const vars = ['a', 'b', 'c', 'x', 'y', 'z']
  const out: bigint[] = []
  for (let i = 0; i < trials; i++) {
    const env = new Map<string, bigint>()
    for (const v of vars) env.set(v, BigInt(Math.floor(rng() * 13) - 6)) // -6..6
    out.push(evalTerm(t, env))
  }
  return out
}

function equalOnSamples(a: Term, b: Term, rng: () => number, trials: number): boolean {
  const need = new Set([...freeVars(a), ...freeVars(b)])
  const vars = [...need]
  for (let i = 0; i < trials; i++) {
    const env = new Map<string, bigint>()
    for (const v of vars) env.set(v, BigInt(Math.floor(rng() * 13) - 6))
    if (evalTerm(a, env) !== evalTerm(b, env)) return false
  }
  return true
}

export function runEgraphChecks(): EgraphCheckReport {
  let pass = 0
  let fail = 0
  const messages: string[] = []
  const ok = (cond: boolean, msg: () => string) => {
    if (cond) pass++
    else {
      fail++
      if (messages.length < 12) messages.push(msg())
    }
  }

  const rng = mulberry32(0x5a7f0)

  // (1) + (2): optimize invariance + structural invariants, on random terms.
  for (let i = 0; i < 45; i++) {
    const t = randomTerm(rng, 3)
    let res
    try {
      res = optimize(t, ALL_RULES, FUZZ_OPTS)
    } catch (e) {
      ok(false, () => `optimize threw on ${printTerm(t)}: ${e instanceof Error ? e.message : e}`)
      continue
    }
    // structural oracle
    const errs = res.eg.checkInvariants()
    ok(errs.length === 0, () => `invariants on ${printTerm(t)}: ${errs[0]}`)
    // never costs more than the input
    ok(res.bestCost <= res.originalCost, () =>
      `extraction regressed: ${printTerm(t)} (${res.originalCost}) → ${printTerm(res.best)} (${res.bestCost})`,
    )
    // exact evaluation invariance
    const before = sampleValues(t, mulberry32(1000 + i), 14)
    const after = sampleValues(res.best, mulberry32(1000 + i), 14)
    const same = before.every((v, k) => v === after[k])
    ok(same, () => `NOT invariant: ${printTerm(t)} ≠ ${printTerm(res.best)}`)
  }

  // (3): prover soundness — a proved equality must hold on every assignment.
  for (let i = 0; i < 90; i++) {
    const t1 = randomTerm(rng, 3)
    const t2 = randomTerm(rng, 3)
    let pr
    try {
      pr = prove(t1, t2, ALL_RULES, FUZZ_OPTS)
    } catch (e) {
      ok(false, () => `prove threw: ${e instanceof Error ? e.message : e}`)
      continue
    }
    ok(pr.eg.checkInvariants().length === 0, () => `prove invariants broken on ${printTerm(t1)} =? ${printTerm(t2)}`)
    if (pr.proved) {
      ok(equalOnSamples(t1, t2, mulberry32(7000 + i), 24), () =>
        `UNSOUND: proved ${printTerm(t1)} ≡ ${printTerm(t2)} but they differ numerically`,
      )
    }
  }

  // (4a): completeness spot-checks — reflexivity + hand-built sound rewrites.
  const wrappers: Array<(t: Term) => Term> = [
    (t) => ({ op: '+', args: [t, { op: '0', args: [] }] }),
    (t) => ({ op: '*', args: [t, { op: '1', args: [] }] }),
    (t) => ({ op: 'neg', args: [{ op: 'neg', args: [t] }] }),
    (t) => ({ op: '+', args: [t, { op: '+', args: [{ op: 'a', args: [] }, { op: 'neg', args: [{ op: 'a', args: [] }] }] }] }),
  ]
  for (let i = 0; i < 12; i++) {
    const t = randomTerm(rng, 2)
    ok(prove(t, t, ALL_RULES, FULL_OPTS).proved, () => `reflexivity failed on ${printTerm(t)}`)
    for (const w of wrappers) {
      const t2 = w(t)
      ok(prove(t, t2, ALL_RULES, FULL_OPTS).proved, () =>
        `should prove ${printTerm(t)} ≡ ${printTerm(t2)} but did not`,
      )
    }
  }

  // (4b): the curated examples must reach their advertised answers.
  for (const ex of OPT_EXAMPLES) {
    const p = tryParse(ex.src)
    if (!p.ok) {
      ok(false, () => `example ${ex.name} failed to parse: ${p.error}`)
      continue
    }
    const res = optimize(p.term, ALL_RULES, { maxIters: 20, maxNodes: 900 })
    const before = sampleValues(p.term, mulberry32(42), 20)
    const after = sampleValues(res.best, mulberry32(42), 20)
    ok(before.every((v, k) => v === after[k]), () => `example ${ex.name}: optimization changed the meaning`)
    ok(res.bestCost <= res.originalCost, () => `example ${ex.name}: extraction did not improve cost`)
  }
  for (const ex of PROVE_EXAMPLES) {
    const l = tryParse(ex.lhs)
    const r = tryParse(ex.rhs)
    if (!l.ok || !r.ok) {
      ok(false, () => `prove example ${ex.name} failed to parse`)
      continue
    }
    ok(prove(l.term, r.term, ALL_RULES, { maxIters: 25, maxNodes: 900 }).proved, () =>
      `prove example ${ex.name} should hold: ${ex.lhs} ≡ ${ex.rhs}`,
    )
  }

  // (4c): constant folding really collapses a product of constants.
  for (let i = 0; i < 20; i++) {
    const k = Math.floor(rng() * 9) + 1
    const m = Math.floor(rng() * 9) + 1
    const t: Term = { op: '*', args: [{ op: String(k), args: [] }, { op: String(m), args: [] }] }
    const res = optimize(t, rulesFor(new Set(['Identities & annihilation'])), FUZZ_OPTS)
    ok(res.eg.constantOf(res.rootId) === BigInt(k * m), () => `const-fold ${k}*${m} ≠ ${k * m}`)
    ok(printTerm(res.best) === String(k * m), () => `const-fold extracted ${printTerm(res.best)} for ${k}*${m}`)
  }

  return { pass, fail, messages }
}
