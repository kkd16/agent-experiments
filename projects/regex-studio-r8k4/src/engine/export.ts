// Export an automaton as Graphviz DOT so it can be rendered, embedded or
// shared outside the app. Driven by the same GraphInput the layout engine uses.

import type { GraphInput } from './layout';

function escapeLabel(label: string): string {
  return label.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function toDot(input: GraphInput, name = 'Automaton'): string {
  const lines: string[] = [];
  lines.push(`digraph ${name.replace(/[^A-Za-z0-9_]/g, '_')} {`);
  lines.push('  rankdir=LR;');
  lines.push('  bgcolor="transparent";');
  lines.push('  node [shape=circle, fontname="monospace"];');
  lines.push('  edge [fontname="monospace"];');
  lines.push('  __start [shape=point, width=0.12];');

  for (const n of input.nodes) {
    if (input.accepts.has(n.id)) lines.push(`  ${n.id} [shape=doublecircle];`);
  }
  lines.push(`  __start -> ${input.start};`);

  // Merge parallel edges into one label, mirroring the on-screen graph.
  const merged = new Map<string, { from: number; to: number; labels: Set<string> }>();
  for (const e of input.edges) {
    const key = `${e.from}->${e.to}`;
    const acc = merged.get(key) ?? { from: e.from, to: e.to, labels: new Set<string>() };
    acc.labels.add(e.label);
    merged.set(key, acc);
  }
  for (const e of merged.values()) {
    const label = escapeLabel([...e.labels].join(', '));
    lines.push(`  ${e.from} -> ${e.to} [label="${label}"];`);
  }

  lines.push('}');
  return lines.join('\n');
}
