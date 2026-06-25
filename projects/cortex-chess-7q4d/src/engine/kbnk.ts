// King + Bishop + Knight vs King — the hardest of the elementary checkmates —
// solved *exactly* in the browser by backward retrograde analysis. No embedded
// data: the whole distance-to-mate (DTM) table is generated once, lazily, by
// working backwards from the mated positions, so the engine plays the bishop +
// knight mate as the fastest forced win and drives the lone king to the correct
// (bishop-coloured) corner every time.
//
// Why this is harder than K+R / K+Q vs K (which the project already solves):
//
//   • there are *two* attacking pieces, so the state is a 4-square tuple
//     (wk, bk, bishop, knight) → up to 2 · 64⁴ ≈ 33.6M states, ~64× the KRvK
//     space. A naïve "re-scan every position each ply" fixed point would do tens
//     of billions of visits and take minutes, so this uses proper *retrograde
//     BFS*: seed the mates, then walk predecessors outward layer by layer, each
//     position touched once.
//
//   • the mate only exists in two of the four corners (the ones the bishop
//     controls), and the longest forced KBNK mate is 33 moves, so the table has
//     to remember a real DTM, not just win/draw.
//
// Canonical frame: the strong side (bishop + knight) is always "White". The
// probe mirrors a black-strong position into that frame before looking up.
//
// Squares throughout are plain 0..63 with sq = rank * 8 + file.

const WIN = 0 // strong side (bishop + knight) to move
const DEF = 1 // defender (lone king) to move

// index = side(1) | wk(6) | bk(6) | bsq(6) | nsq(6)  →  2^25 entries.
const SIZE = 1 << 25

const ILLEGAL = -2
const DRAW = -1 // also "unknown / unresolved" during the build; unresolved ⇒ draw.

function file(s: number): number {
  return s & 7
}
function rank(s: number): number {
  return s >> 3
}
function dist(a: number, b: number): number {
  return Math.max(Math.abs(file(a) - file(b)), Math.abs(rank(a) - rank(b)))
}

function index(side: number, wk: number, bk: number, bsq: number, nsq: number): number {
  return side | (wk << 1) | (bk << 7) | (bsq << 13) | (nsq << 19)
}

// Precomputed king and knight target lists, plus a 64×64 knight-attack bitmap.
const KING_TARGETS: number[][] = []
const KNIGHT_TARGETS: number[][] = []
const KNIGHT_MAP = new Uint8Array(64 * 64)
const KNIGHT_DELTAS = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
]
for (let s = 0; s < 64; s++) {
  const f = file(s)
  const r = rank(s)
  const kt: number[] = []
  for (let df = -1; df <= 1; df++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (df === 0 && dr === 0) continue
      const nf = f + df
      const nr = r + dr
      if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) kt.push(nr * 8 + nf)
    }
  }
  KING_TARGETS.push(kt)
  const nt: number[] = []
  for (const [df, dr] of KNIGHT_DELTAS) {
    const nf = f + df
    const nr = r + dr
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
      const q = nr * 8 + nf
      nt.push(q)
      KNIGHT_MAP[s * 64 + q] = 1
    }
  }
  KNIGHT_TARGETS.push(nt)
}

function knightAttacks(nsq: number, target: number): boolean {
  return KNIGHT_MAP[nsq * 64 + target] === 1
}

// Does the bishop on `bsq` attack `target`, with up to two blocking squares?
// The four diagonals are unrolled — this is the single hottest function in the
// retrograde build, so it allocates nothing.
function bishopAttacks(bsq: number, target: number, b1: number, b2: number): boolean {
  const sf = bsq & 7
  const sr = bsq >> 3
  for (let f = sf + 1, r = sr + 1; f < 8 && r < 8; f++, r++) {
    const q = (r << 3) + f
    if (q === target) return true
    if (q === b1 || q === b2) break
  }
  for (let f = sf + 1, r = sr - 1; f < 8 && r >= 0; f++, r--) {
    const q = (r << 3) + f
    if (q === target) return true
    if (q === b1 || q === b2) break
  }
  for (let f = sf - 1, r = sr + 1; f >= 0 && r < 8; f--, r++) {
    const q = (r << 3) + f
    if (q === target) return true
    if (q === b1 || q === b2) break
  }
  for (let f = sf - 1, r = sr - 1; f >= 0 && r >= 0; f--, r--) {
    const q = (r << 3) + f
    if (q === target) return true
    if (q === b1 || q === b2) break
  }
  return false
}

