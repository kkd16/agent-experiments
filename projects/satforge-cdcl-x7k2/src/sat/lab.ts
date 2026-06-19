// SatForge Solver Lab — an empirical-algorithmics engine that pits different CDCL
// configurations against a reproducible suite of benchmark instances, then scores
// them the way the SAT Competition does: a cactus plot, PAR-2 scores, and a
// head-to-head grid. It is also a *soundness oracle*: every configuration is the
// same proved-correct CDCL core with a single heuristic flipped, so on any instance
// they all decide, they must AGREE — `agreementErrors` checks exactly that.
//
// Nothing here is UI: it is pure functions over CNFs and `SolverOptions`, so the
// self-test harness drives the identical code path the studio does.

import type { CNF } from './cnf'
import { verifyModel } from './cnf'
import type { SolverOptions, SolveResult } from './solver'
import { solve } from './solver'
import { randomKSat } from './encoders/random3sat'
import { encodePigeonhole } from './encoders/pigeonhole'
import { encodeLangford } from './encoders/langford'
import { encodeGraphColoring, randomGraph } from './encoders/graphColoring'

// ---------------------------------------------------------------------------
// Configurations — a heuristic ablation matrix over the single CDCL core.
// ---------------------------------------------------------------------------

export interface BenchConfig {
  id: string
  label: string
  /** A one-line explanation of which knob is turned, shown in the UI. */
  description: string
  opts: SolverOptions
}

/**
 * Curated presets. Each is the full solver with ONE thing changed from the
 * baseline, so a difference in the results isolates the effect of that single
 * technique. `id: 'full'` is the reference (everything on).
 */
export const PRESET_CONFIGS: BenchConfig[] = [
  { id: 'full', label: 'Full CDCL', description: 'Every technique on — the reference solver.', opts: {} },
  {
    id: 'no-restart',
    label: 'No restarts',
    description: 'Luby restarts disabled — the search never abandons a bad path.',
    opts: { restarts: false },
  },
  {
    id: 'no-reduce',
    label: 'No clause deletion',
    description: 'Learnt clauses are never forgotten — the database grows without bound.',
    opts: { reduceDb: false },
  },
  {
    id: 'no-min',
    label: 'No minimization',
    description: 'Learnt clauses are kept as-is, without recursive self-subsumption.',
    opts: { minimize: false },
  },
  {
    id: 'no-phase',
    label: 'No phase saving',
    description: 'Decisions always branch false-first instead of re-using the last polarity.',
    opts: { phaseSaving: false },
  },
  {
    id: 'random-branch',
    label: 'Random branching',
    description: 'VSIDS replaced by a uniform random variable choice — the activity scores are ignored.',
    opts: { branch: 'random' },
  },
  {
    id: 'fast-decay',
    label: 'Fast VSIDS decay (0.85)',
    description: 'Activity scores age quickly — the solver chases very recent conflicts.',
    opts: { varDecay: 0.85 },
  },
  {
    id: 'slow-decay',
    label: 'Slow VSIDS decay (0.99)',
    description: 'Activity scores age slowly — the variable order has a long memory.',
    opts: { varDecay: 0.99 },
  },
  {
    id: 'eager-restart',
    label: 'Aggressive restarts (base 25)',
    description: 'Luby restarts on a short base — the solver re-rolls its decisions often.',
    opts: { restartBase: 25 },
  },
  {
    id: 'lazy-restart',
    label: 'Lazy restarts (base 400)',
    description: 'Luby restarts on a long base — the solver commits to a path far longer.',
    opts: { restartBase: 400 },
  },
]

export function configById(id: string): BenchConfig | undefined {
  return PRESET_CONFIGS.find((c) => c.id === id)
}

// ---------------------------------------------------------------------------
// Instances — a reproducible benchmark suite.
// ---------------------------------------------------------------------------

export type InstanceFamily = 'random-3sat' | 'pigeonhole' | 'coloring' | 'langford'

