// The Puzzle Trainer's tactical library and supporting logic.
//
// Every *mate* puzzle here was proven to be a **forced** mate by an in-repo
// retrograde solver (see JOURNAL.md → "Puzzle Trainer"): a candidate FEN is
// accepted only if the side to move can force checkmate within the stated number
// of moves against *every* defence. The solver also emits the canonical line
// (attacker plays the shortest mate, defender the most stubborn defence) and the
// full set of first moves that work — so the trainer can accept any sound key,
// not just one blessed move. The *win* puzzles are the engine-verified material
// shots from the Engine Lab's tactical suite (`tactics.ts`), reused here.
//
// `puzzleSelftest()` re-checks the shipped data at runtime: every move in every
// line is legal from the position before it, side-to-move parity is right, mate
// puzzles terminate in checkmate, and the canonical key is among the accepted
// keys. It is cheap (no search) and is surfaced in the trainer's footer.

import { Game } from './index'
import { moveFrom, moveTo, movePromo, squareName, parseSquare } from './board'

export type Theme =
  | 'mateIn1'
  | 'mateIn2'
  | 'mateIn3'
  | 'mateIn4'
  | 'backRank'
  | 'smothered'
  | 'sacrifice'
  | 'basicMate'
  | 'fork'
  | 'pin'
  | 'trappedPiece'
  | 'promotion'
  | 'endgame'
  | 'material'

export interface ThemeInfo {
  key: Theme
  label: string
  blurb: string
}

export const THEMES: ThemeInfo[] = [
  { key: 'mateIn1', label: 'Mate in 1', blurb: 'One move ends the game.' },
  { key: 'mateIn2', label: 'Mate in 2', blurb: 'A forced two-move checkmate.' },
  { key: 'mateIn3', label: 'Mate in 3', blurb: 'A deeper forced mate.' },
  { key: 'mateIn4', label: 'Mate in 4', blurb: 'A long forced mate — calculate to the end.' },
  { key: 'backRank', label: 'Back rank', blurb: "The king is trapped on its first rank." },
  { key: 'smothered', label: 'Smothered', blurb: 'The king is hemmed in by its own men.' },
  { key: 'sacrifice', label: 'Sacrifice', blurb: 'Give up material to force the finish.' },
  { key: 'basicMate', label: 'Basic mates', blurb: 'King-and-piece mating technique.' },
  { key: 'fork', label: 'Fork', blurb: 'One piece attacks two.' },
  { key: 'pin', label: 'Pin', blurb: 'A piece is stuck shielding a bigger one.' },
  { key: 'trappedPiece', label: 'Trapped piece', blurb: 'A piece has no safe square.' },
  { key: 'promotion', label: 'Promotion', blurb: 'A pawn is about to queen.' },
  { key: 'endgame', label: 'Endgame', blurb: 'Few pieces left on the board.' },
  { key: 'material', label: 'Win material', blurb: 'A tactic that wins decisive material.' },
]

export type PuzzleKind = 'mate' | 'win'

export interface Puzzle {
  id: string
  title: string
  fen: string
  kind: PuzzleKind
  // Mate-in-N (for 'mate'); for 'win' it's 0 (a single best move).
  mateIn: number
  // Canonical solution, alternating plies starting with the side to move
  // (solver, defender, solver, ...). UCI moves.
  line: string[]
  // Every accepted *first* move (all force the same mate / all are the winning
  // shot). The trainer accepts any of these for ply 0; deeper solver plies use
  // the canonical `line` move.
  keys: string[]
  themes: Theme[]
  rating: number
  motif: string
  source?: string
}

// --- The library. Ordered roughly by rating; the trainer can filter/sort. ---

