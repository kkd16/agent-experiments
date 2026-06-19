import type { Dir3 } from './dirs3';
import type { Faces } from './sockets3';
import type { VoxModel } from './voxel';

/** A hand-authored 3D tile, before rotation expansion. */
export type Prototype3 = {
  name: string;
  model: VoxModel;
  sockets: Faces;
  /** How many distinct 90° Y-rotations to generate (1, 2, or 4). Duplicates are deduped anyway. */
  rotations: 1 | 2 | 4;
  /** Relative frequency hint; higher = appears more often. Defaults to 1. */
  weight?: number;
};

/** A concrete, rotated tile the 3D solver actually places. */
export type Variant3 = {
  id: number;
  proto: string;
  rotation: number; // 0..3 (×90° CW about +Y)
  model: VoxModel;
  sockets: Faces;
  weight: number;
  avg: [number, number, number];
};

export type Tileset3 = {
  key: string;
  name: string;
  blurb: string;
  /** CSS background behind the scene. */
  background: string;
  /** Voxel resolution every prototype is authored at. */
  res: number;
  prototypes: Prototype3[];
};

/** A fully compiled 3D tileset: variants + the 6-direction adjacency tensor the solver consumes. */
export type CompiledTileset3 = {
  key: string;
  name: string;
  background: string;
  res: number;
  variants: Variant3[];
  /** allowed[d] = for each tile, the list of tile ids permitted as its neighbour in dir d. */
  allowed: Record<Dir3, number[][]>;
  weights: number[];
  weightLogWeights: number[];
};
