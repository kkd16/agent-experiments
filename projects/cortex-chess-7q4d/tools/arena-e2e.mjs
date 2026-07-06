// Headless end-to-end test of the Arena against the *production build*. Drives the
// real UI in Chromium: opens Engine Lab → Arena, runs a short SPRT match and a
// round-robin tournament, and asserts the statistics render with zero console
// errors. This is the "prove it in the live app" gate the repo runs by hand — it
// is NOT part of CI (which is lint + build), and playwright-core is not a project
// dependency, so run it deliberately:
//
//   pnpm build
//   pnpm preview --port 4174 --strictPort &   # serve dist/
//   node tools/arena-e2e.mjs                  # needs playwright-core + a Chromium
//
// Point CHROME at a Chromium/headless-shell binary if the default path differs.

import { chromium } from 'playwright-core'

const EXE =
  process.env.CHROME ||
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell'
const URL = process.env.ARENA_URL || 'http://localhost:4174/'

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1 }

await page.goto(URL, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: 'Engine Lab' }).click()
await page.getByRole('button', { name: 'Arena' }).click()
await page.waitForTimeout(300)

// --- SPRT match: a clearly-stronger engine should be detected as H1 ---
if (!(await page.getByText('The Arena.').first().isVisible())) fail('Arena intro missing')
await page.locator('.arena-cfg').first().getByRole('button', { name: '30kn' }).click()
await page.locator('.arena-cfg').nth(1).getByRole('button', { name: '2kn' }).click()
await page.getByRole('button', { name: '100', exact: true }).click()
await page.getByRole('button', { name: 'Run SPRT' }).click()

let sprtOk = false
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(1000)
  const verdict = await page.locator('.sprt-verdict').first().textContent().catch(() => '')
  if (/accepted|Inconclusive/.test(verdict)) { sprtOk = true; break }
  if (i === 8 && (await page.locator('.llr-line').count()) === 0) fail('no LLR track after 9s')
}
const finalVerdict = (await page.locator('.sprt-verdict').first().textContent().catch(() => '')).trim()
const pentaKeys = await page.locator('.penta-key').count()
console.log('SPRT verdict:', finalVerdict)
console.log('penta buckets:', pentaKeys)
if (!sprtOk) fail('SPRT did not reach a verdict in 60s')
if (!/H₁ accepted/.test(finalVerdict)) fail('expected H1 accepted for 30kn vs 2kn')
if (pentaKeys !== 5) fail('pentanomial breakdown not rendered')

// --- Round-robin: standings + crosstable + Elo bars + LOS matrix ---
await page.getByRole('button', { name: 'Round-robin' }).click()
await page.waitForTimeout(200)
await page.getByRole('button', { name: '4', exact: true }).click()
await page.getByRole('button', { name: 'Run tournament' }).click()

for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(1000)
  const done = await page.locator('.tour-progress-text').textContent().catch(() => '')
  const m = done.match(/(\d+)\/(\d+)/)
  if (m && m[1] === m[2] && (await page.locator('.tour-standings tbody tr').count()) >= 4) break
}
const rows = await page.locator('.tour-standings tbody tr').count()
const cross = await page.locator('.cross-cell').count()
const bars = await page.locator('.elo-bar-row').count()
const los = await page.locator('.los-cell').count()
console.log('tournament — standings:', rows, 'cross cells:', cross, 'elo bars:', bars, 'LOS cells:', los)
if (rows < 4) fail('standings incomplete')
if (cross === 0) fail('crosstable not rendered')
if (bars < 4) fail('elo bars not rendered')
if (los === 0) fail('LOS matrix not rendered')

if (errors.length) { console.error('CONSOLE ERRORS:', errors.slice(0, 10)); fail('console errors') }

await browser.close()
console.log(process.exitCode ? '\nE2E FAILED' : '\nE2E PASSED — SPRT + tournament run live, zero console errors')