export const PUZZLES: Puzzle[] = [
  // ---- Mate in 1 ----
  {
    id: 'm1-backrank',
    title: 'Back-rank mate',
    fen: '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1',
    kind: 'mate',
    mateIn: 1,
    line: ['d1d8'],
    keys: ['d1d8'],
    themes: ['mateIn1', 'backRank'],
    rating: 600,
    motif: 'The king is walled in by its own pawns — Rd8 is mate.',
  },
  {
    id: 'm1-rook-box',
    title: 'Box him in',
    fen: '6k1/8/6K1/8/8/8/8/R7 w - - 0 1',
    kind: 'mate',
    mateIn: 1,
    line: ['a1a8'],
    keys: ['a1a8'],
    themes: ['mateIn1', 'basicMate', 'endgame'],
    rating: 680,
    motif: 'The white king covers every escape on the 7th — Ra8 mates.',
  },
  {
    id: 'm1-rook-pawn',
    title: 'Rook and pawn',
    fen: '6k1/6P1/6K1/8/8/8/8/7R w - - 0 1',
    kind: 'mate',
    mateIn: 1,
    line: ['h1h8'],
    keys: ['h1h8'],
    themes: ['mateIn1', 'basicMate', 'endgame'],
    rating: 720,
    motif: 'The g7-pawn and king seal the dark squares — Rh8 is mate.',
  },
  {
    id: 'm1-queen-edge',
    title: 'Queen to the edge',
    fen: '4k3/8/4K3/8/2Q5/8/8/8 w - - 0 1',
    kind: 'mate',
    mateIn: 1,
    line: ['c4c8'],
    keys: ['c4c8'],
    themes: ['mateIn1', 'basicMate', 'endgame'],
    rating: 760,
    motif: 'With the kings in opposition, Qc8 is mate on the back rank.',
  },
  {
    id: 'm1-queen-corner',
    title: 'Cornered king',
    fen: '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1',
    kind: 'mate',
    mateIn: 1,
    line: ['f7e8'],
    keys: ['f7e8', 'f7g7', 'f7h7', 'f7f8'],
    themes: ['mateIn1', 'basicMate', 'endgame'],
    rating: 800,
    motif: 'Four different queen moves mate — the king has no flight square.',
  },
  {
    id: 'm1-smothered',
    title: 'Smothered mate',
    fen: 'r5rk/6pp/8/6N1/8/2Q5/8/6K1 w - - 0 1',
    kind: 'mate',
    mateIn: 1,
    line: ['g5f7'],
    keys: ['g5f7'],
    themes: ['mateIn1', 'smothered'],
    rating: 1120,
    motif: 'The king is smothered by its own rook and pawns — Nf7 is mate.',
  },

  // ---- Mate in 2 ----
  {
    id: 'm2-ladder',
    title: 'Two-rook ladder',
    fen: '7k/8/8/8/8/8/1R6/R6K w - - 0 1',
    kind: 'mate',
    mateIn: 2,
    line: ['a1g1', 'h8h7', 'b2h2'],
    keys: ['a1g1', 'a1a7', 'b2b7'],
    themes: ['mateIn2', 'basicMate', 'endgame'],
    rating: 900,
    motif: 'One rook cuts the king off, the other drives it to the edge and mates.',
  },
  {
    id: 'm2-oppose',
    title: 'King and rook',
    fen: '7k/8/5K2/8/8/8/8/R7 w - - 0 1',
    kind: 'mate',
    mateIn: 2,
    line: ['f6g6', 'h8g8', 'a1a8'],
    keys: ['f6g6', 'f6f7'],
    themes: ['mateIn2', 'basicMate', 'endgame'],
    rating: 980,
    motif: 'Take the opposition with the king, then Ra8 delivers mate.',
  },
  {
    id: 'm2-queen-corner',
    title: 'Walk the queen in',
    fen: 'k7/8/2K5/2Q5/8/8/8/8 w - - 0 1',
    kind: 'mate',
    mateIn: 2,
    line: ['c5b4', 'a8a7', 'b4b7'],
    keys: ['c5b4', 'c5e7', 'c5b5', 'c6b6'],
    themes: ['mateIn2', 'basicMate', 'endgame'],
    rating: 1080,
    motif: 'Cut the king to the edge with a waiting move, then Qb7 mates.',
  },
  {
    id: 'm2-opera',
    title: 'The Opera Mate',
    fen: '4kb1r/p2n1ppp/4q3/4p1B1/4P3/1Q6/PPP2PPP/2KR4 w k - 0 1',
    kind: 'mate',
    mateIn: 2,
    line: ['b3b8', 'd7b8', 'd1d8'],
    keys: ['b3b8'],
    themes: ['mateIn2', 'sacrifice', 'backRank'],
    rating: 1500,
    motif: "Morphy's finish: 1.Qb8+! Nxb8 2.Rd8# — a queen sacrifice for the back rank.",
    source: 'Morphy–Duke of Brunswick & Count Isouard, Paris 1858',
  },
  {
    id: 'm2-wac003',
    title: 'Open the h-file',
    fen: 'r1bq2rk/pp3pbp/2p1p1pQ/7P/3P4/2PB1N2/PP3PPR/2KR4 w - - 0 1',
    kind: 'mate',
    mateIn: 2,
    line: ['h6h7', 'h8h7', 'h5g6'],
    keys: ['h6h7'],
    themes: ['mateIn2', 'sacrifice'],
    rating: 1650,
    motif: '1.Qxh7+! Kxh7 2.hxg6# — the sacrifice rips open the h-file.',
    source: 'Win at Chess #3',
  },
  {
    id: 'm2-wac001',
    title: 'Double threat',
    fen: '2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1',
    kind: 'mate',
    mateIn: 2,
    line: ['g3g6', 'b6a4', 'g6h7'],
    keys: ['g3g6'],
    themes: ['mateIn2', 'sacrifice'],
    rating: 1750,
    motif: '1.Qg6!! threatens Qxg7# and Qxh7# at once — Black cannot stop both.',
    source: 'Win at Chess #1',
  },

  // ---- Mate in 3 ----
  {
    id: 'm3-knight-hunt',
    title: 'The knight leads the hunt',
    fen: '1k5r/pP3ppp/3p2b1/1BN1n3/1Q2P3/P1B5/KP3P1P/7q w - - 1 0',
    kind: 'mate',
    mateIn: 3,
    line: ['c5a6', 'b8b7', 'b5a4', 'b7a6', 'b4b5'],
    keys: ['c5a6'],
    themes: ['mateIn3', 'sacrifice'],
    rating: 1950,
    motif: '1.Na6+! drags the king into a forced mate in three.',
  },

  // ---- Mate in 4 ----
  {
    id: 'm4-wac006',
    title: 'Calculate to the end',
    fen: 'r2rb1k1/pp1q1p1p/2n1p1p1/2bp4/5P2/PP1BPR1Q/1BPN2PP/R5K1 w - - 0 1',
    kind: 'mate',
    mateIn: 4,
    line: ['h3h7', 'g8f8', 'b2f6', 'c5e3', 'g1f1', 'e3d2', 'h7g7'],
    keys: ['h3h7'],
    themes: ['mateIn4', 'sacrifice'],
    rating: 2050,
    motif: '1.Qxh7+! Kf8 2.Bf6! (the quiet move) Bxe3+ 3.Kf1 Bxd2 4.Qxg7# — a forced mate in four.',
    source: 'Win at Chess #6',
  },

  // ---- Win material (engine-verified single best move) ----
  {
    id: 'w-loose-queen',
    title: 'Snap off the queen',
    fen: 'r5k1/pp3ppp/4p3/3pP3/3P4/P1q2Q2/5PPP/R5K1 w - - 0 1',
    kind: 'win',
    mateIn: 0,
    line: ['f3c3'],
    keys: ['f3c3'],
    themes: ['material'],
    rating: 1000,
    motif: 'Qxc3 — the black queen was undefended.',
  },
  {
    id: 'w-knight-fork',
    title: 'Knight wins material',
    fen: '5k2/1p3ppp/p1q5/2Pn4/8/2Q2N2/P4PPP/3R2K1 b - - 0 1',
    kind: 'win',
    mateIn: 0,
    line: ['d5c3'],
    keys: ['d5c3'],
    themes: ['material', 'fork'],
    rating: 1250,
    motif: 'Nxc3 wins the queen for knight and rook.',
    source: 'Win at Chess #24',
  },
  {
    id: 'w-bishop-grab',
    title: 'Win a piece',
    fen: 'r1b1kb1r/3q1ppp/pBp1pn2/8/Np3P2/5B2/PPP3PP/R2Q1RK1 w kq - 0 1',
    kind: 'win',
    mateIn: 0,
    line: ['f3c6'],
    keys: ['f3c6'],
    themes: ['material'],
    rating: 1300,
    motif: 'Bxc6 nets a clean piece.',
    source: 'Win at Chess #14',
  },
  {
    id: 'w-bxd5',
    title: 'The in-between capture',
    fen: 'r3k2r/pb3pp1/5q1p/1p1bp3/8/1B3N2/PP3PPP/2RQR1K1 w kq - 0 1',
    kind: 'win',
    mateIn: 0,
    line: ['b3d5'],
    keys: ['b3d5'],
    themes: ['material'],
    rating: 1320,
    motif: 'Bxd5 wins material in the tactical melee.',
    source: 'Win at Chess #30',
  },
  {
    id: 'w-trap-queen',
    title: 'Trap the queen',
    fen: '5rk1/1ppb3p/p1pb4/6q1/3P1p1r/2P1R2P/PP1BQ1P1/5RKN w - - 0 1',
    kind: 'win',
    mateIn: 0,
    line: ['e3g3'],
    keys: ['e3g3'],
    themes: ['trappedPiece'],
    rating: 1420,
    motif: 'Rg3 attacks the queen, which has no safe retreat.',
    source: 'Win at Chess #5',
  },
  {
    id: 'w-black-rxb2',
    title: 'The passed pawns roll',
    fen: '8/7p/5k2/5p2/p1p2P2/Pr1pPK2/1P1R3P/8 b - - 0 1',
    kind: 'win',
    mateIn: 0,
    line: ['b3b2'],
    keys: ['b3b2'],
    themes: ['material', 'endgame'],
    rating: 1480,
    motif: 'Rxb2! — after Rxb2 the connected passed pawns are unstoppable.',
    source: 'Win at Chess #2',
  },
  {
    id: 'w-black-qxf3',
    title: 'Demolish the defence',
    fen: '4k1r1/2p3r1/1pR1p3/3pP2p/3P2qP/P4N2/1PQ4P/5RK1 b - - 0 1',
    kind: 'win',
    mateIn: 0,
    line: ['g4f3'],
    keys: ['g4f3'],
    themes: ['material', 'sacrifice'],
    rating: 1620,
    motif: 'Qxf3! rips open the king — 2.gxf3 Rxg1+ or 2.Rxf3 Rxg... wins.',
    source: 'Win at Chess #11',
  },
  {
    id: 'w-qxf8-fork',
    title: 'Sacrifice into a fork',
    fen: '5rk1/pp4p1/2n1p2p/2Npq3/2p5/6P1/P3P1BP/R4Q1K w - - 0 1',
    kind: 'win',
    mateIn: 0,
    line: ['f1f8'],
    keys: ['f1f8'],
    themes: ['material', 'fork', 'sacrifice'],
    rating: 1760,
    motif: 'Qxf8+! Kxf8 2.Nxe6+ forks king and queen, winning the queen.',
    source: 'Win at Chess #22',
  },
  {
    id: 'w-clear-promo',
    title: 'Clear the queening square',
    fen: 'R7/P4k2/8/8/8/8/r7/6K1 w - - 0 1',
    kind: 'win',
    mateIn: 0,
    line: ['a8h8'],
    keys: ['a8h8'],
    themes: ['promotion', 'endgame'],
    rating: 1460,
    motif: 'Rh8! vacates a8 so the pawn promotes next move.',
  },
]

