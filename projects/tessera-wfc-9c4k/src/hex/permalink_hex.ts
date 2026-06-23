// Permalink support for the hex studio. The hash carries the mode marker `m=h` (decoded in
// ../wfc3d/permalink3.ts, which owns the shared `Mode`) plus the compact hex config (set / cols /
// rows / seed / wrap / backtracking / speed / view toggles). Hash routing only, per the deployment
// contract; the 2D/3D/∞ schemes are untouched.

import type { ControllerHexConfig } from './controller_hex';
import { HEX_TILESETS } from './tilesets/index';

const KEYS = new Set(HEX_TILESETS.map((t) => t.key));
const bool = (b: boolean) => (b ? '1' : '0');

export function encodeHashHex(c: ControllerHexConfig): string {
  const p = new URLSearchParams();
  p.set('m', 'h');
  p.set('k', c.tilesetKey);
  p.set('c', String(c.cols));
  p.set('r', String(c.rows));
  p.set('s', c.seed);
  p.set('w', bool(c.wrap));
  p.set('b', bool(c.backtracking));
  p.set('v', String(c.speed));
  p.set('gh', bool(c.showGhost));
  p.set('en', bool(c.showEntropy));
  p.set('gr', bool(c.showGrid));
  return '#' + p.toString();
}

export function decodeHashHex(hash: string): Partial<ControllerHexConfig> {
  const out: Partial<ControllerHexConfig> = {};
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const k = p.get('k');
  if (k && KEYS.has(k)) out.tilesetKey = k;
  const dim = (key: string): number | undefined => {
    const n = Number(p.get(key));
    return Number.isFinite(n) && n >= 3 && n <= 40 ? Math.round(n) : undefined;
  };
  const c = dim('c');
  if (c !== undefined) out.cols = c;
  const r = dim('r');
  if (r !== undefined) out.rows = r;
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
  const gh = flag('gh');
  if (gh !== undefined) out.showGhost = gh;
  const en = flag('en');
  if (en !== undefined) out.showEntropy = en;
  const gr = flag('gr');
  if (gr !== undefined) out.showGrid = gr;
  return out;
}
