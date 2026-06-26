// Chord ring-health checks. Unlike consensus safety, Chord's pointer correctness
// is an *eventual* property: stabilization heals the ring after every join or
// failure. So "Identifier uniqueness" is a true always-on safety invariant,
// while "Successor/Predecessor converged" are convergence gauges — they may dip
// during churn and then return to green as the ring heals (that *is* the lesson).
import type { InvariantResult, NodeView } from '../../sim/types';
import type { ChordState } from './types';
import { successorOf } from './ring';

export function chordInvariants(nodes: ReadonlyArray<NodeView<ChordState>>): InvariantResult[] {
  const live = nodes.filter((n) => n.up && n.state.joined);
  const liveIds = live.map((n) => n.state.id);
  const results: InvariantResult[] = [];

  // 1. Identifier uniqueness — a genuine, always-on safety property.
  {
    const seen = new Set<number>();
    let dup = -1;
    for (const id of liveIds) {
      if (seen.has(id)) dup = id;
      seen.add(id);
    }
    results.push({
      name: 'Identifier uniqueness',
      ok: dup < 0,
      detail: dup < 0 ? 'every node holds a distinct ring id' : `two nodes share ring id ${dup}`,
    });
  }

  // 2. Successor pointers converged (eventual).
  {
    let correct = 0;
    for (const n of live) {
      const trueSucc = successorOf(n.state.id, liveIds);
      if ((n.state.successorList[0] ?? n.state.id) === trueSucc) correct++;
    }
    const ok = correct === live.length;
    results.push({
      name: 'Successor ring converged',
      ok,
      detail: ok
        ? `all ${live.length} successors correct — one clean cycle`
        : `${correct}/${live.length} successors correct (stabilization is healing the ring)`,
    });
  }

  // 3. Predecessor pointers converged (eventual). The correct predecessor of a
  //    node is whoever's successor it should be.
  {
    const sorted = [...liveIds].sort((a, b) => a - b);
    const truePred = (id: number): number => {
      const i = sorted.indexOf(id);
      if (sorted.length <= 1) return id;
      return sorted[(i - 1 + sorted.length) % sorted.length];
    };
    let correct = 0;
    for (const n of live) {
      if (n.state.predecessor !== null && n.state.predecessor === truePred(n.state.id)) correct++;
    }
    const ok = correct === live.length;
    results.push({
      name: 'Predecessor pointers converged',
      ok,
      detail: ok ? `all ${live.length} predecessors correct` : `${correct}/${live.length} predecessors correct (healing)`,
    });
  }

  return results;
}
