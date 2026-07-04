// The in-app proof harness. Every claim the Games view makes is re-derived here from scratch and
// cross-checked three independent ways: the memoryless-strategy **certificate** (a complete proof
// per instance), a brute-force **oracle** on small arenas (the rules, and nothing but the rules),
// and structural **cross-checks** between conditions (Büchi as a parity encoding; parity duality
// under a priority shift). A negative test finally confirms the certificate has teeth — it must
// reject a deliberately corrupted solution.

import type { Condition, Player, Solution } from './types'
import { other, validateArena } from './types'
import { GAME_EXAMPLES } from './examples'
import { randomArena } from './random'
import { solveGame, conditionPriorities } from './solve'
import { solveParity } from './parity'
import { solveBuchi } from './buchi'
import { certifyParity } from './certify'
import { oracleWinners } from './oracle'

export interface TestResult {
  name: string
  pass: boolean
  detail: string
}

function sameWinners(a: Player[], b: Player[]): boolean {
  return a.length === b.length && a.every((w, i) => w === b[i])
}

export function runGamesSelfTest(): {
  results: TestResult[]
  passed: number
  total: number
  ok: boolean
} {
  const results: TestResult[] = []
  const add = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail })

  // 1. Every curated arena is well-formed and its solution self-certifies.
  {
    let bad = 0
    let firstBad = ''
    for (const ex of GAME_EXAMPLES) {
      const err = validateArena(ex.arena)
      const cert = err ? { ok: false, reason: err } : solveGame(ex.arena, ex.condition).certificate
      if (!cert.ok) {
        bad++
        if (!firstBad) firstBad = `${ex.id}: ${cert.reason}`
      }
    }
    add(
      'every curated game is proven correct by its certificate',
      bad === 0,
      bad === 0 ? `${GAME_EXAMPLES.length} arenas certified` : firstBad,
    )
  }

  // 2. Fuzz the certificate across all four conditions and many sizes (the headline check).
  {
    const conds: Condition[] = ['reachability', 'safety', 'buchi', 'parity']
    let checked = 0
    let bad = 0
    let firstBad = ''
    for (const cond of conds) {
      for (let seed = 1; seed <= 250; seed++) {
        const n = 4 + (seed % 14) // 4..17 vertices
        const a = randomArena(seed * 7 + cond.length, cond, { n, maxOut: 3, maxPriority: 4 })
        const { certificate } = solveGame(a, cond)
        checked++
        if (!certificate.ok) {
          bad++
          if (!firstBad) firstBad = `${cond} seed ${seed}: ${certificate.reason}`
        }
      }
    }
    add(
      'solutions self-certify on random arenas (all conditions)',
      bad === 0,
      bad === 0 ? `${checked} random games certified` : firstBad,
    )
  }

  // 3. The fast solvers agree with the brute-force oracle on small arenas.
  {
    const cases: { cond: Condition; kind: 'parity' | 'reachability' | 'safety' }[] = [
      { cond: 'parity', kind: 'parity' },
      { cond: 'reachability', kind: 'reachability' },
      { cond: 'safety', kind: 'safety' },
    ]
    let checked = 0
    let bad = 0
    let firstBad = ''
    for (const { cond, kind } of cases) {
      for (let seed = 1; seed <= 60; seed++) {
        const n = 4 + (seed % 4) // 4..7 vertices, small enough to brute force
        const a = randomArena(seed * 13 + 1, cond, { n, maxOut: 2, maxPriority: 3 })
        const oracle = oracleWinners(a, kind, { priority: a.priority, marked: a.accent })
        if (!oracle) continue
        const { solution } = solveGame(a, cond)
        checked++
        if (!sameWinners(solution.winner, oracle)) {
          bad++
          if (!firstBad) firstBad = `${cond} seed ${seed}`
        }
      }
    }
    add(
      'fast solvers match the brute-force oracle',
      bad === 0,
      bad === 0 ? `${checked} tiny games agreed vertex-for-vertex` : firstBad,
    )
  }

  // 4. Büchi is exactly the parity game with accepting ↦ 2, others ↦ 1.
  {
    let checked = 0
    let bad = 0
    for (let seed = 1; seed <= 80; seed++) {
      const n = 4 + (seed % 10)
      const a = randomArena(seed * 5 + 2, 'buchi', { n, maxOut: 3 })
      const direct = solveBuchi(a, a.accent).winner
      const asParity = solveParity({ ...a, priority: conditionPriorities(a, 'buchi') }).winner
      checked++
      if (!sameWinners(direct, asParity)) bad++
    }
    add('direct Büchi ≡ its parity encoding', bad === 0, `${checked} arenas, both routes agree`)
  }

  // 5. Parity duality: the *role-dual* game — flip every owner AND bump every priority by 1 — hands
  //    the game to the other player, so its Player-0 region is the original's Player-1 region.
  {
    let checked = 0
    let bad = 0
    for (let seed = 1; seed <= 80; seed++) {
      const n = 4 + (seed % 10)
      const a = randomArena(seed * 11 + 3, 'parity', { n, maxOut: 3, maxPriority: 4 })
      const base = solveParity(a).winner
      const dual = solveParity({
        ...a,
        owner: a.owner.map((o) => other(o)),
        priority: a.priority.map((p) => p + 1),
      }).winner
      checked++
      if (!base.every((w, v) => dual[v] === other(w))) bad++
    }
    add('parity role-duality (swap owners, shift priorities)', bad === 0, `${checked} arenas swap winners exactly`)
  }

  // 6. The certificate rejects a corrupted solution (it is not vacuously true).
  {
    const a = randomArena(4242, 'parity', { n: 9, maxOut: 3, maxPriority: 4 })
    const good = solveParity(a)
    const flipAt = good.winner.findIndex((_, v) => v >= 0)
    const corrupted: Solution = {
      winner: good.winner.map((w, v) => (v === flipAt ? other(w) : w)) as Player[],
      strat0: good.strat0,
      strat1: good.strat1,
    }
    const rej = certifyParity(a, a.priority, corrupted)
    const accept = certifyParity(a, a.priority, good)
    add(
      'certificate accepts the truth and rejects a corruption',
      accept.ok && !rej.ok,
      accept.ok ? (rej.ok ? 'FAILED to reject corruption' : 'accepts valid, rejects flipped winner') : 'rejected a valid solution',
    )
  }

  const passed = results.filter((r) => r.pass).length
  return { results, passed, total: results.length, ok: passed === results.length }
}