export interface BenchInstance {
  id: string
  family: InstanceFamily
  label: string
  cnf: CNF
  /** Ground truth where it is known a priori (used as an extra correctness check). */
  expected?: 'sat' | 'unsat'
}

export const ALL_FAMILIES: InstanceFamily[] = ['random-3sat', 'pigeonhole', 'coloring', 'langford']

export const FAMILY_LABEL: Record<InstanceFamily, string> = {
  'random-3sat': 'Random 3-SAT (phase transition)',
  pigeonhole: 'Pigeonhole (UNSAT)',
  coloring: 'Graph k-coloring',
  langford: 'Langford pairings',
}

export interface SuiteSpec {
  families: Record<InstanceFamily, boolean>
  /** Master seed — the whole suite is a pure function of this. */
  seed: number
  /** Difficulty / size dial, 1 (quick) … 4 (stress). */
  scale: number
}

export const DEFAULT_SUITE: SuiteSpec = {
  families: { 'random-3sat': true, pigeonhole: true, coloring: true, langford: true },
  seed: 1,
  scale: 2,
}

// L(n) is satisfiable iff n ≡ 0 or 3 (mod 4) — a tidy known oracle for the suite.
const langfordSat = (n: number) => n % 4 === 0 || n % 4 === 3

/**
 * Build the benchmark suite deterministically from a spec. Mixing easy and hard,
 * SAT and UNSAT, random and structured instances is what makes the cactus plot
 * informative — a heuristic that wins on one family often loses on another.
 */
