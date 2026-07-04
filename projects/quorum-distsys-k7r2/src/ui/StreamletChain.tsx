// The Streamlet block-tree visualiser — the protocol's signature picture. It
// draws the recent block tree with blocks positioned by height (left→right) and
// forks stacked into lanes, tinted by how far agreement has carried each one:
//   proposed (known)  →  notarized (2f+1 votes)  →  finalized (a triple fired).
// The magic is the finalization rule: whenever three *adjacent* notarized blocks
// have *consecutive* epoch numbers (e, e+1, e+2), a golden bracket lights under
// them and the middle block turns solid green — final, forever. Watching that
// bracket slide right along the chain *is* Streamlet.
import { useMemo } from 'react';
import { quorum, GENESIS_HASH, opStr, type Block, type StreamletState } from '../protocols/streamlet/types';

interface Props {
  state: StreamletState | null;
  /** Cluster size, for the 2f+1 notarization threshold shown on each block. */
  n: number;
}

type Phase = 'final' | 'notarized' | 'proposed';

const PHASE_COLOR: Record<Phase, string> = {
  final: '#73e08a',
  notarized: '#5bd6c8',
  proposed: '#b08bff',
};
const PHASE_LABEL: Record<Phase, string> = {
  final: 'finalized',
  notarized: 'notarized (2f+1)',
  proposed: 'proposed',
};

const BW = 96; // block width
const BH = 52; // block height
const COLGAP = 44; // horizontal gap between height columns
const LANEGAP = 20; // vertical gap between fork lanes
const PAD_X = 20;
const PAD_TOP = 26;
const PAD_BOT = 30;
const WINDOW = 12; // how many height columns to show

