// PGN export of the played game. Reads the move history (already stored as SAN)
// and the game result, and emits a standards-compliant PGN with the Seven Tag
// Roster — including a SetUp/FEN tag when the game didn't start from the initial
// position — so the moves can be loaded into any chess viewer or database.

import { type Game, type GameResult, WHITE, START_FEN } from './index'

export interface PgnMeta {
  white: string
  black: string
  date: string // YYYY.MM.DD
  event?: string
  site?: string
  round?: string
}

function resultToken(result: GameResult, turn: number): string {
  if (result === 'checkmate') return turn === WHITE ? '0-1' : '1-0' // side to move is mated
  if (result === 'playing') return '*'
  return '1/2-1/2'
}

export function buildPgn(game: Game, meta: PgnMeta): string {
  const result = game.result()
  const token = resultToken(result, game.turn)

  const startFen = game.history.length > 0 ? game.history[0].fenBefore : game.fen()
  const fromStart = startFen === START_FEN

  const headers: [string, string][] = [
    ['Event', meta.event ?? 'Cortex Chess'],
    ['Site', meta.site ?? 'cortex-chess'],
    ['Date', meta.date],
    ['Round', meta.round ?? '-'],
    ['White', meta.white],
    ['Black', meta.black],
    ['Result', token],
  ]
  if (!fromStart) {
    headers.push(['SetUp', '1'])
    headers.push(['FEN', startFen])
  }

  let out = headers.map(([k, v]) => `[${k} "${v.replace(/"/g, "'")}"]`).join('\n') + '\n\n'

  // Build the move text with move numbers derived from each ply's pre-move FEN.
  const tokens: string[] = []
  for (let i = 0; i < game.history.length; i++) {
    const h = game.history[i]
    const parts = h.fenBefore.split(/\s+/)
    const turn = parts[1]
    const full = parts[5] ?? '1'
    if (turn === 'w') tokens.push(`${full}.`)
    else if (i === 0) tokens.push(`${full}...`)
    tokens.push(h.san)
  }
  tokens.push(token)

  // Wrap to ~80 columns, the PGN convention.
  let line = ''
  for (const t of tokens) {
    if (line.length + t.length + 1 > 80) {
      out += line.trimEnd() + '\n'
      line = ''
    }
    line += t + ' '
  }
  out += line.trimEnd() + '\n'
  return out
}
