// Offline validation for the pawnful KPvK distance-to-mate tablebase (dev-only; not
// part of the app build). Builds the table under Node and proves it three ways:
//
//   (1) EXHAUSTIVE WDL agreement against the wholly-independent kpk.ts bitbase —
//       every legal King+Pawn-vs-King position's win/draw verdict must match.
//   (2) EXHAUSTIVE Bellman optimality — every resolved position's stored DTM equals
//       the negamax of its children (quiet children read from the table, promotions
//       re-derived from the KQvK/KRvK sub-tables).
//   (3) Real-movegen self-play *across the promotion boundary* — from won roots,
//       optimal play (driven only by table probes through the engine's actual move
//       generator) promotes and then mates in the KQvK/KRvK table in exactly the
//       stored DTM, with the DTM decreasing by one on every ply.
//
//   node tools/run-ts.mjs tools/test-pawntb.ts

import {
  buildPawnTb,
  pawnTbStats,
  verifyPawnTb,
  probePawnKvK,
} from '../src/engine/pawntb'
import { probeKxK } from '../src/engine/egtb'
import { Game, WHITE } from '../src/engine/index'
import { type Position, PAWN, ROOK, QUEEN, KING, pieceType, pieceColor } from '../src/engine/board'
import { to64 } from '../src/engine/nnue'

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  const tag = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`  [${tag}] ${name}${detail ? '  —  ' + detail : ''}`)
}

// Build a canonical-frame FEN (white pawn marching up) for self-play roots.
function canonicalFen(wk: number, bk: number, psq: number, whiteToMove: boolean): string {
  const sq: string[] = new Array(64).fill('')
  sq[wk] = 'K'
  sq[bk] = 'k'
  sq[psq] = 'P'
  let placement = ''
  for (let r = 7; r >= 0; r--) {
    let empty = 0
    for (let f = 0; f < 8; f++) {
      const c = sq[r * 8 + f]
      if (c) {
        if (empty) placement += empty
        empty = 0
        placement += c
      } else empty++
    }
    if (empty) placement += empty
    if (r > 0) placement += '/'
  }
  return `${placement} ${whiteToMove ? 'w' : 'b'} - - 0 1`
}

// The exact DTM (white-to-mate) of any position reachable from a canonical KPvK
// root: white holds the only non-king piece (P before promotion; Q/R/B/N after).
// Returns the DTM for the side to move (white strong), or -1 if drawn.
function positionDtm(pos: Position): number {
  let wk = -1
  let bk = -1
  let pieceSq = -1
  let piece = 0
  for (let s = 0; s < 128; s++) {
    if ((s & 0x88) !== 0) {
      s += 7
      continue
    }
    const pc = pos.board[s]
    if (pc === 0) continue
    const t = pieceType(pc)
    if (t === KING) {
      if (pieceColor(pc) === WHITE) wk = to64(s)
      else bk = to64(s)
    } else {
      pieceSq = to64(s)
      piece = t
    }
  }
  const whiteToMove = pos.turn === WHITE
  if (piece === PAWN) {
    const r = probePawnKvK(wk, bk, pieceSq, true, whiteToMove)
    return r.win ? r.dtm : -1
  }
  if (piece === QUEEN || piece === ROOK) {
    const r = probeKxK(piece, wk, bk, pieceSq, true, whiteToMove)
    return r.win ? r.dtm : -1
  }
  return -1 // K vs K, K+B vs K, K+N vs K → draw
}

