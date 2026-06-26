// The search: iterative deepening negamax with alpha-beta and principal-variation
// search (PVS), wrapped in aspiration windows. On top of the classic spine —
// transposition table, quiescence, null-move pruning, MVV-LVA + killer + history
// ordering — it adds the modern selectivity that buys depth:
//
//   • Static Exchange Evaluation (SEE) to order captures and prune losing ones,
//   • late move reductions (LMR) — search likely-irrelevant late moves shallower,
//   • reverse futility pruning + razoring around the static eval,
//   • futility pruning and late-move pruning of quiet moves near the frontier,
//   • check extensions, and mate-distance-aware scoring.
//
// The board is mutated in place with make/unmake for speed; an external key stack
// detects repetitions (including positions from the real game, via options.history).

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
import { see } from './see'
import { Accumulator, type NnueWeights, type EvalAccumulator } from './nnue'
import { QuantAccumulator, type QuantNet } from './nnue-quant'

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

// Margins (centipawns) for the static-eval pruning families.
const RFP_MARGIN = 80 // reverse futility per ply of depth
const RAZOR_MARGIN = 220
const FUTILITY_MARGIN = [0, 120, 220, 320, 420, 520, 620]
const LMP_LIMIT = [0, 6, 9, 14, 21] // max quiets to try by depth before pruning the rest

export interface SearchInfo {
  depth: number
  seldepth: number
  score: number
  mate: number | null // signed mate-in-N, or null
  nodes: number
  timeMs: number
  nps: number
  hashfull: number // permille of the transposition table in use
  pv: Move[]
}

export interface SearchOptions {
  maxDepth: number
  maxTime: number // milliseconds; 0 = no limit (hard ceiling)
  maxNodes?: number // node ceiling; 0/undefined = no limit
  softTime?: number // ms after which no new iteration is started; default maxTime/2
  history?: bigint[]
}

export type InfoCallback = (info: SearchInfo) => void

// A single principal variation in a multi-PV analysis.
export interface PvLine {
  score: number
  mate: number | null
  pv: Move[]
}

export interface MultiInfo {
  depth: number
  seldepth: number
  nodes: number
  timeMs: number
  nps: number
  hashfull: number
  lines: PvLine[]
}

export type MultiInfoCallback = (info: MultiInfo) => void

export class Searcher {
  private pos!: Position
  private nodes = 0
  private seldepth = 0
  private startTime = 0
  private timeLimit = 0
  private softLimit = 0
  private nodeLimit = 0
  private stop = false
  private now: () => number

  // Optional NNUE evaluation. When a network is set, the search keeps a persistent
  // accumulator in sync across make/unmake (an incremental update per move) and the
  // static eval reads it instead of the hand-crafted `evaluate`. A null move never
  // touches the accumulator (the feature set is colour-indexed, not side-to-move),
  // so its only effect is which half is read as "own" at the leaf.
  // Either a float `Accumulator` or an integer `QuantAccumulator` — the search
  // drives both through the shared `EvalAccumulator` interface.
  private nnueAcc: EvalAccumulator | null = null
  private useNnue = false

  private readonly killers = new Int32Array(MAX_PLY * 2)
  private readonly history = new Int32Array(2 * 128 * 128)
  // Countermove heuristic: the quiet refutation that last cut after a given
  // (from,to) move by the opponent. Indexed by the previous move's from*128+to.
  private readonly counter = new Int32Array(128 * 128)
  // Static eval per ply, so a node can tell whether the side to move is
  // "improving" (eval higher than two plies ago) and prune accordingly.
  private readonly evalStack = new Int32Array(MAX_PLY)
  // Quiet moves tried at each ply, so a beta cutoff can reward the move that cut
  // and apply a history malus to the ones that didn't.
  private readonly searchedQuiets = new Int32Array(MAX_PLY * 64)
  private readonly keyStack: bigint[] = []
  private readonly lmr = new Int32Array(64 * 64)
  // Root moves to skip at ply 0 — drives multi-PV (find the best line, then the
  // best line that doesn't start with any already-found move).
  private rootExcluded: Move[] = []

