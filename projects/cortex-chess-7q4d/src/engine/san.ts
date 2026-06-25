// Standard Algebraic Notation (SAN) generation, with disambiguation and
// check / checkmate suffixes — what the move list shows.

import {
  type Position,
  type Move,
  EMPTY,
  PAWN,
  QUEEN,
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

const PIECE_FROM_LETTER: Record<string, number> = { N: 2, B: 3, R: 4, Q: 5, K: 6 }

// Parse a SAN token (e.g. "Nf3", "exd5", "O-O", "e8=Q+", "Qh4xe1#") into the
// matching legal Move in `pos`, or null if it doesn't resolve. We parse the
// token *structurally* (piece, optional from-file / from-rank disambiguators,
// destination, promotion) and then match it against the legal move list, so the
// parser tolerates the real-world sloppiness that a strict canonical-string
// compare would reject: missing "=" before a promotion, over-specified
// disambiguation (e.g. "Qh4e1" where "Qe1" was enough), zeros for castling, and
// trailing check / annotation glyphs.
export function sanToMove(pos: Position, san: string): Move | null {
  const s = san.trim().replace(/e\.p\.?/i, '').replace(/[+#!?]+$/g, '').replace(/0/g, 'O')
  if (!s) return null

  const legal = generateLegal(pos)

  // Castling.
  if (s === 'O-O' || s === 'O-O-O') {
    const kingside = s === 'O-O'
    for (const m of legal) {
      if (moveFlag(m) === FLAG_CASTLE && (fileOf(moveTo(m)) === 6) === kingside) return m
    }
    return null
  }

  const match = /^([NBRQK])?([a-h])?([1-8])?x?([a-h][1-8])(?:=?([NBRQ]))?$/.exec(s)
  if (!match) return null
  const [, pieceLetter, fromFile, fromRank, destName, promoLetter] = match

  const type = pieceLetter ? PIECE_FROM_LETTER[pieceLetter] : PAWN
  const dest = (destName.charCodeAt(0) - 97) + (destName.charCodeAt(1) - 49) * 16
  const ff = fromFile ? fromFile.charCodeAt(0) - 97 : -1
  const fr = fromRank ? fromRank.charCodeAt(0) - 49 : -1
  const promo = promoLetter ? PIECE_FROM_LETTER[promoLetter] : 0

  let found: Move | null = null
  for (const m of legal) {
    if (moveTo(m) !== dest) continue
    const from = moveFrom(m)
    if (pieceType(pos.board[from]) !== type) continue
    if (ff >= 0 && fileOf(from) !== ff) continue
    if (fr >= 0 && rankOf(from) !== fr) continue
    const mp = movePromo(m)
    if (promo) {
      if (mp !== promo) continue
    } else if (mp && mp !== QUEEN) {
      // Promotion with no piece named in the token → default to a queen.
      continue
    }
    if (found !== null) return null // genuinely ambiguous — refuse rather than guess
    found = m
  }
  return found
}

export { PIECE_LETTER, KING }
