import type { HexTileset } from '../types_hex';
import { terrain } from './terrain';
import { paths } from './paths';
import { weave } from './weave';
import { pipes } from './pipes';

export const HEX_TILESETS: HexTileset[] = [terrain, paths, weave, pipes];

const BY_KEY = new Map(HEX_TILESETS.map((t) => [t.key, t]));

export function hexTilesetByKey(key: string): HexTileset {
  return BY_KEY.get(key) ?? terrain;
}
