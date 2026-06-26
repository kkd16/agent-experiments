// Cortex Coach — a principled, from-scratch game-review model.
//
// Given a game (start FEN + moves) and a per-node engine analysis (the best line,
// its score, and the 2nd-best score at every position), this module classifies
// every move (Brilliant / Great / Best / … / Blunder / Missed-win), scores each
// player's overall **accuracy %** and **average centipawn loss (ACPL)**, estimates
// a performance rating, and writes a plain-English coach note per move — all with
// no external service. The maths is the documented lichess model:
//
//   win%(cp)      = 50 + 50·(2/(1+e^(−0.00368208·cp)) − 1)        — clamped to ±1000cp
//   accuracy(Δ)   = 103.1668·e^(−0.04354·Δ) − 3.1669              — Δ = win-% the move conceded
//   player accuracy = mean( volatility-weighted mean , harmonic mean ) of move accuracies
//
// The classification adds the familiar chess.com flavours on top: a sound
// **sacrifice** that stays best is Brilliant, an **only-move** (the second-best is
// far worse) that you found is Great, and throwing away a forced mate / winning
// position is a Missed win.

import {
  type Move,
  type Color,
  WHITE,
  BLACK,
  moveFrom,
  moveTo,
  movePromo,
  fileOf,
  rankOf,
} from './board'
import { Game } from './index'
import { moveToSan } from './san'
import { see } from './see'
import { bookExplorer } from './book'

export const MATE_CP = 100000

export type MoveClass =
  | 'brilliant'
  | 'great'
  | 'best'
  | 'excellent'
  | 'good'
  | 'book'
  | 'inaccuracy'
  | 'mistake'
  | 'blunder'
  | 'missed-win'
  | 'forced'

// One position's engine read, from the **side-to-move's** point of view.
export interface NodeAnalysis {
  score: number // centipawns, side-to-move POV (best line)
  mate: number | null // signed mate-in-N for the best line, or null
  bestPv: Move[] // the best line (move ints)
  secondScore: number | null // 2nd-best move's score (stm POV), or null if none
  secondMate: number | null
}

export interface MoveReview {
  index: number // 0-based ply index (move i is from node i to node i+1)
  san: string
  color: Color // the player who made the move
  klass: MoveClass
  cpBefore: number // mover POV, best achievable
  cpAfter: number // mover POV, after the move actually played
  winBefore: number // 0..100, mover POV
  winAfter: number
  accuracy: number // 0..100
  cpLoss: number // centipawns lost vs best (≥0)
  isBest: boolean
  bestMove: Move | null // the engine's best move at this node (for a board arrow)
  bestSan: string // SAN of the engine's best move at this node
  bestLineSan: string // a few plies of the best line
  coach: string // plain-English note
}

export interface PlayerSummary {
  accuracy: number // 0..100
  acpl: number // average centipawn loss
  estElo: number // rough performance estimate
  moves: number // moves counted toward stats (book/forced excluded)
  counts: Record<MoveClass, number>
}

export interface GameReview {
  moves: MoveReview[]
  white: PlayerSummary
  black: PlayerSummary
  keyMoments: number[] // indices into `moves`, biggest swings first
}

// ---- core curves -------------------------------------------------------------

// Effective centipawns for win-% purposes: a mate collapses to a saturating ±value.
function effCp(a: { score: number; mate: number | null }): number {
  if (a.mate !== null) return a.mate > 0 ? MATE_CP : -MATE_CP
  return a.score
}

export function winPercent(cp: number): number {
  const c = Math.max(-1000, Math.min(1000, cp))
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1)
}

export function moveAccuracy(winBefore: number, winAfter: number): number {
  const drop = Math.max(0, winBefore - winAfter)
  const acc = 103.1668 * Math.exp(-0.04354 * drop) - 3.1669
  return Math.max(0, Math.min(100, acc))
}

// Population standard deviation of a window — the "volatility" weight.
function stdev(xs: number[]): number {
  if (xs.length === 0) return 0
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length
  return Math.sqrt(v)
}

function harmonicMean(xs: number[]): number {
  if (xs.length === 0) return 0
  let s = 0
  for (const x of xs) s += 1 / Math.max(x, 1e-3)
  return xs.length / s
}

