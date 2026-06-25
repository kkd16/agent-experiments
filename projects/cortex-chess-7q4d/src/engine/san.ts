// Standard Algebraic Notation (SAN) generation, with disambiguation and
// check / checkmate suffixes — what the move list shows.

import {
  type Position,
  type Move,
  EMPTY,
  PAWN,
  KING,
  FLAG_EP,
  FLAG_CASTLE,
  moveFrom,
  moveTo,
  moveFlag,
  movePromo,
  pieceType,
  fileOf,
  rankOf,
  squareName,
  makeMoveOnBoard,
  unmakeMoveOnBoard,
  type Undo,
} from './board'
import { generateLegal, inCheck } from './movegen'

const PIECE_LETTER = ['', '', 'N', 'B', 'R', 'Q', 'K']
const FILES = 'abcdefgh'

function newUndo(): Undo {
  return { captured: 0, capturedSq: -1, castling: 0, ep: -1, halfmove: 0, hash: 0n }
}

export function moveToSan(pos: Position, move: Move, legal: Move[]): string {
  const from = moveFrom(move)
  const to = moveTo(move)
  const flag = moveFlag(move)
  const promo = movePromo(move)
  const piece = pos.board[from]
  const type = pieceType(piece)

  let san: string
  if (flag === FLAG_CASTLE) {
    san = fileOf(to) === 6 ? 'O-O' : 'O-O-O'
  } else {
    const isCapture = flag === FLAG_EP || pos.board[to] !== EMPTY
    if (type === PAWN) {
      san = isCapture ? `${FILES[fileOf(from)]}x${squareName(to)}` : squareName(to)
      if (promo) san += '=' + PIECE_LETTER[promo]
    } else {
      // Disambiguate against other identical pieces that can reach `to`.
      let sameFile = false
      let sameRank = false
      let ambiguous = false
      for (const other of legal) {
        if (other === move) continue
        if (moveTo(other) !== to) continue
        const ofrom = moveFrom(other)
        if (pieceType(pos.board[ofrom]) !== type) continue
        ambiguous = true
        if (fileOf(ofrom) === fileOf(from)) sameFile = true
        if (rankOf(ofrom) === rankOf(from)) sameRank = true
      }
      let disambig = ''
      if (ambiguous) {
        if (!sameFile) disambig = FILES[fileOf(from)]
        else if (!sameRank) disambig = String(rankOf(from) + 1)
        else disambig = squareName(from)
      }
      san = PIECE_LETTER[type] + disambig + (isCapture ? 'x' : '') + squareName(to)
    }
  }

  // Check / checkmate suffix.
  const undo = newUndo()
  makeMoveOnBoard(pos, move, undo)
  const opponent = pos.turn
  if (inCheck(pos, opponent)) {
    san += generateLegal(pos).length === 0 ? '#' : '+'
  }
  unmakeMoveOnBoard(pos, move, undo)

  return san
}

export { PIECE_LETTER, KING }
