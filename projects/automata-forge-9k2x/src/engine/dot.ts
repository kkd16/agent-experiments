// Emit Graphviz DOT for any automaton, straight from the renderer's GraphModel. Paste the result
// into Graphviz (or dot -Tpng) to get a publication-quality diagram of exactly what's on screen.

import type { GraphModel } from './types'

/** Escape a string for a DOT double-quoted label. */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

/**
 * Render a GraphModel as a `digraph`. Start state gets an incoming arrow from an invisible point;
 * accepting states are double circles; parallel transitions are already merged into one label.
 */
export function toDot(graph: GraphModel, name = 'automaton'): string {
  const lines: string[] = []
  lines.push(`digraph ${/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : 'automaton'} {`)
  lines.push('  rankdir=LR;')
  lines.push('  bgcolor="transparent";')
  lines.push('  node [shape=circle, fontname="Helvetica", fixedsize=true, width=0.6];')
  lines.push('  edge [fontname="Helvetica"];')
  lines.push('  __start__ [shape=point, width=0.12, color="#888888"];')

  for (let i = 0; i < graph.numStates; i++) {
    const shape = graph.accepting.has(i) ? 'doublecircle' : 'circle'
    const sub = graph.stateSub?.[i]
    const label = sub ? `${i}\\n${sub}` : `${i}`
    lines.push(`  q${i} [shape=${shape}, label="${esc(label)}"];`)
  }

  lines.push(`  __start__ -> q${graph.start};`)
  for (const e of graph.edges) {
    lines.push(`  q${e.from} -> q${e.to} [label="${esc(e.label)}"];`)
  }

  lines.push('}')
  return lines.join('\n')
}
