import { useMemo } from 'react';
import type { Game, GameState, Player } from '../../engine/games';
import type { SearchResult } from '../../engine/mcts';

const U = 100; // SVG units per cell

const P1 = '#38bdf8'; // player ① — cyan
const P2 = '#f472b6'; // player ② — pink

interface Props {
  game: Game;
  state: GameState;
  analysis: SearchResult | null;
  humanPlayer: Player;
  lastAIMove: number;
  winLine: readonly number[];
  interactive: boolean;
  showOverlay: boolean;
  onPlay: (action: number) => void;
}

// One SVG board that renders both games: Tic-Tac-Toe (click a cell) and Connect-Four (click a
// column, gravity drops the disc). When `showOverlay` is on, every legal move is annotated with the
// search's read of it — a halo sized by the share of MCTS visits and tinted by the action value Q.
export default function AZBoard({
  game,
  state,
  analysis,
  humanPlayer,
  lastAIMove,
  winLine,
  interactive,
  showOverlay,
  onPlay,
}: Props) {
  const { rows, cols } = game;
  const W = cols * U;
  const H = rows * U;
  const columnGame = game.numActions === cols; // Connect-Four: actions are columns

  const totalVisits = useMemo(() => {
    if (!analysis) return 0;
    let s = 0;
    for (let a = 0; a < analysis.counts.length; a++) s += analysis.counts[a];
    return s;
  }, [analysis]);

  const winSet = useMemo(() => new Set(winLine), [winLine]);
  const legalMask = game.legalMask(state);
  const humanToMove = state.player === humanPlayer && !game.status(state).done;

  // Visit-share overlay marker for an action, placed on the cell the action lands on.
  const overlayFor = (action: number) => {
    if (!showOverlay || !analysis || totalVisits <= 0 || !legalMask[action]) return null;
    const share = analysis.counts[action] / totalVisits;
    const q = analysis.q[action]; // [−1, 1] from the side-to-move's perspective
    const cell = game.actionCell(state, action);
    const r = Math.floor(cell / cols);
    const c = cell % cols;
    const cx = (c + 0.5) * U;
    const cy = (r + 0.5) * U;
    // Q → colour: green good for mover, red bad.
    const g = Math.round(120 + 120 * Math.max(0, q));
    const rd = Math.round(120 + 120 * Math.max(0, -q));
    const fill = `rgba(${rd}, ${g}, 90, ${0.10 + 0.45 * share})`;
    const radius = 14 + 30 * Math.sqrt(share);
    return (
      <g key={`ov${action}`} pointerEvents="none">
        <circle cx={cx} cy={cy} r={radius} fill={fill} stroke="rgba(226,232,240,0.35)" strokeWidth={1.5} />
        <text x={cx} y={cy - radius - 4} textAnchor="middle" fontSize={15} fill="#cbd5e1" fontWeight={600}>
          {Math.round(share * 100)}%
        </text>
      </g>
    );
  };

  const cells = [];
  for (let i = 0; i < game.cells; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const v = state.board[i];
    const cx = (c + 0.5) * U;
    const cy = (r + 0.5) * U;
    if (columnGame) {
      // Connect-Four: draw a hole (empty) or a coloured disc.
      cells.push(
        <circle
          key={`h${i}`}
          cx={cx}
          cy={cy}
          r={U * 0.38}
          fill={v === 1 ? P1 : v === 2 || v === -1 ? P2 : '#0b1220'}
          stroke={winSet.has(i) ? '#4ade80' : 'rgba(148,163,184,0.25)'}
          strokeWidth={winSet.has(i) ? 5 : 2}
        />,
      );
    } else if (v !== 0) {
      // Tic-Tac-Toe: draw X (player ①) or O (player ②).
      const stroke = v === 1 ? P1 : P2;
      const hl = winSet.has(i);
      if (v === 1) {
        const o = U * 0.26;
        cells.push(
          <g key={`m${i}`} stroke={stroke} strokeWidth={hl ? 11 : 8} strokeLinecap="round">
            <line x1={cx - o} y1={cy - o} x2={cx + o} y2={cy + o} />
            <line x1={cx + o} y1={cy - o} x2={cx - o} y2={cy + o} />
          </g>,
        );
      } else {
        cells.push(
          <circle key={`m${i}`} cx={cx} cy={cy} r={U * 0.27} fill="none" stroke={stroke} strokeWidth={hl ? 11 : 8} />,
        );
      }
    }
  }

  // Grid lines (Tic-Tac-Toe) / board frame (Connect-Four already drawn as holes on a panel).
  const grid = [];
  if (!columnGame) {
    for (let c = 1; c < cols; c++) {
      grid.push(<line key={`gv${c}`} x1={c * U} y1={6} x2={c * U} y2={H - 6} stroke="rgba(148,163,184,0.25)" strokeWidth={2} />);
    }
    for (let r = 1; r < rows; r++) {
      grid.push(<line key={`gh${r}`} x1={6} y1={r * U} x2={W - 6} y2={r * U} stroke="rgba(148,163,184,0.25)" strokeWidth={2} />);
    }
  }

  // Clickable regions: a column strip (Connect-Four) or a single cell (Tic-Tac-Toe).
  const hits = [];
  if (columnGame) {
    for (let c = 0; c < cols; c++) {
      const playable = interactive && humanToMove && legalMask[c];
      hits.push(
        <rect
          key={`hit${c}`}
          x={c * U}
          y={0}
          width={U}
          height={H}
          fill="transparent"
          style={{ cursor: playable ? 'pointer' : 'default' }}
          onClick={() => playable && onPlay(c)}
        />,
      );
    }
  } else {
    for (let i = 0; i < game.cells; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const playable = interactive && humanToMove && legalMask[i];
      hits.push(
        <rect
          key={`hit${i}`}
          x={c * U}
          y={r * U}
          width={U}
          height={U}
          fill="transparent"
          style={{ cursor: playable ? 'pointer' : 'default' }}
          onClick={() => playable && onPlay(i)}
        />,
      );
    }
  }

  // Highlight the AI's last move.
  let lastMarker = null;
  if (lastAIMove >= 0) {
    const cell = game.actionCell(state, lastAIMove);
    // For the column game the disc is already placed; ring the cell it landed in.
    const ci = columnGame ? lastPlacedCell(state, lastAIMove, cols, rows) : cell;
    if (ci >= 0) {
      const r = Math.floor(ci / cols);
      const c = ci % cols;
      lastMarker = (
        <rect
          x={c * U + 4}
          y={r * U + 4}
          width={U - 8}
          height={U - 8}
          fill="none"
          stroke="rgba(250,204,21,0.8)"
          strokeWidth={3}
          rx={columnGame ? U * 0.4 : 8}
          pointerEvents="none"
        />
      );
    }
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="az-board" style={{ aspectRatio: `${cols} / ${rows}` }}>
      {columnGame && <rect x={0} y={0} width={W} height={H} rx={12} fill="rgba(56,189,248,0.06)" />}
      {grid}
      {cells}
      {showOverlay && Array.from({ length: game.numActions }, (_, a) => overlayFor(a))}
      {lastMarker}
      {hits}
    </svg>
  );
}

// The board cell the most recent disc occupies in a column (the topmost filled cell of that column).
function lastPlacedCell(state: GameState, col: number, cols: number, rows: number): number {
  for (let r = 0; r < rows; r++) {
    if (state.board[r * cols + col] !== 0) return r * cols + col;
  }
  return -1;
}
