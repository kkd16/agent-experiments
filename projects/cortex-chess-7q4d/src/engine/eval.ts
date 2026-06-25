// Tapered evaluation. The core is the PeSTO piece-square tables (Rofchade /
// Chess Programming Wiki) — separate midgame/endgame tables interpolated by a
// "game phase" from the remaining material. On top of that the engine adds the
// positional understanding that separates a tactician from a player:
//
//   • piece mobility (with sane centres so it doesn't just inflate material),
//   • king safety: pawn-shield holes + a weighted count of attackers on the king,
//   • pawn structure: passed, isolated and doubled pawns,
//   • rooks on open / semi-open files and on the 7th rank,
//   • knight outposts,
//   • a "mop-up" term that drives the bare king to the corner in won endings,
//   • and a perfect KPK bitbase probe for King + Pawn vs King.
//
// Scores are returned from the side-to-move's perspective (negamax).

import {
  type Position,
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
  isOnBoard,
  fileOf,
  rankOf,
  pieceColor,
  pieceType,
} from './board'
import { kpkWin } from './kpk'
import { probeKxK } from './egtb'
import { probeKbnk, kbnkReady } from './kbnk'
import { gtbReady, gtbConfigFor, probeGtb } from './gtb'

// Midgame / endgame base values, indexed by piece type 1..6.
const MG_VALUE = [0, 82, 337, 365, 477, 1025, 0]
const EG_VALUE = [0, 94, 281, 297, 512, 936, 0]

// Game-phase weight per piece type (knight/bishop = 1, rook = 2, queen = 4).
const PHASE_WEIGHT = [0, 0, 1, 1, 2, 4, 0]
const TOTAL_PHASE = 24

