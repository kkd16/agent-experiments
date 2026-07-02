// Ben-Or's safety properties, checked across the whole cluster on every render.
// Safety in Ben-Or is deterministic and unconditional (it never depends on the
// coin); only termination is probabilistic, so it is shown as a live gauge rather
// than an invariant.
import type { InvariantResult, NodeView } from '../../sim/types';
import type { BenOrState } from './types';

export function benorInvariants(nodes: ReadonlyArray<NodeView<BenOrState>>): InvariantResult[] {
  const results: InvariantResult[] = [];
  const decided = nodes.filter((n) => n.state.decided !== null);

  // 1. Agreement — no two replicas ever decide different values.
  {
    const values = new Set(decided.map((n) => n.state.decided));
    const ok = values.size <= 1;
    results.push({
      name: 'Agreement',
      ok,
      detail: ok
        ? decided.length
          ? `all ${decided.length} decided replicas chose ${[...values][0]}`
          : 'no decision yet'
        : `conflicting decisions: ${[...values].join(' vs ')}`,
    });
  }

  // 2. Validity — every decided value is the input bit of *some* replica (a value
  //    can't be invented; in particular a unanimous input is the only possible outcome).
  {
    const inputs = new Set(nodes.map((n) => n.state.input));
    const bad = decided.find((n) => !inputs.has(n.state.decided as 0 | 1));
    results.push({
      name: 'Validity',
      ok: !bad,
      detail: bad ? `decided ${bad.state.decided} which was no replica's input` : 'every decision was some replica’s input',
    });
  }

  // 3. Decision Stability — a decided replica has locked: its running estimate equals
  //    its decision, so it can only ever re-decide the same value.
  {
    const bad = decided.find((n) => n.state.estimate !== n.state.decided);
    results.push({
      name: 'Decision Locked',
      ok: !bad,
      detail: bad ? `${bad.id} decided ${bad.state.decided} but its estimate drifted to ${bad.state.estimate}` : 'decided replicas keep their value',
    });
  }

  return results;
}

/** A UI gauge: how far the cluster has progressed toward a unanimous decision. */
export function benorGauge(nodes: ReadonlyArray<NodeView<BenOrState>>): {
  decided: number;
  total: number;
  value: 0 | 1 | null;
  maxRound: number;
} {
  const decided = nodes.filter((n) => n.state.decided !== null);
  const value = decided.length ? (decided[0].state.decided as 0 | 1) : null;
  const maxRound = Math.max(0, ...nodes.map((n) => n.state.round));
  return { decided: decided.length, total: nodes.length, value, maxRound };
}
