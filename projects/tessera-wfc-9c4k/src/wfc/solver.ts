import {
  forcedConnectors,
  networkFeasible,
  terminalsFeasible,
  type ConnMode,
  type ConnView,
} from './connectivity';
import { DELTA, DIRS, opposite, type Dir } from './edges';
import { hashSeed, makeRng, type Rng } from './prng';
import type { CompiledTileset } from './types';

export type SolverStatus = 'running' | 'done' | 'failed';

/**
 * Optional global connectivity constraint layered on top of the local adjacency solve. Active
 * only when the tileset has open sockets (`CompiledTileset.openMask`); otherwise ignored.
 */
export type ConnectivityOptions = {
  /** 'network' = all connector cells form one component; 'terminals' = the given cells link up. */
  mode: ConnMode;
  /** Cell indices that must end up mutually connected (used by 'terminals' mode). */
  terminals?: readonly number[];
};

/** Grids larger than this skip the (heavier) cut-vertex forcing — feasibility + final check still run. */
const CONN_FORCE_LIMIT = 4096;

export type SolverOptions = {
  width: number;
  height: number;
  seed: string;
  wrap: boolean;
  backtracking: boolean;
  /** Maximum cumulative backtracks before the run gives up (and the host restarts). */
  backtrackBudget: number;
  /**
   * Hand-placed constraints, applied once after the initial arc-consistency purge: each entry
   * collapses `cell` to `tile` and propagates. Re-supplied on every (re)seed so painted
   * constraints survive restarts. A pin that can't be satisfied is skipped (not fatal).
   */
  pins?: ReadonlyArray<readonly [number, number]>;
  /** Optional global connectivity constraint (see {@link ConnectivityOptions}). */
  connectivity?: ConnectivityOptions;
};

type Snapshot = { wave: Uint8Array; cell: number; tile: number };

const SUPPORTED = 1 << 20; // sentinel "always supported" count for off-grid neighbours

/**
 * Wave Function Collapse — simple tiled model with support-counter propagation
 * (the fast-WFC three-counter method) and snapshot-based chronological backtracking.
 */
export class Solver {
  readonly width: number;
  readonly height: number;
  readonly cells: number;
  readonly n: number; // tile count
  readonly set: CompiledTileset;
  readonly opts: SolverOptions;

  private rng: Rng;
  private wave: Uint8Array; // cells * n  (1 = still possible)
  private numPossible: Int32Array; // per cell
  private sumW: Float64Array; // per cell: Σ weight
  private sumWLogW: Float64Array; // per cell: Σ weight·log(weight)
  private compat: Int32Array; // cells * n * 4 support counters
  // running colour sums per cell, for cheap superposition ghosting
  private sumR: Float64Array;
  private sumG: Float64Array;
  private sumB: Float64Array;

  private stack: number[] = []; // propagation stack: interleaved (cell, tile)
  private snapshots: Snapshot[] = [];

  // Global connectivity constraint, enabled only when the set has open sockets. `null` = the
  // solver behaves exactly as the unconstrained v2 engine (the default).
  private conn: ConnectivityOptions | null;
  private openMask: Uint8Array | null;

  status: SolverStatus = 'running';
  collapsedCount = 0;
  contradictions = 0;
  backtracks = 0;
  steps = 0;

  constructor(set: CompiledTileset, opts: SolverOptions) {
    this.set = set;
    this.opts = opts;
    this.width = opts.width;
    this.height = opts.height;
    this.cells = opts.width * opts.height;
    this.n = set.variants.length;
    this.openMask = set.openMask ?? null;
    this.conn = opts.connectivity && this.openMask ? opts.connectivity : null;
    this.rng = makeRng(hashSeed(opts.seed));
    this.wave = new Uint8Array(this.cells * this.n);
    this.numPossible = new Int32Array(this.cells);
    this.sumW = new Float64Array(this.cells);
    this.sumWLogW = new Float64Array(this.cells);
    this.compat = new Int32Array(this.cells * this.n * 4);
    this.sumR = new Float64Array(this.cells);
    this.sumG = new Float64Array(this.cells);
    this.sumB = new Float64Array(this.cells);
    this.reset();
  }

  // ---- grid helpers --------------------------------------------------------