// ---------------------------------------------------------------------------
// UCI <-> engine move plumbing
// ---------------------------------------------------------------------------

const PROMO_FROM_CHAR: Record<string, number> = { n: 2, b: 3, r: 4, q: 5 }

export function uciFrom(uci: string): number {
  return parseSquare(uci.slice(0, 2))
}
export function uciTo(uci: string): number {
  return parseSquare(uci.slice(2, 4))
}
export function uciPromo(uci: string): number {
  const c = uci.slice(4, 5).toLowerCase()
  return c ? (PROMO_FROM_CHAR[c] ?? 0) : 0
}

// Resolve a UCI string to a concrete legal Move on `game` (or null). Handles the
// engine's king-captures-rook castling encoding via Game.findMove.
export function uciToMove(game: Game, uci: string): number | null {
  return game.findMove(uciFrom(uci), uciTo(uci), uciPromo(uci))
}

// The full UCI of an engine move int (matches the keys/line encoding).
export function moveToUci(m: number): string {
  const p = movePromo(m)
  const c = p ? 'nbrq'[p - 2] : ''
  return squareName(moveFrom(m)) + squareName(moveTo(m)) + c
}

export function sideToMove(fen: string): 'w' | 'b' {
  return fen.split(/\s+/)[1] === 'b' ? 'b' : 'w'
}

