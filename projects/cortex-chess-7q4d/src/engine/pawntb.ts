// pawntb.ts — the first *pawnful* endgame tablebase: King + Pawn vs King solved as
// an exact **distance-to-mate** table, generated in the browser by retrograde
// analysis (no embedded data).
//
// Every retrograde table the engine has shipped so far — `egtb.ts` (KRvK/KQvK),
// `kbnk.ts` (KBNvK), the material-generic `gtb.ts`, and even the three-valued
// `wdltb.ts` — is **pawnless**: the material on the board never changes, so the
// whole solve lives inside one fixed position space. A pawn breaks that. A pawn
// pushes (it is the one piece that cannot move backwards, so the position space is
// a DAG in the pawn's rank) and, decisively, it **promotes** — a pawn reaching the
// last rank *leaves KPvK entirely* and becomes a brand-new K+Q-vs-K or K+R-vs-K
// position. There is no checkmate in KPvK at all: a lone king and a single pawn can
// never mate. **Every win flows through a promotion**, so the win values of this
// table are seeded not by mates but by *promotion edges into the already-solved
// KQvK / KRvK distance-to-mate tables* (`egtb.ts`). The pawn side promotes to the
// queen — or, when a queen would only stalemate, *underpromotes to a rook* — and
// the table's DTM is `1 (the promotion) + the sub-table's DTM to mate`. That single
// cross-table edge is what makes this the engine's first pawn ending, and it is why
// the table plays KPvK with literally perfect technique: it queens with the fastest
// forced mate and never stalemates a won pawn.
//
// Canonical frame: the pawn always belongs to White and marches up the board
// (toward square 56..63). The probe mirrors colours/ranks before looking up, so the
// solver only ever reasons about a white pawn. Squares are plain 0..63 with
// sq = rank * 8 + file (rank 0 = White's home rank).

import { ROOK, QUEEN } from './board'
import { probeKxK } from './egtb'
import { kpkWin } from './kpk'
import { tbCacheLoad, tbCacheSave } from './tbcache'

const WIN_TO_MOVE = 0 // strong side (the pawn) to move
const DEF_TO_MOVE = 1 // defender (the lone king) to move

// index = us(1) | wk(6) | bk(6) | psq(6)  →  up to 1 << 19 entries.
const SIZE = 1 << 19
const UNKNOWN = -1 // unresolved during the sweep; a draw once the sweep converges
const ILLEGAL = -2

// The pawn lives on ranks 1..6 (squares 8..55). Rank 0 is impossible; a pawn on
// rank 7 has already promoted and is no longer a KPvK position.
const PAWN_MIN = 8
const PAWN_MAX = 55

function file(s: number): number {
  return s & 7
}
function rank(s: number): number {
  return s >> 3
}
function dist(a: number, b: number): number {
  return Math.max(Math.abs(file(a) - file(b)), Math.abs(rank(a) - rank(b)))
}

// Precomputed king-move target lists (0..63 board).
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

function index(us: number, wk: number, bk: number, psq: number): number {
  return us | (wk << 1) | (bk << 7) | (psq << 13)
}

// Does a white pawn on `psq` attack square `t`?
function pawnAttacks(psq: number, t: number): boolean {
  const f = file(psq)
  return (f > 0 && t === psq + 7) || (f < 7 && t === psq + 9)
}

// The DTM (in plies) of promoting the pawn on rank 7 (`promoSq` on the 8th rank) to
// `piece`, with the kings at wk/bk and the defender to move afterwards — read from
// the already-solved KQvK / KRvK table. Returns -1 if that promotion does not win
// (the new piece hangs to the lone king → a drawn K+piece-less ending). Only Q and
// R are ever winning tries; a bishop or knight promotion is an immediate draw.
function promoDtm(piece: number, wk: number, bk: number, promoSq: number): number {
  const r = probeKxK(piece, wk, bk, promoSq, true, false)
  return r.win ? r.dtm : -1
}

export interface PawnTbStats {
  legal: number // legal positions in the table
  wins: number // positions won for the pawn side
  draws: number // legal positions that are drawn
  maxDtm: number // longest forced mate (plies)
  maxDtmFen: string // a FEN realising that longest win
}

export class PawnTablebase {
  private dtm: Int16Array | null = null

