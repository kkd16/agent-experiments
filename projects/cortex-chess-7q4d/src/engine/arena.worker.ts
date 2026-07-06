// The Arena Web Worker. Playing hundreds of games would freeze the UI thread, so
// the whole tournament runs here and streams progress back. Two jobs:
//
//   • 'sprt'       — an A-vs-B match in colour-reversed pairs, stopping the moment
//                     the SPRT reaches a verdict (or the pair cap is hit).
//   • 'tournament' — an N-engine round-robin, streaming the crosstable, the
//                     Bradley–Terry ratings, and each game as it finishes.
//
// A cooperative `cancel` is honoured between games: the run loop yields a macrotask
// after every game so a queued 'cancel' message can flip the flag.

import { deserializeNnue, type NnueBlob, type NnueWeights } from './nnue'
import {
  makeBrain,
  playGame,
  emptyTally,
  addPair,
  sprt,
  estimate,
  emptyCrossTable,
  recordResult,
  fitRatings,
  ADJUDICATION_DEFAULTS,
  type EngineSpec,
  type SprtParams,
  type AdjudicationOptions,
  type MatchTally,
  type CrossTable,
  type Standing,
  type GameReason,
} from './arena'

// ---- Message protocol ------------------------------------------------------

export interface SprtRequest {
  type: 'sprt'
  a: EngineSpec
  b: EngineSpec
  openings: { name: string; fen: string }[]
  params: SprtParams
  adj?: Partial<AdjudicationOptions>
  maxPairs: number
  net?: NnueBlob | null
}

export interface TournamentRequest {
  type: 'tournament'
  engines: EngineSpec[]
  openings: { name: string; fen: string }[]
  gamesPerPairing: number // games per ordered engine pair (rounded to even for colour balance)
  adj?: Partial<AdjudicationOptions>
  net?: NnueBlob | null
}

export interface CancelRequest {
  type: 'cancel'
}

export type ArenaRequest = SprtRequest | TournamentRequest | CancelRequest

export interface GameLine {
  opening: string
  aWhite: boolean
  result: 'a' | 'b' | 'draw'
  reason: GameReason
  plies: number
}

export interface OpeningTally {
  name: string
  points: number // A's points over the games from this opening
  games: number
}

export interface SprtProgress {
  type: 'sprt-progress'
  tally: MatchTally
  llr: number
  lower: number
  upper: number
  verdict: string
  elo: number
  eloLow: number
  eloHigh: number
  los: number
  normAdvantage: number
  drawRate: number
  pairsDone: number
  maxPairs: number
  last: GameLine[]
  llrTrack: number[]
  /** Estimated pairs still needed to decide, from the current LLR drift. */
  expectedRemaining: number
  /** A's score broken down by opening. */
  byOpening: OpeningTally[]
  /** Full multi-game PGN of the match — populated only on the final message. */
  pgn: string
  done: boolean
}

export interface TourProgress {
  type: 'tour-progress'
  cells: { wins: number; draws: number; losses: number }[][]
  labels: string[]
  standings: Standing[]
  gamesDone: number
  gamesTotal: number
  last: GameLine | null
  done: boolean
}

export type ArenaOut = SprtProgress | TourProgress

// ---------------------------------------------------------------------------

let cancelled = false
const yieldMacro = () => new Promise<void>((r) => setTimeout(r, 0))

function loadNet(blob: NnueBlob | null | undefined): NnueWeights | null {
  if (!blob) return null
  try {
    return deserializeNnue(blob)
  } catch {
    return null
  }
}

function reasonToDot(white: number, aWhite: boolean): 'a' | 'b' | 'draw' {
  if (white === 0.5) return 'draw'
  const whiteWon = white === 1
  // A won iff (A was white and white won) or (A was black and black won).
  return whiteWon === aWhite ? 'a' : 'b'
}

const resultStr = (white: number): string => (white === 1 ? '1-0' : white === 0 ? '0-1' : '1/2-1/2')

// Assemble a single valid PGN game from a start FEN + SAN movetext, honouring the
// opening's side-to-move and full-move number so the numbering is correct.
function buildGamePgn(startFen: string, san: string, whiteName: string, blackName: string, white: number, opening: string): string {
  const fields = startFen.split(/\s+/)
  const blackToStart = fields[1] === 'b'
  let moveNo = parseInt(fields[5] || '1', 10)
  if (!Number.isFinite(moveNo) || moveNo < 1) moveNo = 1
  const moves = san ? san.split(' ').filter(Boolean) : []
  const res = resultStr(white)
  const parts: string[] = []
  let i = 0
  if (blackToStart && moves.length > 0) {
    parts.push(`${moveNo}...${moves[0]}`)
    i = 1
    moveNo++
  }
  for (; i < moves.length; i += 2) {
    if (moves[i + 1] !== undefined) parts.push(`${moveNo}.${moves[i]} ${moves[i + 1]}`)
    else parts.push(`${moveNo}.${moves[i]}`)
    moveNo++
  }
  const header =
    `[Event "Cortex Arena"]\n[Site "The Arena"]\n[White "${whiteName}"]\n[Black "${blackName}"]\n` +
    `[Result "${res}"]\n[Opening "${opening}"]\n[SetUp "1"]\n[FEN "${startFen}"]\n`
  return `${header}\n${parts.join(' ')} ${res}\n`
}

// ---- SPRT match ------------------------------------------------------------

