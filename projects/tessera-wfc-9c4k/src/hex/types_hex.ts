import type { Dir6, HexEdges } from './hexgrid';

export type { HexEdges } from './hexgrid';

/** A hand-authored hex tile, before rotation expansion. */
export type HexPrototype = {
  name: string;
  edges: HexEdges;
  /**
   * How many distinct 60° clockwise rotations to generate (1..6). Visually-identical rotations are
   * deduped by the compiler regardless, so over-stating this is safe — it just costs a render.
   */
  rotations: number;
  /** Relative frequency hint; higher = appears more often. Defaults to 1. */
  weight?: number;
  /**
   * Draw the base (0°) orientation into a hex of circumradius `s` centred at the origin. The
   * compiler clips to the hexagon, so a draw may paint past the boundary freely.
   */
  draw: (ctx: CanvasRenderingContext2D, s: number) => void;
};

/** A concrete, rotated, rendered tile the hex solver actually places. */
export type HexVariant = {
  id: number;
  proto: string;
  rotation: number; // 0..5 (×60° clockwise)
  edges: HexEdges;
  weight: number;
  /** A transparent-cornered hex bitmap, blitted (scaled) into each collapsed cell. */
  bitmap: HTMLCanvasElement;
  /** Average colour of the hex interior, for ghosting superpositions. */
  avg: [number, number, number];
};

export type HexTileset = {
  key: string;
  name: string;
  blurb: string;
  background: string;
  prototypes: HexPrototype[];
};

/** A fully compiled hex tileset: variants + the 6-direction adjacency tensor the solver consumes. */
export type CompiledHexTileset = {
  key: string;
  name: string;
  background: string;
  variants: HexVariant[];
  /** allowed[d] = for each tile, the list of tile ids permitted as its neighbour in dir d. */
  allowed: Record<Dir6, number[][]>;
  weights: number[];
  weightLogWeights: number[];
};
