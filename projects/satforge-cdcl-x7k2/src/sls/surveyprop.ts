// Survey Propagation (SP) + decimation — the crown jewel of the Phys Studio and
// the deepest idea in this whole project. SP is a message-passing algorithm born
// not in computer science but in the statistical physics of spin glasses: it
// applies the *cavity method* to the factor graph of a CNF and estimates, for
// every variable, the probability that it is "frozen" to a value across the
// cluster of nearby solutions. Iterating the cavity equations to a fixed point,
// then repeatedly fixing the most-biased ("most frozen") variable and re-running,
// solves random 3-SAT right up against the satisfiability threshold (α ≈ 4.267) —
// a region where every complete solver in this project (and every DPLL/CDCL
// solver on Earth) falls off an exponential cliff.
//
// The cavity equations implemented here are the canonical ones of Braunstein,
// Mézard & Zecchina (2005). For a clause a and a variable i ∈ a, the *survey*
// η_{a→i} ∈ [0,1] is the probability that, in the absence of a, every *other*
// variable of a is forced away from satisfying a — so a must lean on i:
//
//     η_{a→i} = ∏_{j ∈ V(a)\i}  Π^u_{j→a} / (Π^u_{j→a} + Π^s_{j→a} + Π^0_{j→a})
//
// where, splitting j's *other* clauses into those that agree (V^s, same sign of j
// as in a) and disagree (V^u, opposite sign):
//
//     Π^u = [1 − ∏_{V^u}(1−η)] · ∏_{V^s}(1−η)     (j forced to NOT satisfy a)
//     Π^s = [1 − ∏_{V^s}(1−η)] · ∏_{V^u}(1−η)     (j forced to     satisfy a)
//     Π^0 = ∏_{V^u ∪ V^s}(1−η)                     (j unconstrained by its others)
//
// At the fixed point each variable's *bias* W⁺−W⁻ measures how frozen it is; the
// decimator fixes the most frozen, unit-propagates, and recurses. When the
// surveys collapse to ~0 (the paramagnetic phase) the residual formula is
// under-constrained and is finished off by WalkSAT. Every assignment SP produces
// is independently re-checked with the project's `verifyModel`.

import type { CNF } from '../sat/cnf'
import { verifyModel } from '../sat/cnf'
import { localSearch } from './localsearch'

export interface SpOptions {
  /** Max SP iterations per decimation round (default 1000). */
  maxIters?: number
  /** Convergence tolerance on max|Δη| (default 1e-6). */
  tol?: number
  /** Survey magnitude below which the formula is deemed paramagnetic (default 1e-2). */
  paramagneticTol?: number
  /** Message damping in [0,1): η ← (1−d)·η_new + d·η_old (default 0). */
  damping?: number
  /** Fraction of free variables fixed per decimation round (default 0.02). */
  fixFraction?: number
  /** Wall-clock budget in ms; 0 = unlimited (default 8000). */
  maxTimeMs?: number
  /** RNG seed handed to the WalkSAT clean-up phase (default 1). */
  seed?: number
}

export interface VarBias {
  v: number
  wPlus: number
  wMinus: number
  wZero: number
}

export interface SpRoundInfo {
  round: number
  converged: boolean
  iters: number
  /** Largest survey magnitude at convergence — a "how frozen is the formula" gauge. */
  maxEta: number
  fixed: number
  remaining: number
  note: string
}

export interface SpResult {
  status: 'sat' | 'unconverged' | 'contradiction' | 'unknown'
  model?: boolean[]
  rounds: number
  totalIters: number
  fixedBySp: number
  fixedByUnit: number
  fixedByWalksat: number
  /** Per-variable biases from the *first* SP fixed point (the whole-formula field). */
  initialBiases?: VarBias[]
  /** Whether that first fixed point was reached. */
  initialConverged: boolean
  initialMaxEta: number
  history: SpRoundInfo[]
  timeMs: number
  message?: string
  /** True iff a returned model satisfies the original CNF (defence in depth). */
  verified: boolean
}

const litTrue = (lit: number, val: boolean) => (lit > 0 ? val : !val)

