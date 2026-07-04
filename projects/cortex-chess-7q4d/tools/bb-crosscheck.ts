// Cross-check: the magic-bitboard generator and the 0x88 mailbox generator must
// agree on the perft DIVIDE (per-root-move node counts) for every reference
// position — two engines that share no code, move for move. Run with:
//   node tools/run-ts.mjs tools/bb-crosscheck.ts
import {
  parseFen,
  generateLegal,
  perft,
  makeMoveOnBoard,
  unmakeMoveOnBoard,
  moveFrom,
  moveTo,
  movePromo,
  moveFlag,
  squareName,
  castleKingDest,
  FLAG_CASTLE,
  type Undo,
} from '../src/engine/index.ts'
import { parseFenBB, bbPerftDivide, initMagics, PERFT_REF } from '../src/engine/bitboard.ts'

function mailboxUci(m: number): string {
  if (moveFlag(m) === FLAG_CASTLE) return squareName(moveFrom(m)) + squareName(castleKingDest(moveFrom(m), moveTo(m)))
  return squareName(moveFrom(m)) + squareName(moveTo(m)) + (movePromo(m) ? 'nbrq'[movePromo(m) - 2] : '')
}

function mailboxDivide(fen: string, depth: number): Map<string, number> {
  const pos = parseFen(fen)
  const moves = generateLegal(pos)
  const undo: Undo = { captured: 0, capturedSq: -1, castling: 0, ep: -1, halfmove: 0, hash: 0n }
  const out = new Map<string, number>()
  for (const m of moves) {
    makeMoveOnBoard(pos, m, undo)
    out.set(mailboxUci(m), depth <= 1 ? 1 : perft(pos, depth - 1))
    unmakeMoveOnBoard(pos, m, undo)
  }
  return out
}

initMagics()
const MAX = Number(process.env.MAXNODES ?? 700_000)
let allPass = true
for (const ref of PERFT_REF) {
  let depth = 1
  while (depth + 1 < ref.counts.length && ref.counts[depth + 1] <= MAX) depth++
  const bb = bbPerftDivide(parseFenBB(ref.fen), depth)
  const mb = mailboxDivide(ref.fen, depth)
  let ok = bb.length === mb.size
  for (const e of bb) if (mb.get(e.uci) !== e.nodes) ok = false
  const bbTotal = bb.reduce((s, e) => s + e.nodes, 0)
  if (!ok) allPass = false
  console.log(
    `${ok ? '✓' : '✗'} ${ref.name.padEnd(18)} d${depth}  ${bb.length} root moves, ` +
      `${bbTotal.toLocaleString()} nodes — bitboard vs mailbox ${ok ? 'AGREE' : 'DISAGREE'}`,
  )
  if (!ok) {
    for (const e of bb) if (mb.get(e.uci) !== e.nodes) console.log(`    ${e.uci}: bb=${e.nodes} mb=${mb.get(e.uci)}`)
  }
}
console.log(allPass ? '\nALL AGREE' : '\nMISMATCH')
process.exit(allPass ? 0 : 1)
