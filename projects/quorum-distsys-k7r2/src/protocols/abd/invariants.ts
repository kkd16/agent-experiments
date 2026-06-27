// ABD safety invariants — a *live linearizability proof* for the register.
//
// Linearizability of a read/write register has a famous, checkable
// characterization (Lamport's atomic-register conditions): take every completed
// operation, give each a tag (a write's written tag; a read's returned tag), and
// require, for operations on the same key:
//
//   1. Real-time order is respected by tags. If op A finishes before op B starts
//      (they don't overlap), then tag(B) ≥ tag(A) — and strictly greater if B is
//      a write. This is the single condition that rules out a read going back in
//      time and forces writes into a global order consistent with real time.
//   2. Reads return the value of the write whose tag they carry (or the initial
//      value at ⊥). No read invents a value.
//   3. Every acknowledged write is durable: its value is still recoverable from a
//      majority right now, so it can never be lost.
//
// If all three hold on every render, however cruel the network, the register is
// linearizable — proven without ever building a serial order by hand.
import type { InvariantResult, NodeView } from '../../sim/types';
import { cmpTag, tagEq, tagStr, BOTTOM, type AbdState, type CompletedOp } from './types';

type View = NodeView<AbdState>;

/** All completed operations across the cluster, grouped by key. */
function historyByKey(views: ReadonlyArray<View>): Map<string, CompletedOp[]> {
  const byKey = new Map<string, CompletedOp[]>();
  for (const v of views) {
    for (const op of v.state.history) {
      (byKey.get(op.key) ?? byKey.set(op.key, []).get(op.key)!).push(op);
    }
  }
  return byKey;
}

export function abdInvariants(views: ReadonlyArray<View>): InvariantResult[] {
  const out: InvariantResult[] = [];
  const byKey = historyByKey(views);
  const N = views.length;
  const majority = Math.floor(N / 2) + 1;

  // 1. REAL-TIME ATOMICITY — for non-overlapping ops A ≺ B on a key, tag(B) ≥
  //    tag(A), strict when B is a write. This is the heart of linearizability.
  {
    let bad = '';
    outer1: for (const [key, ops] of byKey) {
      for (let i = 0; i < ops.length; i++) {
        for (let j = 0; j < ops.length; j++) {
          if (i === j) continue;
          const a = ops[i];
          const b = ops[j];
          if (a.finishedAt > b.startedAt) continue; // overlapping or a after b — no constraint
          const c = cmpTag(b.tag, a.tag);
          if (c < 0 || (b.kind === 'write' && c <= 0)) {
            bad = `key "${key}": ${opLabel(a)} precedes ${opLabel(b)} but tag ${tagStr(b.tag)} ${b.kind === 'write' ? '≤' : '<'} ${tagStr(a.tag)}`;
            break outer1;
          }
        }
      }
    }
    out.push({
      name: 'Real-time atomicity',
      ok: !bad,
      detail: bad ? `a later operation went back in time — ${bad}` : 'every non-overlapping operation respects tag order (no stale read, writes globally ordered)',
    });
  }

  // 2. READ INTEGRITY — every read returns the value of the write carrying its
  //    tag (or the initial value at ⊥). No read fabricates a value.
  {
    const tagValue = new Map<string, string>(); // key|tag → value, from writes
    for (const ops of byKey.values()) {
      for (const op of ops) if (op.kind === 'write') tagValue.set(op.key + '|' + tagStr(op.tag), op.value);
    }
    let bad = '';
    outer2: for (const [key, ops] of byKey) {
      for (const op of ops) {
        if (op.kind !== 'read') continue;
        if (tagEq(op.tag, BOTTOM)) {
          if (op.value !== '') {
            bad = `key "${key}": read returned "${op.value}" at ⊥ (should be the empty initial value)`;
            break outer2;
          }
          continue;
        }
        const written = tagValue.get(key + '|' + tagStr(op.tag));
        if (written === undefined) {
          // The matching write may have been pruned from history; only flag a real mismatch.
          continue;
        }
        if (written !== op.value) {
          bad = `key "${key}": read returned "${op.value}" at tag ${tagStr(op.tag)} but that tag wrote "${written}"`;
          break outer2;
        }
      }
    }
    out.push({
      name: 'Read integrity',
      ok: !bad,
      detail: bad ? bad : 'every read returns exactly the value written at the tag it carries',
    });
  }

  // 3. DURABILITY OF ACKNOWLEDGED WRITES — the highest committed-write tag per key
  //    is still held by a majority of replicas, so an acknowledged value is never
  //    lost (the quorum-intersection guarantee, witnessed live).
  {
    let bad = '';
    for (const [key, ops] of byKey) {
      let hi = BOTTOM;
      for (const op of ops) if (op.kind === 'write' && cmpTag(op.tag, hi) > 0) hi = op.tag;
      if (tagEq(hi, BOTTOM)) continue;
      let holders = 0;
      for (const v of views) {
        const reg = v.state.store[key];
        if (reg && cmpTag(reg.tag, hi) >= 0) holders++;
      }
      if (holders < majority) {
        bad = `key "${key}": newest acknowledged write ${tagStr(hi)} held by only ${holders}/${N} replicas (need ${majority})`;
        break;
      }
    }
    out.push({
      name: 'Write durability',
      ok: !bad,
      detail: bad ? bad : 'every acknowledged write is still recoverable from a majority — it cannot be lost',
    });
  }

  return out;
}

function opLabel(op: CompletedOp): string {
  return `${op.kind}(${op.key}${op.kind === 'write' ? '=' + op.value : '→' + (op.value || '∅')})`;
}
