// The Arena — a from-scratch statistical strength-testing framework for the
// engine, the way real chess-engine development is actually validated (Fishtest /
// OpenBench / cutechess-cli + BayesElo). It has two independent halves:
//
//   1. A **game runner** (`playGame`) that pits two "brains" — any pairing of the
//      alpha-beta searcher and the MCTS searcher, each with the classical or the
//      neural evaluation — head-to-head from a fixed opening, with cutechess-style
//      win/draw **adjudication** so games stay short and decisive.
//
//   2. The **statistics** an engine tester lives by, all hand-derived here with no
//      library: the logistic Elo model, the **SPRT** (Sequential Probability Ratio
//      Test) in both the per-game *trinomial* and the modern per-game-pair
//      *pentanomial* variance models, an Elo point estimate with a pentanomial-
//      correct confidence interval, the **LOS** (likelihood of superiority), a
//      two-sided significance z/p, and a **Bradley–Terry maximum-likelihood** rating
//      fit (the MLE that BayesElo approximates) for an N-engine round-robin.
//
// This module is deliberately DOM-free and side-effect-free so it runs identically
// in the UI thread, in the arena Web Worker, and under Node for validation.

import {
  type Position,
  type Move,
  type Color,
  type Undo,
  WHITE,
  parseFen,
  toFen,
  makeMoveOnBoard,
} from './board'
import { generateLegal, isSquareAttacked } from './movegen'
import { moveToSan } from './san'
import { Searcher } from './search'
import { mctsSearch, MCTS_DEFAULTS } from './mcts'
import { type NnueWeights } from './nnue'

// ============================================================================
// Opening book — balanced, varied start positions
// ============================================================================

/**
 * A curated set of balanced opening positions. Each is played from *both* sides
 * in a match (player A as White, then as Black), forming the colour-reversed pairs
 * the pentanomial model consumes. Kept a few plies in so the games diverge but not
 * so far that either side is already better.
 */