// lichess-style aggregate: average of a volatility-weighted mean and a harmonic
// mean of the move accuracies. `winWhite` is the white-POV win% at every node;
// the weight for each move is the stdev of a window of those values around it.
function aggregateAccuracy(accs: number[], winWhite: number[], plyIdx: number[]): number {
  if (accs.length === 0) return 100
  const n = winWhite.length
  const win = Math.max(2, Math.min(8, Math.ceil(n / 10)))
  const weights = accs.map((_, k) => {
    const center = plyIdx[k]
    const lo = Math.max(0, center - win)
    const hi = Math.min(n - 1, center + win)
    const w = winWhite.slice(lo, hi + 1)
    return Math.max(0.5, Math.min(12, stdev(w)))
  })
  let wsum = 0
  let wtot = 0
  for (let k = 0; k < accs.length; k++) {
    wsum += accs[k] * weights[k]
    wtot += weights[k]
  }
  const weighted = wtot > 0 ? wsum / wtot : accs.reduce((a, b) => a + b, 0) / accs.length
  const harm = harmonicMean(accs)
  return Math.max(0, Math.min(100, (weighted + harm) / 2))
}

// A defensible, clearly-approximate map from ACPL to a performance rating. Lower
// centipawn loss ⇒ stronger play; saturated at the ends.
function estimateElo(acpl: number): number {
  const e = 3100 * Math.exp(-acpl / 90) - 200
  return Math.round(Math.max(250, Math.min(2900, e)))
}

// ---- formatting helpers ------------------------------------------------------

function fmtEval(cp: number, mate: number | null): string {
  if (mate !== null) return `#${Math.abs(mate)}`
  const v = cp / 100
  return (v >= 0 ? '+' : '') + v.toFixed(2)
}

function squareName(sq: number): string {
  return 'abcdefgh'[fileOf(sq)] + (rankOf(sq) + 1)
}

function bestLineToSan(fen: string, pv: Move[], limit = 6): string {
  const g = new Game(fen)
  const parts: string[] = []
  for (let i = 0; i < pv.length && i < limit; i++) {
    const legal = g.legalMoves()
    if (!legal.includes(pv[i])) break
    let prefix = ''
    if (g.turn === WHITE) prefix = `${g.pos.fullmove}.`
    else if (i === 0) prefix = `${g.pos.fullmove}…`
    parts.push(prefix + moveToSan(g.pos, pv[i], legal))
    g.apply(pv[i])
  }
  return parts.join(' ')
}

// ---- classification ----------------------------------------------------------

interface ClassifyInput {
  played: Move
  best: Move | null
  winBefore: number
  winAfter: number
  cpBefore: number
  cpAfter: number
  bestMate: number | null // mate available for the mover at this node (>0 means yes)
  afterMate: number | null // mate situation after the move (mover POV; <0 means now getting mated)
  secondCp: number | null // 2nd-best move score, mover POV
  legalCount: number
  isBook: boolean
  seeOfPlayed: number // SEE of the played move (mover POV, centipawns)
}

function classify(inp: ClassifyInput): MoveClass {
  if (inp.isBook) return 'book'
  if (inp.legalCount <= 1) return 'forced'

  const drop = Math.max(0, inp.winBefore - inp.winAfter)
  const isBest = inp.best !== null && inp.played === inp.best

  // Missed forced mate: the engine had a mate, the move played gives it up.
  if (inp.bestMate !== null && inp.bestMate > 0 && !(inp.afterMate !== null && inp.afterMate > 0)) {
    if (drop >= 8) return 'missed-win'
  }
  // Threw away a winning position (was ≥ winning, now no longer clearly winning).
  if (inp.winBefore >= 88 && inp.winAfter < 60 && !isBest) return 'missed-win'

  // Brilliant: a sound sacrifice that's still (near-)best and keeps you at least
  // equal. SEE < 0 means the move concedes material on the square it lands on.
  if (
    (isBest || drop <= 3) &&
    inp.seeOfPlayed <= -150 &&
    inp.winAfter >= 50 &&
    inp.winBefore < 99.5 // not a position that's already trivially won
  ) {
    return 'brilliant'
  }

  // Great: you found the only move that holds — the 2nd-best is far worse, the
  // position was genuinely critical, and the move itself conceded little.
  if (isBest && drop <= 6 && inp.secondCp !== null) {
    const gapWin = inp.winBefore - winPercent(inp.secondCp)
    if (gapWin >= 12 && inp.winBefore > 8 && inp.winBefore < 96) return 'great'
  }

  // Playing the engine's top move can never be worse than "Best", even if the
  // position deteriorates regardless of what you play — you can't do better.
  if (isBest) return 'best'

  if (drop <= 2) return 'excellent'
  if (drop <= 5) return 'good'
  if (drop <= 10) return 'inaccuracy'
  if (drop <= 20) return 'mistake'
  return 'blunder'
}

