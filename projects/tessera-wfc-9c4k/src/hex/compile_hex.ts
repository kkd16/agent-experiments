// Compile a hand-authored hex tileset into the variants + adjacency tensor the solver consumes —
// the hex analogue of the square pipeline (../wfc/tiles.ts). Each prototype is expanded into its
// distinct 60° rotations (rotating the edge codes by a cyclic shift and re-rendering the drawing),
// duplicates are dropped, and the local edge rule is compiled into `allowed[dir][tile]` lists: for
// each tile and direction, the tiles permitted as its neighbour there. The tensor is built once;
// the solver only ever reads it.

import { DIRS6, fits6, hexCorners, hexPath, rotateHexEdges, type Dir6, type HexEdges } from './hexgrid';
import type { CompiledHexTileset, HexPrototype, HexTileset, HexVariant } from './types_hex';

/** Resolution (px) of a variant's square bitmap. The hex is inscribed; the corners are transparent. */
export const HEX_BMP = 72;

function makeCanvas(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

/** Render one prototype at a given rotation into a transparent-cornered hex bitmap. */
function renderVariant(proto: HexPrototype, rotation: number, background: string): HTMLCanvasElement {
  const c = makeCanvas(HEX_BMP);
  const ctx = c.getContext('2d')!;
  const s = HEX_BMP / 2; // circumradius; pointy-top height = 2s = HEX_BMP fits exactly
  ctx.save();
  ctx.translate(HEX_BMP / 2, HEX_BMP / 2);
  // clip to the hexagon so the drawing never bleeds into a neighbour's cell
  hexPath(ctx, 0, 0, s);
  ctx.clip();
  ctx.fillStyle = background;
  ctx.fill();
  ctx.rotate((rotation * Math.PI) / 3); // 60° clockwise per step
  proto.draw(ctx, s);
  ctx.restore();
  return c;
}

/** Average colour over the hex interior (alpha-weighted, so transparent corners don't pollute it). */
function averageColor(c: HTMLCanvasElement): [number, number, number] {
  const ctx = c.getContext('2d')!;
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let r = 0;
  let g = 0;
  let b = 0;
  let wsum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue;
    const w = a / 255;
    r += data[i] * w;
    g += data[i + 1] * w;
    b += data[i + 2] * w;
    wsum += w;
  }
  if (wsum === 0) return [40, 44, 58];
  return [Math.round(r / wsum), Math.round(g / wsum), Math.round(b / wsum)];
}

/** A content hash of the rendered pixels (FNV-1a), so visually-identical rotations dedup cleanly. */
function bitmapHash(c: HTMLCanvasElement): number {
  const ctx = c.getContext('2d')!;
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let h = 0x811c9dc5;
  // sample every 4th pixel — plenty to separate distinct drawings, a quarter of the work
  for (let i = 0; i < data.length; i += 16) {
    h ^= data[i] + (data[i + 1] << 3) + (data[i + 2] << 6) + (data[i + 3] << 9);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function compileHex(set: HexTileset): CompiledHexTileset {
  const variants: HexVariant[] = [];
  const seen = new Set<string>();

  for (const proto of set.prototypes) {
    const rots = Math.max(1, Math.min(6, proto.rotations));
    for (let r = 0; r < rots; r++) {
      const edges = rotateHexEdges(proto.edges, r);
      const bitmap = renderVariant(proto, r, set.background);
      // dedup on edges *and* look: identical-edge rotations of an asymmetric drawing stay distinct
      const key = `${proto.name}|${edges.join(',')}|${bitmapHash(bitmap)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      variants.push({
        id: variants.length,
        proto: proto.name,
        rotation: r,
        edges,
        weight: proto.weight ?? 1,
        bitmap,
        avg: averageColor(bitmap),
      });
    }
  }

  const n = variants.length;
  const allowed = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [] } as Record<Dir6, number[][]>;
  for (const d of DIRS6) {
    const lists: number[][] = [];
    for (let a = 0; a < n; a++) {
      const list: number[] = [];
      for (let b = 0; b < n; b++) {
        if (fits6(variants[a].edges, variants[b].edges, d)) list.push(b);
      }
      lists.push(list);
    }
    allowed[d] = lists;
  }

  const weights = variants.map((v) => v.weight);
  const weightLogWeights = weights.map((w) => w * Math.log(w));

  return {
    key: set.key,
    name: set.name,
    background: set.background,
    variants,
    allowed,
    weights,
    weightLogWeights,
  };
}

/** Recompile with per-variant weight overrides (adjacency untouched) — used by the live sliders. */
export function withWeights(set: CompiledHexTileset, overrides: ReadonlyMap<number, number>): CompiledHexTileset {
  if (overrides.size === 0) return set;
  const weights = set.weights.slice();
  for (const [id, w] of overrides) if (id >= 0 && id < weights.length) weights[id] = Math.max(0.0001, w);
  return { ...set, weights, weightLogWeights: weights.map((w) => w * Math.log(w)) };
}

/** Re-export so tilesets can build their drawings against the same corner geometry as the compiler. */
export { hexCorners };
export type { HexEdges };