  private neighbor(cell: number, d: Dir): number {
    const x = cell % this.width;
    const y = (cell / this.width) | 0;
    const [dx, dy] = DELTA[d];
    let nx = x + dx;
    let ny = y + dy;
    if (this.opts.wrap) {
      nx = (nx + this.width) % this.width;
      ny = (ny + this.height) % this.height;
    } else if (nx < 0 || ny < 0 || nx >= this.width || ny >= this.height) {
      return -1;
    }
    return ny * this.width + nx;
  }

  // ---- initialisation ------------------------------------------------------

  reset(): void {
    const { n, set } = this;
    let totR = 0;
    let totG = 0;
    let totB = 0;
    let totW = 0;
    let totWLW = 0;
    for (let t = 0; t < n; t++) {
      totR += set.variants[t].avg[0];
      totG += set.variants[t].avg[1];
      totB += set.variants[t].avg[2];
      totW += set.weights[t];
      totWLW += set.weightLogWeights[t];
    }
    this.wave.fill(1);
    this.numPossible.fill(n);
    this.sumW.fill(totW);
    this.sumWLogW.fill(totWLW);
    this.sumR.fill(totR);
    this.sumG.fill(totG);
    this.sumB.fill(totB);
    this.rebuildCompat();
    this.stack = [];
    this.snapshots = [];
    this.status = 'running';
    this.collapsedCount = 0;
    this.contradictions = 0;
    this.backtracks = 0;
    this.steps = 0;
    this.purgeUnsupported();
  }

  /**
   * Initial arc-consistency purge. A tile whose support count in some *on-grid* direction is
   * already zero (its `allowed` list there is structurally empty) can never satisfy adjacency
   * in that direction, so it must be banned everywhere it isn't rescued by an off-grid edge.
   *
   * The support-counter loop in `propagate` only bans on the transition *to* zero, so a tile
   * that starts at zero is otherwise never removed. With bounded edges off-grid neighbours
   * count as `SUPPORTED`, so such tiles simply pin to the border; on a torus there are no
   * off-grid edges, and without this purge an unplaceable tile could be collapsed into the
   * grid — declaring "done" with an adjacency violation. Running it once up front makes both
   * models correct on the torus (it is a no-op for tilesets whose every edge has a match).
   */
  private purgeUnsupported(): void {
    const { n } = this;
    for (let cell = 0; cell < this.cells; cell++) {
      for (let t = 0; t < n; t++) {
        if (this.wave[cell * n + t] === 0) continue;
        const base = (cell * n + t) * 4;
        let dead = false;
        for (const d of DIRS) {
          if (this.compat[base + d] === 0) {
            dead = true;
            break;
          }
        }
        if (dead) {
          this.ban(cell, t);
          if (this.numPossible[cell] === 0) {
            this.status = 'failed';
            this.stack = [];
            return;
          }
        }
      }
    }
    if (!this.propagate()) this.status = 'failed';
    this.stack = [];
    this.applyPins();
    // Seed the connectivity constraint once up front: force the cells every terminal route must
    // cross, and reject a config that is already globally unroutable (so the host stops instead
    // of restarting forever). A no-op when connectivity is disabled.
    if (this.conn && this.status === 'running') {
      if (!this.enforceConnectivity()) this.status = 'failed';
      this.stack = [];
    }
    this.recountCollapsed();
  }

  /** Apply the constructor's hand-placed constraints. Unsatisfiable pins are skipped. */
  private applyPins(): void {
    const pins = this.opts.pins;
    if (!pins || this.status !== 'running') return;
    for (const [cell, tile] of pins) {
      if (cell < 0 || cell >= this.cells || tile < 0 || tile >= this.n) continue;
      // A pin that can't be satisfied is skipped — `pin` reverts the wave and returns false.
      this.pin(cell, tile);
    }
  }

  private recountCollapsed(): void {
    let collapsed = 0;
    for (let c = 0; c < this.cells; c++) if (this.numPossible[c] === 1) collapsed++;
    this.collapsedCount = collapsed;
  }

  /** Recompute every support counter from the current wave (used at init + on restore). */
  private rebuildCompat(): void {
    const { width, height, n, set } = this;
    for (let cell = 0; cell < this.cells; cell++) {
      for (let t = 0; t < n; t++) {
        const base = (cell * n + t) * 4;
        const possible = this.wave[cell * n + t] === 1;
        for (const d of DIRS) {
          if (!possible) {
            this.compat[base + d] = 0;
            continue;
          }
          const nb = this.neighborStatic(cell, d as Dir, width, height);
          if (nb < 0) {
            this.compat[base + d] = SUPPORTED;
            continue;
          }
          let count = 0;
          const list = set.allowed[d as Dir][t];
          for (let i = 0; i < list.length; i++) {
            if (this.wave[nb * n + list[i]] === 1) count++;
          }
          this.compat[base + d] = count;
        }
      }
    }
  }

