// The CTL* mode's in-app verification suite — the same differential discipline the rest of the lab
// lives by, now aimed at the Emerson–Lei checker. The headline checks pit the production engine
// against engines that share NO code with it:
//
//   • on the CTL fragment — every CTL* formula whose quantifiers hug a temporal operator — the GPVW
//     path-existence engine driving Emerson–Lei must agree, state for state, with the Branching
//     mode's symbolic-fixpoint CTL checker (and so, transitively, its own SCC oracle);
//   • on the linear fragment — `A ρ` / `E ρ` over a deterministic model — it must agree with the
//     Logic mode's DIRECT ω-word semantics (`evalLtlOnLasso`), the automaton-free ground truth;
//   • on FULL CTL*, with genuine nesting, the production GPVW engine must agree with the independent
//     Tarjan-SCC path-existence oracle across hundreds of random (model, formula) pairs;
//
// plus the `A ρ = ¬E¬ρ` duality, certificate soundness (every witness lasso replays under the direct
// semantics and is a real model path), and the gallery verdicts. All of it runs live in the browser.

import type { Star } from './formula'
import { ctlToStar, starToLtl } from './formula'
import { parseStar } from './parser'
import { satVectorStar, modelCheckStarOn, checkWellFormed } from './modelcheck'
import { pathExistOracle } from './oracle'
import type { CtlModel } from '../ctl/modelcheck'
import { satVector as ctlSatVector } from '../ctl/modelcheck'
import type { Ctl } from '../ctl/formula'
import type { Ltl } from '../ltl/formula'
import { evalLtlOnLasso } from '../ltl/semantics'
import { parseKripke } from '../ltl/kripke'
import { totalize } from '../ctl/modelcheck'
import { STAR_EXAMPLES } from './examples'

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

/** A random small total Kripke model (1–3 successors per state ⇒ no deadlocks). */
function genModel(rng: () => number): CtlModel {
  const n = 3 + Math.floor(rng() * 4) // 3..6
  const props = Array.from({ length: n }, () => new Set(ATOMS.filter(() => rng() < 0.5)))
  const succ = Array.from({ length: n }, () => {
    const k = 1 + Math.floor(rng() * 3)
    const set = new Set<number>()
    for (let i = 0; i < k; i++) set.add(Math.floor(rng() * n))
    return [...set]
  })
  return { n, succ, initial: [0], props, names: Array.from({ length: n }, (_, i) => 's' + i), addedSelfLoops: [] }
}

/** A deterministic total model: exactly one successor per state ⇒ a single infinite path from s0. */
function genDetModel(rng: () => number): CtlModel {
  const n = 3 + Math.floor(rng() * 4)
  const props = Array.from({ length: n }, () => new Set(ATOMS.filter(() => rng() < 0.5)))
  const succ = Array.from({ length: n }, () => [Math.floor(rng() * n)])
  return { n, succ, initial: [0], props, names: Array.from({ length: n }, (_, i) => 's' + i), addedSelfLoops: [] }
}

/** A random CTL formula (depth-bounded), to drive the differential against the CTL labelling engine. */
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

/** A random *pure-LTL* path formula (no quantifiers), as a Star. */
function genLtlStar(rng: () => number, depth: number): Star {
  if (depth <= 0 || rng() < 0.35) {
    const r = rng()
    if (r < 0.12) return { k: 'true' }
    if (r < 0.24) return { k: 'false' }
    return { k: 'atom', name: pick(rng, ATOMS) }
  }
  const r = rng()
  const u = genLtlStar(rng, depth - 1)
  if (r < 0.16) return { k: 'not', a: u }
  if (r < 0.3) return { k: 'next', a: u }
  if (r < 0.44) return { k: 'fin', a: u }
  if (r < 0.58) return { k: 'glob', a: u }
  const b = genLtlStar(rng, depth - 1)
  if (r < 0.68) return { k: 'and', a: u, b }
  if (r < 0.78) return { k: 'or', a: u, b }
  if (r < 0.88) return { k: 'imp', a: u, b }
  if (r < 0.94) return { k: 'until', a: u, b }
  return { k: 'release', a: u, b }
}

/** A random well-formed CTL* *state* formula with genuine nesting. */
function genState(rng: () => number, depth: number): Star {
  if (depth <= 0 || rng() < 0.25) {
    const r = rng()
    if (r < 0.12) return { k: 'true' }
    if (r < 0.24) return { k: 'false' }
    return { k: 'atom', name: pick(rng, ATOMS) }
  }
  const r = rng()
  if (r < 0.16) return { k: 'not', a: genState(rng, depth - 1) }
  if (r < 0.28) return { k: 'and', a: genState(rng, depth - 1), b: genState(rng, depth - 1) }
  if (r < 0.4) return { k: 'or', a: genState(rng, depth - 1), b: genState(rng, depth - 1) }
  if (r < 0.46) return { k: 'imp', a: genState(rng, depth - 1), b: genState(rng, depth - 1) }
  return { k: rng() < 0.5 ? 'E' : 'A', a: genPath(rng, depth - 1) }
}

