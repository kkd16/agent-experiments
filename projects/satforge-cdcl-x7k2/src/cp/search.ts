// The search engine: depth-first backtracking interleaved with constraint
// propagation ("propagate then branch"). Each node fixes one variable to a
// value, propagates to a fixpoint, and recurses; a dead end backtracks in O(1)
// via the store's trail. On top of that skeleton sit the things that make a
// modern finite-domain solver fast and fun to watch:
//
//   • variable-ordering heuristics: input order, first-fail (smallest domain),
//     and dom/wdeg (smallest domain per accumulated constraint "blame");
//   • value-ordering heuristics: min / max / median / seeded-random;
//   • Luby restarts (for single-solution & optimisation search), which keep the
//     learned wdeg weights so each restart digs in a better direction;
//   • full enumeration + exact solution counting, and branch-and-bound
//     optimisation of an objective variable.

import type { Domain } from './domain.ts'
import { size } from './domain.ts'
import type { Model } from './model.ts'
import type { AllDiffLevel } from './propagators.ts'
import { allDifferent, linearLe } from './propagators.ts'
import { Store } from './store.ts'
import { luby } from './luby.ts'

export type VarHeuristic = 'input' | 'first-fail' | 'dom-wdeg'
export type ValHeuristic = 'min' | 'max' | 'median' | 'random'
export type SearchMode = 'first' | 'all' | 'count'

export interface SearchOptions {
  mode: SearchMode
  varHeuristic: VarHeuristic
  valHeuristic: ValHeuristic
  /** Cap on stored solutions (enumeration keeps counting past this). */
  maxStored?: number
  /** Stop enumerating after this many solutions (safety); Infinity = exhaustive. */
  solutionCap?: number
  nodeLimit?: number
  timeLimitMs?: number
  restarts?: boolean
  restartBase?: number
  randomSeed?: number
  trace?: boolean
  maxTrace?: number
  /** Override every all-different's filtering level for this run. */
  allDiffLevel?: AllDiffLevel
}

export interface SearchStats {
  nodes: number
  failures: number
  propagations: number
  solutions: number
  peakDepth: number
  restarts: number
  timeMs: number
}

export type TraceEvent =
  | { type: 'decision'; v: number; val: number; depth: number }
  | { type: 'fail'; prop: number; label: string; depth: number }
  | { type: 'solution'; depth: number }
  | { type: 'restart'; after: number }