const GLYPH: Record<MoveClass, string> = {
  brilliant: '‼',
  great: '❗',
  best: '★',
  excellent: '✓',
  good: '·',
  book: '📖',
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
  'missed-win': '✗',
  forced: '⤷',
}

export function classGlyph(k: MoveClass): string {
  return GLYPH[k]
}

const LABEL: Record<MoveClass, string> = {
  brilliant: 'Brilliant',
  great: 'Great move',
  best: 'Best',
  excellent: 'Excellent',
  good: 'Good',
  book: 'Book',
  inaccuracy: 'Inaccuracy',
  mistake: 'Mistake',
  blunder: 'Blunder',
  'missed-win': 'Missed win',
  forced: 'Forced',
}

export function classLabel(k: MoveClass): string {
  return LABEL[k]
}

// ---- coach narration ---------------------------------------------------------

function coachText(
  klass: MoveClass,
  san: string,
  bestSan: string,
  cpBefore: number,
  cpAfter: number,
  bestMate: number | null,
  isBest: boolean,
): string {
  const evalBest = fmtEval(cpBefore, bestMate)
  const evalAfter = fmtEval(cpAfter, null)
  switch (klass) {
    case 'book':
      return `${san} is a book move — established opening theory.`
    case 'forced':
      return `${san} was forced — the only legal move.`
    case 'brilliant':
      return `${san} is brilliant! A sound sacrifice that's still the best move — material given up for a decisive edge.`
    case 'great':
      return `${san} is the only move that holds. Every alternative was clearly worse — well found.`
    case 'best':
      return `${san} is the engine's top choice (${evalBest}). Precise.`
    case 'excellent':
      return isBest
        ? `${san} keeps the evaluation (${evalAfter}).`
        : `${san} is excellent — as good as the engine's ${bestSan} (${evalBest}).`
    case 'good':
      return `${san} is fine. The engine slightly prefers ${bestSan} (${evalBest}).`
    case 'inaccuracy':
      return `Inaccuracy. ${san} drifts to ${evalAfter}; ${bestSan} (${evalBest}) was stronger.`
    case 'mistake':
      return `Mistake. ${san} lets the position slip to ${evalAfter} — ${bestSan} held ${evalBest}.`
    case 'blunder':
      return `Blunder. ${san} drops the evaluation to ${evalAfter}; ${bestSan} (${evalBest}) was much better.`
    case 'missed-win':
      return bestMate !== null && bestMate > 0
        ? `Missed mate. ${bestSan} forced mate in ${Math.abs(bestMate)} — instead ${san} (${evalAfter}).`
        : `Missed win. ${bestSan} (${evalBest}) kept a winning position; ${san} let it go (${evalAfter}).`
  }
}

// ---- the review --------------------------------------------------------------

export interface ReviewInput {
  startFen: string
  moves: Move[]
  nodes: NodeAnalysis[] // length moves.length + 1
}

const EMPTY_COUNTS = (): Record<MoveClass, number> => ({
  brilliant: 0,
  great: 0,
  best: 0,
  excellent: 0,
  good: 0,
  book: 0,
  inaccuracy: 0,
  mistake: 0,
  blunder: 0,
  'missed-win': 0,
  forced: 0,
})

