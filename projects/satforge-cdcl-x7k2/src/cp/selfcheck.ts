// Correctness harness for the CP engine. Everything the studio claims is checked
// here against *independent* oracles — the same discipline as the rest of the
// SatForge subsystems (solver vs. brute force, plus pinned known answers).
//
//   1. Random-model differential: thousands of small random models solved to
//      completion, their full solution SET compared value-for-value against a
//      brute-force enumeration built from the model's independent checkers.
//   2. GAC exactness: Régin's domain-consistent all-different must leave exactly
//      the values that a brute support search says are supportable — no more,
//      no fewer.
//   3. Filtering-level agreement: 'value', 'bounds' and 'domain' all-different
//      must yield the *same* solution count (different pruning, same solutions).
//   4. Optimisation differential: branch-and-bound optima vs. brute optima.
//   5. Pinned known answers from the gallery: N-Queens (OEIS A000170), Latin
//      squares, the magic square, SEND+MORE=MONEY, Golomb ruler lengths — and
//      every reported solution re-validated by the model's own checkers.

import { Model } from './model.ts'
import type { AllDiffLevel } from './propagators.ts'
import { search, countSolutions, optimize } from './search.ts'
import { buildStore } from './search.ts'
import { CP_EXAMPLES } from './examples.ts'

