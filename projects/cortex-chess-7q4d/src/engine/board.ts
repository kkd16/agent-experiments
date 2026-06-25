// Board representation: classic 0x88 mailbox.
//
//   square = rank * 16 + file        (file 0..7 = a..h, rank 0..7 = 1..8)
//   off-board test: (square & 0x88) !== 0
//
// Pieces are encoded as (color << 3) | type, so `piece >> 3` is the color and
// `piece & 7` is the type. Empty squares are 0. This keeps move generation and
// hashing branch-light.

import { PIECE_KEYS, CASTLE_KEYS, EP_FILE_KEYS, SIDE_KEY } from './zobrist'

export const WHITE = 0
export const BLACK = 1
export type Color = 0 | 1

export const PAWN = 1
export const KNIGHT = 2
export const BISHOP = 3
export const ROOK = 4
export const QUEEN = 5
export const KING = 6

export const EMPTY = 0

export function makePiece(color: Color, type: number): number {
  return (color << 3) | type
}
export function pieceColor(p: number): Color {
  return (p >> 3) as Color
}
export function pieceType(p: number): number {
  return p & 7
}

// Castling-rights bitmask
export const CR_WK = 1
export const CR_WQ = 2
export const CR_BK = 4
export const CR_BQ = 8

// Square helpers
export function sq(file: number, rank: number): number {
  return rank * 16 + file
}
export function fileOf(s: number): number {
  return s & 7
}
export function rankOf(s: number): number {
  return s >> 4
}
export function isOnBoard(s: number): boolean {
  return (s & 0x88) === 0
}

const FILES = 'abcdefgh'
export function squareName(s: number): string {
  return FILES[fileOf(s)] + (rankOf(s) + 1)
}
export function parseSquare(name: string): number {
  const f = FILES.indexOf(name[0])
  const r = parseInt(name[1], 10) - 1
  return sq(f, r)
}

// Move flags
export const FLAG_NORMAL = 0
export const FLAG_DOUBLE = 1
export const FLAG_EP = 2
export const FLAG_CASTLE = 3

// A move is packed into a single 32-bit integer:
//   from (7) | to (7) | promotion type (3) | flag (3)
export type Move = number
export function makeMove(from: number, to: number, promo: number, flag: number): Move {
  return from | (to << 7) | (promo << 14) | (flag << 17)
}
export function moveFrom(m: Move): number {
  return m & 0x7f
}
export function moveTo(m: Move): number {
  return (m >> 7) & 0x7f
}
export function movePromo(m: Move): number {
  return (m >> 14) & 7
}
export function moveFlag(m: Move): number {
  return (m >> 17) & 7
}

export interface Position {
  board: Int8Array // 128 entries, 0x88 layout
  turn: Color
  castling: number
  ep: number // en-passant target square, or -1
  halfmove: number
  fullmove: number
  kings: [number, number] // king square per color
  hash: bigint
}

// Stored on the undo stack so make/unmake is allocation-free during search.
export interface Undo {
  captured: number
  capturedSq: number // where the captured piece sat (differs from `to` on en passant)
  castling: number
  ep: number
  halfmove: number
  hash: bigint
}

export function emptyPosition(): Position {
  return {
    board: new Int8Array(128),
    turn: WHITE,
    castling: 0,
    ep: -1,
    halfmove: 0,
    fullmove: 1,
    kings: [-1, -1],
    hash: 0n,
  }
}

export function clonePosition(p: Position): Position {
  return {
    board: Int8Array.from(p.board),
    turn: p.turn,
    castling: p.castling,
    ep: p.ep,
    halfmove: p.halfmove,
    fullmove: p.fullmove,
    kings: [p.kings[0], p.kings[1]],
    hash: p.hash,
  }
}

export function computeHash(p: Position): bigint {
  let h = 0n
  for (let s = 0; s < 128; s++) {
    if (!isOnBoard(s)) continue
    const piece = p.board[s]
    if (piece !== EMPTY) h ^= PIECE_KEYS[piece][s]
  }
  h ^= CASTLE_KEYS[p.castling]
  if (p.ep >= 0) h ^= EP_FILE_KEYS[fileOf(p.ep)]
  if (p.turn === BLACK) h ^= SIDE_KEY
  return h
}

