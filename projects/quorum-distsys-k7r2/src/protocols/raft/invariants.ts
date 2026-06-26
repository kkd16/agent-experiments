// The Raft safety properties, checked across the whole cluster on every render.
// These are the guarantees the algorithm must NEVER violate, no matter what the
// network or the chaos driver does — if one ever shows red, Raft is broken.
//
// Care is taken so the checks are *exactly* Raft's guarantees and never raise a
// false alarm on legitimate transient states (e.g. a partitioned stale leader,
// or an uncommitted entry that will later be overwritten). Crashed nodes are not
// acting as leaders, so leader-related checks consider only live nodes.
import type { InvariantResult, NodeView } from '../../sim/types';
import type { RaftLogEntry, RaftState } from './types';

const sameEntry = (a: RaftLogEntry, b: RaftLogEntry) =>
  a.term === b.term && JSON.stringify(a.cmd) === JSON.stringify(b.cmd);

export function raftInvariants(nodes: ReadonlyArray<NodeView<RaftState>>): InvariantResult[] {
  const results: InvariantResult[] = [];
  const states = nodes.map((n) => n.state);
  const liveLeaders = nodes.filter((n) => n.up && n.state.role === 'leader');

  // 1. Election Safety — at most one (live) leader per term.
  {
    const leadersByTerm = new Map<number, string[]>();
    for (const n of liveLeaders) {
      const arr = leadersByTerm.get(n.state.currentTerm) ?? [];
      arr.push(n.id);
      leadersByTerm.set(n.state.currentTerm, arr);
    }
    const bad = [...leadersByTerm.entries()].filter(([, ids]) => ids.length > 1);
    results.push({
      name: 'Election Safety',
      ok: bad.length === 0,
      detail: bad.length ? `two leaders in term ${bad[0][0]}: ${bad[0][1].join(', ')}` : 'at most one leader per term',
    });
  }

  // 2. Log Matching — same (index, term) ⇒ identical prefix.
  {
    let violation = '';
    outer: for (let a = 0; a < states.length && !violation; a++) {
      for (let b = a + 1; b < states.length; b++) {
        const la = states[a].log;
        const lb = states[b].log;
        const m = Math.min(la.length, lb.length);
        let diverged = false;
        for (let i = 0; i < m; i++) {
          if (!sameEntry(la[i], lb[i])) diverged = true;
          else if (diverged && la[i].term === lb[i].term) {
            violation = `nodes ${nodes[a].id}/${nodes[b].id} share term ${la[i].term} at index ${i + 1} but diverge earlier`;
            break outer;
          }
        }
      }
    }
    results.push({
      name: 'Log Matching',
      ok: !violation,
      detail: violation || 'matching (index, term) implies identical history',
    });
  }

  // 3. State Machine Safety — committed entries never disagree across nodes.
  {
    let violation = '';
    outer: for (let a = 0; a < states.length && !violation; a++) {
      for (let b = a + 1; b < states.length; b++) {
        const commonCommitted = Math.min(states[a].commitIndex, states[b].commitIndex);
        for (let i = 0; i < commonCommitted; i++) {
          if (!sameEntry(states[a].log[i], states[b].log[i])) {
            violation = `committed index ${i + 1} differs between ${nodes[a].id} and ${nodes[b].id}`;
            break outer;
          }
        }
      }
    }
    results.push({
      name: 'State Machine Safety',
      ok: !violation,
      detail: violation || 'no two nodes apply different commands at the same index',
    });
  }

  // 4. Leader Completeness — the highest-term live leader holds every committed
  //    entry. (A lower-term partitioned "stale" leader is intentionally excluded:
  //    it is not required to have entries committed by a newer term's majority.)
  {
    const top = liveLeaders.slice().sort((a, b) => b.state.currentTerm - a.state.currentTerm)[0];
    let violation = '';
    if (top) {
      const maxCommitted = Math.max(0, ...states.map((s) => s.commitIndex));
      for (let i = 0; i < maxCommitted; i++) {
        const committedSomewhere = nodes.find((n) => n.state.commitIndex > i);
        if (!committedSomewhere) continue;
        const ref = committedSomewhere.state.log[i];
        const own = top.state.log[i];
        if (!own || !sameEntry(own, ref)) {
          violation = `leader ${top.id} (term ${top.state.currentTerm}) missing committed index ${i + 1}`;
          break;
        }
      }
    }
    results.push({
      name: 'Leader Completeness',
      ok: !violation,
      detail: violation || 'the current leader contains all committed entries',
    });
  }

  return results;
}
