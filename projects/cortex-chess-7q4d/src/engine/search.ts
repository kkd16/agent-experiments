// The search: iterative deepening negamax with alpha-beta, principal-variation
// search (PVS), a transposition table, quiescence search, null-move pruning, and
// move ordering (TT move, MVV-LVA captures, killer + history heuristics).
//
// The board is mutated in place with make/unmake for speed; an external key stack
// detects repetitions (including positions from the real game, passed in via
// options.history).

import {
  type Position,
  type Move,
  type Color,
  type Undo,
  EMPTY,
  PAWN,
  KING,
  isOnBoard,
  pieceColor,
  pieceType,
  moveFrom,
  moveTo,
  moveFlag,
  movePromo,
  FLAG_EP,
  makeMoveOnBoard,
  unmakeMoveOnBoard,
  makeNullMove,
  unmakeNullMove,
} from './board'
import { generatePseudo, isSquareAttacked } from './movegen'
import { evaluate } from './eval'

export const INF = 1_000_000
export const MATE = 100_000
export const MATE_THRESHOLD = MATE - 1000

const MAX_PLY = 64
const TT_SIZE = 1 << 21 // ~2M entries
const TT_MASK = BigInt(TT_SIZE - 1)

const TT_EXACT = 0
const TT_LOWER = 1
const TT_UPPER = 2

// MVV-LVA victim/attacker values, indexed by piece type 1..6.
const PIECE_VAL = [0, 100, 320, 330, 500, 900, 20000]

export interface SearchInfo {
  depth: number
  score: number
  mate: number | null // signed mate-in-N, or null
  nodes: number
  timeMs: number
  nps: number
  pv: Move[]
}

export interface SearchOptions {
  maxDepth: number
  maxTime: number // milliseconds; 0 = no limit
  history?: bigint[]
}

export type InfoCallback = (info: SearchInfo) => void

export class Searcher {
  private pos!: Position
  private nodes = 0
  private startTime = 0
  private timeLimit = 0
  private stop = false
  private now: () => number

  private readonly killers = new Int32Array(MAX_PLY * 2)
  private readonly history = new Int32Array(2 * 128 * 128)
  private readonly keyStack: bigint[] = []

  // Transposition table (open-addressed, always-replace).
  private readonly ttKey = new BigInt64Array(TT_SIZE)
  private readonly ttDepth = new Int16Array(TT_SIZE)
  private readonly ttScore = new Int32Array(TT_SIZE)
  private readonly ttFlag = new Int8Array(TT_SIZE)
  private readonly ttMove = new Int32Array(TT_SIZE)
  private ttHasEntry = new Uint8Array(TT_SIZE)

  // Triangular PV table.
  private readonly pv = new Int32Array(MAX_PLY * MAX_PLY)
  private readonly pvLen = new Int32Array(MAX_PLY)

  private readonly undos: Undo[] = Array.from({ length: MAX_PLY + 8 }, () => ({
    captured: 0,
    capturedSq: -1,
    castling: 0,
    ep: -1,
    halfmove: 0,
    hash: 0n,
  }))

  constructor(now: () => number = () => performance.now()) {
    this.now = now
  }

  clearTable(): void {
    this.ttHasEntry = new Uint8Array(TT_SIZE)
    this.killers.fill(0)
    this.history.fill(0)
  }

  private timeUp(): boolean {
    if (this.timeLimit <= 0) return false
    return this.now() - this.startTime >= this.timeLimit
  }

  search(pos: Position, options: SearchOptions, onInfo?: InfoCallback): SearchInfo {
    this.pos = pos
    this.nodes = 0
    this.stop = false
    this.startTime = this.now()
    this.timeLimit = options.maxTime
    this.killers.fill(0)
    this.history.fill(0)
    this.keyStack.length = 0
    if (options.history) for (const h of options.history) this.keyStack.push(h)

    let best: SearchInfo = {
      depth: 0,
      score: 0,
      mate: null,
      nodes: 0,
      timeMs: 0,
      nps: 0,
      pv: [],
    }

    for (let depth = 1; depth <= options.maxDepth; depth++) {
      const score = this.negamax(depth, -INF, INF, 0, true)
      if (this.stop) break

      const pvMoves = this.extractPv()
      const elapsed = Math.max(1, this.now() - this.startTime)
      best = {
        depth,
        score,
        mate: this.mateIn(score),
        nodes: this.nodes,
        timeMs: Math.round(elapsed),
        nps: Math.round((this.nodes / elapsed) * 1000),
        pv: pvMoves,
      }
      onInfo?.(best)

      // Stop early on a forced mate, or if we're unlikely to finish another ply.
      if (Math.abs(score) > MATE_THRESHOLD) break
      if (this.timeLimit > 0 && this.now() - this.startTime > this.timeLimit * 0.5) break
    }

    return best
  }

