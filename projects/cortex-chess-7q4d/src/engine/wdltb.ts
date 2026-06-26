// wdltb.ts — a from-scratch Win/Draw/Loss + distance-to-mate retrograde solver for
// the endings with a *piece on both sides* (KQvKR, KRvKB, KRvKN, KQvKB, KQvKN, and
// the symmetric KRvKR / KQvKQ). Built entirely in the browser, no embedded data.
//
// Every other tablebase in this project (egtb.ts, kbnk.ts, gtb.ts) assumes the
// defender is a *lone king*. That makes the game two-valued — the strong side always
// wins (or it's a known draw) — and the retrograde a single "is this won for the
// strong side?" BFS. The moment the defender has a piece of its own the outcome is
// genuinely **three-valued**: the side to move can win, lose, or draw. This module
// solves that general case.
//
// Algorithm (symmetric retrograde over a DTM bucket queue, Dial's algorithm):
//   • Position space is (stm, wk, bk, wp, bp); 2^25 entries (~33.5 M), same scale as
//     KBNvK. Within fixed material *every legal move is quiet* — a capture removes the
//     opponent's only piece and leaves the table.
//   • Captures are typed terminal edges. A capture leaves a 3-man residual in which the
//     *capturer* is the strong side (it keeps its own piece): so a capture is always
//     opp-LOSS when the capturer keeps a major (probe gtb's KQvK/KRvK for the exact
//     length) or opp-DRAW when it keeps a minor (K+minor vs K). You can never capture
//     *into* a still-lost position, so no loss-floor is ever needed.
//   • Seeds: checkmates (LOSS-in-0), capture-wins (WIN at 1 + residual DTM). Stalemates
//     and capture-draws make a position un-losable but still reachable as a WIN.
//   • Propagation: a finalised LOSS pushes its predecessors to WIN (1 + min over winning
//     moves, by bucket order); a finalised WIN decrements a per-node counter of "quiet
//     children not yet known winning" and, when it hits 0, finalises that node LOSS
//     (1 + max). Nodes never resolved settle as DRAW.
//
// Squares are plain 0..63 with sq = rank*8 + file throughout (the canonical frame has
// White = the side holding the config's *first* piece type).

import { KNIGHT, BISHOP, ROOK, QUEEN } from './board'
import { buildGtb, probeGtb } from './gtb'
import { tbCacheLoad, tbCacheSave } from './tbcache'

// Side to move in the canonical frame.
const WHITE = 0
const BLACK = 1

// Build-time node states.
const UNKNOWN = 0 // also the final DRAW marker
const WIN = 1 // side to move wins
const LOSS = 2 // side to move loses
const ILLEGAL = 3
const IMMUNE = 255 // counter sentinel: this node can never be finalised LOSS

// Final encoded table values (signed Int16):
//   v > 0            → side to move wins  in (v - 1) plies (mate delivered)
//   v < 0 && > -30000 → side to move loses in (-v - 1) plies
//   v === 0          → draw
//   v <= -30000      → illegal position
const ENC_ILLEGAL = -30000

function file(s: number): number {
  return s & 7
}
function rank(s: number): number {
  return s >> 3
}
function dist(a: number, b: number): number {
  return Math.max(Math.abs(file(a) - file(b)), Math.abs(rank(a) - rank(b)))
}
function isMajor(t: number): boolean {
  return t === ROOK || t === QUEEN
}

// ---- Precomputed geometry (shared across all configs) ----

const KING_TARGETS: number[][] = []
const KNIGHT_TARGETS: number[][] = []
const KNIGHT_MAP = new Uint8Array(64 * 64)
const RAYS: number[][][] = []
const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
]
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

  const rays: number[][] = []
  for (const [df, dr] of DIRS) {
    const line: number[] = []
    let nf = f + df
    let nr = r + dr
    while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
      line.push(nr * 8 + nf)
      nf += df
      nr += dr
    }
    rays.push(line)
  }
  RAYS.push(rays)
}

const ROOK_DIRS = [0, 1, 2, 3]
const BISHOP_DIRS = [4, 5, 6, 7]
const QUEEN_DIRS = [0, 1, 2, 3, 4, 5, 6, 7]
function dirsFor(type: number): number[] {
  return type === BISHOP ? BISHOP_DIRS : type === ROOK ? ROOK_DIRS : QUEEN_DIRS
}

