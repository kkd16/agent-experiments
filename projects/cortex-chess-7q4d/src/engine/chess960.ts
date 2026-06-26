// Chess960 (Fischer Random) start-position numbering — the Scharnagl scheme used
// everywhere (lichess, the FIDE handbook, the SP-ID you see on a Chess960 game).
// Each of the 960 legal back-rank arrangements maps to a unique id 0..959, with
// id 518 = the standard RNBQKBNR set-up. This module converts an id to a back
// rank (and a full FEN) and back, and rolls a random legal position.
//
// A back rank is legal iff the two bishops sit on opposite-coloured squares and
// the king stands between the two rooks. The numbering enumerates exactly those.

const FILES = 'abcdefgh'

// Place `piece` on the `nth` (0-indexed) still-empty file of `rank`.
function placeOnNthEmpty(rank: string[], nth: number, piece: string): void {
  let seen = -1
  for (let f = 0; f < 8; f++) {
    if (rank[f] === '') {
      seen++
      if (seen === nth) {
        rank[f] = piece
        return
      }
    }
  }
}

// The 10 ways to choose two of the five squares left for the knights, in the
// canonical Scharnagl order (the "KRN code").
const KNIGHT_PAIRS: [number, number][] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
  [1, 2],
  [1, 3],
  [1, 4],
  [2, 3],
  [2, 4],
  [3, 4],
]

// The back rank (white pieces, uppercase, files a→h) for Scharnagl id 0..959.
export function backRankForId(id: number): string {
  const n0 = ((id % 960) + 960) % 960
  const rank: string[] = ['', '', '', '', '', '', '', '']

  let n = n0
  const lightBishop = n % 4 // light squares are files 1,3,5,7
  n = Math.floor(n / 4)
  rank[2 * lightBishop + 1] = 'B'

  const darkBishop = n % 4 // dark squares are files 0,2,4,6
  n = Math.floor(n / 4)
  rank[2 * darkBishop] = 'B'

  const queenSlot = n % 6 // among the 6 remaining squares
  n = Math.floor(n / 6)
  placeOnNthEmpty(rank, queenSlot, 'Q')

  const [k1, k2] = KNIGHT_PAIRS[n] // n is now 0..9
  // Place both knights; do the later index first so placing the first doesn't
  // shift the "nth empty" reference for the second.
  placeOnNthEmpty(rank, k2, 'N')
  placeOnNthEmpty(rank, k1, 'N')

  // The three leftover squares receive R, K, R left-to-right — so the king is
  // always between the rooks, as Chess960 requires.
  placeOnNthEmpty(rank, 0, 'R')
  placeOnNthEmpty(rank, 0, 'K')
  placeOnNthEmpty(rank, 0, 'R')

  return rank.join('')
}

// Inverse of backRankForId: the Scharnagl id of a legal back rank, or -1 if the
// arrangement is not a legal Chess960 set-up.
export function idForBackRank(br: string): number {
  if (br.length !== 8) return -1
  const bishops: number[] = []
  const knights: number[] = []
  const rooks: number[] = []
  let queen = -1
  let king = -1
  for (let f = 0; f < 8; f++) {
    switch (br[f]) {
      case 'B':
        bishops.push(f)
        break
      case 'N':
        knights.push(f)
        break
      case 'R':
        rooks.push(f)
        break
      case 'Q':
        queen = f
        break
      case 'K':
        king = f
        break
      default:
        return -1
    }
  }
  if (bishops.length !== 2 || knights.length !== 2 || rooks.length !== 2 || queen < 0 || king < 0) return -1
  const [b0, b1] = bishops
  if ((b0 + b1) % 2 === 0) return -1 // bishops must be on opposite colours
  if (!(rooks[0] < king && king < rooks[1])) return -1 // king between the rooks

  const light = b0 % 2 === 1 ? b0 : b1
  const dark = b0 % 2 === 0 ? b0 : b1
  const lightBishop = (light - 1) / 2
  const darkBishop = dark / 2

  // Queen index among the squares empty after the bishops are placed.
  const emptyAfterBishops: number[] = []
  for (let f = 0; f < 8; f++) if (f !== light && f !== dark) emptyAfterBishops.push(f)
  const queenSlot = emptyAfterBishops.indexOf(queen)

  // Knight pair among the five squares empty after bishops + queen are placed.
  const emptyAfterQueen = emptyAfterBishops.filter((f) => f !== queen)
  const ki = [emptyAfterQueen.indexOf(knights[0]), emptyAfterQueen.indexOf(knights[1])].sort((a, b) => a - b)
  const krn = KNIGHT_PAIRS.findIndex((p) => p[0] === ki[0] && p[1] === ki[1])
  if (krn < 0 || queenSlot < 0) return -1

  return lightBishop + 4 * (darkBishop + 4 * (queenSlot + 6 * krn))
}

