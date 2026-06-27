// The linearizability checker — a from-scratch Wing & Gong (1993) decision
// procedure.
//
// Deciding linearizability is NP-complete in general, so a naive checker would
// enumerate every interleaving (n! of them). Two ideas make it tractable on real
// histories:
//
//   1. *Real-time pruning.* In any valid linearization the next operation must be
//      one whose every real-time predecessor is already placed — exactly the
//      "available" set of a topological sort. So we never consider an ordering
//      that puts a late operation before one that already finished.
//
//   2. *Memoization (Wing & Gong's key trick).* The future of the search depends
//      only on (which operations remain, current model state) — not on the path
//      taken to get there. So once a (remaining-set, state) node is proven a dead
//      end, we never re-explore it. This collapses the exponential interleavings
//      down to the number of distinct reachable model states, which on a real
//      history is tiny because only the few currently-overlapping operations are
//      ever in play at once.
//
//   3. *Compositionality (locality).* Herlihy & Wing proved a history is
//      linearizable iff its restriction to each object is — so a multi-object
//      history (e.g. an ABD store keyed x/y/z) is split and each part checked
//      alone, an exponential win.
//
// When the answer is YES we return a *witness*: a concrete legal sequential order
// with the model-state transition at each step, so the certificate can be
// re-validated independently. When the answer is NO we return *blame*: the set of
// operations whose removal would make the history linearizable — a crisp pointer
// at the operation that went back in time.
import {
  eqValue,
  isPending,
  partitionByObject,
  precedes,
  type History,
  type Op,
  type Value,
} from './history';
import type { Spec } from './specs';

export interface SearchStats {
  ops: number;
  /** Distinct (remaining-set, state) search nodes expanded. */
  statesExplored: number;
  /** Times a node was skipped because it was already proven a dead end. */
  memoHits: number;
  /** Operation applications attempted (the raw work). */
  candidatesTried: number;
  /** Deepest the search recursed. */
  maxDepth: number;
}

export interface WitnessStep {
  op: Op;
  before: string;
  after: string;
  out: Value;
}

export interface PartResult {
  obj: string;
  linearizable: boolean;
  witness: WitnessStep[] | null;
  ops: number;
}

export interface LinzResult {
  linearizable: boolean;
  parts: PartResult[];
  stats: SearchStats;
  /** Op ids whose removal would restore linearizability (empty when LZ). */
  blame: number[];
  /** True if the search hit its node budget and bailed (verdict is then unsound). */
  timedOut: boolean;
}

export interface CheckOptions {
  /** Abort (timedOut) after this many search nodes. Default 4,000,000. */
  budget?: number;
  /** Whether to compute the blame set on a NO verdict. Default true. */
  blame?: boolean;
  /** Whether to apply the locality split by object id. Default true. */
  partition?: boolean;
}

const DEFAULT_BUDGET = 4_000_000;

class BudgetExceeded extends Error {}

function emptyStats(ops: number): SearchStats {
  return { ops, statesExplored: 0, memoHits: 0, candidatesTried: 0, maxDepth: 0 };
}

function mergeStats(a: SearchStats, b: SearchStats): SearchStats {
  return {
    ops: a.ops + b.ops,
    statesExplored: a.statesExplored + b.statesExplored,
    memoHits: a.memoHits + b.memoHits,
    candidatesTried: a.candidatesTried + b.candidatesTried,
    maxDepth: Math.max(a.maxDepth, b.maxDepth),
  };
}

/**
 * Decide whether a single-object history is linearizable against `spec`, and if
 * so produce one witness ordering. Returns the witness order as op-array indices
 * or null when not linearizable.
 */
