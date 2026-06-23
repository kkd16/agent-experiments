// Wave Function Collapse on a hexagonal lattice — the square core (../wfc/solver.ts) carried onto
// a 6-neighbour axial hex grid. Same machinery, same guarantees: support-counter constraint
// propagation (the fast-WFC method, here six counters per tile), weighted minimum-Shannon-entropy
// observation with seeded tie-break noise, an initial arc-consistency purge so a structurally
// unplaceable tile can never survive to "done", and snapshot-based chronological backtracking
// within a budget. Pins/connectivity are out of scope for the hex side — it is a pure adjacency
// solve, like the 3D engine.

import { DELTA_AX, DIRS6, opposite6, type Dir6 } from './hexgrid';
import { hashSeed, makeRng, type Rng } from '../wfc/prng';
import type { CompiledHexTileset } from './types_hex';

export type HexSolverStatus = 'running' | 'done' | 'failed';

export type HexSolverOptions = {
  cols: number; // q ∈ [0, cols)
  rows: number; // r ∈ [0, rows)
  seed: string;
  wrap: boolean;
  backtracking: boolean;
  backtrackBudget: number;
};

type Snapshot = { wave: Uint8Array; cell: number; tile: number };

const SUPPORTED = 1 << 20; // sentinel "always supported" for off-grid neighbours (bounded edges)

export class HexSolver {
  readonly cols: number;
  readonly rows: number;
  readonly cells: number;
  readonly n: number;
  readonly set: CompiledHexTileset;
  readonly opts: HexSolverOptions;

  private rng: Rng;
  private wave: Uint8Array; // cells * n  (1 = still possible)
  private numPossible: Int32Array;
  private sumW: Float64Array;
  private sumWLogW: Float64Array;
  private compat: Int32Array; // cells * n * 6 support counters
  private sumR: Float64Array;
  private sumG: Float64Array;
  private sumB: Float64Array;

  private stack: number[] = []; // interleaved (cell, tile)
  private snapshots: Snapshot[] = [];

  status: HexSolverStatus = 'running';
  collapsedCount = 0;
  contradictions = 0;
  backtracks = 0;
  steps = 0;
  /** Bumped on every wave mutation so the renderer knows the field is dirty. */
  generation = 0;

  constructor(set: CompiledHexTileset, opts: HexSolverOptions) {
    this.set = set;
    this.opts = opts;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.cells = this.cols * this.rows;
    this.n = set.variants.length;
    this.rng = makeRng(hashSeed(opts.seed));
    this.wave = new Uint8Array(this.cells * this.n);
    this.numPossible = new Int32Array(this.cells);
    this.sumW = new Float64Array(this.cells);
    this.sumWLogW = new Float64Array(this.cells);
    this.compat = new Int32Array(this.cells * this.n * 6);
    this.sumR = new Float64Array(this.cells);
    this.sumG = new Float64Array(this.cells);
    this.sumB = new Float64Array(this.cells);
    this.reset();
  }

  // ---- grid helpers --------------------------------------------------------

  private neighbor(cell: number, d: Dir6): number {
    const q = cell % this.cols;
    const r = (cell / this.cols) | 0;
    const [dq, dr] = DELTA_AX[d];
    let nq = q + dq;
    let nr = r + dr;
    if (this.opts.wrap) {
      nq = ((nq % this.cols) + this.cols) % this.cols;
      nr = ((nr % this.rows) + this.rows) % this.rows;
    } else if (nq < 0 || nr < 0 || nq >= this.cols || nr >= this.rows) {
      return -1;
    }
    return nq + this.cols * nr;
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
    this.generation++;
    this.purgeUnsupported();
    this.recountCollapsed();
    if (this.status === 'running' && this.collapsedCount === this.cells) this.status = 'done';
  }

  private rebuildCompat(): void {
    const { n, set } = this;
    for (let cell = 0; cell < this.cells; cell++) {
      for (let t = 0; t < n; t++) {
        const base = (cell * n + t) * 6;
        const possible = this.wave[cell * n + t] === 1;
        for (const d of DIRS6) {
          if (!possible) {
            this.compat[base + d] = 0;
            continue;
          }
          const nb = this.neighbor(cell, d);
          if (nb < 0) {
            this.compat[base + d] = SUPPORTED;
            continue;
          }
          let count = 0;
          const list = set.allowed[d][t];
          for (let i = 0; i < list.length; i++) if (this.wave[nb * n + list[i]] === 1) count++;
          this.compat[base + d] = count;
        }
      }
    }
  }

