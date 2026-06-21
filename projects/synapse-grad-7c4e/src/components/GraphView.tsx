import { useMemo, useState } from 'react';
import { Tensor } from '../engine/tensor';
import type { TrainerHandle } from '../hooks/useTrainer';
import type { Activation } from '../engine/nn';

interface Props {
  handle: TrainerHandle;
  tick: number;
  selected: [number, number] | null;
}

type NodeKind = 'input' | 'weight' | 'op' | 'act';
interface VNode {
  id: number;
  label: string;
  value: number;
  grad: number;
  kind: NodeKind;
  depth: number;
  x: number;
  y: number;
}
interface VEdge {
  from: number;
  to: number;
}

const NODE_W = 88;
const NODE_H = 46;
const COL_GAP = 54;
const ROW_GAP = 16;

function applyAct(z: Tensor, act: Activation): Tensor {
  if (act === 'relu') return z.relu();
  if (act === 'tanh') return z.tanh();
  if (act === 'sigmoid') return z.sigmoid();
  return z;
}

const KIND_COLOR: Record<NodeKind, string> = {
  input: '#38bdf8',
  weight: '#fbbf24',
  op: '#94a3b8',
  act: '#a78bfa',
};

export default function GraphView({ handle, tick, selected }: Props) {
  const [unit, setUnit] = useState(0);
  const model = handle.model;
  const maxUnit = model ? model.layers[0].weight.cols - 1 : 0;
  const u = Math.min(unit, maxUnit);

  const layout = useMemo(() => {
    if (!model) return null;
    const layer0 = model.layers[0];
    const inputDim = layer0.weight.rows;
    const act = model.acts[0];
    const probe = selected ?? [0.3, 0.3];

    // Build a genuine little autograd graph for neuron (L1, unit u) on the probe point.
    const labels = new Map<number, { label: string; kind: NodeKind }>();
    const xs: Tensor[] = [];
    const products: Tensor[] = [];
    const sub = ['₀', '₁'];
    for (let i = 0; i < inputDim; i++) {
      const xi = Tensor.from([[probe[i] ?? 0]], true);
      const wi = Tensor.from([[layer0.weight.data[i * layer0.weight.cols + u]]], true);
      labels.set(xi.id, { label: `x${sub[i] ?? i}`, kind: 'input' });
      labels.set(wi.id, { label: `w${sub[i] ?? i}`, kind: 'weight' });
      const prod = xi.matmul(wi);
      labels.set(prod.id, { label: '×', kind: 'op' });
      xs.push(xi);
      products.push(prod);
    }
    let s = products[0];
    for (let i = 1; i < products.length; i++) {
      s = s.add(products[i]);
      labels.set(s.id, { label: '+', kind: 'op' });
    }
    const b = Tensor.from([[layer0.bias.data[u]]], true);
    labels.set(b.id, { label: 'b', kind: 'weight' });
    const z = s.add(b);
    labels.set(z.id, { label: 'Σ', kind: 'op' });
    const a = applyAct(z, act);
    labels.set(a.id, { label: act === 'linear' ? 'id' : act, kind: 'act' });
    a.backward();

    // topo + depth (longest path from any leaf)
    const order: Tensor[] = [];
    const seen = new Set<number>();
    const build = (t: Tensor) => {
      if (seen.has(t.id)) return;
      seen.add(t.id);
      for (const p of t.prev) build(p);
      order.push(t);
    };
    build(a);
    const depth = new Map<number, number>();
    for (const t of order) {
      let d = 0;
      for (const p of t.prev) d = Math.max(d, (depth.get(p.id) ?? 0) + 1);
      depth.set(t.id, d);
    }
    const maxDepth = Math.max(...order.map((t) => depth.get(t.id)!));
    const byDepth: Tensor[][] = Array.from({ length: maxDepth + 1 }, () => []);
    for (const t of order) byDepth[depth.get(t.id)!].push(t);

    const maxRows = Math.max(...byDepth.map((c) => c.length));
    const height = maxRows * (NODE_H + ROW_GAP) + ROW_GAP;
    const width = (maxDepth + 1) * (NODE_W + COL_GAP) + COL_GAP;

    const nodes: VNode[] = [];
    const idToNode = new Map<number, VNode>();
    for (let d = 0; d <= maxDepth; d++) {
      const col = byDepth[d];
      const colH = col.length * (NODE_H + ROW_GAP);
      const y0 = (height - colH) / 2;
      col.forEach((t, i) => {
        const meta = labels.get(t.id) ?? { label: t.op, kind: 'op' as NodeKind };
        const node: VNode = {
          id: t.id,
          label: meta.label,
          value: t.data[0],
          grad: t.grad[0],
          kind: meta.kind,
          depth: d,
          x: COL_GAP + d * (NODE_W + COL_GAP),
          y: y0 + i * (NODE_H + ROW_GAP) + ROW_GAP,
        };
        nodes.push(node);
        idToNode.set(t.id, node);
      });
    }
    const edges: VEdge[] = [];
    for (const t of order) for (const p of t.prev) edges.push({ from: p.id, to: t.id });

    return { nodes, edges, idToNode, width, height };
    // tick triggers recompute as weights change during training
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, selected, u, tick]);

  if (!model || !layout) return null;

  return (
    <div className="graph-view">
      <div className="graph-head">
        <span className="muted small">
          Autograd tape · neuron (L1, unit {u}) · probe ({(selected ?? [0.3, 0.3])[0].toFixed(2)},{' '}
          {(selected ?? [0.3, 0.3])[1].toFixed(2)})
        </span>
        <span className="unit-pick">
          <button onClick={() => setUnit(Math.max(0, u - 1))} disabled={u <= 0}>
            ◀
          </button>
          <button onClick={() => setUnit(Math.min(maxUnit, u + 1))} disabled={u >= maxUnit}>
            ▶
          </button>
        </span>
      </div>
      <div className="graph-scroll">
        <svg width={layout.width} height={layout.height} className="graph-svg">
          {layout.edges.map((e, i) => {
            const a = layout.idToNode.get(e.from)!;
            const b = layout.idToNode.get(e.to)!;
            const x1 = a.x + NODE_W;
            const y1 = a.y + NODE_H / 2;
            const x2 = b.x;
            const y2 = b.y + NODE_H / 2;
            const mx = (x1 + x2) / 2;
            return (
              <path
                key={i}
                d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="rgba(148,163,184,0.35)"
                strokeWidth={1.3}
              />
            );
          })}
          {layout.nodes.map((n) => (
            <g key={n.id} transform={`translate(${n.x},${n.y})`}>
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={8}
                fill="#0b1220"
                stroke={KIND_COLOR[n.kind]}
                strokeWidth={1.4}
              />
              <text x={8} y={16} className="g-label" fill={KIND_COLOR[n.kind]}>
                {n.label}
              </text>
              <text x={8} y={30} className="g-val">
                {n.value.toFixed(3)}
              </text>
              <text x={8} y={41} className="g-grad">
                ∂={n.grad.toFixed(3)}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </div>
  );
}
