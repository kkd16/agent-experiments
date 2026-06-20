import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import type { Layout, LaidOutEdge, LaidOutNode } from '../engine/layout';

interface Props {
  layout: Layout;
  highlight?: Set<number>;
  // Optional secondary highlight (e.g. the states reached this step).
  trail?: Set<number>;
  accent: string;
  emptyHint?: string;
}

interface View {
  scale: number;
  tx: number;
  ty: number;
}

const R = 22;

export function AutomatonGraph({ layout, highlight, trail, accent, emptyHint }: Props) {
  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 });
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const nodeById = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);

  const onWheel = (e: ReactWheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setView((v) => ({ ...v, scale: clamp(v.scale * factor, 0.3, 3) }));
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag.current) return;
    setView((v) => ({
      ...v,
      tx: drag.current!.tx + (e.clientX - drag.current!.x),
      ty: drag.current!.ty + (e.clientY - drag.current!.y),
    }));
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const reset = () => setView({ scale: 1, tx: 0, ty: 0 });
  const zoom = (f: number) => setView((v) => ({ ...v, scale: clamp(v.scale * f, 0.3, 3) }));

  const markerId = `arrow-${accent.replace(/[^a-z0-9]/gi, '')}`;

  return (
    <div className="graph-wrap">
      <div className="graph-toolbar">
        <button onClick={() => zoom(1.2)} title="Zoom in">＋</button>
        <button onClick={() => zoom(1 / 1.2)} title="Zoom out">－</button>
        <button onClick={reset} title="Reset view">⟳</button>
        <span className="graph-hint">drag to pan · scroll to zoom</span>
      </div>
      <svg
        className="graph-svg"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <defs>
          <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--edge)" />
          </marker>
          <marker id={`${markerId}-hot`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill={accent} />
          </marker>
          <marker id="start-tip" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)" />
          </marker>
        </defs>
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
          {layout.edges.map((e) => (
            <EdgePath
              key={`${e.from}->${e.to}`}
              edge={e}
              from={nodeById.get(e.from)!}
              to={nodeById.get(e.to)!}
              markerId={markerId}
              accent={accent}
              hot={!!highlight && highlight.has(e.from) && highlight.has(e.to)}
            />
          ))}
          {layout.nodes.map((n) => (
            <NodeCircle key={n.id} node={n} highlight={highlight?.has(n.id)} trail={trail?.has(n.id)} accent={accent} />
          ))}
        </g>
        {layout.nodes.length === 0 && (
          <text x="50%" y="50%" className="graph-empty" textAnchor="middle">
            {emptyHint ?? 'nothing to show'}
          </text>
        )}
      </svg>
    </div>
  );
}

function NodeCircle({
  node,
  highlight,
  trail,
  accent,
}: {
  node: LaidOutNode;
  highlight?: boolean;
  trail?: boolean;
  accent: string;
}) {
  return (
    <g className={`node${highlight ? ' node-hot' : ''}${trail ? ' node-trail' : ''}`}>
      {node.isStart && (
        <line
          x1={node.x - R - 26}
          y1={node.y}
          x2={node.x - R - 4}
          y2={node.y}
          className="start-arrow"
          markerEnd="url(#start-tip)"
        />
      )}
      <circle
        cx={node.x}
        cy={node.y}
        r={R}
        className="node-body"
        style={highlight ? { fill: accent, stroke: accent } : undefined}
      />
      {node.isAccept && <circle cx={node.x} cy={node.y} r={R - 4} className="node-accept-ring" />}
      <text x={node.x} y={node.y} className="node-label" textAnchor="middle" dominantBaseline="central">
        {node.label}
      </text>
    </g>
  );
}

function EdgePath({
  edge,
  from,
  to,
  markerId,
  accent,
  hot,
}: {
  edge: LaidOutEdge;
  from: LaidOutNode;
  to: LaidOutNode;
  markerId: string;
  accent: string;
  hot: boolean;
}) {
  const { d, lx, ly } = computePath(edge, from, to);
  return (
    <g className={`edge${edge.epsilon ? ' edge-eps' : ''}${hot ? ' edge-hot' : ''}`}>
      <path d={d} className="edge-line" markerEnd={`url(#${hot ? markerId + '-hot' : markerId})`} style={hot ? { stroke: accent } : undefined} />
      <g transform={`translate(${lx} ${ly})`}>
        <rect x={-labelWidth(edge.label) / 2} y={-9} width={labelWidth(edge.label)} height={18} rx={5} className="edge-label-bg" />
        <text className="edge-label" textAnchor="middle" dominantBaseline="central" style={hot ? { fill: accent } : undefined}>
          {edge.label}
        </text>
      </g>
    </g>
  );
}

function labelWidth(label: string): number {
  return Math.max(16, label.length * 7.2 + 8);
}

function computePath(edge: LaidOutEdge, from: LaidOutNode, to: LaidOutNode): { d: string; lx: number; ly: number } {
  if (edge.kind === 'self') {
    const x = from.x;
    const y = from.y;
    const d = `M ${x - 9} ${y - R + 2} C ${x - 34} ${y - R - 40}, ${x + 34} ${y - R - 40}, ${x + 9} ${y - R + 2}`;
    return { d, lx: x, ly: y - R - 34 };
  }
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;
  // Perpendicular offset so opposing edges and back-edges don't overlap.
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
  const d = `M ${sx} ${sy} Q ${mx} ${my} ${ex} ${ey}`;
  return { d, lx: mx, ly: my };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