  // Transposition table (open-addressed, always-replace).
  private readonly ttKey = new BigInt64Array(TT_SIZE)
  private readonly ttDepth = new Int16Array(TT_SIZE)
  private readonly ttScore = new Int32Array(TT_SIZE)
  private readonly ttFlag = new Int8Array(TT_SIZE)
  private readonly ttMove = new Int32Array(TT_SIZE)
  private ttHasEntry = new Uint8Array(TT_SIZE)
  private ttUsed = 0

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
    // Precompute the late-move-reduction table: reduce more as both depth and
    // move number grow.
    for (let d = 1; d < 64; d++) {
      for (let m = 1; m < 64; m++) {
        this.lmr[d * 64 + m] = Math.floor(0.75 + (Math.log(d) * Math.log(m)) / 2.25)
      }
    }
  }

  clearTable(): void {
    this.ttHasEntry = new Uint8Array(TT_SIZE)
    this.ttUsed = 0
    this.killers.fill(0)
    this.history.fill(0)
    this.counter.fill(0)
  }

  // Swap the evaluation function. Pass NNUE weights to use the learned net (with an
  // incrementally-updated accumulator), or null to revert to the classical eval.
  setEvaluator(w: NnueWeights | null): void {
    this.useNnue = w !== null
    this.nnueAcc = w ? new Accumulator(w) : null
  }

  // Use the *quantized* (integer) network instead of the float one. Same
  // incremental accumulator contract, so the rest of the search is unchanged —
  // this is how the engine actually plays with the int8/int16 net.
  setQuantEvaluator(q: QuantNet | null): void {
    this.useNnue = q !== null
    this.nnueAcc = q ? new QuantAccumulator(q) : null
  }

  usesNnue(): boolean {
    return this.useNnue
  }

  // Static evaluation at a leaf — NNUE (from the live accumulator) or classical.
  private staticEvaluate(): number {
    return this.useNnue && this.nnueAcc ? this.nnueAcc.evalScore(this.pos.turn) : evaluate(this.pos)
  }

  // make/unmake wrappers that also fold the move into the NNUE accumulator. The
  // accumulator delta is read from the pre-move position in both directions, so the
  // incremental state stays bit-for-bit identical to a from-scratch refresh.
  private doMake(m: Move, undo: Undo): void {
    if (this.useNnue && this.nnueAcc) this.nnueAcc.applyMove(this.pos, m, 1)
    makeMoveOnBoard(this.pos, m, undo)
  }

  private doUnmake(m: Move, undo: Undo): void {
    unmakeMoveOnBoard(this.pos, m, undo)
    if (this.useNnue && this.nnueAcc) this.nnueAcc.applyMove(this.pos, m, -1)
  }

  private timeUp(): boolean {
    if (this.timeLimit <= 0) return false
    return this.now() - this.startTime >= this.timeLimit
  }

  search(pos: Position, options: SearchOptions, onInfo?: InfoCallback): SearchInfo {
    this.pos = pos
    if (this.useNnue && this.nnueAcc) this.nnueAcc.refresh(pos)
    this.nodes = 0
    this.stop = false
    this.startTime = this.now()
    this.timeLimit = options.maxTime
    this.softLimit = options.softTime && options.softTime > 0 ? options.softTime : 0
    this.nodeLimit = options.maxNodes ?? 0
    this.killers.fill(0)
    this.history.fill(0)
    this.counter.fill(0)
    this.keyStack.length = 0
    this.rootExcluded = []
    if (options.history) for (const h of options.history) this.keyStack.push(h)

    let best: SearchInfo = {
      depth: 0,
      seldepth: 0,
      score: 0,
      mate: null,
      nodes: 0,
      timeMs: 0,
      nps: 0,
      hashfull: 0,
      pv: [],
    }

    let prevScore = 0
    for (let depth = 1; depth <= options.maxDepth; depth++) {
      this.seldepth = 0
      const score = this.searchRoot(depth, prevScore)
      if (this.stop && depth > 1) break

      prevScore = score
      const pvMoves = this.extractPv()
      const elapsed = Math.max(1, this.now() - this.startTime)
      best = {
        depth,
        seldepth: this.seldepth,
        score,
        mate: this.mateIn(score),
        nodes: this.nodes,
        timeMs: Math.round(elapsed),
        nps: Math.round((this.nodes / elapsed) * 1000),
        hashfull: Math.min(1000, Math.round((this.ttUsed / TT_SIZE) * 1000)),
        pv: pvMoves,
      }
      onInfo?.(best)

      if (Math.abs(score) > MATE_THRESHOLD) break
      const soft = this.softLimit > 0 ? this.softLimit : this.timeLimit * 0.5
      if (this.timeLimit > 0 && this.now() - this.startTime > soft) break
    }

    return best
  }

  // Multi-PV analysis: at every depth, find the best line, then the best line
  // whose first move differs from all earlier ones, up to `multiPv` lines. Each
  // line is a full-window root search with the earlier root moves excluded; the
  // shared transposition table keeps the later lines cheap.
  searchMultiPv(
    pos: Position,
    options: SearchOptions,
    multiPv: number,
    onInfo?: MultiInfoCallback,
  ): MultiInfo {
    this.pos = pos
    if (this.useNnue && this.nnueAcc) this.nnueAcc.refresh(pos)
    this.nodes = 0
    this.stop = false
    this.startTime = this.now()
    this.timeLimit = options.maxTime
    this.softLimit = options.softTime && options.softTime > 0 ? options.softTime : 0
    this.nodeLimit = options.maxNodes ?? 0
    this.killers.fill(0)
    this.history.fill(0)
    this.counter.fill(0)
    this.keyStack.length = 0
    this.rootExcluded = []
    if (options.history) for (const h of options.history) this.keyStack.push(h)

    let best: MultiInfo = { depth: 0, seldepth: 0, nodes: 0, timeMs: 0, nps: 0, hashfull: 0, lines: [] }

    for (let depth = 1; depth <= options.maxDepth; depth++) {
      this.seldepth = 0
      this.rootExcluded = []
      const lines: PvLine[] = []
      let aborted = false

      for (let pvi = 0; pvi < multiPv; pvi++) {
        const score = this.negamax(depth, -INF, INF, 0, true, 0)
        if (this.stop && depth > 1) {
          aborted = true
          break
        }
        const pv = this.extractPv()
        if (pv.length === 0) break // no more distinct root moves
        lines.push({ score, mate: this.mateIn(score), pv })
        this.rootExcluded.push(pv[0])
      }

      if (aborted) break
      if (lines.length === 0) break // mate/stalemate at the root

      const elapsed = Math.max(1, this.now() - this.startTime)
      best = {
        depth,
        seldepth: this.seldepth,
        nodes: this.nodes,
        timeMs: Math.round(elapsed),
        nps: Math.round((this.nodes / elapsed) * 1000),
        hashfull: Math.min(1000, Math.round((this.ttUsed / TT_SIZE) * 1000)),
        lines,
      }
      onInfo?.(best)

      if (lines[0] && Math.abs(lines[0].score) > MATE_THRESHOLD) break
      if (this.timeLimit > 0 && this.now() - this.startTime > this.timeLimit * 0.5) break
    }

    return best
  }

  // Root search with aspiration windows: re-use the previous score as the centre
  // of a narrow window, widening on a fail-high/low instead of redoing full width.
  private searchRoot(depth: number, prevScore: number): number {
    if (depth <= 4) return this.negamax(depth, -INF, INF, 0, true, 0)

    let window = 30
    let alpha = prevScore - window
    let beta = prevScore + window
    for (;;) {
      const score = this.negamax(depth, alpha, beta, 0, true, 0)
      if (this.stop) return score
      if (score <= alpha) {
        beta = (alpha + beta) >> 1
        alpha = Math.max(-INF, score - window)
        window *= 2
      } else if (score >= beta) {
        beta = Math.min(INF, score + window)
        window *= 2
      } else {
        return score
      }
    }
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
    let s = score
    if (s > MATE_THRESHOLD) s += ply
    else if (s < -MATE_THRESHOLD) s -= ply
    if (!this.ttHasEntry[idx]) this.ttUsed++
    this.ttKey[idx] = BigInt.asIntN(64, hash)
    this.ttDepth[idx] = depth
    this.ttScore[idx] = s
    this.ttFlag[idx] = flag
    this.ttMove[idx] = move
    this.ttHasEntry[idx] = 1
  }

  private isCapture(m: Move): boolean {
    return moveFlag(m) === FLAG_EP || this.pos.board[moveTo(m)] !== EMPTY
  }

  private scoreMoves(moves: Move[], ttMove: Move, ply: number, counterMove: Move): Int32Array {
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
        const mvvlva = PIECE_VAL[victim] * 16 - PIECE_VAL[attacker]
        // Only spend SEE on captures that could be losing (capturing up in value
        // is virtually always fine); demote losing captures below the quiets.
        if (victim >= attacker || see(this.pos, m) >= 0) scores[i] = 1_000_000 + mvvlva
        else scores[i] = -1_000_000 + mvvlva
      } else if (promo) {
        scores[i] = 900_000 + PIECE_VAL[promo]
      } else if (m === k0) {
        scores[i] = 800_000
      } else if (m === k1) {
        scores[i] = 700_000
      } else if (m === counterMove) {
        scores[i] = 600_000
      } else {
        scores[i] = this.history[colorOffset + moveFrom(m) * 128 + to]
      }
    }
    return scores
  }

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
    if ((this.nodes & 2047) === 0 && (this.timeUp() || (this.nodeLimit > 0 && this.nodes >= this.nodeLimit)))
      this.stop = true
    if (this.stop) return 0
    this.nodes++
    if (ply > this.seldepth) this.seldepth = ply

    const stand = this.staticEvaluate()
    if (stand >= beta) return beta
    if (stand > alpha) alpha = stand
    if (ply >= MAX_PLY - 1) return stand

    const moves: Move[] = []
    generatePseudo(this.pos, moves, true)
    const scores = this.scoreMoves(moves, 0, ply, 0)
    const undo = this.undos[ply]
    const us = this.pos.turn

    for (let i = 0; i < moves.length; i++) {
      this.pickMove(moves, scores, i)
      const m = moves[i]

      // Skip clearly losing captures, and captures that can't reach alpha even
      // with a generous margin (delta pruning).
      if (!movePromo(m)) {
        const to = moveTo(m)
        const victim = moveFlag(m) === FLAG_EP ? PAWN : this.pos.board[to] === EMPTY ? 0 : pieceType(this.pos.board[to])
        if (victim > 0) {
          if (stand + PIECE_VAL[victim] + 200 < alpha) continue
          if (see(this.pos, m) < 0) continue
        }
      }

      this.doMake(m, undo)
      if (isSquareAttacked(this.pos, this.pos.kings[us], (us ^ 1) as Color)) {
        this.doUnmake(m, undo)
        continue
      }
      const score = -this.quiescence(-beta, -alpha, ply + 1)
      this.doUnmake(m, undo)
      if (this.stop) return 0
      if (score >= beta) return beta
      if (score > alpha) alpha = score
    }
    return alpha
  }

  private negamax(depth: number, alpha: number, beta: number, ply: number, isPv: boolean, prevMove: Move): number {
    this.pvLen[ply] = 0
    if ((this.nodes & 2047) === 0 && (this.timeUp() || (this.nodeLimit > 0 && this.nodes >= this.nodeLimit)))
      this.stop = true
    if (this.stop) return 0

    if (ply > 0 && (this.isRepetition() || this.pos.halfmove >= 100)) return 0

    // Hard ply ceiling: with check extensions the search chain can outrun the
    // nominal depth, so cap it to keep the fixed-size undo/PV stacks in bounds.
    if (ply >= MAX_PLY - 1) return this.quiescence(alpha, beta, ply)

    const us = this.pos.turn
    const them = (us ^ 1) as Color
    const checked = isSquareAttacked(this.pos, this.pos.kings[us], them)
    if (checked) depth++ // check extension

    if (depth <= 0) return this.quiescence(alpha, beta, ply)

    this.nodes++
    if (ply > this.seldepth) this.seldepth = ply

    // Mate-distance pruning: never report a mate longer than one already found.
    if (ply > 0) {
      alpha = Math.max(alpha, -MATE + ply)
      beta = Math.min(beta, MATE - ply - 1)
      if (alpha >= beta) return alpha
    }

    const hash = this.pos.hash
    let ttMove = 0
    const ttIdx = this.ttProbe(hash)
    if (ttIdx >= 0) {
      ttMove = this.ttMove[ttIdx]
      if (ply > 0 && !isPv && this.ttDepth[ttIdx] >= depth) {
        let s = this.ttScore[ttIdx]
        if (s > MATE_THRESHOLD) s -= ply
        else if (s < -MATE_THRESHOLD) s += ply
        const flag = this.ttFlag[ttIdx]
        if (flag === TT_EXACT) return s
        if (flag === TT_LOWER && s >= beta) return s
        if (flag === TT_UPPER && s <= alpha) return s
      }
    }

    // Internal iterative reduction: with no hash move to guide ordering, a deep
    // search is wasteful — shave a ply and let the shallower result seed the TT.
    // Kept off the principal variation so forced lines aren't proven any slower.
    if (ttMove === 0 && !isPv && depth >= 6) depth--

    const staticEval = checked ? 0 : this.staticEvaluate()
    this.evalStack[ply] = staticEval
    // "Improving": the side to move stands better than it did two plies ago. When
    // improving we prune less eagerly; when sliding, more.
    const improving = !checked && ply >= 2 && staticEval > this.evalStack[ply - 2]
    const impInt = improving ? 1 : 0

    // --- Static-eval forward pruning (non-PV, not in check) ---
    if (!isPv && !checked && Math.abs(beta) < MATE_THRESHOLD) {
      // Reverse futility / static null move: a big static lead just gives up.
      if (depth <= 6 && staticEval - RFP_MARGIN * depth >= beta) return staticEval

      // Razoring: a hopeless static score drops straight to quiescence.
      if (depth <= 3 && staticEval + RAZOR_MARGIN * depth < alpha) {
        const q = this.quiescence(alpha, beta, ply)
        if (q < alpha) return q
      }

      // Null-move pruning: if passing the move still beats beta, prune.
      if (depth >= 3 && staticEval >= beta && this.hasNonPawnMaterial(us)) {
        const undo = this.undos[ply]
        makeNullMove(this.pos, undo)
        this.keyStack.push(this.pos.hash)
        const R = 2 + (depth >= 6 ? 1 : 0) + (staticEval - beta >= 200 ? 1 : 0)
        const score = -this.negamax(depth - 1 - R, -beta, -beta + 1, ply + 1, false, 0)
        this.keyStack.pop()
        unmakeNullMove(this.pos, undo)
        if (this.stop) return 0
        if (score >= beta) return beta
      }
    }

    const counterMove = prevMove ? this.counter[moveFrom(prevMove) * 128 + moveTo(prevMove)] : 0
    const moves: Move[] = []
    generatePseudo(this.pos, moves, false)
    const scores = this.scoreMoves(moves, ttMove, ply, counterMove)
    const undo = this.undos[ply]
    const quietBase = ply * 64

    const futile = !isPv && !checked && depth <= 6 && Math.abs(alpha) < MATE_THRESHOLD &&
      staticEval + FUTILITY_MARGIN[depth] <= alpha

    let bestScore = -INF
    let bestMove = 0
    let legal = 0
    let quietCount = 0
    let flag = TT_UPPER
    let alphaLocal = alpha

    for (let i = 0; i < moves.length; i++) {
      this.pickMove(moves, scores, i)
      const m = moves[i]
      // Multi-PV: at the root, skip moves already claimed by an earlier line.
      if (ply === 0 && this.rootExcluded.length > 0 && this.rootExcluded.includes(m)) continue
      const capture = this.isCapture(m)
      const promo = movePromo(m)
      const quiet = !capture && !promo

      // Late-move pruning and futility pruning skip hopeless quiet moves, but
      // only once we already have a real score to fall back on. The LMP threshold
      // is more generous when the side to move is improving.
      if (quiet && legal > 0 && bestScore > -MATE_THRESHOLD) {
        if (!isPv && !checked && depth <= 4 && quietCount > LMP_LIMIT[depth] + impInt * depth) continue
        if (futile) continue
      }

      this.doMake(m, undo)
      if (isSquareAttacked(this.pos, this.pos.kings[us], them)) {
        this.doUnmake(m, undo)
        continue
      }
      legal++
      if (quiet) {
        if (quietCount < 64) this.searchedQuiets[quietBase + quietCount] = m
        quietCount++
      }
      const givesCheck = isSquareAttacked(this.pos, this.pos.kings[them], us)
      this.keyStack.push(this.pos.hash)

      let score: number
      if (legal === 1) {
        score = -this.negamax(depth - 1, -beta, -alphaLocal, ply + 1, isPv, m)
      } else {
        // Late move reductions: search likely-irrelevant quiet moves shallower.
        // To keep tactics safe, reductions are only pushed up for clearly late
        // quiets when not improving, and eased for moves with a positive history.
        let r = 0
        if (quiet && depth >= 3 && !givesCheck) {
          r = this.lmr[Math.min(depth, 63) * 64 + Math.min(legal, 63)]
          if (isPv) r--
          if (!improving && legal > 6) r++
          if (this.history[us * 128 * 128 + moveFrom(m) * 128 + moveTo(m)] > 0) r--
          if (r < 0) r = 0
          if (r > depth - 2) r = depth - 2
        }
        score = -this.negamax(depth - 1 - r, -alphaLocal - 1, -alphaLocal, ply + 1, false, m)
        if (r > 0 && score > alphaLocal) {
          score = -this.negamax(depth - 1, -alphaLocal - 1, -alphaLocal, ply + 1, false, m)
        }
        if (score > alphaLocal && score < beta) {
          score = -this.negamax(depth - 1, -beta, -alphaLocal, ply + 1, true, m)
        }
      }

      this.keyStack.pop()
      this.doUnmake(m, undo)
      if (this.stop) return 0

      if (score > bestScore) {
        bestScore = score
        bestMove = m
        if (score > alphaLocal) {
          alphaLocal = score
          flag = TT_EXACT
          this.pv[ply * MAX_PLY] = m
          const childLen = this.pvLen[ply + 1]
          for (let j = 0; j < childLen; j++) {
            this.pv[ply * MAX_PLY + 1 + j] = this.pv[(ply + 1) * MAX_PLY + j]
          }
          this.pvLen[ply] = childLen + 1
        }
      }

      if (alphaLocal >= beta) {
        if (quiet) {
          if (this.killers[ply * 2] !== m) {
            this.killers[ply * 2 + 1] = this.killers[ply * 2]
            this.killers[ply * 2] = m
          }
          if (prevMove) this.counter[moveFrom(prevMove) * 128 + moveTo(prevMove)] = m
          const bonus = depth * depth
          const idx = us * 128 * 128 + moveFrom(m) * 128 + moveTo(m)
          this.history[idx] += bonus
          if (this.history[idx] > 1 << 28) this.dampHistory()
          // History malus: the quiet moves that were tried first but didn't cut
          // get pushed down so they're ordered later next time.
          const n = Math.min(quietCount - 1, 64)
          for (let q = 0; q < n; q++) {
            const qm = this.searchedQuiets[quietBase + q]
            if (qm === m) continue
            this.history[us * 128 * 128 + moveFrom(qm) * 128 + moveTo(qm)] -= bonus
          }
        }
        flag = TT_LOWER
        this.ttStore(hash, depth, bestScore, flag, bestMove, ply)
        return bestScore
      }
    }

    if (legal === 0) {
      return checked ? -MATE + ply : 0
    }

    this.ttStore(hash, depth, bestScore, flag, bestMove, ply)
    return bestScore
  }

  private dampHistory(): void {
    for (let i = 0; i < this.history.length; i++) this.history[i] >>= 1
  }
}
