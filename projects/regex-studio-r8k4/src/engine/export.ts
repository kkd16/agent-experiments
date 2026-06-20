// Export an automaton as Graphviz DOT so it can be rendered, embedded or
// shared outside the app. Driven by the same GraphInput the layout engine uses.
//
// Also exports a self-contained, styled **SVG** built straight from the laid-out
// graph — a portable vector you can drop into a slide deck or paper without a
// Graphviz install. It mirrors the on-screen diagram's geometry.

import type { GraphInput, LaidOutEdge, LaidOutNode, Layout } from './layout';

function escapeLabel(label: string): string {
  return label.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

// --- Standalone SVG --------------------------------------------------------

const R = 22;

// Recompute one edge's path + label anchor — a trimmed copy of the renderer's
// geometry so the exported vector matches what's on screen.
function edgePath(edge: LaidOutEdge, from: LaidOutNode, to: LaidOutNode): { d: string; lx: number; ly: number } {
  if (edge.kind === 'self') {
    const x = from.x;
    const y = from.y;
    return { d: `M ${x - 9} ${y - R + 2} C ${x - 34} ${y - R - 40}, ${x + 34} ${y - R - 40}, ${x + 9} ${y - R + 2}`, lx: x, ly: y - R - 34 };
  }
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;
  let curve = edge.kind === 'forward' ? 0 : 26;
  if (edge.hasReverse) curve = Math.max(curve, 22);
  const sign = edge.hasReverse ? (edge.from < edge.to ? 1 : -1) : edge.kind === 'back' ? 1 : -1;
  const offset = curve * sign;
  const sx = from.x + ux * R;
  const sy = from.y + uy * R;
  const ex = to.x - ux * R;
  const ey = to.y - uy * R;
  const mx = (sx + ex) / 2 - uy * offset;
  const my = (sy + ey) / 2 + ux * offset;
  return { d: `M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`, lx: mx, ly: my };
}

export function toSvg(layout: Layout, opts: { accent?: string } = {}): string {
  const accent = opts.accent ?? '#60a5fa';
  const nodeById = new Map(layout.nodes.map((n) => [n.id, n]));
  const pad = 8;
  const w = layout.width + pad * 2;
  const h = layout.height + pad * 2;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="ui-monospace, monospace">`);
  parts.push(
    `<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#64748b"/></marker></defs>`,
  );
  parts.push(`<rect width="${w}" height="${h}" fill="#0b1020"/>`);
  parts.push(`<g transform="translate(${pad} ${pad})">`);

  for (const e of layout.edges) {
    const from = nodeById.get(e.from);
    const to = nodeById.get(e.to);
    if (!from || !to) continue;
    const { d, lx, ly } = edgePath(e, from, to);
    const stroke = e.epsilon ? '#475569' : '#64748b';
    const dash = e.epsilon ? ' stroke-dasharray="4 3"' : '';
    parts.push(`<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1.5"${dash} marker-end="url(#arr)"/>`);
    const lw = Math.max(16, e.label.length * 7.2 + 8);
    parts.push(`<rect x="${lx - lw / 2}" y="${ly - 9}" width="${lw}" height="18" rx="5" fill="#0b1020" opacity="0.92"/>`);
    parts.push(`<text x="${lx}" y="${ly}" fill="#cbd5e1" font-size="11" text-anchor="middle" dominant-baseline="central">${xmlEscape(e.label)}</text>`);
  }

  for (const n of layout.nodes) {
    if (n.isStart) {
      parts.push(`<line x1="${n.x - R - 26}" y1="${n.y}" x2="${n.x - R - 4}" y2="${n.y}" stroke="#64748b" stroke-width="1.5" marker-end="url(#arr)"/>`);
    }
    parts.push(`<circle cx="${n.x}" cy="${n.y}" r="${R}" fill="#11182e" stroke="${accent}" stroke-width="1.6"/>`);
    if (n.isAccept) parts.push(`<circle cx="${n.x}" cy="${n.y}" r="${R - 4}" fill="none" stroke="${accent}" stroke-width="1.4"/>`);
    parts.push(`<text x="${n.x}" y="${n.y}" fill="#e2e8f0" font-size="13" text-anchor="middle" dominant-baseline="central">${xmlEscape(n.label)}</text>`);
  }

  parts.push('</g></svg>');
  return parts.join('\n');
}
