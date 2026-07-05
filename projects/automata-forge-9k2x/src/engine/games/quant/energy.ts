// Energy games, à la Brim–Chatterjee–Doyen–Gimbert–Raskin (2011) — a second, structurally
// independent solver for the *sign* of the mean-payoff value, plus the memoryless strategies.
//
// Question: from which vertices can the "keeper" hold a running energy (the cumulative edge weight)
// ≥ 0 forever, and with how little starting credit? Call that least sufficient credit F(v). It is
// the least fixed point of the *lift* operator
//   keeper vertex v:    F(v) = min_{(v,u)} max(0, F(u) − w(v,u))    (keeper spends as little as it can)
//   adversary vertex v: F(v) = max_{(v,u)} max(0, F(u) − w(v,u))    (adversary forces the worst edge)
// clamped into {0,…,(n−1)·W}; a demand above that ceiling is unmeetable, written ⊤ = "keeper loses".
// With keeper = Max and the given weights, F(v) ≠ ⊤ ⇔ ν(v) ≥ 0 (BCDGR). Running the same solver
// with keeper = Min on transformed weights decides the *strict* other side — that is what powers the
// certificate below.

import type { WArena, Player } from './types'
import { minCycleMean, ratCmp, type Rational, type WEdge } from './rational'

const TOP = Number.POSITIVE_INFINITY

/** A generic energy solve: on graph `out`, which vertices can `keeper` hold energy ≥ 0 from, and how? */
export interface EnergySolve {
  credit: number[]
  /** keeper holds energy ≥ 0 ⇔ credit ≠ ⊤. */
  winKeeper: boolean[]
  /** keeper's positional strategy on the region it holds (`-1` elsewhere). */
  strat: number[]
  ceiling: number
}

function demand(F: number[], e: WEdge): number {
  if (F[e.to] === TOP) return TOP
  return Math.max(0, F[e.to] - e.w)
}

/** Solve the energy game "`keeper` keeps the cumulative weight ≥ 0" on the weighted graph `out`. */
export function solveEnergyGeneric(n: number, owner: Player[], out: WEdge[][], keeper: Player): EnergySolve {
  let W = 0
  for (const es of out) for (const e of es) W = Math.max(W, Math.abs(e.w))
  const ceiling = Math.max(0, (n - 1) * W)

  const F = new Array(n).fill(0)
  for (let changed = true; changed; ) {
    changed = false
    for (let v = 0; v < n; v++) {
      if (F[v] === TOP) continue
      const es = out[v]
      let want: number
      if (owner[v] === keeper) {
        want = TOP
        for (const e of es) want = Math.min(want, demand(F, e))
      } else {
        want = 0
        for (const e of es) want = Math.max(want, demand(F, e))
      }
      if (want > ceiling) want = TOP
      if (want > F[v]) {
        F[v] = want
        changed = true
      }
    }
  }

  const winKeeper = F.map((f) => f !== TOP)
  const strat = new Array(n).fill(-1)
  for (let v = 0; v < n; v++) {
    if (owner[v] !== keeper || !winKeeper[v]) continue
    let bestU = -1
    let bestD = TOP
    for (const e of out[v]) {
      const d = demand(F, e)
      if (d !== TOP && d <= F[v] && d < bestD) {
        bestD = d
        bestU = e.to
      }
    }
    if (bestU === -1) bestU = out[v].find((e) => winKeeper[e.to])?.to ?? out[v][0].to
    strat[v] = bestU
  }
  return { credit: F, winKeeper, strat, ceiling }
}

export interface EnergyResult {
  /** Least sufficient initial credit per vertex; `Infinity` (⊤) means Max cannot keep energy ≥ 0. */
  credit: number[]
  /** ν(v) ≥ 0 ⇔ Max keeps energy ≥ 0 ⇔ credit ≠ ⊤. */
  win0: boolean[]
  /** Max's positional strategy on the region it wins (`-1` elsewhere). */
  strat0: number[]
  ceiling: number
}

