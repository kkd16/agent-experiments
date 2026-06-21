// "Boundless" — a deterministic, infinite Wave Function Collapse world.
//
// Where the 2D/3D studios solve one finite grid, this generates an *endless* plane you scroll
// through, materialising tiles lazily as the viewport reaches them. The whole world is a pure
// function of (masterSeed, chunkSize): `tileAt(gx, gy)` returns the same tile for the same
// coordinates forever, no matter what order cells are requested — so panning never changes the
// past, and two independent observers always agree.
//
// The trick is the CW-complex decomposition in coords.ts. We materialise, on demand and memoised:
//
//   • JUNCTIONS — the cell at each lattice corner (gx,gy ≡ 0 mod G). A single deterministic tile.
//     We use the set's "ground" tile (one that is adjacency-compatible with itself in all four
//     directions) so the seam/chunk solves below are always satisfiable.
//   • SEAMS — the 1-D run of cells along each vertical / horizontal G-line *between* two junctions.
//     Solved by the real WFC solver as a 1×k (or k×1) strip pinned to its two junction endpoints,
//     so the seam is itself a valid 1-D adjacency chain. A seam is shared by the two chunks it
//     divides, so both see identical border tiles.
//   • CHUNKS — the (G-1)² strictly-interior cells. Solved as a (G+1)² grid whose entire border ring
//     is pinned to the surrounding junctions + seams, then we keep the interior. Because the border
//     is shared with the neighbours, and the solver only accepts a fully-collapsed, pin-honouring
//     result, every cross-chunk adjacency is valid by construction.
//
// All three reuse the existing, untouched `Solver`/`compile`. The infinite engine is strictly
// additive — it never touches the 2D or 3D code paths.

import { DIRS, opposite, type Dir } from '../wfc/edges';
import { Solver } from '../wfc/solver';
import type { CompiledTileset } from '../wfc/types';
import { classify, subSeed } from './coords';

export type WorldOptions = {
  /** Compiled tileset to grow the world from. */
  set: CompiledTileset;
  /** Master seed — the whole infinite world is reproducible from this string. */
  seed: string;
  /** Chunk size G (≥ 4). Junctions sit every G cells; chunk interiors are (G-1)². */
  chunkSize: number;
  /** Max distinct re-seed attempts per seam/chunk before falling back to ground. */
  attempts?: number;
  /** Soft cap on cached chunks (LRU eviction). Seams/junctions are tiny and never evicted. */
  chunkCacheCap?: number;
};

/**
 * Find a "ground" variant: one that is adjacency-compatible with itself in all four directions
 * (so an all-ground line/region is always a legal tiling). Returns the highest-weight such variant
 * (ties → lowest id) for determinism, or -1 if the set has none.
 */
export function findGround(set: CompiledTileset): number {
  let best = -1;
  let bestW = -Infinity;
  for (let t = 0; t < set.variants.length; t++) {
    let ok = true;
    for (const d of DIRS) {
      if (!set.allowed[d as Dir][t].includes(t)) {
        ok = false;
        break;
      }
    }
    if (ok && set.weights[t] > bestW) {
      best = t;
      bestW = set.weights[t];
    }
  }
  return best;
}

/** Step a solver to a terminal state (done/failed). Bounded so it can never spin forever. */
function solveToEnd(solver: Solver): void {
  const guard = (solver.cells + solver.opts.backtrackBudget) * 4 + 64;
  let i = 0;
  while (solver.status === 'running' && i++ < guard) solver.step();
}

export class InfiniteWorld {
  readonly set: CompiledTileset;
  readonly master: string;
  readonly g: number; // chunk size
  readonly ground: number; // ground tile id, or -1
  private readonly attempts: number;
  private readonly cap: number;

  private junctions = new Map<string, number>();
  private vseams = new Map<string, Int32Array>();
  private hseams = new Map<string, Int32Array>();
  private chunks = new Map<string, Int32Array>();
  private chunkOrder: string[] = []; // LRU queue for chunk eviction

  // Diagnostics surfaced to the studio / proof lab.
  fallbacks = 0; // seam/chunk units that exhausted all attempts and fell back to ground
  seamSolves = 0;
  chunkSolves = 0;

  constructor(o: WorldOptions) {
    this.set = o.set;
    this.master = o.seed;
    this.g = Math.max(4, Math.round(o.chunkSize));
    this.attempts = o.attempts ?? 6;
    this.cap = o.chunkCacheCap ?? 2048;
    this.ground = findGround(o.set);
  }

  /** Whether this set has the structural prerequisite for an infinite world (a ground tile). */
  static hasGround(set: CompiledTileset): boolean {
    return findGround(set) >= 0;
  }

