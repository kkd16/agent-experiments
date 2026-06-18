import type { ControllerConfig } from './controller';
import { SAMPLES, type Sample } from './samples';

// Encode the generative state into the URL hash so a run is shareable/reproducible.
// Hash routing only (history-API routes break under the site's relative base).
//
// Backwards compatible: older hashes have no model field and decode to the tiled model with
// their saved tileset + settings, exactly as before. The overlapping model adds its sample,
// pattern size, symmetry, periodic-input flag, and — for hand-drawn samples — a compact,
// self-contained encoding of the bitmap itself so a custom sample travels in the link.

const bool = (b: boolean) => (b ? '1' : '0');
const TILESET_KEYS = new Set(['knots', 'terrain', 'circuit', 'cables']);
const SAMPLE_KEYS = new Set([...SAMPLES.map((s) => s.key), 'custom']);
const MAX_CUSTOM_CELLS = 1024; // don't bloat the URL with huge hand-drawn samples

export type Permalinkable = Pick<
  ControllerConfig,
  | 'model'
  | 'tilesetKey'
  | 'sampleKey'
  | 'customSample'
  | 'patternN'
  | 'symmetry'
  | 'periodicInput'
  | 'size'
  | 'seed'
  | 'wrap'
  | 'backtracking'
  | 'speed'
  | 'showGhost'
  | 'showEntropy'
  | 'showGrid'
>;

// ---- custom-sample (de)serialisation ---------------------------------------

/** `w.h.hex-hex-...~<one base36 char per cell>` — compact and URL-safe. */
function encodeSample(s: Sample): string | null {
  if (s.width * s.height > MAX_CUSTOM_CELLS) return null;
  if (s.palette.length > 36) return null;
  const pal = s.palette.map((c) => c.replace('#', '')).join('-');
  let cells = '';
  for (let i = 0; i < s.grid.length; i++) cells += (s.grid[i] % 36).toString(36);
  return `${s.width}.${s.height}.${pal}~${cells}`;
}

function decodeSample(raw: string): Sample | undefined {
  const tilde = raw.indexOf('~');
  if (tilde < 0) return undefined;
  const head = raw.slice(0, tilde);
  const cells = raw.slice(tilde + 1);
  const parts = head.split('.');
  if (parts.length < 3) return undefined;
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  if (!Number.isInteger(width) || !Number.isInteger(height)) return undefined;
  if (width < 1 || height < 1 || width * height > MAX_CUSTOM_CELLS) return undefined;
  const palette = parts[2].split('-').map((h) => `#${h}`);
  if (palette.length < 1 || palette.some((h) => !/^#[0-9a-fA-F]{3,6}$/.test(h))) return undefined;
  if (cells.length !== width * height) return undefined;
  const grid = new Int32Array(width * height);
  for (let i = 0; i < cells.length; i++) {
    const v = parseInt(cells[i], 36);
    if (Number.isNaN(v) || v >= palette.length) return undefined;
    grid[i] = v;
  }
  return { key: 'custom', name: 'Custom', blurb: 'Your own hand-drawn sample.', width, height, palette, grid };
}

// ---- top-level encode / decode ---------------------------------------------

export function encodeHash(c: Permalinkable): string {
  const p = new URLSearchParams();
  p.set('m', c.model === 'overlap' ? 'o' : 't');
  p.set('n', String(c.size));
  p.set('s', c.seed);
  p.set('w', bool(c.wrap));
  p.set('b', bool(c.backtracking));
  p.set('v', String(c.speed));
  p.set('g', bool(c.showGhost));
  p.set('h', bool(c.showEntropy));
  p.set('r', bool(c.showGrid));
  if (c.model === 'overlap') {
    p.set('sk', c.sampleKey);
    p.set('pn', String(c.patternN));
    p.set('sy', String(c.symmetry));
    p.set('pi', bool(c.periodicInput));
    if (c.sampleKey === 'custom' && c.customSample) {
      const enc = encodeSample(c.customSample);
      if (enc) p.set('cs', enc);
    }
  } else {
    p.set('k', c.tilesetKey);
  }
  return '#' + p.toString();
}

/** Parse the current hash into a partial config (only well-formed fields are returned). */
export function decodeHash(hash: string): Partial<Permalinkable> {
  const out: Partial<Permalinkable> = {};
  const raw = hash.replace(/^#/, '');
  if (!raw) return out;
  const p = new URLSearchParams(raw);

  const m = p.get('m');
  if (m === 'o') out.model = 'overlap';
  else if (m === 't') out.model = 'tiled';

  const k = p.get('k');
  if (k && TILESET_KEYS.has(k)) out.tilesetKey = k;

  const sk = p.get('sk');
  if (sk && SAMPLE_KEYS.has(sk)) out.sampleKey = sk;
  const cs = p.get('cs');
  if (cs) {
    const sample = decodeSample(cs);
    if (sample) {
      out.customSample = sample;
      out.sampleKey = 'custom';
    }
  }
  const pn = Number(p.get('pn'));
  if (pn === 2 || pn === 3) out.patternN = pn;
  const sy = Number(p.get('sy'));
  if (sy === 1 || sy === 2 || sy === 4 || sy === 8) out.symmetry = sy;

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
  const pi = flag('pi');
  if (pi !== undefined) out.periodicInput = pi;
  const g = flag('g');
  if (g !== undefined) out.showGhost = g;
  const h = flag('h');
  if (h !== undefined) out.showEntropy = h;
  const r = flag('r');
  if (r !== undefined) out.showGrid = r;
  return out;
}