const PIECE_FROM_CHAR: Record<string, number> = {
  P: makePiece(WHITE, PAWN),
  N: makePiece(WHITE, KNIGHT),
  B: makePiece(WHITE, BISHOP),
  R: makePiece(WHITE, ROOK),
  Q: makePiece(WHITE, QUEEN),
  K: makePiece(WHITE, KING),
  p: makePiece(BLACK, PAWN),
  n: makePiece(BLACK, KNIGHT),
  b: makePiece(BLACK, BISHOP),
  r: makePiece(BLACK, ROOK),
  q: makePiece(BLACK, QUEEN),
  k: makePiece(BLACK, KING),
}
const CHAR_FROM_PIECE: Record<number, string> = Object.fromEntries(
  Object.entries(PIECE_FROM_CHAR).map(([c, p]) => [p, c]),
)

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

export function parseFen(fen: string): Position {
  const pos = emptyPosition()
  const parts = fen.trim().split(/\s+/)
  const [placement, turn, castling, ep, half, full] = parts

  let rank = 7
  let file = 0
  for (const ch of placement) {
    if (ch === '/') {
      rank--
      file = 0
    } else if (ch >= '1' && ch <= '8') {
      file += ch.charCodeAt(0) - 48
    } else {
      const piece = PIECE_FROM_CHAR[ch]
      const s = sq(file, rank)
      pos.board[s] = piece
      if (pieceType(piece) === KING) pos.kings[pieceColor(piece)] = s
      file++
    }
  }

  pos.turn = turn === 'b' ? BLACK : WHITE
  pos.castling =
    (castling.includes('K') ? CR_WK : 0) |
    (castling.includes('Q') ? CR_WQ : 0) |
    (castling.includes('k') ? CR_BK : 0) |
    (castling.includes('q') ? CR_BQ : 0)
  pos.ep = ep && ep !== '-' ? parseSquare(ep) : -1
  pos.halfmove = half ? parseInt(half, 10) : 0
  pos.fullmove = full ? parseInt(full, 10) : 1
  pos.hash = computeHash(pos)
  return pos
}

export function toFen(p: Position): string {
  let placement = ''
  for (let rank = 7; rank >= 0; rank--) {
    let empty = 0
    for (let file = 0; file < 8; file++) {
      const piece = p.board[sq(file, rank)]
      if (piece === EMPTY) {
        empty++
      } else {
        if (empty) {
          placement += empty
          empty = 0
        }
        placement += CHAR_FROM_PIECE[piece]
      }
    }
    if (empty) placement += empty
    if (rank > 0) placement += '/'
  }
  const turn = p.turn === WHITE ? 'w' : 'b'
  let castling = ''
  if (p.castling & CR_WK) castling += 'K'
  if (p.castling & CR_WQ) castling += 'Q'
  if (p.castling & CR_BK) castling += 'k'
  if (p.castling & CR_BQ) castling += 'q'
  if (!castling) castling = '-'
  const ep = p.ep >= 0 ? squareName(p.ep) : '-'
  return `${placement} ${turn} ${castling} ${ep} ${p.halfmove} ${p.fullmove}`
}

// Castling rights are cleared when a king or rook leaves its home square (or a
// home rook is captured). This lookup zeroes the relevant bits by from/to square.
const CASTLE_MASK = new Int8Array(128).fill(15)
CASTLE_MASK[sq(4, 0)] = ~(CR_WK | CR_WQ) & 15 // e1
CASTLE_MASK[sq(0, 0)] = ~CR_WQ & 15 // a1
CASTLE_MASK[sq(7, 0)] = ~CR_WK & 15 // h1
CASTLE_MASK[sq(4, 7)] = ~(CR_BK | CR_BQ) & 15 // e8
CASTLE_MASK[sq(0, 7)] = ~CR_BQ & 15 // a8
CASTLE_MASK[sq(7, 7)] = ~CR_BK & 15 // h8

