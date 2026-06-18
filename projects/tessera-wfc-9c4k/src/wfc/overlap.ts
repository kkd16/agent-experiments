// The **overlapping** Wave Function Collapse model — the original algorithm (Gumin, 2016).
//
// Where the tiled model is handed a set of tiles and an explicit adjacency relation, the
// overlapping model is handed a single example bitmap and *derives everything* from it:
//
//   1. Slide an N×N window over the sample (optionally wrapping, "periodic input") and collect
//      every distinct pattern, together with the full D4 symmetry family (rotations +
//      reflections) up to the chosen symmetry level. Each pattern's number of occurrences
//      becomes its weight, so common patterns are placed more often.
//   2. Two patterns A and B may sit one cell apart in direction (dx,dy) iff they *agree on
//      their overlap* — every cell shared by the two offset windows holds the same colour.
//      That overlap-agreement relation is exactly the adjacency the solver consumes.
//   3. The output cell at (x,y) is rendered as the colour of the collapsed pattern's origin
//      pixel — so each cell is a single solid colour, and the whole grid reads as one image.
//
// Crucially this is compiled into the *same* `CompiledTileset` shape the tiled model uses, so
// the entire existing engine — support-counter propagation, snapshot backtracking, the live
// renderer, the gallery — runs the overlapping model with zero changes.

import { DELTA, DIRS, type Dir } from './edges';
import type { Sample } from './samples';
import type { CompiledTileset, Variant } from './types';

export type OverlapOptions = {
  /** Pattern side length (2 or 3 in practice). */
  n: number;
  /** How many of the 8 D4 transforms to harvest: 1, 2, 4 or 8. */
  symmetry: number;
  /** Treat the sample as toroidal when harvesting patterns. */
  periodicInput: boolean;
};

/** Hard cap on the pattern alphabet so memory/time stay bounded on pathological inputs. */
const MAX_PATTERNS = 320;

type Pattern = Int32Array; // length n*n, palette indices, indexed [x + n*y]

// ---- D4 transforms on an N×N pattern ---------------------------------------

function rotate(p: Pattern, n: number): Pattern {
  const out = new Int32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[x + n * y] = p[n - 1 - y + n * x];
  return out;
}

function reflect(p: Pattern, n: number): Pattern {
  const out = new Int32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[x + n * y] = p[n - 1 - x + n * y];
  return out;
}

/** The first `symmetry` elements of the dihedral family, in Gumin's canonical order. */
function symmetryFamily(base: Pattern, n: number, symmetry: number): Pattern[] {
  const fam: Pattern[] = new Array(8);
  fam[0] = base;
  fam[1] = reflect(fam[0], n);
  fam[2] = rotate(fam[0], n);
  fam[3] = reflect(fam[2], n);
  fam[4] = rotate(fam[2], n);
  fam[5] = reflect(fam[4], n);
  fam[6] = rotate(fam[4], n);
  fam[7] = reflect(fam[6], n);
  return fam.slice(0, Math.max(1, Math.min(8, symmetry)));
}

function keyOf(p: Pattern): string {
  // Patterns are tiny (n≤3 → ≤9 cells), so a joined string is a fine, stable hash.
  return p.join(',');
}

// ---- overlap-agreement adjacency -------------------------------------------

/**
 * Do patterns `a` (at the origin) and `b` (shifted by (dx,dy)) agree on every shared cell?
 * The shared region is the intersection of the two N×N windows; outside it there is no
 * constraint. This is the overlapping model's entire notion of "fits".
 */
function agrees(a: Pattern, b: Pattern, dx: number, dy: number, n: number): boolean {
  const xmin = dx < 0 ? 0 : dx;
  const xmax = dx < 0 ? dx + n : n;
  const ymin = dy < 0 ? 0 : dy;
  const ymax = dy < 0 ? dy + n : n;
  for (let y = ymin; y < ymax; y++) {
    for (let x = xmin; x < xmax; x++) {
      if (a[x + n * y] !== b[x - dx + n * (y - dy)]) return false;
    }
  }
  return true;
}

