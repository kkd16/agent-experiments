import { DIRS, fits, rotateEdges, type Dir, type Edges } from './edges';
import { ROTATIONS, type CompiledTileset, type Tileset, type Variant } from './types';

/** Resolution (px) each tile variant is rendered at. Crisp enough to upscale cleanly. */
export const TILE_PX = 56;

function makeCanvas(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return c;
}

/** Render one prototype at a given rotation into its own bitmap canvas. */
function renderVariant(
  draw: (ctx: CanvasRenderingContext2D, size: number) => void,
  rotation: number,
  background: string,
): HTMLCanvasElement {
  const c = makeCanvas(TILE_PX);
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  ctx.save();
  // Rotate about the tile centre by rotation×90° clockwise.
  ctx.translate(TILE_PX / 2, TILE_PX / 2);
  ctx.rotate((rotation * Math.PI) / 2);
  ctx.translate(-TILE_PX / 2, -TILE_PX / 2);
  draw(ctx, TILE_PX);
  ctx.restore();
  return c;
}

function averageColor(c: HTMLCanvasElement): [number, number, number] {
  const ctx = c.getContext('2d')!;
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let r = 0;
  let g = 0;
  let b = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/** A stable signature for a variant's connectivity + look, used to drop true duplicates. */
function variantKey(proto: string, edges: Edges): string {
  return `${proto}|${edges.join(',')}`;
}

/** Expand prototypes into rotated variants and compile the adjacency tensor. */
export function compile(set: Tileset): CompiledTileset {
  const variants: Variant[] = [];
  const seen = new Set<string>();

  for (const proto of set.prototypes) {
    const rots = ROTATIONS[proto.symmetry];
    for (let r = 0; r < rots; r++) {
      const edges = rotateEdges(proto.edges, r);
      const key = variantKey(proto.name, edges);
      if (seen.has(key)) continue;
      seen.add(key);
      const bitmap = renderVariant(proto.draw, r, set.background);
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
  const allowed = { 0: [], 1: [], 2: [], 3: [] } as Record<Dir, number[][]>;
  for (const d of DIRS) {
    for (let a = 0; a < n; a++) {
      const list: number[] = [];
      for (let b = 0; b < n; b++) {
        if (fits(variants[a].edges, variants[b].edges, d as Dir)) list.push(b);
      }
      allowed[d as Dir].push(list);
    }
  }

  const weights = variants.map((v) => v.weight);
  const weightLogWeights = weights.map((w) => w * Math.log(w));

  // Derive the open-socket mask when the set has connection semantics: bit d is set when this
  // variant's edge d is something other than the declared empty socket (i.e. it carries a link).
  let openMask: Uint8Array | undefined;
  if (set.emptyEdge != null) {
    const empty = set.emptyEdge;
    openMask = new Uint8Array(n);
    for (let a = 0; a < n; a++) {
      let m = 0;
      for (const d of DIRS) if (variants[a].edges[d] !== empty) m |= 1 << d;
      openMask[a] = m;
    }
  }

  return {
    key: set.key,
    name: set.name,
    background: set.background,
    variants,
    allowed,
    weights,
    weightLogWeights,
    openMask,
  };
}
