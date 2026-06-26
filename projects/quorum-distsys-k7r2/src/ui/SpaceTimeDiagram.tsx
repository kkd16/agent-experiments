// A space-time (process-time) diagram: one horizontal lane per node, events
// plotted along virtual time, and a diagonal arrow for every message from its
// send event to its receive event. Click two events to see whether one
// happened-before the other or they are concurrent.
import { useEffect, useRef, useState } from 'react';
import type { NodeId } from '../sim/types';
import type { VcEvent } from '../protocols/vclock/vclock';
import { nodeColor } from '../lib/format';

interface Props {
  events: VcEvent[];
  nodeOrder: NodeId[];
  selected: string[];
  onSelect: (id: string) => void;
}

const KIND_STROKE: Record<VcEvent['kind'], string> = {
  internal: '#9aa2b1',
  send: '#7c9cff',
  recv: '#8be9c0',
};

export function SpaceTimeDiagram({ events, nodeOrder, selected, onSelect }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(700);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => {
      for (const e of es) setW(Math.max(360, Math.floor(e.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const laneH = 52;
  const top = 18;
  const ml = 64;
  const mr = 24;
  const H = top * 2 + nodeOrder.length * laneH;
  const laneY = (id: NodeId) => top + nodeOrder.indexOf(id) * laneH + laneH / 2;

  const ts = events.map((e) => e.t);
  const minT = Math.min(0, ...ts);
  const maxT = Math.max(minT + 1, ...ts);
  const x = (t: number) => ml + ((t - minT) / (maxT - minT)) * (w - ml - mr);

  const byId = new Map(events.map((e) => [e.id, e]));

  return (
    <div className="stdiagram" ref={wrapRef}>
      <svg width={w} height={H} role="img">
        {/* lanes */}
        {nodeOrder.map((id, i) => (
          <g key={id}>
            <line x1={ml} y1={top + i * laneH + laneH / 2} x2={w - mr} y2={top + i * laneH + laneH / 2}
              stroke="rgba(120,130,150,0.18)" strokeWidth={1} />
            <text x={12} y={top + i * laneH + laneH / 2 + 4} fill={nodeColor(i)} fontWeight={700}
              fontSize={13} fontFamily="ui-monospace, monospace">
              {id}
            </text>
          </g>
        ))}

        {/* message arrows */}
        {events
          .filter((e) => e.kind === 'recv' && e.srcId && byId.has(e.srcId))
          .map((e) => {
            const src = byId.get(e.srcId!)!;
            const x1 = x(src.t);
            const y1 = laneY(src.node);
            const x2 = x(e.t);
            const y2 = laneY(e.node);
            return (
              <line key={`m${e.id}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(139,233,192,0.5)"
                strokeWidth={1.5} markerEnd="url(#arrow)" />
            );
          })}

        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="rgba(139,233,192,0.7)" />
          </marker>
        </defs>

        {/* events */}
        {events.map((e) => {
          const cx = x(e.t);
          const cy = laneY(e.node);
          const isSel = selected.includes(e.id);
          return (
            <circle key={e.id} cx={cx} cy={cy} r={isSel ? 8 : 5.5}
              fill={nodeColor(nodeOrder.indexOf(e.node))}
              stroke={isSel ? '#fff' : KIND_STROKE[e.kind]} strokeWidth={isSel ? 2.5 : 2}
              style={{ cursor: 'pointer' }} onClick={() => onSelect(e.id)}>
              <title>{`${e.id} (${e.kind})`}</title>
            </circle>
          );
        })}
      </svg>
    </div>
  );
}
