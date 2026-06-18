import type { ControllerConfig } from './controller';

// Encode the generative state into the URL hash so a run is shareable/reproducible.
// Hash routing only (history-API routes break under the site's relative base).

const bool = (b: boolean) => (b ? '1' : '0');
const KEYS = new Set(['knots', 'terrain', 'circuit', 'cables']);

export type Permalinkable = Pick<
  ControllerConfig,
  'tilesetKey' | 'size' | 'seed' | 'wrap' | 'backtracking' | 'speed' | 'showGhost' | 'showEntropy' | 'showGrid'
>;

export function encodeHash(c: Permalinkable): string {
  const p = new URLSearchParams();
  p.set('k', c.tilesetKey);
  p.set('n', String(c.size));
  p.set('s', c.seed);
  p.set('w', bool(c.wrap));
  p.set('b', bool(c.backtracking));
  p.set('v', String(c.speed));
  p.set('g', bool(c.showGhost));
  p.set('h', bool(c.showEntropy));
  p.set('r', bool(c.showGrid));
  return '#' + p.toString();
}

/** Parse the current hash into a partial config (only well-formed fields are returned). */
export function decodeHash(hash: string): Partial<Permalinkable> {
  const out: Partial<Permalinkable> = {};
  const raw = hash.replace(/^#/, '');
  if (!raw) return out;
  const p = new URLSearchParams(raw);
  const k = p.get('k');
  if (k && KEYS.has(k)) out.tilesetKey = k;
  const n = Number(p.get('n'));
  if (Number.isFinite(n) && n >= 10 && n <= 48) out.size = Math.round(n);
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
  const g = flag('g');
  if (g !== undefined) out.showGhost = g;
  const h = flag('h');
  if (h !== undefined) out.showEntropy = h;
  const r = flag('r');
  if (r !== undefined) out.showGrid = r;
  return out;
}