// The Shredder-FEN castling field (file letters) for a back rank: uppercase for
// white, lowercase for black, kingside (higher-file) rook first.
function castleField(br: string): string {
  const rookFiles: number[] = []
  for (let f = 0; f < 8; f++) if (br[f] === 'R') rookFiles.push(f)
  const [lo, hi] = [Math.min(...rookFiles), Math.max(...rookFiles)]
  const u = FILES.toUpperCase()
  return `${u[hi]}${u[lo]}${FILES[hi]}${FILES[lo]}`
}

// A full starting FEN for Scharnagl id 0..959.
export function startFenForId(id: number): string {
  const br = backRankForId(id)
  const black = br.toLowerCase()
  const castle = castleField(br)
  return `${black}/pppppppp/8/8/8/8/PPPPPPPP/${br} w ${castle} - 0 1`
}

// A starting FEN for Double Fischer Random Chess (DFRC): white and black get
// independent back ranks. The engine tracks castling rights per side, so this
// needs no special-casing beyond emitting the two ranks — it falls straight out
// of the Chess960 castling code.
export function startFenForDfrc(idWhite: number, idBlack: number): string {
  const w = backRankForId(idWhite)
  const b = backRankForId(idBlack)
  return `${b.toLowerCase()}/pppppppp/8/8/8/8/PPPPPPPP/${w} w ${castleField(w)}${castleField(b).toLowerCase()} - 0 1`
}

// A uniformly-random Chess960 id (and its FEN). `rnd` defaults to Math.random so
// callers in a worker / test can inject a deterministic source.
export function randomStartId(rnd: () => number = Math.random): number {
  return Math.floor(rnd() * 960)
}

export const STANDARD_ID = 518

// ---------------- self-verification ----------------

import {
  type Position,
  type Undo,
  parseFen,
  toFen,
  computeHash,
  makeMoveOnBoard,
  unmakeMoveOnBoard,
  moveFrom,
  moveTo,
  moveFlag,
  fileOf,
  rankOf,
  sq,
  makePiece,
  WHITE,
  EMPTY,
  KING,
  ROOK,
  FLAG_CASTLE,
} from './board'
import { generateLegal, isSquareAttacked } from './movegen'
import { perft } from './perft'

export interface Chess960Check {
  name: string
  pass: boolean
  detail: string
}