// Black king in check from the white bishop/knight? (Kings can never be adjacent
// in a legal position, so the white king never gives check.)
function blackInCheck(wk: number, bk: number, bsq: number, nsq: number): boolean {
  return knightAttacks(nsq, bk) || bishopAttacks(bsq, bk, wk, nsq)
}

// Position legality for a raw tuple: distinct squares, non-adjacent kings, and —
// when it's the strong side's move — the defender must not already be in check
// (that would mean the side-not-to-move was left in check).
function legal(side: number, wk: number, bk: number, bsq: number, nsq: number): boolean {
  if (wk === bk || wk === bsq || wk === nsq || bk === bsq || bk === nsq || bsq === nsq) return false
  if (dist(wk, bk) <= 1) return false
  if (side === WIN && blackInCheck(wk, bk, bsq, nsq)) return false
  return true
}

export interface KbnkStats {
  buildMs: number
  won: number // strong-to-move winning positions
  lost: number // defender-to-move lost (mated) positions
  draw: number
  illegal: number
  maxDtm: number // longest forced mate, in plies
  maxDtmFen: string // a position realising the longest mate
}

let table: Int16Array | null = null
let stats: KbnkStats | null = null

export function kbnkReady(): boolean {
  return table !== null
}

export function kbnkStats(): KbnkStats | null {
  return stats
}

export type ProgressFn = (frac: number, phase: string) => void

