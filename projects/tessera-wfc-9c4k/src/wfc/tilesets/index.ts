import type { Tileset } from '../types';
import { knots } from './knots';
import { terrain } from './terrain';
import { circuit } from './circuit';
import { cables } from './cables';
import { truchet } from './truchet';
import { rails } from './rails';
import { maze } from './maze';

export const TILESETS: Tileset[] = [knots, terrain, circuit, cables, truchet, rails, maze];

export function tilesetByKey(key: string): Tileset {
  return TILESETS.find((t) => t.key === key) ?? TILESETS[0];
}