// ---- rendering -------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.replace(/(.)/g, '$1$1') : h;
  const num = parseInt(v, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

/** A solid `TILE_PX` swatch of one colour — what the grid draws per cell. */
function solidBitmap(hex: string, px: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = px;
  c.height = px;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, px, px);
  return c;
}

/** The full N×N pattern rendered crisply — used only by the gallery preview. */
function patternBitmap(p: Pattern, n: number, palette: string[], px: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = px;
  c.height = px;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const cell = px / n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      ctx.fillStyle = palette[p[x + n * y]] ?? '#000';
      ctx.fillRect(Math.floor(x * cell), Math.floor(y * cell), Math.ceil(cell), Math.ceil(cell));
    }
  }
  return c;
}

const OVERLAP_PX = 56; // matches the tiled model's TILE_PX so previews line up

// ---- the compiler ----------------------------------------------------------

/** Harvest patterns from a sample and compile the overlapping model into a CompiledTileset. */
export function compileOverlap(sample: Sample, opts: OverlapOptions): CompiledTileset {
  const n = Math.max(2, Math.min(3, Math.round(opts.n)));
  const { width: W, height: H, grid, palette } = sample;

  // 1. Harvest patterns + counts.
  const counts = new Map<string, number>();
  const patterns = new Map<string, Pattern>();
  const xMax = opts.periodicInput ? W : W - n + 1;
  const yMax = opts.periodicInput ? H : H - n + 1;
  for (let oy = 0; oy < Math.max(0, yMax); oy++) {
    for (let ox = 0; ox < Math.max(0, xMax); ox++) {
      const base = new Int32Array(n * n);
      for (let dy = 0; dy < n; dy++) {
        for (let dx = 0; dx < n; dx++) {
          const sx = (ox + dx) % W;
          const sy = (oy + dy) % H;
          base[dx + n * dy] = grid[sy * W + sx];
        }
      }
      for (const variant of symmetryFamily(base, n, opts.symmetry)) {
        const k = keyOf(variant);
        counts.set(k, (counts.get(k) ?? 0) + 1);
        if (!patterns.has(k)) patterns.set(k, variant);
      }
    }
  }

  // Fallback: a degenerate sample (smaller than N, etc.) — emit a single 1-colour pattern so
  // the solver still has something to place and the studio never hard-fails.
  let keys = [...patterns.keys()];
  if (keys.length === 0) {
    const solid = new Int32Array(n * n).fill(grid[0] ?? 0);
    const k = keyOf(solid);
    patterns.set(k, solid);
    counts.set(k, 1);
    keys = [k];
  }

  // 2. Keep the most frequent patterns if we blew past the cap.
  keys.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
  if (keys.length > MAX_PATTERNS) keys = keys.slice(0, MAX_PATTERNS);
  const pats = keys.map((k) => patterns.get(k)!);
  const N = pats.length;

  // 3. Build variants (origin-pixel colour drives the cell; full pattern drives the gallery).
  const variants: Variant[] = pats.map((p, i) => {
    const hex = palette[p[0]] ?? '#000';
    return {
      id: i,
      proto: `p${i}`,
      rotation: 0,
      edges: ['', '', '', ''],
      weight: counts.get(keys[i]) ?? 1,
      bitmap: solidBitmap(hex, OVERLAP_PX),
      patternBitmap: patternBitmap(p, n, palette, OVERLAP_PX),
      avg: hexToRgb(hex),
    };
  });

  // 4. Overlap-agreement adjacency, in the [N,E,S,W] direction order the solver expects.
  const allowed = { 0: [], 1: [], 2: [], 3: [] } as Record<Dir, number[][]>;
  for (const d of DIRS) {
    const [dx, dy] = DELTA[d as Dir];
    for (let a = 0; a < N; a++) {
      const list: number[] = [];
      for (let b = 0; b < N; b++) if (agrees(pats[a], pats[b], dx, dy, n)) list.push(b);
      allowed[d as Dir].push(list);
    }
  }

  const weights = variants.map((v) => v.weight);
  const weightLogWeights = weights.map((w) => w * Math.log(w));

  return {
    key: `overlap:${sample.key}`,
    name: sample.name,
    background: '#0b0f14',
    variants,
    allowed,
    weights,
    weightLogWeights,
  };
}