// Does a piece of `type` on `from` attack `target`, with up to two blocking squares
// (b1, b2; pass -1 to disable)? Knights ignore blockers.
function rayAttack(type: number, from: number, target: number, b1: number, b2: number): boolean {
  if (type === KNIGHT) return KNIGHT_MAP[from * 64 + target] === 1
  const dirs = dirsFor(type)
  const rs = RAYS[from]
  for (let di = 0; di < dirs.length; di++) {
    const ray = rs[dirs[di]]
    for (let k = 0; k < ray.length; k++) {
      const q = ray[k]
      if (q === target) return true
      if (q === b1 || q === b2) break
    }
  }
  return false
}

// ---- Config / registry ----

export interface WdlConfig {
  id: string // e.g. 'KQvKR'
  white: number // White's (canonical strong-frame) piece type
  black: number // Black's piece type
  label: string // human display, e.g. 'K+Q vs K+R'
}

const PIECE_LETTER: Record<number, string> = { [KNIGHT]: 'N', [BISHOP]: 'B', [ROOK]: 'R', [QUEEN]: 'Q' }

function mkConfig(white: number, black: number): WdlConfig {
  return {
    id: `K${PIECE_LETTER[white]}vK${PIECE_LETTER[black]}`,
    white,
    black,
    label: `K+${PIECE_LETTER[white]} vs K+${PIECE_LETTER[black]}`,
  }
}

// The configs the Lab exposes. The asymmetric ones always list the *stronger* piece as
// White so the canonical frame is unambiguous; the symmetric draws round out the WDL story.
export const WDL_CONFIGS: WdlConfig[] = [
  mkConfig(QUEEN, ROOK), // a win — the headline ending
  mkConfig(QUEEN, BISHOP), // a win
  mkConfig(QUEEN, KNIGHT), // a win
  mkConfig(ROOK, BISHOP), // a draw (…Bxr fortress into K+B vs K)
  mkConfig(ROOK, KNIGHT), // a draw
  mkConfig(ROOK, ROOK), // a draw (symmetric)
  mkConfig(QUEEN, QUEEN), // a draw (symmetric)
]

export interface WdlStats {
  id: string
  buildMs: number
  size: number
  legal: number // legal (non-illegal) positions
  whiteWin: number // White-to-move-or-Black-to-move positions that are a White win
  blackWin: number
  draw: number
  illegal: number
  maxDtm: number // longest forced mate in the table (plies)
  maxDtmFen: string
  // Decisiveness from the strong (White) side's view, over legal positions: the
  // fraction of positions that are a White win minus a White loss. Near 0 ⇒ a draw.
  whiteAdvantage: number
}

interface Solved {
  config: WdlConfig
  size: number
  enc: Int16Array // final encoded table
  stats: WdlStats
}

const SOLVED = new Map<string, Solved>()

export type ProgressFn = (frac: number, phase: string) => void

function configById(id: string): WdlConfig | undefined {
  return WDL_CONFIGS.find((c) => c.id === id)
}

// ---- Indexing ----

const SIZE = 1 << 25
function indexN(side: number, wk: number, bk: number, wp: number, bp: number): number {
  return side | (wk << 1) | (bk << 7) | (wp << 13) | (bp << 19)
}

// ---- Capture residual probing ----
//
// After `capturer` (the side to move) captures the opponent's only piece, the
// position is a 3-man ending in which the capturer is the strong side and the
// opponent is a lone king to move. Returns the residual outcome *from that resulting
// position's perspective* (opponent to move): a DTM >= 0 when the opponent is lost
// (the capturer keeps a winning major), or -1 for a draw (a minor, or the major
// somehow fails to win — e.g. it hangs immediately).
//
// `capPieceType` is the capturer's own piece type, `capPieceSq`/`capKingSq` its men
// after the capture, `loneKingSq` the bare king. `capturerIsWhite` says which colour
// the capturer is on the real canonical board (so the gtb probe can mirror).
function residualLossDtm(
  capPieceType: number,
  capKingSq: number,
  capPieceSq: number,
  loneKingSq: number,
  capturerIsWhite: boolean,
): number {
  if (!isMajor(capPieceType)) return -1 // K + lone minor vs K — a draw
  const subId = capPieceType === QUEEN ? 'KQvK' : 'KRvK'
  // The resulting position has the lone king to move. probeGtb wants the real-board
  // white/black king squares plus which colour is strong.
  const r = probeGtb(
    subId,
    capturerIsWhite ? capKingSq : loneKingSq,
    capturerIsWhite ? loneKingSq : capKingSq,
    [capPieceSq],
    capturerIsWhite,
    !capturerIsWhite, // the *lone* king (the opponent) is to move after the capture
  )
  return r.win ? r.dtm : -1
}

