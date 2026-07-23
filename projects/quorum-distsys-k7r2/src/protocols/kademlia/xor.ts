// Pure XOR-metric arithmetic for Kademlia (Maymounkov & Mazières, IPTPS 2002)
// — shared by the protocol, its routing table, its invariants and the lab's
// binary-trie visualisation, so the picture and the algorithm agree exactly.
//
// Kademlia lays node ids and keys on the *same* m-bit space and measures
// closeness by **XOR**: distance(a, b) = a ⊕ b, read as an unsigned integer.
// This metric is the whole trick — it is symmetric, it obeys the triangle
// inequality, and (unlike Chord's clockwise ring distance) it is *unidirectional*
// and *self-routing*: for any point there is exactly one node at each distance,
// so every node can independently learn a low-diameter routing table just by
// remembering whom it talks to. A node keeps one **k-bucket** per bit of the id:
// bucket i holds contacts whose most-significant differing bit sits at position i
// — i.e. contacts in the subtree that branches off the node's own path at depth
// (m-1-i). That is precisely the family of subtrees that do *not* contain the
// node, which is why the routing table is drawn as the trees "hanging off" the
// path from the root to the node.
import type { NodeId } from '../../sim/types';

/** Stable FNV-1a string hash folded into [0, 2^m) — same hash Chord uses, so a
 *  key lands at the same id in either lab. */
export function hashId(s: string, m: number): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % (1 << m);
}

/**
 * Assign each node an id by hashing its name, resolving collisions by
 * deterministic linear probing. Every node computes this from the same ordered
 * directory (the "DNS"/transport layer), so all nodes agree on id ↔ name — while
 * the *algorithm* still only ever acts on ids it has learned through messages.
 */
export function buildDirectory(names: readonly NodeId[], m: number): Record<number, NodeId> {
  const size = 1 << m;
  const dir: Record<number, NodeId> = {};
  for (const name of names) {
    let id = hashId(name, m);
    let guard = 0;
    while (dir[id] !== undefined && guard < size) {
      id = (id + 1) % size;
      guard++;
    }
    dir[id] = name;
  }
  return dir;
}

/** The XOR distance between two ids, as an unsigned integer. */
export function xorDist(a: number, b: number): number {
  return (a ^ b) >>> 0;
}

/** Position (0 = LSB … m-1 = MSB) of the highest set bit of x, or -1 if x === 0. */
export function highBit(x: number): number {
  let p = -1;
  x >>>= 0;
  while (x > 0) {
    p++;
    x >>>= 1;
  }
  return p;
}

/**
 * The k-bucket index for `other` in `self`'s routing table: the position of the
 * most-significant bit at which the two ids differ. Returns -1 when the ids are
 * equal (a node never stores itself). Range: [0, m-1].
 */
export function bucketIndex(self: number, other: number): number {
  return highBit(xorDist(self, other));
}

/** Compare two ids by XOR distance to `target`: negative ⇒ a is strictly closer. */
export function compareDist(target: number, a: number, b: number): number {
  const da = xorDist(target, a);
  const db = xorDist(target, b);
  return da === db ? 0 : da < db ? -1 : 1;
}

/** The k ids nearest to `target` under the XOR metric (deterministic, ties by id). */
export function kClosest(target: number, ids: readonly number[], k: number): number[] {
  return [...new Set(ids)]
    .sort((a, b) => {
      const c = compareDist(target, a, b);
      return c !== 0 ? c : a - b;
    })
    .slice(0, k);
}

/** Render an id as its m-bit binary string, most-significant bit first. */
export function toBits(id: number, m: number): string {
  let s = '';
  for (let i = m - 1; i >= 0; i--) s += (id >> i) & 1;
  return s;
}
