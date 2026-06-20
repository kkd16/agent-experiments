// Adapters turning the automaton structures into the generic GraphInput the
// layout engine consumes.

import type { DFA } from './dfa';
import type { GraphInput } from './layout';
import type { NFA } from './nfa';

export function nfaToGraph(nfa: NFA): GraphInput {
  const nodes = Array.from({ length: nfa.stateCount }, (_, id) => ({ id, label: String(id) }));
  const edges = nfa.edges.map((e) => ({
    from: e.from,
    to: e.to,
    label: e.set ? e.set.label() : 'ε',
    epsilon: e.set === null,
  }));
  return { nodes, edges, start: nfa.start, accepts: new Set([nfa.accept]) };
}

export function dfaToGraph(dfa: DFA): GraphInput {
  const nodes = dfa.states.map((s) => ({ id: s.id, label: String(s.id) }));
  const edges = dfa.transitions.map((t) => ({
    from: t.from,
    to: t.to,
    label: t.set.label(),
    epsilon: false,
  }));
  const accepts = new Set(dfa.states.filter((s) => s.accept).map((s) => s.id));
  return { nodes, edges, start: dfa.start, accepts };
}