// Ensure the 3-man sub-tables this config's captures resolve into are built.
function ensureDeps(config: WdlConfig): void {
  if (isMajor(config.white)) buildGtb(config.white === QUEEN ? 'KQvK' : 'KRvK')
  if (isMajor(config.black)) buildGtb(config.black === QUEEN ? 'KQvK' : 'KRvK')
}

// ---- Build ----

export function buildWdlConfig(config: WdlConfig, onProgress?: ProgressFn, now: () => number = () => Date.now()): WdlStats {
  const existing = SOLVED.get(config.id)
  if (existing) return existing.stats

  const t0 = now()
  ensureDeps(config)
  const wt = config.white
  const bt = config.black

  const state = new Uint8Array(SIZE) // UNKNOWN / WIN / LOSS / ILLEGAL
  const dist8 = new Int16Array(SIZE) // resolved DTM (plies); meaningful when state ∈ {WIN,LOSS}
  const counter = new Uint8Array(SIZE) // unresolved quiet children for loss detection

  // Bucket queue keyed on DTM. Entries are (index << 1) | tag, tag 0 = WIN, 1 = LOSS.
  const buckets: number[][] = []
  const push = (i: number, tag: number, d: number) => {
    while (buckets.length <= d) buckets.push([])
    buckets[d].push((i << 1) | tag)
  }

  // --- Pass 1: legality + classification + seeds. ---
  let reportAt = 0
  for (let i = 0; i < SIZE; i++) {
    if (i >= reportAt) {
      onProgress?.((i / SIZE) * 0.4, 'scanning positions')
      reportAt = i + (SIZE >> 6)
    }
    const side = i & 1
    const wk = (i >> 1) & 63
    const bk = (i >> 7) & 63
    const wp = (i >> 13) & 63
    const bp = (i >> 19) & 63

    // Distinct squares, non-adjacent kings.
    if (wk === bk || wk === wp || wk === bp || bk === wp || bk === bp || wp === bp) {
      state[i] = ILLEGAL
      continue
    }
    if (dist(wk, bk) <= 1) {
      state[i] = ILLEGAL
      continue
    }

    // Side-to-move (s) men vs opponent (o) men.
    const sKing = side === WHITE ? wk : bk
    const sPiece = side === WHITE ? wp : bp
    const sType = side === WHITE ? wt : bt
    const oKing = side === WHITE ? bk : wk
    const oPiece = side === WHITE ? bp : wp
    const oType = side === WHITE ? bt : wt

    // Illegal if the side *not* to move is in check (its king is capturable).
    if (rayAttack(sType, sPiece, oKing, sKing, oPiece)) {
      state[i] = ILLEGAL
      continue
    }

    const inCheck = rayAttack(oType, oPiece, sKing, oKing, sPiece)
    const sIsWhite = side === WHITE

    let quiet = 0
    let winCand = -1 // min (1 + residual DTM) over winning captures
    let drawImmune = false // a capture that reaches a drawn residual

    // King moves.
    const kt = KING_TARGETS[sKing]
    for (let k = 0; k < kt.length; k++) {
      const t = kt[k]
      if (t === sPiece) continue // own piece
      if (dist(t, oKing) <= 1) continue // can't sit next to the enemy king
      if (t === oPiece) {
        // King captures the enemy piece (legal: enemy piece gone, not adjacent oKing).
        const d = residualLossDtm(sType, t, sPiece, oKing, sIsWhite)
        if (d >= 0) {
          const cand = d + 1
          if (winCand < 0 || cand < winCand) winCand = cand
        } else drawImmune = true
        continue
      }
      // Quiet king step: legal iff not attacked by the enemy piece, with our king's
      // *origin* vacated (the only blockers on that ray are oKing and sPiece).
      if (rayAttack(oType, oPiece, t, oKing, sPiece)) continue
      quiet++
    }

    // Piece moves.
    if (sType === KNIGHT) {
      const nt = KNIGHT_TARGETS[sPiece]
      for (let k = 0; k < nt.length; k++) {
        const t = nt[k]
        if (t === sKing || t === oKing) continue
        if (t === oPiece) {
          const d = residualLossDtm(sType, sKing, t, oKing, sIsWhite)
          if (d >= 0) {
            const cand = d + 1
            if (winCand < 0 || cand < winCand) winCand = cand
          } else drawImmune = true
          continue
        }
        // Quiet knight move: legal iff our king isn't left in check (a pin) — the
        // enemy piece's ray to our king now blocked by oKing or our knight at t.
        if (rayAttack(oType, oPiece, sKing, oKing, t)) continue
        quiet++
      }
    } else {
      const dirs = dirsFor(sType)
      const rs = RAYS[sPiece]
      for (let di = 0; di < dirs.length; di++) {
        const ray = rs[dirs[di]]
        for (let k = 0; k < ray.length; k++) {
          const t = ray[k]
          if (t === sKing) break // blocked by our own king
          if (t === oKing) break // blocked by the enemy king
          if (t === oPiece) {
            // Capture the enemy piece (ray stops here).
            const d = residualLossDtm(sType, sKing, t, oKing, sIsWhite)
            if (d >= 0) {
              const cand = d + 1
              if (winCand < 0 || cand < winCand) winCand = cand
            } else drawImmune = true
            break
          }
          // Quiet slide to an empty square: legal iff not a pin violation.
          if (!rayAttack(oType, oPiece, sKing, oKing, t)) quiet++
        }
      }
    }

    const anyMove = quiet > 0 || winCand >= 0 || drawImmune

    if (!anyMove) {
      // Checkmate is LOSS-in-0; stalemate is a draw (left UNKNOWN). Seeds are *not*
      // pre-stated here — pass 2 finalises them on pop so their predecessors propagate.
      if (inCheck) push(i, 1, 0)
      counter[i] = IMMUNE
      continue
    }

    if (winCand >= 0) {
      // Winnable via a capture; a faster quiet win may still be discovered, so seed
      // the candidate but leave the node UNKNOWN until its bucket is reached.
      counter[i] = IMMUNE
      push(i, 0, winCand)
    } else if (drawImmune) {
      counter[i] = IMMUNE // has a drawing capture: can become WIN via retrograde, never LOSS
    } else {
      // Only quiet moves: eligible for both outcomes.
      counter[i] = quiet
    }
  }

  // --- Pass 2: symmetric retrograde over the DTM bucket queue. ---
  // For a node at index i we need the predecessors reachable by a *quiet* move of the
  // side that just moved (the opponent of i's side to move). We enumerate those inline.
  let d = 0
  for (;;) {
    while (d < buckets.length && buckets[d].length === 0) d++
    if (d >= buckets.length) break
    onProgress?.(0.4 + Math.min(0.55, d / 90) * 0.55, `solving mate-in-${(d >> 1) + 1}`)
    const layer = buckets[d]
    buckets[d] = []
    for (let li = 0; li < layer.length; li++) {
      const e = layer[li]
      const i = e >> 1
      const tag = e & 1 // 0 = WIN, 1 = LOSS
      if (state[i] !== UNKNOWN) continue // already finalised at a smaller distance
      state[i] = tag === 0 ? WIN : LOSS
      dist8[i] = d

      // Decode i and the opponent's men (the side that moved to reach i).
      const side = i & 1
      const wk = (i >> 1) & 63
      const bk = (i >> 7) & 63
      const wp = (i >> 13) & 63
      const bp = (i >> 19) & 63
      const oSide = side ^ 1
      const oKing = oSide === WHITE ? wk : bk
      const oPiece = oSide === WHITE ? wp : bp
      const oType = oSide === WHITE ? wt : bt
      // The other three men are fixed across the un-move (blockers for piece un-slides).
      const m1 = side === WHITE ? wk : bk // our king
      const m2 = side === WHITE ? wp : bp // our piece
      // oKing is the third occupied square.

      // Visit a predecessor index `p`.
      const visit =
        tag === 1
          ? (p: number) => {
              // i is LOSS ⇒ predecessor (opponent moved into a lost-for-mover node) WINS.
              if (state[p] === UNKNOWN) push(p, 0, d + 1)
            }
          : (p: number) => {
              // i is WIN ⇒ predecessor needs all its quiet moves to be winning to LOSE.
              if (state[p] === UNKNOWN && counter[p] !== IMMUNE) {
                if (--counter[p] === 0) push(p, 1, d + 1)
              }
            }

      // (a) Opponent king un-moves: it stepped in from an adjacent empty square.
      const okt = KING_TARGETS[oKing]
      for (let k = 0; k < okt.length; k++) {
        const from = okt[k]
        if (from === m1 || from === m2 || from === oPiece) continue
        const p = oSide === WHITE ? indexN(oSide, from, bk, wp, bp) : indexN(oSide, wk, from, wp, bp)
        visit(p)
      }

      // (b) Opponent piece un-moves: it slid/hopped in from an empty square, path clear.
      if (oType === KNIGHT) {
        const nt = KNIGHT_TARGETS[oPiece]
        for (let k = 0; k < nt.length; k++) {
          const from = nt[k]
          if (from === m1 || from === m2 || from === oKing) continue
          const p = oSide === WHITE ? indexN(oSide, wk, bk, from, bp) : indexN(oSide, wk, bk, wp, from)
          visit(p)
        }
      } else {
        const dirs = dirsFor(oType)
        const rs = RAYS[oPiece]
        for (let di = 0; di < dirs.length; di++) {
          const ray = rs[dirs[di]]
          for (let k = 0; k < ray.length; k++) {
            const from = ray[k]
            if (from === m1 || from === m2 || from === oKing) break // blocked
            const p = oSide === WHITE ? indexN(oSide, wk, bk, from, bp) : indexN(oSide, wk, bk, wp, from)
            visit(p)
          }
        }
      }
    }
    d++
  }

  // --- Encode + stats ---
  const enc = new Int16Array(SIZE)
  let legal = 0
  let whiteWin = 0
  let blackWin = 0
  let draw = 0
  let illegal = 0
  let maxDtm = 0
  let maxIdx = -1
  for (let i = 0; i < SIZE; i++) {
    const st = state[i]
    if (st === ILLEGAL) {
      enc[i] = ENC_ILLEGAL
      illegal++
      continue
    }
    legal++
    const side = i & 1
    if (st === WIN) {
      enc[i] = dist8[i] + 1
      if (side === WHITE) whiteWin++
      else blackWin++
      if (dist8[i] > maxDtm) {
        maxDtm = dist8[i]
        maxIdx = i
      }
    } else if (st === LOSS) {
      enc[i] = -(dist8[i] + 1)
      // A LOSS for the side to move is a win for the other colour.
      if (side === WHITE) blackWin++
      else whiteWin++
    } else {
      enc[i] = 0
      draw++
    }
  }

  const whiteAdvantage = legal > 0 ? (whiteWin - blackWin) / legal : 0
  const stats: WdlStats = {
    id: config.id,
    buildMs: Math.round(now() - t0),
    size: SIZE,
    legal,
    whiteWin,
    blackWin,
    draw,
    illegal,
    maxDtm,
    maxDtmFen: maxIdx >= 0 ? fenOfState(config, maxIdx) : '',
    whiteAdvantage,
  }
  SOLVED.set(config.id, { config, size: SIZE, enc, stats })
  onProgress?.(1, 'done')
  return stats
}

