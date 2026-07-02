import type { MeshTileset } from '../meshtypes';
import { paths } from './paths';
import { rivers } from './rivers';
import { circuit } from './circuit';

export const MESH_TILESETS: MeshTileset[] = [paths, rivers, circuit];

const BY_KEY = new Map(MESH_TILESETS.map((t) => [t.key, t]));

export function meshTilesetByKey(key: string): MeshTileset {
  return BY_KEY.get(key) ?? paths;
}
