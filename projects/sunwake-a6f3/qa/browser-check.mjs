// Start `pnpm dev --host 127.0.0.1 --port 4178`, then run `node qa/browser-check.mjs`.
// Uses the real React UI and requestAnimationFrame loop, with a controllable browser clock.
// SUNWAKE_URL can target a production preview; CHROMIUM_PATH can select a local browser.
// SUNWAKE_CHECK optionally runs just scenarios whose names include that text.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'

const baseURL = process.env.SUNWAKE_URL ?? 'http://127.0.0.1:4178'
const executablePath = process.env.CHROMIUM_PATH
const artifactDirectory = fileURLToPath(new URL('./artifacts/', import.meta.url))
const SAVE_KEY = 'sunwake.progress.v1'
const browser = await chromium.launch({ headless: true, executablePath })
const failures = []
const browserErrors = []
let scenariosRun = 0
await mkdir(artifactDirectory, { recursive: true })

const integer = value => Number(value.replace(/[^0-9]/g, ''))
const distance = async page => integer(await page.locator('.distance-readout > strong').innerText())
const progress = page => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), SAVE_KEY)
const fly = async page => {
  await page.getByRole('button', { name: 'Let’s fly', exact: true }).click()
  await page.clock.runFor(64)
  await expect(page.locator('.flight-stage')).toHaveClass(/phase-running/)
}
const finish = async page => {
  if (await page.getByRole('button', { name: 'Pause flight', exact: true }).count()) {
    await page.getByRole('button', { name: 'Pause flight', exact: true }).click()
  }
  await page.getByRole('button', { name: 'End this flight', exact: true }).click()
  await page.clock.runFor(64)
  await expect(page.locator('.results-card')).toBeVisible()
}