// Build the whole table by retrograde BFS. Returns the build statistics. Safe to
// call repeatedly — only the first call does the work.
export function buildKbnk(onProgress?: ProgressFn, now: () => number = () => Date.now()): KbnkStats {
  if (table && stats) return stats
  const t0 = now()
  const dtm = new Int16Array(SIZE).fill(DRAW)
  // For defender (lone-king-to-move) positions: how many legal *quiet* moves
  // (children, all reaching strong-to-move positions) are not yet proven winning.
  const count = new Uint8Array(SIZE)

  // The mated positions (lost-in-0) seed the BFS.
  let frontier: number[] = []

  // --- Pass 1: legality, mate/stalemate seeds, defender out-degree. ---
  let reportAt = 0
  for (let i = 0; i < SIZE; i++) {
    if (i >= reportAt) {
      onProgress?.((i / SIZE) * 0.5, 'scanning positions')
      reportAt = i + (SIZE >> 6)
    }
    const side = i & 1
    const wk = (i >> 1) & 63
    const bk = (i >> 7) & 63
    const bsq = (i >> 13) & 63
    const nsq = (i >> 19) & 63
    if (!legal(side, wk, bk, bsq, nsq)) {
      dtm[i] = ILLEGAL
      continue
    }
    if (side === WIN) continue // discovered later via predecessors

    // Defender to move: enumerate the lone king's legal replies.
    let moves = 0
    let drawEscape = false
    const targets = KING_TARGETS[bk]
    for (let k = 0; k < targets.length; k++) {
      const t = targets[k]
      if (t === wk) continue
      if (dist(t, wk) <= 1) continue // can't step next to the enemy king
      if (t === bsq) {
        // Capturing the bishop → K+N vs K is a draw, *if* the capture is legal
        // (square not defended by king or knight).
        if (dist(bsq, wk) >= 2 && !knightAttacks(nsq, bsq)) drawEscape = true
        continue
      }
      if (t === nsq) {
        // Capturing the knight → K+B vs K is a draw, if the capture is legal.
        if (dist(nsq, wk) >= 2 && !bishopAttacks(bsq, nsq, wk, -1)) drawEscape = true
        continue
      }
      // Quiet king move to an empty square: legal only if it isn't attacked
      // (the king has left bk, so the bishop ray is blocked only by wk / nsq).
      if (bishopAttacks(bsq, t, wk, nsq)) continue
      if (knightAttacks(nsq, t)) continue
      moves++
    }

    if (drawEscape) {
      dtm[i] = DRAW // defender can bail out to a drawn K+minor vs K
    } else if (moves === 0) {
      if (blackInCheck(wk, bk, bsq, nsq)) {
        dtm[i] = 0 // checkmate — lost in 0
        frontier.push(i)
      } else {
        dtm[i] = DRAW // stalemate
      }
    } else {
      count[i] = moves // unresolved; needs every child to become winning
    }
  }

  // --- Pass 2: retrograde BFS, layer by layer of increasing DTM. ---
  let d = 0
  let resolved = frontier.length
  while (frontier.length > 0) {
    onProgress?.(0.5 + Math.min(0.49, d / 70) * 0.5, `solving mate-in-${(d >> 1) + 1}`)
    const next: number[] = []
    for (let fi = 0; fi < frontier.length; fi++) {
      const i = frontier[fi]
      const side = i & 1
      const wk = (i >> 1) & 63
      const bk = (i >> 7) & 63
      const bsq = (i >> 13) & 63
      const nsq = (i >> 19) & 63

      if (side === DEF) {
        // Lost-in-d defender position. Its predecessors are strong-to-move
        // positions from which White moved here; each is won in d+1. Illegal
        // predecessors were marked ILLEGAL in pass 1, so the `=== DRAW` guard
        // already rejects them — no need to re-test legality in this hot loop.
        // (a) white king came from an adjacent square.
        const kt = KING_TARGETS[wk]
        for (let k = 0; k < kt.length; k++) {
          const p = index(WIN, kt[k], bk, bsq, nsq)
          if (dtm[p] === DRAW) {
            dtm[p] = d + 1
            next.push(p)
            resolved++
          }
        }
        // (b) bishop slid in from somewhere along a diagonal (path now clear).
        {
          const sf = bsq & 7
          const sr = bsq >> 3
          for (let dir = 0; dir < 4; dir++) {
            const df = dir < 2 ? 1 : -1
            const dr = dir & 1 ? -1 : 1
            for (let f = sf + df, r = sr + dr; f >= 0 && f < 8 && r >= 0 && r < 8; f += df, r += dr) {
              const bsq0 = (r << 3) + f
              if (bsq0 === wk || bsq0 === nsq || bsq0 === bk) break // blocked
              const p = index(WIN, wk, bk, bsq0, nsq)
              if (dtm[p] === DRAW) {
                dtm[p] = d + 1
                next.push(p)
                resolved++
              }
            }
          }
        }
        // (c) knight hopped in from a knight-move away.
        {
          const nt = KNIGHT_TARGETS[nsq]
          for (let k = 0; k < nt.length; k++) {
            const p = index(WIN, wk, bk, bsq, nt[k])
            if (dtm[p] === DRAW) {
              dtm[p] = d + 1
              next.push(p)
              resolved++
            }
          }
        }
      } else {
        // Won-in-d strong position. Its predecessors are defender positions from
        // which the lone king stepped here; decrement their unresolved counter.
        const kt = KING_TARGETS[bk]
        for (let k = 0; k < kt.length; k++) {
          const p = index(DEF, wk, kt[k], bsq, nsq)
          if (dtm[p] === DRAW && count[p] > 0) {
            count[p]--
            if (count[p] === 0) {
              dtm[p] = d + 1 // every child winning, hardest is win-in-d ⇒ lost-in-(d+1)
              next.push(p)
              resolved++
            }
          }
        }
      }
    }
    frontier = next
    d++
  }

  // --- Stats (a full, cheap scan). ---
  let won = 0
  let lost = 0
  let draw = 0
  let illegal = 0
  let maxDtm = 0
  let maxIdx = -1
  for (let i = 0; i < SIZE; i++) {
    const v = dtm[i]
    if (v === ILLEGAL) illegal++
    else if (v === DRAW) draw++
    else if ((i & 1) === WIN) {
      won++
      if (v > maxDtm) {
        maxDtm = v
        maxIdx = i
      }
    } else lost++
  }

  table = dtm
  stats = {
    buildMs: Math.round(now() - t0),
    won,
    lost,
    draw,
    illegal,
    maxDtm,
    maxDtmFen: maxIdx >= 0 ? fenOf(maxIdx) : '',
  }
  void resolved
  onProgress?.(1, 'done')
  return stats
}

// Reconstruct a FEN (white = strong) from a table index, for display/tests.
export function fenOf(i: number): string {
  const side = i & 1
  const wk = (i >> 1) & 63
  const bk = (i >> 7) & 63
  const bsq = (i >> 13) & 63
  const nsq = (i >> 19) & 63
  const board: string[] = Array(64).fill('')
  board[wk] = 'K'
  board[bk] = 'k'
  board[bsq] = 'B'
  board[nsq] = 'N'
  const rows: string[] = []
  for (let r = 7; r >= 0; r--) {
    let row = ''
    let empty = 0
    for (let f = 0; f < 8; f++) {
      const p = board[r * 8 + f]
      if (p === '') empty++
      else {
        if (empty) {
          row += empty
          empty = 0
        }
        row += p
      }
    }
    if (empty) row += empty
    rows.push(row)
  }
  return `${rows.join('/')} ${side === WIN ? 'w' : 'b'} - - 0 1`
}

