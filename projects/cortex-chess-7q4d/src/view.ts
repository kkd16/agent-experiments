// UI-facing view model derived from a Game, plus difficulty presets. Kept
// separate from components so React Fast Refresh stays happy.

import {
  Game,
  type Move,
  type Color,
  type GameResult,
  WHITE,
  KING,
  moveFrom,
  moveTo,
  isOnBoard,
  pieceType,
  isSquareAttacked,
  moveToSan,
} from './engine'

export type EngineSide = 'white' | 'black' | 'none'

export interface Level {
  name: string
  maxDepth: number
  maxTime: number // ms
  blurb: string
}

export const LEVELS: Level[] = [
  { name: 'Casual', maxDepth: 4, maxTime: 200, blurb: 'shallow search — makes mistakes' },
  { name: 'Club', maxDepth: 8, maxTime: 500, blurb: 'solid tactics, ~1 ply blunders' },
  { name: 'Expert', maxDepth: 12, maxTime: 1200, blurb: 'strong tactical play' },
  { name: 'Master', maxDepth: 18, maxTime: 2500, blurb: 'deep search, few mistakes' },
  { name: 'Maximum', maxDepth: 24, maxTime: 5000, blurb: 'thinks as long as it can' },
]

export interface BoardView {
  board: Int8Array
  turn: Color
  legal: Move[]
  lastMove: { from: number; to: number } | null
  checkSquare: number | null
  result: GameResult
  historySan: string[]
  fen: string
  fullmoveNumber: number
}

export function buildView(game: Game): BoardView {
  const legal = game.legalMoves()
  const last = game.history.length > 0 ? game.history[game.history.length - 1].move : null
  let checkSquare: number | null = null
  const turn = game.turn
  if (isSquareAttacked(game.pos, game.pos.kings[turn], (turn ^ 1) as Color)) {
    checkSquare = game.pos.kings[turn]
  }
  return {
    board: Int8Array.from(game.pos.board),
    turn,
    legal,
    lastMove: last !== null ? { from: moveFrom(last), to: moveTo(last) } : null,
    checkSquare,
    result: game.result(),
    historySan: game.history.map((h) => h.san),
    fen: game.fen(),
    fullmoveNumber: game.pos.fullmove,
  }
}

// Squares (0x88) a piece on `from` can legally move to, given the legal move list.
export function targetsFrom(legal: Move[], from: number): number[] {
  return legal.filter((m) => moveFrom(m) === from).map((m) => moveTo(m))
}

export function isPromotionMove(legal: Move[], from: number, to: number): boolean {
  return legal.some((m) => moveFrom(m) === from && moveTo(m) === to && (m >> 14 & 7) !== 0)
}

// Ordered list of on-board squares for rendering, respecting orientation.
export function orderedSquares(whiteOnBottom: boolean): number[] {
  const squares: number[] = []
  const ranks = whiteOnBottom ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7]
  const files = whiteOnBottom ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0]
  for (const r of ranks) for (const f of files) squares.push(r * 16 + f)
  return squares
}

export function pieceAt(board: Int8Array, square: number): { color: Color; type: number } | null {
  if (!isOnBoard(square)) return null
  const pc = board[square]
  if (pc === 0) return null
  return { color: (pc >> 3) as Color, type: pieceType(pc) }
}

// Render a principal variation (move ints from `fen`) as a SAN string.
export function pvToSan(fen: string, moves: Move[], limit = 14): string {
  const g = new Game(fen)
  const parts: string[] = []
  for (let i = 0; i < moves.length && i < limit; i++) {
    const m = moves[i]
    const legal = g.legalMoves()
    if (!legal.includes(m)) break
    let prefix = ''
    if (g.turn === WHITE) prefix = `${g.pos.fullmove}.`
    else if (i === 0) prefix = `${g.pos.fullmove}…`
    parts.push(prefix + moveToSan(g.pos, m, legal))
    g.apply(m)
  }
  return parts.join(' ')
}

export { WHITE, KING }
