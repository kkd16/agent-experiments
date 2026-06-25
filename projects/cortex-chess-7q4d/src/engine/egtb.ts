// Endgame tablebases for King + Rook vs King and King + Queen vs King, generated
// in the browser by retrograde analysis — no embedded data. Each table holds the
// exact distance-to-mate (DTM, in plies) for every legal position, so the engine
// plays the *fastest* forced mate and never drifts into a 50-move draw with a
// winning piece. Like the KPK bitbase, the table is built once, lazily, and
// memoised.
//
// Canonical frame: the strong side (the one with the rook/queen) is always
// "White". The probe mirrors colours/ranks before looking up, so the solver only
// ever reasons about a white piece hunting a lone black king.
//
// Squares here are plain 0..63 with sq = rank * 8 + file.

import { ROOK, QUEEN } from './board'

const WIN_TO_MOVE = 0 // strong side to move
const DEF_TO_MOVE = 1 // defender (lone king) to move

// index = us(1) | wk(6) | bk(6) | psq(6)  →  up to 1 << 19 entries.
const SIZE = 1 << 19
const UNKNOWN = -1
const ILLEGAL = -2

function file(s: number): number {
  return s & 7
}
function rank(s: number): number {
  return s >> 3
}
function dist(a: number, b: number): number {
  return Math.max(Math.abs(file(a) - file(b)), Math.abs(rank(a) - rank(b)))
}

// Precomputed king-move target lists.
const KING_TARGETS: number[][] = []
for (let s = 0; s < 64; s++) {
  const list: number[] = []
  const f = file(s)
  const r = rank(s)
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (df === 0 && dr === 0) continue
      const nf = f + df
      const nr = r + dr
      if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) list.push(nr * 8 + nf)
    }
  }
  KING_TARGETS.push(list)
}

const ROOK_DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]
const QUEEN_DIRS = [
  ...ROOK_DIRS,
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
]

function index(us: number, wk: number, bk: number, psq: number): number {
  return us | (wk << 1) | (bk << 7) | (psq << 13)
}

// Does the piece on `psq` attack `target`, with up to two blocking squares
// (the kings)? Walks each ray and stops at the first blocker.
function attacks(dirs: number[][], psq: number, target: number, b1: number, b2: number): boolean {
  const pf = file(psq)
  const pr = rank(psq)
  for (const [df, dr] of dirs) {
    let f = pf + df
    let r = pr + dr
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const q = r * 8 + f
      if (q === target) return true
      if (q === b1 || q === b2) break
      f += df
      r += dr
    }
  }
  return false
}

export class Tablebase {
  private readonly dirs: number[][]
  private dtm: Int16Array | null = null

  constructor(piece: number) {
    this.dirs = piece === QUEEN ? QUEEN_DIRS : ROOK_DIRS
  }

  // Legality of a raw (us, wk, bk, psq) tuple: distinct squares, non-adjacent
  // kings, and the side NOT to move must not already be in check. With a lone
  // black king the only way the side-not-to-move is in check is: White to move
  // with the black king attacked by the white piece.
  private legal(us: number, wk: number, bk: number, psq: number): boolean {
    if (wk === bk || wk === psq || bk === psq) return false
    if (dist(wk, bk) <= 1) return false
    if (us === WIN_TO_MOVE && attacks(this.dirs, psq, bk, wk, -1)) return false
    return true
  }

  private build(): Int16Array {
    const d = new Int16Array(SIZE).fill(UNKNOWN)

    // Seed: mark illegal positions, and find the checkmates (DTM 0).
    for (let us = 0; us < 2; us++) {
      for (let wk = 0; wk < 64; wk++) {
        for (let bk = 0; bk < 64; bk++) {
          if (dist(wk, bk) <= 1) continue
          for (let psq = 0; psq < 64; psq++) {
            const i = index(us, wk, bk, psq)
            if (!this.legal(us, wk, bk, psq)) {
              d[i] = ILLEGAL
              continue
            }
            if (us === DEF_TO_MOVE && this.defenderHasNoMove(wk, bk, psq)) {
              // No legal defender move: checkmate if in check, else stalemate.
              d[i] = attacks(this.dirs, psq, bk, wk, -1) ? 0 : ILLEGAL // stalemate ≈ not a win
            }
          }
        }
      }
    }

    // Retrograde fixed point. At sweep d we assign every position whose optimal
    // DTM is exactly d+1: a strong-side position that can reach a mate-in-d, or a
    // defender position whose *every* move runs into a win and whose hardest
    // defence is mate-in-d.
    let dd = 0
    for (;;) {
      let changed = false
      for (let us = 0; us < 2; us++) {
        for (let wk = 0; wk < 64; wk++) {
          for (let bk = 0; bk < 64; bk++) {
            if (dist(wk, bk) <= 1) continue
            for (let psq = 0; psq < 64; psq++) {
              const i = index(us, wk, bk, psq)
              if (d[i] !== UNKNOWN) continue
              const v =
                us === WIN_TO_MOVE
                  ? this.classifyStrong(wk, bk, psq, dd, d)
                  : this.classifyDefender(wk, bk, psq, dd, d)
              if (v) {
                d[i] = dd + 1
                changed = true
              }
            }
          }
        }
      }
      if (!changed) break
      dd++
    }
    return d
  }