/** Build the residual: drop satisfied clauses, drop false literals; flag empties. */
function buildResidual(
  clauses: number[][],
  assign: Int8Array, // 1=true, 0=false, -1=free
): { clauses: number[][]; contradiction: boolean } {
  const out: number[][] = []
  for (const c of clauses) {
    let sat = false
    const lits: number[] = []
    for (const lit of c) {
      const v = Math.abs(lit)
      const a = assign[v]
      if (a === -1) {
        lits.push(lit)
      } else if (litTrue(lit, a === 1)) {
        sat = true
        break
      }
      // else: literal is false under the fixed value → drop it
    }
    if (sat) continue
    if (lits.length === 0) return { clauses: [], contradiction: true }
    out.push(lits)
  }
  return { clauses: out, contradiction: false }
}

/** Unit-propagate to a fixed point on the residual; mutate `assign` in place. */
function unitPropagate(clauses: number[][], assign: Int8Array): { contradiction: boolean; fixed: number } {
  let fixed = 0
  for (;;) {
    const { clauses: res, contradiction } = buildResidual(clauses, assign)
    if (contradiction) return { contradiction: true, fixed }
    let unit = -1
    for (const c of res) {
      if (c.length === 1) {
        unit = c[0]
        break
      }
    }
    if (unit === -1) return { contradiction: false, fixed }
    assign[Math.abs(unit)] = unit > 0 ? 1 : 0
    fixed++
  }
}

interface SpFixedPoint {
  converged: boolean
  iters: number
  maxEta: number
  biases: VarBias[]
}

/**
 * Run the SP cavity iteration on a residual formula `clauses` (literals over the
 * still-free variables) and read off each variable's bias at the fixed point.
 */
function runSp(clauses: number[][], opts: Required<SpOptions>): SpFixedPoint {
  // Factor graph. Index every variable that actually appears.
  const varIndex = new Map<number, number>()
  const varList: number[] = []
  const cVars: number[][] = [] // |lit| per clause position
  const cPos: boolean[][] = [] // literal sign per clause position
  for (const c of clauses) {
    const vs: number[] = []
    const ps: boolean[] = []
    for (const lit of c) {
      const v = Math.abs(lit)
      if (!varIndex.has(v)) {
        varIndex.set(v, varList.length)
        varList.push(v)
      }
      vs.push(v)
      ps.push(lit > 0)
    }
    cVars.push(vs)
    cPos.push(ps)
  }

  // Per variable: the (clause, position, sign) edges it participates in.
  const varEdges: { a: number; p: number; positive: boolean }[][] = varList.map(() => [])
  for (let a = 0; a < cVars.length; a++) {
    for (let p = 0; p < cVars[a].length; p++) {
      varEdges[varIndex.get(cVars[a][p])!].push({ a, p, positive: cPos[a][p] })
    }
  }

  // Surveys η_{a→i}, stored per clause position. Random init in (0,1) is standard.
  let rng = 0x2545f491
  const frand = () => {
    rng ^= rng << 13
    rng ^= rng >>> 17
    rng ^= rng << 5
    return ((rng >>> 0) % 1000) / 1000
  }
  const eta: number[][] = cVars.map((vs) => vs.map(() => 0.1 + 0.8 * frand()))

  let converged = false
  let iters = 0
  for (let it = 0; it < opts.maxIters; it++) {
    iters = it + 1
    let maxDelta = 0
    for (let a = 0; a < cVars.length; a++) {
      for (let p = 0; p < cVars[a].length; p++) {
        // η_{a→i}: product over the other variables j of clause a.
        let prod = 1
        for (let q = 0; q < cVars[a].length; q++) {
          if (q === p) continue
          const j = cVars[a][q]
          const sj = cPos[a][q] // sign of j in clause a
          let prodSame = 1 // V^s : clauses (≠a) where j has the SAME sign as in a
          let prodDiff = 1 // V^u : clauses (≠a) where j has the OPPOSITE sign
          for (const e of varEdges[varIndex.get(j)!]) {
            if (e.a === a) continue
            const val = 1 - eta[e.a][e.p]
            if (e.positive === sj) prodSame *= val
            else prodDiff *= val
          }
          const pu = (1 - prodDiff) * prodSame
          const ps = (1 - prodSame) * prodDiff
          const p0 = prodSame * prodDiff
          const denom = pu + ps + p0
          prod *= denom > 0 ? pu / denom : 0
        }
        const old = eta[a][p]
        const next = opts.damping > 0 ? (1 - opts.damping) * prod + opts.damping * old : prod
        const d = Math.abs(next - old)
        if (d > maxDelta) maxDelta = d
        eta[a][p] = next
      }
    }
    if (maxDelta < opts.tol) {
      converged = true
      break
    }
  }

  // Read off biases W⁺/W⁻/W⁰ for each variable from the converged surveys.
  let maxEta = 0
  for (const row of eta) for (const e of row) if (e > maxEta) maxEta = e
  const biases: VarBias[] = []
  for (let idx = 0; idx < varList.length; idx++) {
    let prodPos = 1 // clauses where the variable is positive
    let prodNeg = 1 // clauses where it is negative
    for (const e of varEdges[idx]) {
      const val = 1 - eta[e.a][e.p]
      if (e.positive) prodPos *= val
      else prodNeg *= val
    }
    const piPlus = (1 - prodPos) * prodNeg
    const piMinus = (1 - prodNeg) * prodPos
    const piZero = prodPos * prodNeg
    const z = piPlus + piMinus + piZero
    biases.push(
      z > 0
        ? { v: varList[idx], wPlus: piPlus / z, wMinus: piMinus / z, wZero: piZero / z }
        : { v: varList[idx], wPlus: 0, wMinus: 0, wZero: 1 },
    )
  }
  return { converged, iters, maxEta, biases }
}

