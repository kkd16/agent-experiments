import type { Dir, Edges } from './edges';

/** How a prototype generates its rotated variants. */
export type Symmetry =
  | 'X' // fully symmetric — 1 variant (e.g. blank, cross)
  | 'I' // 180°-symmetric — 2 variants (e.g. straight line)
  | 'T' // one axis of symmetry — 4 variants (e.g. tee, coast)
  | 'L' // corner — 4 variants (e.g. elbow)
  | 'F'; // no symmetry — 4 variants, all distinct

/** How many distinct rotations a symmetry class needs. */
export const ROTATIONS: Record<Symmetry, number> = { X: 1, I: 2, T: 4, L: 4, F: 4 };

/** A hand-authored tile, before rotation expansion. */
export type Prototype = {
  name: string;
  edges: Edges;
  symmetry: Symmetry;
  /** Relative frequency hint; higher = appears more often. Defaults to 1. */
  weight?: number;
  /** Draw the base (0°) orientation into a `size`×`size` context at the origin. */
  draw: (ctx: CanvasRenderingContext2D, size: number) => void;
};

/** A concrete, rotated, rendered tile the solver actually places. */
export type Variant = {
  id: number;
  proto: string;
  rotation: number; // 0..3 (×90° clockwise)
  edges: Edges;
  weight: number;
  bitmap: HTMLCanvasElement;
  /** Average colour of the rendered bitmap, for ghosting superpositions. */
  avg: [number, number, number];
  /**
   * Optional richer preview for the gallery. The grid renderer always draws `bitmap`
   * (a solid cell colour, which is the correct output for the overlapping model — each
   * cell shows the colour of its pattern's origin pixel), but the gallery prefers this
   * when present so it can show the *whole* learnt N×N pattern.
   */
  patternBitmap?: HTMLCanvasElement;
};

export type Tileset = {
  key: string;
  name: string;
  blurb: string;
  background: string;
  prototypes: Prototype[];
  /**
   * The "disconnected" edge socket, if this tileset has a notion of carrying a connection
   * (rails, wires, pipes, corridors). Any edge code other than this one is an *open* edge that
   * links to its neighbour. Tilesets that declare it unlock the global connectivity constraint;
   * those that don't (e.g. terrain, truchet) simply leave that feature disabled. The code must
   * be reverse-symmetric (`open(c) ⇔ open(reverse(c))`) so a collapsed open edge always faces an
   * open edge — the in-app suite asserts this.
   */
  emptyEdge?: string;
};

/** A fully compiled tileset: variants + the adjacency tensor the solver consumes. */
export type CompiledTileset = {
  key: string;
  name: string;
  background: string;
  variants: Variant[];
  /** allowed[d] = for each tile, the list of tile ids permitted as its neighbour in dir d. */
  allowed: Record<Dir, number[][]>;
  weights: number[];
  weightLogWeights: number[];
  /**
   * Per-variant 4-bit open-socket mask (bit `d` set ⇔ edge `d` carries a connection), present
   * only when the source tileset declared an `emptyEdge`. Drives the global connectivity
   * constraint; `undefined` means the set has no connection semantics.
   */
  openMask?: Uint8Array;
};
