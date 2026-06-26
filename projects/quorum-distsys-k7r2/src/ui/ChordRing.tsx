// A purpose-built visualisation of a Chord ring: nodes placed on the circle by
// their identifier, successor pointers drawn as perimeter arcs, the selected
// node's finger table drawn as chords across the ring, sample keys placed at
// their hash position and tinted by their current owner, and the most recent
// lookup drawn as a glowing path of hops to the owner.
import { useMemo } from 'react';
import { ownerOf } from '../protocols/chord/ring';

export interface RingNode {
  name: string;
  id: number;
  up: boolean;
  joined: boolean;
  successor: number;
  predecessor: number | null;
  finger: number[];
}

interface Props {
  m: number;
  nodes: RingNode[];
  selected: string | null;
  onSelect: (name: string) => void;
  keys: number[];
  lookupPath: number[] | null;
  lookupKey: number | null;
  height?: number;
}

const NODE_FILL = '#7c9cff';
const NODE_SEL = '#73e08a';
const NODE_DOWN = '#3a3f4b';

export function ChordRing({ m, nodes, selected, onSelect, keys, lookupPath, lookupKey, height = 440 }: Props) {
  const SIZE = 1 << m;
  const W = 440;
  const H = height;
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) / 2 - 54;

  const live = nodes.filter((n) => n.up && n.joined);
  const liveIds = live.map((n) => n.id);

  const pos = (id: number, radius = R) => {
    const theta = (2 * Math.PI * id) / SIZE - Math.PI / 2;
    return { x: cx + radius * Math.cos(theta), y: cy + radius * Math.sin(theta) };
  };

  // A perimeter arc from a → b going clockwise (the short way along the ring).
  const arcPath = (a: number, b: number, radius = R) => {
    const pa = pos(a, radius);
    const pb = pos(b, radius);
    const delta = ((b - a + SIZE) % SIZE) / SIZE;
    const large = delta > 0.5 ? 1 : 0;
    // SVG sweep-flag 1 = clockwise in screen coords (y-down).
    return `M ${pa.x.toFixed(1)} ${pa.y.toFixed(1)} A ${radius} ${radius} 0 ${large} 1 ${pb.x.toFixed(1)} ${pb.y.toFixed(1)}`;
  };

  const selNode = selected ? nodes.find((n) => n.name === selected) : undefined;

  // Distinct finger targets for the selected node (skip self-fingers).
  const fingerTargets = useMemo(() => {
    if (!selNode) return [];
    const set = new Set<number>();
    for (const f of selNode.finger) if (f !== selNode.id) set.add(f);
    return [...set];
  }, [selNode]);

  const ownerColor = (key: number): string => {
    const owner = ownerOf(key, liveIds);
    if (owner === null) return '#5b6472';
    // Hue derived from owner id for a stable, distinct tint.
    const hue = (owner * 67) % 360;
    return `hsl(${hue} 70% 60%)`;
  };

  return (
    <div className="chord-ring">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ maxHeight: H }}>
        {/* ring backbone */}
        <circle cx={cx} cy={cy} r={R} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={2} />

        {/* successor pointers as clockwise perimeter arcs */}
        {live.map((n) => {
          if (n.successor === n.id) return null;
          const sel = selNode && (n.name === selNode.name);
          return (
            <path
              key={`succ-${n.id}`}
              d={arcPath(n.id, n.successor, R)}
              fill="none"
              stroke={sel ? 'rgba(115,224,138,0.9)' : 'rgba(124,156,255,0.35)'}
              strokeWidth={sel ? 3 : 2}
            />
          );
        })}

        {/* finger chords for the selected node */}
        {selNode &&
          fingerTargets.map((f) => {
            const a = pos(selNode.id);
            const b = pos(f);
            return <line key={`fin-${f}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="rgba(176,139,255,0.45)" strokeWidth={1.5} strokeDasharray="4 3" />;
          })}

        {/* most-recent lookup path */}
        {lookupPath && lookupPath.length > 1 && (
          <polyline
            points={lookupPath.map((id) => { const p = pos(id); return `${p.x.toFixed(1)},${p.y.toFixed(1)}`; }).join(' ')}
            fill="none"
            stroke="#ffd479"
            strokeWidth={2.5}
            strokeLinejoin="round"
            style={{ filter: 'drop-shadow(0 0 5px rgba(255,212,121,0.8))' }}
          />
        )}

        {/* sample keys on the rim, tinted by owner */}
        {keys.map((key) => {
          const p = pos(key, R + 16);
          const isLookup = lookupKey === key;
          return (
            <g key={`key-${key}`}>
              <circle cx={p.x} cy={p.y} r={isLookup ? 5 : 3.2} fill={ownerColor(key)} stroke={isLookup ? '#ffd479' : 'none'} strokeWidth={isLookup ? 2 : 0} />
            </g>
          );
        })}

        {/* nodes */}
        {nodes.map((n) => {
          const p = pos(n.id);
          const isSel = n.name === selected;
          const fill = !n.up ? NODE_DOWN : isSel ? NODE_SEL : NODE_FILL;
          return (
            <g key={n.name} onClick={() => onSelect(n.name)} style={{ cursor: 'pointer' }}>
              {isSel && <circle cx={p.x} cy={p.y} r={17} fill="none" stroke={NODE_SEL} strokeWidth={2} opacity={0.6} />}
              <circle cx={p.x} cy={p.y} r={13} fill={fill} stroke="rgba(0,0,0,0.4)" strokeWidth={1.5} opacity={n.up ? 1 : 0.5} />
              <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={12} fontWeight={700} fill="#0d1016">
                {n.name}
              </text>
              <text x={pos(n.id, R + 34).x} y={pos(n.id, R + 34).y + 4} textAnchor="middle" fontSize={10} fill="rgba(255,255,255,0.55)">
                {n.id}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
