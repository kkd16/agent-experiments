// The Branching mode's in-app verification suite. As everywhere else in the lab the headline check is
// *differential*: the production CTL checker (`modelcheck.ts`, symbolic pre-image fixpoints) is run
// against a completely independent oracle (`oracle.ts`, explicit backward-BFS + Tarjan SCCs) over
// hundreds of random (Kripke model, CTL formula) pairs, and they must agree at EVERY state. On top of
// that we check the adequate-basis rewrite is semantics-preserving, the textbook fixpoint identities
// hold, every emitted certificate is a real replayable behaviour, ACTL agrees with the v8 LTL
// semantics on linear models (where branching collapses), and every gallery verdict lands. All of it
// runs live, in the browser, in the Verify tab.

import type { Ctl } from './formula'
import { toAdequate } from './formula'
import { parseCtl } from './parser'
import type { CtlModel } from './modelcheck'
import { satVector, totalize, modelCheckCtl } from './modelcheck'
import { oracleSat } from './oracle'
import { certify } from './witness'
import { parseKripke } from '../ltl/kripke'
import type { Ltl } from '../ltl/formula'
import { evalLtlOnLasso } from '../ltl/semantics'
import { CTL_EXAMPLES } from './examples'

export interface CheckResult {
  name: string
  pass: boolean
  detail: string
}

