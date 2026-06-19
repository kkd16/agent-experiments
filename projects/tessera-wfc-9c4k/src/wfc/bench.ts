// The Solver Lab benchmark: run the *real* solver across many seeds under different search
// policies and measure what each one actually costs. WFC's search heuristic is invisible in a
// single run — you can't tell whether "entropy" earned its keep or whether plain scanline would
// have done. Running the same instance dozens of times and tabulating success rate, search depth,
// backtracks and propagation work makes the trade-off legible: this is the empirical companion to
// the Proof Lab's correctness proofs.
//
// Everything here is pure and deterministic given the seeds (only wall-clock `ms` varies), so the
// Proof Lab pins down the aggregation arithmetic directly.

import type { CellHeuristic, TilePolicy } from './heuristics';
import { Solver, type SolverOptions } from './solver';
import type { CompiledTileset } from './types';

/** A single search configuration to benchmark. */
export type BenchStrategy = {
  heuristic: CellHeuristic;
  tilePolicy: TilePolicy;
};

/** The shared instance every strategy is measured against (size, edges, budget). */
export type BenchBase = {
  width: number;
  height: number;
  wrap: boolean;
  backtracking: boolean;
  backtrackBudget: number;
  /** Seeds are derived from this so two strategies see the *same* instances. */
  seedBase: string;
};

/** The outcome of one solve attempt (totals are summed across the controller-style restarts). */
export type RunOutcome = {
  solved: boolean;
  steps: number;
  backtracks: number;
  contradictions: number;
  eliminations: number;
  peakDepth: number;
  restarts: number;
  ms: number;
};

/** Aggregated results for one strategy over a batch of seeds. */
export type BenchRow = {
  heuristic: CellHeuristic;
  tilePolicy: TilePolicy;
  runs: number;
  solved: number;
  /** Fraction of runs that reached a full, valid collapse. */
  successRate: number;
  /** Means below are taken over the *solved* runs (0 when none solved), except `meanMs`. */
  meanSteps: number;
  meanBacktracks: number;
  meanContradictions: number;
  meanEliminations: number;
  meanPeakDepth: number;
  meanRestarts: number;
  /** Mean wall-clock time per run, over *all* attempts (timing is independent of success). */
  meanMs: number;
};

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Run one solve to a terminal state, reseeding on failure exactly the way the live controller
 * does, and summing the per-attempt instrumentation so the totals reflect the *whole* search
 * (every restart included). `peakDepth` is the max across attempts; `ms` is the wall time.
 */
export function runOne(set: CompiledTileset, baseOpts: SolverOptions, maxRestarts = 120): RunOutcome {
  const t0 = now();
  let solver = new Solver(set, baseOpts);
  let steps = 0;
  let backtracks = 0;
  let contradictions = 0;
  let eliminations = 0;
  let peakDepth = 0;
  let restarts = 0;

  const fold = (s: Solver) => {
    steps += s.steps;
    backtracks += s.backtracks;
    contradictions += s.contradictions;
    eliminations += s.eliminations;
    if (s.peakDepth > peakDepth) peakDepth = s.peakDepth;
  };
  const out = (solved: boolean): RunOutcome => ({
    solved,
    steps,
    backtracks,
    contradictions,
    eliminations,
    peakDepth,
    restarts,
    ms: now() - t0,
  });

  // A fresh solver can already be `failed` if its initial purge proved the config unsatisfiable.
  if (solver.status === 'failed') {
    fold(solver);
    return out(false);
  }
  // generous guard so a pathological instance can't wedge the loop
  for (let guard = 0; guard < 5_000_000; guard++) {
    const st = solver.step();
    if (st === 'done') {
      fold(solver);
      return out(true);
    }
    if (st === 'failed') {
      fold(solver);
      if (restarts >= maxRestarts) return out(false);
      restarts++;
      solver = new Solver(set, { ...baseOpts, seed: `${baseOpts.seed}#${restarts}` });
      if (solver.status === 'failed') {
        fold(solver);
        return out(false);
      }
    }
  }
  fold(solver);
  return out(false);
}

/** Aggregate a batch of outcomes for one strategy. Pure — the Proof Lab checks this directly. */
export function aggregate(strategy: BenchStrategy, outcomes: RunOutcome[]): BenchRow {
  const runs = outcomes.length;
  const solvedRuns = outcomes.filter((o) => o.solved);
  const solved = solvedRuns.length;
  const meanOver = (xs: RunOutcome[], pick: (o: RunOutcome) => number): number =>
    xs.length === 0 ? 0 : xs.reduce((a, o) => a + pick(o), 0) / xs.length;
  return {
    heuristic: strategy.heuristic,
    tilePolicy: strategy.tilePolicy,
    runs,
    solved,
    successRate: runs === 0 ? 0 : solved / runs,
    meanSteps: meanOver(solvedRuns, (o) => o.steps),
    meanBacktracks: meanOver(solvedRuns, (o) => o.backtracks),
    meanContradictions: meanOver(solvedRuns, (o) => o.contradictions),
    meanEliminations: meanOver(solvedRuns, (o) => o.eliminations),
    meanPeakDepth: meanOver(solvedRuns, (o) => o.peakDepth),
    meanRestarts: meanOver(solvedRuns, (o) => o.restarts),
    meanMs: meanOver(outcomes, (o) => o.ms),
  };
}

/**
 * Benchmark every strategy against `seeds` shared instances of `set`. Each strategy sees the same
 * derived seeds (`${seedBase}~b${i}`), so the comparison is apples-to-apples — only the search
 * policy differs.
 */
export function runBench(
  set: CompiledTileset,
  base: BenchBase,
  strategies: BenchStrategy[],
  seeds: number,
  maxRestarts = 120,
): BenchRow[] {
  return strategies.map((strat) => {
    const outcomes: RunOutcome[] = [];
    for (let i = 0; i < seeds; i++) {
      const opts: SolverOptions = {
        width: base.width,
        height: base.height,
        seed: `${base.seedBase}~b${i}`,
        wrap: base.wrap,
        backtracking: base.backtracking,
        backtrackBudget: base.backtrackBudget,
        heuristic: strat.heuristic,
        tilePolicy: strat.tilePolicy,
      };
      outcomes.push(runOne(set, opts, maxRestarts));
    }
    return aggregate(strat, outcomes);
  });
}

/** Render a results table as CSV (for the panel's "copy" button). */
export function benchToCsv(rows: BenchRow[]): string {
  const head = [
    'heuristic',
    'tilePolicy',
    'runs',
    'solved',
    'successRate',
    'meanSteps',
    'meanBacktracks',
    'meanContradictions',
    'meanEliminations',
    'meanPeakDepth',
    'meanRestarts',
    'meanMs',
  ];
  const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  const lines = rows.map((r) =>
    [
      r.heuristic,
      r.tilePolicy,
      r.runs,
      r.solved,
      r.successRate.toFixed(3),
      num(r.meanSteps),
      num(r.meanBacktracks),
      num(r.meanContradictions),
      num(r.meanEliminations),
      num(r.meanPeakDepth),
      num(r.meanRestarts),
      num(r.meanMs),
    ].join(','),
  );
  return [head.join(','), ...lines].join('\n');
}
