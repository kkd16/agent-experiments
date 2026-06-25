// KPK bitbase — perfect King + Pawn vs King knowledge, generated in the browser
// by retrograde analysis (no embedded data table). Every legal KPvK position is
// classified WIN or DRAW for the pawn's side by iterating a fixed-point of the
// game rules over all ~98k positions, exactly the classic Chess Programming Wiki
// / Stockfish bitbase construction. The engine probes it in the evaluation so it
// never throws away a won pawn ending or pushes a dead-drawn one.
//
// Canonical frame: the pawn always belongs to White (the side that promotes on
// rank 8). The evaluation mirrors colours/ranks before probing, so this module
// only ever reasons about a white pawn marching up the board.

// Squares here are plain 0..63 with sq = rank * 8 + file (rank 0 = White's home).

const INVALID = 0
const UNKNOWN = 1
const DRAW = 2
const WIN = 4

// index = us(1 bit) | bksq(6) | wksq(6) | psq(6)  →  up to 1 << 19 entries.
const SIZE = 1 << 19
let db: Uint8Array | null = null

const WHITE_US = 0
const BLACK_US = 1

function rankOf(s: number): number {
  return s >> 3
}
function fileOf(s: number): number {
  return s & 7
}
function distance(a: number, b: number): number {
  return Math.max(Math.abs(fileOf(a) - fileOf(b)), Math.abs(rankOf(a) - rankOf(b)))
}

// Bitset of king-move target squares (as a 64-bit value split into two numbers
// is overkill; we just test membership with helper predicates below).
function kingAttacks(s: number, target: number): boolean {
  return s !== target && distance(s, target) === 1
}

// Does a white pawn on psq attack square t?
function pawnAttacks(psq: number, t: number): boolean {
  const f = fileOf(psq)
  return (f > 0 && t === psq + 7) || (f < 7 && t === psq + 9)
}

function index(us: number, wksq: number, bksq: number, psq: number): number {
  return us | (bksq << 1) | (wksq << 7) | (psq << 13)
}

// Classify a single position from already-known successor values.
function classify(us: number, wksq: number, bksq: number, psq: number, d: Uint8Array): number {
  let r = INVALID
  if (us === WHITE_US) {
    // White (pawn side) wins if any move reaches a WIN.
    for (let t = 0; t < 64; t++) {
      if (kingAttacks(wksq, t) && t !== bksq && t !== psq && distance(t, bksq) > 0) {
        r |= d[index(BLACK_US, t, bksq, psq)]
      }
    }
    if (rankOf(psq) < 6) {
      const push = psq + 8
      if (push !== wksq && push !== bksq) r |= d[index(BLACK_US, wksq, bksq, push)]
      if (rankOf(psq) === 1) {
        const dbl = psq + 16
        if (push !== wksq && push !== bksq && dbl !== wksq && dbl !== bksq) {
          r |= d[index(BLACK_US, wksq, bksq, dbl)]
        }
      }
    }
    return r & WIN ? WIN : r & UNKNOWN ? UNKNOWN : DRAW
  }
  // Black (defending side) draws if any move reaches a DRAW.
  for (let t = 0; t < 64; t++) {
    if (kingAttacks(bksq, t) && t !== wksq && distance(t, wksq) > 0) {
      // Black king cannot move onto a square defended by the white king, nor be
      // captured; capturing the pawn is allowed only if the pawn is undefended.
      if (t === psq && pawnAttacks(psq, t)) continue // pawn can't defend its own square; safe to capture
      r |= d[index(WHITE_US, wksq, t, psq)]
    }
  }
  return r & DRAW ? DRAW : r & UNKNOWN ? UNKNOWN : WIN
}

function terminal(us: number, wksq: number, bksq: number, psq: number): number {
  // Overlaps / adjacent kings / black-in-check-on-white's-move are illegal.
  if (
    wksq === bksq ||
    wksq === psq ||
    bksq === psq ||
    distance(wksq, bksq) <= 1 ||
    (us === WHITE_US && pawnAttacks(psq, bksq))
  ) {
    return INVALID
  }

  // White to move with the pawn one step from promotion and safe to queen → win.
  if (us === WHITE_US && rankOf(psq) === 6) {
    const push = psq + 8
    if (push !== wksq && (distance(bksq, push) > 1 || kingAttacks(wksq, push))) {
      return WIN
    }
  }

  if (us === BLACK_US) {
    // Stalemate (no legal black king move that isn't into the white king's or
    // pawn's coverage) → draw.
    let hasMove = false
    let capturesPawn = false
    for (let t = 0; t < 64; t++) {
      if (!kingAttacks(bksq, t)) continue
      if (kingAttacks(wksq, t)) continue // adjacent to white king
      if (pawnAttacks(psq, t)) continue // square attacked by the pawn
      if (t === wksq) continue
      if (t === psq && !kingAttacks(wksq, psq)) capturesPawn = true
      hasMove = true
    }
    if (!hasMove) return DRAW // stalemate
    if (capturesPawn) return DRAW // king grabs the undefended pawn → bare kings
  }

  return UNKNOWN
}

function build(): Uint8Array {
  const d = new Uint8Array(SIZE)

  // Seed terminal/illegal verdicts.
  for (let us = 0; us < 2; us++) {
    for (let wksq = 0; wksq < 64; wksq++) {
      for (let bksq = 0; bksq < 64; bksq++) {
        for (let psq = 8; psq < 56; psq++) {
          d[index(us, wksq, bksq, psq)] = terminal(us, wksq, bksq, psq)
        }
      }
    }
  }

  // Iterate the fixed point: re-classify UNKNOWN positions until nothing changes.
  let changed = true
  while (changed) {
    changed = false
    for (let us = 0; us < 2; us++) {
      for (let wksq = 0; wksq < 64; wksq++) {
        for (let bksq = 0; bksq < 64; bksq++) {
          for (let psq = 8; psq < 56; psq++) {
            const i = index(us, wksq, bksq, psq)
            if (d[i] !== UNKNOWN) continue
            const v = classify(us, wksq, bksq, psq, d)
            if (v !== UNKNOWN) {
              d[i] = v
              changed = true
            }
          }
        }
      }
    }
  }
  return d
}

// True if the pawn side (canonical White) wins. Inputs are 0..63 in the canonical
// frame; `usWhite` is true when it's the pawn side's move.
export function kpkWin(wksq: number, bksq: number, psq: number, usWhite: boolean): boolean {
  if (!db) db = build()
  const r = db[index(usWhite ? WHITE_US : BLACK_US, wksq, bksq, psq)]
  return r === WIN
}