async function scenario(name, viewport, check, mobile = false) {
  if (process.env.SUNWAKE_CHECK && !name.includes(process.env.SUNWAKE_CHECK)) return
  scenariosRun++
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 })
  const page = await context.newPage()
  page.setDefaultTimeout(6000)
  page.on('pageerror', error => browserErrors.push(`${name}: ${error.stack ?? error.message}`))
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`${name}: ${message.text()}`)
  })
  try {
    await page.clock.install({ time: new Date('2026-09-24T11:00:00Z') })
    await page.goto(baseURL, { waitUntil: 'networkidle' })
    await page.clock.pauseAt(new Date('2026-09-24T12:00:00Z'))
    await expect(page.locator('h1')).toContainText('last light')
    await check(page)
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.stack ?? error}`)
    console.error(`FAIL ${name}: ${error.message}`)
    await page.screenshot({ path: `${artifactDirectory}/${name}-failure.png`, fullPage: true }).catch(() => {})
  } finally {
    await context.close()
  }
}

try {
  await scenario('desktop-flight-and-save', { width: 1440, height: 1050 }, async page => {
    await page.getByRole('button', { name: 'How to fly' }).click()
    await expect(page.getByRole('dialog', { name: 'How to fly' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await fly(page)
    const initialDistance = await distance(page)
    await page.keyboard.down('Space')
    await page.clock.runFor(1600)
    await page.keyboard.up('Space')
    await page.clock.runFor(1600)
    assert.ok(await distance(page) > initialDistance + 50, 'Keyboard play must advance the skiff')

    await page.keyboard.press('KeyP')
    await expect(page.locator('.pause-card')).toBeVisible()
    const pausedDistance = await distance(page)
    await page.clock.runFor(3000)
    assert.equal(await distance(page), pausedDistance, 'Pause must freeze distance')
    await page.getByRole('button', { name: 'Keep flying', exact: true }).click()
    await page.clock.runFor(1200)
    assert.ok(await distance(page) > pausedDistance + 20, 'Resuming must restore simulation')

    // Pointer capture must release the dive even after the pointer leaves the canvas.
    const box = await page.locator('canvas').boundingBox()
    assert.ok(box)
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5)
    await page.mouse.down()
    await page.clock.runFor(1100)
    await page.mouse.move(box.x + box.width + 10, box.y + box.height + 10)
    await page.mouse.up()
    await page.clock.runFor(900)
    await page.getByRole('button', { name: 'Read the flight guide' }).click()
    await expect(page.getByRole('dialog', { name: 'How to fly' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.pause-card')).toBeVisible()
    await page.getByRole('button', { name: 'Keep flying', exact: true }).click()
    await page.clock.runFor(1000)

    await finish(page)
    const settled = await progress(page)
    assert.equal(settled.totalRuns, 1)
    assert.ok(settled.bank > 0, 'Collected light must reach the saved bank')
    assert.ok(settled.best > 150)
    await page.clock.runFor(4000)
    assert.deepEqual(await progress(page), settled, 'A completed run must settle exactly once')
    await page.reload({ waitUntil: 'networkidle' })
    await page.clock.runFor(64)
    assert.deepEqual(await progress(page), settled, 'Records and currency must survive reload')
    await expect(page.locator('.bank-pill')).toContainText(String(settled.bank))
    await expect(page.locator('.personal-best')).toContainText(settled.best.toLocaleString('en-US'))
    await page.screenshot({ path: `${artifactDirectory}/desktop-verified.png`, fullPage: true })
  })

  await scenario('daily-course-and-record', { width: 1280, height: 950 }, async page => {
    await page.getByRole('button', { name: 'Daily flight', exact: true }).click()
    await expect(page.locator('.daily-best')).toContainText('2026-09-24')
    const results = []
    for (let attempt = 0; attempt < 2; attempt++) {
      await fly(page)
      await expect(page.locator('.daily-tag')).toHaveText('DAILY')
      await page.keyboard.down('Space')
      await page.clock.runFor(2400)
      await page.keyboard.up('Space')
      await page.clock.runFor(3200)
      await page.keyboard.down('Space')
      await page.clock.runFor(2000)
      await page.keyboard.up('Space')
      await page.clock.runFor(2400)
      await page.getByRole('button', { name: 'Pause flight', exact: true }).click()
      results.push(await distance(page))
      await finish(page)
      await page.getByRole('button', { name: 'Back to shore', exact: true }).click()
      await page.clock.runFor(64)
    }
    assert.ok(Math.abs(results[0] - results[1]) <= 3, `Repeated daily input should follow the same course: ${results}`)
    const saved = await progress(page)
    assert.equal(saved.daily.date, '2026-09-24')
    assert.equal(saved.daily.best, Math.max(...results))
    assert.equal(saved.totalRuns, 2)
  })

  await scenario('free-flight-no-competitive-rewards', { width: 1280, height: 950 }, async page => {
    await page.getByRole('button', { name: 'Free flight', exact: true }).click()
    await fly(page)
    await expect(page.locator('.daily-tag')).toHaveText('FREE FLIGHT')
    await expect(page.locator('.sunlight-readout')).toContainText('∞')
    await page.keyboard.down('Space')
    await page.clock.runFor(14000)
    await page.keyboard.up('Space')
    assert.ok(await distance(page) > 400)
    await expect(page.locator('.sunlight-readout')).toContainText('∞')
    await finish(page)
    const saved = await progress(page)
    assert.equal(saved.bank, 0, 'Practice mode must not farm currency')
    assert.equal(saved.best, 0, 'Practice must not replace competitive distance records')
    assert.equal(saved.bestScore, 0)
    assert.equal(saved.completed.length, 0, 'Practice must not complete competitive missions')
    assert.equal(saved.daily.best, 0)
  })

  await scenario('hangar-purchases-persist', { width: 1280, height: 950 }, async page => {
    // Seed a save rather than modifying the engine: purchase behavior is the subject of this check.
    await page.evaluate(({ key, save }) => localStorage.setItem(key, JSON.stringify(save)), {
      key: SAVE_KEY,
      save: {
        version: 1, bank: 600, best: 1000, bestScore: 7000, totalDistance: 2000, totalRuns: 2,
        owned: ['sol'], selected: 'sol', completed: [], daily: { date: '2026-09-24', best: 0 }, sound: false,
      },
    })
    await page.reload({ waitUntil: 'networkidle' })
    await page.clock.runFor(64)
    await page.getByTitle('Open the hangar', { exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'The hangar' })).toBeVisible()
    const manta = page.locator('.ship-card').filter({ has: page.getByRole('heading', { name: 'Manta', exact: true }) })
    await manta.getByRole('button', { name: /150 light/ }).click()
    assert.equal((await progress(page)).bank, 450)
    assert.equal((await progress(page)).selected, 'manta')
    await expect(manta.getByRole('button', { name: 'Selected', exact: true })).toBeDisabled()
    const comet = page.locator('.ship-card').filter({ has: page.getByRole('heading', { name: 'Comet', exact: true }) })
    await comet.getByRole('button', { name: /400 light/ }).click()
    assert.equal((await progress(page)).bank, 50)
    assert.equal((await progress(page)).selected, 'comet')
    await manta.getByRole('button', { name: 'Select skiff', exact: true }).click()
    assert.equal((await progress(page)).bank, 50, 'Selecting an owned skiff must be free')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.reload({ waitUntil: 'networkidle' })
    await page.clock.runFor(64)
    const saved = await progress(page)
    assert.equal(saved.selected, 'manta')
    assert.deepEqual(saved.owned, ['sol', 'manta', 'comet'])
    assert.equal(saved.bank, 50)
    await page.getByTitle('Open the hangar', { exact: true }).click()
    await expect(page.locator('.ship-selected h3')).toHaveText('Manta')
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  await scenario('audio-toggle-and-pause', { width: 1280, height: 950 }, async page => {
    await page.getByRole('button', { name: 'Enable sound', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Mute sound', exact: true })).toHaveAttribute('aria-pressed', 'true')
    assert.equal((await progress(page)).sound, true)
    await fly(page)
    await page.clock.runFor(1300)
    await page.getByRole('button', { name: 'Pause flight', exact: true }).click()
    await page.clock.runFor(250)
    await expect(page.locator('.pause-card')).toBeVisible()
    await page.getByRole('button', { name: 'Keep flying', exact: true }).click()
    await page.clock.runFor(600)
    await page.getByRole('button', { name: 'Mute sound', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Enable sound', exact: true })).toHaveAttribute('aria-pressed', 'false')
    assert.equal((await progress(page)).sound, false)
    await page.clock.runFor(500)
    await page.reload({ waitUntil: 'networkidle' })
    await page.clock.runFor(64)
    await expect(page.getByRole('button', { name: 'Enable sound', exact: true })).toHaveAttribute('aria-pressed', 'false')
  })

  await scenario('shared-course-ghost-log-and-reload', { width: 1280, height: 950 }, async page => {
    await page.goto(`${baseURL}/#/course/2/3j`, { waitUntil: 'networkidle' })
    await expect(page.locator('.mode-description')).toContainText('Shared course')
    await fly(page)
    await page.clock.runFor(6000)
    await finish(page)
    const saved = await progress(page)
    assert.equal(saved.history.length, 1)
    assert.equal(saved.history[0].seed, 127)
    const ghost = await page.evaluate(() => JSON.parse(localStorage.getItem('sunwake.ghosts.v2'))[0])
    assert.equal(ghost.seed, 127)
    assert.ok(ghost.points.length >= 20)
    await expect(page.locator('.flight-debrief')).toBeVisible()
    await page.getByRole('button', { name: 'Race this route', exact: true }).click()
    await page.clock.runFor(2500)
    await expect(page.locator('.ghost-gap')).toBeVisible()
    const gap = await page.locator('.ghost-gap b').innerText()
    assert.ok(integer(gap) <= 3, `Matching inputs should closely match the ghost: ${gap}`)
    await finish(page)
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Open flight log', exact: true }).click()
    await expect(page.locator('.flight-log-row')).toHaveCount(2)
    await page.locator('.flight-log-row').last().getByRole('button').click()
    await page.clock.runFor(800)
    await expect(page.locator('.flight-stage')).toHaveClass(/phase-running/)
    await expect(page.locator('.ghost-gap')).toBeVisible()
    await page.screenshot({ path: `${artifactDirectory}/ghost-replay-verified.png` })
  })

  await scenario('coaching-preferences-and-independent-inputs', { width: 1280, height: 950 }, async page => {
    await fly(page)
    const box = await page.locator('canvas').boundingBox()
    await page.keyboard.down('Space')
    await page.mouse.move(box.x + box.width * .6, box.y + box.height * .4)
    await page.mouse.down()
    await page.clock.runFor(500)
    await page.keyboard.up('Space')
    await page.clock.runFor(150)
    await expect(page.locator('.flight-coach i')).toHaveText('DIVING')
    await page.mouse.up()
    await page.clock.runFor(150)
    await expect(page.locator('.flight-coach i')).toHaveCount(0)
    await page.getByRole('button', { name: 'How to fly' }).click()
    await page.getByRole('switch', { name: 'Flight coaching' }).click()
    await page.getByRole('switch', { name: 'Race your ghost' }).click()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Keep flying', exact: true }).click()
    await page.clock.runFor(150)
    await expect(page.locator('.flight-coach')).toHaveCount(0)
    await finish(page)
    assert.equal((await progress(page)).coach, false)
    await page.reload({ waitUntil: 'networkidle' })
    await fly(page)
    await expect(page.locator('.flight-coach')).toHaveCount(0)
    assert.equal((await progress(page)).ghost, false)
  })

  await scenario('course-share-clipboard-fallback', { width: 390, height: 844 }, async page => {
    await page.goto(`${baseURL}/#/course/2/3j`, { waitUntil: 'networkidle' })
    await fly(page)
    await page.clock.runFor(1200)
    await finish(page)
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Clipboard denied') } } }))
    await page.getByRole('button', { name: 'Copy course link', exact: true }).click()
    await expect(page.getByRole('dialog', { name: 'Share this course' })).toBeVisible()
    await expect(page.locator('.share-field input')).toHaveValue(/#\/course\/2\/3j$/)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.keyboard.press('Escape')
    await expect(page.locator('.results-card')).toBeVisible()
  }, true)

  await scenario('blocked-storage-still-replays', { width: 1280, height: 950 }, async page => {
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('Storage unavailable') } })
    await fly(page)
    await page.clock.runFor(1800)
    await finish(page)
    await expect(page.locator('.saved-note')).toContainText('this session')
    await page.getByRole('button', { name: 'Race this route', exact: true }).click()
    await page.clock.runFor(800)
    await expect(page.locator('.ghost-gap')).toBeVisible()
  })

  await scenario('landscape-fullscreen-touch-and-results', { width: 844, height: 390 }, async page => {
    await page.goto(`${baseURL}/#/course/2/3j`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: 'Enter fullscreen', exact: true }).click()
    assert.ok(await page.evaluate(() => Boolean(document.fullscreenElement)))
    await fly(page)
    const dive = page.getByRole('button', { name: 'Hold to dive, release to soar', exact: true })
    await expect(dive).toBeVisible()
    const style = await dive.evaluate(el => ({ height: el.clientHeight, radius: getComputedStyle(el).borderRadius }))
    assert.ok(style.height >= 44 && style.radius !== '0px', 'Landscape touch controls need their full styling and tap area')
    await page.clock.runFor(8800)
    await page.screenshot({ path: `${artifactDirectory}/landscape-flight-verified.png` })
    await finish(page)
    const dimensions = await page.locator('.results-card').evaluate(el => ({ height: el.clientHeight, scroll: el.scrollHeight }))
    assert.ok(dimensions.scroll <= dimensions.height + 2, `Fullscreen results must fit: ${JSON.stringify(dimensions)}`)
    await page.screenshot({ path: `${artifactDirectory}/landscape-results-verified.png` })
    await page.getByRole('button', { name: 'Race this route', exact: true }).click()
    await page.clock.runFor(800)
    await expect(page.locator('.ghost-gap')).toBeVisible()
    await page.evaluate(() => document.exitFullscreen())
  }, true)

  for (const width of [320, 390]) {
    await scenario(`mobile-${width}`, { width, height: 844 }, async page => {
      const noOverflow = async label => {
        const dimensions = await page.evaluate(() => ({
          width: window.innerWidth,
          document: document.documentElement.scrollWidth,
          body: document.body.scrollWidth,
        }))
        assert.ok(dimensions.document <= dimensions.width + 1, `${label}: document overflow ${JSON.stringify(dimensions)}`)
        assert.ok(dimensions.body <= dimensions.width + 1, `${label}: body overflow ${JSON.stringify(dimensions)}`)
      }
      await noOverflow('Welcome')
      await fly(page)
      const initial = await distance(page)
      const dive = page.getByRole('button', { name: 'Hold to dive, release to soar', exact: true })
      await expect(dive).toBeVisible()
      const target = await dive.boundingBox()
      assert.ok(target)
      const touch = await page.context().newCDPSession(page)
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: target.x + target.width / 2, y: target.y + target.height / 2, id: 1 }],
      })
      await page.clock.runFor(1600)
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await touch.detach()
      await page.clock.runFor(1600)
      assert.ok(await distance(page) > initial + 50, 'Touch play must advance distance')
      await noOverflow('Playing')
      await page.getByRole('button', { name: 'Pause flight', exact: true }).tap()
      const paused = await distance(page)
      await page.clock.runFor(1500)
      assert.equal(await distance(page), paused)
      await page.getByRole('button', { name: 'Keep flying', exact: true }).tap()
      await page.clock.runFor(700)
      await finish(page)
      await noOverflow('Results')
      await page.screenshot({ path: `${artifactDirectory}/mobile-${width}-verified.png`, fullPage: true })
    }, true)
  }
} finally {
  await browser.close()
}

if (scenariosRun === 0) failures.push('No browser scenarios matched SUNWAKE_CHECK')
if (browserErrors.length) failures.push(`Browser console/runtime errors:\n${browserErrors.join('\n')}`)
if (failures.length) {
  console.error(`\n${failures.length} browser regression failure(s):\n${failures.join('\n\n')}`)
  process.exitCode = 1
} else {
  console.log(process.env.SUNWAKE_CHECK
    ? `Selected browser checks passed: ${process.env.SUNWAKE_CHECK}; clean browser console.`
    : `All ${scenariosRun} browser checks passed: controls, saved progress, daily courses, practice, purchases, audio, shared-route ghosts, history, preferences, clipboard/storage fallbacks, mobile layouts, and clean consoles.`)
}
