// Two-player, perfect-information board games for the AlphaZero lab, written from scratch.
//
// AlphaZero learns a game tabula rasa — no dataset, no human games — so the only thing the rest
// of the lab needs from a game is a small, exact rulebook: what the legal moves are, how a move
// changes the position, when the game is over and who won. This file is that rulebook for two
// games, behind one `Game` interface so the network, the search and the trainer are completely
// game-agnostic.
//
//   • Tic-Tac-Toe (3×3) — tiny and *solved*, so a from-scratch perfect negamax solver gives us a
//     ground-truth oracle: optimal play is a draw, and we can prove the trained agent never loses.
//   • Connect-Four (6×7) — the bigger, prettier cousin: real gravity, four-in-a-row in every
//     direction, a 7-way branching factor, enough state that the network has something to learn.
//
// The board is stored in absolute terms (+1 = player ①, −1 = player ②, 0 = empty). The network,
// however, always sees the board from the *side to move*'s perspective (`encode`), so a single
// net plays both sides — exactly AlphaZero's "canonical board". The value it predicts is likewise
// from the mover's perspective: +1 "I am winning", −1 "I am losing".

export type Player = 1 | -1;

export interface GameState {
  /** Absolute board: +1 player ①, −1 player ②, 0 empty. Length === `cells`. */
  readonly board: Int8Array;
  /** Whose turn it is (absolute). */
  readonly player: Player;
  /** The action that produced this state (for UI highlighting); −1 for the initial state. */
  readonly last: number;
  /** Ply count (number of pieces placed) — the move number. */
  readonly ply: number;
}

export interface GameStatus {
  done: boolean;
  /** Absolute winner: +1, −1, or 0 for a draw. Meaningful only when `done`. */
  winner: number;
  /** Winning line cell indices, for the UI to highlight. */
  line: readonly number[];
}

/** A board symmetry: a relabelling of cells (and of the policy over actions) that preserves the
 *  rules. Augmenting self-play data with these multiplies the data the net sees for free. */
export interface Symmetry {
  /** `augmentedCell[i] = cell[cellPerm[i]]` — a gather permutation over the board cells. */
  readonly cellPerm: Int32Array;
  /** `augmentedPolicy[a] = policy[actPerm[a]]` — the matching permutation over actions. */
  readonly actPerm: Int32Array;
}

export interface Game {
  readonly id: GameId;
  readonly name: string;
  readonly rows: number;
  readonly cols: number;
  readonly cells: number;
  /** Number of distinct actions (TTT: 9 cells; C4: 7 columns). */
  readonly numActions: number;
  /** Input feature planes the encoder emits (mine / theirs). */
  readonly planes: number;

  initial(): GameState;
  legalMoves(s: GameState): number[];
  legalMask(s: GameState): Uint8Array;
  apply(s: GameState, action: number): GameState;
  status(s: GameState): GameStatus;

  /** Canonical, side-to-move-perspective planes, flattened NCHW: [planes * rows * cols]. */
  encode(s: GameState): Float64Array;
  /** The board cell an action lands on (for overlay placement). */
  actionCell(s: GameState, action: number): number;
  symmetries(): Symmetry[];
}

export type GameId = 'ttt' | 'c4';

// ---------------------------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------------------------

function emptyState(cells: number): GameState {
  return { board: new Int8Array(cells), player: 1, last: -1, ply: 0 };
}