// prettier-ignore
const MG_PAWN = [
  0,0,0,0,0,0,0,0, 98,134,61,95,68,126,34,-11, -6,7,26,31,65,56,25,-20,
  -14,13,6,21,23,12,17,-23, -27,-2,-5,12,17,6,10,-25, -26,-4,-4,-10,3,3,33,-12,
  -35,-1,-20,-23,-15,24,38,-22, 0,0,0,0,0,0,0,0,
]
// prettier-ignore
const EG_PAWN = [
  0,0,0,0,0,0,0,0, 178,173,158,134,147,132,165,187, 94,100,85,67,56,53,82,84,
  32,24,13,5,-2,4,17,17, 13,9,-3,-7,-7,-8,3,-1, 4,7,-6,1,0,-5,-1,-8,
  13,8,8,10,13,0,2,-7, 0,0,0,0,0,0,0,0,
]
// prettier-ignore
const MG_KNIGHT = [
  -167,-89,-34,-49,61,-97,-15,-107, -73,-41,72,36,23,62,7,-17, -47,60,37,65,84,129,73,44,
  -9,17,19,53,37,69,18,22, -13,4,16,13,28,19,21,-8, -23,-9,12,10,19,17,25,-16,
  -29,-53,-12,-3,-1,18,-14,-19, -105,-21,-58,-33,-17,-28,-19,-23,
]
// prettier-ignore
const EG_KNIGHT = [
  -58,-38,-13,-28,-31,-27,-63,-99, -25,-8,-25,-2,-9,-25,-24,-52, -24,-20,10,9,-1,-9,-19,-41,
  -17,3,22,22,22,11,8,-18, -18,-6,16,25,16,17,4,-18, -23,-3,-1,15,10,-3,-20,-22,
  -42,-20,-10,-5,-2,-20,-23,-44, -29,-51,-23,-15,-22,-18,-50,-64,
]
// prettier-ignore
const MG_BISHOP = [
  -29,4,-82,-37,-25,-42,7,-8, -26,16,-18,-13,30,59,18,-47, -16,37,43,40,35,50,37,-2,
  -4,5,19,50,37,37,7,-2, -6,13,13,26,34,12,10,4, 0,15,15,15,14,27,18,10,
  4,15,16,0,7,21,33,1, -33,-3,-14,-21,-13,-12,-39,-21,
]
// prettier-ignore
const EG_BISHOP = [
  -14,-21,-11,-8,-7,-9,-17,-24, -8,-4,7,-12,-3,-13,-4,-14, 2,-8,0,-1,-2,6,0,4,
  -3,9,12,9,14,10,3,2, -6,3,13,19,7,10,-3,-9, -12,-3,8,10,13,3,-7,-15,
  -14,-18,-7,-1,4,-9,-15,-27, -23,-9,-23,-5,-9,-16,-5,-17,
]
// prettier-ignore
const MG_ROOK = [
  32,42,32,51,63,9,31,43, 27,32,58,62,80,67,26,44, -5,19,26,36,17,45,61,16,
  -24,-11,7,26,24,35,-8,-20, -36,-26,-12,-1,9,-7,6,-23, -45,-25,-16,-17,3,0,-5,-33,
  -44,-16,-20,-9,-1,11,-6,-71, -19,-13,1,17,16,7,-37,-26,
]
// prettier-ignore
const EG_ROOK = [
  13,10,18,15,12,12,8,5, 11,13,13,11,-3,3,8,3, 7,7,7,5,4,-3,-5,-3,
  4,3,13,1,2,1,-1,2, 3,5,8,4,-5,-6,-8,-11, -4,0,-5,-1,-7,-12,-8,-16,
  -6,-6,0,2,-9,-9,-11,-3, -9,2,3,-1,-5,-13,4,-20,
]
// prettier-ignore
const MG_QUEEN = [
  -28,0,29,12,59,44,43,45, -24,-39,-5,1,-16,57,28,54, -13,-17,7,8,29,56,47,57,
  -27,-27,-16,-16,-1,17,-2,1, -9,-26,-9,-10,-2,-4,3,-3, -14,2,-11,-2,-5,2,14,5,
  -35,-8,11,2,8,15,-3,1, -1,-18,-9,10,-15,-25,-31,-50,
]
// prettier-ignore
const EG_QUEEN = [
  -9,22,22,27,27,19,10,20, -17,20,32,41,58,25,30,0, -20,6,9,49,47,35,19,9,
  3,22,24,45,57,40,57,36, -18,28,19,47,31,34,39,23, -16,-27,15,6,9,17,10,5,
  -22,-23,-30,-16,-16,-23,-36,-32, -33,-28,-22,-43,-5,-32,-20,-41,
]
// prettier-ignore
const MG_KING = [
  -65,23,16,-15,-56,-34,2,13, 29,-1,-20,-7,-8,-4,-38,-29, -9,24,2,-16,-20,6,22,-22,
  -17,-20,-12,-27,-30,-25,-14,-36, -49,-1,-27,-39,-46,-44,-33,-51, -14,-14,-22,-46,-44,-30,-15,-27,
  1,7,-8,-64,-43,-16,9,8, -15,36,12,-54,8,-28,24,14,
]
// prettier-ignore
const EG_KING = [
  -74,-35,-18,-18,-11,15,4,-17, -12,17,14,17,17,38,23,11, 10,17,23,15,20,45,44,13,
  -8,22,24,27,26,33,26,3, -18,-4,21,24,27,23,9,-11, -19,-3,11,21,23,16,7,-9,
  -27,-11,4,13,14,4,-5,-17, -53,-34,-21,-11,-28,-14,-24,-43,
]

const MG_TABLES = [null, MG_PAWN, MG_KNIGHT, MG_BISHOP, MG_ROOK, MG_QUEEN, MG_KING]
const EG_TABLES = [null, EG_PAWN, EG_KNIGHT, EG_BISHOP, EG_ROOK, EG_QUEEN, EG_KING]

// Map a 0x88 square + color to the index used by the (a8-first, White-POV)
// tables. White reads it directly; Black mirrors vertically.
function tableIndex(square: number, color: Color): number {
  const f = fileOf(square)
  const r = rankOf(square)
  return color === WHITE ? (7 - r) * 8 + f : r * 8 + f
}

const TEMPO = 10
const BISHOP_PAIR_MG = 25
const BISHOP_PAIR_EG = 45

