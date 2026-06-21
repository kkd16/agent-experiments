// Permalink support for the 3D studio. The hash carries a mode marker (`m=3`) so the app knows to
// boot into the 3D engine, plus the compact 3D config (set / grid X·Y·Z / seed / wrap /
// backtracking / speed / edges). Hash routing only, per the deployment contract. The 2D scheme
// (../wfc/permalink.ts) is untouched and still owns `m=t`/`m=o`.

import type { Controller3Config } from './controller3';
import { TILESETS3 } from './tilesets3/index';

const KEYS = new Set(TILESETS3.map((t) => t.key));
const bool = (b: boolean) => (b ? '1' : '0');

export type Mode = '2d' | '3d' | 'inf';

/** Which engine a hash selects. Defaults to 2D for every legacy/empty hash. */
export function hashMode(hash: string): Mode {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const m = p.get('m');
  if (m === '3') return '3d';
  if (m === 'i') return 'inf';
  return '2d';
}

export function encodeHash3(c: Controller3Config): string {
  const p = new URLSearchParams();
  p.set('m', '3');
  p.set('k', c.tilesetKey);
  p.set('x', String(c.sizeX));
  p.set('y', String(c.sizeY));
  p.set('z', String(c.sizeZ));
  p.set('s', c.seed);
  p.set('w', bool(c.wrap));
  p.set('b', bool(c.backtracking));
  p.set('v', String(c.speed));
  p.set('e', bool(c.edges));
  return '#' + p.toString();
}

export function decodeHash3(hash: string): Partial<Controller3Config> {
  const out: Partial<Controller3Config> = {};
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const k = p.get('k');
  if (k && KEYS.has(k)) out.tilesetKey = k;
  const dim = (key: string): number | undefined => {
    const n = Number(p.get(key));
    return Number.isFinite(n) && n >= 2 && n <= 16 ? Math.round(n) : undefined;
  };
  const x = dim('x');
  if (x !== undefined) out.sizeX = x;
  const y = dim('y');
  if (y !== undefined) out.sizeY = y;
  const z = dim('z');
  if (z !== undefined) out.sizeZ = z;
  const s = p.get('s');
  if (s) out.seed = s.slice(0, 64);
  const v = Number(p.get('v'));
  if (Number.isFinite(v) && v >= 1 && v <= 512) out.speed = Math.round(v);
  const flag = (key: string): boolean | undefined => {
    const val = p.get(key);
    return val === '1' ? true : val === '0' ? false : undefined;
  };
  const w = flag('w');
  if (w !== undefined) out.wrap = w;
  const b = flag('b');
  if (b !== undefined) out.backtracking = b;
  const e = flag('e');
  if (e !== undefined) out.edges = e;
  return out;
}
