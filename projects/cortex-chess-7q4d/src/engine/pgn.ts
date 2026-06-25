// PGN export of the played game. Reads the move history (already stored as SAN)
// and the game result, and emits a standards-compliant PGN with the Seven Tag
// Roster — including a SetUp/FEN tag when the game didn't start from the initial
// position — so the moves can be loaded into any chess viewer or database.

import { Game, type GameResult, type Move, WHITE, START_FEN } from './index'
import { sanToMove, moveToSan } from './san'

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

// ----------------------------- PGN import -----------------------------

export interface ParsedGame {
  tags: Record<string, string>
  startFen: string
  moves: Move[] // resolved, legal moves in order
  sans: string[] // canonical SAN for each move (as the engine would write it)
  result: string // '1-0' | '0-1' | '1/2-1/2' | '*'
  error?: string // set if movetext stopped resolving partway through
}

const RESULT_TOKENS = new Set(['1-0', '0-1', '1/2-1/2', '½-½', '*'])

// Split a PGN file into one chunk of { tags, movetext } per game. A new game
// begins at the first tag line that appears after movetext has started.
function splitGames(text: string): { tags: Record<string, string>; movetext: string }[] {
  const games: { tags: Record<string, string>; movetext: string }[] = []
  let tags: Record<string, string> = {}
  let movetext = ''
  let inMoves = false
  const flush = () => {
    if (inMoves || Object.keys(tags).length) games.push({ tags, movetext })
    tags = {}
    movetext = ''
    inMoves = false
  }

  const TAG = /\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]/g
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[') && /^\[(\w+)\s+"/.test(line)) {
      // A tag line — may carry several [Tag "value"] pairs.
      if (inMoves) flush() // tags after moves → next game
      let m: RegExpExecArray | null
      TAG.lastIndex = 0
      while ((m = TAG.exec(line)) !== null) {
        tags[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      }
    } else if (line.length > 0) {
      inMoves = true
      const semi = line.indexOf(';') // rest-of-line comment
      movetext += (semi >= 0 ? line.slice(0, semi) : line) + ' '
    }
  }
  flush()
  return games
}

// Remove brace comments, recursive ( ) variations and $NAG glyphs, leaving a
// flat mainline movetext.
function stripAnnotations(movetext: string): string {
  let s = movetext.replace(/\{[^}]*\}/g, ' ')
  let out = ''
  let depth = 0
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')') {
      if (depth > 0) depth--
    } else if (depth === 0) out += ch
  }
  s = out.replace(/\$\d+/g, ' ')
  return s
}

// Parse a whole PGN file into games, resolving each SAN token to a legal move by
// replaying it on a board (so the result is verified, not just tokenized).
export function parsePgn(text: string): ParsedGame[] {
  return splitGames(text).map(({ tags, movetext }) => {
    const setUp = tags.SetUp === '1' || tags.FEN !== undefined
    const startFen = setUp && tags.FEN ? tags.FEN : START_FEN
    const out: ParsedGame = { tags, startFen, moves: [], sans: [], result: '*' }

    let game: Game
    try {
      game = new Game(startFen)
    } catch {
      out.error = 'invalid FEN tag'
      return out
    }

    const tokens = stripAnnotations(movetext).split(/\s+/).filter(Boolean)
    for (let tok of tokens) {
      if (RESULT_TOKENS.has(tok)) {
        out.result = tok === '½-½' ? '1/2-1/2' : tok
        break
      }
      tok = tok.replace(/^\d+\.(\.\.)?/, '') // strip a leading "12." / "12..."
      if (!tok || tok === '.' || tok === '...') continue
      const m = sanToMove(game.pos, tok)
      if (m === null) {
        out.error = `could not parse move "${tok}" at ply ${out.moves.length + 1}`
        break
      }
      out.sans.push(moveToSan(game.pos, m, game.legalMoves()))
      game.apply(m)
      out.moves.push(m)
    }
    return out
  })
}