const KNIGHT_OFFSETS = [-33, -31, -18, -14, 14, 18, 31, 33]
const BISHOP_DIRS = [-17, -15, 15, 17]
const ROOK_DIRS = [-16, -1, 1, 16]
const QUEEN_DIRS = [-17, -15, 15, 17, -16, -1, 1, 16]

// Mobility: bonus = (reachable squares − centre) × weight, kept small. Centres
// stop a developed piece from looking like free material.
const KNIGHT_MOB_MG = 4, KNIGHT_MOB_EG = 4, KNIGHT_MOB_CENTER = 4
const BISHOP_MOB_MG = 4, BISHOP_MOB_EG = 5, BISHOP_MOB_CENTER = 6
const ROOK_MOB_MG = 2, ROOK_MOB_EG = 4, ROOK_MOB_CENTER = 7
const QUEEN_MOB_MG = 1, QUEEN_MOB_EG = 2, QUEEN_MOB_CENTER = 14

// Pawn structure (white-relative; mirrored for black).
const ISOLATED_MG = -12, ISOLATED_EG = -8
const DOUBLED_MG = -8, DOUBLED_EG = -16
// Passed-pawn bonus indexed by the pawn's rank from its own side (1..6).
const PASSED_MG = [0, 0, 8, 16, 32, 60, 110, 0]
const PASSED_EG = [0, 4, 14, 28, 52, 90, 160, 0]

const ROOK_OPEN_MG = 22, ROOK_OPEN_EG = 10
const ROOK_SEMI_MG = 11, ROOK_SEMI_EG = 6
const ROOK_7TH_MG = 18, ROOK_7TH_EG = 24
const KNIGHT_OUTPOST = 22

// King safety: weighted attackers in the king zone → a capped midgame penalty.
const KING_ATTACK_WEIGHT = [0, 0, 2, 2, 3, 5, 0] // by piece type
const SHIELD_PENALTY = 12 // per missing pawn in front of a castled king

// Reusable scratch so evaluate() allocates nothing in the hot path.
const wPawnSq = new Int32Array(8)
const bPawnSq = new Int32Array(8)
const wPawnByFile = new Int32Array(8) // bitmask of ranks (0..7) with a white pawn
const bPawnByFile = new Int32Array(8)

function centerDistance(s: number): number {
  const f = fileOf(s)
  const r = rankOf(s)
  const fd = f < 4 ? 3 - f : f - 4
  const rd = r < 4 ? 3 - r : r - 4
  return fd + rd
}

function kingDistance(a: number, b: number): number {
  return Math.max(Math.abs(fileOf(a) - fileOf(b)), Math.abs(rankOf(a) - rankOf(b)))
}

// Squares 0x88 → 0..63 (rank*8+file) for the KPK probe.
function to64(s: number): number {
  return rankOf(s) * 8 + fileOf(s)
}