export interface CpCheckReport {
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

/** Brute-force the entire solution set of a (small) model via its checkers. */
function bruteSolutions(m: Model): string[] {
  const doms = m.domains
  const n = doms.length
  const out: string[] = []
  const a = new Array(n).fill(0)
  const rec = (i: number): void => {
    if (i === n) {
      if (m.satisfies(a)) out.push(a.join(','))
      return
    }
    for (const v of doms[i]) {
      a[i] = v
      rec(i + 1)
    }
  }
  rec(0)
  out.sort()
  return out
}

function productSize(m: Model): number {
  let p = 1
  for (const d of m.domains) {
    p *= d.length
    if (p > 200_000) return Infinity
  }
  return p
}

export function runCpChecks(): CpCheckReport {
  let pass = 0
  let fail = 0
  const messages: string[] = []
  const ok = (cond: boolean, msg: string) => {
    if (cond) pass++
    else {
      fail++
      if (messages.length < 12) messages.push(msg)
    }
  }

  // ---- 1. random-model differential -------------------------------------
  {
    const rnd = mulberry32(0xc0ffee)
    let matched = 0
    let total = 0
    for (let iter = 0; iter < 700; iter++) {
      const m = new Model()
      const nv = 2 + Math.floor(rnd() * 3)
      const vars: number[] = []
      for (let i = 0; i < nv; i++) {
        const lo = Math.floor(rnd() * 3)
        const hi = lo + 1 + Math.floor(rnd() * 4)
        vars.push(m.newVar(`x${i}`, lo, hi))
      }
      const nc = 1 + Math.floor(rnd() * 3)
      for (let c = 0; c < nc; c++) {
        const kind = Math.floor(rnd() * 5)
        if (kind === 0) m.addAllDifferent(vars, (['value', 'bounds', 'domain'] as AllDiffLevel[])[Math.floor(rnd() * 3)])
        else if (kind === 1) {
          const i = Math.floor(rnd() * nv)
          let j = Math.floor(rnd() * nv)
          if (j === i) j = (j + 1) % nv
          m.addNotEqual(vars[i], vars[j], Math.floor(rnd() * 3) - 1)
        } else if (kind === 2) {
          const coeffs = vars.map(() => Math.floor(rnd() * 5) - 2)
          const op = (['<=', '>=', '='] as const)[Math.floor(rnd() * 3)]
          m.addLinear(coeffs, vars, op, Math.floor(rnd() * 10) - 3)
        } else if (kind === 3) {
          const i = Math.floor(rnd() * nv)
          let j = Math.floor(rnd() * nv)
          if (j === i) j = (j + 1) % nv
          m.addLinear([1, -1], [vars[i], vars[j]], (['<=', '>=', '<', '>'] as const)[Math.floor(rnd() * 4)], Math.floor(rnd() * 3) - 1)
        } else {
          // element + a random table on two vars
          const y = vars[Math.floor(rnd() * nv)]
          const idx = m.newVar('idx', 0, 3)
          const arr = [0, 1, 2, 3].map(() => Math.floor(rnd() * 6))
          m.addElement(y, idx, arr)
        }
      }
      if (productSize(m) === Infinity) continue
      total++
      const brute = bruteSolutions(m)
      const level = (['value', 'bounds', 'domain'] as AllDiffLevel[])[iter % 3]
      const res = search(m, { mode: 'all', varHeuristic: 'dom-wdeg', valHeuristic: 'min', maxStored: 200_000, allDiffLevel: level })
      const got = res.solutions.map((s) => s.join(',')).sort()
      const same = res.complete && res.count === brute.length && got.length === brute.length && got.every((g, i) => g === brute[i])
      // Every reported solution must pass the independent checker.
      const allValid = res.solutions.every((s) => m.satisfies(s))
      if (same && allValid) matched++
    }
    ok(matched === total, `random differential: ${matched}/${total} models matched brute force`)
  }

  // ---- 2. GAC exactness --------------------------------------------------
  {
    const rnd = mulberry32(0xbeef)
    let exact = 0
    let total = 0
    for (let iter = 0; iter < 600; iter++) {
      const m = new Model()
      const nv = 2 + Math.floor(rnd() * 3)
      const vars: number[] = []
      for (let i = 0; i < nv; i++) {
        const vals = new Set<number>()
        const k = 1 + Math.floor(rnd() * 4)
        for (let j = 0; j < k; j++) vals.add(Math.floor(rnd() * 5))
        vars.push(m.newVarValues(`x${i}`, vals))
      }
      m.addAllDifferent(vars, 'domain')
      const before = m.domains.map((d) => d.slice())
      const store = buildStore(m)
      store.seedAll()
      store.propagate()
      // brute support
      const supported: Set<number>[] = vars.map(() => new Set<number>())
      let anySol = false
      const a = new Array(nv).fill(0)
      const rec = (i: number, used: Set<number>): void => {
        if (i === nv) {
          anySol = true
          for (let k2 = 0; k2 < nv; k2++) supported[k2].add(a[k2])
          return
        }
        for (const v of before[i]) {
          if (used.has(v)) continue
          a[i] = v
          used.add(v)
          rec(i + 1, used)
          used.delete(v)
        }
      }
      rec(0, new Set())
      total++
      if (!anySol) {
        if (store.failed) exact++
        continue
      }
      if (store.failed) continue
      let good = true
      for (let i = 0; i < nv; i++) {
        const got = [...store.doms[i]].sort((x, y) => x - y).join(',')
        const exp = [...supported[i]].sort((x, y) => x - y).join(',')
        if (got !== exp) {
          good = false
          break
        }
      }
      if (good) exact++
    }
    ok(exact === total, `Régin GAC exactness: ${exact}/${total} all-different instances domain-consistent`)
  }

  // ---- 3. filtering-level agreement --------------------------------------
  {
    let agree = 0
    let total = 0
    const cases: Array<[string, Record<string, number>]> = [
      ['queens', { n: 6 }],
      ['queens', { n: 7 }],
      ['latin', { n: 4 }],
      ['magic', { n: 3 }],
    ]
    for (const [id, p] of cases) {
      const ex = CP_EXAMPLES.find((e) => e.id === id)!
      const counts = (['value', 'bounds', 'domain'] as AllDiffLevel[]).map((lvl) => {
        const built = ex.build(p)
        return countSolutions(built.model, { allDiffLevel: lvl, varHeuristic: 'first-fail' }).count
      })
      total++
      if (counts[0] === counts[1] && counts[1] === counts[2]) agree++
      else if (messages.length < 12) messages.push(`level disagreement on ${id}(${JSON.stringify(p)}): ${counts.join('/')}`)
    }
    ok(agree === total, `filtering-level agreement: ${agree}/${total} instances agree across value/bounds/domain`)
  }

  // ---- 4. optimisation differential --------------------------------------
  {
    const rnd = mulberry32(0xd00d)
    let matched = 0
    let total = 0
    for (let iter = 0; iter < 120; iter++) {
      const m = new Model()
      const nv = 3
      const vars: number[] = []
      for (let i = 0; i < nv; i++) vars.push(m.newVar(`x${i}`, 0, 4))
      m.addAllDifferent(vars)
      m.addLinear(vars.map(() => 1 + Math.floor(rnd() * 3)), vars, '<=', 5 + Math.floor(rnd() * 4))
      const objCoeffs = vars.map(() => 1 + Math.floor(rnd() * 3))
      const obj = m.newVar('obj', 0, 100)
      m.addLinear([...objCoeffs, -1], [...vars, obj], '=', 0)
      const sense = rnd() < 0.5 ? 'min' : 'max'
      const r = optimize(m, obj, sense, { mode: 'first', varHeuristic: 'dom-wdeg', valHeuristic: sense === 'max' ? 'max' : 'min' })
      let bBest = sense === 'max' ? -Infinity : Infinity
      const a = new Array(m.domains.length).fill(0)
      const rec = (i: number): void => {
        if (i === m.domains.length) {
          if (m.satisfies(a)) bBest = sense === 'max' ? Math.max(bBest, a[obj]) : Math.min(bBest, a[obj])
          return
        }
        for (const v of m.domains[i]) {
          a[i] = v
          rec(i + 1)
        }
      }
      rec(0)
      const exp = Number.isFinite(bBest) ? bBest : null
      total++
      if ((r.best ?? null) === exp) matched++
    }
    ok(matched === total, `optimisation differential: ${matched}/${total} B&B optima match brute force`)
  }

  // ---- 5. pinned known answers from the gallery --------------------------
  {
    const pinned: Array<{ id: string; p: Record<string, number>; kind: 'count' | 'opt' }> = [
      { id: 'queens', p: { n: 6 }, kind: 'count' },
      { id: 'queens', p: { n: 8 }, kind: 'count' },
      { id: 'queens', p: { n: 9 }, kind: 'count' },
      { id: 'latin', p: { n: 3 }, kind: 'count' },
      { id: 'magic', p: { n: 3 }, kind: 'count' },
      { id: 'sendmore', p: {}, kind: 'count' },
      { id: 'langford', p: { n: 3 }, kind: 'count' },
      { id: 'langford', p: { n: 4 }, kind: 'count' },
      { id: 'langford', p: { n: 7 }, kind: 'count' },
      { id: 'golomb', p: { m: 4 }, kind: 'opt' },
      { id: 'golomb', p: { m: 5 }, kind: 'opt' },
      { id: 'golomb', p: { m: 6 }, kind: 'opt' },
    ]
    for (const { id, p, kind } of pinned) {
      const ex = CP_EXAMPLES.find((e) => e.id === id)!
      const built = ex.build(p)
      if (kind === 'count') {
        const { count, complete } = countSolutions(built.model, { varHeuristic: 'dom-wdeg' })
        ok(complete && count === built.known?.count, `${id}(${JSON.stringify(p)}): counted ${count}, expected ${built.known?.count}`)
      } else {
        const r = optimize(built.model, built.objective!.v, built.objective!.sense, { mode: 'first', varHeuristic: 'dom-wdeg', valHeuristic: 'min', restarts: true })
        ok(r.status === 'optimal' && r.best === built.known?.optimum, `${id}(${JSON.stringify(p)}): optimum ${r.best}, expected ${built.known?.optimum}`)
        // Re-validate the optimal solution with the independent checker.
        ok(!!r.solution && built.model.satisfies(r.solution), `${id}(${JSON.stringify(p)}): optimal solution valid`)
      }
    }

    // SEND+MORE specific values.
    const sm = CP_EXAMPLES.find((e) => e.id === 'sendmore')!.build({})
    const res = search(sm.model, { mode: 'all', varHeuristic: 'dom-wdeg', valHeuristic: 'min', maxStored: 4 })
    if (res.solutions.length === 1) {
      const a = res.solutions[0]
      // letters order S,E,N,D,M,O,R,Y are vars 0..7
      const [S, E, N, D, M, O, R, Y] = a
      const send = 1000 * S + 100 * E + 10 * N + D
      const more = 1000 * M + 100 * O + 10 * R + E
      const money = 10000 * M + 1000 * O + 100 * N + 10 * E + Y
      ok(send + more === money && send === 9567 && more === 1085 && money === 10652, `SEND+MORE: ${send}+${more}=${money}`)
    } else {
      ok(false, `SEND+MORE: expected 1 solution, got ${res.solutions.length}`)
    }
  }

  return { pass, fail, messages }
}