function searchPart(
  ops: Op[],
  spec: Spec<unknown>,
  stats: SearchStats,
  budget: number,
): number[] | null {
  const n = ops.length;
  if (n === 0) return [];

  // Stable left-to-right order makes the witness read naturally and the search
  // deterministic.
  const order = ops
    .map((_, i) => i)
    .sort((a, b) => ops[a].call - ops[b].call || ops[a].ret - ops[b].ret || ops[a].id - ops[b].id);
  const sorted = order.map((i) => ops[i]);

  // preds[i] = indices j that must be linearized before i (j ≺ i in real time).
  const preds: number[][] = sorted.map((oi, i) => {
    const ps: number[] = [];
    for (let j = 0; j < n; j++) if (j !== i && precedes(sorted[j], oi)) ps.push(j);
    return ps;
  });

  const removed = new Array<boolean>(n).fill(false);
  let completeRemaining = sorted.reduce((c, o) => c + (isPending(o) ? 0 : 1), 0);
  const witness: number[] = [];
  const visited = new Set<string>();

  const memoKey = (stateHash: string): string => {
    let s = '';
    for (let i = 0; i < n; i++) if (!removed[i]) s += i + ',';
    return s + '|' + stateHash;
  };

  const dfs = (state: unknown, depth: number): boolean => {
    // Done once every *complete* op is placed; leftover pending ops simply
    // "didn't happen", which is allowed.
    if (completeRemaining === 0) return true;
    if (depth > stats.maxDepth) stats.maxDepth = depth;

    const k = memoKey(spec.hash(state));
    if (visited.has(k)) {
      stats.memoHits++;
      return false;
    }
    if (stats.statesExplored >= budget) throw new BudgetExceeded();
    stats.statesExplored++;

    for (let i = 0; i < n; i++) {
      if (removed[i]) continue;
      let ready = true;
      for (const j of preds[i]) {
        if (!removed[j]) {
          ready = false;
          break;
        }
      }
      if (!ready) continue;

      const o = sorted[i];
      const r = spec.apply(state, o.f, o.arg);
      stats.candidatesTried++;
      // A completed op must produce exactly its observed response; a pending op
      // may produce anything (we never saw its result).
      if (!isPending(o) && !eqValue(r.out, o.res ?? null)) continue;

      removed[i] = true;
      const wasComplete = !isPending(o);
      if (wasComplete) completeRemaining--;
      witness.push(i);

      if (dfs(r.state, depth + 1)) return true;

      witness.pop();
      removed[i] = false;
      if (wasComplete) completeRemaining++;
    }

    visited.add(k);
    return false;
  };

  const ok = dfs(spec.init(), 0);
  if (!ok) return null;
  // Map witness (indices into `sorted`) back to indices into the caller's `ops`.
  return witness.map((i) => order[i]);
}

function buildWitness(ops: Op[], orderIdx: number[], spec: Spec<unknown>): WitnessStep[] {
  let state = spec.init();
  const steps: WitnessStep[] = [];
  for (const i of orderIdx) {
    const o = ops[i];
    const before = spec.show(state);
    const r = spec.apply(state, o.f, o.arg);
    steps.push({ op: o, before, after: spec.show(r.state), out: r.out });
    state = r.state;
  }
  return steps;
}

function checkPart(obj: string, ops: Op[], spec: Spec<unknown>, budget: number): {
  part: PartResult;
  stats: SearchStats;
  timedOut: boolean;
} {
  const stats = emptyStats(ops.length);
  try {
    const orderIdx = searchPart(ops, spec, stats, budget);
    const part: PartResult = {
      obj,
      linearizable: orderIdx !== null,
      witness: orderIdx ? buildWitness(ops, orderIdx, spec) : null,
      ops: ops.length,
    };
    return { part, stats, timedOut: false };
  } catch (e) {
    if (e instanceof BudgetExceeded) {
      return { part: { obj, linearizable: false, witness: null, ops: ops.length }, stats, timedOut: true };
    }
    throw e;
  }
}

/** The main entry point: decide linearizability of a whole history. */
export function check(history: History, spec: Spec<unknown>, opts: CheckOptions = {}): LinzResult {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const doPartition = opts.partition ?? true;
  const doBlame = opts.blame ?? true;

  const parts = doPartition ? partitionByObject(history.ops) : new Map([['', history.ops]]);

  let stats = emptyStats(0);
  const partResults: PartResult[] = [];
  let timedOut = false;
  let linearizable = true;

  for (const [obj, ops] of parts) {
    const { part, stats: ps, timedOut: t } = checkPart(obj, ops, spec, budget);
    partResults.push(part);
    stats = mergeStats(stats, ps);
    timedOut = timedOut || t;
    if (!part.linearizable) linearizable = false;
  }
  partResults.sort((a, b) => a.obj.localeCompare(b.obj));

  let blame: number[] = [];
  if (!linearizable && !timedOut && doBlame && history.ops.length <= 40) {
    blame = computeBlame(history, spec, budget);
  }

  return { linearizable, parts: partResults, stats, blame, timedOut };
}

/** Check and also report wall-clock time (kept here so callers stay pure). */
export function checkTimed(
  history: History,
  spec: Spec<unknown>,
  opts: CheckOptions = {},
): { result: LinzResult; elapsedMs: number } {
  const t0 = performance.now();
  const result = check(history, spec, opts);
  return { result, elapsedMs: performance.now() - t0 };
}

/** Convenience: just the yes/no verdict. */
export function isLinearizable(history: History, spec: Spec<unknown>, opts: CheckOptions = {}): boolean {
  return check(history, spec, { ...opts, blame: false }).linearizable;
}

/**
 * The operations whose removal would make the history linearizable. A single such
 * operation is the clearest possible counterexample: "this read/dequeue returned
 * a value that no valid ordering allows." Computed by removing each operation in
 * turn and re-deciding — only over the failing object, so it stays cheap.
 */
function computeBlame(history: History, spec: Spec<unknown>, budget: number): number[] {
  const blamed: number[] = [];
  for (const victim of history.ops) {
    const without: History = { label: history.label, ops: history.ops.filter((o) => o.id !== victim.id) };
    if (isLinearizable(without, spec, { budget, partition: true })) blamed.push(victim.id);
  }
  return blamed;
}
