// Permalink support for the "Boundless" infinite studio. The hash carries the mode marker (`m=i`)
// plus the compact config: tileset, master seed, chunk size, zoom, and the camera centre (rounded
// to whole cells — sub-cell precision isn't worth the URL length). Hash routing only, per the
// deployment contract. Legacy `m=t`/`m=o` (2D) and `m=3` (3D) hashes are untouched and still own
// their engines; anything without `m=i` simply never decodes here.

import type { ControllerInfConfig } from './controller_inf';
import { isInfiniteKey } from './sets';

const bool = (b: boolean) => (b ? '1' : '0');

export function encodeHashInf(c: ControllerInfConfig): string {
  const p = new URLSearchParams();
  p.set('m', 'i');
  p.set('k', c.tilesetKey);
  p.set('s', c.seed);
  p.set('g', String(c.chunkSize));
  p.set('z', String(Math.round(c.cellPx)));
  p.set('cx', String(Math.round(c.centerX)));
  p.set('cy', String(Math.round(c.centerY)));
  p.set('gr', bool(c.showGrid));
  p.set('jn', bool(c.showJunctions));
  return '#' + p.toString();
}

export function decodeHashInf(hash: string): Partial<ControllerInfConfig> {
  const out: Partial<ControllerInfConfig> = {};
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const k = p.get('k');
  if (k && isInfiniteKey(k)) out.tilesetKey = k;
  const s = p.get('s');
  if (s) out.seed = s.slice(0, 64);
  const g = Number(p.get('g'));
  if (Number.isFinite(g) && g >= 6 && g <= 24) out.chunkSize = Math.round(g);
  const z = Number(p.get('z'));
  if (Number.isFinite(z) && z >= 4 && z <= 80) out.cellPx = Math.round(z);
  const cx = Number(p.get('cx'));
  if (Number.isFinite(cx)) out.centerX = Math.round(cx);
  const cy = Number(p.get('cy'));
  if (Number.isFinite(cy)) out.centerY = Math.round(cy);
  const flag = (key: string): boolean | undefined => {
    const v = p.get(key);
    return v === '1' ? true : v === '0' ? false : undefined;
  };
  const gr = flag('gr');
  if (gr !== undefined) out.showGrid = gr;
  const jn = flag('jn');
  if (jn !== undefined) out.showJunctions = jn;
  return out;
}