/** A random CTL* path formula: a state formula, or a temporal/boolean combination of path formulas. */
function genPath(rng: () => number, depth: number): Star {
  if (depth <= 0 || rng() < 0.35) return genState(rng, depth)
  const r = rng()
  const u = genPath(rng, depth - 1)
  if (r < 0.18) return { k: 'next', a: u }
  if (r < 0.32) return { k: 'fin', a: u }
  if (r < 0.46) return { k: 'glob', a: u }
  if (r < 0.56) return { k: 'not', a: u }
  const b = genPath(rng, depth - 1)
  if (r < 0.66) return { k: 'and', a: u, b }
  if (r < 0.76) return { k: 'or', a: u, b }
  if (r < 0.88) return { k: 'until', a: u, b }
  return { k: 'release', a: u, b }
}

/** The unique infinite path from state 0 of a deterministic model, as a lasso of label-sets. */
function detLasso(m: CtlModel): { prefix: Set<string>[]; loop: Set<string>[] } {
  const seen = new Map<number, number>()
  const seq: number[] = []
  let cur = 0
  while (!seen.has(cur)) {
    seen.set(cur, seq.length)
    seq.push(cur)
    cur = m.succ[cur][0]
  }
  const loopAt = seen.get(cur)!
  return {
    prefix: seq.slice(0, loopAt).map((s) => m.props[s]),
    loop: seq.slice(loopAt).map((s) => m.props[s]),
  }
}