export function reviewGame(input: ReviewInput): GameReview {
  const { startFen, moves, nodes } = input
  const g = new Game(startFen)
  const reviews: MoveReview[] = []

  // First pass: white-POV win% at every node, used for the volatility weighting.
  const winWhite: number[] = new Array(nodes.length).fill(50)
  {
    const gg = new Game(startFen)
    for (let i = 0; i < nodes.length; i++) {
      const cpStm = effCp(nodes[i])
      const cpWhite = gg.turn === WHITE ? cpStm : -cpStm
      winWhite[i] = winPercent(cpWhite)
      if (i < moves.length) gg.apply(moves[i])
    }
  }

  // Second pass: classify each move with full position context.
  for (let i = 0; i < moves.length; i++) {
    const fenBefore = g.fen()
    const mover = g.turn
    const legal = g.legalMoves()
    const san = moveToSan(g.pos, moves[i], legal)

    const nd = nodes[i]
    const next = nodes[i + 1]
    const cpBefore = effCp(nd) // mover POV
    const cpAfter = -effCp(next) // mover POV after the move
    const winBefore = winPercent(cpBefore)
    const winAfter = winPercent(cpAfter)
    const accuracy = moveAccuracy(winBefore, winAfter)
    const cpLoss = Math.max(0, Math.min(cpBefore, MATE_CP) - Math.min(cpAfter, MATE_CP))

    const best = nd.bestPv.length > 0 ? nd.bestPv[0] : null
    const isBest = best !== null && moves[i] === best
    const bestSan = best !== null ? moveToSan(g.pos, best, legal) : san
    const bestLineSan = nd.bestPv.length > 0 ? bestLineToSan(fenBefore, nd.bestPv) : ''

    // Book: was the played move one of the authored book moves here?
    const book = bookExplorer(fenBefore)
    const isBook = book.some((b) => b.move === moves[i])

    // After-mate, mover POV: next node's mate is from the opponent's POV, so a
    // mover-POV mate is the negation.
    const afterMate = next.mate !== null ? -next.mate : null

    const seeCp = see(g.pos, moves[i]) // mover-POV, centipawns
    const klass = classify({
      played: moves[i],
      best,
      winBefore,
      winAfter,
      cpBefore,
      cpAfter,
      bestMate: nd.mate,
      afterMate,
      secondCp: nd.secondMate !== null ? (nd.secondMate > 0 ? MATE_CP : -MATE_CP) : nd.secondScore,
      legalCount: legal.length,
      isBook,
      seeOfPlayed: seeCp,
    })

    reviews.push({
      index: i,
      san,
      color: mover,
      klass,
      cpBefore,
      cpAfter,
      winBefore,
      winAfter,
      accuracy,
      cpLoss,
      isBest,
      bestMove: best,
      bestSan,
      bestLineSan,
      coach: coachText(klass, san, bestSan, cpBefore, cpAfter, nd.mate, isBest),
    })

    g.apply(moves[i])
  }

  // Aggregate per player. Book and forced moves don't count toward accuracy/ACPL.
  const summarize = (color: Color): PlayerSummary => {
    const counts = EMPTY_COUNTS()
    const accs: number[] = []
    const plyIdx: number[] = []
    let acplSum = 0
    let acplN = 0
    for (const r of reviews) {
      if (r.color !== color) continue
      counts[r.klass]++
      if (r.klass === 'book' || r.klass === 'forced') continue
      accs.push(r.accuracy)
      plyIdx.push(r.index)
      acplSum += Math.min(r.cpLoss, 1000) // cap mate swings so one move can't dominate ACPL
      acplN++
    }
    const accuracy = aggregateAccuracy(accs, winWhite, plyIdx)
    const acpl = acplN > 0 ? acplSum / acplN : 0
    return { accuracy, acpl, estElo: estimateElo(acpl), moves: acplN, counts }
  }

  // Key moments: biggest win-% swings against the mover (blunders/mistakes/missed),
  // and brilliancies, most dramatic first.
  const keyMoments = reviews
    .map((r, idx) => ({ idx, r }))
    .filter(
      ({ r }) =>
        r.klass === 'blunder' ||
        r.klass === 'mistake' ||
        r.klass === 'missed-win' ||
        r.klass === 'brilliant' ||
        r.klass === 'great',
    )
    .sort((a, b) => {
      const sa = a.r.klass === 'brilliant' || a.r.klass === 'great' ? 1000 : a.r.winBefore - a.r.winAfter
      const sb = b.r.klass === 'brilliant' || b.r.klass === 'great' ? 1000 : b.r.winBefore - b.r.winAfter
      return sb - sa
    })
    .slice(0, 8)
    .map(({ idx }) => idx)

  return {
    moves: reviews,
    white: summarize(WHITE),
    black: summarize(BLACK),
    keyMoments,
  }
}