async function runSprt(req: SprtRequest): Promise<void> {
  const net = loadNet(req.net)
  const adj = { ...ADJUDICATION_DEFAULTS, ...(req.adj ?? {}) }
  const brainA = makeBrain(req.a, net)
  const brainB = makeBrain(req.b, net)
  const tally = emptyTally()
  const llrTrack: number[] = []
  let pairsDone = 0
  const openingMap = new Map<string, OpeningTally>()
  const pgnGames: string[] = []
  const PGN_CAP = 400 // bound the payload sent on completion

  for (let pair = 0; pair < req.maxPairs && !cancelled; pair++) {
    const opening = req.openings[pair % req.openings.length]
    // Game 1: A = White. Game 2: A = Black (colours reversed, same opening).
    const g1 = playGame(brainA, brainB, opening.fen, adj, pair * 2)
    const g2 = playGame(brainB, brainA, opening.fen, adj, pair * 2 + 1)
    // Convert to A's score in each game.
    const aScore1 = g1.white // A was White
    const aScore2 = 1 - g2.white // A was Black
    addPair(tally, aScore1, aScore2)
    pairsDone++

    // Per-opening breakdown (A's points).
    const ot = openingMap.get(opening.name) ?? { name: opening.name, points: 0, games: 0 }
    ot.points += aScore1 + aScore2
    ot.games += 2
    openingMap.set(opening.name, ot)

    // Accumulate PGN (A as White in game 1, B as White in game 2).
    if (pgnGames.length < PGN_CAP) pgnGames.push(buildGamePgn(opening.fen, g1.san, req.a.label, req.b.label, g1.white, opening.name))
    if (pgnGames.length < PGN_CAP) pgnGames.push(buildGamePgn(opening.fen, g2.san, req.b.label, req.a.label, g2.white, opening.name))

    const s = sprt(tally, req.params)
    const est = estimate(tally)
    llrTrack.push(s.llr)

    const last: GameLine[] = [
      { opening: opening.name, aWhite: true, result: reasonToDot(g1.white, true), reason: g1.reason, plies: g1.plies },
      { opening: opening.name, aWhite: false, result: reasonToDot(g2.white, false), reason: g2.reason, plies: g2.plies },
    ]

    const done = s.verdict !== 'continue' || pair + 1 >= req.maxPairs || cancelled
    const msg: SprtProgress = {
      type: 'sprt-progress',
      tally: { ...tally, penta: [...tally.penta] as MatchTally['penta'] },
      llr: s.llr,
      lower: s.lower,
      upper: s.upper,
      verdict: s.verdict,
      elo: est.elo,
      eloLow: est.eloLow,
      eloHigh: est.eloHigh,
      los: est.los,
      normAdvantage: est.normAdvantage,
      drawRate: est.drawRate,
      pairsDone,
      maxPairs: req.maxPairs,
      last,
      llrTrack: llrTrack.slice(),
      expectedRemaining: s.expectedRemaining,
      byOpening: [...openingMap.values()],
      pgn: done ? pgnGames.join('\n') : '',
      done,
    }
    ;(self as unknown as Worker).postMessage(msg)

    if (s.verdict !== 'continue') break
    await yieldMacro()
  }
}

// ---- Round-robin tournament ------------------------------------------------

async function runTournament(req: TournamentRequest): Promise<void> {
  const net = loadNet(req.net)
  const adj = { ...ADJUDICATION_DEFAULTS, ...(req.adj ?? {}) }
  const specs = req.engines
  const labels = specs.map((s) => s.label)
  const brains = specs.map((s) => makeBrain(s, net))
  const ct: CrossTable = emptyCrossTable(labels)

  // Every unordered pair plays `pairs` colour-reversed 2-game mini-matches.
  const perPairing = Math.max(2, req.gamesPerPairing - (req.gamesPerPairing % 2))
  const matchups: [number, number][] = []
  for (let i = 0; i < specs.length; i++)
    for (let j = i + 1; j < specs.length; j++) matchups.push([i, j])
  const gamesTotal = matchups.length * perPairing
  let gamesDone = 0
  let seed = 1

  for (const [i, j] of matchups) {
    for (let g = 0; g < perPairing && !cancelled; g += 2) {
      const opening = req.openings[(seed >> 1) % req.openings.length]
      // Game A: i is White. Game B: j is White.
      const gi = playGame(brains[i], brains[j], opening.fen, adj, seed++)
      const gj = playGame(brains[j], brains[i], opening.fen, adj, seed++)
      recordResult(ct, i, j, gi.white) // i as White → i's score = white score
      recordResult(ct, i, j, 1 - gj.white) // j as White → i's score = 1 − white score
      gamesDone += 2

      const standings = fitRatings(ct)
      const last: GameLine = {
        opening: opening.name,
        aWhite: true,
        result: gi.white === 0.5 ? 'draw' : gi.white === 1 ? 'a' : 'b',
        reason: gi.reason,
        plies: gi.plies,
      }
      const msg: TourProgress = {
        type: 'tour-progress',
        cells: ct.cells.map((row) => row.map((c) => ({ ...c }))),
        labels: labels.slice(),
        standings,
        gamesDone,
        gamesTotal,
        last,
        done: gamesDone >= gamesTotal || cancelled,
      }
      ;(self as unknown as Worker).postMessage(msg)
      await yieldMacro()
    }
    if (cancelled) break
  }

  // Ensure a terminal message even if cancelled mid-run.
  const standings = fitRatings(ct)
  ;(self as unknown as Worker).postMessage({
    type: 'tour-progress',
    cells: ct.cells.map((row) => row.map((c) => ({ ...c }))),
    labels: labels.slice(),
    standings,
    gamesDone,
    gamesTotal,
    last: null,
    done: true,
  } satisfies TourProgress)
}

// ---- Dispatch --------------------------------------------------------------

self.onmessage = (e: MessageEvent<ArenaRequest>) => {
  const req = e.data
  if (req.type === 'cancel') {
    cancelled = true
    return
  }
  cancelled = false
  if (req.type === 'sprt') void runSprt(req)
  else if (req.type === 'tournament') void runTournament(req)
}