export function buildWdl(id: string, onProgress?: ProgressFn, now: () => number = () => Date.now()): WdlStats {
  const config = configById(id)
  if (!config) throw new Error(`unknown WDL tablebase config: ${id}`)
  return buildWdlConfig(config, onProgress, now)
}

export function wdlReady(id: string): boolean {
  return SOLVED.has(id)
}
export function wdlStats(id: string): WdlStats | null {
  return SOLVED.get(id)?.stats ?? null
}
export function wdlSolvedIds(): string[] {
  return [...SOLVED.keys()]
}
export function wdlTable(id: string): Int16Array | null {
  return SOLVED.get(id)?.enc ?? null
}

export function loadWdlTable(id: string, enc: Int16Array, stats: WdlStats): void {
  const config = configById(id)
  if (!config) return
  SOLVED.set(config.id, { config, size: stats.size, enc, stats })
}

// ---- Cache-aware orchestration ----

const CACHE_PREFIX = 'WDL:'

export async function ensureWdl(id: string, onProgress?: ProgressFn): Promise<WdlStats> {
  if (wdlReady(id)) return wdlStats(id)!
  const cached = await tbCacheLoad<WdlStats>(CACHE_PREFIX + id)
  if (cached && cached.meta && cached.meta.id === id && cached.dtm.length === cached.meta.size) {
    const c = configById(id)
    if (c) ensureDeps(c)
    loadWdlTable(id, cached.dtm, cached.meta)
    onProgress?.(1, 'loaded from cache')
    return cached.meta
  }
  const stats = buildWdl(id, onProgress)
  const enc = wdlTable(id)
  if (enc) await tbCacheSave(CACHE_PREFIX + id, enc, stats)
  return stats
}

