// Independent validation of the magic-bitboard generator against the PUBLISHED
// perft reference counts (Chess Programming Wiki), outside the browser.
//   node --experimental-strip-types tools/bb-validate.ts
//   MAXNODES=20000000 node --experimental-strip-types tools/bb-validate.ts
import { initMagics, parseFenBB, bbPerft, PERFT_REF } from '../src/engine/bitboard.ts'

const MAX = Number(process.env.MAXNODES ?? 6_000_000)

const t0 = Date.now()
initMagics()
console.log(`magics initialised in ${Date.now() - t0} ms\n`)

let allPass = true
for (const c of PERFT_REF) {
  const st = parseFenBB(c.fen)
  for (let d = 1; d < c.counts.length; d++) {
    if (c.counts[d] > MAX) break
    const s = Date.now()
    const got = bbPerft(st, d)
    const ms = Date.now() - s
    const ok = got === c.counts[d]
    if (!ok) allPass = false
    const nps = ms > 0 ? `${(got / ms / 1000).toFixed(2)}M nps` : '—'
    console.log(
      `${ok ? '✓' : '✗'} ${c.name.padEnd(18)} d${d}  got=${got.toString().padStart(10)}  ` +
        `want=${c.counts[d].toString().padStart(10)}  ${ms.toString().padStart(6)}ms  ${nps}`,
    )
  }
}
console.log(allPass ? '\nALL PASS' : '\nFAILURES PRESENT')
process.exit(allPass ? 0 : 1)
