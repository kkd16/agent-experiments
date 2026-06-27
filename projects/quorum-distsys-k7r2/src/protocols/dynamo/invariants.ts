// Live correctness checks for the Dynamo store.
//
// Dynamo deliberately gives up linearizability, so the interesting question is
// *what does it still guarantee?* Two things, and they must hold no matter how
// cruel the network is:
//   • Causality — every stored value set is a clean antichain of vector clocks
//     (reconciliation never keeps a version that another strictly dominates).
//   • Durability — no write the system has acknowledged to a client is ever
//     lost: its causal fingerprint is always recoverable from the live data.
// Convergence (all replicas of a key agreeing) is an *eventual* property, not a
// safety one — it dips during a partition and heals — so it is reported
// separately as a gauge rather than asserted under chaos.
import type { InvariantResult, NodeView } from '../../sim/types';
import { buildRing, isHomeReplica } from './ring';
import {
  descends,
  mergeClocks,
  reconcile,
  versionSetEq,
  clockStr,
  valuesStr,
  type DynamoState,
  type VClock,
  type VersionSet,
} from './types';

type View = NodeView<DynamoState>;

/** The two genuine safety invariants — always green, even under chaos. */
export function dynamoInvariants(nodes: ReadonlyArray<View>): InvariantResult[] {
  return [causality(nodes), durability(nodes)];
}

function causality(nodes: ReadonlyArray<View>): InvariantResult {
  let checked = 0;
  for (const n of nodes) {
    const buckets: VersionSet[] = [];
    for (const key in n.state.store) buckets.push(n.state.store[key]);
    for (const target in n.state.hints) for (const key in n.state.hints[target]) buckets.push(n.state.hints[target][key]);
    for (const vs of buckets) {
      checked++;
      // Every stored set must equal its own reconciliation — i.e. it is already a
      // maximal antichain with no dominated leftovers.
      if (!versionSetEq(reconcile(vs), vs)) {
        return {
          name: 'Causality (sibling antichain)',
          ok: false,
          detail: `${n.id} kept a causally-dominated version: ${valuesStr(vs)} [${vs.map((v) => clockStr(v.clock)).join(' | ')}]`,
        };
      }
    }
  }
  return {
    name: 'Causality (sibling antichain)',
    ok: true,
    detail: `every stored value set is a clean vector-clock antichain (${checked} checked)`,
  };
}

function durability(nodes: ReadonlyArray<View>): InvariantResult {
  // Per key: the join of every clock the cluster has acknowledged to a client…
  const acked: Record<string, VClock> = {};
  for (const n of nodes) {
    for (const key in n.state.ackedFrontier) {
      acked[key] = mergeClocks(acked[key] ?? {}, n.state.ackedFrontier[key]);
    }
  }
  // …must be descended by the join of every clock still held somewhere on disk
  // (replicas + hints, on live OR crashed nodes — disk survives a reboot).
  const held: Record<string, VClock> = {};
  for (const n of nodes) {
    for (const key in n.state.store) for (const v of n.state.store[key]) held[key] = mergeClocks(held[key] ?? {}, v.clock);
    for (const t in n.state.hints) for (const key in n.state.hints[t]) for (const v of n.state.hints[t][key]) held[key] = mergeClocks(held[key] ?? {}, v.clock);
  }
  let keys = 0;
  for (const key in acked) {
    keys++;
    if (!descends(held[key] ?? {}, acked[key])) {
      return {
        name: 'Durability (no acked write lost)',
        ok: false,
        detail: `key "${key}": acked ⌈${clockStr(acked[key])}⌉ is not covered by held ⌈${clockStr(held[key] ?? {})}⌉`,
      };
    }
  }
  return {
    name: 'Durability (no acked write lost)',
    ok: true,
    detail: keys
      ? `all ${keys} acknowledged key(s) remain recoverable from the live data`
      : 'no writes acknowledged yet',
  };
}

/** Eventual-convergence gauge: do all up home-replicas of every key agree?
 *  Not a safety invariant — it is expected to dip during partitions. */
export function convergenceGauge(nodes: ReadonlyArray<View>): InvariantResult {
  const ring = buildRing(nodes.map((n) => n.id));
  const n = nodes[0]?.state.cfg.n ?? 3;
  const up = nodes.filter((v) => v.up);
  const keys = new Set<string>();
  for (const v of up) for (const k in v.state.store) keys.add(k);

  let firstBad = '';
  for (const key of keys) {
    const replicas = up.filter((v) => isHomeReplica(key, ring, n, v.id));
    if (replicas.length <= 1) continue;
    const sets = replicas.map((v) => reconcile(v.state.store[key] ?? []));
    const allEqual = sets.every((s) => versionSetEq(s, sets[0]));
    if (!allEqual && !firstBad) firstBad = `${key}: ${replicas.map((v) => `${v.id}=${valuesStr(reconcile(v.state.store[key] ?? []))}`).join(' vs ')}`;
  }
  const ok = firstBad === '';
  return {
    name: 'Convergence (eventual)',
    ok,
    detail: ok
      ? keys.size
        ? `all ${keys.size} key(s) agree across their reachable replicas`
        : 'no data yet'
      : `diverged — ${firstBad} (heals once anti-entropy drains)`,
  };
}