export const ARENA_OPENINGS: { name: string; fen: string }[] = [
  { name: 'Ruy Lopez', fen: 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4' },
  { name: 'Italian', fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 4 3' },
  { name: 'Sicilian Najdorf', fen: 'rnbqkb1r/1p2pppp/p2p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6' },
  { name: 'Sicilian Dragon', fen: 'rnbqkb1r/pp2pp1p/3p1np1/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq - 0 6' },
  { name: 'French Defence', fen: 'rnbqkbnr/ppp2ppp/4p3/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq d6 0 3' },
  { name: 'Caro-Kann', fen: 'rnbqkbnr/pp2pppp/2p5/3p4/3PP3/8/PPP2PPP/RNBQKBNR w KQkq d6 0 3' },
  { name: "Queen's Gambit Declined", fen: 'rnbqkbnr/ppp2ppp/4p3/3p4/2PP4/8/PP2PPPP/RNBQKBNR w KQkq - 0 3' },
  { name: 'Slav Defence', fen: 'rnbqkbnr/pp2pppp/2p5/3p4/2PP4/8/PP2PPPP/RNBQKBNR w KQkq - 0 3' },
  { name: "King's Indian", fen: 'rnbqk2r/ppppppbp/5np1/8/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq - 0 4' },
  { name: 'Nimzo-Indian', fen: 'rnbqk2r/pppp1ppp/4pn2/8/1bPP4/2N5/PP2PPPP/R1BQKBNR w KQkq - 2 4' },
  { name: 'Grünfeld', fen: 'rnbqkb1r/ppp1pp1p/5np1/3p4/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq d6 0 4' },
  { name: 'English Symmetric', fen: 'rnbqkbnr/pp1ppppp/8/2p5/2P5/8/PP1PPPPP/RNBQKBNR w KQkq c6 0 2' },
  { name: 'London System', fen: 'rnbqkb1r/ppp1pppp/5n2/3p4/3P1B2/8/PPP1PPPP/RN1QKBNR w KQkq - 2 3' },
  { name: 'Scandinavian', fen: 'rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2' },
  { name: "King's Gambit", fen: 'rnbqkbnr/pppp1ppp/8/4p3/4PP2/8/PPPP2PP/RNBQKBNR b KQkq f3 0 2' },
  { name: 'Pirc Defence', fen: 'rnbqkb1r/ppp1pp1p/3p1np1/8/3PP3/2N5/PPP2PPP/R1BQKBNR w KQkq - 0 4' },
]

// ============================================================================
// Engine specifications & brains
// ============================================================================

export type EvalKind = 'classical' | 'nnue'

/** A fully-described engine configuration — one competitor in the Arena. */
export interface EngineSpec {
  /** The search algorithm. */
  search: 'ab' | 'mcts'
  /** Binding budget per move (nodes for alpha-beta, simulations for MCTS). */
  budget: number
  /** Which static evaluation feeds the search. */
  eval: EvalKind
  /** Human-readable label, shown throughout the UI. */
  label: string
}

/** Stable identity for a spec, used to key crosstables and dedupe. */
export function specKey(s: EngineSpec): string {
  return `${s.search}:${s.budget}:${s.eval}`
}

export function defaultLabel(s: Omit<EngineSpec, 'label'>): string {
  const algo = s.search === 'ab' ? 'AB' : 'MCTS'
  const unit = s.search === 'ab' ? 'n' : 'sim'
  const b = s.budget >= 1000 ? `${s.budget / 1000}k` : `${s.budget}`
  return `${algo} ${b}${unit}·${s.eval === 'nnue' ? 'NNUE' : 'HCE'}`
}

/** A brain turns a position into a move and reports a white-relative score in cp. */
export interface Brain {
  pick(pos: Position, history: bigint[], seed: number): { move: Move | null; scoreWhiteCp: number }
  /** Reset any per-game memory (e.g. the transposition table) before a new game. */
  newGame(): void
}

// A large centipawn value that stands in for "mate" in adjudication comparisons.
const MATE_CP_ADJ = 30000

function makeAbBrain(budget: number, weights: NnueWeights | null): Brain {
  const s = new Searcher()
  s.setEvaluator(weights)
  return {
    newGame() {
      s.clearTable()
    },
    pick(pos, history) {
      const info = s.search(pos, { maxDepth: 64, maxTime: 0, maxNodes: budget, history })
      const stm = info.score
      // Fold a signed mate into a large cp magnitude so adjudication reads it.
      const cp = info.mate != null ? (info.mate > 0 ? MATE_CP_ADJ : -MATE_CP_ADJ) : stm
      return { move: info.pv[0] ?? null, scoreWhiteCp: pos.turn === WHITE ? cp : -cp }
    },
  }
}

function makeMctsBrain(budget: number, evalKind: EvalKind, weights: NnueWeights | null): Brain {
  return {
    newGame() {
      /* MCTS is stateless between moves — nothing to reset. */
    },
    pick(pos, history, seed) {
      void history
      const r = mctsSearch(
        toFen(pos),
        {
          ...MCTS_DEFAULTS,
          maxNodes: budget,
          maxTime: 0,
          evalSource: evalKind,
          seed: (seed ^ 0x9e3779b9) >>> 0,
        },
        evalKind === 'nnue' ? weights : null,
      )
      const cp = r.mate != null ? (r.mate > 0 ? MATE_CP_ADJ : -MATE_CP_ADJ) : r.scoreCp
      return { move: r.bestMove, scoreWhiteCp: pos.turn === WHITE ? cp : -cp }
    },
  }
}

/** Build a brain from a spec, given an optional NNUE net (shared across brains). */
export function makeBrain(spec: EngineSpec, weights: NnueWeights | null): Brain {
  const net = spec.eval === 'nnue' ? weights : null
  return spec.search === 'ab' ? makeAbBrain(spec.budget, net) : makeMctsBrain(spec.budget, spec.eval, net)
}

// ============================================================================
// The game runner
// ============================================================================

export interface AdjudicationOptions {
  /** Resign a game once one side is ahead by ≥ resignCp for resignPlies plies. */
  resignCp: number
  resignPlies: number
  /** Call a draw once both scores stay within drawCp for drawPlies plies (after move drawMinMove). */
  drawCp: number
  drawPlies: number
  drawMinMove: number
  /** Hard cap on the game length; hit it and the final eval sign decides. */
  maxPlies: number
}

export const ADJUDICATION_DEFAULTS: AdjudicationOptions = {
  resignCp: 900,
  resignPlies: 6,
  drawCp: 12,
  drawPlies: 10,
  drawMinMove: 40,
  maxPlies: 240,
}

export type GameReason =
  | 'checkmate'
  | 'stalemate'
  | 'fifty-move'
  | 'repetition'
  | 'insufficient'
  | 'adj-resign'
  | 'adj-draw'
  | 'adj-maxplies'
  | 'no-move'

export interface GameOutcome {
  /** White's score: 1 = white win, 0 = black win, 0.5 = draw. */
  white: number
  reason: GameReason
  plies: number
  /** SAN movetext (space-separated), for PGN export. */
  san: string
}

function insufficientMaterial(pos: Position): boolean {
  let minors = 0
  for (let s = 0; s < 128; s++) {
    if ((s & 0x88) !== 0) {
      s += 7
      continue
    }
    const pc = pos.board[s]
    if (pc === 0) continue
    const t = pc & 7
    if (t === 1 || t === 4 || t === 5) return false // pawn, rook, queen
    if (t === 2 || t === 3) minors++
  }
  return minors <= 1
}

function inCheck(pos: Position): boolean {
  return isSquareAttacked(pos, pos.kings[pos.turn], (pos.turn ^ 1) as Color)
}

/**
 * Play one game between two brains from `startFen`. `white`/`black` are already
 * built brains. Deterministic given the same brains + seed. Applies natural rules
 * (mate / stalemate / 50-move / threefold / insufficient material) and cutechess-
 * style resign/draw adjudication on top.
 */
export function playGame(
  white: Brain,
  black: Brain,
  startFen: string,
  adj: AdjudicationOptions,
  seed: number,
): GameOutcome {
  const pos = parseFen(startFen)
  white.newGame()
  black.newGame()

  const undo: Undo = { captured: 0, capturedSq: -1, castling: 0, ep: -1, halfmove: 0, hash: 0n }
  const keys: bigint[] = [pos.hash]
  const sans: string[] = []

  // Adjudication counters.
  let resignRun = 0
  let resignSide = 0 // +1 white ahead, -1 black ahead
  let drawRun = 0
  let lastWhiteCp = 0
  let plies = 0

  const finish = (white: number, reason: GameReason): GameOutcome => ({
    white,
    reason,
    plies,
    san: sans.join(' '),
  })

  for (; plies < adj.maxPlies; plies++) {
    const legal = generateLegal(pos)
    if (legal.length === 0) {
      // Mate or stalemate.
      if (inCheck(pos)) return finish(pos.turn === WHITE ? 0 : 1, 'checkmate')
      return finish(0.5, 'stalemate')
    }
    if (pos.halfmove >= 100) return finish(0.5, 'fifty-move')
    // Threefold repetition on the current position.
    let rep = 0
    for (const k of keys) if (k === pos.hash) rep++
    if (rep >= 3) return finish(0.5, 'repetition')
    if (insufficientMaterial(pos)) return finish(0.5, 'insufficient')

    const brain = pos.turn === WHITE ? white : black
    const { move, scoreWhiteCp } = brain.pick(pos, keys, seed + plies)
    if (move == null) {
      // A brain failed to produce a move — decide by the last known eval.
      return finish(lastWhiteCp > 0 ? 1 : lastWhiteCp < 0 ? 0 : 0.5, 'no-move')
    }
    lastWhiteCp = scoreWhiteCp

    // Resign adjudication — a decisive, persistent advantage for one side.
    const side = scoreWhiteCp >= adj.resignCp ? 1 : scoreWhiteCp <= -adj.resignCp ? -1 : 0
    if (side !== 0 && side === resignSide) resignRun++
    else {
      resignSide = side
      resignRun = side !== 0 ? 1 : 0
    }
    if (resignRun >= adj.resignPlies) return finish(resignSide > 0 ? 1 : 0, 'adj-resign')

    // Draw adjudication — a dead-level position that has stopped moving.
    const moveNo = (plies >> 1) + 1
    if (moveNo >= adj.drawMinMove && Math.abs(scoreWhiteCp) <= adj.drawCp) drawRun++
    else drawRun = 0
    if (drawRun >= adj.drawPlies) return finish(0.5, 'adj-draw')

    sans.push(moveToSan(pos, move, legal))
    makeMoveOnBoard(pos, move, undo)
    keys.push(pos.hash)
  }

  // Hit the ply cap — the final eval sign decides, within a margin.
  const w = lastWhiteCp > 100 ? 1 : lastWhiteCp < -100 ? 0 : 0.5
  return finish(w, 'adj-maxplies')
}

// ============================================================================
// Elo & the logistic model
// ============================================================================

/** Numerical error function (Abramowitz–Stegun 7.1.26), max abs error 1.5e-7. */
export function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x))
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x)
  return x >= 0 ? y : -y
}

