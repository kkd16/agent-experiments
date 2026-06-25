// A small, hand-authored weighted opening book. Each line below is a sequence of
// SAN moves from the start; the book is compiled (lazily, once) into a map from
// position → the moves played from it with a popularity weight. When several
// authored lines pass through the same position the shared move accumulates
// weight, so the engine's book choice is weighted-random toward main lines while
// still varying its play. This keeps early play principled and non-repetitive
// without any search.

import { Game } from './index'
import { type Move, moveFrom, moveTo, movePromo } from './board'
import { moveToSan } from './san'

// Main-line repertoire for both colours. Kept broad rather than deep — the search
// takes over after the opening. Duplicated prefixes are intentional: they make the
// shared early moves more likely to be chosen.
const LINES: string[] = [
  // --- 1.e4 e5 ---
  'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O', // Ruy Lopez, Closed
  'e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 O-O c3 d5', // Marshall
  'e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6 O-O f6', // Exchange Ruy
  'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d4 exd4 cxd4 Bb4 Bd2', // Italian / Giuoco
  'e4 e5 Nf3 Nc6 Bc4 Bc5 b4 Bxb4 c3 Ba5 d4', // Evans Gambit
  'e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Na5 Bb5 c6', // Two Knights
  'e4 e5 Nf3 Nc6 d4 exd4 Nxd4 Nf6 Nc3 Bb4', // Scotch
  'e4 e5 Nf3 Nf6 Nxe5 d6 Nf3 Nxe4 d4 d5 Bd3 Nc6', // Petroff
  'e4 e5 Nc3 Nf6 f4 d5 fxe5 Nxe4', // Vienna
  // --- 1.e4 c5 Sicilian ---
  'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be2 e5', // Najdorf
  'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6 Be3 Bg7', // Dragon
  'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 Nf6 Nc3 e5', // Sveshnikov
  'e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6 Bd3 Nf6', // Taimanov-ish
  'e4 c5 Nc3 Nc6 g3 g6 Bg2 Bg7', // Closed Sicilian
  'e4 c5 c3 d5 exd5 Qxd5 d4 Nf6', // Alapin
  // --- 1.e4 e6 French ---
  'e4 e6 d4 d5 Nc3 Bb4 e5 c5 a3 Bxc3 bxc3 Ne7', // Winawer
  'e4 e6 d4 d5 Nd2 Nf6 e5 Nfd7 Bd3 c5', // Tarrasch
  'e4 e6 d4 d5 exd5 exd5 Nf3 Nf6 Bd3 Bd6', // Exchange French
  // --- 1.e4 c6 Caro-Kann ---
  'e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 Ng3 Bg6 h4 h6', // Classical
  'e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2 c5', // Advance
  'e4 c6 d4 d5 exd5 cxd5 c4 Nf6', // Panov
  // --- 1.e4 others ---
  'e4 d6 d4 Nf6 Nc3 g6 f4 Bg7', // Pirc
  'e4 g6 d4 Bg7 Nc3 d6 f4 Nf6', // Modern
  'e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6', // Scandinavian
  // --- 1.d4 d5 ---
  'd4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3 h6', // QGD
  'd4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4 a4 Bf5', // Slav
  'd4 d5 c4 dxc4 Nf3 Nf6 e3 e6 Bxc4 c5', // QGA
  'd4 d5 c4 e6 Nc3 c5 cxd5 exd5 Nf3 Nc6', // Tarrasch Defence
  'd4 d5 Nf3 Nf6 c4 e6 Nc3 Be7', // QGD via Nf3
  // --- 1.d4 Nf6 Indian ---
  'd4 Nf6 c4 e6 Nc3 Bb4 e3 O-O Bd3 d5 Nf3 c5', // Nimzo-Indian
  'd4 Nf6 c4 e6 Nf3 b6 g3 Bb7 Bg2 Be7', // Queen's Indian
  'd4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5', // King's Indian
  'd4 Nf6 c4 g6 Nc3 d5 cxd5 Nxd5 e4 Nxc3 bxc3 Bg7', // Grünfeld
  'd4 Nf6 c4 c5 d5 b5', // Benko-ish
  'd4 Nf6 c4 e6 g3 d5 Bg2 Be7', // Catalan
  // --- 1.d4 f5 / others ---
  'd4 f5 g3 Nf6 Bg2 e6 Nf3 Be7', // Dutch
  // --- 1.c4 English ---
  'c4 e5 Nc3 Nf6 Nf3 Nc6 g3 d5 cxd5 Nxd5', // English, reversed Sicilian
  'c4 Nf6 Nc3 e6 Nf3 d5 d4 Be7', // English → QGD
  'c4 c5 Nf3 Nf6 Nc3 Nc6 g3 g6 Bg2 Bg7', // Symmetrical English
  // --- 1.Nf3 ---
  'Nf3 d5 d4 Nf6 c4 e6 Nc3 Be7', // Réti → QGD
  'Nf3 Nf6 c4 g6 Nc3 d5', // Réti
]

type BookEntry = { move: Move; weight: number }
let book: Map<string, BookEntry[]> | null = null

// Position key: the first four FEN fields (ignore the clocks) so transpositions
// share an entry.
function key(fen: string): string {
  return fen.split(/\s+/).slice(0, 4).join(' ')
}

function findSanMove(g: Game, san: string): Move | null {
  const target = san.replace(/[+#]/g, '')
  for (const m of g.legalMoves()) {
    if (moveToSan(g.pos, m, g.legalMoves()).replace(/[+#]/g, '') === target) return m
  }
  return null
}

function compile(): Map<string, BookEntry[]> {
  const map = new Map<string, BookEntry[]>()
  for (const line of LINES) {
    const g = new Game()
    for (const san of line.split(/\s+/)) {
      const move = findSanMove(g, san)
      if (move === null) break // a typo in a line just truncates it, never crashes
      const k = key(g.fen())
      let list = map.get(k)
      if (!list) {
        list = []
        map.set(k, list)
      }
      const existing = list.find((e) => e.move === move)
      if (existing) existing.weight++
      else list.push({ move, weight: 1 })
      g.apply(move)
    }
  }
  return map
}

// A weighted-random book move for the given position, or null if out of book.
export function bookMove(fen: string): Move | null {
  if (!book) book = compile()
  const list = book.get(key(fen))
  if (!list || list.length === 0) return null
  let total = 0
  for (const e of list) total += e.weight
  let r = Math.random() * total
  for (const e of list) {
    r -= e.weight
    if (r < 0) return e.move
  }
  return list[0].move
}

// The book entries for a position (for display / debugging), sorted by weight.
export function bookEntries(fen: string): { uci: string; weight: number }[] {
  if (!book) book = compile()
  const list = book.get(key(fen)) ?? []
  const files = 'abcdefgh'
  const name = (s: number) => files[s & 7] + ((s >> 4) + 1)
  return [...list]
    .sort((a, b) => b.weight - a.weight)
    .map((e) => ({ uci: name(moveFrom(e.move)) + name(moveTo(e.move)) + (movePromo(e.move) ? 'q' : ''), weight: e.weight }))
}

export function bookPositions(): number {
  if (!book) book = compile()
  return book.size
}
