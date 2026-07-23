// Kademlia health checks. As in Chord, pointer correctness is an *eventual*
// property — background bucket-refresh heals the tables after churn — so the
// well-formedness of the k-buckets is a true always-on safety invariant, while
// "lookup finds the true k-closest" and "tables cover the network" are
// convergence gauges that dip during a join/crash and return to green as the
// network heals. That dip-then-heal is the lesson.
import type { InvariantResult, NodeView } from '../../sim/types';
import type { KademliaState, RoutingTable } from './types';
import { bucketIndex, kClosest, xorDist, compareDist } from './xor';

/**
 * Re-run Kademlia's iterative lookup *offline* over a frozen set of routing
 * tables — the same α-parallel shortlist algorithm the live protocol runs, but
 * as a pure function so an invariant can ask "from node `start`, would a lookup
 * for `target` reach the true k closest live nodes?" without perturbing the sim.
 */
export function offlineClosest(
  tables: Map<number, RoutingTable>,
  start: number,
  target: number,
  k: number,
  alpha: number,
): number[] {
  const status = new Map<number, 'unqueried' | 'ok'>();
  const shortlist: number[] = [start];
  status.set(start, 'ok');
  const seed = tables.get(start);
  if (seed) for (const b of seed.buckets) for (const c of b) if (!status.has(c)) { status.set(c, 'unqueried'); shortlist.push(c); }

  const bySort = () =>
    shortlist.sort((a, b) => {
      const c = compareDist(target, a, b);
      return c !== 0 ? c : a - b;
    });

  let guard = 0;
  for (;;) {
    if (guard++ > 512) break;
    bySort();
    const okList = shortlist.filter((id) => status.get(id) === 'ok').slice(0, k);
    const bound = okList.length >= k ? xorDist(target, okList[k - 1]) : Infinity;
    const batch = shortlist
      .filter((id) => status.get(id) === 'unqueried' && id !== start && xorDist(target, id) < bound)
      .slice(0, alpha);
    if (batch.length === 0) break;
    for (const q of batch) {
      status.set(q, 'ok');
      const t = tables.get(q);
      if (!t) continue;
      for (const b of t.buckets) for (const c of b) if (!status.has(c)) { status.set(c, 'unqueried'); shortlist.push(c); }
    }
  }
  bySort();
  return shortlist.filter((id) => status.get(id) === 'ok').slice(0, k);
}

export function kademliaInvariants(nodes: ReadonlyArray<NodeView<KademliaState>>): InvariantResult[] {
  const live = nodes.filter((n) => n.up && n.state.joined);
  const liveIds = live.map((n) => n.state.id);
  const results: InvariantResult[] = [];

  // 1. k-bucket well-formedness — a genuine, always-on safety property. Every
  //    contact sits in the bucket its most-significant differing bit demands, no
  //    bucket exceeds k, no node stores itself, and no id is duplicated.
  {
    let bad = '';
    for (const n of live) {
      const s = n.state;
      const seen = new Set<number>();
      for (let b = 0; b < s.rt.buckets.length && !bad; b++) {
        const bucket = s.rt.buckets[b];
        if (bucket.length > s.k) bad = `${n.id}: bucket ${b} holds ${bucket.length} > k=${s.k}`;
        for (const c of bucket) {
          if (c === s.id) bad = `${n.id}: stores itself`;
          else if (bucketIndex(s.id, c) !== b) bad = `${n.id}: contact ${c} misfiled in bucket ${b} (belongs in ${bucketIndex(s.id, c)})`;
          else if (seen.has(c)) bad = `${n.id}: duplicate contact ${c}`;
          seen.add(c);
        }
      }
      if (bad) break;
    }
    results.push({
      name: 'k-bucket well-formedness',
      ok: bad === '',
      detail: bad === '' ? 'every contact filed by its high differing bit; no overflow, self or dupes' : bad,
    });
  }

  // 2. Tables cover the network (eventual) — for each node, every other live
  //    node's bucket is non-empty, so no peer is invisible in any direction.
  {
    let filled = 0;
    let total = 0;
    for (const n of live) {
      const s = n.state;
      const needed = new Set<number>();
      for (const t of liveIds) if (t !== s.id) needed.add(bucketIndex(s.id, t));
      for (const b of needed) {
        total++;
        if (s.rt.buckets[b] && s.rt.buckets[b].length > 0) filled++;
      }
    }
    const ok = total === 0 || filled === total;
    results.push({
      name: 'Routing tables cover the network',
      ok,
      detail: ok ? `every node has a contact toward every peer (${filled}/${total} buckets)` : `${filled}/${total} required buckets populated (refresh is healing)`,
    });
  }

  // 3. Iterative lookup finds the true k-closest (eventual, the headline). From
  //    every node, an offline replay of the α-parallel lookup for every live
  //    node id must return exactly the globally k-nearest nodes under XOR.
  {
    const tables = new Map<number, RoutingTable>();
    for (const n of live) tables.set(n.state.id, n.state.rt);
    const k = live[0]?.state.k ?? 4;
    const alpha = live[0]?.state.alpha ?? 3;
    let correct = 0;
    let total = 0;
    let bad = '';
    outer: for (const n of live) {
      for (const target of liveIds) {
        total++;
        const got = offlineClosest(tables, n.state.id, target, k, alpha);
        const want = kClosest(target, liveIds, k);
        if (got.length === want.length && got.every((x, i) => x === want[i])) correct++;
        else if (!bad) {
          bad = `${n.state.id}→${target}: got {${got.join(',')}}, true {${want.join(',')}}`;
          if (total > 4) break outer;
        }
      }
    }
    const ok = total > 0 && correct === total;
    results.push({
      name: 'Iterative lookup finds the true k-closest',
      ok,
      detail: ok ? `all ${total} (node, target) lookups resolve to the exact XOR-nearest k` : `${correct}/${total} lookups exact — ${bad} (healing)`,
    });
  }

  return results;
}