/** Standard-normal CDF Φ(z). */
export function phi(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2))
}

/** Expected score → Elo difference (logistic, base-10, 400-scale). */
export function eloFromScore(score: number): number {
  const s = Math.max(1e-9, Math.min(1 - 1e-9, score))
  return -400 * Math.log10(1 / s - 1)
}

/** Elo difference → expected score. */
export function scoreFromElo(elo: number): number {
  return 1 / (1 + Math.pow(10, -elo / 400))
}

// ============================================================================
// Match aggregation — trinomial (per game) & pentanomial (per game-pair)
// ============================================================================

/**
 * The running tally of a match. Games are logged individually (trinomial view)
 * and, when played in colour-reversed pairs, aggregated into a pentanomial
 * distribution — the game-*pair* result in {0, ½, 1, 1½, 2} points for player A,
 * which correctly captures the correlation between the two games of a pair and so
 * gives the smaller, honest variance the SPRT needs.
 */
export interface MatchTally {
  /** Wins / draws / losses for player A (trinomial). */
  w: number
  d: number
  l: number
  /** Pentanomial buckets: index i = pairs where A scored i·½ of 2 points. */
  penta: [number, number, number, number, number]
}

export function emptyTally(): MatchTally {
  return { w: 0, d: 0, l: 0, penta: [0, 0, 0, 0, 0] }
}