export function evaluate(p: Position): number {
  const board = p.board
  let mg = 0
  let eg = 0
  let phase = 0
  let whiteBishops = 0
  let blackBishops = 0
  let whiteKnights = 0
  let blackKnights = 0
  let whiteRooks = 0
  let blackRooks = 0
  let whiteQueens = 0
  let blackQueens = 0
  let wpN = 0
  let bpN = 0
  wPawnByFile.fill(0)
  bPawnByFile.fill(0)

  // Pass A — material, PSTs, phase, pawn map.
  for (let s = 0; s < 128; s++) {
    if (!isOnBoard(s)) {
      s += 7
      continue
    }
    const piece = board[s]
    if (piece === EMPTY) continue
    const color = pieceColor(piece)
    const type = pieceType(piece)
    const idx = tableIndex(s, color)
    const mgVal = MG_VALUE[type] + MG_TABLES[type]![idx]
    const egVal = EG_VALUE[type] + EG_TABLES[type]![idx]
    if (color === WHITE) {
      mg += mgVal
      eg += egVal
    } else {
      mg -= mgVal
      eg -= egVal
    }
    phase += PHASE_WEIGHT[type]
    const white = color === WHITE
    switch (type) {
      case PAWN:
        if (white) {
          wPawnSq[wpN++] = s
          wPawnByFile[fileOf(s)] |= 1 << rankOf(s)
        } else {
          bPawnSq[bpN++] = s
          bPawnByFile[fileOf(s)] |= 1 << rankOf(s)
        }
        break
      case KNIGHT:
        if (white) whiteKnights++
        else blackKnights++
        break
      case BISHOP:
        if (white) whiteBishops++
        else blackBishops++
        break
      case ROOK:
        if (white) whiteRooks++
        else blackRooks++
        break
      case QUEEN:
        if (white) whiteQueens++
        else blackQueens++
        break
    }
  }

  const wMinor = whiteKnights + whiteBishops
  const bMinor = blackKnights + blackBishops
  const wMajor = whiteRooks + whiteQueens
  const bMajor = blackRooks + blackQueens
  const wNonKing = wpN + wMinor + wMajor
  const bNonKing = bpN + bMinor + bMajor

  // --- Special endgame: King + Pawn vs King (perfect knowledge) ---
  if (wNonKing + bNonKing === 1 && (wpN + bpN) === 1) {
    return evalKPK(p, wpN === 1)
  }

  // --- Special endgames: K+R vs K and K+Q vs K (perfect distance-to-mate) ---
  if (wpN === 0 && bpN === 0) {
    if (wNonKing === 1 && bNonKing === 0 && whiteRooks === 1) return evalKxK(p, ROOK, true)
    if (wNonKing === 1 && bNonKing === 0 && whiteQueens === 1) return evalKxK(p, QUEEN, true)
    if (bNonKing === 1 && wNonKing === 0 && blackRooks === 1) return evalKxK(p, ROOK, false)
    if (bNonKing === 1 && wNonKing === 0 && blackQueens === 1) return evalKxK(p, QUEEN, false)
    // --- The hardest elementary mate: King + Bishop + Knight vs King ---
    if (wNonKing === 2 && bNonKing === 0 && whiteBishops === 1 && whiteKnights === 1) return evalKBNK(p, true)
    if (bNonKing === 2 && wNonKing === 0 && blackBishops === 1 && blackKnights === 1) return evalKBNK(p, false)

    // --- Other K + 2 pieces vs K endings, via the generalized tablebase (gtb.ts).
    // Only consulted when the table has been built/loaded into this worker; until
    // then we fall through to the heuristic eval. Covers KBBvK, KNNvK and the major
    // combinations (KRRvK, KQQvK, KQRvK, KRBvK, KRNvK, KQBvK, KQNvK).
    if (wNonKing === 2 && bNonKing === 0) {
      const sc = evalGtb(p, true, whiteKnights, whiteBishops, whiteRooks, whiteQueens)
      if (sc !== null) return sc
    } else if (bNonKing === 2 && wNonKing === 0) {
      const sc = evalGtb(p, false, blackKnights, blackBishops, blackRooks, blackQueens)
      if (sc !== null) return sc
    }
  }

  if (whiteBishops >= 2) {
    mg += BISHOP_PAIR_MG
    eg += BISHOP_PAIR_EG
  }
  if (blackBishops >= 2) {
    mg -= BISHOP_PAIR_MG
    eg -= BISHOP_PAIR_EG
  }

  // --- Pawn structure (white-relative) ---
  for (let i = 0; i < wpN; i++) {
    const s = wPawnSq[i]
    const f = fileOf(s)
    const r = rankOf(s)
    const isolated = (f === 0 || wPawnByFile[f - 1] === 0) && (f === 7 || wPawnByFile[f + 1] === 0)
    if (isolated) {
      mg += ISOLATED_MG
      eg += ISOLATED_EG
    }
    // Doubled: another white pawn behind on the same file.
    if (wPawnByFile[f] & ((1 << r) - 1)) {
      mg += DOUBLED_MG
      eg += DOUBLED_EG
    }
    const ahead = (0xff << (r + 1)) & 0xff
    const left = f > 0 ? bPawnByFile[f - 1] : 0
    const right = f < 7 ? bPawnByFile[f + 1] : 0
    if (((bPawnByFile[f] | left | right) & ahead) === 0) {
      mg += PASSED_MG[r]
      eg += PASSED_EG[r]
    }
  }
  for (let i = 0; i < bpN; i++) {
    const s = bPawnSq[i]
    const f = fileOf(s)
    const r = rankOf(s)
    const isolated = (f === 0 || bPawnByFile[f - 1] === 0) && (f === 7 || bPawnByFile[f + 1] === 0)
    if (isolated) {
      mg -= ISOLATED_MG
      eg -= ISOLATED_EG
    }
    if (bPawnByFile[f] & (0xff << (r + 1) & 0xff)) {
      mg -= DOUBLED_MG
      eg -= DOUBLED_EG
    }
    const behind = (1 << r) - 1
    const left = f > 0 ? wPawnByFile[f - 1] : 0
    const right = f < 7 ? wPawnByFile[f + 1] : 0
    if (((wPawnByFile[f] | left | right) & behind) === 0) {
      const rel = 7 - r
      mg -= PASSED_MG[rel]
      eg -= PASSED_EG[rel]
    }
  }

  // --- Pass B — mobility, piece placement, king-zone pressure ---
  const wKing = p.kings[WHITE]
  const bKing = p.kings[BLACK]
  let wKingDanger = 0 // attack units against the WHITE king
  let bKingDanger = 0

  for (let s = 0; s < 128; s++) {
    if (!isOnBoard(s)) {
      s += 7
      continue
    }
    const piece = board[s]
    if (piece === EMPTY) continue
    const type = pieceType(piece)
    if (type === PAWN || type === KING) continue
    const color = pieceColor(piece)
    const us = color
    const enemyKing = us === WHITE ? bKing : wKing
    const w = KING_ATTACK_WEIGHT[type]
    let mob = 0

    if (type === KNIGHT) {
      for (const off of KNIGHT_OFFSETS) {
        const t = s + off
        if (!isOnBoard(t)) continue
        const tp = board[t]
        if (tp === EMPTY || pieceColor(tp) !== us) mob++
        if (kingDistance(t, enemyKing) <= 1) {
          if (us === WHITE) bKingDanger += w
          else wKingDanger += w
        }
      }
      const mgB = (mob - KNIGHT_MOB_CENTER) * KNIGHT_MOB_MG
      const egB = (mob - KNIGHT_MOB_CENTER) * KNIGHT_MOB_EG
      if (us === WHITE) { mg += mgB; eg += egB } else { mg -= mgB; eg -= egB }
      // Outpost: a knight on the enemy half, defended by a friendly pawn and
      // unattackable by an enemy pawn on the adjacent files ahead.
      if (outpost(s, us)) {
        if (us === WHITE) mg += KNIGHT_OUTPOST
        else mg -= KNIGHT_OUTPOST
      }
    } else if (type === BISHOP || type === ROOK || type === QUEEN) {
      const list = type === BISHOP ? BISHOP_DIRS : type === ROOK ? ROOK_DIRS : QUEEN_DIRS
      for (const dir of list) {
        let t = s + dir
        while (isOnBoard(t)) {
          const tp = board[t]
          if (kingDistance(t, enemyKing) <= 1) {
            if (us === WHITE) bKingDanger += w
            else wKingDanger += w
          }
          if (tp === EMPTY) {
            mob++
          } else {
            if (pieceColor(tp) !== us) mob++
            break
          }
          t += dir
        }
      }
      let mgW: number, egW: number, center: number
      if (type === BISHOP) { mgW = BISHOP_MOB_MG; egW = BISHOP_MOB_EG; center = BISHOP_MOB_CENTER }
      else if (type === ROOK) { mgW = ROOK_MOB_MG; egW = ROOK_MOB_EG; center = ROOK_MOB_CENTER }
      else { mgW = QUEEN_MOB_MG; egW = QUEEN_MOB_EG; center = QUEEN_MOB_CENTER }
      const mgB = (mob - center) * mgW
      const egB = (mob - center) * egW
      if (us === WHITE) { mg += mgB; eg += egB } else { mg -= mgB; eg -= egB }

      // Rook files + 7th rank.
      if (type === ROOK) {
        const f = fileOf(s)
        const own = us === WHITE ? wPawnByFile[f] : bPawnByFile[f]
        const opp = us === WHITE ? bPawnByFile[f] : wPawnByFile[f]
        if (own === 0 && opp === 0) {
          if (us === WHITE) { mg += ROOK_OPEN_MG; eg += ROOK_OPEN_EG } else { mg -= ROOK_OPEN_MG; eg -= ROOK_OPEN_EG }
        } else if (own === 0) {
          if (us === WHITE) { mg += ROOK_SEMI_MG; eg += ROOK_SEMI_EG } else { mg -= ROOK_SEMI_MG; eg -= ROOK_SEMI_EG }
        }
        const seventh = us === WHITE ? 6 : 1
        if (rankOf(s) === seventh) {
          if (us === WHITE) { mg += ROOK_7TH_MG; eg += ROOK_7TH_EG } else { mg -= ROOK_7TH_MG; eg -= ROOK_7TH_EG }
        }
      }
    }
  }

  // King safety: pawn-shield holes + a capped attacker penalty (midgame only).
  wKingDanger += shieldHoles(p, WHITE) * SHIELD_PENALTY
  bKingDanger += shieldHoles(p, BLACK) * SHIELD_PENALTY
  mg -= Math.min(wKingDanger * wKingDanger, 600) >> 1
  mg += Math.min(bKingDanger * bKingDanger, 600) >> 1

  // --- Mop-up: drive the lone enemy king to a corner in won, pawnless endings ---
  if (bpN === 0 && bNonKing === 0 && wMajor + wMinor >= 1 && mg + eg > 0) {
    eg += 47 * centerDistance(bKing) + 16 * (14 - kingDistance(wKing, bKing))
  } else if (wpN === 0 && wNonKing === 0 && bMajor + bMinor >= 1 && mg + eg < 0) {
    eg -= 47 * centerDistance(wKing) + 16 * (14 - kingDistance(wKing, bKing))
  }

  const mgPhase = Math.min(phase, TOTAL_PHASE)
  const egPhase = TOTAL_PHASE - mgPhase
  let score = (mg * mgPhase + eg * egPhase) / TOTAL_PHASE

  score = p.turn === WHITE ? score : -score
  return Math.round(score) + TEMPO
}