  /** Ban tiles whose support is already zero in some on-grid direction (the arc-consistency purge). */
  private purgeUnsupported(): void {
    const { n } = this;
    for (let cell = 0; cell < this.cells; cell++) {
      for (let t = 0; t < n; t++) {
        if (this.wave[cell * n + t] === 0) continue;
        const base = (cell * n + t) * 6;
        let dead = false;
        for (const d of DIRS6) {
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
  }

  private recountCollapsed(): void {
    let collapsed = 0;
    for (let c = 0; c < this.cells; c++) if (this.numPossible[c] === 1) collapsed++;
    this.collapsedCount = collapsed;
  }

  // ---- core ----------------------------------------------------------------

  private ban(cell: number, tile: number): void {
    const idx = cell * this.n + tile;
    if (this.wave[idx] === 0) return;
    this.wave[idx] = 0;
    const base = idx * 6;
    for (const d of DIRS6) this.compat[base + d] = 0;
    this.numPossible[cell]--;
    this.sumW[cell] -= this.set.weights[tile];
    this.sumWLogW[cell] -= this.set.weightLogWeights[tile];
    const avg = this.set.variants[tile].avg;
    this.sumR[cell] -= avg[0];
    this.sumG[cell] -= avg[1];
    this.sumB[cell] -= avg[2];
    this.stack.push(cell, tile);
  }

  private propagate(): boolean {
    const { n, set } = this;
    while (this.stack.length) {
      const tile = this.stack.pop()!;
      const cell = this.stack.pop()!;
      for (const d of DIRS6) {
        const nb = this.neighbor(cell, d);
        if (nb < 0) continue;
        const list = set.allowed[d][tile];
        const opp = opposite6(d);
        for (let i = 0; i < list.length; i++) {
          const t2 = list[i];
          const cbase = (nb * n + t2) * 6 + opp;
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
    for (let t = 0; t < n; t++) if (t !== tile && this.wave[cell * n + t] === 1) this.ban(cell, t);
    return this.propagate();
  }

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

  private handleContradiction(): void {
    this.contradictions++;
    if (this.opts.backtracking && this.backtracks < this.opts.backtrackBudget && this.backtrack()) {
      return;
    }
    this.status = 'failed';
  }

  /** One observation + full propagation. */
  step(): HexSolverStatus {
    if (this.status !== 'running') return this.status;
    const cell = this.chooseCell();
    if (cell === -1) {
      this.status = 'done';
      this.recountCollapsed();
      return this.status;
    }
    const tile = this.chooseTile(cell);
    if (this.opts.backtracking) {
      this.snapshots.push({ wave: this.wave.slice(), cell, tile });
      if (this.snapshots.length > 256) this.snapshots.shift();
    }
    this.steps++;
    const ok = this.collapse(cell, tile);
    if (!ok) this.handleContradiction();
    this.generation++;
    this.recountCollapsed();
    if (this.collapsedCount === this.cells && this.status === 'running') this.status = 'done';
    return this.status;
  }

  // ---- read-out for the renderer ------------------------------------------

  collapsedTile(cell: number): number {
    if (this.numPossible[cell] !== 1) return -1;
    const { n } = this;
    for (let t = 0; t < n; t++) if (this.wave[cell * n + t] === 1) return t;
    return -1;
  }

  possibilities(cell: number): number {
    return this.numPossible[cell];
  }

  /** Normalised entropy in [0, 1] for the heatmap overlay (1 = fully superposed). */
  entropy01(cell: number): number {
    if (this.n <= 1) return 0;
    return Math.log(Math.max(1, this.numPossible[cell])) / Math.log(this.n);
  }

  ghostColor(cell: number): [number, number, number] {
    const c = this.numPossible[cell] || 1;
    return [this.sumR[cell] / c, this.sumG[cell] / c, this.sumB[cell] / c];
  }

  get total(): number {
    return this.cells;
  }
}
