// The Nakamoto lab's signature picture: the block *tree*, not a single chain.
//
// Blocks are placed by height (column) and branch (row). The heaviest chain —
// the one every honest node adopts — runs along the top in green, deepening to a
// solid "finalised" green once a block is k confirmations deep. Blocks that lost
// the race sit below as faded orphans, still linked to their parent. An
// attacker's withheld private chain is drawn as an amber dashed branch, so you
// can literally watch a secret chain grow past the public one and then, on
// release, swallow it — reverting the payment that was buried in the orphaned
// branch.
import { useMemo } from 'react';
import { chainOf, shortHash, type Block } from '../protocols/nakamoto/types';

interface Props {
  blocks: Record<string, Block>;
  tip: string;
  /** An attacker's withheld secret blocks (drawn dashed amber), if any. */
  hidden?: Record<string, Block>;
  /** Confirmation depth — blocks this deep render as finalised. */
  k: number;
  /** A tx tag to spotlight (e.g. the double-spend), drawn with a badge. */
  spotlight?: string;
  title?: string;
}

const BW = 70;
const BH = 40;
const GX = 26;
const GY = 20;
const PAD = 16;
const TOP = 26;
const WINDOW = 16;

type Kind = 'final' | 'confirmed' | 'orphan' | 'secret';
const COLOR: Record<Kind, string> = {
  final: '#4bd07a',
  confirmed: '#5bd6c8',
  orphan: '#6b7280',
  secret: '#ffb454',
};

export function BlockTree({ blocks, tip, hidden, k, spotlight, title = 'Block tree' }: Props) {
  const model = useMemo(() => {
    const union: Record<string, Block> = { ...blocks };
    const secret = new Set<string>();
    if (hidden) for (const h of Object.keys(hidden)) {
      union[h] = hidden[h];
      secret.add(h);
    }
    const canonical = new Set(chainOf(blocks, tip).map((b) => b.hash));
    const tipH = union[tip]?.height ?? 0;
    const allH = Object.values(union).map((b) => b.height);
    const maxH = allH.length ? Math.max(...allH) : 0;
    const minShown = Math.max(0, maxH - WINDOW);

    const shown = Object.values(union)
      .filter((b) => b.height >= minShown)
      .sort((a, b) => a.height - b.height || (a.hash < b.hash ? -1 : 1));

    // Assign a row to each block: the canonical chain on row 0, forks below.
    const rowOf = new Map<string, number>();
    const occupied = new Set<string>();
    const key = (h: number, r: number) => `${h}:${r}`;
    for (const b of shown) {
      let r: number;
      if (canonical.has(b.hash) || b.hash === 'genesis') r = 0;
      else {
        const pr = rowOf.get(b.parent) ?? 0;
        r = Math.max(1, pr);
        while (occupied.has(key(b.height, r))) r++;
      }
      while (occupied.has(key(b.height, r))) r++;
      occupied.add(key(b.height, r));
      rowOf.set(b.hash, r);
    }

    const maxRow = Math.max(0, ...[...rowOf.values()]);
    const x = (h: number) => PAD + (h - minShown) * (BW + GX);
    const y = (r: number) => TOP + r * (BH + GY);

    const kindOf = (b: Block): Kind => {
      if (secret.has(b.hash)) return 'secret';
      if (!canonical.has(b.hash)) return 'orphan';
      return tipH - b.height >= k ? 'final' : 'confirmed';
    };

    const nodes = shown.map((b) => ({
      b,
      x: x(b.height),
      y: y(rowOf.get(b.hash) ?? 0),
      kind: kindOf(b),
      spot: !!spotlight && b.txs.some((t) => t.tag === spotlight),
    }));
    const pos = new Map(nodes.map((n) => [n.b.hash, n]));
    const edges = nodes
      .filter((n) => pos.has(n.b.parent))
      .map((n) => ({ from: pos.get(n.b.parent)!, to: n }));

    const width = PAD * 2 + (maxH - minShown + 1) * (BW + GX);
    const height = TOP + (maxRow + 1) * (BH + GY) + 12;
    return { nodes, edges, width: Math.max(width, 320), height: Math.max(height, 120), tipH, empty: nodes.length === 0 };
  }, [blocks, tip, hidden, k, spotlight]);

  return (
    <div className="depgraph">
      <div className="panel-head">
        <span>{title}</span>
        <span className="chain-legend" style={{ display: 'flex', gap: 10, fontSize: 11 }}>
          <span><i style={{ background: COLOR.final }} /> final</span>
          <span><i style={{ background: COLOR.confirmed }} /> confirming</span>
          <span><i style={{ background: COLOR.orphan }} /> orphan</span>
          {hidden && Object.keys(hidden).length > 0 && <span><i style={{ background: COLOR.secret }} /> secret</span>}
        </span>
      </div>
      <div className="depgraph-scroll">
        {model.empty ? (
          <div className="muted" style={{ padding: 16 }}>No blocks yet — press Play and let the miners find blocks.</div>
        ) : (
          <svg width={model.width} height={model.height} className="depgraph-svg">
            <defs>
              <marker id="bt-arrow" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6 Z" fill="rgba(255,255,255,0.4)" />
              </marker>
            </defs>
            {model.edges.map((e, i) => {
              const x1 = e.to.x;
              const x2 = e.from.x + BW;
              const y1 = e.to.y + BH / 2;
              const y2 = e.from.y + BH / 2;
              const secret = e.to.kind === 'secret';
              return (
                <path
                  key={i}
                  d={`M ${x1} ${y1} C ${x1 - GX / 2} ${y1}, ${x2 + GX / 2} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke={secret ? COLOR.secret : 'rgba(255,255,255,0.35)'}
                  strokeWidth={1.4}
                  strokeDasharray={secret ? '4 3' : undefined}
                  markerEnd="url(#bt-arrow)"
                />
              );
            })}
            {model.nodes.map((n) => {
              const c = COLOR[n.kind];
              const isTip = n.b.hash === tip;
              return (
                <g key={n.b.hash}>
                  <rect
                    x={n.x}
                    y={n.y}
                    width={BW}
                    height={BH}
                    rx={7}
                    fill={`${c}22`}
                    stroke={c}
                    strokeWidth={isTip ? 2.4 : n.kind === 'final' ? 1.6 : 1.2}
                    strokeDasharray={n.kind === 'secret' ? '4 3' : undefined}
                    opacity={n.kind === 'orphan' ? 0.6 : 1}
                  />
                  <text x={n.x + BW / 2} y={n.y + 15} textAnchor="middle" className="chain-h" fill={c}>
                    #{n.b.height}
                  </text>
                  <text x={n.x + BW / 2} y={n.y + 30} textAnchor="middle" className="chain-meta">
                    {n.b.hash === 'genesis' ? '⊥' : `${shortHash(n.b.hash)}·${n.b.txs.length}t`}
                  </text>
                  {n.spot && (
                    <circle cx={n.x + BW - 6} cy={n.y + 6} r={5} fill="#ff5d6c" stroke="#0b0c10" strokeWidth={1}>
                      <title>contains the spotlighted transaction</title>
                    </circle>
                  )}
                </g>
              );
            })}
          </svg>
        )}
      </div>
      <div className="depgraph-foot muted">
        Height {model.tipH}. The green run is the chain every honest node agrees on; blocks {k}+ deep are treated as final.
        Forks resolve when one branch out-races the other — the loser's blocks become orphans.
      </div>
    </div>
  );
}