export async function persistWdl(id: string): Promise<void> {
  const s = SOLVED.get(id)
  if (s) await tbCacheSave(CACHE_PREFIX + id, s.enc, s.stats)
}

export async function tryLoadWdlFromCache(id: string): Promise<boolean> {
  if (wdlReady(id)) return true
  const cached = await tbCacheLoad<WdlStats>(CACHE_PREFIX + id)
  if (cached && cached.meta && cached.meta.id === id && cached.dtm.length === cached.meta.size) {
    const c = configById(id)
    if (c) ensureDeps(c)
    loadWdlTable(id, cached.dtm, cached.meta)
    return true
  }
  return false
}

// ---- FEN reconstruction (canonical frame: White holds config.white) ----

function fenOfState(config: WdlConfig, i: number): string {
  const side = i & 1
  const wk = (i >> 1) & 63
  const bk = (i >> 7) & 63
  const wp = (i >> 13) & 63
  const bp = (i >> 19) & 63
  const board: string[] = Array(64).fill('')
  board[wk] = 'K'
  board[bk] = 'k'
  board[wp] = PIECE_LETTER[config.white]
  board[bp] = PIECE_LETTER[config.black].toLowerCase()
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
  return `${rows.join('/')} ${side === WHITE ? 'w' : 'b'} - - 0 1`
}