/** Fold two colour-reversed games (A's scores, each in {0,½,1}) into the tally. */
export function addPair(t: MatchTally, aScore1: number, aScore2: number): void {
  for (const s of [aScore1, aScore2]) {
    if (s === 1) t.w++
    else if (s === 0.5) t.d++
    else t.l++
  }
  const idx = Math.round((aScore1 + aScore2) * 2) // 0..4
  t.penta[idx]++
}

/** Fold a single (unpaired) game into the trinomial tally only. */
export function addGame(t: MatchTally, aScore: number): void {
  if (aScore === 1) t.w++
  else if (aScore === 0.5) t.d++
  else t.l++
}

// ---- Distribution helpers -------------------------------------------------

/** Mean & variance of the per-game score under the trinomial model. */
function trinomialMoments(t: MatchTally): { n: number; mean: number; variance: number } {
  const n = t.w + t.d + t.l
  if (n === 0) return { n: 0, mean: 0.5, variance: 0 }
  const mean = (t.w + 0.5 * t.d) / n
  // Population variance of the score r.v. over the observed pmf.
  const e2 = (t.w * 1 + t.d * 0.25 + t.l * 0) / n
  const variance = Math.max(0, e2 - mean * mean)
  return { n, mean, variance }
}

/** Mean & variance of the per-*pair* score (out of 2) under the pentanomial model. */
function pentanomialMoments(t: MatchTally): { pairs: number; mean: number; variance: number } {
  const pairs = t.penta.reduce((a, b) => a + b, 0)
  if (pairs === 0) return { pairs: 0, mean: 1, variance: 0 }
  let m = 0
  let m2 = 0
  for (let i = 0; i < 5; i++) {
    const v = i * 0.5 // pair score in {0,.5,1,1.5,2}
    m += t.penta[i] * v
    m2 += t.penta[i] * v * v
  }
  m /= pairs
  m2 /= pairs
  return { pairs, mean: m, variance: Math.max(0, m2 - m * m) }
}

