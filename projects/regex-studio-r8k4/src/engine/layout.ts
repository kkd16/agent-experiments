// A small layered graph layout for the automaton diagrams. States are assigned
// to columns by their BFS distance from the start state and stacked within each
// column; the renderer turns the classified edges into curved SVG paths.

export interface GraphNode {
  id: number;
  label: string; // text shown inside the state circle
}

export interface GraphEdge {
  from: number;
  to: number;
  label: string;
  epsilon: boolean;
}

export interface GraphInput {
  nodes: GraphNode[];
  edges: GraphEdge[];
  start: number;
  accepts: Set<number>;
}

export type EdgeKind = 'self' | 'forward' | 'back' | 'flat';

export interface LaidOutNode extends GraphNode {
  x: number;
  y: number;
  layer: number;
  isStart: boolean;
  isAccept: boolean;
}

export interface LaidOutEdge extends GraphEdge {
  kind: EdgeKind;
  hasReverse: boolean;
}

export interface Layout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
  nodeRadius: number;
}

const H_GAP = 130;
const V_GAP = 84;
const MARGIN_X = 70;
const MARGIN_Y = 56;
const NODE_RADIUS = 22;

export function layoutGraph(input: GraphInput): Layout {
  const ids = input.nodes.map((n) => n.id);
  const byId = new Map(input.nodes.map((n) => [n.id, n]));

  // Merge parallel edges (same from→to) into a single labelled edge.
  const merged = new Map<string, GraphEdge>();
  for (const e of input.edges) {
    const key = `${e.from}->${e.to}`;
    const prev = merged.get(key);
    if (prev) {
      const labels = new Set(prev.label.split(', ').concat(e.label.split(', ')));
      prev.label = [...labels].join(', ');
      prev.epsilon = prev.epsilon || e.epsilon;
    } else {
      merged.set(key, { ...e });
    }
  }
  const edges = [...merged.values()];
  const edgeKeys = new Set(edges.map((e) => `${e.from}->${e.to}`));

  // BFS layering from the start state.
  const adj = new Map<number, number[]>();
  for (const id of ids) adj.set(id, []);
  for (const e of edges) if (e.from !== e.to) adj.get(e.from)?.push(e.to);

  const layer = new Map<number, number>();
  const queue: number[] = [];
  if (byId.has(input.start)) {
    layer.set(input.start, 0);
    queue.push(input.start);
  }
  while (queue.length) {
    const s = queue.shift()!;
    const ls = layer.get(s)!;
    for (const t of adj.get(s) ?? []) {
      if (!layer.has(t)) {
        layer.set(t, ls + 1);
        queue.push(t);
      }
    }
  }
  // Any node unreachable from start (shouldn't happen) lands in the last column.
  let maxLayer = 0;
  for (const l of layer.values()) maxLayer = Math.max(maxLayer, l);
  for (const id of ids) if (!layer.has(id)) layer.set(id, maxLayer + 1);

  // Group nodes by layer, ordered by id for stability.
  const byLayer = new Map<number, number[]>();
  for (const id of ids) {
    const l = layer.get(id)!;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l)!.push(id);
  }
  for (const arr of byLayer.values()) arr.sort((a, b) => a - b);

  const layers = [...byLayer.keys()].sort((a, b) => a - b);
  const maxRows = Math.max(1, ...[...byLayer.values()].map((a) => a.length));

  const pos = new Map<number, { x: number; y: number }>();
  for (const l of layers) {
    const col = byLayer.get(l)!;
    const colHeight = (col.length - 1) * V_GAP;
    const totalHeight = (maxRows - 1) * V_GAP;
    const offset = (totalHeight - colHeight) / 2;
    col.forEach((id, row) => {
      pos.set(id, { x: MARGIN_X + l * H_GAP, y: MARGIN_Y + offset + row * V_GAP });
    });
  }

  const nodes: LaidOutNode[] = ids.map((id) => {
    const p = pos.get(id)!;
    const n = byId.get(id)!;
    return {
      ...n,
      x: p.x,
      y: p.y,
      layer: layer.get(id)!,
      isStart: id === input.start,
      isAccept: input.accepts.has(id),
    };
  });

  const laidEdges: LaidOutEdge[] = edges.map((e) => {
    let kind: EdgeKind;
    if (e.from === e.to) kind = 'self';
    else {
      const lf = layer.get(e.from)!;
      const lt = layer.get(e.to)!;
      kind = lt > lf ? 'forward' : lt < lf ? 'back' : 'flat';
    }
    return { ...e, kind, hasReverse: edgeKeys.has(`${e.to}->${e.from}`) };
  });

  const width = MARGIN_X * 2 + (layers.length ? layers[layers.length - 1] : 0) * H_GAP;
  const height = MARGIN_Y * 2 + (maxRows - 1) * V_GAP;

  return { nodes, edges: laidEdges, width: Math.max(width, 240), height: Math.max(height, 180), nodeRadius: NODE_RADIUS };
}