  // Legality of a raw (us, wk, bk, psq) tuple in the canonical (white pawn) frame:
  // distinct squares, non-adjacent kings, pawn on a real rank, and — because the
  // side *not* to move may not already be in check — when it's the pawn side to
  // move the black king must not be standing on a square the pawn attacks.
  private legal(us: number, wk: number, bk: number, psq: number): boolean {
    if (psq < PAWN_MIN || psq > PAWN_MAX) return false
    if (wk === bk || wk === psq || bk === psq) return false
    if (dist(wk, bk) <= 1) return false
    if (us === WIN_TO_MOVE && pawnAttacks(psq, bk)) return false
    return true
  }

  private build(): Int16Array {
    const d = new Int16Array(SIZE).fill(UNKNOWN)

    // Seed: mark illegal positions, and the defender's no-move terminals. There is
    // no checkmate in KPvK (a king + pawn cannot mate), but a pawn *can* give check,
    // so a defender with no legal move is mate (DTM 0) if checked, else stalemate
    // (a draw — flagged ILLEGAL, i.e. "not a win", so the strong side avoids it).
    for (let us = 0; us < 2; us++) {
      for (let wk = 0; wk < 64; wk++) {
        for (let bk = 0; bk < 64; bk++) {
          if (dist(wk, bk) <= 1) continue
          for (let psq = PAWN_MIN; psq <= PAWN_MAX; psq++) {
            const i = index(us, wk, bk, psq)
            if (!this.legal(us, wk, bk, psq)) {
              d[i] = ILLEGAL
              continue
            }
            if (us === DEF_TO_MOVE && this.defenderHasNoMove(wk, bk, psq)) {
              d[i] = pawnAttacks(psq, bk) ? 0 : ILLEGAL
            }
          }
        }
      }
    }

    // Retrograde fixed point. At sweep `dd` we assign every position whose optimal
    // DTM is exactly dd+1: a pawn-side position that can reach a known win-in-dd
    // (a quiet move into the table, or a *promotion* whose sub-table DTM is dd), or
    // a defender position whose every move loses and whose hardest defence is
    // win-in-dd. The smallest possible win is dd=0 → promote straight into mate.
    let dd = 0
    for (;;) {
      let changed = false
      for (let us = 0; us < 2; us++) {
        for (let wk = 0; wk < 64; wk++) {
          for (let bk = 0; bk < 64; bk++) {
            if (dist(wk, bk) <= 1) continue
            for (let psq = PAWN_MIN; psq <= PAWN_MAX; psq++) {
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

  // True if the pawn side (to move) has a move reaching a defender position already
  // known to be win-in-`dd` — a king move, a pawn push, or a promotion whose
  // resulting KQvK/KRvK position is win-in-dd for the queen/rook side.
  private classifyStrong(wk: number, bk: number, psq: number, dd: number, d: Int16Array): boolean {
    // King moves.
    for (const t of KING_TARGETS[wk]) {
      if (t === bk || t === psq) continue
      if (dist(t, bk) <= 1) continue
      if (d[index(DEF_TO_MOVE, t, bk, psq)] === dd) return true
    }
    // Pawn moves.
    const pr = rank(psq)
    if (pr <= 5) {
      // A quiet push (and, from the 2nd rank, a double push) to a square the table
      // still owns — the pawn has not yet reached the promotion rank.
      const push = psq + 8
      if (push !== wk && push !== bk) {
        if (d[index(DEF_TO_MOVE, wk, bk, push)] === dd) return true
        if (pr === 1) {
          const dbl = psq + 16
          if (dbl !== wk && dbl !== bk && d[index(DEF_TO_MOVE, wk, bk, dbl)] === dd) return true
        }
      }
    } else {
      // pr === 6: the push promotes and leaves the table. The move costs one ply and
      // hands off to the KQvK / KRvK sub-table at its own DTM.
      const promoSq = psq + 8
      if (promoSq !== wk && promoSq !== bk) {
        if (promoDtm(QUEEN, wk, bk, promoSq) === dd) return true
        if (promoDtm(ROOK, wk, bk, promoSq) === dd) return true
      }
    }
    return false
  }

  // True if the defender (to move) is lost in exactly dd+1: every legal move leads
  // to a pawn-side win, and the hardest of them is win-in-dd. A move that draws —
  // an escape into the table's drawn region, or capturing an undefended pawn into
  // bare kings — refutes the loss.
  private classifyDefender(wk: number, bk: number, psq: number, dd: number, d: Int16Array): boolean {
    let maxChild = -1
    let any = false
    for (const t of KING_TARGETS[bk]) {
      if (t === wk) continue
      if (dist(t, wk) <= 1) continue
      if (t === psq) {
        // Capturing the pawn. Legal only if it isn't defended by the white king;
        // the result is bare kings — a draw, so the defender survives.
        if (dist(psq, wk) >= 2) return false
        continue
      }
      // Quiet king move: illegal if it steps onto a square the pawn attacks.
      if (pawnAttacks(psq, t)) continue
      any = true
      const child = d[index(WIN_TO_MOVE, wk, t, psq)]
      if (child < 0) return false // a draw / unresolved escape → not (yet) lost
      if (child > maxChild) maxChild = child
    }
    if (!any) return false // no quiet move: handled as mate / stalemate in the seed pass
    return maxChild === dd
  }

  // The defender (to move) has no legal move at all (→ mate or stalemate).
  private defenderHasNoMove(wk: number, bk: number, psq: number): boolean {
    for (const t of KING_TARGETS[bk]) {
      if (t === wk) continue
      if (dist(t, wk) <= 1) continue
      if (t === psq) {
        if (dist(psq, wk) >= 2) return false // can grab the undefended pawn → has a move
        continue
      }
      if (pawnAttacks(psq, t)) continue
      return false // found a legal king move
    }
    return true
  }

  private ensure(): Int16Array {
    if (!this.dtm) this.dtm = this.build()
    return this.dtm
  }

  get ready(): boolean {
    return this.dtm !== null
  }

  // Direct buffer access for IndexedDB persistence (the Int16Array fully encodes the
  // solved table — probing it needs no sub-tables once built).
  buffer(): Int16Array | null {
    return this.dtm
  }
  load(buf: Int16Array): void {
    if (buf.length === SIZE) this.dtm = buf
  }

  // Probe in the canonical (white = pawn side) frame. Returns DTM in plies, or -1
  // for a draw / illegal lookup.
  probe(wk: number, bk: number, psq: number, strongToMove: boolean): number {
    const d = this.ensure()
    const v = d[index(strongToMove ? WIN_TO_MOVE : DEF_TO_MOVE, wk, bk, psq)]
    return v >= 0 ? v : -1
  }

  stats(): PawnTbStats {
    const d = this.ensure()
    let legal = 0
    let wins = 0
    let draws = 0
    let maxDtm = -1
    let maxDtmFen = ''
    for (let us = 0; us < 2; us++) {
      for (let wk = 0; wk < 64; wk++) {
        for (let bk = 0; bk < 64; bk++) {
          for (let psq = PAWN_MIN; psq <= PAWN_MAX; psq++) {
            const v = d[index(us, wk, bk, psq)]
            if (v === ILLEGAL) continue
            legal++
            if (v >= 0) {
              wins++
              if (v > maxDtm) {
                maxDtm = v
                maxDtmFen = canonicalFen(us, wk, bk, psq)
              }
            } else {
              draws++
            }
          }
        }
      }
    }
    return { legal, wins, draws, maxDtm: Math.max(0, maxDtm), maxDtmFen }
  }
}

// Build a FEN for a canonical-frame position (white pawn, kings at wk/bk).
function canonicalFen(us: number, wk: number, bk: number, psq: number): string {
  const board: string[] = new Array(64).fill('')
  board[wk] = 'K'
  board[bk] = 'k'
  board[psq] = 'P'
  let placement = ''
  for (let r = 7; r >= 0; r--) {
    let empty = 0
    for (let f = 0; f < 8; f++) {
      const c = board[r * 8 + f]
      if (c) {
        if (empty) placement += empty
        empty = 0
        placement += c
      } else empty++
    }
    if (empty) placement += empty
    if (r > 0) placement += '/'
  }
  return `${placement} ${us === WIN_TO_MOVE ? 'w' : 'b'} - - 0 1`
}

// --- The single instance + public surface (mirrors egtb / gtb / wdl) -------------

const TABLE = new PawnTablebase()

export function buildPawnTb(): void {
  TABLE.probe(0, 0, PAWN_MIN, true) // force the lazy build (harmless illegal lookup)
}

export function ensurePawnTb(): void {
  buildPawnTb()
}

export function pawnTbReady(): boolean {
  return TABLE.ready
}

export function pawnTbStats(): PawnTbStats {
  return TABLE.stats()
}

// ---- IndexedDB persistence (mirrors gtb / wdl) ----------------------------------

const CACHE_KEY = 'KPvK'

// Persist an already-built table so it survives a reload and re-hydrates instantly
// in the play worker (no multi-second rebuild mid-move).
export async function persistPawnTb(): Promise<void> {
  const buf = TABLE.buffer()
  if (buf) await tbCacheSave(CACHE_KEY, buf, TABLE.stats())
}

// Hydrate the table from the cache only (never builds). Returns whether it is now
// resident — called by the play worker before searching a KPvK ending.
export async function tryLoadPawnTbFromCache(): Promise<boolean> {
  if (TABLE.ready) return true
  const cached = await tbCacheLoad<PawnTbStats>(CACHE_KEY)
  if (cached && cached.dtm.length === SIZE) {
    TABLE.load(cached.dtm)
    return true
  }
  return false
}

export interface PawnTbResult {
  win: boolean
  dtm: number // plies to mate (counting the promotion + the sub-table's mate); -1 if drawn
}

// Probe King + Pawn vs King. Inputs are 0..63 squares in the *real* board frame; the
// pawn's owner is given by `pawnIsWhite`, and `whiteToMove` is the real side to move.
// Mirrors a black pawn into the canonical white-pawn frame.
export function probePawnKvK(
  whiteKing: number,
  blackKing: number,
  pawnSq: number,
  pawnIsWhite: boolean,
  whiteToMove: boolean,
): PawnTbResult {
  let wk: number
  let bk: number
  let psq: number
  let strongToMove: boolean
  if (pawnIsWhite) {
    wk = whiteKing
    bk = blackKing
    psq = pawnSq
    strongToMove = whiteToMove
  } else {
    // Mirror vertically and swap king roles so the pawn side becomes White.
    wk = blackKing ^ 56
    bk = whiteKing ^ 56
    psq = pawnSq ^ 56
    strongToMove = !whiteToMove
  }
  const dtm = TABLE.probe(wk, bk, psq, strongToMove)
  return dtm >= 0 ? { win: true, dtm } : { win: false, dtm: -1 }
}

// --- Verification ----------------------------------------------------------------

export interface PawnTbVerification {
  stats: PawnTbStats
  // (1) Exhaustive WDL agreement against the independent kpk.ts bitbase.
  oracleChecked: number
  oracleMismatch: number
  // (2) Bellman optimality on a sample of resolved positions.
  bellmanChecked: number
  bellmanBad: number
  // (3) Self-play to promotion: the stored DTM equals plies-to-promotion + the
  // promoting move's sub-table DTM, played out move by move inside the table.
  selfPlayGames: number
  selfPlayBad: number
  selfPlayOk: number
}

// A small deterministic RNG so verification samples are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Re-derive a position's value from first principles (negamax over the legal move
// tree, one ply deep, reading children from the table and promotions from the
// sub-tables) and compare it to the stored value — the Bellman optimality test.
function bellmanValue(us: number, wk: number, bk: number, psq: number, probe: (u: number, a: number, b: number, c: number) => number): number {
  if (us === WIN_TO_MOVE) {
    // Pawn side: win iff some move reaches a defender-loss; DTM = 1 + min child DTM.
    let best = Infinity
    for (const t of KING_TARGETS[wk]) {
      if (t === bk || t === psq || dist(t, bk) <= 1) continue
      const c = probe(DEF_TO_MOVE, t, bk, psq)
      if (c >= 0) best = Math.min(best, 1 + c)
    }
    const pr = rank(psq)
    if (pr <= 5) {
      const push = psq + 8
      if (push !== wk && push !== bk) {
        const c = probe(DEF_TO_MOVE, wk, bk, push)
        if (c >= 0) best = Math.min(best, 1 + c)
        if (pr === 1) {
          const dbl = psq + 16
          if (dbl !== wk && dbl !== bk) {
            const c2 = probe(DEF_TO_MOVE, wk, bk, dbl)
            if (c2 >= 0) best = Math.min(best, 1 + c2)
          }
        }
      }
    } else {
      const promoSq = psq + 8
      if (promoSq !== wk && promoSq !== bk) {
        const q = promoDtm(QUEEN, wk, bk, promoSq)
        if (q >= 0) best = Math.min(best, 1 + q)
        const r = promoDtm(ROOK, wk, bk, promoSq)
        if (r >= 0) best = Math.min(best, 1 + r)
      }
    }
    return best === Infinity ? -1 : best
  }
  // Defender: lost iff every legal move loses; DTM = 1 + max child DTM. Any drawing
  // move (escape into a drawn child, or capturing an undefended pawn) → draw.
  let worst = -1
  let any = false
  for (const t of KING_TARGETS[bk]) {
    if (t === wk || dist(t, wk) <= 1) continue
    if (t === psq) {
      if (dist(psq, wk) >= 2) return -1 // capture undefended pawn → draw
      continue
    }
    if (pawnAttacks(psq, t)) continue
    any = true
    const c = probe(WIN_TO_MOVE, wk, t, psq)
    if (c < 0) return -1 // a drawing escape
    worst = Math.max(worst, 1 + c)
  }
  if (!any) return -1 // no move: mate/stalemate, handled as a terminal elsewhere
  return worst
}

export function verifyPawnTb(
  opts: { sample?: number; games?: number } = {},
  onProgress?: (frac: number, phase: string) => void,
): PawnTbVerification {
  const sample = opts.sample ?? 60000
  const games = opts.games ?? 1500
  const table = TABLE
  table.probe(0, 0, PAWN_MIN, true) // ensure built
  const stats = table.stats()

  const probe = (u: number, a: number, b: number, c: number): number => table.probe(a, b, c, u === WIN_TO_MOVE)

  // (1) Exhaustive WDL agreement vs the independent kpk.ts bitbase. For every legal
  // canonical position the pawn-side win/draw verdict must match exactly.
  let oracleChecked = 0
  let oracleMismatch = 0
  for (let us = 0; us < 2; us++) {
    for (let wk = 0; wk < 64; wk++) {
      for (let bk = 0; bk < 64; bk++) {
        if (dist(wk, bk) <= 1) continue
        for (let psq = PAWN_MIN; psq <= PAWN_MAX; psq++) {
          if (wk === bk || wk === psq || bk === psq) continue
          if (us === WIN_TO_MOVE && pawnAttacks(psq, bk)) continue
          const mine = table.probe(wk, bk, psq, us === WIN_TO_MOVE) >= 0
          const oracle = kpkWin(wk, bk, psq, us === WIN_TO_MOVE)
          oracleChecked++
          if (mine !== oracle) oracleMismatch++
        }
      }
    }
    onProgress?.((us + 1) / 4, 'WDL oracle (vs kpk bitbase)')
  }

  // (2) Bellman optimality on a random sample of resolved positions.
  const rng = mulberry32(0x9e3779b9)
  let bellmanChecked = 0
  let bellmanBad = 0
  for (let n = 0; n < sample; n++) {
    const us = rng() < 0.5 ? WIN_TO_MOVE : DEF_TO_MOVE
    const wk = (rng() * 64) | 0
    const bk = (rng() * 64) | 0
    const psq = PAWN_MIN + ((rng() * (PAWN_MAX - PAWN_MIN + 1)) | 0)
    if (wk === bk || wk === psq || bk === psq || dist(wk, bk) <= 1) continue
    if (us === WIN_TO_MOVE && pawnAttacks(psq, bk)) continue
    const stored = table.probe(wk, bk, psq, us === WIN_TO_MOVE)
    const recomputed = bellmanValue(us, wk, bk, psq, probe)
    bellmanChecked++
    if (stored !== recomputed) bellmanBad++
    if ((n & 8191) === 0) onProgress?.(0.5 + (0.4 * n) / sample, 'Bellman optimality')
  }

  // (3) Self-play to promotion. From a random won pawn-side root, play the side to
  // move optimally (pawn side minimises DTM, defender maximises it) using the table,
  // counting plies until the pawn promotes; that count plus the promoting move's
  // sub-table DTM must equal the root's stored DTM.
  let selfPlayGames = 0
  let selfPlayOk = 0
  let selfPlayBad = 0
  for (let g = 0; g < games * 6 && selfPlayGames < games; g++) {
    const wk0 = (rng() * 64) | 0
    const bk0 = (rng() * 64) | 0
    const psq0 = PAWN_MIN + ((rng() * (PAWN_MAX - PAWN_MIN + 1)) | 0)
    if (wk0 === bk0 || wk0 === psq0 || bk0 === psq0 || dist(wk0, bk0) <= 1) continue
    if (pawnAttacks(psq0, bk0)) continue
    const rootDtm = table.probe(wk0, bk0, psq0, true)
    if (rootDtm < 0) continue
    selfPlayGames++
    const r = playToPromotion(wk0, bk0, psq0, probe)
    if (r && r.plies + r.promoDtm === rootDtm) selfPlayOk++
    else selfPlayBad++
  }
  onProgress?.(1, 'self-play to promotion')

  return {
    stats,
    oracleChecked,
    oracleMismatch,
    bellmanChecked,
    bellmanBad,
    selfPlayGames,
    selfPlayBad,
    selfPlayOk,
  }
}

// Drive optimal KPvK play from a won, pawn-side-to-move root until the pawn
// promotes, returning the number of plies played and the promoting move's sub-table
// DTM. Returns null if play ever leaves the won region (which would be a bug).
function playToPromotion(
  wk0: number,
  bk0: number,
  psq0: number,
  probe: (u: number, a: number, b: number, c: number) => number,
): { plies: number; promoDtm: number } | null {
  let wk = wk0
  let bk = bk0
  let psq = psq0
  let us = WIN_TO_MOVE
  for (let ply = 0; ply < 256; ply++) {
    if (us === WIN_TO_MOVE) {
      // Pick the move minimising DTM; a promotion ends the KPvK phase.
      let best = Infinity
      let mv: { wk: number; bk: number; psq: number } | null = null
      let promo: number | null = null
      for (const t of KING_TARGETS[wk]) {
        if (t === bk || t === psq || dist(t, bk) <= 1) continue
        const c = probe(DEF_TO_MOVE, t, bk, psq)
        if (c >= 0 && 1 + c < best) {
          best = 1 + c
          mv = { wk: t, bk, psq }
          promo = null
        }
      }
      const pr = rank(psq)
      if (pr <= 5) {
        const push = psq + 8
        if (push !== wk && push !== bk) {
          const c = probe(DEF_TO_MOVE, wk, bk, push)
          if (c >= 0 && 1 + c < best) {
            best = 1 + c
            mv = { wk, bk, psq: push }
            promo = null
          }
          if (pr === 1) {
            const dbl = psq + 16
            if (dbl !== wk && dbl !== bk) {
              const c2 = probe(DEF_TO_MOVE, wk, bk, dbl)
              if (c2 >= 0 && 1 + c2 < best) {
                mv = { wk, bk, psq: dbl }
                promo = null
              }
            }
          }
        }
      } else {
        const promoSq = psq + 8
        if (promoSq !== wk && promoSq !== bk) {
          const q = promoDtm(QUEEN, wk, bk, promoSq)
          if (q >= 0 && 1 + q < best) {
            best = 1 + q
            promo = q
          }
          const rr = promoDtm(ROOK, wk, bk, promoSq)
          if (rr >= 0 && 1 + rr < best) {
            promo = rr
          }
        }
      }
      if (promo !== null) return { plies: ply + 1, promoDtm: promo }
      if (!mv) return null
      wk = mv.wk
      bk = mv.bk
      psq = mv.psq
      us = DEF_TO_MOVE
    } else {
      // Defender plays the move maximising DTM (longest resistance).
      let worst = -1
      let mv: { wk: number; bk: number; psq: number } | null = null
      for (const t of KING_TARGETS[bk]) {
        if (t === wk || dist(t, wk) <= 1) continue
        if (t === psq) {
          if (dist(psq, wk) >= 2) return null // could capture into a draw → root wasn't won
          continue
        }
        if (pawnAttacks(psq, t)) continue
        const c = probe(WIN_TO_MOVE, wk, t, psq)
        if (c < 0) return null // a drawing escape from a "won" position → bug
        if (c > worst) {
          worst = c
          mv = { wk, bk: t, psq }
        }
      }
      if (!mv) return null // mate/stalemate before promotion — impossible in KPvK
      wk = mv.wk
      bk = mv.bk
      psq = mv.psq
      us = WIN_TO_MOVE
    }
  }
  return null
}