// ============================================================================
// SPRT — Sequential Probability Ratio Test (generalized / normal-approx)
// ============================================================================

export type SprtModel = 'trinomial' | 'pentanomial' | 'pentanomial-exact'
export type SprtVerdict = 'continue' | 'accept-h1' | 'accept-h0'

export interface SprtParams {
  /** Null and alternative Elo hypotheses (the [elo0, elo1] interval under test). */
  elo0: number
  elo1: number
  /** Type-I and type-II error rates. */
  alpha: number
  beta: number
  model: SprtModel
}

export const SPRT_DEFAULTS: SprtParams = {
  elo0: 0,
  elo1: 10,
  alpha: 0.05,
  beta: 0.05,
  model: 'pentanomial',
}

export interface SprtResult {
  llr: number
  lower: number
  upper: number
  verdict: SprtVerdict
  /** Observations so far (games for trinomial, pairs for pentanomial). */
  n: number
  /**
   * A rough estimate of how many more observations the test needs to decide, from
   * the current LLR drift per observation (0 if already decided or drift is flat).
   */
  expectedRemaining: number
}

/**
 * The generalized SPRT (GSPRT) log-likelihood ratio under a normal approximation
 * to the score distribution — the estimator used in practice by Fishtest/OpenBench.
 * For a sample with `n` observations of mean `mean` and variance `variance`, and
 * two hypothesized means `m0`, `m1`:
 *
 *     LLR = n · (mean − (m0+m1)/2) · (m1 − m0) / variance
 *
 * Wald's thresholds are `log(β/(1−α))` (accept H0) and `log((1−β)/α)` (accept H1).
 */
function gsprtLlr(n: number, mean: number, variance: number, m0: number, m1: number): number {
  if (n === 0) return 0
  // A perfectly one-sided result has zero sample variance — but it is decisive, not
  // uninformative, so floor the variance instead of returning a null LLR. The floor
  // only bites in that degenerate case; on any real spread it is negligible.
  const v = Math.max(variance, 1e-6)
  return (n * (mean - (m0 + m1) / 2) * (m1 - m0)) / v
}

/**
 * The **exact** generalized SPRT via empirical likelihood — no normal
 * approximation. For discrete outcome categories with values `v` and observed
 * counts `n`, the maximum-likelihood distribution supported on the observed
 * categories with mean constrained to `m` is
 *
 *     p_i(m) = n_i / (N · (1 + t·(v_i − m)))
 *
 * where the tilt `t` is the unique root of Σ n_i (v_i − m)/(1 + t(v_i − m)) = 0
 * (the mean constraint; normalization then follows automatically). The exact LLR
 * between the two hypotheses is then
 *
 *     LLR = Σ n_i [ log(1 + t₀(v_i − m₀)) − log(1 + t₁(v_i − m₁)) ]
 *
 * (the n_i·log(n_i/N) terms cancel). This is the estimator Michel Van den Bergh
 * derived for pentanomial SPRT; it agrees with the normal-approx GSPRT to first
 * order but is exact at any sample size.
 */
