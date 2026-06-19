// The 3D socket algebra — how two tiles decide whether they may sit face-to-face.
//
// In 2D every edge is a string read clockwise and tiles fit when one edge equals the reverse of
// the other's facing edge (see ../wfc/edges.ts). In 3D that reversal becomes two different rules,
// one per face orientation — this is the well-tested scheme from Oskar Stålberg / Marian42's 3D
// WFC work, and it is what makes rotation-about-Y sound:
//
//   • HORIZONTAL faces (±X, ±Z). Each carries a profile that is the same physical seam viewed
//     from either side, so a face and its neighbour's facing face fit iff they describe the
//     *mirror* of one another. We encode that with a `key` plus a `flip` bit: a symmetric seam
//     ("0", "wall"…, marked `sym`) connects to itself; an asymmetric seam comes as a flipped
//     pair — `flip:false` connects only to the same key with `flip:true`. A Y-rotation merely
//     moves a horizontal socket to a different face; its key/flip are unchanged.
//
//   • VERTICAL faces (top/bottom). These never mirror — the top of A meets the bottom of B with
//     no flip — but they *do* carry a rotation: a tile rotated 90° about Y presents a top texture
//     turned 90°. So a vertical socket has a `key`, a `rot` in 0..3, and an `inv` ("rotationally
//     invariant") bit. Tops/bottoms connect iff keys match and (either side invariant, or their
//     rotations are equal). A Y-rotation advances `rot` by the rotation count (see voxel.ts).
//
// Sockets are authored as short strings the parser below turns into this struct, so a tileset
// reads compactly (e.g. "2f" = asymmetric horizontal key 2 flipped, "v1" = vertical key 1, "v1i"
// = vertical key 1 invariant).

import { HORIZ, type Dir3 } from './dirs3';

export type HSocket = { kind: 'h'; key: string; sym: boolean; flip: boolean };
export type VSocket = { kind: 'v'; key: string; rot: number; inv: boolean };
export type Socket = HSocket | VSocket;

/** A tile's six face sockets, indexed by {@link Dir3}. */
export type Faces = [Socket, Socket, Socket, Socket, Socket, Socket];

/**
 * Parse a horizontal socket spec. Grammar: `key` optionally followed by `s` (symmetric) or `f`
 * (flipped). `"0"` and any `…s` are symmetric; `…f` is the flipped half of an asymmetric pair.
 * Examples: `"0"` empty/symmetric, `"1s"` symmetric seam 1, `"2"`/`"2f"` an asymmetric pair.
 */
export function hsock(spec: string): HSocket {
  const sym = spec.endsWith('s') || spec === '0';
  const flip = spec.endsWith('f');
  const key = spec.replace(/[sf]$/, '');
  return { kind: 'h', key, sym, flip };
}

/**
 * Parse a vertical socket spec. Grammar: `v` `key` then optional `i` (rotation-invariant) and an
 * optional rotation digit is *not* part of the spec — base rotation is always 0; the compiler
 * advances it when it rotates the tile. Examples: `"v0"` invariant-by-default empty top, `"v1"`
 * a directional top, `"v1i"` a top whose texture is 4-fold symmetric.
 */
export function vsock(spec: string): VSocket {
  const inv = spec.endsWith('i') || spec === 'v0';
  const key = spec.replace(/^v/, '').replace(/i$/, '');
  return { kind: 'v', key, rot: 0, inv };
}

/** Advance a socket's rotation tag by `k` quarter-turns (no-op for horizontal sockets). */
export function rotateSocket(s: Socket, k: number): Socket {
  if (s.kind === 'h') return s;
  return { ...s, rot: ((s.rot + k) % 4 + 4) % 4 };
}

/**
 * Does face socket `a` (on the side facing its neighbour) connect to face socket `b` (the
 * neighbour's facing socket)? Horizontal-to-horizontal uses the mirror rule; vertical-to-vertical
 * the rotation rule. A horizontal socket never connects to a vertical one (they only ever meet
 * their own orientation, since a face direction is fixed across the seam).
 */
export function connects(a: Socket, b: Socket): boolean {
  if (a.kind === 'h' && b.kind === 'h') {
    if (a.key !== b.key) return false;
    if (a.sym && b.sym) return true;
    if (a.sym !== b.sym) return false; // a symmetric seam can't meet an asymmetric one
    return a.flip !== b.flip; // asymmetric pair: opposite halves fit
  }
  if (a.kind === 'v' && b.kind === 'v') {
    if (a.key !== b.key) return false;
    if (a.inv || b.inv) return true;
    return a.rot === b.rot;
  }
  return false;
}

/** Build a `Faces` tuple from a compact spec record (defaults any missing face to empty "0"). */
export function faces(spec: Partial<Record<Dir3, string>>): Faces {
  const get = (d: Dir3): Socket => {
    const raw = spec[d];
    if (raw == null) return HORIZ.includes(d as never) ? hsock('0') : vsock('v0');
    return raw.startsWith('v') ? vsock(raw) : hsock(raw);
  };
  return [get(0), get(1), get(2), get(3), get(4), get(5)] as Faces;
}
