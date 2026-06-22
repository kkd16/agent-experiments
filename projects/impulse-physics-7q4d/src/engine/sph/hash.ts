/**
 * A uniform spatial hash for neighbour finding. The fluid solve asks, for every
 * particle, "which other particles lie within the kernel radius `h`?" — answering
 * that by brute force is O(n²). With a grid whose cell size equals `h`, every
 * neighbour of a particle is in that particle's own cell or one of the eight
 * around it, so the query visits only a 3×3 block and the whole pass is O(n).
 *
 * Cells are stored in a `Map` keyed by a hash of the integer cell coordinates,
 * so the grid is unbounded (no fixed domain, no wasted memory for empty space)
 * and works at any world position — the same scheme the soft-body inter-collision
 * pass uses. Rebuilt once per substep from the current positions.
 */
import { Vec2 } from '../math';

export class SpatialHash {
  /** Cell size in world units (set to the kernel radius `h`). */
  readonly cellSize: number;
  private readonly inv: number;
  private points: Vec2[] = [];
  private readonly grid = new Map<number, number[]>();

  constructor(cellSize: number) {
    this.cellSize = cellSize;
    this.inv = 1 / cellSize;
  }

  private cell(x: number, y: number): number {
    // A pair-mix of the two cell coordinates. The large primes spread adjacent
    // cells across the table; `| 0` keeps it a 32-bit int for fast Map keys.
    return (Math.floor(x * this.inv) * 73856093) ^ (Math.floor(y * this.inv) * 19349663);
  }

  /** (Re)index `points`; clears any previous contents. */
  build(points: Vec2[]): void {
    this.points = points;
    this.grid.clear();
    for (let i = 0; i < points.length; i++) {
      const k = this.cell(points[i].x, points[i].y);
      const bucket = this.grid.get(k);
      if (bucket) bucket.push(i);
      else this.grid.set(k, [i]);
    }
  }

  /**
   * Visit every indexed point whose cell lies in the 3×3 block around world point
   * `p` (i.e. every candidate within `cellSize`). The callback gets the candidate
   * index; the caller filters by the true distance. `skip` is excluded (use it to
   * skip the query particle itself).
   */
  query(p: Vec2, cb: (index: number) => void, skip = -1): void {
    const cx = Math.floor(p.x * this.inv);
    const cy = Math.floor(p.y * this.inv);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = this.grid.get(
          ((cx + dx) * 73856093) ^ ((cy + dy) * 19349663),
        );
        if (!bucket) continue;
        for (const j of bucket) if (j !== skip) cb(j);
      }
    }
  }

  /** Convenience: candidate neighbours of indexed point `i` (excludes `i`). */
  forEachNeighbor(i: number, cb: (index: number) => void): void {
    this.query(this.points[i], cb, i);
  }
}
