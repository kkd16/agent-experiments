// The block-chain visualiser — HotStuff's signature picture. It draws the tail of
// the replicated chain as a row of blocks, each linked to its parent, and overlays
// the QC "justify" arcs that thread the pipeline. Blocks are tinted by how far
// agreement has carried them: proposed → certified (1 QC) → locked (2-chain) →
// committed (the 3-chain rule fired). Watching a block march left→right through
// those four colours *is* the protocol.
import { useMemo } from 'react';
import type { Block, HsState } from '../protocols/hotstuff/types';
import { opStr } from '../protocols/hotstuff/types';

interface Props {
  state: HsState | null;
  /** Recently-committed height to pulse (the block the 3-chain just decided). */
  height?: number;
}

type Phase = 'committed' | 'locked' | 'certified' | 'proposed';

const PHASE_COLOR: Record<Phase, string> = {
  committed: '#73e08a',
  locked: '#7c9cff',
  certified: '#5bd6c8',
  proposed: '#b08bff',
};
const PHASE_LABEL: Record<Phase, string> = {
  committed: 'committed',
  locked: 'locked (2-chain)',
  certified: 'certified (QC)',
  proposed: 'proposed',
};

const BW = 92; // block width
const BH = 64; // block height
const GAP = 34; // gap between blocks
const PAD = 18;
const TOP = 30;

export function ChainView({ state }: Props) {
  const { chain, phases, tipHeight } = useMemo(() => {
    if (!state) return { chain: [] as Block[], phases: new Map<string, Phase>(), tipHeight: 0 };
    // Walk from the highest block we know down its parent links.
    let tip: Block | undefined;
    for (const h of Object.keys(state.blocks)) {
      const b = state.blocks[h];
      if (!tip || b.height > tip.height) tip = b;
    }
    const out: Block[] = [];
    let cur = tip;
    let guard = 0;
    while (cur && guard++ < 64) {
      out.push(cur);
      if (cur.parent === '') break;
      cur = state.blocks[cur.parent];
    }
    out.reverse();
    const tail = out.slice(-14);
    const qcTip = state.blocks[state.qcHigh.block];
    const qcTipH = qcTip ? qcTip.height : 0;
    const ph = new Map<string, Phase>();
    for (const b of tail) {
      let p: Phase;
      if (b.height <= state.bExecHeight) p = 'committed';
      else if (b.height <= state.lockedHeight) p = 'locked';
      else if (b.height <= qcTipH) p = 'certified';
      else p = 'proposed';
      ph.set(b.hash, p);
    }
    return { chain: tail, phases: ph, tipHeight: tip ? tip.height : 0 };
  }, [state]);

  if (!state || chain.length === 0) {
    return (
      <div className="chainview empty">
        <span className="muted">No blocks yet — send a client request to start the chain.</span>
      </div>
    );
  }

  const width = PAD * 2 + chain.length * BW + (chain.length - 1) * GAP;
  const height = TOP + BH + 64;
  const xOf = (i: number) => PAD + i * (BW + GAP);
  const idxOf = new Map<string, number>();
  chain.forEach((b, i) => idxOf.set(b.hash, i));

  return (
    <div className="chainview">
      <div className="chainview-head">
        <span>Replicated chain</span>
        <span className="chain-legend">
          {(['proposed', 'certified', 'locked', 'committed'] as Phase[]).map((p) => (
            <span key={p}>
              <i style={{ background: PHASE_COLOR[p] }} /> {PHASE_LABEL[p]}
            </span>
          ))}
        </span>
      </div>
      <div className="chainview-scroll">
        <svg width={width} height={height} className="chain-svg">
          <defs>
            <marker id="chain-arrow" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="rgba(255,255,255,0.45)" />
            </marker>
            <marker id="qc-arrow" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="#ffd479" />
            </marker>
          </defs>

          {/* QC "justify" arcs: each block points at the block its certificate certifies. */}
          {chain.map((b, i) => {
            const j = idxOf.get(b.justify.block);
            if (j === undefined || j === i) return null;
            const x1 = xOf(i) + BW / 2;
            const x2 = xOf(j) + BW / 2;
            const y = TOP;
            const lift = 18 + Math.min(20, Math.abs(i - j) * 4);
            return (
              <path
                key={'qc' + b.hash}
                d={`M ${x1} ${y} C ${x1} ${y - lift}, ${x2} ${y - lift}, ${x2} ${y}`}
                fill="none"
                stroke="#ffd479"
                strokeWidth={1.3}
                strokeOpacity={0.6}
                strokeDasharray="3 3"
                markerEnd="url(#qc-arrow)"
              />
            );
          })}

          {/* parent links */}
          {chain.map((b, i) => {
            if (i === 0) return null;
            const prev = idxOf.get(b.parent);
            if (prev === undefined) return null;
            const x1 = xOf(i);
            const x2 = xOf(prev) + BW;
            const y = TOP + BH / 2;
            return <line key={'p' + b.hash} x1={x1} y1={y} x2={x2} y2={y} stroke="rgba(255,255,255,0.4)" strokeWidth={1.5} markerEnd="url(#chain-arrow)" />;
          })}

          {/* blocks */}
          {chain.map((b, i) => {
            const p = phases.get(b.hash)!;
            const x = xOf(i);
            const isNoop = b.cmd.op.op === 'noop';
            return (
              <g key={b.hash}>
                <rect
                  x={x}
                  y={TOP}
                  width={BW}
                  height={BH}
                  rx={9}
                  fill={`${PHASE_COLOR[p]}22`}
                  stroke={PHASE_COLOR[p]}
                  strokeWidth={p === 'committed' ? 2 : 1.3}
                />
                <text x={x + BW / 2} y={TOP + 17} textAnchor="middle" className="chain-h">
                  #{b.height}
                </text>
                <text x={x + BW / 2} y={TOP + 37} textAnchor="middle" className="chain-cmd" fill={isNoop ? '#5b6472' : '#e8eaf0'}>
                  {opStr(b.cmd)}
                </text>
                <text x={x + BW / 2} y={TOP + 54} textAnchor="middle" className="chain-meta">
                  v{b.view} · {b.proposer}
                </text>
              </g>
            );
          })}

          {/* a bracket over the most recent committed 3-chain */}
          {(() => {
            const committedIdx = chain.map((b, i) => (phases.get(b.hash) === 'committed' ? i : -1)).filter((i) => i >= 0);
            if (committedIdx.length < 1) return null;
            const last = committedIdx[committedIdx.length - 1];
            const start = Math.max(0, last);
            const end = Math.min(chain.length - 1, last + 2);
            const x1 = xOf(start);
            const x2 = xOf(end) + BW;
            const y = TOP + BH + 14;
            return (
              <g>
                <path d={`M ${x1} ${y} L ${x1} ${y + 6} L ${x2} ${y + 6} L ${x2} ${y}`} fill="none" stroke="#73e08a" strokeWidth={1.2} strokeOpacity={0.7} />
                <text x={(x1 + x2) / 2} y={y + 22} textAnchor="middle" className="chain-bracket">
                  3-chain ⇒ commit
                </text>
              </g>
            );
          })()}
        </svg>
      </div>
      <div className="chainview-foot muted">
        chain height {tipHeight} · committed ≤ #{state.bExecHeight} · locked #{state.lockedHeight} · qcHigh v{state.qcHigh.view}
      </div>
    </div>
  );
}