export function generateSuite(spec: SuiteSpec): BenchInstance[] {
  const out: BenchInstance[] = []
  const scale = Math.max(1, Math.min(4, Math.round(spec.scale)))

  if (spec.families['random-3sat']) {
    // Sizes grow with scale; ratios straddle the α ≈ 4.26 phase transition.
    const sizes = [30, 45, 60, 75].slice(0, 1 + scale)
    const ratios = [3.8, 4.1, 4.26, 4.5]
    let k = 0
    for (const n of sizes) {
      for (const ratio of ratios) {
        const seed = (spec.seed * 2654435761 + k * 40503 + 1) >>> 0
        out.push({
          id: `r3-${n}-${ratio}-${k}`,
          family: 'random-3sat',
          label: `3-SAT n=${n}, α=${ratio}`,
          cnf: randomKSat(n, ratio, 3, seed),
        })
        k++
      }
    }
  }

  if (spec.families.pigeonhole) {
    // PHP(n+1 → n) is UNSAT and exponentially hard — the classic resolution lower bound.
    const ns = [4, 5, 6, 7].slice(0, 1 + scale)
    for (const n of ns) {
      out.push({
        id: `php-${n}`,
        family: 'pigeonhole',
        label: `PHP ${n + 1}→${n}`,
        cnf: encodePigeonhole(n).cnf,
        expected: 'unsat',
      })
    }
  }

  if (spec.families.coloring) {
    // Random graphs near the coloring threshold: some k-colorable, some not.
    const colorTable: Array<[number, number, number]> = [
      [12, 0.5, 3],
      [16, 0.45, 3],
      [18, 0.4, 4],
      [22, 0.42, 4],
    ]
    const specs = colorTable.slice(0, 1 + scale)
    let k = 0
    for (const [n, p, colors] of specs) {
      const seed = (spec.seed * 0x9e3779b1 + k * 2246822519 + 7) >>> 0
      const g = randomGraph(n, p, seed)
      out.push({
        id: `col-${n}-${colors}-${k}`,
        family: 'coloring',
        label: `${colors}-color G(${n}, ${g.edges.length}e)`,
        cnf: encodeGraphColoring(g, colors).cnf,
      })
      k++
    }
  }

  if (spec.families.langford) {
    const ns = [7, 8, 9, 10].slice(0, 1 + scale)
    for (const n of ns) {
      out.push({
        id: `lang-${n}`,
        family: 'langford',
        label: `L(${n})`,
        cnf: encodeLangford(n).cnf,
        expected: langfordSat(n) ? 'sat' : 'unsat',
      })
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Running a benchmark.
// ---------------------------------------------------------------------------

export interface BenchBudget {
  /** Abort a run after this many conflicts (0 = unlimited). */
  maxConflicts: number
  /** Abort a run after this much wall time (ms; 0 = unlimited). */
  maxTimeMs: number
}

export const DEFAULT_BUDGET: BenchBudget = { maxConflicts: 200000, maxTimeMs: 4000 }

export interface RunResult {
  configId: string
  instanceId: string
  status: 'sat' | 'unsat' | 'unknown'
  timeMs: number
  conflicts: number
  decisions: number
  propagations: number
  restarts: number
  learned: number
  /** For a SAT verdict: did the returned model actually satisfy the CNF? */
  modelOk: boolean
}

/** Solve one (config, instance) pair under the budget and collect its metrics. */
export function runOne(config: BenchConfig, inst: BenchInstance, budget: BenchBudget): RunResult {
  const opts: SolverOptions = {
    ...config.opts,
    maxConflicts: budget.maxConflicts,
    maxTimeMs: budget.maxTimeMs,
  }
  const r: SolveResult = solve(inst.cnf, opts)
  let modelOk = true
  if (r.status === 'sat') modelOk = !!r.model && verifyModel(inst.cnf, r.model).ok
  return {
    configId: config.id,
    instanceId: inst.id,
    status: r.status,
    timeMs: r.stats.timeMs,
    conflicts: r.stats.conflicts,
    decisions: r.stats.decisions,
    propagations: r.stats.propagations,
    restarts: r.stats.restarts,
    learned: r.stats.learned,
    modelOk,
  }
}

/**
 * Lazily run every (config × instance) cell, yielding after each so a worker (or
 * the self-test) can report progress and stay responsive. The order is
 * instance-major so partial results already cover every config.
 */
export function* benchSteps(
  configs: BenchConfig[],
  instances: BenchInstance[],
  budget: BenchBudget,
): Generator<{ result: RunResult; index: number; total: number }> {
  const total = configs.length * instances.length
  let index = 0
  for (const inst of instances) {
    for (const config of configs) {
      const result = runOne(config, inst, budget)
      index++
      yield { result, index, total }
    }
  }
}

/** Eagerly run the whole matrix (convenience wrapper over `benchSteps`). */
export function runBench(configs: BenchConfig[], instances: BenchInstance[], budget: BenchBudget): RunResult[] {
  const out: RunResult[] = []
  for (const step of benchSteps(configs, instances, budget)) out.push(step.result)
  return out
}

// ---------------------------------------------------------------------------
// Scoring & aggregation.
// ---------------------------------------------------------------------------

const solvedStatus = (s: RunResult['status']) => s === 'sat' || s === 'unsat'

export interface ConfigSummary {
  configId: string
  solved: number
  total: number
  unknown: number
  /** Total wall time over the instances this config actually solved (ms). */
  timeSolvedMs: number
  /** PAR-2 score: solved → its time; unsolved → 2 × the time cap. Lower is better. */
  par2: number
  meanConflicts: number
  meanDecisions: number
  meanPropagations: number
}

/**
 * SAT-Competition-style scoring. PAR-2 (Penalized Average Runtime, factor 2)
 * charges a timed-out instance twice the cap, so it rewards solving more
 * instances first and being fast second — the standard ranking metric.
 */
export function summarize(
  configs: BenchConfig[],
  instances: BenchInstance[],
  results: RunResult[],
  budget: BenchBudget,
): ConfigSummary[] {
  const penalty = 2 * (budget.maxTimeMs > 0 ? budget.maxTimeMs : 1)
  const byConfig = new Map<string, RunResult[]>()
  for (const r of results) {
    const list = byConfig.get(r.configId) ?? []
    list.push(r)
    byConfig.set(r.configId, list)
  }
  return configs.map((c) => {
    const rs = byConfig.get(c.id) ?? []
    let solved = 0
    let timeSolvedMs = 0
    let par2 = 0
    let conflicts = 0
    let decisions = 0
    let propagations = 0
    for (const r of rs) {
      conflicts += r.conflicts
      decisions += r.decisions
      propagations += r.propagations
      if (solvedStatus(r.status)) {
        solved++
        timeSolvedMs += r.timeMs
        par2 += r.timeMs
      } else {
        par2 += penalty
      }
    }
    const n = Math.max(1, rs.length)
    return {
      configId: c.id,
      solved,
      total: instances.length,
      unknown: rs.length - solved,
      timeSolvedMs,
      par2,
      meanConflicts: conflicts / n,
      meanDecisions: decisions / n,
      meanPropagations: propagations / n,
    }
  })
}

export interface CactusSeries {
  configId: string
  /** Sorted points: the i-th solved instance and the cumulative time to reach it. */
  points: Array<{ solved: number; cumTimeMs: number; instanceTimeMs: number }>
}

/**
 * Cactus-plot data. Each config's solved-instance times are sorted ascending and
 * accumulated, so a curve that stays low and reaches far to the right is a
 * strictly better solver: it solves more instances in less total time.
 */
export function cactus(configs: BenchConfig[], results: RunResult[]): CactusSeries[] {
  const byConfig = new Map<string, RunResult[]>()
  for (const r of results) {
    const list = byConfig.get(r.configId) ?? []
    list.push(r)
    byConfig.set(r.configId, list)
  }
  return configs.map((c) => {
    const times = (byConfig.get(c.id) ?? [])
      .filter((r) => solvedStatus(r.status))
      .map((r) => r.timeMs)
      .sort((a, b) => a - b)
    let cum = 0
    const points = times.map((t, i) => {
      cum += t
      return { solved: i + 1, cumTimeMs: cum, instanceTimeMs: t }
    })
    return { configId: c.id, points }
  })
}

// ---------------------------------------------------------------------------
// Soundness oracle — the heart of why this is more than a benchmark.
// ---------------------------------------------------------------------------

export interface Disagreement {
  instanceId: string
  kind: 'verdict' | 'expected' | 'bad-model'
  detail: string
}

/**
 * Cross-check the configurations against each other and against known ground
 * truth. Because every configuration is the same sound+complete CDCL engine with
 * one heuristic flipped, ANY of these firing is a real bug:
 *   • 'verdict'   — two configs decided the same instance SAT vs. UNSAT,
 *   • 'expected'  — a config contradicted a known a-priori status,
 *   • 'bad-model' — a config reported SAT with a model that fails the CNF.
 * On a healthy build this always returns `[]`.
 */
export function agreementErrors(
  instances: BenchInstance[],
  results: RunResult[],
): Disagreement[] {
  const errors: Disagreement[] = []
  const expected = new Map(instances.map((i) => [i.id, i.expected]))
  const byInstance = new Map<string, RunResult[]>()
  for (const r of results) {
    const list = byInstance.get(r.instanceId) ?? []
    list.push(r)
    byInstance.set(r.instanceId, list)
  }
  for (const [instanceId, rs] of byInstance) {
    let sawSat = false
    let sawUnsat = false
    for (const r of rs) {
      if (r.status === 'sat') sawSat = true
      if (r.status === 'unsat') sawUnsat = true
      if (r.status === 'sat' && !r.modelOk)
        errors.push({ instanceId, kind: 'bad-model', detail: `${r.configId} reported SAT with an invalid model` })
      const exp = expected.get(instanceId)
      if (exp && solvedStatus(r.status) && r.status !== exp)
        errors.push({ instanceId, kind: 'expected', detail: `${r.configId} said ${r.status}, expected ${exp}` })
    }
    if (sawSat && sawUnsat)
      errors.push({ instanceId, kind: 'verdict', detail: 'configurations disagree: SAT vs UNSAT' })
  }
  return errors
}
