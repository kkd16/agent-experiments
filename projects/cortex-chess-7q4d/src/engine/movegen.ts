// Pseudo-legal move generation for the 0x88 board, plus attack detection and a
// legal-move filter. Legality is enforced the simple, provably-correct way:
// generate pseudo-legal moves, make each one, and discard any that leave our own
// king in check.

import {
  type Position,
  type Move,
  type Color,
  WHITE,
  BLACK,
  PAWN,
  KNIGHT,
  BISHOP,
  ROOK,
  QUEEN,
  KING,
  EMPTY,
  CR_WK,
  CR_WQ,
  CR_BK,
  CR_BQ,
  CR_IDX_WK,
  CR_IDX_WQ,
  CR_IDX_BK,
  CR_IDX_BQ,
  FLAG_NORMAL,
  FLAG_DOUBLE,
  FLAG_EP,
  FLAG_CASTLE,
  makeMove,
  pieceColor,
  pieceType,
  rankOf,
  fileOf,
  isOnBoard,
  sq,
  makeMoveOnBoard,
  unmakeMoveOnBoard,
  type Undo,
} from './board'

const KNIGHT_OFFSETS = [-33, -31, -18, -14, 14, 18, 31, 33]
const KING_OFFSETS = [-17, -16, -15, -1, 1, 15, 16, 17]
const BISHOP_DIRS = [-17, -15, 15, 17]
const ROOK_DIRS = [-16, -1, 1, 16]

const PROMO_TYPES = [QUEEN, ROOK, BISHOP, KNIGHT]

export function isSquareAttacked(p: Position, target: number, by: Color): boolean {
  const board = p.board

  // Pawn attacks: a pawn of `by` attacks diagonally toward the enemy side.
  if (by === WHITE) {
    const a = target - 15
    const b = target - 17
    if (isOnBoard(a) && board[a] === ((WHITE << 3) | PAWN)) return true
    if (isOnBoard(b) && board[b] === ((WHITE << 3) | PAWN)) return true
  } else {
    const a = target + 15
    const b = target + 17
    if (isOnBoard(a) && board[a] === ((BLACK << 3) | PAWN)) return true
    if (isOnBoard(b) && board[b] === ((BLACK << 3) | PAWN)) return true
  }

  // Knights
  for (const off of KNIGHT_OFFSETS) {
    const s = target + off
    if (isOnBoard(s)) {
      const pc = board[s]
      if (pc !== EMPTY && pieceColor(pc) === by && pieceType(pc) === KNIGHT) return true
    }
  }

  // Kings
  for (const off of KING_OFFSETS) {
    const s = target + off
    if (isOnBoard(s)) {
      const pc = board[s]
      if (pc !== EMPTY && pieceColor(pc) === by && pieceType(pc) === KING) return true
    }
  }

  // Bishops / queens (diagonal rays)
  for (const dir of BISHOP_DIRS) {
    let s = target + dir
    while (isOnBoard(s)) {
      const pc = board[s]
      if (pc !== EMPTY) {
        if (pieceColor(pc) === by) {
          const t = pieceType(pc)
          if (t === BISHOP || t === QUEEN) return true
        }
        break
      }
      s += dir
    }
  }

  // Rooks / queens (orthogonal rays)
  for (const dir of ROOK_DIRS) {
    let s = target + dir
    while (isOnBoard(s)) {
      const pc = board[s]
      if (pc !== EMPTY) {
        if (pieceColor(pc) === by) {
          const t = pieceType(pc)
          if (t === ROOK || t === QUEEN) return true
        }
        break
      }
      s += dir
    }
  }

  return false
}

export function inCheck(p: Position, color: Color): boolean {
  return isSquareAttacked(p, p.kings[color], (color ^ 1) as Color)
}

function addPawnMove(moves: Move[], from: number, to: number, flag: number, promoRank: number): void {
  if (rankOf(to) === promoRank) {
    for (const promo of PROMO_TYPES) moves.push(makeMove(from, to, promo, flag))
  } else {
    moves.push(makeMove(from, to, 0, flag))
  }
}

