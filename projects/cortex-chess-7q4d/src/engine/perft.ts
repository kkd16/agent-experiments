// perft: count the leaf nodes of the move tree to a given depth. It's the gold
// standard for proving a move generator is bug-free — the counts below are the
// well-known reference values, so a match means castling, en passant, promotion
// and check evasion are all handled correctly.

import { type Position, type Undo, makeMoveOnBoard, unmakeMoveOnBoard } from './board'
import { generatePseudo, isSquareAttacked } from './movegen'

function newUndo(): Undo {
  return { captured: 0, capturedSq: -1, castling: 0, ep: -1, halfmove: 0, hash: 0n }
}

export function perft(p: Position, depth: number): number {
  if (depth === 0) return 1
  const moves: number[] = []
  generatePseudo(p, moves, false)
  const undo = newUndo()
  let nodes = 0
  for (const m of moves) {
    const us = p.turn
    makeMoveOnBoard(p, m, undo)
    if (!isSquareAttacked(p, p.kings[us], (us ^ 1) as 0 | 1)) {
      nodes += depth === 1 ? 1 : perft(p, depth - 1)
    }
    unmakeMoveOnBoard(p, m, undo)
  }
  return nodes
}

export interface PerftCase {
  name: string
  fen: string
  depth: number
  expected: number
}

// Standard perft suite (Chess Programming Wiki). Depths kept browser-friendly.
export const PERFT_SUITE: PerftCase[] = [
  { name: 'Starting position', fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', depth: 4, expected: 197281 },
  {
    name: 'Kiwipete',
    fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    depth: 3,
    expected: 97862,
  },
  { name: 'Position 3 (endgame)', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', depth: 5, expected: 674624 },
  {
    name: 'Position 4 (promotions)',
    fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
    depth: 4,
    expected: 422333,
  },
  {
    name: 'Position 5',
    fen: 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
    depth: 3,
    expected: 62379,
  },
]