// ---------------------------------------------------------------------------
// Glicko-lite rating for the solver and per-puzzle difficulty pairing.
// A compact, well-behaved rating system: expectation from the rating gap, an
// update scaled by the current deviation (RD), and a slow RD floor so a long
// streak of easy/hard puzzles still moves the needle.
// ---------------------------------------------------------------------------

export interface Rating {
  rating: number
  rd: number // rating deviation (uncertainty)
}

export const DEFAULT_RATING: Rating = { rating: 1000, rd: 350 }
const RD_MIN = 60
const Q = Math.log(10) / 400

function gFactor(rd: number): number {
  return 1 / Math.sqrt(1 + (3 * Q * Q * rd * rd) / (Math.PI * Math.PI))
}
export function expectedScore(player: Rating, puzzleRating: number): number {
  const g = gFactor(player.rd)
  return 1 / (1 + Math.pow(10, (-g * (player.rating - puzzleRating)) / 400))
}

// Update the player's rating after a single puzzle (score 1 = solved, 0 = failed).
export function updateRating(player: Rating, puzzleRating: number, score: number): Rating {
  const g = gFactor(player.rd)
  const e = expectedScore(player, puzzleRating)
  const dSq = 1 / (Q * Q * g * g * e * (1 - e))
  const denom = 1 / (player.rd * player.rd) + 1 / dSq
  const newRd = Math.max(RD_MIN, Math.sqrt(1 / denom))
  const newRating = player.rating + Q * newRd * newRd * g * (score - e)
  return {
    rating: Math.round(Math.max(100, Math.min(3000, newRating))),
    rd: Math.round(newRd),
  }
}

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