function empiricalTilt(counts: number[], values: number[], m: number): number {
  const N = counts.reduce((a, b) => a + b, 0)
  if (N === 0) return 0
  // Valid range for t: keep 1 + t(v_i − m) > 0 for every populated category.
  let tLo = -Infinity
  let tHi = Infinity
  for (let i = 0; i < values.length; i++) {
    if (counts[i] === 0) continue
    const d = values[i] - m
    if (d > 0) tLo = Math.max(tLo, -1 / d)
    else if (d < 0) tHi = Math.min(tHi, -1 / d)
  }
  if (!Number.isFinite(tLo)) tLo = -1e6
  if (!Number.isFinite(tHi)) tHi = 1e6
  // F(t) = Σ n_i (v_i − m)/(1 + t(v_i − m)) is strictly decreasing; bisect its root.
  const F = (t: number): number => {
    let s = 0
    for (let i = 0; i < values.length; i++) {
      if (counts[i] === 0) continue
      const d = values[i] - m
      s += (counts[i] * d) / (1 + t * d)
    }
    return s
  }
  let lo = tLo + 1e-9
  let hi = tHi - 1e-9
  if (F(lo) <= 0) return lo
  if (F(hi) >= 0) return hi
  for (let it = 0; it < 200; it++) {
    const mid = (lo + hi) / 2
    const f = F(mid)
    if (Math.abs(f) < 1e-12) return mid
    if (f > 0) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

function exactLlr(counts: number[], values: number[], m0: number, m1: number): number {
  const t0 = empiricalTilt(counts, values, m0)
  const t1 = empiricalTilt(counts, values, m1)
  let llr = 0
  for (let i = 0; i < values.length; i++) {
    if (counts[i] === 0) continue
    llr += counts[i] * (Math.log(1 + t0 * (values[i] - m0)) - Math.log(1 + t1 * (values[i] - m1)))
  }
  return llr
}

/**
 * Is the empirical-likelihood LLR well-conditioned? It requires each hypothesized
 * mean to sit strictly inside the convex hull of the *observed* category values.
 * On a degenerate result (e.g. every pair a double-win — all mass at value 2) the
 * hull collapses and the constrained MLE for an interior mean is ill-defined, so we
 * fall back to the normal approximation there.
 */
function exactWellConditioned(counts: number[], values: number[], m0: number, m1: number): boolean {
  let minV = Infinity
  let maxV = -Infinity
  for (let i = 0; i < values.length; i++) {
    if (counts[i] === 0) continue
    minV = Math.min(minV, values[i])
    maxV = Math.max(maxV, values[i])
  }
  const d = 1e-6
  const inside = (m: number) => m > minV + d && m < maxV - d
  return inside(m0) && inside(m1)
}

export function sprt(t: MatchTally, p: SprtParams): SprtResult {
  const lower = Math.log(p.beta / (1 - p.alpha))
  const upper = Math.log((1 - p.beta) / p.alpha)
  const s0 = scoreFromElo(p.elo0)
  const s1 = scoreFromElo(p.elo1)

  let llr: number
  let n: number
  if (p.model === 'pentanomial' || p.model === 'pentanomial-exact') {
    const { pairs, mean, variance } = pentanomialMoments(t)
    n = pairs
    // Hypothesized per-pair means are twice the per-game expected scores.
    if (p.model === 'pentanomial-exact') {
      const vals = [0, 0.5, 1, 1.5, 2]
      // Exact where well-conditioned; robust normal-approx at the degenerate edges.
      llr =
        pairs > 0 && exactWellConditioned([...t.penta], vals, 2 * s0, 2 * s1)
          ? exactLlr([...t.penta], vals, 2 * s0, 2 * s1)
          : gsprtLlr(pairs, mean, variance, 2 * s0, 2 * s1)
    } else {
      llr = gsprtLlr(pairs, mean, variance, 2 * s0, 2 * s1)
    }
  } else {
    const { n: games, mean, variance } = trinomialMoments(t)
    n = games
    llr = gsprtLlr(games, mean, variance, s0, s1)
  }

  const verdict: SprtVerdict = llr >= upper ? 'accept-h1' : llr <= lower ? 'accept-h0' : 'continue'
  // Estimate observations remaining from the current per-observation LLR drift.
  let expectedRemaining = 0
  if (verdict === 'continue' && n > 0 && Math.abs(llr) > 1e-6) {
    const drift = llr / n
    const target = llr >= 0 ? upper : lower
    const rem = (target - llr) / drift
    expectedRemaining = rem > 0 && Number.isFinite(rem) ? Math.ceil(rem) : 0
  }
  return { llr, lower, upper, verdict, n, expectedRemaining }
}

// ============================================================================
// Point estimate: Elo ± CI, LOS, significance, normalized advantage
// ============================================================================

export interface EloEstimate {
  /** Total games and, if paired, game-pairs. */
  games: number
  pairs: number
  /** Per-game score for player A and its Elo. */
  score: number
  elo: number
  /** 95% CI on the Elo (asymmetric — the score CI mapped through the logistic). */
  eloLow: number
  eloHigh: number
  /** Standard error of the per-game score estimate (pentanomial where possible). */
  scoreSE: number
  /** Likelihood A is genuinely stronger than B (one-sided, from the score z). */
  los: number
  /** Two-sided z and p for H0: equal strength (score = ½). */
  z: number
  pValue: number
  /**
   * Normalized advantage: the per-pair score edge measured in standard deviations,
   * √2·(μ₂−1)/σ₂ — draw-ratio-independent, the basis of "normalized Elo".
   */
  normAdvantage: number
  /** Draw rate over all games. */
  drawRate: number
}

export function estimate(t: MatchTally): EloEstimate {
  const games = t.w + t.d + t.l
  const tri = trinomialMoments(t)
  const pen = pentanomialMoments(t)

  const score = tri.mean
  const elo = eloFromScore(score)

  // Standard error of the mean per-game score. Prefer the pentanomial estimate
  // (paired games are correlated; the pentanomial variance is the correct one).
  let scoreSE: number
  let z: number
  let normAdvantage = 0
  if (pen.pairs > 0 && pen.variance > 0) {
    // Var(per-pair mean) = variance / pairs; per-game score = pairMean / 2.
    const sePair = Math.sqrt(pen.variance / pen.pairs)
    scoreSE = sePair / 2
    const sigmaPair = Math.sqrt(pen.variance)
    normAdvantage = sigmaPair > 0 ? (Math.SQRT2 * (pen.mean - 1)) / sigmaPair : 0
    z = scoreSE > 0 ? (score - 0.5) / scoreSE : 0
  } else if (games > 0 && tri.variance > 0) {
    scoreSE = Math.sqrt(tri.variance / games)
    z = scoreSE > 0 ? (score - 0.5) / scoreSE : 0
  } else {
    scoreSE = 0
    z = 0
  }

  const margin = 1.96 * scoreSE
  const eloLow = eloFromScore(score - margin)
  const eloHigh = eloFromScore(score + margin)

  const los = phi(z)
  const pValue = 2 * (1 - phi(Math.abs(z)))
  const drawRate = games > 0 ? t.d / games : 0

  return {
    games,
    pairs: pen.pairs,
    score,
    elo,
    eloLow,
    eloHigh,
    scoreSE,
    los,
    z,
    pValue,
    normAdvantage,
    drawRate,
  }
}

// ============================================================================
// Round-robin: Bradley–Terry maximum-likelihood ratings (the BayesElo MLE)
// ============================================================================

export interface HeadToHead {
  /** Games where the row engine beat the column engine. */
  wins: number
  draws: number
  losses: number
}

export interface CrossTable {
  /** n×n head-to-head, indexed [row][col] from the row engine's perspective. */
  cells: HeadToHead[][]
  labels: string[]
}

export function emptyCrossTable(labels: string[]): CrossTable {
  const n = labels.length
  const cells: HeadToHead[][] = Array.from({ length: n }, () =>
    Array.from({ length: n }, () => ({ wins: 0, draws: 0, losses: 0 })),
  )
  return { cells, labels }
}

/** Record a game result between engines i and j (score = i's score in {0,½,1}). */
export function recordResult(ct: CrossTable, i: number, j: number, iScore: number): void {
  if (iScore === 1) {
    ct.cells[i][j].wins++
    ct.cells[j][i].losses++
  } else if (iScore === 0) {
    ct.cells[i][j].losses++
    ct.cells[j][i].wins++
  } else {
    ct.cells[i][j].draws++
    ct.cells[j][i].draws++
  }
}

export interface Standing {
  index: number
  label: string
  played: number
  points: number
  elo: number
  eloError: number
}

/**
 * Maximum-likelihood Elo ratings via the Bradley–Terry model with draws counted
 * as half-points — the estimator BayesElo approximates. In γ-space (γ = 10^(r/400))
 * the MM (minorization–maximization) fixed point is
 *
 *     γ_i ← T_i / Σ_{j≠i} n_ij / (γ_i + γ_j)
 *
 * where T_i is i's total points and n_ij the games between i and j (Hunter 2004).
 * The iteration increases the likelihood every step and converges globally; we then
 * anchor the ratings to mean 0 and convert back to Elo. Standard errors come from
 * the diagonal of the inverse Fisher information of the fitted logistic model.
 */
export function fitRatings(ct: CrossTable, iters = 500): Standing[] {
  const n = ct.labels.length
  const gamma = new Array(n).fill(1)
  const points = new Array(n).fill(0)
  const played = new Array(n).fill(0)
  const games: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      const c = ct.cells[i][j]
      const gij = c.wins + c.draws + c.losses
      games[i][j] = gij
      played[i] += gij
      points[i] += c.wins + 0.5 * c.draws
    }
  }

  // MM iterations. Engines with no games keep γ = 1 (Elo 0).
  for (let it = 0; it < iters; it++) {
    let maxRel = 0
    for (let i = 0; i < n; i++) {
      if (played[i] === 0 || points[i] === 0) continue
      let denom = 0
      for (let j = 0; j < n; j++) {
        if (i === j || games[i][j] === 0) continue
        denom += games[i][j] / (gamma[i] + gamma[j])
      }
      if (denom <= 0) continue
      const next = points[i] / denom
      maxRel = Math.max(maxRel, Math.abs(next - gamma[i]) / gamma[i])
      gamma[i] = next
    }
    // Renormalize to geometric mean 1 for numerical stability.
    let logSum = 0
    let cnt = 0
    for (let i = 0; i < n; i++)
      if (played[i] > 0) {
        logSum += Math.log(gamma[i])
        cnt++
      }
    if (cnt > 0) {
      const gm = Math.exp(logSum / cnt)
      for (let i = 0; i < n; i++) gamma[i] /= gm
    }
    if (maxRel < 1e-9) break
  }

  const elo = gamma.map((g) => 400 * Math.log10(g))

  // Standard errors from the logistic Fisher information: for the pairwise model
  // I_ii = Σ_{j≠i} n_ij · p_ij · (1−p_ij) · (ln10/400)², SE_i ≈ 1/√I_ii.
  const k = Math.log(10) / 400
  const errors = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    let info = 0
    for (let j = 0; j < n; j++) {
      if (i === j || games[i][j] === 0) continue
      const p = gamma[i] / (gamma[i] + gamma[j])
      info += games[i][j] * p * (1 - p) * k * k
    }
    errors[i] = info > 0 ? 1 / Math.sqrt(info) : 0
  }

  const standings: Standing[] = ct.labels.map((label, i) => ({
    index: i,
    label,
    played: played[i],
    points: points[i],
    elo: elo[i],
    eloError: errors[i],
  }))
  standings.sort((a, b) => b.elo - a.elo)
  return standings
}

/** Pairwise likelihood-of-superiority from a head-to-head (normal approx). */
export function losFromH2H(c: HeadToHead): number {
  const n = c.wins + c.draws + c.losses
  if (n === 0) return 0.5
  const mean = (c.wins + 0.5 * c.draws) / n
  const e2 = (c.wins + 0.25 * c.draws) / n
  const variance = Math.max(0, e2 - mean * mean)
  if (variance <= 0) return mean > 0.5 ? 1 : mean < 0.5 ? 0 : 0.5
  const se = Math.sqrt(variance / n)
  return phi((mean - 0.5) / se)
}
