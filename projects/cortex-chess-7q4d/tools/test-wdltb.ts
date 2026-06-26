// Offline validation for the WDL (Win/Draw/Loss + DTM) tablebase engine (dev-only;
// not part of the app build). Builds a couple of pieces-on-both-sides endings under
// Node and asserts the solver's invariants — Bellman optimality, optimal self-play to
// mate, and endgame-theory cross-checks — before the feature ships.
//
//   node tools/run-ts.mjs tools/test-wdltb.ts

import { buildWdlConfig, verifyWdl, probeWdl, WDL_CONFIGS, type WdlConfig } from '../src/engine/wdltb'
import { ROOK, QUEEN } from '../src/engine/board'

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  const tag = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`  [${tag}] ${name}${detail ? '  —  ' + detail : ''}`)
}

function run(config: WdlConfig) {
  console.log(`\n=== ${config.id}  (${config.label}) ===`)
  const t0 = Date.now()
  const v = verifyWdl(config.id, { sample: 300000, games: 2500 })
  const s = v.stats
  console.log(
    `  built+verified in ${((Date.now() - t0) / 1000).toFixed(1)}s  |  ` +
      `legal=${s.legal}  whiteWin=${s.whiteWin}  blackWin=${s.blackWin}  draw=${s.draw}  ` +
      `maxDTM=${s.maxDtm}  adv=${s.whiteAdvantage.toFixed(3)}`,
  )
  if (s.maxDtmFen) console.log(`  longest win: ${s.maxDtmFen}`)
  check(`Bellman optimality (${v.consChecked} sampled)`, v.consBad === 0, `${v.consBad} bad`)
  check(
    `optimal self-play to mate (${v.selfPlayGames} games)`,
    v.selfPlayMismatch === 0 && v.selfPlayOk > 0,
    `${v.selfPlayOk} ok / ${v.selfPlayMismatch} mismatch`,
  )
  check(`endgame theory (${v.theoryName}, expectDecisive=${v.theoryExpectDecisive})`, v.theoryPass)
}

// Build + verify the headline decisive ending and a headline draw.
run(WDL_CONFIGS.find((c) => c.id === 'KQvKR')!)
run(WDL_CONFIGS.find((c) => c.id === 'KRvKB')!)
run(WDL_CONFIGS.find((c) => c.id === 'KRvKR')!)

// --- Probe orientation / colour-mirroring spot checks ---
// Parse the placement of a `K Q vs K R`-style FEN into squares (0..63, a1 = 0).
function parse(fen: string) {
  const [placement, stm] = fen.split(/\s+/)
  let wk = -1
  let bk = -1
  let wp = -1
  let bp = -1
  const rows = placement.split('/')
  for (let r = 0; r < 8; r++) {
    const rank = 7 - r
    let f = 0
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') {
        f += +ch
        continue
      }
      const sq = rank * 8 + f
      if (ch === 'K') wk = sq
      else if (ch === 'k') bk = sq
      else if (ch === 'Q' || ch === 'R' || ch === 'B' || ch === 'N') wp = sq
      else bp = sq
      f++
    }
  }
  return { wk, bk, wp, bp, whiteToMove: stm === 'w' }
}

console.log('\n=== probe spot checks ===')
const kqvkr = WDL_CONFIGS.find((c) => c.id === 'KQvKR')!
const built = buildWdlConfig(kqvkr)
const longest = parse(built.maxDtmFen) // White holds the Q, Black the R — a forced win
{
  const r = probeWdl('KQvKR', longest.wk, longest.bk, QUEEN, longest.wp, ROOK, longest.bp, longest.whiteToMove)
  check(
    'KQvKR longest-win FEN probes as a win with the exact DTM',
    r.wdl === 'win' && r.dtm === built.maxDtm,
    `${r.wdl} dtm=${r.dtm} (expected win ${built.maxDtm})`,
  )
}
{
  // Colour-mirror the same position vertically: real Black now holds the queen and is
  // to move. The canonicaliser must recover the identical win + DTM.
  const r = probeWdl(
    'KQvKR',
    longest.bk ^ 56, // real White king (was Black's, mirrored)
    longest.wk ^ 56, // real Black king (was White's, mirrored)
    ROOK, // real White holds the rook
    longest.bp ^ 56,
    QUEEN, // real Black holds the queen
    longest.wp ^ 56,
    !longest.whiteToMove,
  )
  check(
    'KQvKR colour-mirrored probe recovers the same win + DTM',
    r.wdl === 'win' && r.dtm === built.maxDtm,
    `${r.wdl} dtm=${r.dtm} (expected win ${built.maxDtm})`,
  )
}

console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' CHECK(S) FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