/**
 * Solve `cnf` by survey-propagation-guided decimation, finishing under-constrained
 * residuals with WalkSAT. Incomplete: may return `'unconverged'` (SP failed to
 * reach a fixed point), `'contradiction'` (decimation drove the residual empty —
 * SP took a wrong turn) or `'unknown'`. A `'sat'` model is always `verifyModel`-checked.
 */
export function surveyPropagate(cnf: CNF, opts: SpOptions = {}): SpResult {
  const o: Required<SpOptions> = {
    maxIters: opts.maxIters ?? 1000,
    tol: opts.tol ?? 1e-6,
    paramagneticTol: opts.paramagneticTol ?? 1e-2,
    damping: opts.damping ?? 0,
    fixFraction: opts.fixFraction ?? 0.02,
    maxTimeMs: opts.maxTimeMs ?? 8000,
    seed: opts.seed ?? 1,
  }
  const start = performance.now()
  const n = cnf.numVars
  const baseClauses = cnf.clauses.filter((c) => c.length > 0)

  const assign = new Int8Array(n + 1).fill(-1)
  const history: SpRoundInfo[] = []
  let fixedBySp = 0
  let fixedByUnit = 0
  let fixedByWalksat = 0
  let totalIters = 0
  let initialBiases: VarBias[] | undefined
  let initialConverged = false
  let initialMaxEta = 0

  const finish = (status: SpResult['status'], model: boolean[] | undefined, message?: string): SpResult => {
    let verified = false
    if (status === 'sat' && model) {
      verified = verifyModel(cnf, model).ok
      if (!verified) status = 'contradiction'
    }
    return {
      status,
      model: status === 'sat' ? model : undefined,
      rounds: history.length,
      totalIters,
      fixedBySp,
      fixedByUnit,
      fixedByWalksat,
      initialBiases,
      initialConverged,
      initialMaxEta,
      history,
      timeMs: performance.now() - start,
      message,
      verified,
    }
  }

  // Initial unit propagation (handles any unit clauses up front).
  const up0 = unitPropagate(baseClauses, assign)
  if (up0.contradiction) return finish('contradiction', undefined, 'unit propagation hit an empty clause')
  fixedByUnit += up0.fixed

  let round = 0
  for (;;) {
    if (performance.now() - start > o.maxTimeMs) return finish('unknown', undefined, 'time budget exhausted')

    const { clauses: residual, contradiction } = buildResidual(baseClauses, assign)
    if (contradiction) return finish('contradiction', undefined, 'residual contains an empty clause')

    // Solved? No active clauses ⇒ every remaining free variable is unconstrained.
    if (residual.length === 0) {
      const model = completeModel(assign, n)
      return finish('sat', model)
    }

    const fp = runSp(residual, o)
    totalIters += fp.iters
    round++
    if (round === 1) {
      initialBiases = fp.biases
      initialConverged = fp.converged
      initialMaxEta = fp.maxEta
    }

    if (!fp.converged) {
      // SP did not settle — hand the whole residual to WalkSAT.
      history.push({ round, converged: false, iters: fp.iters, maxEta: fp.maxEta, fixed: 0, remaining: countFree(assign, n), note: 'SP did not converge → WalkSAT' })
      return finishWithWalksat(residual)
    }

    if (fp.maxEta < o.paramagneticTol) {
      // Paramagnetic: no frozen variables left → residual is in the easy SAT region.
      history.push({ round, converged: true, iters: fp.iters, maxEta: fp.maxEta, fixed: 0, remaining: countFree(assign, n), note: 'paramagnetic → WalkSAT clean-up' })
      return finishWithWalksat(residual)
    }

    // Decimate: fix the most-biased free variables to their preferred polarity.
    const ranked = fp.biases
      .map((b) => ({ b, mag: Math.abs(b.wPlus - b.wMinus) }))
      .sort((x, y) => y.mag - x.mag)
    const free = ranked.length
    const k = Math.max(1, Math.floor(o.fixFraction * free))
    let fixedThis = 0
    for (let i = 0; i < k && i < ranked.length; i++) {
      const { b } = ranked[i]
      if (assign[b.v] !== -1) continue
      assign[b.v] = b.wPlus >= b.wMinus ? 1 : 0
      fixedThis++
    }
    fixedBySp += fixedThis

    // Propagate the consequences.
    const up = unitPropagate(baseClauses, assign)
    if (up.contradiction) {
      history.push({ round, converged: true, iters: fp.iters, maxEta: fp.maxEta, fixed: fixedThis, remaining: countFree(assign, n), note: 'decimation → empty clause' })
      return finish('contradiction', undefined, 'decimation produced an empty clause')
    }
    fixedByUnit += up.fixed
    history.push({
      round,
      converged: true,
      iters: fp.iters,
      maxEta: fp.maxEta,
      fixed: fixedThis + up.fixed,
      remaining: countFree(assign, n),
      note: `fixed ${fixedThis} by SP, ${up.fixed} by unit propagation`,
    })

    if (round > n + 5) return finish('unknown', undefined, 'too many decimation rounds')
  }

  function finishWithWalksat(residual: number[][]): SpResult {
    const remaining = countFree(assign, n)
    const sub: CNF = { numVars: n, clauses: residual }
    const ls = localSearch(sub, {
      algorithm: 'walksat',
      seed: o.seed,
      maxTimeMs: Math.max(500, o.maxTimeMs - (performance.now() - start)),
      maxTries: 30,
    })
    if (ls.status === 'sat' && ls.model) {
      // Merge: fixed variables keep their decided value; free variables take the SLS model.
      const model = new Array<boolean>(n + 1).fill(false)
      for (let v = 1; v <= n; v++) model[v] = assign[v] === 1 ? true : assign[v] === 0 ? false : ls.model[v]
      fixedByWalksat = remaining
      return finish('sat', model)
    }
    return finish('unknown', undefined, 'WalkSAT clean-up did not finish the residual in budget')
  }
}

function completeModel(assign: Int8Array, n: number): boolean[] {
  const m = new Array<boolean>(n + 1).fill(false)
  for (let v = 1; v <= n; v++) m[v] = assign[v] === 1
  return m
}

function countFree(assign: Int8Array, n: number): number {
  let c = 0
  for (let v = 1; v <= n; v++) if (assign[v] === -1) c++
  return c
}
