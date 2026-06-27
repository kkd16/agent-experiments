// The consistent-hashing ring that places nodes and keys in one id space, and
// the preference-list logic that turns a key into the N nodes responsible for it.
//
// Dynamo partitions data with consistent hashing so that adding or removing a
// node only moves a 1/N slice of keys. A key is owned by the nodes immediately
// *clockwise* of its hash on the ring (its **preference list**). When some of
// those nodes are unreachable, a *sloppy* quorum walks further round the ring to
// the next healthy nodes, which hold the data as a hint for the absent owners —
// that is what keeps Dynamo "always writeable".
import type { NodeId } from '../../sim/types';

/** Size of the id space (positions are in [0, RING)). */
export const RING = 1 << 16;

/** 32-bit FNV-1a hash, folded into the ring space. Deterministic per string. */
export function hashPos(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % RING;
}

export interface RingNode {
  id: NodeId;
  pos: number;
}

/** Place every node on the ring with collision-resolved positions, sorted clockwise. */
export function buildRing(nodeIds: readonly NodeId[]): RingNode[] {
  const taken = new Set<number>();
  const nodes: RingNode[] = [];
  for (const id of nodeIds) {
    let p = hashPos(id);
    while (taken.has(p)) p = (p + 1) % RING; // linear probe keeps ids distinct
    taken.add(p);
    nodes.push({ id, pos: p });
  }
  nodes.sort((a, b) => a.pos - b.pos);
  return nodes;
}

/** Index of the first ring node at-or-after `pos` (wrapping) — the key's coordinator slot. */
function firstAtOrAfter(ring: RingNode[], pos: number): number {
  for (let i = 0; i < ring.length; i++) if (ring[i].pos >= pos) return i;
  return 0; // wrapped past the largest position → back to the smallest
}

/**
 * The ideal preference list for a key: the N distinct nodes walking clockwise
 * from the key's hash. With ≤ N nodes total it returns the whole cluster.
 */
export function preferenceList(key: string, ring: RingNode[], n: number): NodeId[] {
  if (ring.length === 0) return [];
  const start = firstAtOrAfter(ring, hashPos(key));
  const out: NodeId[] = [];
  for (let k = 0; k < ring.length && out.length < n; k++) {
    const id = ring[(start + k) % ring.length].id;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** One entry of a sloppy preference list: who stores the data, and (if it is a
 *  substitute) which absent home node it is holding a hint for. */
export interface SloppyTarget {
  node: NodeId;
  hintFor?: NodeId;
}

/**
 * The sloppy preference list: the first N *reachable* nodes clockwise. Each
 * unreachable home owner is replaced by the next healthy node further round the
 * ring, which records a hint for the owner it is standing in for. If sloppy is
 * disabled (strict quorum) the unreachable owners are simply dropped, so a write
 * can fail to reach W — exactly the availability cost of a strict quorum.
 */
export function sloppyPreferenceList(
  key: string,
  ring: RingNode[],
  n: number,
  alive: (id: NodeId) => boolean,
  sloppy: boolean,
): SloppyTarget[] {
  const home = preferenceList(key, ring, n);
  const homeSet = new Set(home);
  const out: SloppyTarget[] = [];
  const used = new Set<NodeId>();

  // Healthy home owners keep their slot.
  const sickHomes: NodeId[] = [];
  for (const h of home) {
    if (alive(h)) {
      out.push({ node: h });
      used.add(h);
    } else {
      sickHomes.push(h);
    }
  }
  if (!sloppy) return out; // strict quorum: no substitutes

  // Substitute each unreachable owner with the next healthy non-owner clockwise.
  const order = ring.map((r) => r.id);
  for (const sick of sickHomes) {
    const startIdx = order.indexOf(sick);
    let chosen: NodeId | undefined;
    for (let k = 1; k <= order.length; k++) {
      const cand = order[(startIdx + k) % order.length];
      if (alive(cand) && !used.has(cand) && !homeSet.has(cand)) {
        chosen = cand;
        break;
      }
    }
    // If every non-owner is taken/dead, fall back to any unused healthy node.
    if (!chosen) {
      for (const cand of order) {
        if (alive(cand) && !used.has(cand)) {
          chosen = cand;
          break;
        }
      }
    }
    if (chosen) {
      out.push({ node: chosen, hintFor: sick });
      used.add(chosen);
    }
  }
  return out;
}

/** Is `node` one of the N home owners for `key`? (Used to scope anti-entropy + convergence.) */
export function isHomeReplica(key: string, ring: RingNode[], n: number, node: NodeId): boolean {
  return preferenceList(key, ring, n).includes(node);
}
