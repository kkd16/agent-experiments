// Compile a hand-authored mesh tileset into the variants + adjacency tensor the graph solver reads.
// The square/hex pipeline distilled: expand each prototype into its distinct quarter-turn rotations
// (a cyclic shift of the four sockets), drop duplicates, then precompute — for every ordered pair of
// local edge-slots (sA, sB) — which tiles may face each other there. The tensor is built once; the
// solver only ever reads it.

import {
  ROT,
  reverseSocket,
  rotateSockets,
  type CompiledMeshTileset,
  type MeshTileset,
  type MeshVariant,
} from './meshtypes';

/** Do socket `a` (on this cell) and socket `b` (on the neighbour) fit across a seam? */
function fit(a: string, b: string, sameDir: boolean): boolean {
  return sameDir ? a === b : a === reverseSocket(b);
}

export function compileMesh(set: MeshTileset): CompiledMeshTileset {
  const variants: MeshVariant[] = [];
  const seen = new Set<string>();

  for (const proto of set.prototypes) {
    const rots = ROT[proto.symmetry];
    for (let r = 0; r < rots; r++) {
      const sockets = rotateSockets(proto.sockets, r);
      const key = `${proto.name}|${sockets.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const rotated = sockets; // capture for the closure
      variants.push({
        id: variants.length,
        proto: proto.name,
        rotation: r,
        sockets,
        weight: proto.weight ?? 1,
        tint: proto.tint,
        render: (ctx, g, pal) => proto.paint(ctx, g, rotated, pal),
      });
    }
  }

  const n = variants.length;
  const emptyEdge = set.emptyEdge;

  // openMask: which slots carry a connection (anything other than the blank socket).
  const openMask = new Uint8Array(n);
  for (let t = 0; t < n; t++) {
    let m = 0;
    for (let s = 0; s < 4; s++) if (variants[t].sockets[s] !== emptyEdge) m |= 1 << s;
    openMask[t] = m;
  }

  const buildTensor = (sameDir: boolean): number[][][] => {
    const table: number[][][] = [];
    for (let pair = 0; pair < 16; pair++) {
      const sA = pair >> 2;
      const sB = pair & 3;
      const lists: number[][] = [];
      for (let a = 0; a < n; a++) {
        const list: number[] = [];
        const codeA = variants[a].sockets[sA];
        for (let b = 0; b < n; b++) {
          if (fit(codeA, variants[b].sockets[sB], sameDir)) list.push(b);
        }
        lists.push(list);
      }
      table.push(lists);
    }
    return table;
  };

  const weights = variants.map((v) => v.weight);
  const weightLogWeights = weights.map((w) => w * Math.log(w));

  return {
    key: set.key,
    name: set.name,
    background: set.background,
    palette: set.palette,
    variants,
    emptyEdge,
    allowedOpp: buildTensor(false),
    allowedSame: buildTensor(true),
    weights,
    weightLogWeights,
    openMask,
  };
}

/** Recompile with per-variant weight overrides (adjacency untouched) — used by the live sliders. */
export function withWeightsMesh(set: CompiledMeshTileset, overrides: ReadonlyMap<number, number>): CompiledMeshTileset {
  if (overrides.size === 0) return set;
  const weights = set.weights.slice();
  for (const [id, w] of overrides) if (id >= 0 && id < weights.length) weights[id] = Math.max(0.0001, w);
  return { ...set, weights, weightLogWeights: weights.map((w) => w * Math.log(w)) };
}