// Play one optimal game from a won, white-to-move canonical root and confirm the
// game mates in exactly `rootDtm` plies, the DTM falling by one each ply.
function selfPlayToMate(wk: number, bk: number, psq: number, rootDtm: number): { ok: boolean; reason: string } {
  const g = new Game(canonicalFen(wk, bk, psq, true))
  let dtm = rootDtm
  for (let ply = 0; ply < 256; ply++) {
    const moves = g.legalMoves()
    if (moves.length === 0) {
      const mated = g.result() === 'checkmate'
      if (!mated) return { ok: false, reason: `stalemate at ply ${ply}` }
      if (dtm !== 0) return { ok: false, reason: `mate at ply ${ply} but dtm=${dtm}` }
      return { ok: ply === rootDtm ? true : false, reason: `mated in ${ply}, expected ${rootDtm}` }
    }
    const strongToMove = g.turn === WHITE
    // Optimal target: the child whose DTM is dtm-1 (white minimises, black maximises;
    // for both, the principal child sits at dtm-1).
    let chosen = moves[0]
    let chosenDtm = strongToMove ? Infinity : -Infinity
    for (const m of moves) {
      const c = g.clone()
      c.apply(m)
      const cd = positionDtm(c.pos)
      if (strongToMove) {
        if (cd >= 0 && cd < chosenDtm) {
          chosenDtm = cd
          chosen = m
        }
      } else {
        if (cd < 0) return { ok: false, reason: `defender escapes to a draw at ply ${ply}` }
        if (cd > chosenDtm) {
          chosenDtm = cd
          chosen = m
        }
      }
    }
    if (!isFinite(chosenDtm) || chosenDtm < 0) return { ok: false, reason: `no winning move at ply ${ply}` }
    if (chosenDtm !== dtm - 1) return { ok: false, reason: `dtm step off at ply ${ply}: ${dtm} → ${chosenDtm}` }
    g.apply(chosen)
    dtm = chosenDtm
  }
  return { ok: false, reason: 'did not mate within 256 plies' }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

console.log('\n=== KPvK pawnful distance-to-mate tablebase ===')
const t0 = Date.now()
buildPawnTb()
const stats = pawnTbStats()
console.log(
  `  built in ${((Date.now() - t0) / 1000).toFixed(2)}s  |  ` +
    `legal=${stats.legal}  wins=${stats.wins}  draws=${stats.draws}  maxDTM=${stats.maxDtm} plies`,
)
console.log(`  longest forced win: ${stats.maxDtmFen}`)

// (1) + (2): the module's own verifier, but pushed to exhaustive Bellman coverage.
const v = verifyPawnTb({ sample: 800000, games: 4000 })
check(
  `exhaustive WDL agreement vs kpk bitbase (${v.oracleChecked} positions)`,
  v.oracleMismatch === 0,
  `${v.oracleMismatch} mismatches`,
)
check(
  `Bellman optimality (${v.bellmanChecked} sampled)`,
  v.bellmanBad === 0,
  `${v.bellmanBad} bad`,
)
check(
  `self-play to promotion (${v.selfPlayGames} games)`,
  v.selfPlayBad === 0 && v.selfPlayOk > 0,
  `${v.selfPlayOk} ok / ${v.selfPlayBad} bad`,
)

// (3): real-movegen self-play through promotion all the way to checkmate.
const rng = mulberry32(0xc0ffee)
let played = 0
let mated = 0
let badGame = ''
for (let g = 0; g < 200000 && played < 3000; g++) {
  const wk = (rng() * 64) | 0
  const bk = (rng() * 64) | 0
  const psq = 8 + ((rng() * 48) | 0)
  if (wk === bk || wk === psq || bk === psq) continue
  const r = probePawnKvK(wk, bk, psq, true, true)
  if (!r.win) continue
  played++
  const res = selfPlayToMate(wk, bk, psq, r.dtm)
  if (res.ok) mated++
  else if (!badGame) badGame = `${canonicalFen(wk, bk, psq, true)} (dtm ${r.dtm}): ${res.reason}`
}
check(
  `real-movegen self-play to mate across promotion (${played} games)`,
  mated === played && played > 0,
  badGame || `${mated}/${played} mated in the stored DTM`,
)

// A couple of hand-checked landmark positions.
{
  // White pawn a7, white king a8 is illegal; use a clean win: Ke6, Pe5 vs Ke8 — a
  // textbook won king-and-pawn ending. Just assert it is a win and probes finitely.
  const g = new Game('4k3/8/4K3/4P3/8/8/8/8 w - - 0 1')
  const dtm = positionDtm(g.pos)
  check('Ke6/Pe5 vs Ke8 is a win', dtm >= 0, `dtm=${dtm}`)
}
{
  // Rook-pawn draw: the defending king reaches the corner. Ka6, Pa5 vs Ka8 with
  // White to move is the classic drawn rook-pawn fortress... unless the white king
  // shoulders correctly. Use the dead-drawn Kb6? No — assert the known draw: white
  // pawn on a-file, black king in front. Kh1,Pa2,Kh8 → pawn too far, but a-file with
  // the black king on a8 and white king cut off is a draw.
  const draw = probePawnKvK(/*wk*/ 0 /*a1*/, /*bk*/ 56 /*a8*/, /*psq*/ 8 /*a2*/, true, true)
  check('a-pawn with the defending king on a8 (cut off) is drawn', !draw.win, `win=${draw.win}`)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