export function puzzlesWithTheme(theme: Theme | 'all'): Puzzle[] {
  if (theme === 'all') return PUZZLES
  return PUZZLES.filter((p) => p.themes.includes(theme))
}

// A deterministic daily puzzle: hash the ISO date to an index. Pure function of
// the date string, so everyone gets the same puzzle on a given day.
export function dailyPuzzle(isoDate: string): Puzzle {
  let h = 2166136261
  for (let i = 0; i < isoDate.length; i++) {
    h ^= isoDate.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const idx = Math.abs(h) % PUZZLES.length
  return PUZZLES[idx]
}

// Pick the puzzle whose rating is closest to the target, excluding ids in `seen`
// (so a session doesn't repeat). Falls back to the closest overall if all seen.
export function pickByRating(target: number, pool: Puzzle[], seen: Set<string>): Puzzle | null {
  if (pool.length === 0) return null
  const fresh = pool.filter((p) => !seen.has(p.id))
  const from = fresh.length > 0 ? fresh : pool
  let best = from[0]
  let bestD = Math.abs(best.rating - target)
  for (const p of from) {
    const d = Math.abs(p.rating - target)
    if (d < bestD) {
      best = p
      bestD = d
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Runtime self-verification of the shipped library (no search — cheap).
// ---------------------------------------------------------------------------

export interface PuzzleSelftest {
  ok: boolean
  total: number
  failures: { id: string; reason: string }[]
}

export function puzzleSelftest(): PuzzleSelftest {
  const failures: { id: string; reason: string }[] = []
  for (const p of PUZZLES) {
    try {
      const g = new Game(p.fen)
      // side-to-move sanity
      const stm = sideToMove(p.fen)
      if ((g.turn === 0 ? 'w' : 'b') !== stm) {
        failures.push({ id: p.id, reason: 'side-to-move mismatch' })
        continue
      }
      // canonical key must be an accepted key, and a legal first move
      if (!p.keys.includes(p.line[0])) {
        failures.push({ id: p.id, reason: 'canonical line[0] not in keys' })
        continue
      }
      let bad = false
      for (const k of p.keys) {
        if (uciToMove(g, k) === null) {
          failures.push({ id: p.id, reason: `illegal key ${k}` })
          bad = true
          break
        }
      }
      if (bad) continue
      // replay the whole canonical line; every move must be legal in turn
      for (let i = 0; i < p.line.length; i++) {
        const m = uciToMove(g, p.line[i])
        if (m === null) {
          failures.push({ id: p.id, reason: `illegal line move ${p.line[i]} at ply ${i}` })
          bad = true
          break
        }
        g.apply(m)
      }
      if (bad) continue
      // mate puzzles must end in checkmate; their line length must equal 2N-1
      if (p.kind === 'mate') {
        if (g.result() !== 'checkmate') {
          failures.push({ id: p.id, reason: 'line does not end in checkmate' })
          continue
        }
        if (p.line.length !== 2 * p.mateIn - 1) {
          failures.push({ id: p.id, reason: `line length ${p.line.length} != 2*${p.mateIn}-1` })
          continue
        }
      }
    } catch (e) {
      failures.push({ id: p.id, reason: 'threw: ' + (e as Error).message })
    }
  }
  return { ok: failures.length === 0, total: PUZZLES.length, failures }
}