// Generate pseudo-legal moves. When `capturesOnly` is set we emit only captures,
// en-passant and promotions — the move set the quiescence search needs.
export function generatePseudo(p: Position, moves: Move[], capturesOnly = false): void {
  const board = p.board
  const us = p.turn
  const them = (us ^ 1) as Color

  for (let from = 0; from < 128; from++) {
    if (!isOnBoard(from)) {
      from += 7 // skip the off-board half of the row
      continue
    }
    const piece = board[from]
    if (piece === EMPTY || pieceColor(piece) !== us) continue
    const type = pieceType(piece)

    if (type === PAWN) {
      const dir = us === WHITE ? 16 : -16
      const startRank = us === WHITE ? 1 : 6
      const promoRank = us === WHITE ? 7 : 0

      // Captures
      for (const cap of [from + dir - 1, from + dir + 1]) {
        if (!isOnBoard(cap)) continue
        const tpc = board[cap]
        if (tpc !== EMPTY && pieceColor(tpc) === them) {
          addPawnMove(moves, from, cap, FLAG_NORMAL, promoRank)
        } else if (cap === p.ep) {
          moves.push(makeMove(from, cap, 0, FLAG_EP))
        }
      }

      if (capturesOnly) {
        // Promotions are tactically important enough to include in quiescence.
        const one = from + dir
        if (isOnBoard(one) && board[one] === EMPTY && rankOf(one) === promoRank) {
          addPawnMove(moves, from, one, FLAG_NORMAL, promoRank)
        }
        continue
      }

      // Quiet pushes
      const one = from + dir
      if (isOnBoard(one) && board[one] === EMPTY) {
        addPawnMove(moves, from, one, FLAG_NORMAL, promoRank)
        const two = one + dir
        if (rankOf(from) === startRank && board[two] === EMPTY) {
          moves.push(makeMove(from, two, 0, FLAG_DOUBLE))
        }
      }
      continue
    }

    if (type === KNIGHT) {
      for (const off of KNIGHT_OFFSETS) {
        const to = from + off
        if (!isOnBoard(to)) continue
        const tpc = board[to]
        if (tpc === EMPTY) {
          if (!capturesOnly) moves.push(makeMove(from, to, 0, FLAG_NORMAL))
        } else if (pieceColor(tpc) === them) {
          moves.push(makeMove(from, to, 0, FLAG_NORMAL))
        }
      }
      continue
    }

    if (type === KING) {
      for (const off of KING_OFFSETS) {
        const to = from + off
        if (!isOnBoard(to)) continue
        const tpc = board[to]
        if (tpc === EMPTY) {
          if (!capturesOnly) moves.push(makeMove(from, to, 0, FLAG_NORMAL))
        } else if (pieceColor(tpc) === them) {
          moves.push(makeMove(from, to, 0, FLAG_NORMAL))
        }
      }
      if (!capturesOnly) generateCastles(p, moves)
      continue
    }

    // Sliding pieces
    const dirs = type === BISHOP ? BISHOP_DIRS : type === ROOK ? ROOK_DIRS : BISHOP_DIRS.concat(ROOK_DIRS)
    for (const dir of dirs) {
      let to = from + dir
      while (isOnBoard(to)) {
        const tpc = board[to]
        if (tpc === EMPTY) {
          if (!capturesOnly) moves.push(makeMove(from, to, 0, FLAG_NORMAL))
        } else {
          if (pieceColor(tpc) === them) moves.push(makeMove(from, to, 0, FLAG_NORMAL))
          break
        }
        to += dir
      }
    }
  }
}

// Every square on `rank` between squares `a` and `b` (inclusive) is empty,
// ignoring the king's own origin and the castling rook's origin (those two are
// allowed to sit anywhere on the path).
function castlePathClear(board: Int8Array, a: number, b: number, kingFrom: number, rookFrom: number): boolean {
  const rank = rankOf(a)
  const loF = Math.min(fileOf(a), fileOf(b))
  const hiF = Math.max(fileOf(a), fileOf(b))
  for (let f = loF; f <= hiF; f++) {
    const s = sq(f, rank)
    if (s === kingFrom || s === rookFrom) continue
    if (board[s] !== EMPTY) return false
  }
  return true
}

// No square the king passes over — start, every step, and destination — may be
// attacked (you may not castle out of, through, or into check).
function kingPathSafe(p: Position, from: number, to: number, them: Color): boolean {
  const rank = rankOf(from)
  const loF = Math.min(fileOf(from), fileOf(to))
  const hiF = Math.max(fileOf(from), fileOf(to))
  for (let f = loF; f <= hiF; f++) {
    if (isSquareAttacked(p, sq(f, rank), them)) return false
  }
  return true
}

// Chess960-general castling: king and rooks may start on arbitrary files. A
// castle is encoded as "king captures own rook" (the move's `to` is the rook's
// origin). The king always lands on the g-/c-file and the rook on the f-/d-file.
function generateCastles(p: Position, moves: Move[]): void {
  const us = p.turn
  const them = (us ^ 1) as Color
  const rights = us === WHITE ? CR_WK | CR_WQ : CR_BK | CR_BQ
  if ((p.castling & rights) === 0) return

  const board = p.board
  const kingFrom = p.kings[us]
  const rank = rankOf(kingFrom)
  if (isSquareAttacked(p, kingFrom, them)) return // cannot castle out of check

  const sides: [number, number, boolean][] =
    us === WHITE
      ? [
          [CR_WK, CR_IDX_WK, true],
          [CR_WQ, CR_IDX_WQ, false],
        ]
      : [
          [CR_BK, CR_IDX_BK, true],
          [CR_BQ, CR_IDX_BQ, false],
        ]

  for (const [rightBit, idx, kingside] of sides) {
    if ((p.castling & rightBit) === 0) continue
    const rookFrom = p.crook[idx]
    if (rookFrom < 0) continue
    const kingTo = sq(kingside ? 6 : 2, rank)
    const rookTo = sq(kingside ? 5 : 3, rank)
    if (!castlePathClear(board, kingFrom, kingTo, kingFrom, rookFrom)) continue
    if (!castlePathClear(board, rookFrom, rookTo, kingFrom, rookFrom)) continue
    if (!kingPathSafe(p, kingFrom, kingTo, them)) continue
    moves.push(makeMove(kingFrom, rookFrom, 0, FLAG_CASTLE))
  }
}

const scratchUndo: Undo = {
  captured: 0,
  capturedSq: -1,
  castling: 0,
  ep: -1,
  halfmove: 0,
  hash: 0n,
}

// True if a pseudo-legal move is fully legal (does not leave our king in check).
export function isLegal(p: Position, m: Move): boolean {
  const us = p.turn
  makeMoveOnBoard(p, m, scratchUndo)
  const ok = !isSquareAttacked(p, p.kings[us], (us ^ 1) as Color)
  unmakeMoveOnBoard(p, m, scratchUndo)
  return ok
}

export function generateLegal(p: Position): Move[] {
  const pseudo: Move[] = []
  generatePseudo(p, pseudo, false)
  const legal: Move[] = []
  for (const m of pseudo) if (isLegal(p, m)) legal.push(m)
  return legal
}
