// Pure ring arithmetic for Chord — shared by the protocol, its invariants and
// the lab's visualisation (so the picture and the algorithm use identical math).
import type { NodeId } from '../../sim/types';

/** Stable FNV-1a string hash folded into [0, 2^m). */
export function hashId(s: string, m: number): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % (1 << m);
}

/**
 * Assign each node a ring id by hashing its name, resolving collisions by
 * deterministic linear probing. Every node computes this from the same ordered
 * directory, so all nodes agree on the id ↔ name mapping.
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

/** x ∈ (a, b) on the ring; (a,a) is empty. */
export function inOpen(x: number, a: number, b: number): boolean {
  if (a === b) return false;
  return a < b ? a < x && x < b : a < x || x < b;
}

/** x ∈ (a, b] on the ring; (a,a] is the whole ring. */
export function inOpenClosed(x: number, a: number, b: number): boolean {
  if (a === b) return true;
  return a < b ? a < x && x <= b : a < x || x <= b;
}

/** The true owner (successor) of `key` among a set of live ring ids. */
export function ownerOf(key: number, liveIds: readonly number[]): number | null {
  if (liveIds.length === 0) return null;
  const sorted = [...liveIds].sort((p, q) => p - q);
  for (const id of sorted) if (id >= key) return id;
  return sorted[0]; // wrap around
}

/** The correct immediate successor of `id` among live ids (excluding id itself). */
export function successorOf(id: number, liveIds: readonly number[]): number | null {
  const others = liveIds.filter((x) => x !== id);
  if (others.length === 0) return id; // alone on the ring
  const sorted = [...others].sort((p, q) => p - q);
  for (const x of sorted) if (x > id) return x;
  return sorted[0];
}
