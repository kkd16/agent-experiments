// Compile a hand-authored 3D tileset into the variants + adjacency tensor the solver consumes.
//
// Mirrors the 2D pipeline (../wfc/tiles.ts): expand each prototype into its distinct Y-rotations
// (rotating both the voxel geometry and the six face sockets coherently, then deduping identical
// results), and compile the local socket rule into `allowed[dir][tile]` lists — for each tile and
// face direction, the list of tiles permitted as its neighbour there. Two tiles A,B are allowed
// to sit with B in direction d from A iff A's face-d socket connects to B's face-opposite(d)
// socket; the tensor is built once and the solver only ever reads it.

import { DIRS3, opposite3, ROT_CW_SRC, type Dir3 } from './dirs3';
import { connects, rotateSocket, type Faces, type Socket } from './sockets3';
import type { CompiledTileset3, Prototype3, Tileset3, Variant3 } from './types3';
import { averageColor, modelKey, rotateY } from './voxel';

/** Rotate a face-socket tuple 90° CW about +Y, `k` times: faces permute, vertical tags advance. */
export function rotateFaces(f: Faces, k: number): Faces {
  const steps = ((k % 4) + 4) % 4;
  let cur = f;
  for (let s = 0; s < steps; s++) {
    const out = new Array(6) as Faces;
    for (const d of DIRS3) {
      // world face d, after a CW step, shows the socket that was on ROT_CW_SRC[d] — and if that
      // face is vertical its rotation tag advances by one quarter-turn.
      out[d] = rotateSocket(cur[ROT_CW_SRC[d as Dir3]], 1) as Socket;
    }
    cur = out;
  }
  return cur;
}

/** A stable key for a fully-rotated variant, so 180°/90°-symmetric tiles don't double-count. */
function variantKey(v: Variant3): string {
  const s = v.sockets
    .map((f) => (f.kind === 'h' ? `h${f.key}${f.sym ? 's' : f.flip ? 'f' : ''}` : `v${f.key}${f.inv ? 'i' : f.rot}`))
    .join('|');
  return s + '#' + modelKey(v.model);
}

export function compile3(set: Tileset3): CompiledTileset3 {
  const variants: Variant3[] = [];
  const seen = new Set<string>();

  for (const proto of set.prototypes as Prototype3[]) {
    for (let k = 0; k < proto.rotations; k++) {
      const model = rotateY(proto.model, k);
      const sockets = rotateFaces(proto.sockets, k);
      const v: Variant3 = {
        id: variants.length,
        proto: proto.name,
        rotation: k,
        model,
        sockets,
        weight: proto.weight ?? 1,
        avg: averageColor(model),
      };
      const key = variantKey(v);
      if (seen.has(key)) continue; // a symmetric tile produced an identical rotation — drop it
      seen.add(key);
      variants.push(v);
    }
  }

  const n = variants.length;
  const allowed: Record<Dir3, number[][]> = {
    0: [],
    1: [],
    2: [],
    3: [],
    4: [],
    5: [],
  };
  for (const d of DIRS3) {
    const opp = opposite3(d);
    const lists: number[][] = [];
    for (let a = 0; a < n; a++) {
      const sa = variants[a].sockets[d];
      const list: number[] = [];
      for (let b = 0; b < n; b++) {
        if (connects(sa, variants[b].sockets[opp])) list.push(b);
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
    res: set.res,
    variants,
    allowed,
    weights,
    weightLogWeights,
  };
}

/** Recompile with per-variant weight overrides (adjacency untouched) — used by the live sliders. */
export function withWeights(set: CompiledTileset3, overrides: ReadonlyMap<number, number>): CompiledTileset3 {
  if (overrides.size === 0) return set;
  const weights = set.weights.slice();
  for (const [id, w] of overrides) if (id >= 0 && id < weights.length) weights[id] = Math.max(0.0001, w);
  return { ...set, weights, weightLogWeights: weights.map((w) => w * Math.log(w)) };
}
