// Integration check for the WDL eval routing: build the tables, then confirm that
// evaluate() reads the board, routes to the table, and returns scores consistent with
// a direct probe over many random positions (a draw/illegal scores exactly 0; a win is
// decisive for the side to move, a loss decisive against it).
//   node tools/run-ts.mjs tools/test-wdl-eval.ts

import { buildWdlConfig, probeWdl, WDL_CONFIGS } from '../src/engine/wdltb'
import { evaluate, parseFen, generateLegal, KNIGHT, BISHOP, ROOK, QUEEN } from '../src/engine'

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? '  —  ' + detail : ''}`)
}

const L: Record<number, string> = { [KNIGHT]: 'N', [BISHOP]: 'B', [ROOK]: 'R', [QUEEN]: 'Q' }
function fenFor(wk: number, bk: number, wType: number, wp: number, bType: number, bp: number, whiteToMove: boolean) {
  const b: string[] = Array(64).fill('')
  b[wk] = 'K'
  b[bk] = 'k'
  b[wp] = L[wType]
  b[bp] = L[bType].toLowerCase()
  const rows: string[] = []
  for (let r = 7; r >= 0; r--) {
    let row = ''
    let e = 0
    for (let f = 0; f < 8; f++) {
      const p = b[r * 8 + f]
      if (!p) e++
      else {
        if (e) {
          row += e
          e = 0
        }
        row += p
      }
    }
    if (e) row += e
    rows.push(row)
  }
  return `${rows.join('/')} ${whiteToMove ? 'w' : 'b'} - - 0 1`
}

function splitmix32(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x9e3779b9) >>> 0
    let z = s
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad)
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97)
    return (z ^ (z >>> 15)) >>> 0
  }
}

// Compare evaluate() against a direct probe over many random positions. Real White
// holds `wType`, real Black holds `bType`. Illegal positions (side not to move in check)
// are marked illegal → draw in the table and 0 in the eval, so they agree too.
function compareConfig(id: string, wType: number, bType: number) {
  console.log(`\n=== ${id} eval routing ===`)
  buildWdlConfig(WDL_CONFIGS.find((c) => c.id === id)!)
  const rng = splitmix32(0x2025abcd)
  let tested = 0
  let mismatch = 0
  let win = 0
  let loss = 0
  let draw = 0
  for (let t = 0; t < 1500000 && tested < 80000; t++) {
    const wk = rng() % 64
    const bk = rng() % 64
    const wp = rng() % 64
    const bp = rng() % 64
    if (new Set([wk, bk, wp, bp]).size !== 4) continue
    const whiteToMove = (rng() & 1) === 0
    let pos
    try {
      pos = parseFen(fenFor(wk, bk, wType, wp, bType, bp, whiteToMove))
    } catch {
      continue
    }
    if (generateLegal(pos).length === 0) continue
    const r = probeWdl(id, wk, bk, wType, wp, bType, bp, whiteToMove)
    const ev = evaluate(pos) // side-to-move relative
    tested++
    let ok: boolean
    if (r.wdl === 'draw') {
      draw++
      ok = ev === 0
    } else if (r.wdl === 'win') {
      win++
      ok = ev > 15000
    } else {
      loss++
      ok = ev < -15000
    }
    if (!ok) mismatch++
  }
  console.log(`  tested ${tested}  win ${win}  loss ${loss}  draw ${draw}  mismatch ${mismatch}`)
  check(`${id}: evaluate() agrees with the WDL probe`, mismatch === 0 && win > 0, `${mismatch} mismatches`)
}

compareConfig('KQvKR', QUEEN, ROOK)
compareConfig('KRvKB', ROOK, BISHOP)

console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' CHECK(S) FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