  // neighbor lookup that doesn't allocate, used in the hot rebuild loop
  private neighborStatic(cell: number, d: Dir, width: number, height: number): number {
    const x = cell % width;
    const y = (cell / width) | 0;
    const [dx, dy] = DELTA[d];
    let nx = x + dx;
    let ny = y + dy;
    if (this.opts.wrap) {
      nx = (nx + width) % width;
      ny = (ny + height) % height;
    } else if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
      return -1;
    }
    return ny * width + nx;
  }

  // ---- core ----------------------------------------------------------------

  private ban(cell: number, tile: number): void {
    const idx = cell * this.n + tile;
    if (this.wave[idx] === 0) return;
    this.wave[idx] = 0;
    const base = idx * 4;
    for (const d of DIRS) this.compat[base + d] = 0;
    this.numPossible[cell]--;
    this.sumW[cell] -= this.set.weights[tile];
    this.sumWLogW[cell] -= this.set.weightLogWeights[tile];
    const avg = this.set.variants[tile].avg;
    this.sumR[cell] -= avg[0];
    this.sumG[cell] -= avg[1];
    this.sumB[cell] -= avg[2];
    this.stack.push(cell, tile);
  }

  /** Drain the propagation stack. Returns false on a contradiction (an emptied cell). */
  private propagate(): boolean {
    const { n, set } = this;
    while (this.stack.length) {
      const tile = this.stack.pop()!;
      const cell = this.stack.pop()!;
      for (const d of DIRS) {
        const nb = this.neighbor(cell, d as Dir);
        if (nb < 0) continue;
        const list = set.allowed[d as Dir][tile];
        const opp = opposite(d as Dir);
        for (let i = 0; i < list.length; i++) {
          const t2 = list[i];
          const cbase = (nb * n + t2) * 4 + opp;
          if (this.compat[cbase] === SUPPORTED) continue;
          const left = --this.compat[cbase];
          if (left === 0 && this.wave[nb * n + t2] === 1) {
            this.ban(nb, t2);
            if (this.numPossible[nb] === 0) return false;
          }
        }
      }
    }
    return true;
  }

  /** Lowest-entropy uncollapsed cell, with seeded noise to break ties. Returns -1 if done. */
  private chooseCell(): number {
    let best = -1;
    let bestEntropy = Infinity;
    for (let cell = 0; cell < this.cells; cell++) {
      const c = this.numPossible[cell];
      if (c <= 1) continue;
      const entropy = Math.log(this.sumW[cell]) - this.sumWLogW[cell] / this.sumW[cell];
      const noisy = entropy + this.rng.next() * 1e-6;
      if (noisy < bestEntropy) {
        bestEntropy = noisy;
        best = cell;
      }
    }
    return best;
  }

  private chooseTile(cell: number): number {
    const { n } = this;
    const weights: number[] = [];
    const tiles: number[] = [];
    let total = 0;
    for (let t = 0; t < n; t++) {
      if (this.wave[cell * n + t] === 1) {
        weights.push(this.set.weights[t]);
        tiles.push(t);
        total += this.set.weights[t];
      }
    }
    return tiles[this.rng.weighted(weights, total)];
  }

  private collapse(cell: number, tile: number): boolean {
    const { n } = this;
    for (let t = 0; t < n; t++) {
      if (t !== tile && this.wave[cell * n + t] === 1) this.ban(cell, t);
    }
    return this.propagate();
  }

  /** Restore the most recent decision, forbid the value it tried, and re-propagate. */
  private backtrack(): boolean {
    while (this.snapshots.length) {
      const snap = this.snapshots.pop()!;
      this.wave.set(snap.wave);
      this.recomputeDerived();
      this.rebuildCompat();
      this.stack = [];
      this.backtracks++;
      this.ban(snap.cell, snap.tile);
      if (this.numPossible[snap.cell] > 0 && this.propagate()) return true;
      // still broken — keep unwinding
    }
    return false;
  }

  private recomputeDerived(): void {
    const { n, set } = this;
    for (let cell = 0; cell < this.cells; cell++) {
      let count = 0;
      let w = 0;
      let wlw = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let t = 0; t < n; t++) {
        if (this.wave[cell * n + t] === 1) {
          count++;
          w += set.weights[t];
          wlw += set.weightLogWeights[t];
          r += set.variants[t].avg[0];
          g += set.variants[t].avg[1];
          b += set.variants[t].avg[2];
        }
      }
      this.numPossible[cell] = count;
      this.sumW[cell] = w;
      this.sumWLogW[cell] = wlw;
      this.sumR[cell] = r;
      this.sumG[cell] = g;
      this.sumB[cell] = b;
    }
  }

  /** Handle a contradiction (local or global): backtrack within budget, else mark failed. */
  private handleContradiction(): void {
    this.contradictions++;
    if (this.opts.backtracking && this.backtracks < this.opts.backtrackBudget && this.backtrack()) {
      return; // recovered
    }
    this.status = 'failed';
  }

  /** One observation + full propagation. Drives the animation, one call per logical step. */
  step(): SolverStatus {
    if (this.status !== 'running') return this.status;
    const cell = this.chooseCell();
    if (cell === -1) {
      // Fully collapsed — validate the global constraint before declaring success. A finished
      // grid that violates connectivity is a contradiction we backtrack out of, never a "done".
      if (this.finishOk()) this.status = 'done';
      else this.handleContradiction();
      this.recountCollapsed();
      return this.status;
    }
    const tile = this.chooseTile(cell);
    if (this.opts.backtracking) {
      this.snapshots.push({ wave: this.wave.slice(), cell, tile });
      // bound memory: forget the deepest branch point if we go very deep
      if (this.snapshots.length > 512) this.snapshots.shift();
    }
    this.steps++;
    let ok = this.collapse(cell, tile);
    // After local propagation succeeds, enforce the global connectivity constraint: a sound
    // contradiction (or forced bans) here drives the same backtracking machinery.
    if (ok && this.conn) ok = this.enforceConnectivity();
    if (!ok) this.handleContradiction();
    this.recountCollapsed();
    if (this.collapsedCount === this.cells && this.status === 'running') {
      // This step collapsed the last cell — validate the global constraint before "done".
      if (this.finishOk()) this.status = 'done';
      else this.handleContradiction();
      this.recountCollapsed();
    }
    return this.status;
  }

  // ---- global connectivity constraint -------------------------------------

  /** Reduce the live wave to the connectivity view connectivity.ts reasons over. */
  private connView(): ConnView {
    const { n, cells } = this;
    const om = this.openMask!;
    const mayOpen = new Uint8Array(cells);
    const mustConnector = new Uint8Array(cells);
    for (let cell = 0; cell < cells; cell++) {
      let mo = 0;
      let any = false;
      let blank = false;
      const base = cell * n;
      for (let t = 0; t < n; t++) {
        if (this.wave[base + t] === 1) {
          any = true;
          const m = om[t];
          mo |= m;
          if (m === 0) blank = true;
        }
      }
      mayOpen[cell] = mo;
      mustConnector[cell] = any && !blank ? 1 : 0;
    }
    return { width: this.width, height: this.height, wrap: this.opts.wrap, cells, mayOpen, mustConnector };
  }

  /** Does a (view of the) wave satisfy the active connectivity property? */
  private connSatisfied(view: ConnView): boolean {
    const conn = this.conn!;
    if (conn.mode === 'terminals') return terminalsFeasible(view, conn.terminals ?? []);
    return networkFeasible(view);
  }

  /** True if the (assumed fully-collapsed) grid satisfies the global constraint. */
  private finishOk(): boolean {
    if (!this.conn) return true;
    return this.connSatisfied(this.connView());
  }

  /**
   * Enforce connectivity on the current partial wave. For terminal routing it iterates
   * forced-connector inference to a fixpoint (banning blank tiles at cut cells and propagating),
   * then checks feasibility; for whole-network mode it checks optimistic feasibility. Returns
   * false on a sound contradiction (which the caller turns into a backtrack).
   */
  private enforceConnectivity(): boolean {
    const conn = this.conn!;
    if (conn.mode === 'terminals') {
      const terminals = conn.terminals ?? [];
      if (terminals.length < 2) return true; // nothing to route
      if (this.cells <= CONN_FORCE_LIMIT) {
        for (let iter = 0; iter < this.cells; iter++) {
          const view = this.connView();
          const forced = forcedConnectors(view, terminals);
          if (forced === null) return false; // terminals already unroutable
          let changed = false;
          for (const c of forced) {
            const base = c * this.n;
            for (let t = 0; t < this.n; t++) {
              if (this.wave[base + t] === 1 && this.openMask![t] === 0) {
                this.ban(c, t);
                changed = true;
              }
            }
            if (this.numPossible[c] === 0) return false;
          }
          if (!changed) break;
          if (!this.propagate()) return false;
        }
      }
      return terminalsFeasible(this.connView(), terminals);
    }
    return networkFeasible(this.connView());
  }

  /**
   * Force `cell` to `tile` and propagate the consequences — a hand-placed constraint. Returns
   * false (and leaves the wave untouched) if the tile is already banned there or the choice
   * leads to an immediate contradiction; true on success. Used both for live constraint
   * painting and to replay the constructor's pin map after a reseed.
   */
  pin(cell: number, tile: number): boolean {
    if (cell < 0 || cell >= this.cells || tile < 0 || tile >= this.n) return false;
    if (this.wave[cell * this.n + tile] === 0) return false; // tile already impossible here
    if (this.numPossible[cell] === 1) return true; // already collapsed to it
    const saved = this.wave.slice();
    this.stack = [];
    const ok = this.collapse(cell, tile);
    if (!ok) {
      // contradiction — roll back to exactly the pre-pin wave
      this.wave.set(saved);
      this.recomputeDerived();
      this.rebuildCompat();
      this.stack = [];
      return false;
    }
    this.recountCollapsed();
    if (this.collapsedCount === this.cells) this.status = 'done';
    return true;
  }

  // ---- read-out for the renderer ------------------------------------------

  /** Collapsed tile id for a cell, or -1 if still superposed/contradicted. */
  collapsedTile(cell: number): number {
    if (this.numPossible[cell] !== 1) return -1;
    const { n } = this;
    for (let t = 0; t < n; t++) if (this.wave[cell * n + t] === 1) return t;
    return -1;
  }

  possibilities(cell: number): number {
    return this.numPossible[cell];
  }

  /** The list of tile ids still possible at a cell (for the inspector). Capped for sanity. */
  possibleTiles(cell: number, cap = 64): number[] {
    const out: number[] = [];
    const { n } = this;
    for (let t = 0; t < n && out.length < cap; t++) {
      if (this.wave[cell * n + t] === 1) out.push(t);
    }
    return out;
  }

  /** Average colour of a cell's surviving possibilities (for ghosting). */
  ghostColor(cell: number): [number, number, number] {
    const c = this.numPossible[cell] || 1;
    return [this.sumR[cell] / c, this.sumG[cell] / c, this.sumB[cell] / c];
  }

  /** Normalised entropy in [0,1] for the heatmap (0 = collapsed, 1 = all options open). */
  normEntropy(cell: number): number {
    const c = this.numPossible[cell];
    if (c <= 1) return 0;
    return Math.log(c) / Math.log(this.n);
  }

  get total(): number {
    return this.cells;
  }

  // ---- connectivity read-out (for the overlay + stats) --------------------

  /** Whether this run has an active global connectivity constraint. */
  get connectivityActive(): boolean {
    return this.conn !== null;
  }

  get connectivityMode(): ConnMode | null {
    return this.conn ? this.conn.mode : null;
  }

  /** The 4-bit open-socket mask of a collapsed tile, or 0 for blank/uncollapsed. */
  cellOpenMask(cell: number): number {
    if (!this.openMask) return 0;
    const t = this.collapsedTile(cell);
    return t >= 0 ? this.openMask[t] : 0;
  }

  /**
   * A {@link ConnView} of just the *collapsed* connector cells — used to colour the network
   * overlay and report component counts. Uncollapsed cells are treated as non-nodes so the
   * overlay reflects what has actually crystallised. `null` when the set has no sockets.
   */
  collapsedConnView(): ConnView | null {
    if (!this.openMask) return null;
    const { cells } = this;
    const mayOpen = new Uint8Array(cells);
    const mustConnector = new Uint8Array(cells);
    for (let cell = 0; cell < cells; cell++) {
      const t = this.collapsedTile(cell);
      const m = t >= 0 ? this.openMask[t] : 0;
      mayOpen[cell] = m;
      mustConnector[cell] = m !== 0 ? 1 : 0;
    }
    return { width: this.width, height: this.height, wrap: this.opts.wrap, cells, mayOpen, mustConnector };
  }
}
