import type { Tileset } from '../types';
import { knots } from './knots';
import { terrain } from './terrain';
import { circuit } from './circuit';
import { cables } from './cables';

export const TILESETS: Tileset[] = [knots, terrain, circuit, cables];

export function tilesetByKey(key: string): Tileset {
  return TILESETS.find((t) => t.key === key) ?? TILESETS[0];
}