  private mateIn(score: number): number | null {
    if (score > MATE_THRESHOLD) return Math.ceil((MATE - score) / 2)
    if (score < -MATE_THRESHOLD) return -Math.ceil((MATE + score) / 2)
    return null
  }

  private extractPv(): Move[] {
    const line: Move[] = []
    const len = this.pvLen[0]
    for (let i = 0; i < len; i++) line.push(this.pv[i])
    return line
  }

  private isRepetition(): boolean {
    const hash = this.pos.hash
    const stack = this.keyStack
    // Only positions since the last irreversible move can repeat.
    const start = Math.max(0, stack.length - this.pos.halfmove)
    for (let i = stack.length - 2; i >= start; i -= 2) {
      if (stack[i] === hash) return true
    }
    return false
  }

  private hasNonPawnMaterial(color: Color): boolean {
    const board = this.pos.board
    for (let s = 0; s < 128; s++) {
      if (!isOnBoard(s)) {
        s += 7
        continue
      }
      const pc = board[s]
      if (pc === EMPTY) continue
      if (pieceColor(pc) === color) {
        const t = pieceType(pc)
        if (t !== PAWN && t !== KING) return true
      }
    }
    return false
  }

  private ttProbe(hash: bigint): number {
    const idx = Number(hash & TT_MASK)
    if (this.ttHasEntry[idx] && this.ttKey[idx] === BigInt.asIntN(64, hash)) return idx
    return -1
  }

  private ttStore(hash: bigint, depth: number, score: number, flag: number, move: Move, ply: number): void {
    const idx = Number(hash & TT_MASK)
    // Adjust mate scores to be relative to the root.
    let s = score
    if (s > MATE_THRESHOLD) s += ply
    else if (s < -MATE_THRESHOLD) s -= ply
    this.ttKey[idx] = BigInt.asIntN(64, hash)
    this.ttDepth[idx] = depth
    this.ttScore[idx] = s
    this.ttFlag[idx] = flag
    this.ttMove[idx] = move
    this.ttHasEntry[idx] = 1
  }