export function runSelfTest(): SelfTestReport {
  const results: CheckResult[] = []
  const add = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail })

  // 1. Parser — well-formed CTL* accepted, malformed rejected, bare-temporal flagged non-state.
  {
    const good = [
      'E[G F p]', 'A[F G p]', 'A G E F reset', 'EF AG p', 'E[(G p) U q]',
      'A[(G F req) -> (G F ack)]', '!E[F G p]', 'E F A G p', 'A[G(req -> F ack)]', 'AG p & q',
    ]
    const bad = ['', 'E', 'A', 'E[p U]', '(p', 'p &', 'A[]', 'E G']
    const nonState = ['F p', 'p & F q', 'G p', 'X p'] // parse, but not state formulas
    const goodOk = good.every((s) => {
      const r = parseStar(s)
      return r.ok && checkWellFormed(r.formula).ok
    })
    const badOk = bad.every((s) => !parseStar(s).ok)
    const nonOk = nonState.every((s) => {
      const r = parseStar(s)
      return r.ok && !checkWellFormed(r.formula).ok
    })
    add('parser: well-formed CTL* accepted, malformed rejected, bare-temporal flagged', goodOk && badOk && nonOk, `${good.length} ok, ${bad.length} rejected, ${nonState.length} non-state caught`)
  }

  // 2. Headline differential — on the CTL fragment, Emerson–Lei (GPVW) ≡ the CTL labelling engine.
  {
    const rng = mulberry32(0xc715a4)
    let tested = 0
    let mismatches = 0
    for (let i = 0; i < 700; i++) {
      const m = genModel(rng)
      const c = genCtl(rng, 3)
      const a = satVectorStar(ctlToStar(c), m) // CTL* engine on the CTL embedding
      const b = ctlSatVector(c, m) // the independent CTL fixpoint engine
      tested++
      if (!sameVec(a, b)) mismatches++
    }
    add('CTL ⊂ CTL*: Emerson–Lei ≡ the CTL labelling engine at every state', mismatches === 0, `${tested} random (model, CTL formula) pairs, ${mismatches} mismatch${mismatches === 1 ? '' : 'es'}`)
  }

  // 3. Full-CTL* differential — the GPVW engine ≡ the independent SCC path-existence oracle.
  {
    const rng = mulberry32(0x5eed51)
    let tested = 0
    let mismatches = 0
    for (let i = 0; i < 350; i++) {
      const m = genModel(rng)
      const phi = genState(rng, 3)
      const a = satVectorStar(phi, m) // GPVW + BFS-lasso emptiness
      const b = satVectorStar(phi, m, pathExistOracle) // GPVW + Tarjan-SCC emptiness + replay
      tested++
      if (!sameVec(a, b)) mismatches++
    }
    add('full CTL*: GPVW emptiness ≡ the independent SCC oracle at every state', mismatches === 0, `${tested} random (model, CTL* formula) pairs, ${mismatches} mismatch${mismatches === 1 ? '' : 'es'}`)
  }

  // 4. Linear fragment — `A ρ` / `E ρ` on a deterministic model ≡ the direct ω-word semantics.
  {
    const rng = mulberry32(0x11fea7)
    let tested = 0
    let bad = 0
    for (let i = 0; i < 400; i++) {
      const m = genDetModel(rng)
      const rho = genLtlStar(rng, 3)
      const ltl: Ltl = starToLtl(rho)
      const { prefix, loop } = detLasso(m)
      const truth = evalLtlOnLasso(ltl, prefix, loop) // the one path, by direct semantics
      const aHolds = satVectorStar({ k: 'A', a: rho }, m)[0]
      const eHolds = satVectorStar({ k: 'E', a: rho }, m)[0]
      tested++
      // On a deterministic model there is exactly one path, so A ρ ⇔ E ρ ⇔ (that path ⊨ ρ).
      if (aHolds !== truth || eHolds !== truth) bad++
    }
    add('linear fragment: A ρ / E ρ ≡ direct LTL semantics on deterministic models', bad === 0, `${tested} random pure-LTL bodies, ${bad} off`)
  }

  // 5. Duality `A ρ ≡ ¬ E ¬ρ`, state-wise over random bodies and models.
  {
    const rng = mulberry32(0xd7a11)
    let tested = 0
    let bad = 0
    for (let i = 0; i < 300; i++) {
      const m = genModel(rng)
      const rho = genLtlStar(rng, 3)
      const aRho: Star = { k: 'A', a: rho }
      const notENot: Star = { k: 'not', a: { k: 'E', a: { k: 'not', a: rho } } }
      tested++
      if (!sameVec(satVectorStar(aRho, m), satVectorStar(notENot, m))) bad++
    }
    add('duality: A ρ ≡ ¬E¬ρ at every state', bad === 0, `${tested} instances, ${bad} off`)
  }

  // 6. Certificate soundness — every witness lasso is a real model path AND replays under direct semantics.
  {
    let checked = 0
    let bad = 0
    const failures: string[] = []
    const rng = mulberry32(0xce27)
    for (let i = 0; i < 200; i++) {
      const m = genModel(rng)
      const phi = genState(rng, 3)
      const res = modelCheckStarOn(phi, m)
      // The path bodies may reference χ labels from inner rounds — their truth lives in labelMap.
      const atomTrue = (atom: string, s: number): boolean => {
        const lbl = res.labelMap.get(atom)
        return lbl ? lbl[s] : m.props[s].has(atom)
      }
      for (const step of res.steps) {
        const atomList = atomsOfLtl(step.replayLtl)
        for (const w of step.witnesses) {
          checked++
          // (a) a real path of the model: consecutive states are transitions; the loop closes.
          const path = [...w.lasso.prefix, ...w.lasso.loop]
          let realPath = path.length > 0
          for (let j = 0; j + 1 < path.length; j++) if (!m.succ[path[j]].includes(path[j + 1])) realPath = false
          if (w.lasso.loop.length > 0) {
            const last = path[path.length - 1]
            if (!m.succ[last].includes(w.lasso.loop[0])) realPath = false
          }
          // (b) the projected ω-word satisfies the formula the witness claims (ρ for E, ¬ρ for A).
          const toLetters = (states: number[]) => states.map((s) => new Set(atomList.filter((a) => atomTrue(a, s))))
          const replays = evalLtlOnLasso(step.replayLtl, toLetters(w.lasso.prefix), toLetters(w.lasso.loop))
          if (!realPath || !replays) {
            bad++
            if (failures.length < 4) failures.push(`${step.label} @s${w.state}`)
          }
        }
      }
    }
    add('certificates: every witness lasso is a real path replaying its claim', bad === 0, `${checked} witness lassos checked${failures.length ? ' — off: ' + failures.join(', ') : ''}`)
  }

  // 7. Gallery verdicts — every example lands on its documented holds/fails verdict.
  {
    let bad = 0
    const failures: string[] = []
    for (const ex of STAR_EXAMPLES) {
      const pf = parseStar(ex.formula)
      const pm = parseKripke(ex.model)
      if (!pf.ok || !pm.model || !checkWellFormed(pf.formula).ok) {
        bad++
        failures.push(ex.name + ' (parse)')
        continue
      }
      const res = modelCheckStarOn(pf.formula, totalize(pm.model))
      const got = res.holds ? 'holds' : 'fails'
      if (got !== ex.expect) {
        bad++
        failures.push(`${ex.name} (got ${got})`)
      }
    }
    add('gallery verdicts match', bad === 0, `${STAR_EXAMPLES.length} examples${failures.length ? ' — off: ' + failures.join('; ') : ''}`)
  }

  const passed = results.filter((r) => r.pass).length
  return { results, passed, total: results.length, ok: passed === results.length }
}

/** Atoms of an LTL formula (local copy to avoid importing the oracle's internal helper). */
function atomsOfLtl(f: Ltl): string[] {
  const set = new Set<string>()
  const walk = (x: Ltl) => {
    switch (x.k) {
      case 'atom':
        set.add(x.name)
        break
      case 'true':
      case 'false':
        break
      case 'not':
      case 'next':
      case 'fin':
      case 'glob':
        walk(x.a)
        break
      default:
        walk(x.a)
        walk(x.b)
    }
  }
  walk(f)
  return [...set]
}
