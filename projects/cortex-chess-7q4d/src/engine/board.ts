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

// The square the king lands on for a castle move (king-captures-rook encoding):
// always the g-file (kingside) or c-file (queenside) of the king's rank.
export function castleKingDest(kingFrom: number, rookFrom: number): number {
  const kingside = fileOf(rookFrom) > fileOf(kingFrom)
  return sq(kingside ? 6 : 2, rankOf(kingFrom))
}

// Index of each castling right inside `crook` (and the bit position in `castling`).
export const CR_IDX_WK = 0
export const CR_IDX_WQ = 1
export const CR_IDX_BK = 2
export const CR_IDX_BQ = 3

export interface Position {
  board: Int8Array // 128 entries, 0x88 layout
  turn: Color
  castling: number
  ep: number // en-passant target square, or -1
  halfmove: number
  fullmove: number
  kings: [number, number] // king square per color
  hash: bigint
  // Chess960 support. Castling is encoded as "king captures own rook" (a castle
  // move's `to` is the rook's origin square), which works uniformly for standard
  // chess and for the 960 starting positions where king and rooks sit on arbitrary
  // files. These three fields are game-constants — set once by `parseFen`, copied
  // by `clonePosition`, and never touched by make/unmake.
  chess960: boolean
  crook: Int8Array // rook origin square per right index (CR_IDX_*), or -1
  castleMask: Int8Array // per-square AND-mask that clears the rights a move at that square voids
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
    chess960: false,
    crook: Int8Array.of(-1, -1, -1, -1),
    castleMask: new Int8Array(128).fill(15),
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
    chess960: p.chess960,
    crook: Int8Array.from(p.crook),
    castleMask: Int8Array.from(p.castleMask),
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
  parseCastling(pos, castling)
  pos.ep = ep && ep !== '-' ? parseSquare(ep) : -1
  pos.halfmove = half ? parseInt(half, 10) : 0
  pos.fullmove = full ? parseInt(full, 10) : 1
  pos.hash = computeHash(pos)
  return pos
}

const RIGHT_BIT = [CR_WK, CR_WQ, CR_BK, CR_BQ]

// Parse the castling field, tolerant of standard letters (KQkq, the X-FEN form
// where K/Q name the *outermost* rook on the king's right/left) and Shredder-FEN
// file letters (e.g. "HAha", which name the rook file directly). Fills
// `pos.crook` (rook origin per right), `pos.castling`, `pos.chess960`, and the
// per-square `pos.castleMask` used by make/unmake to void rights.
function parseCastling(pos: Position, field: string | undefined): void {
  pos.crook = Int8Array.of(-1, -1, -1, -1)
  pos.castling = 0
  let is960 = false

  if (field && field !== '-') {
    for (const ch of field) {
      const color: Color = ch === ch.toUpperCase() ? WHITE : BLACK
      const rank = color === WHITE ? 0 : 7
      const kingSq = pos.kings[color]
      if (kingSq < 0) continue
      const kingFile = fileOf(kingSq)
      const ourRook = makePiece(color, ROOK)
      let rookFile = -1
      const up = ch.toUpperCase()
      if (up === 'K') {
        for (let f = 7; f > kingFile; f--) if (pos.board[sq(f, rank)] === ourRook) { rookFile = f; break }
      } else if (up === 'Q') {
        for (let f = 0; f < kingFile; f++) if (pos.board[sq(f, rank)] === ourRook) { rookFile = f; break }
      } else if (up >= 'A' && up <= 'H') {
        rookFile = up.charCodeAt(0) - 65
        is960 = true
      }
      if (rookFile < 0) continue
      const kingside = rookFile > kingFile
      const idx = color === WHITE ? (kingside ? CR_IDX_WK : CR_IDX_WQ) : (kingside ? CR_IDX_BK : CR_IDX_BQ)
      pos.crook[idx] = sq(rookFile, rank)
      pos.castling |= RIGHT_BIT[idx]
    }
  }

  // A non-standard king or castling-rook placement means we must round-trip the
  // castling field as Shredder-FEN file letters.
  if (pos.kings[WHITE] !== sq(4, 0) || pos.kings[BLACK] !== sq(4, 7)) is960 = true
  const stdRook = [sq(7, 0), sq(0, 0), sq(7, 7), sq(0, 7)]
  for (let i = 0; i < 4; i++) if (pos.crook[i] >= 0 && pos.crook[i] !== stdRook[i]) is960 = true
  pos.chess960 = is960

  buildCastleMask(pos)
}