// A knight outpost: square on the enemy half, defended by one of our pawns, with
// no enemy pawn able to challenge it from the adjacent files ahead.
function outpost(s: number, us: Color): boolean {
  const r = rankOf(s)
  const f = fileOf(s)
  if (us === WHITE) {
    if (r < 3 || r > 5) return false
    const defended = (f > 0 && (wPawnByFile[f - 1] & (1 << (r - 1)))) || (f < 7 && (wPawnByFile[f + 1] & (1 << (r - 1))))
    if (!defended) return false
    const ahead = (0xff << (r + 1)) & 0xff
    const left = f > 0 ? bPawnByFile[f - 1] : 0
    const right = f < 7 ? bPawnByFile[f + 1] : 0
    return ((left | right) & ahead) === 0
  } else {
    if (r < 2 || r > 4) return false
    const defended = (f > 0 && (bPawnByFile[f - 1] & (1 << (r + 1)))) || (f < 7 && (bPawnByFile[f + 1] & (1 << (r + 1))))
    if (!defended) return false
    const behind = (1 << r) - 1
    const left = f > 0 ? wPawnByFile[f - 1] : 0
    const right = f < 7 ? wPawnByFile[f + 1] : 0
    return ((left | right) & behind) === 0
  }
}

// Missing pawns directly in front of a king that has castled to the wing.
function shieldHoles(p: Position, color: Color): number {
  const k = p.kings[color]
  const kf = fileOf(k)
  const kr = rankOf(k)
  // Only score a shield once the king is on a back-ish rank near a wing.
  if (color === WHITE) {
    if (kr > 1 || (kf >= 2 && kf <= 5)) return 0
  } else {
    if (kr < 6 || (kf >= 2 && kf <= 5)) return 0
  }
  const mask = color === WHITE ? wPawnByFile : bPawnByFile
  const f0 = Math.max(0, kf - 1)
  const f1 = Math.min(7, kf + 1)
  let holes = 0
  for (let f = f0; f <= f1; f++) {
    if (mask[f] === 0) holes++
  }
  return holes
}

