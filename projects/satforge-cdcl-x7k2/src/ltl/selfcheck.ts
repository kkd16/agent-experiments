// Correctness harness for the model checker, in the house style: an
// **independent semantic oracle** (the word-level LTL evaluator in `ltleval.ts`,
// which shares no code with the tableau) referees every verdict.
//
// The cornerstone is the *single-lasso* test. For a random formula φ and a
// random ultimately-periodic word w, wrap w as a one-path Kripke structure K_w
// (a ρ-shaped ring). K_w has exactly one run — w itself — so
//   modelCheck(K_w, φ).holds  ⟺  w ⊨ φ.
// The left side exercises the *entire* pipeline (NNF, GPVW tableau,
// degeneralized product, nested-DFS emptiness, counterexample extraction); the
// right side is the direct fixpoint semantics. Agreement over thousands of
// random (φ, w) is a decisive check that the automaton construction is sound
// **and** complete. Further fronts:
//   · parser/printer round-trips,
//   · NNF preserves meaning on every word,
//   · nested DFS agrees with the independent BFS lasso finder,
//   · every reported counterexample is a genuine path that really violates φ,
//   · a brute-force lasso enumerator never finds a witness the checker missed,
//   · the curated gallery lands on its documented verdicts.

import type { Ltl } from './ast'
import { key, printLtl } from './ast'
import { buildGba } from './buchi'
import type { Counterexample } from './check'
import { counterexampleWord, modelCheck } from './check'
import { findLasso, nestedDfs } from './emptiness'
import { EXAMPLES, mulberry32, randomKripke, randomLassoWord, randomLtl } from './examples'
import type { Kripke } from './kripke'
import { parseKripke } from './kripke'
import { toNnf } from './nnf'
import { parseLtl } from './parse'
import { buildProduct } from './product'
import { satisfiesLasso } from './ltleval'

export interface LtlCheckReport {
  pass: number
  fail: number
  messages: string[]
}

const APS = ['p', 'q', 'r']

/** A one-path Kripke structure whose single run is the given lasso word. */
function lassoKripke(word: { letters: Set<string>[]; loopStart: number }): Kripke {
  const n = word.letters.length
  const states = word.letters.map((ls, i) => ({ id: i, name: 's' + i, labels: [...ls].sort() }))
  const edges: number[][] = []
  for (let i = 0; i < n; i++) edges.push([i + 1 < n ? i + 1 : word.loopStart])
  const aps = [...new Set(states.flatMap((s) => s.labels))].sort()
  return { states, init: [0], edges, aps }
}

/** Validate that a counterexample is a genuine run of K that violates φ. */
function counterexampleValid(k: Kripke, phi: Ltl, cex: Counterexample): { ok: boolean; why: string } {
  const path = [...cex.stem, ...cex.loop]
  if (path.length === 0) return { ok: false, why: 'empty counterexample' }
  if (cex.loop.length === 0) return { ok: false, why: 'counterexample has no loop' }
  if (!k.init.includes(path[0])) return { ok: false, why: 'stem does not start at an initial state' }
  // consecutive edges along stem+loop
  for (let i = 0; i + 1 < path.length; i++) {
    if (!k.edges[path[i]].includes(path[i + 1])) return { ok: false, why: `no edge ${path[i]}→${path[i + 1]}` }
  }
  // closing edge: last state of the loop back to the loop entry
  const lastLoop = cex.loop[cex.loop.length - 1]
  if (!k.edges[lastLoop].includes(cex.loop[0])) return { ok: false, why: 'loop does not close' }
  // the run must violate φ (i.e. satisfy ¬φ)
  const word = counterexampleWord(k, cex)
  if (satisfiesLasso(phi, word)) return { ok: false, why: 'reported counterexample actually satisfies φ' }
  return { ok: true, why: '' }
}

/** Brute-force: does any simple lasso of K violate φ (per the oracle)? */
function bruteForceViolation(k: Kripke, phi: Ltl): boolean {
  let found = false
  const dfs = (path: number[]): void => {
    if (found) return
    const last = path[path.length - 1]
    for (let i = 0; i < path.length - 1; i++) {
      if (path[i] === last) {
        // A cycle closed: stem = path[0..i-1], loop = path[i..end-1].
        const stem = path.slice(0, i)
        const loop = path.slice(i, path.length - 1)
        const letters = [...stem, ...loop].map((s) => new Set(k.states[s].labels))
        if (!satisfiesLasso(phi, { letters, loopStart: stem.length })) found = true
        return // stop extending past the first repeat (simple lassos)
      }
    }
    for (const t of k.edges[last]) dfs([...path, t])
  }
  for (const s of k.init) dfs([s])
  return found
}