/** The threshold-0 energy solve for Max (the protagonist): the values' sign and Max's strategy. */
export function solveEnergy(a: WArena): EnergyResult {
  const s = solveEnergyGeneric(a.n, a.owner, a.out, 0)
  return { credit: s.credit, win0: s.winKeeper, strat0: s.strat, ceiling: s.ceiling }
}

// ---------------------------------------------------------------------------
// Certificate for the threshold-0 partition — pin each side's strategy and inspect the cycles.
// ---------------------------------------------------------------------------

export interface EnergyCertificate {
  ok: boolean
  reason: string
}

/** Successor graph under a strategy `s` (owner `p` forced to `s[v]`), restricted to `region`. */
function pinnedOut(
  n: number,
  owner: Player[],
  out: WEdge[][],
  region: boolean[],
  p: Player,
  s: number[],
): { out: WEdge[][]; closed: boolean } {
  const g: WEdge[][] = Array.from({ length: n }, () => [])
  let closed = true
  for (let v = 0; v < n; v++) {
    if (!region[v]) continue
    if (owner[v] === p) {
      const e = out[v].find((x) => x.to === s[v])
      if (!e || !region[e.to]) closed = false
      else g[v] = [e]
    } else {
      for (const e of out[v]) {
        if (!region[e.to]) closed = false
        else g[v].push(e)
      }
    }
  }
  return { out: g, closed }
}

const R0: Rational = { p: 0, q: 1 }

/**
 * Certify a threshold-0 energy solution *independently of the fixpoint*, by cycle analysis:
 *
 *  • **Max side.** Pin Max to `r.strat0` on W₀. If W₀ is closed under Min and its minimum cycle mean
 *    is ≥ 0, then every play from W₀ has average ≥ 0, so W₀ ⊆ {ν ≥ 0}.
 *  • **Min side.** Because every value is a rational with denominator ≤ n, ν(v) < 0 ⇒ ν(v) ≤ −1/n.
 *    So scale weights by n and add 1 (w↦ n·w+1) and let **Min** be the energy keeper on the negated
 *    board −(n·w+1): the region Min holds is exactly {ν ≤ −1/n} = {ν < 0}, and Min's strategy makes
 *    every cycle there satisfy Σ(n·w+1) ≤ 0, i.e. mean ≤ −1/n < 0. That independently pins W₁.
 *
 * If the two regions match the claimed partition and cover every vertex, the answer is exact. A
 * corrupted partition breaks closedness or the region match, so the certificate has teeth.
 */
export function certifyEnergy(a: WArena, r: EnergyResult): EnergyCertificate {
  const n = a.n
  const W0 = r.win0.slice()
  const W1 = r.win0.map((w) => !w)

  // Max secures ν ≥ 0 on W₀.
  {
    const { out, closed } = pinnedOut(n, a.owner, a.out, W0, 0, r.strat0)
    if (!closed) return { ok: false, reason: "Max's energy strategy is not closed on W₀" }
    const mcm = minCycleMean(n, out, W0)
    if (mcm && ratCmp(mcm, R0) < 0) return { ok: false, reason: 'W₀ admits a cycle of negative mean' }
  }

  // Min forces ν < 0 on W₁, via the scaled/shifted energy game with Min as keeper.
  {
    const scaled: WEdge[][] = a.out.map((es) => es.map((e) => ({ to: e.to, w: -(n * e.w + 1) })))
    const minSolve = solveEnergyGeneric(n, a.owner, scaled, 1)
    const B = minSolve.winKeeper
    // The independently-found ν<0 region must be exactly the claimed W₁.
    for (let v = 0; v < n; v++) {
      if (B[v] !== W1[v]) return { ok: false, reason: `claimed winner at vertex ${v} disagrees with the energy witness` }
    }
    const { out, closed } = pinnedOut(n, a.owner, scaled, W1, 1, minSolve.strat)
    if (!closed) return { ok: false, reason: "Min's forcing strategy is not closed on W₁" }
    const mcm = minCycleMean(n, out, W1)
    if (mcm && ratCmp(mcm, R0) < 0) return { ok: false, reason: 'W₁ is not driven strictly below zero' }
  }

  return { ok: true, reason: 'Max holds ν ≥ 0 on W₀ with no negative cycle; Min drives W₁ below −1/n' }
}