export interface TbResult {
  win: boolean
  dtm: number // plies to mate (0 at mate); -1 when drawn / not in the table
}

// Probe the table in the canonical (white = strong) frame, given 0..63 squares.
function probeCanonical(wk: number, bk: number, bsq: number, nsq: number, strongToMove: boolean): TbResult {
  if (!table) return { win: false, dtm: -1 }
  const v = table[index(strongToMove ? WIN : DEF, wk, bk, bsq, nsq)]
  return v >= 0 ? { win: true, dtm: v } : { win: false, dtm: -1 }
}

// Probe K+B+N vs K with real-board 0..63 squares. `strongIsWhite` says which
// colour holds the bishop+knight; mirrors black-strong positions into the frame.
export function probeKbnk(
  whiteKing: number,
  blackKing: number,
  bishopSq: number,
  knightSq: number,
  strongIsWhite: boolean,
  whiteToMove: boolean,
): TbResult {
  if (!table) return { win: false, dtm: -1 }
  if (strongIsWhite) {
    return probeCanonical(whiteKing, blackKing, bishopSq, knightSq, whiteToMove)
  }
  // Mirror vertically and swap king roles so the strong side becomes White.
  return probeCanonical(blackKing ^ 56, whiteKing ^ 56, bishopSq ^ 56, knightSq ^ 56, !whiteToMove)
}

// ---- Verification helpers (used by the Lab to *prove* the table) ----

// The strong side's legal moves from a canonical (white-to-move) state, each as
// the resulting defender-to-move index. Used by self-play and consistency tests.
export function strongChildren(wk: number, bk: number, bsq: number, nsq: number): number[] {
  const out: number[] = []
  // King moves.
  for (const t of KING_TARGETS[wk]) {
    if (t === bk || t === bsq || t === nsq) continue
    if (dist(t, bk) <= 1) continue
    out.push(index(DEF, t, bk, bsq, nsq))
  }
  // Bishop slides.
  {
    const sf = bsq & 7
    const sr = bsq >> 3
    for (let dir = 0; dir < 4; dir++) {
      const df = dir < 2 ? 1 : -1
      const dr = dir & 1 ? -1 : 1
      for (let f = sf + df, r = sr + dr; f >= 0 && f < 8 && r >= 0 && r < 8; f += df, r += dr) {
        const q = (r << 3) + f
        if (q === wk || q === nsq || q === bk) break
        out.push(index(DEF, wk, bk, q, nsq))
      }
    }
  }
  // Knight hops.
  for (const t of KNIGHT_TARGETS[nsq]) {
    if (t === wk || t === bk || t === bsq) continue
    out.push(index(DEF, wk, bk, bsq, t))
  }
  return out
}

// The defender's legal replies from a canonical (black-to-move) state. A capture
// of a piece (→ drawn K+minor vs K) is reported as the sentinel DRAW_CHILD.
export const DRAW_CHILD = -3
export function defenderChildren(wk: number, bk: number, bsq: number, nsq: number): number[] {
  const out: number[] = []
  for (const t of KING_TARGETS[bk]) {
    if (t === wk) continue
    if (dist(t, wk) <= 1) continue
    if (t === bsq) {
      if (dist(bsq, wk) >= 2 && !knightAttacks(nsq, bsq)) out.push(DRAW_CHILD)
      continue
    }
    if (t === nsq) {
      if (dist(nsq, wk) >= 2 && !bishopAttacks(bsq, nsq, wk, -1)) out.push(DRAW_CHILD)
      continue
    }
    if (bishopAttacks(bsq, t, wk, nsq)) continue
    if (knightAttacks(nsq, t)) continue
    out.push(index(WIN, wk, t, bsq, nsq)) // black king now on t
  }
  return out
}

// Read a raw DTM value at a canonical index (>=0 won/lost, -1 draw, -2 illegal).
export function rawDtm(i: number): number {
  return table ? table[i] : DRAW
}