export interface SelfTestReport {
  results: CheckResult[]
  passed: number
  total: number
  ok: boolean
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

const ATOMS = ['p', 'q', 'r']
const pick = <T,>(rng: () => number, xs: T[]): T => xs[Math.floor(rng() * xs.length) % xs.length]
const sameVec = (a: boolean[], b: boolean[]) => a.length === b.length && a.every((v, i) => v === b[i])

/** A random small total Kripke model (every state has 1–3 successors, so no deadlocks). */
function genModel(rng: () => number): CtlModel {
  const n = 3 + Math.floor(rng() * 4) // 3..6
  const props = Array.from({ length: n }, () => new Set(ATOMS.filter(() => rng() < 0.5)))
  const succ = Array.from({ length: n }, () => {
    const k = 1 + Math.floor(rng() * 3)
    const set = new Set<number>()
    for (let i = 0; i < k; i++) set.add(Math.floor(rng() * n))
    return [...set]
  })
  return {
    n,
    succ,
    initial: [0],
    props,
    names: Array.from({ length: n }, (_, i) => 's' + i),
    addedSelfLoops: [],
  }
}

/** A random CTL formula over ATOMS; depth-bounded so fixpoints stay tiny. */
function genCtl(rng: () => number, depth: number): Ctl {
  if (depth <= 0 || rng() < 0.3) {
    const r = rng()
    if (r < 0.1) return { k: 'true' }
    if (r < 0.2) return { k: 'false' }
    return { k: 'atom', name: pick(rng, ATOMS) }
  }
  const r = rng()
  const u = genCtl(rng, depth - 1)
  if (r < 0.1) return { k: 'not', a: u }
  if (r < 0.18) return { k: 'EX', a: u }
  if (r < 0.26) return { k: 'AX', a: u }
  if (r < 0.34) return { k: 'EF', a: u }
  if (r < 0.42) return { k: 'AF', a: u }
  if (r < 0.5) return { k: 'EG', a: u }
  if (r < 0.58) return { k: 'AG', a: u }
  const b = genCtl(rng, depth - 1)
  if (r < 0.66) return { k: 'and', a: u, b }
  if (r < 0.74) return { k: 'or', a: u, b }
  if (r < 0.8) return { k: 'imp', a: u, b }
  if (r < 0.86) return { k: 'EU', a: u, b }
  if (r < 0.92) return { k: 'AU', a: u, b }
  if (r < 0.96) return { k: 'ER', a: u, b }
  return { k: 'AR', a: u, b }
}

/** A random ACTL formula paired with its LTL projection (strip the universal quantifiers). */
function genActl(rng: () => number, depth: number): { ctl: Ctl; ltl: Ltl } {
  if (depth <= 0 || rng() < 0.35) {
    const r = rng()
    if (r < 0.1) return { ctl: { k: 'true' }, ltl: { k: 'true' } }
    if (r < 0.2) return { ctl: { k: 'false' }, ltl: { k: 'false' } }
    const name = pick(rng, ATOMS)
    return { ctl: { k: 'atom', name }, ltl: { k: 'atom', name } }
  }
  const r = rng()
  const u = genActl(rng, depth - 1)
  if (r < 0.14) return { ctl: { k: 'not', a: u.ctl }, ltl: { k: 'not', a: u.ltl } }
  if (r < 0.3) return { ctl: { k: 'AX', a: u.ctl }, ltl: { k: 'next', a: u.ltl } }
  if (r < 0.46) return { ctl: { k: 'AF', a: u.ctl }, ltl: { k: 'fin', a: u.ltl } }
  if (r < 0.6) return { ctl: { k: 'AG', a: u.ctl }, ltl: { k: 'glob', a: u.ltl } }
  const v = genActl(rng, depth - 1)
  if (r < 0.7) return { ctl: { k: 'and', a: u.ctl, b: v.ctl }, ltl: { k: 'and', a: u.ltl, b: v.ltl } }
  if (r < 0.8) return { ctl: { k: 'or', a: u.ctl, b: v.ctl }, ltl: { k: 'or', a: u.ltl, b: v.ltl } }
  if (r < 0.9) return { ctl: { k: 'AU', a: u.ctl, b: v.ctl }, ltl: { k: 'until', a: u.ltl, b: v.ltl } }
  return { ctl: { k: 'AR', a: u.ctl, b: v.ctl }, ltl: { k: 'release', a: u.ltl, b: v.ltl } }
}

export function runSelfTest(): SelfTestReport {
  const results: CheckResult[] = []
  const add = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail })

  // 1. Parser — a battery of well-formed CTL formulas parses, malformed ones report an error.
  {
    const good = [
      'EF p', 'AG !bad', 'EX p', 'AX q', 'AF done', 'EG running', 'E[p U q]', 'A[p R q]',
      'AG EF restart', 'AG (req -> AF ack)', 'AF AG p', 'E[a W b]', '!(EX p & AF q)',
    ]
    const bad = ['', 'X p', 'E p', 'A', 'EF', 'E[p U]', 'p U q', 'EX', '(p', 'A[p q]']
    const goodOk = good.every((s) => parseCtl(s).ok)
    const badOk = bad.every((s) => !parseCtl(s).ok)
    add('parser: well-formed accepted, malformed rejected', goodOk && badOk, `${good.length} parsed, ${bad.length} rejected`)
  }

  // 2. Headline differential: the fixpoint checker and the SCC/reachability oracle agree everywhere.
  {
    const rng = mulberry32(0x5eed)
    let tested = 0
    let mismatches = 0
    for (let i = 0; i < 400; i++) {
      const m = genModel(rng)
      const f = genCtl(rng, 3)
      const a = satVector(f, m)
      const b = oracleSat(f, m)
      tested++
      if (!sameVec(a, b)) mismatches++
    }
    add(
      'labelling ≡ oracle: fixpoints match SCC/reachability at every state',
      mismatches === 0,
      `${tested} random (model, formula) pairs, ${mismatches} mismatch${mismatches === 1 ? '' : 'es'}`,
    )
  }

  // 3. Adequacy: rewriting into {¬, ∧, EX, EU, EG} preserves the labelled set exactly.
  {
    const rng = mulberry32(0xa11ce)
    let tested = 0
    let bad = 0
    for (let i = 0; i < 300; i++) {
      const m = genModel(rng)
      const f = genCtl(rng, 3)
      const direct = satVector(f, m)
      const viaAdequate = satVector(toAdequate(f), m)
      tested++
      if (!sameVec(direct, viaAdequate)) bad++
    }
    add('adequacy: the {¬,∧,EX,EU,EG} rewrite is semantics-preserving', bad === 0, `${tested} formulas, ${bad} off`)
  }

  // 4. Fixpoint identities, checked state-wise over random sub-formulas and models.
  {
    const rng = mulberry32(1234567)
    let bad = 0
    let tested = 0
    const eq = (m: CtlModel, x: Ctl, y: Ctl) => sameVec(satVector(x, m), satVector(y, m))
    for (let i = 0; i < 200; i++) {
      const m = genModel(rng)
      const a = genCtl(rng, 2)
      const b = genCtl(rng, 2)
      const na: Ctl = { k: 'not', a }
      const nb: Ctl = { k: 'not', a: b }
      const laws: [string, Ctl, Ctl][] = [
        ['AX=¬EX¬', { k: 'AX', a }, { k: 'not', a: { k: 'EX', a: na } }],
        ['EF=E[⊤U·]', { k: 'EF', a }, { k: 'EU', a: { k: 'true' }, b: a }],
        ['AG=¬E[⊤U¬·]', { k: 'AG', a }, { k: 'not', a: { k: 'EU', a: { k: 'true' }, b: na } }],
        ['AF=¬EG¬', { k: 'AF', a }, { k: 'not', a: { k: 'EG', a: na } }],
        [
          'A[·U·] expansion',
          { k: 'AU', a, b },
          {
            k: 'not',
            a: { k: 'or', a: { k: 'EU', a: nb, b: { k: 'and', a: na, b: nb } }, b: { k: 'EG', a: nb } },
          },
        ],
      ]
      for (const [, x, y] of laws) {
        tested++
        if (!eq(m, x, y)) bad++
      }
    }
    add('fixpoint identities (AX/EF/AG/AF/AU) hold state-wise', bad === 0, `${tested} instances, ${bad} off`)
  }

  // 5. ACTL ≡ LTL on linear (deterministic) models, where branching collapses to one path.
  {
    const rng = mulberry32(0x100f)
    let tested = 0
    let bad = 0
    for (let i = 0; i < 250; i++) {
      // a deterministic total model: one successor per state.
      const n = 3 + Math.floor(rng() * 4)
      const props = Array.from({ length: n }, () => new Set(ATOMS.filter(() => rng() < 0.5)))
      const succ = Array.from({ length: n }, () => [Math.floor(rng() * n)])
      const m: CtlModel = { n, succ, initial: [0], props, names: [], addedSelfLoops: [] }
      const { ctl, ltl } = genActl(rng, 3)
      // the unique infinite path from state 0 as a lasso
      const seen = new Map<number, number>()
      const seq: number[] = []
      let cur = 0
      while (!seen.has(cur)) {
        seen.set(cur, seq.length)
        seq.push(cur)
        cur = succ[cur][0]
      }
      const loopAt = seen.get(cur)!
      const prefix = seq.slice(0, loopAt).map((s) => props[s])
      const loop = seq.slice(loopAt).map((s) => props[s])
      const ctlHolds = satVector(ctl, m)[0]
      const ltlHolds = evalLtlOnLasso(ltl, prefix, loop)
      tested++
      if (ctlHolds !== ltlHolds) bad++
    }
    add('ACTL ≡ LTL on linear models (branching collapses to one path)', bad === 0, `${tested} pairs, ${bad} off`)
  }

  // 6. Witness/counterexample soundness — every certificate is a real, claim-verified behaviour.
  {
    let checked = 0
    let bad = 0
    const failures: string[] = []
    for (const ex of CTL_EXAMPLES) {
      const pf = parseCtl(ex.formula)
      const pm = parseKripke(ex.model)
      if (!pf.ok || !pm.model) {
        bad++
        failures.push(ex.name + ' (parse)')
        continue
      }
      const cert = certify(pf.formula, pm.model)
      if (!cert) continue // purely-universal holding formula: no single-behaviour certificate
      const m = totalize(pm.model)
      let ok = true
      // (a) starts at an initial state
      if (cert.states.length === 0 || !m.initial.includes(cert.states[0])) ok = false
      // (b) consecutive states are real transitions; the loop closes
      for (let i = 0; i + 1 < cert.states.length; i++) {
        if (!m.succ[cert.states[i]].includes(cert.states[i + 1])) ok = false
      }
      if (cert.loopStart !== null) {
        const last = cert.states[cert.states.length - 1]
        if (!m.succ[last].includes(cert.states[cert.loopStart])) ok = false
      }
      // (c) every obligation on every state is independently true there (parse it back, ask the oracle)
      for (let i = 0; i < cert.states.length; i++) {
        for (const o of cert.obligations[i]) {
          const po = parseCtl(o)
          if (!po.ok) continue
          if (!oracleSat(po.formula, m)[cert.states[i]]) ok = false
        }
      }
      checked++
      if (!ok) {
        bad++
        failures.push(ex.name)
      }
    }
    add(
      'certificates are real, claim-verified behaviours',
      bad === 0,
      `${checked} certificates replayed${failures.length ? ' — off: ' + failures.join('; ') : ''}`,
    )
  }

  // 7. Gallery verdicts: every example lands on its documented holds/fails verdict.
  {
    let bad = 0
    const failures: string[] = []
    for (const ex of CTL_EXAMPLES) {
      const pf = parseCtl(ex.formula)
      const pm = parseKripke(ex.model)
      if (!pf.ok || !pm.model) {
        bad++
        failures.push(ex.name + ' (parse)')
        continue
      }
      const got = modelCheckCtl(pf.formula, pm.model).holds ? 'holds' : 'fails'
      if (got !== ex.expect) {
        bad++
        failures.push(`${ex.name} (got ${got})`)
      }
    }
    add('gallery verdicts match', bad === 0, `${CTL_EXAMPLES.length} examples${failures.length ? ' — off: ' + failures.join('; ') : ''}`)
  }

  const passed = results.filter((r) => r.pass).length
  return { results, passed, total: results.length, ok: passed === results.length }
}