// Side-to-move-perspective encoding shared by both games: plane 0 = the mover's stones, plane 1 =
// the opponent's stones. Because it is relative to the player to move, one network plays both
// colours and the value is always "good for me".
function encodeMineTheirs(s: GameState, cells: number): Float64Array {
  const out = new Float64Array(2 * cells);
  const me = s.player;
  for (let i = 0; i < cells; i++) {
    const v = s.board[i];
    if (v === me) out[i] = 1;
    else if (v === -me) out[cells + i] = 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tic-Tac-Toe.
// ---------------------------------------------------------------------------------------------

const TTT_LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // cols
  [0, 4, 8], [2, 4, 6], // diagonals
];

class TicTacToe implements Game {
  readonly id = 'ttt' as const;
  readonly name = 'Tic-Tac-Toe';
  readonly rows = 3;
  readonly cols = 3;
  readonly cells = 9;
  readonly numActions = 9;
  readonly planes = 2;

  initial(): GameState {
    return emptyState(9);
  }

  legalMoves(s: GameState): number[] {
    const m: number[] = [];
    for (let i = 0; i < 9; i++) if (s.board[i] === 0) m.push(i);
    return m;
  }

  legalMask(s: GameState): Uint8Array {
    const mask = new Uint8Array(9);
    for (let i = 0; i < 9; i++) mask[i] = s.board[i] === 0 ? 1 : 0;
    return mask;
  }

  apply(s: GameState, action: number): GameState {
    const board = s.board.slice();
    board[action] = s.player;
    return { board, player: (-s.player) as Player, last: action, ply: s.ply + 1 };
  }

  status(s: GameState): GameStatus {
    for (const [a, b, c] of TTT_LINES) {
      const v = s.board[a];
      if (v !== 0 && v === s.board[b] && v === s.board[c]) {
        return { done: true, winner: v, line: [a, b, c] };
      }
    }
    if (s.ply >= 9) return { done: true, winner: 0, line: [] };
    return { done: false, winner: 0, line: [] };
  }

  encode(s: GameState): Float64Array {
    return encodeMineTheirs(s, 9);
  }

  actionCell(_s: GameState, action: number): number {
    return action;
  }

  symmetries(): Symmetry[] {
    return TTT_SYMS;
  }
}

// The dihedral group D4 on a 3×3 board: identity, three rotations, and four reflections. Each is a
// permutation of the nine cells; because an action *is* a cell here, the action permutation equals
// the cell permutation. Built once below.
function buildTttSyms(): Symmetry[] {
  const rc = (i: number): [number, number] => [Math.floor(i / 3), i % 3];
  const idx = (r: number, c: number) => r * 3 + c;
  const maps: ((r: number, c: number) => [number, number])[] = [
    (r, c) => [r, c], // identity
    (r, c) => [c, 2 - r], // rot 90
    (r, c) => [2 - r, 2 - c], // rot 180
    (r, c) => [2 - c, r], // rot 270
    (r, c) => [r, 2 - c], // flip horizontal
    (r, c) => [2 - r, c], // flip vertical
    (r, c) => [c, r], // transpose (main diagonal)
    (r, c) => [2 - c, 2 - r], // anti-diagonal
  ];
  return maps.map((m) => {
    const perm = new Int32Array(9);
    for (let i = 0; i < 9; i++) {
      const [r, c] = rc(i);
      const [nr, nc] = m(r, c);
      // augmented[i] gathers from original[perm[i]] — `perm[i]` is where cell i's content comes from.
      perm[idx(nr, nc)] = i;
    }
    return { cellPerm: perm, actPerm: perm };
  });
}
const TTT_SYMS = buildTttSyms();

// ---------------------------------------------------------------------------------------------
// Connect-Four.
// ---------------------------------------------------------------------------------------------

const C4_ROWS = 6;
const C4_COLS = 7;
const C4_CELLS = C4_ROWS * C4_COLS;

class ConnectFour implements Game {
  readonly id = 'c4' as const;
  readonly name = 'Connect Four';
  readonly rows = C4_ROWS;
  readonly cols = C4_COLS;
  readonly cells = C4_CELLS;
  readonly numActions = C4_COLS;
  readonly planes = 2;

  initial(): GameState {
    return emptyState(C4_CELLS);
  }

  // The lowest empty row in a column, or −1 if the column is full. Row 0 is the top.
  private dropRow(board: Int8Array, col: number): number {
    for (let r = C4_ROWS - 1; r >= 0; r--) if (board[r * C4_COLS + col] === 0) return r;
    return -1;
  }

  legalMoves(s: GameState): number[] {
    const m: number[] = [];
    for (let c = 0; c < C4_COLS; c++) if (s.board[c] === 0) m.push(c); // top cell empty ⇒ column not full
    return m;
  }

  legalMask(s: GameState): Uint8Array {
    const mask = new Uint8Array(C4_COLS);
    for (let c = 0; c < C4_COLS; c++) mask[c] = s.board[c] === 0 ? 1 : 0;
    return mask;
  }

  apply(s: GameState, action: number): GameState {
    const board = s.board.slice();
    const r = this.dropRow(board, action);
    board[r * C4_COLS + action] = s.player;
    return { board, player: (-s.player) as Player, last: r * C4_COLS + action, ply: s.ply + 1 };
  }

  status(s: GameState): GameStatus {
    const b = s.board;
    const dirs: readonly [number, number][] = [
      [0, 1], // →
      [1, 0], // ↓
      [1, 1], // ↘
      [1, -1], // ↙
    ];
    for (let r = 0; r < C4_ROWS; r++) {
      for (let c = 0; c < C4_COLS; c++) {
        const v = b[r * C4_COLS + c];
        if (v === 0) continue;
        for (const [dr, dc] of dirs) {
          const line: number[] = [r * C4_COLS + c];
          let rr = r + dr;
          let cc = c + dc;
          while (rr >= 0 && rr < C4_ROWS && cc >= 0 && cc < C4_COLS && b[rr * C4_COLS + cc] === v) {
            line.push(rr * C4_COLS + cc);
            if (line.length === 4) return { done: true, winner: v, line };
            rr += dr;
            cc += dc;
          }
        }
      }
    }
    if (s.ply >= C4_CELLS) return { done: true, winner: 0, line: [] };
    return { done: false, winner: 0, line: [] };
  }

  encode(s: GameState): Float64Array {
    return encodeMineTheirs(s, C4_CELLS);
  }

  actionCell(s: GameState, action: number): number {
    const r = this.dropRow(s.board, action);
    return r < 0 ? action : r * C4_COLS + action;
  }

  symmetries(): Symmetry[] {
    return C4_SYMS;
  }
}

// Connect-Four's only rule-preserving symmetry is the left–right mirror.
function buildC4Syms(): Symmetry[] {
  const ident = new Int32Array(C4_CELLS);
  const mirror = new Int32Array(C4_CELLS);
  for (let r = 0; r < C4_ROWS; r++) {
    for (let c = 0; c < C4_COLS; c++) {
      const i = r * C4_COLS + c;
      ident[i] = i;
      mirror[i] = r * C4_COLS + (C4_COLS - 1 - c);
    }
  }
  const actIdent = new Int32Array(C4_COLS);
  const actMirror = new Int32Array(C4_COLS);
  for (let c = 0; c < C4_COLS; c++) {
    actIdent[c] = c;
    actMirror[c] = C4_COLS - 1 - c;
  }
  return [
    { cellPerm: ident, actPerm: actIdent },
    { cellPerm: mirror, actPerm: actMirror },
  ];
}
const C4_SYMS = buildC4Syms();

// ---------------------------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------------------------

export function makeGame(id: GameId): Game {
  return id === 'ttt' ? new TicTacToe() : new ConnectFour();
}

export const GAME_IDS: GameId[] = ['ttt', 'c4'];

// ---------------------------------------------------------------------------------------------
// Perfect / bounded solvers — the verifiable oracle and the "perfect" opponent.
// ---------------------------------------------------------------------------------------------

export interface SolveResult {
  /** Game-theoretic value for the side to move: +1 win, 0 draw, −1 loss (under optimal play). */
  score: number;
  /** Plies to the end under optimal play (shorter wins / longer losses preferred). */
  dist: number;
  /** A single crisp best move (value-optimal, then fastest win / slowest loss). −1 if terminal. */
  bestMove: number;
  /** Every *value*-optimal move (any of these preserves the game-theoretic value). */
  optimalMoves: number[];
}

function boardKey(s: GameState): string {
  // Player is encoded by the ply parity for TTT/C4 (① always starts), but include it explicitly
  // so the memo is correct regardless: pack the board into a base-3 string plus the side to move.
  let k = s.player === 1 ? 'A' : 'B';
  const b = s.board;
  for (let i = 0; i < b.length; i++) k += b[i] === 0 ? '0' : b[i] === 1 ? '1' : '2';
  return k;
}

/** Exact negamax with alpha-beta + memoization. Sound and complete for Tic-Tac-Toe (and any small
 *  game). Returns the game-theoretic value, a crisp best move, and the full value-optimal set. */
export function solve(game: Game, s: GameState, memo: Map<string, SolveResult> = new Map()): SolveResult {
  const st = game.status(s);
  if (st.done) {
    // Terminal: the side to move has no move. If someone has won it must be the opponent (the mover
    // can never be the one who just completed a line), so it's a loss; otherwise a draw.
    return { score: st.winner === 0 ? 0 : -1, dist: 0, bestMove: -1, optimalMoves: [] };
  }
  const key = boardKey(s);
  const cached = memo.get(key);
  if (cached) return cached;

  const moves = game.legalMoves(s);
  let bestScore = -Infinity;
  let bestDist = Infinity;
  let bestMove = moves[0];
  const optimalMoves: number[] = [];
  let topValue = -Infinity;

  for (const a of moves) {
    const child = solve(game, game.apply(s, a), memo);
    const score = -child.score;
    const dist = child.dist + 1;
    if (score > topValue) topValue = score;
    // Crisp choice: maximise score; tie-break by distance (win sooner, lose later, draw sooner).
    const better =
      score > bestScore ||
      (score === bestScore &&
        (score > 0 ? dist < bestDist : score < 0 ? dist > bestDist : dist < bestDist));
    if (better) {
      bestScore = score;
      bestDist = dist;
      bestMove = a;
    }
  }
  // The value-optimal set: every move whose subtree value equals the position's value.
  for (const a of moves) {
    const child = solve(game, game.apply(s, a), memo);
    if (-child.score === topValue) optimalMoves.push(a);
  }

  const res: SolveResult = { score: bestScore, dist: bestDist, bestMove, optimalMoves };
  memo.set(key, res);
  return res;
}

// A small heuristic for the bounded Connect-Four search: count open 2/3-in-a-row windows for the
// side to move minus the opponent's. Purely to break ties at the depth horizon — the search still
// plays exact tactics within its depth.
function c4Heuristic(game: Game, s: GameState): number {
  const b = s.board;
  const me = s.player;
  const R = game.rows;
  const C = game.cols;
  const dirs: readonly [number, number][] = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];
  let score = 0;
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      for (const [dr, dc] of dirs) {
        const er = r + 3 * dr;
        const ec = c + 3 * dc;
        if (er < 0 || er >= R || ec < 0 || ec >= C) continue;
        let mine = 0;
        let theirs = 0;
        for (let k = 0; k < 4; k++) {
          const v = b[(r + k * dr) * C + (c + k * dc)];
          if (v === me) mine++;
          else if (v === -me) theirs++;
        }
        if (mine > 0 && theirs === 0) score += mine * mine;
        else if (theirs > 0 && mine === 0) score -= theirs * theirs;
      }
    }
  }
  return Math.tanh(score / 30); // squashed into (−1, 1)
}

