// gtb.ts — a *generalized* in-browser retrograde distance-to-mate solver.
//
// The project already ships three hand-rolled retrograde tablebases (KRvK & KQvK
// in egtb.ts, the King+Bishop+Knight mate in kbnk.ts). Each is a bespoke piece of
// code tied to one material configuration. This module replaces that family with
// a single *material-generic* solver: give it the strong side's pieces and it
// derives the complete distance-to-mate (DTM) table for that ending by backward
// retrograde analysis — no embedded data, all in the browser.
//
//   • It reproduces KRvK, KQvK and KBNvK **bit-for-bit** (cross-checked against the
//     hand-rolled tables in the Lab), which is what proves the generic engine is
//     correct.
//   • It newly solves endings the project never had: **KBBvK** (the two-bishop
//     mate — a real forced win) and **KNNvK** (proven a draw), plus the major-piece
//     combinations (KQRvK, KRRvK, KQQvK, KRBvK, KRNvK, KQBvK, KQNvK).
//
// Convention: the strong side (the one with pieces) is always "White"; the defender
// is a lone Black king. The probe mirrors a black-strong position into that frame.
//
// Algorithm. A fixed-material table only contains *quiet* (non-capturing) moves —
// any capture removes a piece and so leaves the table. That makes the retrograde
// step a clean backward BFS over quiet unmoves, exactly like kbnk.ts. Captures are
// handled at the leaves:
//   – a defender capture that leaves a non-winning residual (bare kings, or K+minor)
//     is a *draw escape*: the defender is not lost;
//   – a defender capture that leaves a *still-winning* residual (a lone Rook/Queen)
//     is a forced-losing line whose length we read from the relevant 3-man sub-table
//     (built first as a dependency). This is the "Syzygy-style" layered probing.
// Because a forced capture can be the defender's *longest* defence, the BFS uses a
// bucket queue (Dial's algorithm) keyed on DTM rather than fixed ply layers, so a
// position can be finalised at a later distance than its quiet children imply.
//
// Squares are plain 0..63 with sq = rank*8 + file throughout.

import { KNIGHT, BISHOP, ROOK, QUEEN } from './board'
import { tbCacheLoad, tbCacheSave } from './tbcache'

const WIN = 0 // strong side (White) to move
const DEF = 1 // defender (lone Black king) to move

const ILLEGAL = -2
const DRAW = -1 // also the "unknown / unresolved" marker during the build

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
// RAYS[sq][dir] = the squares along direction `dir` from `sq`, in order outward.
// dir 0..3 = orthogonal (E,W,N,S); dir 4..7 = diagonal (NE,NW,SE,SW).
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

// Does a white piece of `type` on `from` attack `target`, with up to two blocking
// squares (b1, b2; pass -1 to disable)? Knights ignore blockers.
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

export interface TbConfig {
  id: string // e.g. 'KQvK', 'KBBvK'
  white: number[] // 1 or 2 piece types from {KNIGHT,BISHOP,ROOK,QUEEN}
  label: string // human display, e.g. 'K+Q vs K'
}

const PIECE_LETTER: Record<number, string> = { [KNIGHT]: 'N', [BISHOP]: 'B', [ROOK]: 'R', [QUEEN]: 'Q' }

function mkConfig(white: number[]): TbConfig {
  const letters = white.map((t) => PIECE_LETTER[t]).join('')
  return { id: `K${letters}vK`, white, label: `K+${white.map((t) => PIECE_LETTER[t]).join('+')} vs K` }
}

// The configs the Lab exposes. Single pieces and two-minor combos are escape-only
// (every capture is a draw); the major combos exercise the sub-table probing.
export const GTB_CONFIGS: TbConfig[] = [
  mkConfig([QUEEN]),
  mkConfig([ROOK]),
  mkConfig([BISHOP, BISHOP]),
  mkConfig([BISHOP, KNIGHT]),
  mkConfig([KNIGHT, KNIGHT]),
  mkConfig([ROOK, ROOK]),
  mkConfig([QUEEN, QUEEN]),
  mkConfig([QUEEN, ROOK]),
  mkConfig([ROOK, BISHOP]),
  mkConfig([ROOK, KNIGHT]),
  mkConfig([QUEEN, BISHOP]),
  mkConfig([QUEEN, KNIGHT]),
]

export interface GtbStats {
  id: string
  buildMs: number
  size: number // table entries
  won: number // strong-to-move winning positions
  lost: number // defender-to-move lost positions
  draw: number
  illegal: number
  maxDtm: number // longest forced mate, in plies (0 if the ending is a draw)
  maxDtmFen: string
  decisive: boolean // is the ending a forced win at all?
}

interface Solved {
  config: TbConfig
  n: number
  types: number[]
  size: number
  dtm: Int16Array
  stats: GtbStats
}

const SOLVED = new Map<string, Solved>()

export type ProgressFn = (frac: number, phase: string) => void

function configById(id: string): TbConfig | undefined {
  return GTB_CONFIGS.find((c) => c.id === id)
}

// Find the config matching a multiset of strong-piece types (order-insensitive).
// Returns the config (whose `white` array gives the canonical slot order) or null.
export function gtbConfigFor(types: number[]): TbConfig | null {
  const key = [...types].sort((a, b) => a - b).join(',')
  for (const c of GTB_CONFIGS) {
    if ([...c.white].sort((a, b) => a - b).join(',') === key) return c
  }
  return null
}

// ---- Indexing ----

function sizeFor(n: number): number {
  return 1 << (13 + 6 * n)
}
function indexN(n: number, side: number, wk: number, bk: number, p0: number, p1: number): number {
  let i = side | (wk << 1) | (bk << 7) | (p0 << 13)
  if (n > 1) i |= p1 << 19
  return i
}

// ---- Per-state helpers (operate on decoded fields) ----

// Is square `t` attacked by any white piece? `skip` excludes a piece index (a piece
// being captured); the black king is never a blocker here (it is moving/absent).
function piecesAttack(
  t: number,
  n: number,
  types: number[],
  p0: number,
  p1: number,
  skip: number,
  wk: number,
): boolean {
  for (let i = 0; i < n; i++) {
    if (i === skip) continue
    const ps = i === 0 ? p0 : p1
    // The only possible second blocker (besides the white king) is the *other*
    // white piece, present only when n === 2 and it is neither i nor skip.
    let b2 = -1
    const other = i === 0 ? 1 : 0
    if (n === 2 && other !== skip) b2 = other === 0 ? p0 : p1
    if (rayAttack(types[i], ps, t, wk, b2)) return true
  }
  return false
}

// ---- Build ----

// Ensure the 3-man sub-tables a config depends on (for capture resolution) exist.
function ensureDeps(types: number[], now: () => number): void {
  if (types.length !== 2) return
  // A capture removes one piece; the residual is the other piece. We need a solved
  // single-major table for every major that can remain, so captures into a still-
  // won ending can be scored.
  for (let j = 0; j < 2; j++) {
    const remain = types[1 - j]
    if (isMajor(remain)) {
      const sub = mkConfig([remain])
      if (!SOLVED.has(sub.id)) buildGtbConfig(sub, undefined, now)
    }
  }
}

function probeSolved(s: Solved, side: number, wk: number, bk: number, p0: number, p1: number): number {
  return s.dtm[indexN(s.n, side, wk, bk, p0, p1)]
}

// Build (and memoise) one configuration. Returns its statistics.
export function buildGtbConfig(config: TbConfig, onProgress?: ProgressFn, now: () => number = () => Date.now()): GtbStats {
  const existing = SOLVED.get(config.id)
  if (existing) return existing.stats

  const t0 = now()
  const types = config.white
  const n = types.length
  ensureDeps(types, now)

  const size = sizeFor(n)
  const dtm = new Int16Array(size).fill(DRAW)
  // Unresolved quiet-child counter for defender (Black-to-move) positions.
  const count = new Uint8Array(size)
  // For major-bearing configs: the DTM floor imposed by forced captures into a
  // still-won sub-table. Only allocated when such captures are possible.
  const needFloor = n === 2 && (isMajor(types[0]) || isMajor(types[1]))
  const cfloor = needFloor ? new Int16Array(size).fill(-1) : null

  // Bucket queue keyed on DTM (Dial's algorithm).
  const buckets: number[][] = []
  const pushBucket = (i: number, d: number) => {
    while (buckets.length <= d) buckets.push([])
    buckets[d].push(i)
  }

  // --- Pass 1: legality, defender classification, mate/forced-capture seeds. ---
  let reportAt = 0
  for (let i = 0; i < size; i++) {
    if (i >= reportAt) {
      onProgress?.((i / size) * 0.45, 'scanning positions')
      reportAt = i + (size >> 6)
    }
    const side = i & 1
    const wk = (i >> 1) & 63
    const bk = (i >> 7) & 63
    const p0 = (i >> 13) & 63
    const p1 = n > 1 ? (i >> 19) & 63 : -1

    // Distinct squares + non-adjacent kings.
    if (wk === bk || wk === p0 || bk === p0) {
      dtm[i] = ILLEGAL
      continue
    }
    if (n > 1 && (p1 === wk || p1 === bk || p1 === p0)) {
      dtm[i] = ILLEGAL
      continue
    }
    if (dist(wk, bk) <= 1) {
      dtm[i] = ILLEGAL
      continue
    }
    if (side === WIN) {
      // Strong to move: illegal if the defender (not to move) is already in check.
      if (piecesAttack(bk, n, types, p0, p1, -1, wk)) dtm[i] = ILLEGAL
      continue // value discovered later via predecessors
    }

    // Defender (Black king) to move: classify.
    let quiet = 0
    let escape = false
    let floor = -1
    const targets = KING_TARGETS[bk]
    for (let k = 0; k < targets.length; k++) {
      const t = targets[k]
      if (dist(t, wk) <= 1) continue // can't sit next to the white king
      const capIdx = t === p0 ? 0 : n > 1 && t === p1 ? 1 : -1
      if (capIdx >= 0) {
        // Capture of a white piece. Legal only if the square is undefended (not
        // attacked by the white king or the *other* white piece).
        if (piecesAttack(t, n, types, p0, p1, capIdx, wk)) continue
        // Residual material after the capture.
        if (n === 1) {
          escape = true // → bare kings, draw
        } else {
          const remainType = types[1 - capIdx]
          const remainSq = capIdx === 0 ? p1 : p0
          if (!isMajor(remainType)) {
            escape = true // K + lone minor vs K, draw
          } else {
            // K + Rook/Queen vs K, White to move after the capture. Probe the
            // sub-table: a win there is a forced-losing line, a draw is an escape.
            const sub = SOLVED.get(mkConfig([remainType]).id)!
            const v = probeSolved(sub, WIN, wk, t, remainSq, -1)
            if (v >= 0) {
              if (v > floor) floor = v
            } else {
              escape = true
            }
          }
        }
        continue
      }
      // Quiet king move to an empty square: legal only if it isn't attacked.
      if (piecesAttack(t, n, types, p0, p1, -1, wk)) continue
      quiet++
    }

    if (escape) {
      dtm[i] = DRAW // defender can bail to a draw
    } else if (quiet === 0) {
      if (floor >= 0) {
        // No quiet move, but a forced capture into a won sub-table: lost in floor+1.
        dtm[i] = floor + 1
        pushBucket(i, floor + 1)
      } else if (piecesAttack(bk, n, types, p0, p1, -1, wk)) {
        dtm[i] = 0 // checkmate
        pushBucket(i, 0)
      } else {
        dtm[i] = DRAW // stalemate
      }
    } else {
      count[i] = quiet // unresolved; needs every quiet child to become winning
      if (cfloor && floor >= 0) cfloor[i] = floor
    }
  }

  // --- Pass 2: retrograde BFS over a DTM-keyed bucket queue. ---
  let d = 0
  for (;;) {
    while (d < buckets.length && buckets[d].length === 0) d++
    if (d >= buckets.length) break
    onProgress?.(0.45 + Math.min(0.5, d / 80) * 0.5, `solving mate-in-${(d >> 1) + 1}`)
    const layer = buckets[d]
    buckets[d] = [] // detach; new pushes append to a fresh/extended bucket
    for (let li = 0; li < layer.length; li++) {
      const i = layer[li]
      const side = i & 1
      const wk = (i >> 1) & 63
      const bk = (i >> 7) & 63
      const p0 = (i >> 13) & 63
      const p1 = n > 1 ? (i >> 19) & 63 : -1

      if (side === DEF) {
        // Lost-in-d defender position. Predecessors are White-to-move positions
        // from which White made a quiet move here; each is won in d+1.
        // (a) white king stepped in from an adjacent square.
        const kt = KING_TARGETS[wk]
        for (let k = 0; k < kt.length; k++) {
          const p = indexN(n, WIN, kt[k], bk, p0, p1)
          if (dtm[p] === DRAW) {
            dtm[p] = d + 1
            pushBucket(p, d + 1)
          }
        }
        // (b) a white piece slid/hopped in from somewhere (square now empty).
        for (let pi = 0; pi < n; pi++) {
          const psq = pi === 0 ? p0 : p1
          const type = types[pi]
          if (type === KNIGHT) {
            const nt = KNIGHT_TARGETS[psq]
            for (let k = 0; k < nt.length; k++) {
              const from = nt[k]
              if (from === wk || from === bk || (n > 1 && from === (pi === 0 ? p1 : p0))) continue
              const p = pi === 0 ? indexN(n, WIN, wk, bk, from, p1) : indexN(n, WIN, wk, bk, p0, from)
              if (dtm[p] === DRAW) {
                dtm[p] = d + 1
                pushBucket(p, d + 1)
              }
            }
          } else {
            const dirs = dirsFor(type)
            const rs = RAYS[psq]
            const blockA = pi === 0 ? (n > 1 ? p1 : -1) : p0
            for (let di = 0; di < dirs.length; di++) {
              const ray = rs[dirs[di]]
              for (let k = 0; k < ray.length; k++) {
                const from = ray[k]
                if (from === wk || from === bk || from === blockA) break // blocked
                const p = pi === 0 ? indexN(n, WIN, wk, bk, from, p1) : indexN(n, WIN, wk, bk, p0, from)
                if (dtm[p] === DRAW) {
                  dtm[p] = d + 1
                  pushBucket(p, d + 1)
                }
              }
            }
          }
        }
      } else {
        // Won-in-d strong position. Predecessors are defender positions from which
        // the Black king stepped here; decrement their unresolved counter.
        const kt = KING_TARGETS[bk]
        for (let k = 0; k < kt.length; k++) {
          const p = indexN(n, DEF, wk, kt[k], p0, p1)
          if (dtm[p] === DRAW && count[p] > 0) {
            count[p]--
            if (count[p] === 0) {
              const fl = cfloor ? cfloor[p] : -1
              const val = fl > d ? fl + 1 : d + 1
              dtm[p] = val
              pushBucket(p, val)
            }
          }
        }
      }
    }
    d++
  }

  // --- Stats ---
  let won = 0
  let lost = 0
  let draw = 0
  let illegal = 0
  let maxDtm = 0
  let maxIdx = -1
  for (let i = 0; i < size; i++) {
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

  const stats: GtbStats = {
    id: config.id,
    buildMs: Math.round(now() - t0),
    size,
    won,
    lost,
    draw,
    illegal,
    maxDtm,
    maxDtmFen: maxIdx >= 0 ? fenOfState(types, maxIdx) : '',
    // A general forced win (vs an ending like KNNvK, where the only "won"
    // positions are accidental mates the defender is never forced into).
    decisive: won / size > 0.01,
  }
  SOLVED.set(config.id, { config, n, types, size, dtm, stats })
  onProgress?.(1, 'done')
  return stats
}

export function buildGtb(id: string, onProgress?: ProgressFn, now: () => number = () => Date.now()): GtbStats {
  const config = configById(id)
  if (!config) throw new Error(`unknown tablebase config: ${id}`)
  return buildGtbConfig(config, onProgress, now)
}

export function gtbReady(id: string): boolean {
  return SOLVED.has(id)
}
export function gtbStats(id: string): GtbStats | null {
  return SOLVED.get(id)?.stats ?? null
}
export function gtbSolvedIds(): string[] {
  return [...SOLVED.keys()]
}

// ---- Loading a table from a cache (skips the build) ----

export function loadGtbTable(id: string, dtm: Int16Array, stats: GtbStats): void {
  const config = configById(id)
  if (!config) return
  SOLVED.set(config.id, { config, n: config.white.length, types: config.white, size: stats.size, dtm, stats })
}
export function gtbTable(id: string): Int16Array | null {
  return SOLVED.get(id)?.dtm ?? null
}

// Build the 3-man sub-tables a config's capture-resolution depends on. Needed after
// a config is hydrated from cache (which skips its own build, and so its deps).
function ensureDepsForId(id: string): void {
  const c = configById(id)
  if (c) ensureDeps(c.white, () => Date.now())
}

// ---- Cache-aware orchestration (async; used by the worker) ----

// Make a config resident, preferring the IndexedDB cache; build + persist on a miss.
export async function ensureGtb(id: string, onProgress?: ProgressFn): Promise<GtbStats> {
  if (gtbReady(id)) return gtbStats(id)!
  const cached = await tbCacheLoad<GtbStats>(id)
  if (cached && cached.meta && cached.meta.id === id && cached.dtm.length === cached.meta.size) {
    loadGtbTable(id, cached.dtm, cached.meta)
    ensureDepsForId(id)
    onProgress?.(1, 'loaded from cache')
    return cached.meta
  }
  const stats = buildGtb(id, onProgress)
  const dtm = gtbTable(id)
  if (dtm) await tbCacheSave(id, dtm, stats)
  return stats
}

// Persist an already-resident table to the cache (no-op if not built yet).
export async function persistGtb(id: string): Promise<void> {
  const s = SOLVED.get(id)
  if (s) await tbCacheSave(id, s.dtm, s.stats)
}

// Hydrate a config from the cache *only* (never builds). Returns whether it is now
// resident. The play worker calls this before searching an endgame so a previously
// built-and-persisted table is used without a multi-second rebuild mid-move.
export async function tryLoadGtbFromCache(id: string): Promise<boolean> {
  if (gtbReady(id)) return true
  const cached = await tbCacheLoad<GtbStats>(id)
  if (cached && cached.meta && cached.meta.id === id && cached.dtm.length === cached.meta.size) {
    loadGtbTable(id, cached.dtm, cached.meta)
    ensureDepsForId(id)
    return true
  }
  return false
}

// ---- FEN reconstruction (white = strong) ----

function fenOfState(types: number[], i: number): string {
  const n = types.length
  const side = i & 1
  const wk = (i >> 1) & 63
  const bk = (i >> 7) & 63
  const p0 = (i >> 13) & 63
  const p1 = n > 1 ? (i >> 19) & 63 : -1
  const board: string[] = Array(64).fill('')
  board[wk] = 'K'
  board[bk] = 'k'
  board[p0] = PIECE_LETTER[types[0]]
  if (n > 1) board[p1] = PIECE_LETTER[types[1]]
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

// ---- Probe ----

export interface TbResult {
  win: boolean
  dtm: number // plies to mate (0 at mate); -1 when drawn / not in the table
}

// Probe in the canonical (white = strong) frame. `pieceSqs` lists the strong
// pieces' 0..63 squares, in the same type order as the config.
function probeCanonical(id: string, wk: number, bk: number, pieceSqs: number[], whiteToMove: boolean): TbResult {
  const s = SOLVED.get(id)
  if (!s) return { win: false, dtm: -1 }
  // Assign squares to slots. For two pieces of the same type either ordering hits
  // an equivalent (symmetric) table entry, so a stable sort is enough.
  let p0 = pieceSqs[0]
  let p1 = s.n > 1 ? pieceSqs[1] : -1
  if (s.n > 1 && s.types[0] === s.types[1] && p0 > p1) {
    const tmp = p0
    p0 = p1
    p1 = tmp
  }
  const v = s.dtm[indexN(s.n, whiteToMove ? WIN : DEF, wk, bk, p0, p1)]
  return v >= 0 ? { win: true, dtm: v } : { win: false, dtm: -1 }
}

// Probe with real-board 0..63 squares. `strongIsWhite` says which colour holds the
// pieces; black-strong positions are mirrored vertically into the canonical frame.
export function probeGtb(
  id: string,
  whiteKing: number,
  blackKing: number,
  strongPieceSqs: number[],
  strongIsWhite: boolean,
  whiteToMove: boolean,
): TbResult {
  if (!SOLVED.has(id)) return { win: false, dtm: -1 }
  if (strongIsWhite) {
    return probeCanonical(id, whiteKing, blackKing, strongPieceSqs, whiteToMove)
  }
  return probeCanonical(
    id,
    blackKing ^ 56,
    whiteKing ^ 56,
    strongPieceSqs.map((s) => s ^ 56),
    !whiteToMove,
  )
}

// ===================================================================
//  Verification — proving the generic engine from the inside out.
// ===================================================================

// A deterministic PRNG so verification is reproducible.
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

// The strong side's quiet children of a canonical White-to-move state, each as the
// resulting (DEF-to-move) index. (Strong side never captures: defender is bare.)
function strongChildren(s: Solved, wk: number, bk: number, p0: number, p1: number): number[] {
  const { n, types } = s
  const out: number[] = []
  for (const t of KING_TARGETS[wk]) {
    if (t === bk || t === p0 || (n > 1 && t === p1)) continue
    if (dist(t, bk) <= 1) continue
    out.push(indexN(n, DEF, t, bk, p0, p1))
  }
  for (let pi = 0; pi < n; pi++) {
    const psq = pi === 0 ? p0 : p1
    const type = types[pi]
    if (type === KNIGHT) {
      for (const t of KNIGHT_TARGETS[psq]) {
        if (t === wk || t === bk || (n > 1 && t === (pi === 0 ? p1 : p0))) continue
        out.push(pi === 0 ? indexN(n, DEF, wk, bk, t, p1) : indexN(n, DEF, wk, bk, p0, t))
      }
    } else {
      const dirs = dirsFor(type)
      const rs = RAYS[psq]
      const blockA = pi === 0 ? (n > 1 ? p1 : -1) : p0
      for (let di = 0; di < dirs.length; di++) {
        const ray = rs[dirs[di]]
        for (let k = 0; k < ray.length; k++) {
          const t = ray[k]
          if (t === wk || t === bk || t === blockA) break
          out.push(pi === 0 ? indexN(n, DEF, wk, bk, t, p1) : indexN(n, DEF, wk, bk, p0, t))
        }
      }
    }
  }
  return out
}

// A defender child: a within-table quiet king move (kind 'quiet', index `to`), or a
// capture leaving the table (kind 'cap', with the residual value `val`: a DTM >= 0
// for a forced-losing capture, or -1 for a draw escape).
interface DefChild {
  kind: 'quiet' | 'cap'
  to: number
  val: number
}
function defenderChildren(s: Solved, wk: number, bk: number, p0: number, p1: number): DefChild[] {
  const { n, types } = s
  const out: DefChild[] = []
  for (const t of KING_TARGETS[bk]) {
    if (dist(t, wk) <= 1) continue
    const capIdx = t === p0 ? 0 : n > 1 && t === p1 ? 1 : -1
    if (capIdx >= 0) {
      if (piecesAttack(t, n, types, p0, p1, capIdx, wk)) continue
      if (n === 1) {
        out.push({ kind: 'cap', to: t, val: -1 })
      } else {
        const remainType = types[1 - capIdx]
        const remainSq = capIdx === 0 ? p1 : p0
        if (!isMajor(remainType)) out.push({ kind: 'cap', to: t, val: -1 })
        else {
          const sub = SOLVED.get(mkConfig([remainType]).id)!
          out.push({ kind: 'cap', to: t, val: probeSolved(sub, WIN, wk, t, remainSq, -1) })
        }
      }
      continue
    }
    if (piecesAttack(t, n, types, p0, p1, -1, wk)) continue
    out.push({ kind: 'quiet', to: indexN(n, WIN, wk, t, p0, p1), val: 0 })
  }
  return out
}

export interface GtbVerification {
  id: string
  stats: GtbStats
  // Cross-check against a hand-rolled oracle (only for KQvK / KRvK / KBNvK).
  oracleName: string | null
  oracleChecked: number
  oracleBad: number
  // Bellman optimality on a random sample of resolved positions.
  consChecked: number
  consBad: number
  // Optimal self-play to mate from random won positions.
  selfPlayGames: number
  selfPlayMated: number
  selfPlayMismatch: number
  verifyMs: number
}

// Optional oracle: a probe of the same ending implemented by the hand-rolled tables.
export type Oracle = (wk: number, bk: number, pieceSqs: number[], whiteToMove: boolean) => number

// Verify a built config:
//   1. against the hand-rolled oracle (when one is supplied) — bit-for-bit DTM;
//   2. Bellman optimality on a random sample (strong = 1 + min child; defender =
//      1 + max child over quiet *and* capture children, with no draw escape);
//   3. optimal self-play to mate, following forced captures into sub-tables, where
//      the realised mate distance must equal the stored DTM.
export function verifyGtb(
  id: string,
  opts: { sample?: number; games?: number; oracle?: Oracle; oracleName?: string } = {},
  onProgress?: ProgressFn,
  now: () => number = () => Date.now(),
): GtbVerification {
  const stats = buildGtb(id, onProgress ? (f, ph) => onProgress(f * 0.6, ph) : undefined, now)
  const s = SOLVED.get(id)!
  const t0 = now()
  const rng = splitmix32(0x51ed270b)
  const ri = (m: number) => rng() % m
  const sample = opts.sample ?? 200000
  const games = opts.games ?? 2000

  // --- 1. Oracle cross-check ---
  let oracleChecked = 0
  let oracleBad = 0
  if (opts.oracle) {
    for (let trial = 0; trial < sample; trial++) {
      const i = ri(s.size)
      if (s.dtm[i] === ILLEGAL) continue
      const side = i & 1
      const wk = (i >> 1) & 63
      const bk = (i >> 7) & 63
      const p0 = (i >> 13) & 63
      const p1 = s.n > 1 ? (i >> 19) & 63 : -1
      const pieceSqs = s.n > 1 ? [p0, p1] : [p0]
      const mine = s.dtm[i] >= 0 ? s.dtm[i] : -1
      const ref = opts.oracle(wk, bk, pieceSqs, side === WIN)
      oracleChecked++
      if (mine !== ref) oracleBad++
    }
  }

  // --- 2. Bellman optimality sample ---
  let consChecked = 0
  let consBad = 0
  let reportAt = 0
  for (let trial = 0; trial < sample; trial++) {
    if (trial >= reportAt) {
      onProgress?.(0.6 + (trial / sample) * 0.25, 'checking optimality')
      reportAt = trial + (sample >> 5)
    }
    const i = ri(s.size)
    const v = s.dtm[i]
    if (v < 0) continue
    const side = i & 1
    const wk = (i >> 1) & 63
    const bk = (i >> 7) & 63
    const p0 = (i >> 13) & 63
    const p1 = s.n > 1 ? (i >> 19) & 63 : -1
    consChecked++
    if (side === WIN) {
      let best = Infinity
      for (const c of strongChildren(s, wk, bk, p0, p1)) {
        const cv = s.dtm[c]
        if (cv >= 0 && cv < best) best = cv
      }
      if (best !== v - 1) consBad++
    } else {
      let max = -1
      let ok = true
      for (const c of defenderChildren(s, wk, bk, p0, p1)) {
        const cv = c.kind === 'quiet' ? s.dtm[c.to] : c.val
        if (cv < 0) {
          ok = false // a draw escape — a lost position must not have one
          break
        }
        if (cv > max) max = cv
      }
      if (!ok || max !== v - 1) consBad++
    }
  }

  // --- 3. Optimal self-play to mate (follows captures into sub-tables) ---
  let played = 0
  let mated = 0
  let mismatch = 0
  for (let trial = 0; trial < games * 30 && played < games; trial++) {
    const start = ri(s.size)
    if ((start & 1) !== WIN || s.dtm[start] < 2) continue
    played++
    const v0 = s.dtm[start]
    let cur: Solved = s
    let idx = start
    let plies = 0
    let dead = false
    for (;;) {
      const side = idx & 1
      const wk = (idx >> 1) & 63
      const bk = (idx >> 7) & 63
      const p0 = (idx >> 13) & 63
      const p1 = cur.n > 1 ? (idx >> 19) & 63 : -1
      if (side === WIN) {
        let best = -1
        let bv = Infinity
        for (const c of strongChildren(cur, wk, bk, p0, p1)) {
          const cv = cur.dtm[c]
          if (cv >= 0 && cv < bv) {
            bv = cv
            best = c
          }
        }
        if (best < 0) {
          dead = true
          break
        }
        idx = best
        plies++
      } else {
        if (cur.dtm[idx] === 0) {
          mated++
          break
        }
        // Pick the defence (quiet or forced capture) that maximises DTM.
        let bv = -1
        let bestQuiet = -1
        let bestCap: DefChild | null = null
        for (const c of defenderChildren(cur, wk, bk, p0, p1)) {
          const cv = c.kind === 'quiet' ? cur.dtm[c.to] : c.val
          if (cv < 0) {
            dead = true // escape from a "lost" position → would be a contradiction
            break
          }
          if (cv > bv) {
            bv = cv
            bestQuiet = c.kind === 'quiet' ? c.to : -1
            bestCap = c.kind === 'cap' ? c : null
          }
        }
        if (dead || bv < 0) {
          dead = true
          break
        }
        plies++
        if (bestCap) {
          // Switch to the residual sub-table, White to move after the capture.
          const capIdx = bestCap.to === p0 ? 0 : 1
          const rType = cur.types[1 - capIdx]
          const rSq = capIdx === 0 ? p1 : p0
          const subId = mkConfig([rType]).id
          cur = SOLVED.get(subId)!
          idx = indexN(cur.n, WIN, wk, bestCap.to, rSq, -1)
        } else {
          idx = bestQuiet
        }
      }
      if (plies > 300) {
        dead = true
        break
      }
    }
    if (!dead && plies !== v0) mismatch++
  }

  onProgress?.(1, 'done')
  return {
    id,
    stats,
    oracleName: opts.oracleName ?? null,
    oracleChecked,
    oracleBad,
    consChecked,
    consBad,
    selfPlayGames: played,
    selfPlayMated: mated,
    selfPlayMismatch: mismatch,
    verifyMs: Math.round(now() - t0),
  }
}
