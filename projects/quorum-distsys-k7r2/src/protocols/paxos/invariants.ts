// The Paxos safety properties, checked across the whole cluster on every render.
//
// Paxos rests on a single theorem — *at most one value is ever chosen per slot*
// — and these checks are its live witnesses. They must NEVER go red, however
// cruel the network or the chaos driver is. Crashed nodes are still counted:
// their acceptor state is stable storage and remains part of the proof.
import type { InvariantResult, NodeView } from '../../sim/types';
import { valueEq, valueStr, type PaxosState, type PaxosValue } from './types';

const majority = (n: number) => Math.floor(n / 2) + 1;

export function paxosInvariants(nodes: ReadonlyArray<NodeView<PaxosState>>): InvariantResult[] {
  const results: InvariantResult[] = [];
  const states = nodes.map((n) => n.state);
  const N = nodes.length;

  // Every slot index any node has an opinion about.
  const allSlots = new Set<number>();
  for (const s of states) {
    for (const k of Object.keys(s.chosen)) allSlots.add(Number(k));
    for (const k of Object.keys(s.slots)) allSlots.add(Number(k));
  }

  // 1. AGREEMENT — no two nodes ever hold different chosen values for one slot.
  {
    let bad = '';
    for (const slot of allSlots) {
      let v: PaxosValue | undefined;
      for (const s of states) {
        const c = s.chosen[slot];
        if (c === undefined) continue;
        if (v === undefined) v = c;
        else if (!valueEq(v, c)) {
          bad = `slot ${slot}: "${valueStr(v)}" vs "${valueStr(c)}"`;
          break;
        }
      }
      if (bad) break;
    }
    results.push({
      name: 'Agreement',
      ok: !bad,
      detail: bad ? `two learners disagree on a chosen value — ${bad}` : 'all learners agree on every chosen slot',
    });
  }

  // 2. QUORUM-BACKING — a chosen value is held (accepted) by a strict majority of
  //    acceptors *right now*. Two different values would each need their own
  //    majority, and two majorities of N nodes must intersect — so this being
  //    true at every instant is the live proof a chosen value can't be replaced.
  {
    let bad = '';
    for (const slot of allSlots) {
      // What value is chosen here (per any learner)?
      let chosen: PaxosValue | undefined;
      for (const s of states) {
        if (s.chosen[slot] !== undefined) {
          chosen = s.chosen[slot];
          break;
        }
      }
      if (chosen === undefined) continue;
      let holders = 0;
      for (const s of states) {
        const sl = s.slots[slot];
        if (sl && valueEq(sl.acceptedValue, chosen)) holders++;
      }
      if (holders < majority(N)) {
        bad = `slot ${slot} chosen "${valueStr(chosen)}" but only ${holders}/${N} acceptors hold it`;
        break;
      }
    }
    results.push({
      name: 'Quorum-backing of chosen values',
      ok: !bad,
      detail: bad ? bad : 'every chosen value is still accepted by a majority — it cannot be overwritten',
    });
  }

  // 3. REPLICATED-LOG INTEGRITY — each node's applied watermark covers a gapless
  //    chosen prefix, and its KV is exactly that prefix replayed. (Internal
  //    state-machine correctness: no node applies past a hole or diverges.)
  {
    let bad = '';
    for (const n of nodes) {
      const s = n.state;
      const replay: Record<string, string> = {};
      for (let i = 1; i <= s.applied; i++) {
        const v = s.chosen[i];
        if (v === undefined) {
          bad = `${n.id}: applied=${s.applied} but slot ${i} is not chosen (a gap)`;
          break;
        }
        if (v.op === 'set') replay[v.key] = v.value;
        else if (v.op === 'del') delete replay[v.key];
      }
      if (bad) break;
      if (JSON.stringify(replay) !== JSON.stringify(s.kv)) {
        bad = `${n.id}: KV does not match its chosen prefix replay`;
        break;
      }
    }
    results.push({
      name: 'Replicated-log integrity',
      ok: !bad,
      detail: bad ? bad : 'every node applied a gapless chosen prefix; KV = prefix replayed',
    });
  }

  return results;
}