// ---- Probe ----

export type Wdl = 'win' | 'loss' | 'draw'
export interface WdlResult {
  wdl: Wdl // from the side-to-move's perspective
  dtm: number // plies to mate (win) / to being mated (loss); 0 for draw / not present
}

function decode(v: number): WdlResult {
  if (v <= ENC_ILLEGAL) return { wdl: 'draw', dtm: 0 }
  if (v > 0) return { wdl: 'win', dtm: v - 1 }
  if (v < 0) return { wdl: 'loss', dtm: -v - 1 }
  return { wdl: 'draw', dtm: 0 }
}

// Probe with real-board 0..63 squares. The caller supplies each colour's king and the
// single non-king piece type+square. The frame is canonicalised so the holder of
// `config.white` becomes canonical White (mirroring vertically + swapping turn when not).
export function probeWdl(
  id: string,
  whiteKing: number,
  blackKing: number,
  whitePieceType: number,
  whitePieceSq: number,
  blackPieceType: number,
  blackPieceSq: number,
  whiteToMove: boolean,
): WdlResult {
  const s = SOLVED.get(id)
  if (!s) return { wdl: 'draw', dtm: 0 }
  const c = s.config
  let wk: number, bk: number, wp: number, bp: number, side: number
  if (whitePieceType === c.white && blackPieceType === c.black) {
    // Real White already holds the canonical White piece.
    wk = whiteKing
    bk = blackKing
    wp = whitePieceSq
    bp = blackPieceSq
    side = whiteToMove ? WHITE : BLACK
  } else if (whitePieceType === c.black && blackPieceType === c.white) {
    // Real colours are swapped relative to the canonical frame: mirror vertically and
    // swap which colour is to move so the config.white holder becomes canonical White.
    wk = blackKing ^ 56
    bk = whiteKing ^ 56
    wp = blackPieceSq ^ 56
    bp = whitePieceSq ^ 56
    side = whiteToMove ? BLACK : WHITE
  } else {
    return { wdl: 'draw', dtm: 0 }
  }
  const res = decode(s.enc[indexN(side, wk, bk, wp, bp)])
  // The result is from the canonical side-to-move's perspective. When we swapped
  // colours, canonical "White to move" corresponds to real Black to move, but the
  // win/loss is still relative to *whoever is to move*, which is preserved — so no
  // further flip of the wdl is needed.
  return res
}

// ===================================================================
//  Verification — proving the engine from the inside out.
// ===================================================================

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

// A child of position i: a quiet successor (the resulting in-table index) or a capture
// terminal whose value is read from the residual sub-table. Values are expressed as the
// resulting position's WDL from *its* side-to-move (the opponent of i's mover).
interface Child {
  kind: 'quiet' | 'cap'
  to: number // quiet successor index (kind === 'quiet')
  res: WdlResult // resulting outcome from the child's side to move
}