  /** Is chunk (cx,cy) already materialised? (For the minimap — no generation triggered.) */
  isChunkCached(cx: number, cy: number): boolean {
    return this.chunks.has(`${cx},${cy}`);
  }

  /** Counts of materialised units, for the studio telemetry. */
  get materialized(): { chunks: number; vseams: number; hseams: number; junctions: number } {
    return {
      chunks: this.chunks.size,
      vseams: this.vseams.size,
      hseams: this.hseams.size,
      junctions: this.junctions.size,
    };
  }

  // ---- public read-out -----------------------------------------------------

  /** The collapsed tile id at any global cell — the one pure-function entry point. */
  tileAt(gx: number, gy: number): number {
    const a = classify(gx, gy, this.g);
    switch (a.kind) {
      case 'junction':
        return this.junction(a.jx, a.jy);
      case 'vseam':
        return this.vseam(a.jx, a.jy)[a.ry];
      case 'hseam':
        return this.hseam(a.jx, a.jy)[a.rx];
      default: {
        const grid = this.chunk(a.jx, a.jy);
        return grid[a.ry * (this.g + 1) + a.rx];
      }
    }
  }

  // ---- junctions -----------------------------------------------------------

  /** Public read of a junction tile (for the proof lab); generation is memoised. */
  junctionAt(jx: number, jy: number): number {
    return this.junction(jx, jy);
  }

  private junction(jx: number, jy: number): number {
    const key = `${jx},${jy}`;
    const hit = this.junctions.get(key);
    if (hit !== undefined) return hit;
    // Ground keeps every seam/chunk solve satisfiable. (Sets without a ground tile are not
    // offered in infinite mode, but we still pick a deterministic tile so the engine is robust.)
    let tile = this.ground;
    if (tile < 0) {
      tile = this.weightedPick(subSeed(this.master, 'J', jx, jy));
    }
    this.junctions.set(key, tile);
    return tile;
  }

  private weightedPick(seed: string): number {
    // A tiny inline weighted draw (avoids depending on Rng internals); deterministic from `seed`.
    let h = 0x9e3779b9 ^ seed.length;
    for (let i = 0; i < seed.length; i++) {
      h = Math.imul(h ^ seed.charCodeAt(i), 0x85ebca6b);
      h = (h ^ (h >>> 13)) >>> 0;
    }
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
    const total = this.set.weights.reduce((s, w) => s + w, 0);
    let r = (h / 4294967296) * total;
    for (let t = 0; t < this.set.weights.length; t++) {
      r -= this.set.weights[t];
      if (r < 0) return t;
    }
    return 0;
  }

  // ---- seams (1-D solves) --------------------------------------------------

  /** Vertical seam at junction-column jx between rows jy..jy+1: length G+1, ends are junctions. */
  vseam(jx: number, jy: number): Int32Array {
    const key = `${jx},${jy}`;
    const hit = this.vseams.get(key);
    if (hit) return hit;
    const top = this.junction(jx, jy);
    const bot = this.junction(jx, jy + 1);
    const arr = this.solveStrip('V', jx, jy, 1, this.g + 1, top, bot);
    this.vseams.set(key, arr);
    return arr;
  }

  /** Horizontal seam at junction-row jy between cols jx..jx+1: length G+1, ends are junctions. */
  hseam(jx: number, jy: number): Int32Array {
    const key = `${jx},${jy}`;
    const hit = this.hseams.get(key);
    if (hit) return hit;
    const left = this.junction(jx, jy);
    const right = this.junction(jx + 1, jy);
    const arr = this.solveStrip('H', jx, jy, this.g + 1, 1, left, right);
    this.hseams.set(key, arr);
    return arr;
  }