export function runLtlChecks(): LtlCheckReport {
  let pass = 0
  let fail = 0
  const messages: string[] = []
  const ok = (cond: boolean, msg: () => string): void => {
    if (cond) pass++
    else {
      fail++
      if (messages.length < 40) messages.push('✗ ' + msg())
    }
  }

  // 1 — parser / printer round-trips on the curated formulas and random ones.
  for (const ex of EXAMPLES) {
    let f: Ltl | null = null
    try {
      f = parseLtl(ex.formula)
    } catch (e) {
      ok(false, () => `parse failed on "${ex.formula}": ${(e as Error).message}`)
    }
    if (f) ok(key(parseLtl(printLtl(f))) === key(f), () => `round-trip mismatch on "${ex.formula}"`)
  }
  {
    const rng = mulberry32(0xc0ffee)
    for (let i = 0; i < 300; i++) {
      const f = randomLtl(rng, 4, APS)
      const s = printLtl(f)
      let reparsed: Ltl | null = null
      try {
        reparsed = parseLtl(s)
      } catch (e) {
        ok(false, () => `printed formula did not re-parse: "${s}" — ${(e as Error).message}`)
      }
      if (reparsed) ok(key(reparsed) === key(f), () => `print∘parse changed the formula: "${s}"`)
    }
  }

  // 2 — NNF preserves meaning on every word; ¬-NNF flips it.
  {
    const rng = mulberry32(0x123456)
    for (let i = 0; i < 500; i++) {
      const f = randomLtl(rng, 4, APS)
      const w = randomLassoWord(rng, APS)
      ok(satisfiesLasso(f, w) === satisfiesLasso(toNnf(f, false), w), () => `NNF changed meaning of "${printLtl(f)}"`)
      ok(satisfiesLasso(toNnf(f, true), w) === !satisfiesLasso(f, w), () => `¬NNF wrong for "${printLtl(f)}"`)
    }
  }

  // 3 — CORNERSTONE: single-lasso pipeline verdict == oracle, per word.
  {
    const rng = mulberry32(0x5a17ed)
    for (let i = 0; i < 2500; i++) {
      const f = randomLtl(rng, 4, APS)
      const w = randomLassoWord(rng, APS)
      const kw = lassoKripke(w)
      let res
      try {
        res = modelCheck(kw, f)
      } catch (e) {
        ok(false, () => `modelCheck threw on lasso for "${printLtl(f)}": ${(e as Error).message}`)
        continue
      }
      const oracle = satisfiesLasso(f, w)
      ok(res.holds === oracle, () => `single-lasso verdict ${res.holds} ≠ oracle ${oracle} for "${printLtl(f)}"`)
      if (!res.holds) {
        if (!res.counterexample) ok(false, () => `no counterexample though φ fails: "${printLtl(f)}"`)
        else ok(counterexampleValid(kw, f, res.counterexample).ok, () => `invalid counterexample for "${printLtl(f)}": ${counterexampleValid(kw, f, res.counterexample!).why}`)
      }
    }
  }

  // 4 — nested DFS agrees with the independent BFS lasso finder.
  {
    const rng = mulberry32(0x0badf00d)
    for (let i = 0; i < 800; i++) {
      const f = randomLtl(rng, 3, APS)
      const k = randomKripke(rng, APS, 4)
      let empty1: boolean
      let empty2: boolean
      try {
        const gba = buildGba({ k: 'not', a: f })
        const prod = buildProduct(k, gba)
        empty1 = nestedDfs(prod).empty
        empty2 = findLasso(prod) === null
      } catch (e) {
        ok(false, () => `emptiness threw for "${printLtl(f)}": ${(e as Error).message}`)
        continue
      }
      ok(empty1 === empty2, () => `nested-DFS (${empty1}) ≠ BFS (${empty2}) for "${printLtl(f)}"`)
    }
  }

  // 5 — random Kripke × formula: brute-force never beats the checker; CEX valid.
  {
    const rng = mulberry32(0xfeedbeef)
    for (let i = 0; i < 800; i++) {
      const f = randomLtl(rng, 3, APS)
      const k = randomKripke(rng, APS, 4)
      let res
      try {
        res = modelCheck(k, f)
      } catch (e) {
        ok(false, () => `modelCheck threw for "${printLtl(f)}": ${(e as Error).message}`)
        continue
      }
      const bruteFound = bruteForceViolation(k, f)
      // A real violating lasso means φ cannot hold.
      if (bruteFound) ok(!res.holds, () => `brute force found a counterexample but checker says HOLDS for "${printLtl(f)}"`)
      if (!res.holds && res.counterexample) {
        const v = counterexampleValid(k, f, res.counterexample)
        ok(v.ok, () => `invalid counterexample (random K) for "${printLtl(f)}": ${v.why}`)
      }
    }
  }

  // 6 — curated gallery lands on its documented verdicts, with valid CEXs.
  for (const ex of EXAMPLES) {
    let k: Kripke
    let f: Ltl
    try {
      k = parseKripke(ex.kripke)
      f = parseLtl(ex.formula)
    } catch (e) {
      ok(false, () => `example "${ex.name}" failed to parse: ${(e as Error).message}`)
      continue
    }
    const res = modelCheck(k, f)
    ok(res.holds === ex.holds, () => `example "${ex.name}": got holds=${res.holds}, expected ${ex.holds}`)
    if (!res.holds && res.counterexample) {
      const v = counterexampleValid(k, f, res.counterexample)
      ok(v.ok, () => `example "${ex.name}" counterexample invalid: ${v.why}`)
    }
  }

  messages.unshift(`${pass} passed, ${fail} failed`)
  return { pass, fail, messages }
}
