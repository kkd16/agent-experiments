// The Solver Lab's pluggable *search policy*: how WFC picks which cell to observe next, and which
// tile to collapse it to. These two choices are the entire "intelligence" of the search — they
// don't change *what* solutions are legal (the adjacency tensor does that), only which one the
// solver walks to and how much backtracking it takes to get there. Pulling them out as small,
// pure functions makes them swappable from the UI and, more importantly, *testable in isolation*:
// the Proof Lab pins down each one's mechanics directly, no canvas or solver required.

/**
 * Cell-selection heuristic — the order in which the wavefunction is observed.
 *
 * - `entropy`  : lowest Shannon-entropy cell (the classic WFC heuristic; handled in the solver
 *                because it needs the live weight sums). Tends to grow coherent regions.
 * - `mrv`      : minimum remaining values — fewest surviving options first. The textbook CSP
 *                "most-constrained variable" rule; fails fast and usually backtracks the least.
 * - `scanline` : strict top-left raster order. Deliberately naive — great for *seeing* why a
 *                blind order paints itself into corners far more often.
 * - `random`   : a uniformly-random uncollapsed cell. The maximum-disorder baseline.
 */
export type CellHeuristic = 'entropy' | 'mrv' | 'scanline' | 'random';

/**
 * Tile-selection policy — given a cell's surviving options, which one to collapse to.
 *
 * - `weighted` : sample proportional to tile frequency weights (the default WFC behaviour).
 * - `uniform`  : sample each surviving option with equal probability (ignores weights).
 * - `greedy`   : always take the highest-weight option (deterministic, no randomness consumed).
 */
export type TilePolicy = 'weighted' | 'uniform' | 'greedy';

export const CELL_HEURISTICS: CellHeuristic[] = ['entropy', 'mrv', 'scanline', 'random'];
export const TILE_POLICIES: TilePolicy[] = ['weighted', 'uniform', 'greedy'];

export const HEURISTIC_LABEL: Record<CellHeuristic, string> = {
  entropy: 'Entropy',
  mrv: 'MRV',
  scanline: 'Scanline',
  random: 'Random',
};

export const POLICY_LABEL: Record<TilePolicy, string> = {
  weighted: 'Weighted',
  uniform: 'Uniform',
  greedy: 'Greedy',
};

/** An uncollapsed cell has ≥ 2 surviving possibilities; 1 = collapsed, 0 = contradiction. */
const UNCOLLAPSED = (numPossible: ArrayLike<number>, cell: number) => numPossible[cell] > 1;

/** First (lowest-index) uncollapsed cell in raster order, or -1 if every cell is settled. */
export function scanlineCell(numPossible: ArrayLike<number>, cells: number): number {
  for (let cell = 0; cell < cells; cell++) if (UNCOLLAPSED(numPossible, cell)) return cell;
  return -1;
}

/**
 * Minimum-remaining-values cell: the uncollapsed cell with the fewest surviving options, with a
 * small seeded jitter to break ties without biasing toward low indices. Returns -1 if done.
 */
export function mrvCell(numPossible: ArrayLike<number>, cells: number, rand: () => number): number {
  let best = -1;
  let bestScore = Infinity;
  for (let cell = 0; cell < cells; cell++) {
    if (!UNCOLLAPSED(numPossible, cell)) continue;
    // jitter < 1 so it can only reorder genuine ties (equal integer counts), never overtake a
    // strictly smaller count.
    const score = numPossible[cell] + rand() * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = cell;
    }
  }
  return best;
}

/**
 * A uniformly-random uncollapsed cell, chosen by reservoir sampling so it needs a single pass and
 * no allocation. Deterministic given the rng. Returns -1 if done.
 */
export function randomCell(numPossible: ArrayLike<number>, cells: number, rand: () => number): number {
  let chosen = -1;
  let seen = 0;
  for (let cell = 0; cell < cells; cell++) {
    if (!UNCOLLAPSED(numPossible, cell)) continue;
    seen++;
    // keep the k-th candidate with probability 1/k → every candidate ends up equally likely.
    if (rand() * seen < 1) chosen = cell;
  }
  return chosen;
}

/**
 * Pick an index into a cell's surviving-option list under the given policy. `weights` are the
 * tile frequency weights aligned to that list. `rand` supplies the (seeded) randomness; `greedy`
 * consumes none. Returns -1 only for an empty list (which the caller treats as a contradiction).
 *
 * The `weighted` branch is byte-for-byte the original WFC sampler (so existing seeds reproduce
 * exactly): draw `r ∈ [0,total)` and walk the cumulative weights, with a float-drift fallback.
 */
export function tileIndex(policy: TilePolicy, weights: number[], rand: () => number): number {
  const len = weights.length;
  if (len === 0) return -1;
  if (len === 1) return 0;
  if (policy === 'uniform') {
    return Math.min(len - 1, Math.floor(rand() * len));
  }
  if (policy === 'greedy') {
    let bi = 0;
    let bw = weights[0];
    for (let i = 1; i < len; i++) {
      if (weights[i] > bw) {
        bw = weights[i];
        bi = i;
      }
    }
    return bi;
  }
  // weighted (default)
  let total = 0;
  for (let i = 0; i < len; i++) total += weights[i];
  let r = rand() * total;
  for (let i = 0; i < len; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  for (let i = len - 1; i >= 0; i--) if (weights[i] > 0) return i;
  return 0;
}
