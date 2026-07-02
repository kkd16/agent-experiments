// Permalink support for the mesh studio. The hash carries the mode marker `m=m` (decoded in
// ../wfc3d/permalink3.ts, which owns the shared `Mode`) plus the compact mesh config (set / cols /
// rows / seed / jitter / relax / merge / backtracking / speed / view toggles). Hash routing only,
// per the deployment contract; the 2D/3D/∞/hex schemes are untouched.

import type { ControllerMeshConfig } from './controller_mesh';
import { MESH_TILESETS } from './tilesets/index';

const KEYS = new Set(MESH_TILESETS.map((t) => t.key));
const bool = (b: boolean) => (b ? '1' : '0');

export function encodeHashMesh(c: ControllerMeshConfig): string {
  const p = new URLSearchParams();
  p.set('m', 'm');
  p.set('k', c.tilesetKey);
  p.set('c', String(c.cols));
  p.set('r', String(c.rows));
  p.set('s', c.seed);
  p.set('j', String(c.jitter));
  p.set('rx', String(c.relax));
  p.set('mg', bool(c.merge));
  p.set('b', bool(c.backtracking));
  p.set('v', String(c.speed));
  p.set('gh', bool(c.showGhost));
  p.set('en', bool(c.showEntropy));
  p.set('gr', bool(c.showGrid));
  return '#' + p.toString();
}

export function decodeHashMesh(hash: string): Partial<ControllerMeshConfig> {
  const out: Partial<ControllerMeshConfig> = {};
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const k = p.get('k');
  if (k && KEYS.has(k)) out.tilesetKey = k;
  const range = (key: string, lo: number, hi: number): number | undefined => {
    const raw = p.get(key);
    if (raw === null || raw === '') return undefined; // absent ⇒ keep the default (Number('')/null is 0)
    const n = Number(raw);
    return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : undefined;
  };
  const c = range('c', 2, 24);
  if (c !== undefined) out.cols = c;
  const r = range('r', 2, 24);
  if (r !== undefined) out.rows = r;
  const s = p.get('s');
  if (s) out.seed = s.slice(0, 64);
  const j = range('j', 0, 100);
  if (j !== undefined) out.jitter = j;
  const rx = range('rx', 0, 12);
  if (rx !== undefined) out.relax = rx;
  const v = Number(p.get('v'));
  if (Number.isFinite(v) && v >= 1 && v <= 512) out.speed = Math.round(v);
  const flag = (key: string): boolean | undefined => {
    const val = p.get(key);
    return val === '1' ? true : val === '0' ? false : undefined;
  };
  const mg = flag('mg');
  if (mg !== undefined) out.merge = mg;
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