// An independent re-derivation of the legal castle moves, written from a
// different angle than the move generator (explicit square spans + a from-scratch
// post-move king-safety test on a copied board). Returns sorted "from-to" keys.
function refCastleKeys(p: Position): string[] {
  const us = p.turn
  const them = (us ^ 1) as 0 | 1
  const out: string[] = []
  const kingFrom = p.kings[us]
  if (isSquareAttacked(p, kingFrom, them)) return out
  const rank = rankOf(kingFrom)
  const rights: [number, number, boolean][] =
    us === WHITE
      ? [
          [1, 0, true],
          [2, 1, false],
        ]
      : [
          [4, 2, true],
          [8, 3, false],
        ]
  const span = (a: number, b: number): number[] => {
    const r: number[] = []
    const lo = Math.min(fileOf(a), fileOf(b))
    const hi = Math.max(fileOf(a), fileOf(b))
    for (let f = lo; f <= hi; f++) r.push(sq(f, rank))
    return r
  }
  for (const [bit, idx, kingside] of rights) {
    if ((p.castling & bit) === 0) continue
    const rookFrom = p.crook[idx]
    if (rookFrom < 0) continue
    const kingTo = sq(kingside ? 6 : 2, rank)
    const rookTo = sq(kingside ? 5 : 3, rank)
    const need = [...new Set([...span(kingFrom, kingTo), ...span(rookFrom, rookTo)])].filter(
      (s) => s !== kingFrom && s !== rookFrom,
    )
    if (need.some((s) => p.board[s] !== EMPTY)) continue
    if (span(kingFrom, kingTo).some((s) => isSquareAttacked(p, s, them))) continue
    const b = Int8Array.from(p.board)
    b[kingFrom] = EMPTY
    b[rookFrom] = EMPTY
    b[kingTo] = makePiece(us, KING)
    b[rookTo] = makePiece(us, ROOK)
    const tmp: Position = { ...p, board: b, kings: [p.kings[0], p.kings[1]] }
    tmp.kings[us] = kingTo
    if (isSquareAttacked(tmp, kingTo, them)) continue
    out.push(kingFrom + '-' + rookFrom)
  }
  return out.sort()
}

function engineCastleKeys(p: Position): string[] {
  return generateLegal(p)
    .filter((m) => moveFlag(m) === FLAG_CASTLE)
    .map((m) => moveFrom(m) + '-' + moveTo(m))
    .sort()
}

// Mirror a FEN: flip ranks and swap colours. Perft must be invariant.
function mirrorFen(fen: string): string {
  const [pl, stm, cs, ep, hm, fm] = fen.split(/\s+/)
  const rows = pl
    .split('/')
    .reverse()
    .map((r) => [...r].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join(''))
  const ncs = cs === '-' ? '-' : [...cs].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('')
  const nstm = stm === 'w' ? 'b' : 'w'
  const nep = ep === '-' ? '-' : ep[0] + (9 - Number(ep[1]))
  return `${rows.join('/')} ${nstm} ${ncs} ${nep} ${hm} ${fm}`
}