// Enumerate the legal children of i. Mirrors pass-1 move generation exactly.
function childrenOf(config: WdlConfig, i: number): Child[] {
  const wt = config.white
  const bt = config.black
  const side = i & 1
  const wk = (i >> 1) & 63
  const bk = (i >> 7) & 63
  const wp = (i >> 13) & 63
  const bp = (i >> 19) & 63
  const sKing = side === WHITE ? wk : bk
  const sPiece = side === WHITE ? wp : bp
  const sType = side === WHITE ? wt : bt
  const oKing = side === WHITE ? bk : wk
  const oPiece = side === WHITE ? bp : wp
  const oType = side === WHITE ? bt : wt
  const sIsWhite = side === WHITE
  const out: Child[] = []

  const capRes = (capKing: number, capPiece: number): WdlResult => {
    const dtm = residualLossDtm(sType, capKing, capPiece, oKing, sIsWhite)
    // From the resulting position's side to move (the lone king / opponent): a positive
    // residual DTM means that lone king is *lost*; -1 means draw.
    return dtm >= 0 ? { wdl: 'loss', dtm } : { wdl: 'draw', dtm: 0 }
  }

  // King moves.
  const kt = KING_TARGETS[sKing]
  for (let k = 0; k < kt.length; k++) {
    const t = kt[k]
    if (t === sPiece) continue
    if (dist(t, oKing) <= 1) continue
    if (t === oPiece) {
      out.push({ kind: 'cap', to: -1, res: capRes(t, sPiece) })
      continue
    }
    if (rayAttack(oType, oPiece, t, oKing, sPiece)) continue
    const np = side === WHITE ? indexN(BLACK, t, bk, wp, bp) : indexN(WHITE, wk, t, wp, bp)
    out.push({ kind: 'quiet', to: np, res: { wdl: 'draw', dtm: 0 } })
  }

  // Piece moves.
  if (sType === KNIGHT) {
    const nt = KNIGHT_TARGETS[sPiece]
    for (let k = 0; k < nt.length; k++) {
      const t = nt[k]
      if (t === sKing || t === oKing) continue
      if (t === oPiece) {
        out.push({ kind: 'cap', to: -1, res: capRes(sKing, t) })
        continue
      }
      if (rayAttack(oType, oPiece, sKing, oKing, t)) continue
      const np = side === WHITE ? indexN(BLACK, wk, bk, t, bp) : indexN(WHITE, wk, bk, wp, t)
      out.push({ kind: 'quiet', to: np, res: { wdl: 'draw', dtm: 0 } })
    }
  } else {
    const dirs = dirsFor(sType)
    const rs = RAYS[sPiece]
    for (let di = 0; di < dirs.length; di++) {
      const ray = rs[dirs[di]]
      for (let k = 0; k < ray.length; k++) {
        const t = ray[k]
        if (t === sKing) break
        if (t === oKing) break
        if (t === oPiece) {
          out.push({ kind: 'cap', to: -1, res: capRes(sKing, t) })
          break
        }
        if (!rayAttack(oType, oPiece, sKing, oKing, t)) {
          const np = side === WHITE ? indexN(BLACK, wk, bk, t, bp) : indexN(WHITE, wk, bk, wp, t)
          out.push({ kind: 'quiet', to: np, res: { wdl: 'draw', dtm: 0 } })
        }
      }
    }
  }
  return out
}

// The negamax value of i recomputed purely from its children's *stored* values.
function bellmanValue(s: Solved, i: number): WdlResult {
  const kids = childrenOf(s.config, i)
  if (kids.length === 0) {
    // Terminal: mate (lost) or stalemate (draw). Detect check.
    const side = i & 1
    const wk = (i >> 1) & 63
    const bk = (i >> 7) & 63
    const wp = (i >> 13) & 63
    const bp = (i >> 19) & 63
    const sKing = side === WHITE ? wk : bk
    const oPiece = side === WHITE ? bp : wp
    const oType = side === WHITE ? s.config.black : s.config.white
    const oKing = side === WHITE ? bk : wk
    const sPiece = side === WHITE ? wp : bp
    return rayAttack(oType, oPiece, sKing, oKing, sPiece) ? { wdl: 'loss', dtm: 0 } : { wdl: 'draw', dtm: 0 }
  }
  // Resolve each child's outcome from the child's side to move.
  let anyLossChild = false
  let minLoss = Infinity // fastest move to a child that is a loss for them (we win)
  let allWin = true
  let maxWin = -1
  for (const c of kids) {
    const r = c.kind === 'quiet' ? decode(s.enc[c.to]) : c.res
    if (r.wdl === 'loss') {
      anyLossChild = true
      if (r.dtm < minLoss) minLoss = r.dtm
    }
    if (r.wdl === 'win') {
      if (r.dtm > maxWin) maxWin = r.dtm
    } else {
      allWin = false // a draw or loss child means we are not lost
    }
  }
  if (anyLossChild) return { wdl: 'win', dtm: minLoss + 1 }
  if (allWin) return { wdl: 'loss', dtm: maxWin + 1 }
  return { wdl: 'draw', dtm: 0 }
}

export interface WdlVerification {
  id: string
  stats: WdlStats
  // Bellman optimality on a random sample.
  consChecked: number
  consBad: number
  // Optimal self-play to mate (follows captures into sub-tables).
  selfPlayGames: number
  selfPlayOk: number
  selfPlayMismatch: number
  // Theory cross-checks.
  theoryName: string
  theoryExpectDecisive: boolean
  theoryPass: boolean
  verifyMs: number
}