// KPK with perfect play. `whiteOwnsPawn` says which side has the pawn; we mirror
// into the canonical "white pawn marching up" frame before probing the bitbase.
function evalKPK(p: Position, whiteOwnsPawn: boolean): number {
  const strongIsWhite = whiteOwnsPawn
  let wk = to64(p.kings[WHITE])
  let bk = to64(p.kings[BLACK])
  let psq = -1
  for (let s = 0; s < 128; s++) {
    if (!isOnBoard(s)) { s += 7; continue }
    if (pieceType(p.board[s]) === PAWN) { psq = to64(s); break }
  }

  let usWhiteStrong: boolean
  if (strongIsWhite) {
    usWhiteStrong = p.turn === WHITE
  } else {
    // Mirror vertically and swap king roles so the pawn side becomes white.
    wk ^= 56
    bk ^= 56
    psq ^= 56
    const tmp = wk
    wk = bk
    bk = tmp
    usWhiteStrong = p.turn === BLACK
  }

  if (!kpkWin(wk, bk, psq, usWhiteStrong)) return 0 // dead draw, side-independent

  // Won: queen-up score, sharpened by how advanced the (now canonical) pawn is.
  const base = EG_VALUE[QUEEN] - EG_VALUE[PAWN] + 120 + (psq >> 3) * 16
  const whiteRel = strongIsWhite ? base : -base
  return p.turn === WHITE ? whiteRel : -whiteRel
}