export interface SearchResult {
  status: 'sat' | 'unsat' | 'unknown'
  solution: number[] | null
  solutions: number[][]
  count: number
  complete: boolean
  stats: SearchStats
  trace: TraceEvent[]
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

interface Frame {
  v: number
  vals: number[]
  idx: number
  mark: number
}

/** Build a fresh store from a model, optionally overriding all-different levels. */
export function buildStore(model: Model, level?: AllDiffLevel): Store {
  const store = new Store(model.domains, model.names)
  if (level) {
    // Rebuild every propagator, swapping all-different scopes to the new level.
    let adi = 0
    for (const p of model.propagators) {
      if (p.label.startsWith('allDiff(')) {
        store.addPropagator(allDifferent(model.allDiffScopes[adi], level))
        adi++
      } else {
        store.addPropagator(p)
      }
    }
  } else {
    for (const p of model.propagators) store.addPropagator(p)
  }
  return store
}

/** Solve a model. See `SearchOptions` for the knobs. */
export function search(model: Model, opts: SearchOptions): SearchResult {
  const store = buildStore(model, opts.allDiffLevel)
  return searchStore(store, opts)
}

/** Core search over an already-built store (used by optimise, which adds a bound). */
export function searchStore(store: Store, opts: SearchOptions): SearchResult {
  const rnd = mulberry32(opts.randomSeed ?? 0x9e3779b9)
  const maxStored = opts.maxStored ?? 1000
  const solutionCap = opts.solutionCap ?? Infinity
  const nodeLimit = opts.nodeLimit ?? Infinity
  const timeLimitMs = opts.timeLimitMs ?? Infinity
  const restartsOn = !!opts.restarts && opts.mode === 'first'
  const restartBase = opts.restartBase ?? 100
  const traceOn = !!opts.trace
  const maxTrace = opts.maxTrace ?? 2000

  const weights = new Float64Array(store.props.length).fill(1)
  const trace: TraceEvent[] = []
  const solutions: number[][] = []
  const stats: SearchStats = {
    nodes: 0,
    failures: 0,
    propagations: 0,
    solutions: 0,
    peakDepth: 0,
    restarts: 0,
    timeMs: 0,
  }
  const t0 = Date.now()
  let count = 0
  let hitLimit = false

  const pushTrace = (e: TraceEvent) => {
    if (traceOn && trace.length < maxTrace) trace.push(e)
  }

  // Root propagation.
  store.seedAll()
  if (!store.propagate()) {
    stats.timeMs = Date.now() - t0
    return { status: 'unsat', solution: null, solutions, count: 0, complete: true, stats, trace }
  }
  const rootMark = store.mark()

  // Variable selection over unfixed variables.
  const selectVar = (): number => {
    let best = -1
    let bestScore = Infinity
    for (let v = 0; v < store.n; v++) {
      const d = store.doms[v]
      if (d.length <= 1) continue
      let score: number
      if (opts.varHeuristic === 'input') {
        return v // first unfixed
      } else if (opts.varHeuristic === 'first-fail') {
        score = d.length
      } else {
        // dom/wdeg
        let w = 1
        for (const p of store.watchersOf(v)) w += weights[p]
        score = d.length / w
      }
      if (score < bestScore) {
        bestScore = score
        best = v
      }
    }
    return best
  }

  const orderVals = (v: number): number[] => {
    const d = store.doms[v]
    const vals = d.slice()
    switch (opts.valHeuristic) {
      case 'min':
        return vals // already ascending
      case 'max':
        return vals.reverse()
      case 'median': {
        const med = vals[vals.length >> 1]
        return vals.sort((a, b) => Math.abs(a - med) - Math.abs(b - med))
      }
      case 'random': {
        for (let i = vals.length - 1; i > 0; i--) {
          const j = Math.floor(rnd() * (i + 1))
          ;[vals[i], vals[j]] = [vals[j], vals[i]]
        }
        return vals
      }
    }
  }

  const stack: Frame[] = []
  let failuresSinceRestart = 0
  let lubyIdx = 1
  let restartBudget = restartsOn ? restartBase * luby(lubyIdx) : Infinity

  const applyNextValue = (f: Frame): void => {
    const val = f.vals[f.idx]
    f.idx++
    stats.nodes++
    pushTrace({ type: 'decision', v: f.v, val, depth: stack.length })
    store.narrow(f.v, [val])
    store.propagate()
    stats.propagations = store.propagations
    if (store.failed) {
      stats.failures++
      failuresSinceRestart++
      const pc = store.lastConflict
      if (pc >= 0) {
        weights[pc] += 1
        pushTrace({ type: 'fail', prop: pc, label: store.props[pc]?.label ?? '', depth: stack.length })
      }
    }
  }

  // Backtrack to the next untried value; returns false when the tree is exhausted.
  const backtrackToNextValue = (): boolean => {
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      store.undoTo(top.mark)
      if (top.idx < top.vals.length) {
        applyNextValue(top)
        return true
      }
      stack.pop()
    }
    return false
  }

  const doRestart = (): void => {
    store.undoTo(rootMark)
    stack.length = 0
    stats.restarts++
    failuresSinceRestart = 0
    lubyIdx++
    restartBudget = restartBase * luby(lubyIdx)
    pushTrace({ type: 'restart', after: stats.nodes })
  }

  let status: 'sat' | 'unsat' | 'unknown' = 'unsat'
  let firstSolution: number[] | null = null

