// Offline validation for the Cortex Coach review model (dev-only; not part of the
// app build). It runs the in-repo engine over a real master game end-to-end and
// asserts the model's invariants — exactly what the in-browser Review tab does,
// just under Node so we can prove correctness before shipping.
//
//   node tools/run-ts.mjs tools/test-review.ts

import {
  Game,
  Searcher,
  MATE,
  parsePgn,
  generateLegal,
  inCheck,
  reviewGame,
  reviewSelftest,
  winPercent,
  type NodeAnalysis,
} from '../src/engine'

function analyseNode(s: Searcher, fen: string, history: bigint[], maxDepth: number, maxTime: number): NodeAnalysis {
  const g = new Game(fen)
  if (generateLegal(g.pos).length === 0) {
    const mated = inCheck(g.pos, g.pos.turn)
    return { score: mated ? -MATE : 0, mate: mated ? -1 : null, bestPv: [], secondScore: null, secondMate: null }
  }
  const r = s.searchMultiPv(g.pos, { maxDepth, maxTime, history }, 2)
  const l0 = r.lines[0]
  const l1 = r.lines[1]
  return {
    score: l0?.score ?? 0,
    mate: l0?.mate ?? null,
    bestPv: l0?.pv ?? [],
    secondScore: l1?.score ?? null,
    secondMate: l1?.mate ?? null,
  }
}

let failures = 0
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

// ---- 1. the pure self-test --------------------------------------------------
console.log('reviewSelftest():')
const st = reviewSelftest()
for (const c of st.checks) check(c.name, c.ok, c.detail)
check('reviewSelftest overall', st.ok)

// ---- 2. monotonicity sweep of win%/accuracy --------------------------------
console.log('\ncurve invariants:')
let mono = true
for (let cp = -990; cp < 990; cp += 10) if (winPercent(cp) > winPercent(cp + 10)) mono = false
check('win% strictly monotone over [-1000,1000]', mono)
check('win% bounded', winPercent(99999) <= 100 && winPercent(-99999) >= 0)

// ---- 3. a real master game end-to-end --------------------------------------
const OPERA = `[Event "Paris Opera"] [White "Paul Morphy"] [Black "Allies"] [Result "1-0"]
1.e4 e5 2.Nf3 d6 3.d4 Bg4 4.dxe5 Bxf3 5.Qxf3 dxe5 6.Bc4 Nf6 7.Qb3 Qe7
8.Nc3 c6 9.Bg5 b5 10.Nxb5 cxb5 11.Bxb5+ Nbd7 12.O-O-O Rd8 13.Rxd7 Rxd7
14.Rd1 Qe6 15.Bxd7+ Nxd7 16.Qb8+ Nxb8 17.Rd8# 1-0`

console.log('\nOpera Game review (Morphy vs Allies):')
const parsed = parsePgn(OPERA)[0]
const g = new Game(parsed.startFen)
const fens = [g.fen()]
const histories: bigint[][] = [g.keyHistory()]
for (const m of parsed.moves) {
  g.apply(m)
  fens.push(g.fen())
  histories.push(g.keyHistory())
}
check('parsed all 33 plies', parsed.moves.length === 33, `${parsed.moves.length}`)

const s = new Searcher()
const t0 = Date.now()
const nodes = fens.map((fen, i) => analyseNode(s, fen, histories[i], 12, 200))
const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`  analysed ${nodes.length} nodes in ${elapsed}s`)

const review = reviewGame({ startFen: parsed.startFen, moves: parsed.moves, nodes })

check('white accuracy in [0,100]', review.white.accuracy >= 0 && review.white.accuracy <= 100, review.white.accuracy.toFixed(1) + '%')
check('black accuracy in [0,100]', review.black.accuracy >= 0 && review.black.accuracy <= 100, review.black.accuracy.toFixed(1) + '%')
check('white ACPL ≥ 0', review.white.acpl >= 0, review.white.acpl.toFixed(0))
check('black ACPL ≥ 0', review.black.acpl >= 0, review.black.acpl.toFixed(0))
check('every move classified', review.moves.length === parsed.moves.length && review.moves.every((m) => !!m.klass))
check('last move is mate (#)', review.moves[review.moves.length - 1].san.includes('#'), review.moves[review.moves.length - 1].san)
// Morphy famously outplayed the Allies — his accuracy should exceed theirs, and
// the losing side should have at least one flagged error.
check('White (Morphy) accuracy ≥ Black', review.white.accuracy >= review.black.accuracy, `${review.white.accuracy.toFixed(1)} vs ${review.black.accuracy.toFixed(1)}`)
const blackErrors = review.moves.filter((m) => m.color === 1 && (m.klass === 'mistake' || m.klass === 'blunder' || m.klass === 'inaccuracy' || m.klass === 'missed-win')).length
check('Black has ≥1 flagged error', blackErrors >= 1, `${blackErrors}`)
check('key moments produced', review.keyMoments.length >= 1, `${review.keyMoments.length}`)

console.log('\nscoreboard:')
console.log(`  White: ${review.white.accuracy.toFixed(1)}% acc · ACPL ${review.white.acpl.toFixed(0)} · ~${review.white.estElo} Elo`)
console.log(`  Black: ${review.black.accuracy.toFixed(1)}% acc · ACPL ${review.black.acpl.toFixed(0)} · ~${review.black.estElo} Elo`)
console.log('\nclassified moves:')
for (const m of review.moves) {
  console.log(`  ${m.index + 1}. ${(m.color === 0 ? 'W ' : 'B ')}${m.san.padEnd(7)} ${m.klass.padEnd(11)} acc ${m.accuracy.toFixed(0).padStart(3)}  ${m.coach}`)
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