// K+R vs K / K+Q vs K with perfect play, via the in-browser retrograde
// tablebase. Returns a decisive, DTM-graded score (faster mates score higher) or
// 0 for the rare drawn cases (the lone king can grab an undefended piece, or
// it's stalemate). Scores stay well under the search's mate threshold.
function evalKxK(p: Position, piece: number, strongIsWhite: boolean): number {
  const strongColor = strongIsWhite ? WHITE : BLACK
  let pieceSq = -1
  for (let s = 0; s < 128; s++) {
    if (!isOnBoard(s)) { s += 7; continue }
    const pc = p.board[s]
    if (pc === EMPTY) continue
    if (pieceType(pc) === piece && pieceColor(pc) === strongColor) {
      pieceSq = to64(s)
      break
    }
  }
  const r = probeKxK(piece, to64(p.kings[WHITE]), to64(p.kings[BLACK]), pieceSq, strongIsWhite, p.turn === WHITE)
  if (!r.win) return 0 // drawn (piece hangs) or unreachable
  const strongRel = 20000 - r.dtm
  const whiteRel = strongIsWhite ? strongRel : -strongRel
  return p.turn === WHITE ? whiteRel : -whiteRel
}

// King + Bishop + Knight vs King. When the perfect retrograde tablebase has been
// built (see kbnk.ts) we return its exact distance-to-mate so the engine plays
// the fastest forced win. Otherwise we fall back to a "drive the lone king to a
// corner of the bishop's colour" heuristic — a known-win score with a gradient
// the search climbs to the right corner, where it then sees the forced mate.
function evalKBNK(p: Position, strongIsWhite: boolean): number {
  const strongColor = strongIsWhite ? WHITE : BLACK
  let bsq = -1
  let nsq = -1
  for (let s = 0; s < 128; s++) {
    if (!isOnBoard(s)) { s += 7; continue }
    const pc = p.board[s]
    if (pc === EMPTY || pieceColor(pc) !== strongColor) continue
    const t = pieceType(pc)
    if (t === BISHOP) bsq = to64(s)
    else if (t === KNIGHT) nsq = to64(s)
  }
  const wk = to64(p.kings[WHITE])
  const bk = to64(p.kings[BLACK])

  if (kbnkReady()) {
    const r = probeKbnk(wk, bk, bsq, nsq, strongIsWhite, p.turn === WHITE)
    if (!r.win) return 0 // a genuine draw (the lone king can grab an undefended piece)
    const strongRel = 20000 - r.dtm
    const whiteRel = strongIsWhite ? strongRel : -strongRel
    return p.turn === WHITE ? whiteRel : -whiteRel
  }

  // Heuristic fallback. Corners of the bishop's colour are the only mating
  // corners: a dark-squared bishop mates on a1/h8, a light-squared one on h1/a8.
  const loneKing = strongIsWhite ? bk : wk
  const strongKing = strongIsWhite ? wk : bk
  const bishopParity = ((bsq & 7) + (bsq >> 3)) & 1
  const cornerA = bishopParity === 0 ? 0 : 7 // a1 (dark) or h1 (light)
  const cornerB = bishopParity === 0 ? 63 : 56 // h8 (dark) or a8 (light)
  const cdist = Math.min(cheb64(loneKing, cornerA), cheb64(loneKing, cornerB))
  const kdist = cheb64(strongKing, loneKing)
  // Also reward the knight helping shoulder the king toward the corner.
  const ndist = cheb64(nsq, loneKing)
  const strongRel = 3500 + 170 * (7 - cdist) + 18 * (7 - kdist) + 6 * (7 - ndist)
  const whiteRel = strongIsWhite ? strongRel : -strongRel
  return p.turn === WHITE ? whiteRel : -whiteRel
}