export function decodeIndex(i: number): { side: number; wk: number; bk: number; bsq: number; nsq: number } {
  return { side: i & 1, wk: (i >> 1) & 63, bk: (i >> 7) & 63, bsq: (i >> 13) & 63, nsq: (i >> 19) & 63 }
}

// A small deterministic PRNG so the Lab's verification is reproducible.
function splitmix32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x9e3779b9) >>> 0
    let z = s
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad)
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97)
    return (z ^ (z >>> 15)) >>> 0
  }
}

export interface KbnkVerification {
  stats: KbnkStats
  consChecked: number
  consBad: number
  selfPlayGames: number
  selfPlayMated: number
  selfPlayMismatch: number
  verifyMs: number
}

// Prove the table from the inside out, deterministically:
//   1. Retrograde consistency on a random sample — every won position has a child
//      that is lost one ply sooner; every lost position has *all* children winning
//      with the hardest exactly one ply sooner.
//   2. Self-play from random won positions with both sides playing the table's
//      optimal move — the mate must arrive in exactly the stored distance.
export function verifyKbnk(
  sample = 300000,
  games = 3000,
  onProgress?: ProgressFn,
  now: () => number = () => Date.now(),
): KbnkVerification {
  const s = buildKbnk(onProgress ? (f, ph) => onProgress(f * 0.8, ph) : undefined, now)
  const t0 = now()
  const rng = splitmix32(0x1234abcd)
  const ri = (n: number) => rng() % n

  // --- 1. Consistency sample ---
  let consChecked = 0
  let consBad = 0
  let reportAt = 0
  for (let trial = 0; trial < sample; trial++) {
    if (trial >= reportAt) {
      onProgress?.(0.8 + (trial / sample) * 0.1, 'checking consistency')
      reportAt = trial + (sample >> 5)
    }
    const i = ri(SIZE)
    const v = rawDtm(i)
    if (v < 0) continue
    const { side, wk, bk, bsq, nsq } = decodeIndex(i)
    consChecked++
    if (side === WIN) {
      let best = Infinity
      for (const c of strongChildren(wk, bk, bsq, nsq)) {
        const cv = rawDtm(c)
        if (cv >= 0 && cv < best) best = cv
      }
      if (best !== v - 1) consBad++
    } else {
      let max = -1
      let ok = true
      for (const c of defenderChildren(wk, bk, bsq, nsq)) {
        if (c === DRAW_CHILD) {
          ok = false
          break
        }
        const cv = rawDtm(c)
        if (cv < 0) {
          ok = false
          break
        }
        if (cv > max) max = cv
      }
      if (!ok || max !== v - 1) consBad++
    }
  }

  // --- 2. Optimal self-play to mate ---
  let played = 0
  let mated = 0
  let mismatch = 0
  for (let trial = 0; trial < games * 20 && played < games; trial++) {
    const start = ri(SIZE)
    if ((start & 1) !== WIN) continue
    const v0 = rawDtm(start)
    if (v0 < 2) continue
    played++
    let cur = start
    let plies = 0
    let dead = false
    for (;;) {
      const { side, wk, bk, bsq, nsq } = decodeIndex(cur)
      if (side === WIN) {
        let best = -1
        let bv = Infinity
        for (const c of strongChildren(wk, bk, bsq, nsq)) {
          const cv = rawDtm(c)
          if (cv >= 0 && cv < bv) {
            bv = cv
            best = c
          }
        }
        if (best < 0) {
          dead = true
          break
        }
        cur = best
        plies++
      } else {
        if (rawDtm(cur) === 0) {
          mated++
          break
        }
        let best = -1
        let bv = -1
        let drew = false
        for (const c of defenderChildren(wk, bk, bsq, nsq)) {
          if (c === DRAW_CHILD) {
            drew = true
            continue
          }
          const cv = rawDtm(c)
          if (cv > bv) {
            bv = cv
            best = c
          }
        }
        if (drew || best < 0) {
          dead = true
          break
        }
        cur = best
        plies++
      }
      if (plies > 200) {
        dead = true
        break
      }
    }
    if (!dead && plies !== v0) mismatch++
  }

  onProgress?.(1, 'done')
  return {
    stats: s,
    consChecked,
    consBad,
    selfPlayGames: played,
    selfPlayMated: mated,
    selfPlayMismatch: mismatch,
    verifyMs: Math.round(now() - t0),
  }
}

export { SIZE as KBNK_SIZE, WIN as KBNK_WIN, DEF as KBNK_DEF, index as kbnkIndex }
