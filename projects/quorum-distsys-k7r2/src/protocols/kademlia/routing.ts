// The k-bucket routing table — pure functions over the plain `RoutingTable`
// data so the kernel can snapshot node state as JSON (no class instances).
//
// A node keeps m buckets, one per bit of the id space. Bucket i holds up to k
// contacts whose most-significant differing bit with the node sits at position i
// (see `bucketIndex`). Within a bucket, order encodes recency: index 0 is the
// **least-recently-seen** contact (the eviction candidate) and the tail is the
// **most-recently-seen**. Kademlia's insertion rule:
//
//   • already present  → move it to the tail (it just proved liveness);
//   • bucket has room  → append it at the tail;
//   • bucket is full   → *don't* blindly evict — ping the least-recently-seen
//                        head; if it answers it moves to the tail and the newcomer
//                        is dropped, otherwise the head is evicted and the newcomer
//                        takes the tail. This "prefer old, live contacts" bias is
//                        what makes Kademlia routing tables resistant to churn and
//                        to eclipse attacks: a node that has been up a long time is
//                        statistically likely to stay up.
import { bucketIndex, compareDist } from './xor';
import type { RoutingTable } from './types';

export function makeTable(self: number, m: number, k: number): RoutingTable {
  return { self, m, k, buckets: Array.from({ length: m }, () => []) };
}

export type InsertResult =
  | { status: 'self' }
  | { status: 'seen' }
  | { status: 'added' }
  | { status: 'full'; bucket: number; lru: number };

/** Learn (or refresh) a contact. Returns what the caller must do next: nothing,
 *  or — when the bucket is full — the least-recently-seen head to ping. */
export function tableInsert(rt: RoutingTable, id: number): InsertResult {
  if (id === rt.self) return { status: 'self' };
  const b = bucketIndex(rt.self, id);
  if (b < 0 || b >= rt.m) return { status: 'self' };
  const bucket = rt.buckets[b];
  const at = bucket.indexOf(id);
  if (at >= 0) {
    bucket.splice(at, 1);
    bucket.push(id); // move-to-tail: most-recently-seen
    return { status: 'seen' };
  }
  if (bucket.length < rt.k) {
    bucket.push(id);
    return { status: 'added' };
  }
  return { status: 'full', bucket: b, lru: bucket[0] };
}

/** Move an existing contact to its bucket's tail (it answered a probe). */
export function markSeen(rt: RoutingTable, id: number): void {
  const b = bucketIndex(rt.self, id);
  if (b < 0 || b >= rt.m) return;
  const bucket = rt.buckets[b];
  const at = bucket.indexOf(id);
  if (at >= 0) {
    bucket.splice(at, 1);
    bucket.push(id);
  }
}

/** The pinged head failed to answer: drop it and admit the challenger at the tail. */
export function evict(rt: RoutingTable, dead: number, challenger: number): void {
  const b = bucketIndex(rt.self, dead);
  if (b < 0 || b >= rt.m) return;
  const bucket = rt.buckets[b];
  const at = bucket.indexOf(dead);
  if (at >= 0) bucket.splice(at, 1);
  if (challenger !== rt.self && bucket.indexOf(challenger) < 0 && bucket.length < rt.k) {
    bucket.push(challenger);
  }
}

/** Remove a contact known to be dead (a probe to it timed out). */
export function removeContact(rt: RoutingTable, id: number): void {
  const b = bucketIndex(rt.self, id);
  if (b < 0 || b >= rt.m) return;
  const bucket = rt.buckets[b];
  const at = bucket.indexOf(id);
  if (at >= 0) bucket.splice(at, 1);
}

/** Every contact across every bucket. */
export function allContacts(rt: RoutingTable): number[] {
  const out: number[] = [];
  for (const b of rt.buckets) out.push(...b);
  return out;
}

/** The `count` contacts nearest to `target` under the XOR metric. `extra`
 *  contacts (e.g. self) can be folded in for closeness queries. */
export function closest(rt: RoutingTable, target: number, count: number, extra: number[] = []): number[] {
  const ids = [...new Set([...allContacts(rt), ...extra])];
  return ids
    .sort((a, b) => {
      const c = compareDist(target, a, b);
      return c !== 0 ? c : a - b;
    })
    .slice(0, count);
}

export function tableSize(rt: RoutingTable): number {
  let n = 0;
  for (const b of rt.buckets) n += b.length;
  return n;
}