  private scoreMoves(moves: Move[], ttMove: Move, ply: number): Int32Array {
    const scores = new Int32Array(moves.length)
    const board = this.pos.board
    const colorOffset = this.pos.turn * 128 * 128
    const k0 = this.killers[ply * 2]
    const k1 = this.killers[ply * 2 + 1]
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i]
      if (m === ttMove) {
        scores[i] = 2_000_000
        continue
      }
      const to = moveTo(m)
      const flag = moveFlag(m)
      const promo = movePromo(m)
      const victim = flag === FLAG_EP ? PAWN : board[to] === EMPTY ? 0 : pieceType(board[to])
      if (victim > 0) {
        const attacker = pieceType(board[moveFrom(m)])
        scores[i] = 1_000_000 + PIECE_VAL[victim] * 16 - PIECE_VAL[attacker]
      } else if (promo) {
        scores[i] = 900_000 + PIECE_VAL[promo]
      } else if (m === k0) {
        scores[i] = 800_000
      } else if (m === k1) {
        scores[i] = 700_000
      } else {
        scores[i] = this.history[colorOffset + moveFrom(m) * 128 + to]
      }
    }
    return scores
  }

  // Selection-sort step: bring the best-scoring remaining move to position `i`.
  private pickMove(moves: Move[], scores: Int32Array, i: number): void {
    let best = i
    for (let j = i + 1; j < moves.length; j++) if (scores[j] > scores[best]) best = j
    if (best !== i) {
      const tm = moves[i]
      moves[i] = moves[best]
      moves[best] = tm
      const ts = scores[i]
      scores[i] = scores[best]
      scores[best] = ts
    }
  }

  private quiescence(alpha: number, beta: number, ply: number): number {
    if ((this.nodes & 2047) === 0 && this.timeUp()) this.stop = true
    if (this.stop) return 0
    this.nodes++

    const stand = evaluate(this.pos)
    if (stand >= beta) return beta
    if (stand > alpha) alpha = stand
    if (ply >= MAX_PLY - 1) return stand

    const moves: Move[] = []
    generatePseudo(this.pos, moves, true)
    const scores = this.scoreMoves(moves, 0, ply)
    const undo = this.undos[ply]
    const us = this.pos.turn

    for (let i = 0; i < moves.length; i++) {
      this.pickMove(moves, scores, i)
      const m = moves[i]
      makeMoveOnBoard(this.pos, m, undo)
      if (isSquareAttacked(this.pos, this.pos.kings[us], (us ^ 1) as Color)) {
        unmakeMoveOnBoard(this.pos, m, undo)
        continue
      }
      const score = -this.quiescence(-beta, -alpha, ply + 1)
      unmakeMoveOnBoard(this.pos, m, undo)
      if (this.stop) return 0
      if (score >= beta) return beta
      if (score > alpha) alpha = score
    }
    return alpha
  }

  private negamax(depth: number, alpha: number, beta: number, ply: number, isPv: boolean): number {
    this.pvLen[ply] = 0
    if ((this.nodes & 2047) === 0 && this.timeUp()) this.stop = true
    if (this.stop) return 0

    if (ply > 0 && (this.isRepetition() || this.pos.halfmove >= 100)) return 0

    const us = this.pos.turn
    const checked = isSquareAttacked(this.pos, this.pos.kings[us], (us ^ 1) as Color)
    if (checked) depth++ // check extension

    if (depth <= 0) return this.quiescence(alpha, beta, ply)

    this.nodes++

    const hash = this.pos.hash
    let ttMove = 0
    const ttIdx = this.ttProbe(hash)
    if (ttIdx >= 0) {
      ttMove = this.ttMove[ttIdx]
      if (ply > 0 && this.ttDepth[ttIdx] >= depth) {
        let s = this.ttScore[ttIdx]
        if (s > MATE_THRESHOLD) s -= ply
        else if (s < -MATE_THRESHOLD) s += ply
        const flag = this.ttFlag[ttIdx]
        if (flag === TT_EXACT) return s
        if (flag === TT_LOWER && s >= beta) return s
        if (flag === TT_UPPER && s <= alpha) return s
      }
    }

    // Null-move pruning: if passing the move still beats beta, prune.
    if (!isPv && !checked && depth >= 3 && this.hasNonPawnMaterial(us) && Math.abs(beta) < MATE_THRESHOLD) {
      const undo = this.undos[ply]
      makeNullMove(this.pos, undo)
      this.keyStack.push(this.pos.hash)
      const R = 2 + (depth >= 6 ? 1 : 0)
      const score = -this.negamax(depth - 1 - R, -beta, -beta + 1, ply + 1, false)
      this.keyStack.pop()
      unmakeNullMove(this.pos, undo)
      if (this.stop) return 0
      if (score >= beta) return beta
    }

    const moves: Move[] = []
    generatePseudo(this.pos, moves, false)
    const scores = this.scoreMoves(moves, ttMove, ply)
    const undo = this.undos[ply]

    let bestScore = -INF
    let bestMove = 0
    let legal = 0
    let flag = TT_UPPER
    let alphaLocal = alpha

    for (let i = 0; i < moves.length; i++) {
      this.pickMove(moves, scores, i)
      const m = moves[i]
      makeMoveOnBoard(this.pos, m, undo)
      if (isSquareAttacked(this.pos, this.pos.kings[us], (us ^ 1) as Color)) {
        unmakeMoveOnBoard(this.pos, m, undo)
        continue
      }
      legal++
      this.keyStack.push(this.pos.hash)

      let score: number
      if (legal === 1) {
        score = -this.negamax(depth - 1, -beta, -alphaLocal, ply + 1, isPv)
      } else {
        // PVS: search later moves with a null window, re-search on a raise.
        score = -this.negamax(depth - 1, -alphaLocal - 1, -alphaLocal, ply + 1, false)
        if (score > alphaLocal && score < beta) {
          score = -this.negamax(depth - 1, -beta, -alphaLocal, ply + 1, true)
        }
      }

      this.keyStack.pop()
      unmakeMoveOnBoard(this.pos, m, undo)
      if (this.stop) return 0

      if (score > bestScore) {
        bestScore = score
        bestMove = m
        if (score > alphaLocal) {
          alphaLocal = score
          flag = TT_EXACT
          // Update the triangular PV.
          this.pv[ply * MAX_PLY] = m
          const childLen = this.pvLen[ply + 1]
          for (let j = 0; j < childLen; j++) {
            this.pv[ply * MAX_PLY + 1 + j] = this.pv[(ply + 1) * MAX_PLY + j]
          }
          this.pvLen[ply] = childLen + 1
        }
      }

      if (alphaLocal >= beta) {
        // Beta cutoff. Reward quiet moves via killer + history heuristics.
        const isCapture = moveFlag(m) === FLAG_EP || this.pos.board[moveTo(m)] !== EMPTY
        if (!isCapture && !movePromo(m)) {
          if (this.killers[ply * 2] !== m) {
            this.killers[ply * 2 + 1] = this.killers[ply * 2]
            this.killers[ply * 2] = m
          }
          const idx = us * 128 * 128 + moveFrom(m) * 128 + moveTo(m)
          this.history[idx] += depth * depth
          if (this.history[idx] > 1 << 28) this.dampHistory()
        }
        flag = TT_LOWER
        this.ttStore(hash, depth, bestScore, flag, bestMove, ply)
        return bestScore
      }
    }

    if (legal === 0) {
      // No legal moves: checkmate (scaled by ply so shorter mates win) or stalemate.
      return checked ? -MATE + ply : 0
    }

    this.ttStore(hash, depth, bestScore, flag, bestMove, ply)
    return bestScore
  }

  private dampHistory(): void {
    for (let i = 0; i < this.history.length; i++) this.history[i] >>= 1
  }
}
