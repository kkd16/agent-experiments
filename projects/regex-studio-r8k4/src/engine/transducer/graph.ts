// Adapter: an FST → the studio's generic GraphInput. Parallel edges between the
// same pair of states are merged into one, their `read:write` labels joined, so
// a one-state machine with many self-loops (e.g. ROT13) stays readable.

import type { GraphInput } from '../layout';
import type { FST } from './fst';

const sym = (s: string) => (s === '' ? 'ε' : s);

/** A `read:write` label, ε shown explicitly. */
export function edgeLabel(read: string, write: string): string {
  return `${sym(read)}:${sym(write)}`;
}

export function fstToGraph(fst: FST): GraphInput {
  const nodes = Array.from({ length: fst.states }, (_, id) => ({ id, label: String(id) }));
  const grouped = new Map<string, { from: number; to: number; labels: string[]; epsilon: boolean }>();
  for (const t of fst.trans) {
    const k = `${t.from}->${t.to}`;
    let g = grouped.get(k);
    if (!g) {
      g = { from: t.from, to: t.to, labels: [], epsilon: true };
      grouped.set(k, g);
    }
    g.labels.push(edgeLabel(t.read, t.write));
    if (t.read !== '') g.epsilon = false;
  }
  const edges = [...grouped.values()].map((g) => {
    const uniq = [...new Set(g.labels)];
    const shown = uniq.slice(0, 4).join(', ') + (uniq.length > 4 ? `, +${uniq.length - 4}` : '');
    return { from: g.from, to: g.to, label: shown, epsilon: g.epsilon };
  });
  return { nodes, edges, start: fst.start, accepts: new Set(fst.finals.keys()) };
}