export function StreamletChain({ state, n }: Props) {
  const geom = useMemo(() => {
    if (!state) return null;
    const Q = quorum(n);
    const blocks = Object.values(state.blocks);
    if (blocks.length === 0) return null;
    const maxH = blocks.reduce((m, b) => Math.max(m, b.height), 0);
    const minH = Math.max(0, maxH - WINDOW);
    const shown = blocks.filter((b) => b.height >= minH).sort((a, b) => a.height - b.height || (a.hash < b.hash ? -1 : 1));

    // Lane assignment: keep a block in its parent's lane when free, else spill to
    // the next lane. Produces a legible tree with forks stacked.
    const laneOf = new Map<string, number>();
    const usedPerCol = new Map<number, Set<number>>();
    const colOf = (h: number) => h - minH;
    for (const b of shown) {
      const col = colOf(b.height);
      const used = usedPerCol.get(col) ?? new Set<number>();
      let lane = laneOf.get(b.parent);
      if (lane === undefined || used.has(lane)) {
        lane = 0;
        while (used.has(lane)) lane++;
      }
      used.add(lane);
      usedPerCol.set(col, used);
      laneOf.set(b.hash, lane);
    }
    const maxLane = Math.max(0, ...[...laneOf.values()]);
    const cols = maxH - minH + 1;

    const phaseOf = (b: Block): Phase => {
      if (b.height <= state.finalHeight && finalHashAt(state, b.height) === b.hash) return 'final';
      if (state.notarized[b.hash]) return 'notarized';
      return 'proposed';
    };

    // Detect the finalization triples among shown notarized blocks (top = b2).
    const triples: { hashes: [string, string, string] }[] = [];
    for (const b2 of shown) {
      if (!state.notarized[b2.hash] || b2.height < 3) continue;
      const b1 = state.blocks[b2.parent];
      const b0 = b1 ? state.blocks[b1.parent] : undefined;
      if (b1 && b0 && state.notarized[b1.hash] && b1.epoch === b2.epoch - 1 && b0.epoch === b1.epoch - 1) {
        if (b0.height >= minH) triples.push({ hashes: [b0.hash, b1.hash, b2.hash] });
      }
    }

    const x = (b: Block) => PAD_X + colOf(b.height) * (BW + COLGAP);
    const y = (b: Block) => PAD_TOP + (laneOf.get(b.hash) ?? 0) * (BH + LANEGAP);
    const width = PAD_X * 2 + cols * BW + (cols - 1) * COLGAP;
    const height = PAD_TOP + (maxLane + 1) * BH + maxLane * LANEGAP + PAD_BOT;

    return { shown, phaseOf, triples, x, y, width, height, Q, minH, maxH };
  }, [state, n]);

  if (!state || !geom) {
    return (
      <div className="streamlet-chain empty">
        <span className="muted">The block tree appears here once the first epoch proposes.</span>
      </div>
    );
  }

  const { shown, phaseOf, triples, x, y, width, height, Q } = geom;

  return (
    <div className="streamlet-chain">
      <div className="chain-legend">
        {(['proposed', 'notarized', 'final'] as Phase[]).map((p) => (
          <span key={p}>
            <i style={{ background: PHASE_COLOR[p] }} /> {PHASE_LABEL[p]}
          </span>
        ))}
        <span>
          <i style={{ background: '#ffd479' }} /> consecutive-epoch triple → finalize
        </span>
      </div>
      <div className="chain-scroll">
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Streamlet block tree">
          {/* parent edges */}
          {shown.map((b) => {
            const parent = state.blocks[b.parent];
            if (!parent || b.parent === '') return null;
            if (parent.height < geom.minH) return null;
            const x1 = x(parent) + BW;
            const y1 = y(parent) + BH / 2;
            const x2 = x(b);
            const y2 = y(b) + BH / 2;
            const mid = (x1 + x2) / 2;
            return (
              <path
                key={`e-${b.hash}`}
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="rgba(255,255,255,0.22)"
                strokeWidth={2}
              />
            );
          })}

          {/* finalization triple brackets */}
          {triples.map((t, i) => {
            const bs = t.hashes.map((h) => state.blocks[h]).filter(Boolean) as Block[];
            if (bs.length < 3) return null;
            const xs = bs.map((b) => x(b));
            const ys = bs.map((b) => y(b));
            const left = Math.min(...xs);
            const right = Math.max(...xs) + BW;
            const top = Math.min(...ys) - 8;
            return (
              <g key={`t-${i}`}>
                <rect x={left - 5} y={top} width={right - left + 10} height={BH + 16} rx={10} fill="none" stroke="#ffd479" strokeWidth={2} strokeDasharray="5 4" opacity={0.85} />
                <text x={(left + right) / 2} y={top - 4} textAnchor="middle" fontSize={10.5} fill="#ffd479" fontWeight={600}>
                  e{bs[0].epoch}·e{bs[1].epoch}·e{bs[2].epoch} → #{bs[1].height} final
                </text>
              </g>
            );
          })}

          {/* blocks */}
          {shown.map((b) => {
            const ph = phaseOf(b);
            const col = PHASE_COLOR[ph];
            const bx = x(b);
            const by = y(b);
            const votes = Object.keys(state.votes[b.hash] ?? {}).length;
            const isGenesis = b.hash === GENESIS_HASH;
            const forged = b.cmd.cid.includes('✗') || opStr(b.cmd).includes('✗');
            return (
              <g key={b.hash} opacity={forged ? 0.75 : 1}>
                <rect
                  x={bx}
                  y={by}
                  width={BW}
                  height={BH}
                  rx={9}
                  fill={ph === 'final' ? col : 'rgba(20,26,38,0.9)'}
                  stroke={col}
                  strokeWidth={ph === 'final' ? 2.5 : 1.75}
                />
                <text x={bx + 9} y={by + 17} fontSize={11} fill={ph === 'final' ? '#08130c' : '#e8eaf0'} fontWeight={700}>
                  #{b.height}
                </text>
                <text x={bx + BW - 9} y={by + 17} textAnchor="end" fontSize={10} fill={ph === 'final' ? '#0d1a10' : col} fontWeight={600}>
                  e{b.epoch}
                </text>
                <text x={bx + BW / 2} y={by + 33} textAnchor="middle" fontSize={11} fill={ph === 'final' ? '#08130c' : '#cfd6e4'} fontWeight={600}>
                  {isGenesis ? 'genesis' : opStr(b.cmd)}
                </text>
                {!isGenesis && (
                  <text x={bx + BW / 2} y={by + 46} textAnchor="middle" fontSize={9.5} fill={ph === 'final' ? '#0d1a10' : '#8a93a6'}>
                    {ph === 'proposed' ? `${votes}/${Q} votes` : ph === 'notarized' ? `✓ ${votes} votes` : 'FINAL'}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/** The finalized block hash a replica holds at a given height (from its log). */
function finalHashAt(state: StreamletState, height: number): string | undefined {
  for (let i = state.committed.length - 1; i >= 0; i--) if (state.committed[i].height === height) return state.committed[i].hash;
  return state.finalized[height];
}