// Drive optimal play from a decisive root and confirm the realised mate length equals
// the stored DTM. The winner minimises DTM; the loser maximises it; on a capture the
// game enters a residual sub-table whose (already verified) DTM is added on.
function selfPlayLength(s: Solved, start: number): number | null {
  let idx = start
  let plies = 0
  for (let guard = 0; guard < 400; guard++) {
    const v = decode(s.enc[idx])
    if (v.wdl === 'draw') return null
    if (v.dtm === 0) return plies // mate on the board
    const kids = childrenOf(s.config, idx)
    let chosen: Child | null = null
    if (v.wdl === 'win') {
      // Move to a child that is a loss for them, minimal DTM (must equal v.dtm - 1).
      let best = Infinity
      for (const c of kids) {
        const r = c.kind === 'quiet' ? decode(s.enc[c.to]) : c.res
        if (r.wdl === 'loss' && r.dtm < best) {
          best = r.dtm
          chosen = c
        }
      }
    } else {
      // Lost: every child is a win for them; resist longest (maximal DTM = v.dtm - 1).
      let best = -1
      for (const c of kids) {
        const r = c.kind === 'quiet' ? decode(s.enc[c.to]) : c.res
        if (r.wdl === 'win' && r.dtm > best) {
          best = r.dtm
          chosen = c
        }
      }
    }
    if (!chosen) return null
    plies++
    if (chosen.kind === 'cap') {
      // The capture resolves into a sub-table; its residual DTM completes the line.
      const r = chosen.res
      return plies + r.dtm
    }
    idx = chosen.to
  }
  return null
}

export function verifyWdl(
  id: string,
  opts: { sample?: number; games?: number } = {},
  onProgress?: ProgressFn,
  now: () => number = () => Date.now(),
): WdlVerification {
  const stats = buildWdl(id, onProgress ? (f, ph) => onProgress(f * 0.55, ph) : undefined, now)
  const s = SOLVED.get(id)!
  const t0 = now()
  const rng = splitmix32(0x1d2b3c4d)
  const ri = (m: number) => rng() % m
  const sample = opts.sample ?? 250000
  const games = opts.games ?? 2000

  // --- 1. Bellman optimality ---
  let consChecked = 0
  let consBad = 0
  let reportAt = 0
  for (let trial = 0; trial < sample; trial++) {
    if (trial >= reportAt) {
      onProgress?.(0.55 + (trial / sample) * 0.3, 'checking optimality')
      reportAt = trial + (sample >> 5)
    }
    const i = ri(s.size)
    const v = decode(s.enc[i])
    if (s.enc[i] <= ENC_ILLEGAL) continue
    consChecked++
    const b = bellmanValue(s, i)
    if (b.wdl !== v.wdl || b.dtm !== v.dtm) consBad++
  }

  // --- 2. Optimal self-play to mate ---
  let played = 0
  let ok = 0
  let mismatch = 0
  for (let trial = 0; trial < games * 60 && played < games; trial++) {
    const i = ri(s.size)
    const v = decode(s.enc[i])
    if (s.enc[i] <= ENC_ILLEGAL || v.wdl === 'draw' || v.dtm < 2) continue
    played++
    const realised = selfPlayLength(s, i)
    if (realised === v.dtm) ok++
    else mismatch++
  }

  // --- 3. Theory cross-check ---
  // The asymmetric "major vs minor/rook" endings are decisive for White (the stronger
  // piece); "rook vs minor" and the symmetric endings are draws. We check the sign and
  // magnitude of the table's overall advantage.
  const c = s.config
  const expectDecisive = c.white === QUEEN
  const drawFrac = stats.legal > 0 ? stats.draw / stats.legal : 0
  // A side can win only by keeping a *major* after a capture, so the defender wins a
  // (small) share iff its own piece is a major: KQvKR's rook side wins the positions
  // where it snaps off a hanging queen, but a lone minor never wins.
  const blackWinSane = stats.blackWin > 0 === isMajor(c.black)
  let theoryPass: boolean
  if (c.white === c.black) {
    // Symmetric material: exactly balanced, both sides win equal nonzero fractions.
    theoryPass = Math.abs(stats.whiteAdvantage) < 0.001 && stats.blackWin > 0
  } else if (expectDecisive) {
    // KQ vs a single piece is overwhelmingly a White win, with the known
    // fortress/stalemate draws present.
    theoryPass = stats.whiteAdvantage > 0.4 && stats.draw > 0 && blackWinSane
  } else {
    // K+R vs K+minor: a *general draw* — the minor side can never win (blackWin === 0)
    // and the position is drawn far more often than the rook converts.
    theoryPass = stats.blackWin === 0 && drawFrac > 0.6
  }

  onProgress?.(1, 'done')
  return {
    id,
    stats,
    consChecked,
    consBad,
    selfPlayGames: played,
    selfPlayOk: ok,
    selfPlayMismatch: mismatch,
    theoryName: c.label,
    theoryExpectDecisive: expectDecisive,
    theoryPass,
    verifyMs: Math.round(now() - t0),
  }
}
