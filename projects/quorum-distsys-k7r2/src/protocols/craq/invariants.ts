// CRAQ safety invariants — a live linearizability proof for the chain.
//
// Chain Replication emulates a linearizable read/write register per key, so it
// admits exactly the same checkable characterization the ABD lab uses (Lamport's
// atomic-register conditions), but with the per-key **committed version number**
// playing the role of the tag — there is no need for a (seq, node) tie-break
// because the head serializes all writes, so versions are already a total order:
//
//   1. REAL-TIME ATOMICITY. For two completed, non-overlapping ops A ≺ B on a key,
//      ver(B) ≥ ver(A), strictly greater when B is a write. This is the single
//      condition that forbids a read going back in time and pins writes to a global
//      order consistent with real time — the heart of linearizability.
//   2. READ INTEGRITY. Every read returns the value the write at its version wrote
//      (or the empty value at version 0). No read fabricates a value.
//   3. CHAIN CONSISTENCY (no fork). Every replica agrees on the value of every
//      *committed* version — there is one committed history, never two. (Only clean
//      versions are compared: a dirty/orphaned version a crashed head never
//      committed is allowed to be reused, exactly as the protocol intends.)
//
// (1) and (2) are evaluated over the real operation history the cluster produced;
// (3) is a structural "right now" check over the replicas' stores. Together they
// witness, live and however cruel the faults, that the chain is linearizable.
import type { InvariantResult, NodeView } from '../../sim/types';
import { tailOf, valueAt, committedValue, isDirty, type CraqState, type CompletedOp } from './types';

type View = NodeView<CraqState>;

const replicasOf = (views: ReadonlyArray<View>) => views.filter((v) => v.state.role === 'replica');

/** All completed operations across the cluster, de-duplicated by id, by key. */
function historyByKey(views: ReadonlyArray<View>): Map<string, CompletedOp[]> {
  const seen = new Set<string>();
  const byKey = new Map<string, CompletedOp[]>();
  for (const v of views) {
    for (const op of v.state.history) {
      if (seen.has(op.id)) continue;
      seen.add(op.id);
      (byKey.get(op.key) ?? byKey.set(op.key, []).get(op.key)!).push(op);
    }
  }
  return byKey;
}

function opLabel(op: CompletedOp): string {
  return `${op.kind}(${op.key}${op.kind === 'write' ? '=' + op.value : '→' + (op.value || '∅')})@v${op.ver}`;
}

export function craqInvariants(views: ReadonlyArray<View>): InvariantResult[] {
  const out: InvariantResult[] = [];
  const byKey = historyByKey(views);

  // 1. REAL-TIME ATOMICITY — non-overlapping ops respect version order.
  {
    let bad = '';
    outer1: for (const [key, ops] of byKey) {
      for (let i = 0; i < ops.length; i++) {
        for (let j = 0; j < ops.length; j++) {
          if (i === j) continue;
          const a = ops[i];
          const b = ops[j];
          if (a.finishedAt > b.startedAt) continue; // overlapping or a-after-b ⇒ no constraint
          if (b.ver < a.ver || (b.kind === 'write' && b.ver <= a.ver)) {
            bad = `key "${key}": ${opLabel(a)} precedes ${opLabel(b)} but v${b.ver} ${b.kind === 'write' ? '≤' : '<'} v${a.ver}`;
            break outer1;
          }
        }
      }
    }
    out.push({
      name: 'Real-time atomicity',
      ok: !bad,
      detail: bad
        ? `a later operation went back in time — ${bad}`
        : 'every non-overlapping operation respects committed-version order (no stale read; writes globally ordered)',
    });
  }

  // 2. READ INTEGRITY — reads return the value committed at their version.
  {
    const written = new Map<string, string>(); // key|ver → value, from writes
    for (const ops of byKey.values()) for (const op of ops) if (op.kind === 'write') written.set(op.key + '|' + op.ver, op.value);
    let bad = '';
    outer2: for (const [key, ops] of byKey) {
      for (const op of ops) {
        if (op.kind !== 'read') continue;
        if (op.ver === 0) {
          if (op.value !== '') {
            bad = `key "${key}": read returned "${op.value}" at v0 (should be the empty initial value)`;
            break outer2;
          }
          continue;
        }
        const w = written.get(key + '|' + op.ver);
        if (w === undefined) continue; // matching write may have been pruned from history
        if (w !== op.value) {
          bad = `key "${key}": read returned "${op.value}" at v${op.ver} but that version wrote "${w}"`;
          break outer2;
        }
      }
    }
    out.push({
      name: 'Read integrity',
      ok: !bad,
      detail: bad ? bad : 'every read returns exactly the value committed at the version it carries',
    });
  }

  // 3. CHAIN CONSISTENCY (no fork) — all replicas agree on every committed version.
  {
    const reps = replicasOf(views);
    let bad = '';
    const byKeyVer = new Map<string, { value: string; who: string }>();
    outer3: for (const v of reps) {
      const st = v.state;
      for (const key of Object.keys(st.store)) {
        const ksv = st.store[key];
        for (const ver of ksv.versions) {
          if (ver.ver > ksv.committed) continue; // compare committed (clean) versions only
          const k = key + '|' + ver.ver;
          const prev = byKeyVer.get(k);
          if (prev && prev.value !== ver.value) {
            bad = `key "${key}" v${ver.ver}: ${prev.who} committed "${prev.value}" but ${v.id} committed "${ver.value}"`;
            break outer3;
          }
          if (!prev) byKeyVer.set(k, { value: ver.value, who: v.id });
        }
      }
    }
    out.push({
      name: 'Chain consistency (no fork)',
      ok: !bad,
      detail: bad ? bad : 'every replica agrees on the value of every committed version — one history, never forked',
    });
  }

  return out;
}

/** A small live gauge for the UI: chain shape and CRAQ read split. */
export function craqGauge(views: ReadonlyArray<View>): {
  chain: string[];
  epoch: number;
  cleanReads: number;
  dirtyReads: number;
  dirtyKeys: number;
} {
  const reps = replicasOf(views);
  // The freshest config any replica holds (highest epoch) describes the chain.
  let best = reps[0]?.state.config ?? { epoch: 0, chain: [] };
  for (const v of reps) if (v.state.config.epoch > best.epoch) best = v.state.config;
  let cleanReads = 0,
    dirtyReads = 0;
  for (const v of reps) {
    cleanReads += v.state.cleanReads;
    dirtyReads += v.state.dirtyReads;
  }
  const tail = tailOf(best);
  let dirtyKeys = 0;
  const tv = reps.find((v) => v.id === tail);
  if (tv) for (const key of Object.keys(tv.state.store)) if (isDirty(tv.state.store[key])) dirtyKeys++;
  return { chain: best.chain, epoch: best.epoch, cleanReads, dirtyReads, dirtyKeys };
}

// Re-exported for the lab's per-replica table.
export { valueAt, committedValue, isDirty };
