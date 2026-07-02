// Tile algebra for the irregular-mesh engine. The whole point of forcing an **all-quad** mesh is
// that a tile stays exactly what it is on the square lattice: four edge sockets read in a cyclic
// (counter-clockwise) order, with a 4-fold rotation group that cyclically shifts them. So this file
// is deliberately the square engine's `types.ts`/`edges.ts` distilled to what a socket needs —
// nothing about the *irregular* grid leaks in here, because adjacency lives in the mesh, not the
// tile. Where the tile meets the grid is a single rule: two cells sharing a physical edge fit iff
// one's socket equals the *reverse* of the other's (the seam is traced in opposite senses), which
// degenerates to plain equality for the single-character sockets these tilesets use.

import type { Vec2 } from './mesh';

/** Rotation symmetry classes, mirroring the square engine. */
export type Sym = 'X' | 'I' | 'T' | 'L' | 'F';

/** Distinct clockwise quarter-turn variants each symmetry needs. */
export const ROT: Record<Sym, number> = { X: 1, I: 2, T: 4, L: 4, F: 4 };

/** An RGB colour as a tuple, so ghost/averaging maths needs no parsing. */
export type RGB = [number, number, number];

export const rgb = (c: RGB): string => `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})`;
export const rgba = (c: RGB, a: number): string => `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`;
export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** The geometry a painter receives — the *actual* polygon of the cell being drawn (already scaled
 *  into device pixels by the renderer), so a tile can bend its roads to fit any quad shape. */
export type CellGeom = {
  poly: Vec2[]; // 4 corners, CCW, device px
  mids: Vec2[]; // 4 edge midpoints; mids[s] lies on the edge from poly[s] to poly[s+1]
  centroid: Vec2;
  inradius: number;
};

/** A shared palette handed to every painter, so a tileset themes consistently. */
export type Palette = {
  bg: RGB;
  bgAlt: RGB;
  ink: RGB; // dark casing / outline
  a: RGB; // primary connection colour
  b: RGB; // secondary connection colour
  accent: RGB;
};

/** A hand-authored tile prototype, before rotation expansion. */
export type MeshProto = {
  name: string;
  /** Four CCW edge sockets. `'.'` (or the tileset's `emptyEdge`) is a blank; anything else connects. */
  sockets: [string, string, string, string];
  symmetry: Sym;
  weight?: number;
  /** A representative RGB tint for ghosting superpositions (blend of bg and connection colour). */
  tint: RGB;
  /** Paint into the real polygon. `sockets` is this variant's already-rotated socket array. */
  paint: (ctx: CanvasRenderingContext2D, g: CellGeom, sockets: string[], pal: Palette) => void;
};

export type MeshTileset = {
  key: string;
  name: string;
  blurb: string;
  /** CSS background behind the whole board. */
  background: string;
  palette: Palette;
  /** The blank socket; any other socket is an *open* connection (drives the connectivity readout). */
  emptyEdge: string;
  prototypes: MeshProto[];
};

/** A concrete rotated tile the solver places. */
export type MeshVariant = {
  id: number;
  proto: string;
  rotation: number;
  sockets: [string, string, string, string];
  weight: number;
  tint: RGB;
  /** Draw this variant into a real polygon. */
  render: (ctx: CanvasRenderingContext2D, g: CellGeom, pal: Palette) => void;
};

export type CompiledMeshTileset = {
  key: string;
  name: string;
  background: string;
  palette: Palette;
  variants: MeshVariant[];
  emptyEdge: string;
  /**
   * The adjacency tensor, generalised off the lattice. Because "direction" is no longer global, it
   * is indexed by the *pair* of local edge-slots that meet at a seam:
   *   `allowedOpp[sA*4 + sB][tA]` = tiles `tB` that may sit across cell-A-slot `sA` ↔ cell-B-slot
   *   `sB` when the two cells read the seam in opposite senses (the normal case). `allowedSame`
   *   covers the (mesh-guaranteed-absent, but handled) orientation clash.
   */
  allowedOpp: number[][][];
  allowedSame: number[][][];
  weights: number[];
  weightLogWeights: number[];
  /** Per-variant 4-bit mask: bit `s` set ⇔ edge-slot `s` carries an open connection. */
  openMask: Uint8Array;
};

/** Reverse a socket code (a no-op for the single-character, palindromic codes used here). */
export function reverseSocket(code: string): string {
  return code.length < 2 ? code : code.split('').reverse().join('');
}

/** Rotate a socket ring `k` quarter-turns clockwise: the feature on slot `d` moves to slot `d+k`. */
export function rotateSockets(s: readonly string[], k: number): [string, string, string, string] {
  const m = ((k % 4) + 4) % 4;
  return [s[(0 - m + 4) % 4], s[(1 - m + 4) % 4], s[(2 - m + 4) % 4], s[(3 - m + 4) % 4]];
}
