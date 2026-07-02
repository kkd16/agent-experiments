// Wave Function Collapse on an irregular all-quad mesh — the square/hex core carried onto a general
// graph. The machinery is identical to the lattice solvers (support-counter constraint propagation,
// weighted minimum-Shannon-entropy observation with seeded tie-break noise, an arc-consistency purge
// so a structurally-unplaceable tile can never survive to "done", and snapshot-based chronological
// backtracking within a budget). The single generalisation: a cell's neighbours are no longer found
// by arithmetic on grid coordinates but read from the mesh's explicit adjacency (`nbCell`/`nbSlot`),
// and "which tiles fit across this seam" is indexed by the *pair* of local edge-slots that meet
// there rather than by a global direction. Everything else — and every guarantee — is unchanged.

import { hashSeed, makeRng, type Rng } from '../wfc/prng';
import type { Mesh } from './mesh';
import type { CompiledMeshTileset } from './meshtypes';

export type MeshSolverStatus = 'running' | 'done' | 'failed';

export type MeshSolverOptions = {
  seed: string;
  backtracking: boolean;
  backtrackBudget: number;
};

type Snapshot = { wave: Uint8Array; cell: number; tile: number };

const SUPPORTED = 1 << 20; // sentinel "always supported" for boundary (off-mesh) neighbours

export class MeshSolver {
  readonly mesh: Mesh;
  readonly set: CompiledMeshTileset;
  readonly cells: number;
  readonly n: number;
  readonly opts: MeshSolverOptions;

  private rng: Rng;
  private wave: Uint8Array; // cells * n  (1 = still possible)
  private numPossible: Int32Array;
  private sumW: Float64Array;
  private sumWLogW: Float64Array;
  private compat: Int32Array; // cells * n * 4 support counters (one per edge-slot)
  private sumR: Float64Array;
  private sumG: Float64Array;
  private sumB: Float64Array;

  private stack: number[] = []; // interleaved (cell, tile)
  private snapshots: Snapshot[] = [];

  status: MeshSolverStatus = 'running';
  collapsedCount = 0;
  contradictions = 0;
  backtracks = 0;
  steps = 0;
  generation = 0;

  constructor(mesh: Mesh, set: CompiledMeshTileset, opts: MeshSolverOptions) {
    this.mesh = mesh;
    this.set = set;
    this.cells = mesh.cells.length;
    this.n = set.variants.length;
    this.opts = opts;
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

  // ---- the seam-fit lookup -------------------------------------------------
  // The list of neighbour tiles that may sit across cell `cell`'s edge-slot `s`, given that this
  // cell holds tile `t`. Indexed by (s, neighbour-slot) and the seam orientation.
  private acrossList(cell: number, s: number, t: number): number[] {
    const e = cell * 4 + s;
    const ns = this.mesh.nbSlot[e];
    const table = this.mesh.nbSameDir[e] ? this.set.allowedSame : this.set.allowedOpp;
    return table[s * 4 + ns][t];
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
      totR += set.variants[t].tint[0];
      totG += set.variants[t].tint[1];
      totB += set.variants[t].tint[2];
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
    this.rng = makeRng(hashSeed(this.opts.seed));
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
    const { n, mesh } = this;
    for (let cell = 0; cell < this.cells; cell++) {
      for (let t = 0; t < n; t++) {
        const base = (cell * n + t) * 4;
        const possible = this.wave[cell * n + t] === 1;
        for (let s = 0; s < 4; s++) {
          if (!possible) {
            this.compat[base + s] = 0;
            continue;
          }
          const nb = mesh.nbCell[cell * 4 + s];
          if (nb < 0) {
            this.compat[base + s] = SUPPORTED;
            continue;
          }
          let count = 0;
          const list = this.acrossList(cell, s, t);
          for (let i = 0; i < list.length; i++) if (this.wave[nb * n + list[i]] === 1) count++;
          this.compat[base + s] = count;
        }
      }
    }
  }

  /** Ban tiles whose support is already zero across some real seam (the arc-consistency purge). */
  private purgeUnsupported(): void {
    const { n } = this;
    for (let cell = 0; cell < this.cells; cell++) {
      for (let t = 0; t < n; t++) {
        if (this.wave[cell * n + t] === 0) continue;
        const base = (cell * n + t) * 4;
        let dead = false;
        for (let s = 0; s < 4; s++) {
          if (this.compat[base + s] === 0) {
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
    const base = idx * 4;
    for (let s = 0; s < 4; s++) this.compat[base + s] = 0;
    this.numPossible[cell]--;
    this.sumW[cell] -= this.set.weights[tile];
    this.sumWLogW[cell] -= this.set.weightLogWeights[tile];
    const tint = this.set.variants[tile].tint;
    this.sumR[cell] -= tint[0];
    this.sumG[cell] -= tint[1];
    this.sumB[cell] -= tint[2];
    this.stack.push(cell, tile);
  }

  private propagate(): boolean {
    const { n, mesh } = this;
    while (this.stack.length) {
      const tile = this.stack.pop()!;
      const cell = this.stack.pop()!;
      for (let s = 0; s < 4; s++) {
        const nb = mesh.nbCell[cell * 4 + s];
        if (nb < 0) continue;
        const ns = mesh.nbSlot[cell * 4 + s];
        const list = this.acrossList(cell, s, tile);
        for (let i = 0; i < list.length; i++) {
          const t2 = list[i];
          const cbase = (nb * n + t2) * 4 + ns;
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
          r += set.variants[t].tint[0];
          g += set.variants[t].tint[1];
          b += set.variants[t].tint[2];
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
    if (this.opts.backtracking && this.backtracks < this.opts.backtrackBudget && this.backtrack()) return;
    this.status = 'failed';
  }

  /** One observation + full propagation. */
  step(): MeshSolverStatus {
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