// Square-name helper exported for tests / callers that want UCI-ish strings.
export function moveUci(m: Move): string {
  const promo = movePromo(m)
  const p = promo ? 'nbrq'[promo - 2] ?? '' : ''
  return squareName(moveFrom(m)) + squareName(moveTo(m)) + p
}

// ---- self-test ---------------------------------------------------------------

export interface ReviewSelftest {
  ok: boolean
  checks: { name: string; ok: boolean; detail: string }[]
}

export function reviewSelftest(): ReviewSelftest {
  const checks: { name: string; ok: boolean; detail: string }[] = []
  const add = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail })

  // win% pins 50 at 0, is symmetric and monotone.
  add('win% at 0cp = 50', Math.abs(winPercent(0) - 50) < 1e-9, `${winPercent(0)}`)
  add(
    'win% symmetric',
    Math.abs(winPercent(300) + winPercent(-300) - 100) < 1e-6,
    `${winPercent(300).toFixed(3)} + ${winPercent(-300).toFixed(3)}`,
  )
  let mono = true
  for (let cp = -900; cp < 900; cp += 50) if (winPercent(cp) > winPercent(cp + 50)) mono = false
  add('win% monotone increasing', mono)

  // accuracy is 100 at no loss and strictly decreasing in the win-% drop.
  add('accuracy(no loss) = 100', Math.abs(moveAccuracy(50, 50) - 100) < 0.5, `${moveAccuracy(50, 50).toFixed(2)}`)
  add(
    'accuracy decreasing in drop',
    moveAccuracy(80, 80) > moveAccuracy(80, 60) && moveAccuracy(80, 60) > moveAccuracy(80, 30),
  )

  // A tiny constructed game: a best move, then a blunder that hangs a queen.
  // node0: white to move, best (eval +0.2), 2nd best far worse → "best".
  // node1: black to move, eval near 0 from black POV.
  // We feed a synthetic NodeAnalysis sequence on the real opening position.
  const g = new Game()
  const legal0 = g.legalMoves()
  const e4 = g.findMove(0x14, 0x34) // e2-e4 (0x88: e2=0x14, e4=0x34)
  const bestMove = e4 ?? legal0[0]
  // node analyses (mover POV)
  const nodes: NodeAnalysis[] = [
    { score: 25, mate: null, bestPv: [bestMove], secondScore: 18, secondMate: null },
    { score: -20, mate: null, bestPv: [], secondScore: null, secondMate: null },
  ]
  const rev = reviewGame({ startFen: g.fen(), moves: [bestMove], nodes })
  add('opening best move classified best/excellent', ['best', 'excellent', 'book'].includes(rev.moves[0].klass), rev.moves[0].klass)
  add('player accuracy in [0,100]', rev.white.accuracy >= 0 && rev.white.accuracy <= 100, rev.white.accuracy.toFixed(1))

  // Missed mate: mover had #1 but played a move that leaves no mate and drops a lot.
  // Build from a simple mate-in-1 FEN: white Qh5/Bc4 type isn't necessary — we test
  // the classifier directly via a synthetic node pair.
  const missed = classify({
    played: 999,
    best: 1000,
    winBefore: winPercent(MATE_CP),
    winAfter: winPercent(50),
    cpBefore: MATE_CP,
    cpAfter: 50,
    bestMate: 1,
    afterMate: null,
    secondCp: 500,
    legalCount: 20,
    isBook: false,
    seeOfPlayed: 0,
  })
  add('missed forced mate flagged', missed === 'missed-win', missed)

  // Blunder: a 400cp swing on a non-best move.
  const blunder = classify({
    played: 999,
    best: 1000,
    winBefore: winPercent(300),
    winAfter: winPercent(-300),
    cpBefore: 300,
    cpAfter: -300,
    bestMate: null,
    afterMate: null,
    secondCp: 280,
    legalCount: 20,
    isBook: false,
    seeOfPlayed: 0,
  })
  add('large swing flagged blunder', blunder === 'blunder', blunder)

  return { ok: checks.every((c) => c.ok), checks }
}