  // Main loop.
  for (;;) {
    if (stats.nodes >= nodeLimit || Date.now() - t0 >= timeLimitMs) {
      hitLimit = true
      status = firstSolution ? 'sat' : 'unknown'
      break
    }
    if (restartsOn && failuresSinceRestart >= restartBudget) {
      doRestart()
    }

    if (store.failed) {
      if (!backtrackToNextValue()) break
      continue
    }

    stats.peakDepth = Math.max(stats.peakDepth, stack.length)

    if (store.allFixed()) {
      count++
      stats.solutions = count
      pushTrace({ type: 'solution', depth: stack.length })
      const sol = store.solution()
      if (!firstSolution) firstSolution = sol
      if (solutions.length < maxStored) solutions.push(sol)
      status = 'sat'
      if (opts.mode === 'first') break
      if (count >= solutionCap) {
        hitLimit = true
        break
      }
      if (!backtrackToNextValue()) break
      continue
    }

    // Branch.
    const v = selectVar()
    if (v < 0) {
      // No unfixed var but not allFixed ⇒ impossible; treat as solution guard.
      if (!backtrackToNextValue()) break
      continue
    }
    const vals = orderVals(v)
    const f: Frame = { v, vals, idx: 0, mark: store.mark() }
    stack.push(f)
    applyNextValue(f)
  }

  stats.timeMs = Date.now() - t0
  const complete = !hitLimit
  if (status === 'unsat' && count > 0) status = 'sat'
  return {
    status,
    solution: firstSolution,
    solutions,
    count,
    complete,
    stats,
    trace,
  }
}

export type OptSense = 'min' | 'max'

export interface OptimizeResult {
  status: 'optimal' | 'infeasible' | 'unknown'
  best: number | null
  solution: number[] | null
  improvements: { value: number; solution: number[] }[]
  complete: boolean
  stats: SearchStats
  iterations: number
}

/**
 * Branch-and-bound optimisation of `objVar`. Implemented as a sequence of
 * feasibility searches, each one required to *strictly beat* the incumbent — a
 * simple, obviously-correct B&B whose final infeasible search certifies the last
 * incumbent as optimal. Each inner search may use restarts for speed.
 */
export function optimize(
  model: Model,
  objVar: number,
  sense: OptSense,
  opts: SearchOptions,
): OptimizeResult {
  const improvements: { value: number; solution: number[] }[] = []
  let best: number | null = null
  let bestSol: number[] | null = null
  let iterations = 0
  const agg: SearchStats = {
    nodes: 0,
    failures: 0,
    propagations: 0,
    solutions: 0,
    peakDepth: 0,
    restarts: 0,
    timeMs: 0,
  }
  const t0 = Date.now()
  let complete = true

  for (;;) {
    iterations++
    const store = buildStore(model, opts.allDiffLevel)
    if (best !== null) {
      // Require a strictly better objective than the incumbent.
      if (sense === 'min') store.addPropagator(linearLe([1], [objVar], best - 1))
      else store.addPropagator(linearLe([-1], [objVar], -(best + 1)))
    }
    const res = searchStore(store, { ...opts, mode: 'first' })
    agg.nodes += res.stats.nodes
    agg.failures += res.stats.failures
    agg.propagations += res.stats.propagations
    agg.restarts += res.stats.restarts
    agg.peakDepth = Math.max(agg.peakDepth, res.stats.peakDepth)

    if (res.status === 'sat' && res.solution) {
      best = res.solution[objVar]
      bestSol = res.solution
      improvements.push({ value: best, solution: bestSol })
      continue
    }
    if (res.status === 'unsat') {
      // No better solution exists — incumbent (if any) is optimal.
      break
    }
    // 'unknown' — a limit was hit; can't certify optimality.
    complete = false
    break
  }

  agg.timeMs = Date.now() - t0
  agg.solutions = improvements.length
  const status: OptimizeResult['status'] =
    best === null ? (complete ? 'infeasible' : 'unknown') : complete ? 'optimal' : 'unknown'
  return { status, best, solution: bestSol, improvements, complete, stats: agg, iterations }
}

/** Count solutions exactly (a thin wrapper over `search` in count mode). */
export function countSolutions(model: Model, opts: Partial<SearchOptions> = {}): {
  count: number
  complete: boolean
  stats: SearchStats
} {
  const res = search(model, {
    mode: 'count',
    varHeuristic: opts.varHeuristic ?? 'first-fail',
    valHeuristic: opts.valHeuristic ?? 'min',
    maxStored: 0,
    solutionCap: opts.solutionCap ?? Infinity,
    nodeLimit: opts.nodeLimit,
    timeLimitMs: opts.timeLimitMs,
    allDiffLevel: opts.allDiffLevel,
  })
  return { count: res.count, complete: res.complete, stats: res.stats }
}

// re-export for convenience
export { size as domainSize }
export type { Domain }