// A move that touches a king's home square (king moves) voids both that side's
// rights; a move that touches a castling rook's home square (the rook moves, or
// it is captured) voids that single right. Encoded as a per-square AND-mask so
// make/unmake stays branch-light: `castling &= mask[from] & mask[to]`.
function buildCastleMask(pos: Position): void {
  const mask = new Int8Array(128).fill(15)
  if (pos.kings[WHITE] >= 0) mask[pos.kings[WHITE]] &= ~(CR_WK | CR_WQ) & 15
  if (pos.kings[BLACK] >= 0) mask[pos.kings[BLACK]] &= ~(CR_BK | CR_BQ) & 15
  for (let i = 0; i < 4; i++) if (pos.crook[i] >= 0) mask[pos.crook[i]] &= ~RIGHT_BIT[i] & 15
  pos.castleMask = mask
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
  if (p.chess960) {
    // Shredder-FEN: name each castling rook by its file (upper = white).
    if (p.castling & CR_WK) castling += FILES[fileOf(p.crook[CR_IDX_WK])].toUpperCase()
    if (p.castling & CR_WQ) castling += FILES[fileOf(p.crook[CR_IDX_WQ])].toUpperCase()
    if (p.castling & CR_BK) castling += FILES[fileOf(p.crook[CR_IDX_BK])]
    if (p.castling & CR_BQ) castling += FILES[fileOf(p.crook[CR_IDX_BQ])]
  } else {
    if (p.castling & CR_WK) castling += 'K'
    if (p.castling & CR_WQ) castling += 'Q'
    if (p.castling & CR_BK) castling += 'k'
    if (p.castling & CR_BQ) castling += 'q'
  }
  if (!castling) castling = '-'
  const ep = p.ep >= 0 ? squareName(p.ep) : '-'
  return `${placement} ${turn} ${castling} ${ep} ${p.halfmove} ${p.fullmove}`
}

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

  // Castling — encoded as "king captures own rook" (`to` is the rook's origin),
  // so it handles the standard squares and every 960 layout uniformly. Both home
  // squares are vacated before the destinations are filled, which is correct even
  // when a destination coincides with the other piece's origin.
  if (flag === FLAG_CASTLE) {
    const rank = rankOf(from)
    const kingside = fileOf(to) > fileOf(from)
    const kingTo = sq(kingside ? 6 : 2, rank)
    const rookTo = sq(kingside ? 5 : 3, rank)
    const rook = p.board[to]
    h ^= PIECE_KEYS[piece][from]
    h ^= PIECE_KEYS[rook][to]
    p.board[from] = EMPTY
    p.board[to] = EMPTY
    p.board[kingTo] = piece
    p.board[rookTo] = rook
    h ^= PIECE_KEYS[piece][kingTo]
    h ^= PIECE_KEYS[rook][rookTo]
    p.kings[us] = kingTo

    h ^= CASTLE_KEYS[p.castling]
    p.castling &= p.castleMask[from] & p.castleMask[to]
    h ^= CASTLE_KEYS[p.castling]

    p.ep = -1
    p.halfmove++
    if (us === BLACK) p.fullmove++
    p.turn = them
    h ^= SIDE_KEY
    p.hash = h
    return
  }

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

  // Update castling rights.
  h ^= CASTLE_KEYS[p.castling]
  p.castling &= p.castleMask[from] & p.castleMask[to]
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

  if (flag === FLAG_CASTLE) {
    // `from` = king origin, `to` = rook origin; reverse the relocation.
    const rank = rankOf(from)
    const kingside = fileOf(to) > fileOf(from)
    const kingTo = sq(kingside ? 6 : 2, rank)
    const rookTo = sq(kingside ? 5 : 3, rank)
    const king = p.board[kingTo]
    const rook = p.board[rookTo]
    p.board[kingTo] = EMPTY
    p.board[rookTo] = EMPTY
    p.board[from] = king
    p.board[to] = rook
    p.kings[us] = from
    p.castling = undo.castling
    p.ep = undo.ep
    p.halfmove = undo.halfmove
    p.hash = undo.hash
    return
  }

  // Restore the moving piece (un-promote if needed).
  const moved = p.board[to]
  const original = promo ? makePiece(us, PAWN) : moved
  p.board[from] = original
  p.board[to] = EMPTY

  if (pieceType(original) === KING) p.kings[us] = from

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
