import type { Tileset3 } from '../types3';
import { terraces } from './terraces';
import { pipes3d } from './pipes';
import { castle } from './castle';

export const TILESETS3: Tileset3[] = [terraces, castle, pipes3d];

export function tileset3ByKey(key: string): Tileset3 {
  return TILESETS3.find((t) => t.key === key) ?? terraces;
}