/** Depth-limited negamax with alpha-beta for the "strong" Connect-Four opponent. Exact within the
 *  depth window (real tactics: it will take a win and block a loss); heuristic at the horizon. */
export function boundedSearch(
  game: Game,
  s: GameState,
  depth: number,
  alpha = -Infinity,
  beta = Infinity,
): { score: number; bestMove: number } {
  const st = game.status(s);
  if (st.done) return { score: st.winner === 0 ? 0 : -1, bestMove: -1 };
  if (depth <= 0) return { score: c4Heuristic(game, s), bestMove: -1 };

  const moves = orderMoves(game, s);
  let best = -Infinity;
  let bestMove = moves[0];
  for (const a of moves) {
    const child = game.apply(s, a);
    const r = boundedSearch(game, child, depth - 1, -beta, -alpha);
    const score = -r.score * 0.999; // tiny decay ⇒ prefer faster wins
    if (score > best) {
      best = score;
      bestMove = a;
    }
    if (best > alpha) alpha = best;
    if (alpha >= beta) break; // β-cutoff
  }
  return { score: best, bestMove };
}

// Centre-first move ordering sharpens the alpha-beta pruning (centre columns dominate in C4).
function orderMoves(game: Game, s: GameState): number[] {
  const moves = game.legalMoves(s);
  const mid = (game.numActions - 1) / 2;
  return moves.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
}
