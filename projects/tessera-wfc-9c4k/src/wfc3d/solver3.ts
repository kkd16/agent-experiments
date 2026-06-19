// Wave Function Collapse in three dimensions — the 2D core (../wfc/solver.ts) lifted to a
// 6-neighbour cubic lattice. Same machinery, same guarantees: support-counter constraint
// propagation (the fast-WFC three-counter method, here six counters per tile), weighted
// minimum-Shannon-entropy observation with seeded tie-break noise, an initial arc-consistency
// purge so a structurally-unplaceable tile can never survive to "done", and snapshot-based
// chronological backtracking within a budget. Connectivity/pins from the 2D engine are dropped —
// the 3D side is a pure adjacency solve.

import { DELTA3, DIRS3, opposite3, type Dir3 } from './dirs3';
import { hashSeed, makeRng, type Rng } from '../wfc/prng';
import type { CompiledTileset3 } from './types3';

export type Solver3Status = 'running' | 'done' | 'failed';

export type Solver3Options = {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  seed: string;
  wrap: boolean;
  backtracking: boolean;
  backtrackBudget: number;
};

type Snapshot = { wave: Uint8Array; cell: number; tile: number };

const SUPPORTED = 1 << 20; // sentinel "always supported" for off-grid neighbours (bounded edges)

export class Solver3 {
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly cells: number;
  readonly n: number;
  readonly set: CompiledTileset3;
  readonly opts: Solver3Options;

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

  status: Solver3Status = 'running';
  collapsedCount = 0;
  contradictions = 0;
  backtracks = 0;
  steps = 0;
  /** Bumped on every wave mutation so the renderer knows the scene is dirty and must rebuild. */
  generation = 0;

  constructor(set: CompiledTileset3, opts: Solver3Options) {
    this.set = set;
    this.opts = opts;
    this.sx = opts.sizeX;
    this.sy = opts.sizeY;
    this.sz = opts.sizeZ;
    this.cells = this.sx * this.sy * this.sz;
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

  private coords(cell: number): [number, number, number] {
    const x = cell % this.sx;
    const y = ((cell / this.sx) | 0) % this.sy;
    const z = (cell / (this.sx * this.sy)) | 0;
    return [x, y, z];
  }

  private neighbor(cell: number, d: Dir3): number {
    const [x, y, z] = this.coords(cell);
    const [dx, dy, dz] = DELTA3[d];
    let nx = x + dx;
    let ny = y + dy;
    let nz = z + dz;
    if (this.opts.wrap) {
      nx = (nx + this.sx) % this.sx;
      ny = (ny + this.sy) % this.sy;
      nz = (nz + this.sz) % this.sz;
    } else if (nx < 0 || ny < 0 || nz < 0 || nx >= this.sx || ny >= this.sy || nz >= this.sz) {
      return -1;
    }
    return nx + this.sx * (ny + this.sy * nz);
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
    // every cell collapsed at t=0 (a 1-tile set) is still a valid "done"
    if (this.status === 'running' && this.collapsedCount === this.cells) this.status = 'done';
  }

  private rebuildCompat(): void {
    const { n, set } = this;
    for (let cell = 0; cell < this.cells; cell++) {
      for (let t = 0; t < n; t++) {
        const base = (cell * n + t) * 6;
        const possible = this.wave[cell * n + t] === 1;
        for (const d of DIRS3) {
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

  /** Ban tiles whose support is already zero in some on-grid direction (see the 2D engine note). */
  private purgeUnsupported(): void {
    const { n } = this;
    for (let cell = 0; cell < this.cells; cell++) {
      for (let t = 0; t < n; t++) {
        if (this.wave[cell * n + t] === 0) continue;
        const base = (cell * n + t) * 6;
        let dead = false;
        for (const d of DIRS3) {
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
    for (const d of DIRS3) this.compat[base + d] = 0;
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
      for (const d of DIRS3) {
        const nb = this.neighbor(cell, d);
        if (nb < 0) continue;
        const list = set.allowed[d][tile];
        const opp = opposite3(d);
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
  step(): Solver3Status {
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

  ghostColor(cell: number): [number, number, number] {
    const c = this.numPossible[cell] || 1;
    return [this.sumR[cell] / c, this.sumG[cell] / c, this.sumB[cell] / c];
  }

  get total(): number {
    return this.cells;
  }
}
