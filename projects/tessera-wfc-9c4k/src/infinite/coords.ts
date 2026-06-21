// Coordinate + seed algebra for the infinite engine ("Boundless").
//
// The infinite plane is carved into a CW-complex of four disjoint cell categories, anchored on a
// regular lattice of "junctions" spaced `G` cells apart (G = the chunk size). For a global cell
// (gx, gy), let (jx, jy) = (⌊gx/G⌋, ⌊gy/G⌋) be its chunk index and (rx, ry) the offset inside it:
//
//   rx == 0 && ry == 0  →  a JUNCTION          (the lattice corner cell)
//   rx == 0 && ry != 0  →  a VERTICAL  SEAM cell (on a vertical G-line, between two junctions)
//   ry == 0 && rx != 0  →  a HORIZONTAL SEAM cell (on a horizontal G-line)
//   else                →  a CHUNK INTERIOR cell (strictly inside one chunk)
//
// Every cell belongs to exactly one category, so the plane is partitioned with no overlaps. Shared
// border cells (junctions + seam cells) are generated once and reused by both abutting chunks,
// which is what makes the global tiling seam-consistent by construction (see world.ts).
//
// Determinism is total: every generated unit is seeded purely from the master seed plus its integer
// coordinates, so a cell's tile is a pure function of (masterSeed, gx, gy) — independent of the
// order in which the viewport happens to visit the world. These helpers are deliberately free of
// any solver/canvas dependency so they can be unit-tested in isolation.

/** Floor-division that is correct for negative numerators (JS `/ | 0` truncates toward zero). */
export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Non-negative remainder for any sign of `a` (so `mod(-1, 12) === 11`). */
export function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

export type CellKind = 'junction' | 'vseam' | 'hseam' | 'interior';

export type CellAddr = {
  kind: CellKind;
  /** Chunk / junction index this cell is anchored to. */
  jx: number;
  jy: number;
  /** Offset inside the chunk, in [0, G). */
  rx: number;
  ry: number;
};

/** Classify a global cell into its category + anchor, for a chunk size of `g`. */
export function classify(gx: number, gy: number, g: number): CellAddr {
  const jx = floorDiv(gx, g);
  const jy = floorDiv(gy, g);
  const rx = gx - jx * g;
  const ry = gy - jy * g;
  let kind: CellKind;
  if (rx === 0 && ry === 0) kind = 'junction';
  else if (rx === 0) kind = 'vseam';
  else if (ry === 0) kind = 'hseam';
  else kind = 'interior';
  return { kind, jx, jy, rx, ry };
}

/**
 * Deterministic sub-seed: weave the master seed together with a tag and integer coordinates into a
 * stable string seed the PRNG/solver can consume. Distinct tags keep junctions, seams, and chunks
 * from sharing a stream even at the same coordinates.
 */
export function subSeed(master: string, tag: string, ...coords: number[]): string {
  return `${master}|${tag}|${coords.join(',')}`;
}