  // True if the strong side (to move) has a move reaching a defender position
  // already known to be mate-in-`dd`.
  private classifyStrong(wk: number, bk: number, psq: number, dd: number, d: Int16Array): boolean {
    // King moves.
    for (const t of KING_TARGETS[wk]) {
      if (t === bk || t === psq) continue
      if (dist(t, bk) <= 1) continue // can't step next to the enemy king
      if (d[index(DEF_TO_MOVE, t, bk, psq)] === dd) return true
    }
    // Piece moves: slide to each empty square.
    const pf = file(psq)
    const pr = rank(psq)
    for (const [df, dr] of this.dirs) {
      let f = pf + df
      let r = pr + dr
      while (f >= 0 && f < 8 && r >= 0 && r < 8) {
        const q = r * 8 + f
        if (q === wk || q === bk) break // blocked
        if (d[index(DEF_TO_MOVE, wk, bk, q)] === dd) return true
        f += df
        r += dr
      }
    }
    return false
  }

  // True if the defender (to move) is lost in exactly dd+1: every legal move
  // leads to a strong-side win, and the hardest of them is win-in-dd.
  private classifyDefender(wk: number, bk: number, psq: number, dd: number, d: Int16Array): boolean {
    let maxChild = -1
    let any = false
    for (const t of KING_TARGETS[bk]) {
      if (t === wk) continue
      if (dist(t, wk) <= 1) continue // can't step next to the enemy king
      if (t === psq) {
        // Capturing the piece. Legal only if it isn't defended by the king; the
        // result is bare kings — a draw, so the defender survives.
        if (dist(psq, wk) >= 2) return false
        continue
      }
      // Quiet king move: legal only if the square isn't attacked by the piece
      // (the moving king no longer blocks the ray).
      if (attacks(this.dirs, psq, t, wk, -1)) continue
      any = true
      const child = d[index(WIN_TO_MOVE, wk, t, psq)]
      if (child < 0) return false // a non-winning escape (draw or unresolved) → not yet lost
      if (child > maxChild) maxChild = child
    }
    if (!any) return false // handled as mate/stalemate in the seed pass
    return maxChild === dd
  }

  // The defender (to move) has no legal king move at all (→ mate or stalemate).
  private defenderHasNoMove(wk: number, bk: number, psq: number): boolean {
    for (const t of KING_TARGETS[bk]) {
      if (t === wk) continue
      if (dist(t, wk) <= 1) continue
      if (t === psq) {
        if (dist(psq, wk) >= 2) return false // can capture the undefended piece → has a move
        continue
      }
      if (attacks(this.dirs, psq, t, wk, -1)) continue
      return false // found a legal move
    }
    return true
  }

  // Probe in the canonical (white = strong) frame. Returns DTM in plies, or -1
  // for a draw / illegal lookup.
  probe(wk: number, bk: number, psq: number, strongToMove: boolean): number {
    if (!this.dtm) this.dtm = this.build()
    const v = this.dtm[index(strongToMove ? WIN_TO_MOVE : DEF_TO_MOVE, wk, bk, psq)]
    return v >= 0 ? v : -1
  }
}

const TABLES = new Map<number, Tablebase>()

function tableFor(piece: number): Tablebase {
  let t = TABLES.get(piece)
  if (!t) {
    t = new Tablebase(piece)
    TABLES.set(piece, t)
  }
  return t
}

export interface TbResult {
  win: boolean
  dtm: number // plies to mate (0 at mate); -1 when not winning
}

// Probe K(piece)K. Inputs are 0..63 squares in the *real* board frame, with the
// strong side's colour given by `strongIsWhite`; `whiteToMove` is the real side
// to move. Mirrors black-strong positions into the canonical white-strong frame.
export function probeKxK(
  piece: number,
  whiteKing: number,
  blackKing: number,
  pieceSq: number,
  strongIsWhite: boolean,
  whiteToMove: boolean,
): TbResult {
  if (piece !== ROOK && piece !== QUEEN) return { win: false, dtm: -1 }
  let wk: number
  let bk: number
  let psq: number
  let strongToMove: boolean
  if (strongIsWhite) {
    wk = whiteKing
    bk = blackKing
    psq = pieceSq
    strongToMove = whiteToMove
  } else {
    // Mirror vertically and swap king roles so the strong side becomes White.
    wk = blackKing ^ 56
    bk = whiteKing ^ 56
    psq = pieceSq ^ 56
    strongToMove = !whiteToMove
  }
  const dtm = tableFor(piece).probe(wk, bk, psq, strongToMove)
  return dtm >= 0 ? { win: true, dtm } : { win: false, dtm: -1 }
}
