// Regression coverage for render scheduling, comfort settings, focus, and input edges.
// Start a production preview, then set SUNWAKE_URL and (optionally) CHROMIUM_PATH.
import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH,
})
const base = process.env.SUNWAKE_URL ?? 'http://127.0.0.1:4179'
const failures = []
const errors = []
let count = 0
await mkdir(new URL('./artifacts/', import.meta.url), { recursive: true })
async function scenario(name, viewport, check, mobile = false) {
  if (process.env.SUNWAKE_CHECK && !name.includes(process.env.SUNWAKE_CHECK))
    return
  count++
  const context = await browser.newContext({
    viewport,
    isMobile: mobile,
    hasTouch: mobile,
    deviceScaleFactor: 2,
  })
  await context.addInitScript(() => {
    window.testPaints = 0
    const paint = CanvasRenderingContext2D.prototype.setTransform
    CanvasRenderingContext2D.prototype.setTransform = function (...args) {
      if (this.canvas.classList.contains('world-canvas')) window.testPaints++
      return paint.apply(this, args)
    }
    window.testAudio = []
    const Context = window.AudioContext
    if (Context)
      window.AudioContext = class extends Context {
        constructor(...args) {
          super(...args)
          window.testAudio.push(this)
        }
      }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(6000)
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${name}: ${m.text()}`)
  })
  try {
    await page.clock.install({ time: new Date('2026-09-24T11:00:00Z') })
    await page.goto(base, { waitUntil: 'networkidle' })
    await page.clock.pauseAt(new Date('2026-09-24T12:00:00Z'))
    await check(page)
    console.log(`PASS ${name}`)
  } catch (e) {
    failures.push(`${name}: ${e.stack ?? e}`)
    console.error(`FAIL ${name}: ${e.message}`)
    await page
      .screenshot({ path: `qa/artifacts/${name}-failure.png`, fullPage: true })
      .catch(() => {})
  } finally {
    await context.close()
  }
}
const run = (page, ms = 128) => page.clock.runFor(ms)
const paints = (page) => page.evaluate(() => window.testPaints)
const fly = async (page) => {
  await page.getByRole('button', { name: 'Let’s fly', exact: true }).click()
  await run(page)
  await expect(page.locator('.flight-stage')).toHaveClass(/phase-running/)
}
const distance = (page) =>
  page.locator('.distance-readout > strong').innerText()
const finish = async (page) => {
  await page.keyboard.press('KeyP')
  await page
    .getByRole('button', { name: 'End this flight', exact: true })
    .click()
  await run(page)
  await expect(page.locator('.results-card')).toBeVisible()
  await run(page)
}
try {
  await scenario(
    'idle-paints-and-pause-resize',
    { width: 1440, height: 1050 },
    async (page) => {
      let initial = await paints(page)
      await run(page, 1000)
      const idle = (await paints(page)) - initial
      assert.ok(
        idle <= 32 && idle >= 20,
        `Ambient draw rate should be about 30 FPS, got ${idle}`,
      )
      await fly(page)
      await run(page, 500)
      assert.equal(
        await page.evaluate(() => window.testAudio.length),
        0,
        'Muted play must not construct an audio graph',
      )
      await page.keyboard.press('KeyP')
      await run(page)
      initial = await paints(page)
      const pausedDistance = await distance(page)
      await run(page, 2000)
      assert.equal(
        await paints(page),
        initial,
        'Paused canvas must not repaint',
      )
      assert.equal(await distance(page), pausedDistance)
      await page.setViewportSize({ width: 1280, height: 900 })
      await page.waitForTimeout(40)
      await run(page)
      assert.ok(
        (await paints(page)) > initial,
        'Resizing a paused canvas must repaint it',
      )
      await page
        .getByRole('button', { name: 'Flight settings', exact: true })
        .click()
      await run(page)
      initial = await paints(page)
      await run(page, 1000)
      assert.equal(
        await paints(page),
        initial,
        'Menus must freeze the background canvas',
      )
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Keep flying', exact: true })
        .click()
      await run(page, 500)
      assert.notEqual(await distance(page), pausedDistance)
      await finish(page)
      initial = await paints(page)
      await run(page, 1000)
      assert.equal(
        await paints(page),
        initial,
        'Results must not repaint the world',
      )
    },
  )
  await scenario(
    'settings-storage-motion-and-detail',
    { width: 1280, height: 950 },
    async (page) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await run(page)
      await expect(page.locator('.app-shell')).toHaveClass(/reduced-motion/)
      await page
        .getByRole('button', { name: 'Flight settings', exact: true })
        .click()
      await page.getByLabel(/^Motion/).selectOption('full')
      await expect(page.locator('.app-shell')).not.toHaveClass(/reduced-motion/)
      await page.getByLabel(/^Scenery detail/).selectOption('light')
      await page.getByLabel(/^Motion/).selectOption('reduced')
      await run(page)
      const dimensions = await page
        .locator('canvas')
        .evaluate((c) => [c.width, Math.round(c.getBoundingClientRect().width)])
      assert.equal(
        dimensions[0],
        dimensions[1],
        'Light scenery draws at CSS pixel resolution',
      )
      await page.keyboard.press('Escape')
      await run(page)
      const initial = await paints(page)
      await run(page, 1000)
      assert.equal(
        await paints(page),
        initial,
        'Reduced-motion welcome must remain still',
      )
      await page.reload({ waitUntil: 'networkidle' })
      await run(page)
      await page
        .getByRole('button', { name: 'Flight settings', exact: true })
        .click()
      await expect(page.getByLabel(/^Scenery detail/)).toHaveValue('light')
      await expect(page.getByLabel(/^Motion/)).toHaveValue('reduced')
    },
  )
  await scenario(
    'pointer-buttons-shortcuts-and-retry-focus',
    { width: 1280, height: 950 },
    async (page) => {
      await fly(page)
      await expect(page.locator('canvas')).toBeFocused()
      const c = await page.locator('canvas').boundingBox()
      await page.mouse.click(c.x + c.width * 0.5, c.y + c.height * 0.5, {
        button: 'right',
      })
      await run(page)
      await expect(page.locator('.dive-button')).toHaveAttribute(
        'aria-pressed',
        'false',
      )
      await page.keyboard.down('Space')
      await run(page)
      await expect(page.locator('.dive-button')).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await page.evaluate(() => window.dispatchEvent(new Event('blur')))
      await page.keyboard.up('Space')
      await run(page)
      await expect(page.locator('.pause-reason')).toContainText(
        'while you were away',
      )
      await page
        .getByRole('button', { name: 'Keep flying', exact: true })
        .click()
      await run(page)
      await expect(page.locator('.dive-button')).toHaveAttribute(
        'aria-pressed',
        'false',
      )
      await page.keyboard.press('KeyM')
      await run(page)
      assert.equal(
        await page.evaluate(
          () => JSON.parse(localStorage.getItem('sunwake.progress.v1')).sound,
        ),
        true,
      )
      await page.keyboard.press('KeyM')
      await run(page)
      await finish(page)
      const seed = await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem('sunwake.progress.v1')).history[0]
            .seed,
      )
      await page.locator('canvas').focus()
      await page.keyboard.press('Space')
      await run(page, 300)
      await expect(page.locator('canvas')).toBeFocused()
      await finish(page)
      const history = await page.evaluate(
        () => JSON.parse(localStorage.getItem('sunwake.progress.v1')).history,
      )
      assert.equal(
        history[0].seed,
        seed,
        'Space after results should retry the same course',
      )
    },
  )
  await scenario(
    'controller-handoff-cannot-auto-resume',
    { width: 1280, height: 950 },
    async (page) => {
      await page.evaluate(() => {
        window.pads = [[], []]
        Object.defineProperty(navigator, 'getGamepads', {
          configurable: true,
          value: () =>
            window.pads.map(
              (pressed, index) =>
                pressed && {
                  index,
                  connected: true,
                  mapping: 'standard',
                  buttons: Array.from({ length: 16 }, (_, i) => ({
                    pressed: pressed.includes(i),
                    value: Number(pressed.includes(i)),
                  })),
                },
            ),
        })
      })
      await run(page)
      await fly(page)
      await page.evaluate(() => {
        window.pads = [null, [0, 9]]
      })
      await run(page)
      await expect(page.locator('.pause-card')).toBeVisible()
      await expect(page.locator('.pause-reason')).toContainText(
        'controller disconnected',
      )
      await run(page, 1000)
      await expect(page.locator('.pause-card')).toBeVisible()
      await page.evaluate(() => {
        window.pads = [null, []]
      })
      await run(page)
      await page.evaluate(() => {
        window.pads = [null, [9]]
      })
      await run(page)
      await expect(page.locator('.flight-stage')).toHaveClass(/phase-running/)
    },
  )
  for (const width of [320, 390])
    await scenario(
      `mobile-comfort-${width}`,
      { width, height: 844 },
      async (page) => {
        await page
          .getByRole('button', { name: 'Open the Sun Atlas', exact: true })
          .scrollIntoViewIfNeeded()
        await page
          .getByRole('button', { name: 'Open the Sun Atlas', exact: true })
          .click()
        await page
          .getByRole('button', { name: 'Fly this expedition', exact: true })
          .click()
        await run(page, 300)
        await expect(page.locator('canvas')).toBeFocused()
        const box = await page.locator('.flight-stage').boundingBox()
        assert.ok(
          box.y >= -1 && box.y + box.height <= 845,
          'Embarking from below the game must reveal the whole stage',
        )
        await page
          .getByRole('button', { name: 'Flight settings', exact: true })
          .click()
        await page.getByLabel(/^Motion/).selectOption('reduced')
        await page.getByRole('dialog').evaluate((d) => {
          d.scrollTop = d.scrollHeight
        })
        await expect(
          page.getByRole('button', { name: 'Close dialog', exact: true }),
        ).toBeInViewport()
        assert.equal(
          await page.evaluate(() => document.body.style.overflow),
          'hidden',
        )
        await page
          .getByRole('button', { name: 'Close dialog', exact: true })
          .click()
        assert.notEqual(
          await page.evaluate(() => document.body.style.overflow),
          'hidden',
        )
        await page
          .getByRole('button', { name: 'Keep flying', exact: true })
          .click()
        await run(page)
        await page.screenshot({
          path: `qa/artifacts/polish-mobile-${width}-verified.png`,
        })
        await page.evaluate(() => scrollTo(0, document.body.scrollHeight))
        await page.waitForTimeout(100)
        await run(page)
        await expect(page.locator('.pause-reason')).toContainText('out of view')
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        )
      },
      true,
    )
  await scenario(
    'fullscreen-settings-and-safe-exit',
    { width: 844, height: 390 },
    async (page) => {
      await page
        .getByRole('button', { name: 'Enter fullscreen', exact: true })
        .click()
      await expect(
        page.getByRole('button', { name: 'Exit fullscreen', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true')
      await fly(page)
      await page
        .getByRole('button', { name: 'Flight settings', exact: true })
        .click()
      await page.getByLabel(/^Scenery detail/).selectOption('light')
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Keep flying', exact: true })
        .click()
      await run(page)
      await page
        .getByRole('button', { name: 'Exit fullscreen', exact: true })
        .click()
      await run(page)
      await expect(page.locator('.pause-reason')).toContainText(
        'Fullscreen closed',
      )
      await expect(
        page.getByRole('button', { name: 'Enter fullscreen', exact: true }),
      ).toBeVisible()
      await expect(
        page.getByRole('button', { name: 'Keep flying', exact: true }),
      ).toBeInViewport()
      await expect(
        page.getByRole('button', { name: 'Keep flying', exact: true }),
      ).toBeFocused()
      await page.screenshot({
        path: 'qa/artifacts/polish-fullscreen-exit-verified.png',
      })
      await page.keyboard.press('Space')
      await run(page)
      await expect(page.locator('.flight-stage')).toHaveClass(/phase-running/)
      await expect(page.locator('.dive-button')).toBeInViewport()
      await finish(page)
      await expect(
        page.getByRole('button', { name: 'One more horizon', exact: true }),
      ).toBeInViewport()
      await page.screenshot({
        path: 'qa/artifacts/polish-landscape-results-verified.png',
      })
    },
    true,
  )
  await scenario(
    'modal-drag-and-audio-suspension',
    { width: 1280, height: 950 },
    async (page) => {
      await page
        .getByRole('button', { name: 'Enable sound', exact: true })
        .click()
      await fly(page)
      await run(page, 400)
      await expect
        .poll(() => page.evaluate(() => window.testAudio.at(-1)?.state))
        .toBe('running')
      await page.keyboard.press('KeyP')
      await run(page, 600)
      await expect
        .poll(() => page.evaluate(() => window.testAudio.at(-1)?.state))
        .toBe('suspended')
      await page
        .getByRole('button', { name: 'Keep flying', exact: true })
        .click()
      await run(page)
      await expect
        .poll(() => page.evaluate(() => window.testAudio.at(-1)?.state))
        .toBe('running')
      await page.getByRole('button', { name: 'How to fly' }).click()
      const box = await page.getByRole('dialog').boundingBox()
      await page.mouse.move(box.x + 60, box.y + 100)
      await page.mouse.down()
      await page.mouse.move(5, 5)
      await page.mouse.up()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.mouse.click(5, 5)
      await expect(page.getByRole('dialog')).toHaveCount(0)
    },
  )
  await scenario(
    'hidden-flight-sleeps-until-explicit-resume',
    { width: 1280, height: 950 },
    async (page) => {
      await fly(page)
      await run(page, 500)
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', {
          configurable: true,
          value: true,
        })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await expect(page.locator('.pause-card')).toBeVisible()
      const initial = await paints(page)
      const stopped = await distance(page)
      await run(page, 2000)
      assert.equal(await paints(page), initial, 'Hidden tabs cannot draw')
      assert.equal(await distance(page), stopped)
      await page.evaluate(() => {
        delete document.hidden
        document.dispatchEvent(new Event('visibilitychange'))
      })
      await run(page, 1000)
      assert.equal(
        await distance(page),
        stopped,
        'Returning to the tab must not silently resume',
      )
      await page
        .getByRole('button', { name: 'Keep flying', exact: true })
        .click()
      await run(page, 500)
      assert.notEqual(await distance(page), stopped)
    },
  )
  await scenario(
    'slow-render-frames-preserve-flight-speed',
    { width: 1280, height: 950 },
    async (page) => {
      // Deliver frames every 64 ms, while retaining cancellable animation requests.
      // The old app-level 50 ms clamp made the game run in slow motion here.
      await page.evaluate(() => {
        const request = window.requestAnimationFrame.bind(window)
        const cancel = window.cancelAnimationFrame.bind(window)
        const pending = new Map()
        let next = 1_000_000
        window.requestAnimationFrame = (callback) => {
          const id = next++
          let remaining = 4
          const tick = (now) => {
            if (--remaining > 0) pending.set(id, request(tick))
            else {
              pending.delete(id)
              callback(now)
            }
          }
          pending.set(id, request(tick))
          return id
        }
        window.cancelAnimationFrame = (id) => {
          cancel(pending.get(id) ?? id)
          pending.delete(id)
        }
      })
      await fly(page)
      await run(page, 10000)
      await finish(page)
      const duration = await page.evaluate(
        () => JSON.parse(localStorage.getItem('sunwake.ghosts.v2'))[0].duration,
      )
      assert.ok(
        duration > 9.8 && duration < 10.4,
        `10 seconds of wall time must stay about 10 seconds of flight, got ${duration}`,
      )
    },
  )
} finally {
  await browser.close()
}
assert.ok(count > 0, 'No scenarios matched')
assert.deepEqual(errors, [], 'Browser console must stay clean')
assert.deepEqual(failures, [], 'Polish regression checks must pass')
console.log(`${count} polish scenarios passed.`)
