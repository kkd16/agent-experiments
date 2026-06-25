// endgames.ts — map a position's material to a generalized-tablebase config, and
// warm the relevant cached table before the engine searches it.
//
// A built table lives in one Web Worker's memory. The Lab (its own worker) builds
// and *persists* a table to IndexedDB; the play worker then re-hydrates it from the
// cache on demand here, so once you have solved an ending in the Lab the engine
// plays it perfectly forever after — without a multi-second rebuild mid-move.

import { KNIGHT, BISHOP, ROOK, QUEEN } from './board'
import { GTB_CONFIGS, tryLoadGtbFromCache } from './gtb'
import { tryLoadKbnkFromCache } from './kbnk'

export interface EndgameMatch {
  id: string // generic config id, e.g. 'KBBvK'
  strongIsWhite: boolean
  pieceTypes: number[] // strong pieces, in the config's slot order
}

// type letter → engine piece type
const TYPE_OF: Record<string, number> = { N: KNIGHT, B: BISHOP, R: ROOK, Q: QUEEN }

// signature (sorted strong piece-type letters) → config id and slot order
const BY_SIGNATURE = new Map<string, { id: string; types: number[] }>()
for (const c of GTB_CONFIGS) {
  const sig = c.white
    .map((t) => Object.keys(TYPE_OF).find((k) => TYPE_OF[k] === t)!)
    .slice()
    .sort()
    .join('')
  BY_SIGNATURE.set(sig, { id: c.id, types: c.white })
}

// Parse a FEN's placement into per-colour non-king piece lists.
function material(fen: string): { white: string[]; black: string[]; pawns: boolean } {
  const placement = fen.split(/\s+/)[0]
  const white: string[] = []
  const black: string[] = []
  let pawns = false
  for (const ch of placement) {
    if (ch === '/' || (ch >= '1' && ch <= '8')) continue
    if (ch === 'P' || ch === 'p') pawns = true
    else if (ch === 'N' || ch === 'B' || ch === 'R' || ch === 'Q') white.push(ch)
    else if (ch === 'n' || ch === 'b' || ch === 'r' || ch === 'q') black.push(ch.toUpperCase())
  }
  return { white, black, pawns }
}

// Identify a supported "K+pieces vs lone K" ending, or null. The strong side has
// 1–2 pieces from {N,B,R,Q}; the defender is a bare king; no pawns on the board.
export function endgameMatch(fen: string): EndgameMatch | null {
  const { white, black, pawns } = material(fen)
  if (pawns) return null
  let strongIsWhite: boolean
  let pieces: string[]
  if (black.length === 0 && white.length >= 1 && white.length <= 2) {
    strongIsWhite = true
    pieces = white
  } else if (white.length === 0 && black.length >= 1 && black.length <= 2) {
    strongIsWhite = false
    pieces = black
  } else {
    return null
  }
  const sig = pieces.slice().sort().join('')
  const hit = BY_SIGNATURE.get(sig)
  if (!hit) return null
  return { id: hit.id, strongIsWhite, pieceTypes: hit.types }
}

// Warm any cached tablebase that applies to `fen`. Best-effort and cheap: a no-op
// when the position isn't a supported ending or nothing is cached.
export async function warmTablebasesFor(fen: string): Promise<void> {
  const m = endgameMatch(fen)
  if (!m) return
  if (m.id === 'KBNvK') {
    // KBN-vs-K is served by the bespoke (already-verified) kbnk table.
    await tryLoadKbnkFromCache()
    return
  }
  await tryLoadGtbFromCache(m.id)
}