// K + 2 pieces vs a lone king, via the generalized distance-to-mate tablebase
// (gtb.ts). Returns null when the relevant table isn't resident (the search then
// uses the heuristic eval); a DTM-graded decisive score when winning; or exactly 0
// for a proven draw (KNNvK, same-coloured KBBvK, …) that material alone misjudges.
function evalGtb(
  p: Position,
  strongIsWhite: boolean,
  nKnights: number,
  nBishops: number,
  nRooks: number,
  nQueens: number,
): number | null {
  const types: number[] = []
  for (let i = 0; i < nKnights; i++) types.push(KNIGHT)
  for (let i = 0; i < nBishops; i++) types.push(BISHOP)
  for (let i = 0; i < nRooks; i++) types.push(ROOK)
  for (let i = 0; i < nQueens; i++) types.push(QUEEN)
  const config = gtbConfigFor(types)
  if (!config || !gtbReady(config.id)) return null

  const strongColor = strongIsWhite ? WHITE : BLACK
  const byType: Record<number, number[]> = {}
  for (let s = 0; s < 128; s++) {
    if (!isOnBoard(s)) {
      s += 7
      continue
    }
    const pc = p.board[s]
    if (pc === EMPTY || pieceColor(pc) !== strongColor) continue
    const t = pieceType(pc)
    if (t === KING) continue
    if (!byType[t]) byType[t] = []
    byType[t].push(to64(s))
  }
  const pieceSqs: number[] = []
  const used: Record<number, number> = {}
  for (const t of config.white) {
    const idx = used[t] ?? 0
    pieceSqs.push(byType[t][idx])
    used[t] = idx + 1
  }

  const r = probeGtb(config.id, to64(p.kings[WHITE]), to64(p.kings[BLACK]), pieceSqs, strongIsWhite, p.turn === WHITE)
  if (!r.win) return 0 // proven draw
  const strongRel = 20000 - r.dtm
  const whiteRel = strongIsWhite ? strongRel : -strongRel
  return p.turn === WHITE ? whiteRel : -whiteRel
}

// Chebyshev (king) distance between two 0..63 squares.
function cheb64(a: number, b: number): number {
  return Math.max(Math.abs((a & 7) - (b & 7)), Math.abs((a >> 3) - (b >> 3)))
}

// Reference material so the UI can show a simple material count.
export const MATERIAL = [0, 1, 3, 3, 5, 9, 0]
export const PIECE_NAMES = ['', 'Pawn', 'Knight', 'Bishop', 'Rook', 'Queen', 'King']
export { PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING }
