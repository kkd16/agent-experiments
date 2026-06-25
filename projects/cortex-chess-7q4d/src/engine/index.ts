// High-level game API consumed by the React UI: legal moves, applying/undoing
// moves, SAN history, and status (check / mate / draw). The engine search lives
// in search.ts and runs in a Web Worker (see engine.worker.ts).

import {
  type Position,
  type Move,
  type Color,
  type Undo,
  WHITE,
  BLACK,
  KING,
  parseFen,
  toFen,
  clonePosition,
  START_FEN,
  moveFrom,
  moveTo,
  movePromo,
  makeMoveOnBoard,
  unmakeMoveOnBoard,
} from './board'
import { generateLegal, isSquareAttacked } from './movegen'
import { moveToSan } from './san'

export * from './board'
export { generateLegal, isSquareAttacked, inCheck } from './movegen'
export { evaluate, MATERIAL, PIECE_NAMES } from './eval'
export { Searcher, INF, MATE, MATE_THRESHOLD } from './search'
export type { SearchInfo, SearchOptions, InfoCallback, MultiInfo, PvLine, MultiInfoCallback } from './search'
export { perft, PERFT_SUITE } from './perft'
export type { PerftCase } from './perft'
export { moveToSan, sanToMove } from './san'
export { see } from './see'
export { bookMove, bookEntries, bookPositions, bookExplorer } from './book'
export { buildPgn, parsePgn, buildAnnotatedPgn } from './pgn'
export type { PgnMeta, ParsedGame, AnnotatedPgnInput } from './pgn'
export { kpkWin } from './kpk'
export { buildKbnk, verifyKbnk, probeKbnk, kbnkReady, kbnkStats, ensureKbnk } from './kbnk'
export type { KbnkStats, KbnkVerification } from './kbnk'
export {
  buildGtb,
  verifyGtb,
  probeGtb,
  gtbReady,
  gtbStats,
  gtbSolvedIds,
  ensureGtb,
  tryLoadGtbFromCache,
  GTB_CONFIGS,
} from './gtb'
export type { TbConfig, GtbStats, GtbVerification } from './gtb'
export { tbCacheKeys, tbCacheClear } from './tbcache'
export { allocateTime, formatClock, TIME_CONTROLS } from './clock'
export type { TimeControl, TimeBudget } from './clock'
export { TACTICS } from './tactics'
export type { TacticCase } from './tactics'
export { EPD_SUITES, parseEpd, parseEpdBlock } from './epd'
export type { EpdCase, EpdSuite } from './epd'

export type GameResult = 'playing' | 'checkmate' | 'stalemate' | 'draw-fifty' | 'draw-repetition' | 'draw-material'

export interface HistoryEntry {
  move: Move
  san: string
  undo: Undo
  fenBefore: string
}

export class Game {
  pos: Position
  history: HistoryEntry[] = []
  private keys: bigint[] = []

  constructor(fen: string = START_FEN) {
    this.pos = parseFen(fen)
    this.keys.push(this.pos.hash)
  }

  reset(fen: string = START_FEN): void {
    this.pos = parseFen(fen)
    this.history = []
    this.keys = [this.pos.hash]
  }

  get turn(): Color {
    return this.pos.turn
  }

  fen(): string {
    return toFen(this.pos)
  }

  legalMoves(): Move[] {
    return generateLegal(this.pos)
  }

  legalMovesFrom(square: number): Move[] {
    return this.legalMoves().filter((m) => moveFrom(m) === square)
  }

  // Find a legal move matching the given squares (and promotion piece, if any).
  findMove(from: number, to: number, promo = 0): Move | null {
    for (const m of this.legalMoves()) {
      if (moveFrom(m) === from && moveTo(m) === to) {
        if (promo === 0 || movePromo(m) === promo) return m
      }
    }
    return null
  }

  apply(move: Move): void {
    const undo: Undo = { captured: 0, capturedSq: -1, castling: 0, ep: -1, halfmove: 0, hash: 0n }
    const san = moveToSan(this.pos, move, this.legalMoves())
    const fenBefore = this.fen()
    makeMoveOnBoard(this.pos, move, undo)
    this.history.push({ move, san, undo, fenBefore })
    this.keys.push(this.pos.hash)
  }

  undo(): boolean {
    const entry = this.history.pop()
    if (!entry) return false
    unmakeMoveOnBoard(this.pos, entry.move, entry.undo)
    this.keys.pop()
    return true
  }

  // All position hashes including the current one — used for repetition detection.
  keyHistory(): bigint[] {
    return this.keys.slice()
  }

  inCheck(): boolean {
    return isSquareAttacked(this.pos, this.pos.kings[this.pos.turn], (this.pos.turn ^ 1) as Color)
  }

  // Insufficient material: K vs K, K+minor vs K (no pawns/rooks/queens).
  private insufficientMaterial(): boolean {
    let minors = 0
    for (let s = 0; s < 128; s++) {
      if ((s & 0x88) !== 0) {
        s += 7
        continue
      }
      const pc = this.pos.board[s]
      if (pc === 0) continue
      const t = pc & 7
      if (t === 1 || t === 4 || t === 5) return false // pawn, rook, queen
      if (t === 2 || t === 3) minors++
    }
    return minors <= 1
  }

  private repetitionCount(): number {
    const h = this.pos.hash
    let count = 0
    for (const k of this.keys) if (k === h) count++
    return count
  }

  result(): GameResult {
    if (this.legalMoves().length === 0) {
      return this.inCheck() ? 'checkmate' : 'stalemate'
    }
    if (this.pos.halfmove >= 100) return 'draw-fifty'
    if (this.repetitionCount() >= 3) return 'draw-repetition'
    if (this.insufficientMaterial()) return 'draw-material'
    return 'playing'
  }

  clone(): Game {
    const g = new Game()
    g.pos = clonePosition(this.pos)
    g.history = this.history.map((h) => ({ ...h, undo: { ...h.undo } }))
    g.keys = this.keys.slice()
    return g
  }
}

export { WHITE, BLACK, KING, START_FEN }