export function makeMoveOnBoard(p: Position, m: Move, undo: Undo): void {
  const from = moveFrom(m)
  const to = moveTo(m)
  const flag = moveFlag(m)
  const promo = movePromo(m)
  const piece = p.board[from]
  const us = p.turn
  const them = (us ^ 1) as Color

  undo.castling = p.castling
  undo.ep = p.ep
  undo.halfmove = p.halfmove
  undo.hash = p.hash
  undo.captured = EMPTY
  undo.capturedSq = -1

  let h = p.hash

  // Clear the previous en-passant file from the hash.
  if (p.ep >= 0) h ^= EP_FILE_KEYS[fileOf(p.ep)]

  // Remove a captured piece (en passant captures behind the target square).
  if (flag === FLAG_EP) {
    const capSq = to - (us === WHITE ? 16 : -16)
    undo.captured = p.board[capSq]
    undo.capturedSq = capSq
    h ^= PIECE_KEYS[undo.captured][capSq]
    p.board[capSq] = EMPTY
  } else if (p.board[to] !== EMPTY) {
    undo.captured = p.board[to]
    undo.capturedSq = to
    h ^= PIECE_KEYS[undo.captured][to]
  }

  // Move the piece (promotion swaps in the promoted type).
  h ^= PIECE_KEYS[piece][from]
  p.board[from] = EMPTY
  const moved = promo ? makePiece(us, promo) : piece
  p.board[to] = moved
  h ^= PIECE_KEYS[moved][to]

  if (pieceType(piece) === KING) p.kings[us] = to

  // Move the rook when castling.
  if (flag === FLAG_CASTLE) {
    const rank = us === WHITE ? 0 : 7
    const kingside = fileOf(to) === 6
    const rookFrom = sq(kingside ? 7 : 0, rank)
    const rookTo = sq(kingside ? 5 : 3, rank)
    const rook = p.board[rookFrom]
    p.board[rookFrom] = EMPTY
    p.board[rookTo] = rook
    h ^= PIECE_KEYS[rook][rookFrom]
    h ^= PIECE_KEYS[rook][rookTo]
  }

  // Update castling rights.
  h ^= CASTLE_KEYS[p.castling]
  p.castling &= CASTLE_MASK[from] & CASTLE_MASK[to]
  h ^= CASTLE_KEYS[p.castling]

  // Set a new en-passant target on a double pawn push.
  if (flag === FLAG_DOUBLE) {
    p.ep = (from + to) >> 1
    h ^= EP_FILE_KEYS[fileOf(p.ep)]
  } else {
    p.ep = -1
  }

  // Halfmove clock (reset on pawn move or capture).
  if (pieceType(piece) === PAWN || undo.captured !== EMPTY) p.halfmove = 0
  else p.halfmove++

  if (us === BLACK) p.fullmove++

  p.turn = them
  h ^= SIDE_KEY
  p.hash = h
}

export function unmakeMoveOnBoard(p: Position, m: Move, undo: Undo): void {
  const from = moveFrom(m)
  const to = moveTo(m)
  const flag = moveFlag(m)
  const promo = movePromo(m)
  const them = p.turn
  const us = (them ^ 1) as Color

  p.turn = us
  if (us === BLACK) p.fullmove--

  // Restore the moving piece (un-promote if needed).
  const moved = p.board[to]
  const original = promo ? makePiece(us, PAWN) : moved
  p.board[from] = original
  p.board[to] = EMPTY

  if (pieceType(original) === KING) p.kings[us] = from

  // Restore the rook on castling.
  if (flag === FLAG_CASTLE) {
    const rank = us === WHITE ? 0 : 7
    const kingside = fileOf(to) === 6
    const rookFrom = sq(kingside ? 7 : 0, rank)
    const rookTo = sq(kingside ? 5 : 3, rank)
    p.board[rookFrom] = p.board[rookTo]
    p.board[rookTo] = EMPTY
  }

  // Restore a captured piece.
  if (undo.captured !== EMPTY) p.board[undo.capturedSq] = undo.captured

  p.castling = undo.castling
  p.ep = undo.ep
  p.halfmove = undo.halfmove
  p.hash = undo.hash
}

// A null move (pass the turn) is used for null-move pruning in the search.
export function makeNullMove(p: Position, undo: Undo): void {
  undo.castling = p.castling
  undo.ep = p.ep
  undo.halfmove = p.halfmove
  undo.hash = p.hash
  undo.captured = EMPTY
  undo.capturedSq = -1

  let h = p.hash
  if (p.ep >= 0) h ^= EP_FILE_KEYS[fileOf(p.ep)]
  p.ep = -1
  p.turn = (p.turn ^ 1) as Color
  h ^= SIDE_KEY
  p.hash = h
}

export function unmakeNullMove(p: Position, undo: Undo): void {
  p.turn = (p.turn ^ 1) as Color
  p.ep = undo.ep
  p.castling = undo.castling
  p.halfmove = undo.halfmove
  p.hash = undo.hash
}
