// Static Exchange Evaluation (SEE).
//
// Given a capture, SEE plays out the full sequence of captures on the target
// square — each side always recapturing with its least valuable attacker — and
// returns the net material the side to move wins (or loses). It is the standard
// way to tell a winning capture (QxP defended by a pawn is bad; RxN hanging is
// good) from a losing one without searching, and drives both capture ordering
// and the "don't bother searching losing captures" pruning in quiescence.
//
// The implementation works directly on the 0x88 mailbox: a reusable scratch copy
// of the board is mutated as pieces leave their squares, so sliding x-rays (a
// rook behind a rook, a bishop behind a queen) are revealed automatically when
// the piece in front is removed.

import {
  type Position,
  type Move,
  type Color,
  WHITE,
  PAWN,
  KNIGHT,
  BISHOP,
  ROOK,
  QUEEN,
  KING,
  EMPTY,
  FLAG_EP,
  isOnBoard,
  pieceColor,
  pieceType,
  moveFrom,
  moveTo,
  moveFlag,
  movePromo,
} from './board'

// Exchange values by piece type 1..6. The king is given a huge value so it is
// only ever used as the last attacker (and never into a defended square).
export const SEE_VALUE = [0, 100, 320, 330, 500, 900, 10000]

const KNIGHT_OFFSETS = [-33, -31, -18, -14, 14, 18, 31, 33]
const KING_OFFSETS = [-17, -16, -15, -1, 1, 15, 16, 17]
const BISHOP_DIRS = [-17, -15, 15, 17]
const ROOK_DIRS = [-16, -1, 1, 16]

// Reused across calls so SEE allocates nothing in the hot path.
const scratch = new Int8Array(128)

// Least valuable piece of `side` that attacks `to` on the scratch board, or -1.
// Returns the square; the type can be read from scratch[sq]. Sliding rays stop
// at the first occupied square so removed pieces correctly expose x-rays.
function leastValuableAttacker(to: number, side: Color): number {
  let bestType = 99
  let bestSq = -1

  // Pawns: a pawn of `side` attacks `to` from one rank toward its own side.
  const p0 = side === WHITE ? to - 15 : to + 15
  const p1 = side === WHITE ? to - 17 : to + 17
  for (const s of [p0, p1]) {
    if (isOnBoard(s)) {
      const pc = scratch[s]
      if (pc !== EMPTY && pieceColor(pc) === side && pieceType(pc) === PAWN) {
        bestType = PAWN
        bestSq = s
      }
    }
  }
  if (bestType === PAWN) return bestSq

  // Knights
  for (const off of KNIGHT_OFFSETS) {
    const s = to + off
    if (isOnBoard(s)) {
      const pc = scratch[s]
      if (pc !== EMPTY && pieceColor(pc) === side && pieceType(pc) === KNIGHT) {
        bestType = KNIGHT
        bestSq = s
      }
    }
  }
  if (bestType === KNIGHT) return bestSq

  // Bishops / queens on diagonals (queen only beats the type race if no bishop).
  for (const dir of BISHOP_DIRS) {
    let s = to + dir
    while (isOnBoard(s)) {
      const pc = scratch[s]
      if (pc !== EMPTY) {
        if (pieceColor(pc) === side) {
          const t = pieceType(pc)
          if ((t === BISHOP || t === QUEEN) && t < bestType) {
            bestType = t
            bestSq = s
          }
        }
        break
      }
      s += dir
    }
  }

  // Rooks / queens on files and ranks.
  for (const dir of ROOK_DIRS) {
    let s = to + dir
    while (isOnBoard(s)) {
      const pc = scratch[s]
      if (pc !== EMPTY) {
        if (pieceColor(pc) === side) {
          const t = pieceType(pc)
          if ((t === ROOK || t === QUEEN) && t < bestType) {
            bestType = t
            bestSq = s
          }
        }
        break
      }
      s += dir
    }
  }
  if (bestSq >= 0) return bestSq

  // King — only attacks adjacent squares, used last.
  for (const off of KING_OFFSETS) {
    const s = to + off
    if (isOnBoard(s)) {
      const pc = scratch[s]
      if (pc !== EMPTY && pieceColor(pc) === side && pieceType(pc) === KING) {
        return s
      }
    }
  }
  return -1
}

// Net material the side to move gains by playing `move`, in centipawns. Quiet
// (non-capturing) moves return 0. Promotions are valued by the queen's gain.
export function see(p: Position, move: Move): number {
  const from = moveFrom(move)
  const to = moveTo(move)
  const flag = moveFlag(move)
  const promo = movePromo(move)
  const us = p.turn

  let captured: number
  if (flag === FLAG_EP) captured = PAWN
  else if (p.board[to] === EMPTY) captured = 0
  else captured = pieceType(p.board[to])

  if (captured === 0 && promo === 0) return 0

  scratch.set(p.board)

  // Apply the initial capture on the scratch board.
  const epSq = flag === FLAG_EP ? to - (us === WHITE ? 16 : -16) : -1
  if (epSq >= 0) scratch[epSq] = EMPTY
  scratch[from] = EMPTY

  let attackerType = pieceType(p.board[from])
  // Promotion: the pawn becomes (effectively) a queen sitting on `to`, and the
  // gain bumps by the promotion value difference.
  let promoBonus = 0
  if (promo) {
    promoBonus = SEE_VALUE[promo] - SEE_VALUE[PAWN]
    attackerType = promo
  }

  const gain: number[] = []
  let d = 0
  gain[0] = SEE_VALUE[captured] + promoBonus
  let onSquare = SEE_VALUE[attackerType]
  let side: Color = (us ^ 1) as Color

  for (;;) {
    const fromSq = leastValuableAttacker(to, side)
    if (fromSq < 0) break

    const t = pieceType(scratch[fromSq])
    // The king may not capture into a square the other side still attacks.
    if (t === KING && leastValuableAttacker(to, (side ^ 1) as Color) >= 0) break

    d++
    gain[d] = onSquare - gain[d - 1]
    onSquare = SEE_VALUE[t]
    scratch[fromSq] = EMPTY
    side = (side ^ 1) as Color
  }

  // Minimax the gain stack back to the root: at each step the side to move can
  // stop capturing if continuing would lose material.
  while (--d >= 0) {
    gain[d] = -Math.max(-gain[d], gain[d + 1])
  }
  return gain[0]
}