  private solveStrip(
    tag: string,
    jx: number,
    jy: number,
    width: number,
    height: number,
    e0: number,
    e1: number,
  ): Int32Array {
    const len = Math.max(width, height); // = G+1
    // Pin the two endpoints (cell index is just the 1-D position for a 1×k or k×1 grid).
    const pins: ReadonlyArray<readonly [number, number]> = [
      [0, e0],
      [len - 1, e1],
    ];
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const solver = new Solver(this.set, {
        width,
        height,
        seed: subSeed(this.master, tag, jx, jy, attempt),
        wrap: false,
        backtracking: true,
        backtrackBudget: 800,
        pins,
      });
      solveToEnd(solver);
      if (solver.status !== 'done') continue;
      const out = new Int32Array(len);
      let ok = true;
      for (let i = 0; i < len; i++) {
        const t = solver.collapsedTile(i);
        if (t < 0) {
          ok = false;
          break;
        }
        out[i] = t;
      }
      if (ok && out[0] === e0 && out[len - 1] === e1) {
        this.seamSolves++;
        return out;
      }
    }
    // Fallback: an all-ground strip (always a valid chain when ground self-tiles, which is the
    // contract for offered sets). Counted so the proof lab can assert this never fires.
    this.fallbacks++;
    const out = new Int32Array(len);
    const fill = this.ground >= 0 ? this.ground : e0;
    out.fill(fill);
    out[0] = e0;
    out[len - 1] = e1;
    return out;
  }

  // ---- chunks (2-D solves with a pinned border ring) -----------------------

  /** The full (G+1)² solved grid for chunk (cx,cy); border = shared junctions/seams. */
  chunk(cx: number, cy: number): Int32Array {
    const key = `${cx},${cy}`;
    const hit = this.chunks.get(key);
    if (hit) {
      this.touch(key);
      return hit;
    }
    const grid = this.solveChunk(cx, cy);
    this.chunks.set(key, grid);
    this.chunkOrder.push(key);
    this.evictIfNeeded();
    return grid;
  }

  private touch(key: string): void {
    const i = this.chunkOrder.indexOf(key);
    if (i >= 0) {
      this.chunkOrder.splice(i, 1);
      this.chunkOrder.push(key);
    }
  }

  private evictIfNeeded(): void {
    while (this.chunkOrder.length > this.cap) {
      const old = this.chunkOrder.shift();
      if (old) this.chunks.delete(old);
    }
  }

  private solveChunk(cx: number, cy: number): Int32Array {
    const G = this.g;
    const W = G + 1;
    const top = this.hseam(cx, cy); // gy = cy*G,     gx = cx*G + x   (x = 0..G)
    const bottom = this.hseam(cx, cy + 1); // gy = (cy+1)*G
    const left = this.vseam(cx, cy); // gx = cx*G,     gy = cy*G + y
    const right = this.vseam(cx + 1, cy); // gx = (cx+1)*G

    // Build the border-ring pin list (corners are shared by a row + column seam and agree).
    const pins: Array<[number, number]> = [];
    const at = (x: number, y: number) => y * W + x;
    for (let x = 0; x <= G; x++) {
      pins.push([at(x, 0), top[x]]);
      pins.push([at(x, G), bottom[x]]);
    }
    for (let y = 1; y < G; y++) {
      pins.push([at(0, y), left[y]]);
      pins.push([at(G, y), right[y]]);
    }

    for (let attempt = 0; attempt < this.attempts; attempt++) {
      const solver = new Solver(this.set, {
        width: W,
        height: W,
        seed: subSeed(this.master, 'C', cx, cy, attempt),
        wrap: false,
        backtracking: true,
        backtrackBudget: 4000,
        pins,
      });
      solveToEnd(solver);
      if (solver.status !== 'done') continue;
      const grid = new Int32Array(W * W);
      let ok = true;
      for (let i = 0; i < W * W && ok; i++) {
        const t = solver.collapsedTile(i);
        if (t < 0) ok = false;
        else grid[i] = t;
      }
      // Verify the border ring came out exactly as pinned (a skipped pin would desync neighbours).
      if (ok) {
        for (const [cell, tile] of pins) {
          if (grid[cell] !== tile) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        this.chunkSolves++;
        return grid;
      }
    }
    // Fallback (should never fire for offered sets): ground-fill the interior, keep the real border.
    this.fallbacks++;
    const grid = new Int32Array(W * W);
    const fill = this.ground >= 0 ? this.ground : 0;
    grid.fill(fill);
    for (let x = 0; x <= G; x++) {
      grid[at(x, 0)] = top[x];
      grid[at(x, G)] = bottom[x];
    }
    for (let y = 1; y < G; y++) {
      grid[at(0, y)] = left[y];
      grid[at(G, y)] = right[y];
    }
    return grid;
  }

  // ---- helpers for the proof lab / overlays --------------------------------

  /** Are two global cells adjacency-valid under the compiled tensor? (Both must be in `d`-relation.) */
  adjacentValid(gx: number, gy: number, d: Dir): boolean {
    const a = this.tileAt(gx, gy);
    const [dx, dy] = DIR_DELTA[d];
    const b = this.tileAt(gx + dx, gy + dy);
    return this.set.allowed[d][a].includes(b) && this.set.allowed[opposite(d)][b].includes(a);
  }
}

// Local copy of the direction deltas (DELTA in edges.ts is keyed the same; duplicated to keep this
// module's dependency surface explicit and avoid importing the record type).
const DIR_DELTA: Record<Dir, [number, number]> = {
  0: [0, -1],
  1: [1, 0],
  2: [0, 1],
  3: [-1, 0],
};