// A self-contained correctness suite for the whole Chess960 layer. Every check is
// an exact oracle — no external reference tables needed.
export function chess960Selftest(): Chess960Check[] {
  const out: Chess960Check[] = []

  // 1. id <-> back-rank bijection over all 960, with SP-518 = standard.
  const seen = new Set<string>()
  let bijectionBad = 0
  let legalityBad = 0
  for (let id = 0; id < 960; id++) {
    const br = backRankForId(id)
    seen.add(br)
    if (idForBackRank(br) !== id) bijectionBad++
    const bi = [...br].map((c, i) => (c === 'B' ? i : -1)).filter((i) => i >= 0)
    const ri = [...br].map((c, i) => (c === 'R' ? i : -1)).filter((i) => i >= 0)
    const ki = br.indexOf('K')
    if (!(bi.length === 2 && (bi[0] + bi[1]) % 2 === 1 && ri[0] < ki && ki < ri[1])) legalityBad++
  }
  out.push({
    name: 'All 960 ids ⇄ a distinct, legal back rank (id 518 = standard)',
    pass: seen.size === 960 && bijectionBad === 0 && legalityBad === 0 && backRankForId(518) === 'RNBQKBNR',
    detail: `${seen.size} distinct, ${bijectionBad} inverse + ${legalityBad} legality failures`,
  })

  // 2. SP-518 perft through the 960 code path == the known standard counts.
  const exp = [20, 400, 8902, 197281]
  let anchorBad = 0
  const std518 = startFenForId(518)
  for (let d = 1; d <= 4; d++) if (perft(parseFen(std518), d) !== exp[d - 1]) anchorBad++
  out.push({
    name: 'Standard position via the 960 path matches reference perft(1–4)',
    pass: anchorBad === 0,
    detail: anchorBad === 0 ? 'perft 20 / 400 / 8902 / 197281' : `${anchorBad} depths differ`,
  })

  // 3. make/unmake hash + FEN round-trip and incremental == recomputed hash,
  //    walked over random 960 trees.
  const ids = [0, 1, 2, 959, 300, 450, 640, 123, 777, 88, 505, 420]
  let hashBad = 0
  const walk = (p: Position, d: number): void => {
    const undo: Undo = { captured: 0, capturedSq: -1, castling: 0, ep: -1, halfmove: 0, hash: 0n }
    for (const m of generateLegal(p)) {
      const before = p.hash
      const fenB = toFen(p)
      makeMoveOnBoard(p, m, undo)
      if (p.hash !== computeHash(p)) hashBad++
      if (d > 1) walk(p, d - 1)
      unmakeMoveOnBoard(p, m, undo)
      if (p.hash !== before || toFen(p) !== fenB) hashBad++
    }
  }
  for (const id of ids) walk(parseFen(startFenForId(id)), 3)
  out.push({
    name: `${ids.length} random 960 trees: incremental hash & make/unmake are exact`,
    pass: hashBad === 0,
    detail: hashBad === 0 ? 'hash + FEN restored at every node (depth 3)' : `${hashBad} inconsistencies`,
  })

  // 4. Independent castle-move oracle agrees node-for-node across perft trees.
  let castleChecked = 0
  let castleBad = 0
  const castleWalk = (p: Position, d: number): void => {
    const a = engineCastleKeys(p)
    castleChecked += a.length
    if (a.join(',') !== refCastleKeys(p).join(',')) castleBad++
    if (d === 0) return
    const undo: Undo = { captured: 0, capturedSq: -1, castling: 0, ep: -1, halfmove: 0, hash: 0n }
    for (const m of generateLegal(p)) {
      makeMoveOnBoard(p, m, undo)
      castleWalk(p, d - 1)
      unmakeMoveOnBoard(p, m, undo)
    }
  }
  for (const id of [0, 1, 518, 959, 300, 640, 123, 420]) castleWalk(parseFen(startFenForId(id)), 3)
  out.push({
    name: `${castleChecked.toLocaleString()} castle moves match an independent oracle`,
    pass: castleBad === 0,
    detail: castleBad === 0 ? 'no missing or spurious castles' : `${castleBad} nodes disagree`,
  })

  // 5. Colour-flip symmetry of perft.
  let symBad = 0
  for (const id of [0, 1, 959, 518, 300, 640]) {
    const f = startFenForId(id)
    if (perft(parseFen(f), 4) !== perft(parseFen(mirrorFen(f)), 4)) symBad++
  }
  out.push({
    name: 'Perft is invariant under colour-flip mirroring',
    pass: symBad === 0,
    detail: symBad === 0 ? '6 positions symmetric to depth 4' : `${symBad} asymmetric`,
  })

  // 6. Double Fischer Random (independent back ranks per side): hashing and the
  //    castle oracle hold there too — the per-side castling code needs no extra work.
  let dfrcBad = 0
  let dfrcCastles = 0
  const dfrcWalk = (p: Position, d: number): void => {
    if (engineCastleKeys(p).join(',') !== refCastleKeys(p).join(',')) dfrcBad++
    dfrcCastles += engineCastleKeys(p).length
    if (d === 0) return
    const undo: Undo = { captured: 0, capturedSq: -1, castling: 0, ep: -1, halfmove: 0, hash: 0n }
    for (const m of generateLegal(p)) {
      const before = p.hash
      makeMoveOnBoard(p, m, undo)
      if (p.hash !== computeHash(p)) dfrcBad++
      dfrcWalk(p, d - 1)
      unmakeMoveOnBoard(p, m, undo)
      if (p.hash !== before) dfrcBad++
    }
  }
  for (const [w, b] of [
    [0, 959],
    [300, 18],
    [700, 222],
    [491, 5],
  ] as [number, number][])
    dfrcWalk(parseFen(startFenForDfrc(w, b)), 3)
  out.push({
    name: `Double Fischer Random works too (${dfrcCastles.toLocaleString()} castles cross-checked)`,
    pass: dfrcBad === 0,
    detail: dfrcBad === 0 ? 'asymmetric per-side castling is exact' : `${dfrcBad} inconsistencies`,
  })

  return out
}
