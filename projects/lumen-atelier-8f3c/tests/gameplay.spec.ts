import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { LEVELS, dailyLevel, generateLevel } from '../src/game'
import type { Level } from '../src/game'
import { DEFAULT_PROGRESS, STORAGE_KEY } from '../src/progress'

const errors = new WeakMap<Page, string[]>()
test.beforeEach(async ({ page }) => {
  errors.set(page, [])
  page.on('pageerror', error => errors.get(page)!.push(error.message))
})
test.afterEach(async ({ page }) => {
  expect(errors.get(page), 'No uncaught browser errors').toEqual([])
})

async function openLevel(page: Page, level: Level, route = `play/${level.id}`) {
  await page.goto(`/#/${route}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(level.title)
  await expect(page.locator('.garden-board')).toBeVisible()
}

/** Exercise the real SVG pointer targets; never set game state to a winning board. */
async function solveWithClicks(page: Page, level: Level) {
  for (const stone of level.tiles) {
    if (await page.locator('.garden-complete').count()) break
    if (stone.fixed) continue
    const period = stone.kind === 'straight' ? 2 : 4
    const clicks = ((level.solution[stone.id] - stone.rotation) % period + period) % period
    for (let click = 0; click < clicks; click++) {
      if (await page.locator('.garden-complete').count()) break
      await page.locator(`[data-tile-id="${stone.id}"] .tile-hit`).click()
    }
  }
  await expect(page.getByRole('heading', { name: 'A garden, reborn.', exact: true })).toBeVisible()
  await expect(page.locator('.garden-board [role="button"]').first()).toHaveAttribute('aria-disabled', 'true')
}

async function savedProgress(page: Page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{}'), STORAGE_KEY)
}

test('the first garden completes through clicks, awards blooms, and survives a reload', async ({ page }, testInfo) => {
  await openLevel(page, LEVELS[0])
  await page.screenshot({ path: testInfo.outputPath('first-garden-desktop.png'), fullPage: true })
  await solveWithClicks(page, LEVELS[0])
  await expect.poll(async () => (await savedProgress(page)).completed['level-01']?.stars).toBe(3)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'A garden, reborn.', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Garden 1: A Small Awakening, restored', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Next garden', exact: true }).click()
  await expect(page).toHaveURL(/#\/play\/level-02$/)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(LEVELS[1].title)
  await expect(page.getByTestId('move-count')).toHaveText('00')
})

for (const [index, mechanic] of [[24, 'one-way gates'], [32, 'isolated bridges'], [40, 'paired portals']] as const) {
  test(`a complete ${mechanic} garden works through actual pointer clicks`, async ({ page }, testInfo) => {
    const level = LEVELS[index]
    await openLevel(page, level)
    await solveWithClicks(page, level)
    await expect.poll(async () => Boolean((await savedProgress(page)).completed[level.id])).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`completed-${index + 1}.png`), fullPage: true })
  })
}

test('undo, reverse rotation, keyboard controls, restart, and two-step hints work', async ({ page }) => {
  await openLevel(page, LEVELS[0])
  const stone = LEVELS[0].tiles.find(item => !item.fixed)!
  const target = page.locator(`[data-tile-id="${stone.id}"] .tile-hit`)
  const initialLabel = await target.getAttribute('aria-label')
  await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled()
  await target.click()
  await expect(page.getByTestId('move-count')).toHaveText('01')
  await target.click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('move-count')).toHaveText('02')
  await expect(target).toHaveAttribute('aria-label', initialLabel!)
  await page.getByRole('button', { name: /^Undo/ }).click()
  await expect(page.getByTestId('move-count')).toHaveText('01')
  await page.keyboard.press('z')
  await expect(page.getByTestId('move-count')).toHaveText('00')
  await expect(target).toHaveAttribute('aria-label', initialLabel!)
  await target.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('move-count')).toHaveText('01')
  await page.keyboard.press('r')
  await expect(page.getByTestId('move-count')).toHaveText('00')
  await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled()
  await page.getByRole('button', { name: /A gentle nudge/ }).click()
  await expect(page.locator('.garden-tile--hint')).toHaveCount(1)
  await expect(page.getByTestId('move-count')).toHaveText('00')
  await page.getByRole('button', { name: /Turn this stone/ }).click()
  await expect(page.getByTestId('move-count')).not.toHaveText('00')
  const moves = await page.getByTestId('move-count').textContent()
  await page.reload()
  await expect(page.getByTestId('move-count')).toHaveText(moves!)
  await page.getByRole('button', { name: /^Restart/ }).click()
  await expect(page.getByTestId('move-count')).toHaveText('00')
})

test('settings persist, invalid imports are harmless, and backups merge existing progress', async ({ page }) => {
  await openLevel(page, LEVELS[0])
  await solveWithClicks(page, LEVELS[0])
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('switch', { name: 'Reduce motion' }).click()
  await dialog.getByRole('switch', { name: 'Stronger contrast' }).click()
  await dialog.getByRole('switch', { name: 'Sound effects' }).click()
  await dialog.getByLabel('Paste a progress backup').fill('{"broken":true}')
  await dialog.getByRole('button', { name: 'Import and keep existing progress' }).click()
  await expect(page.locator('.toast')).toContainText('That backup could not be read')
  const before = await savedProgress(page)
  expect(before.completed['level-01'].stars).toBe(3)
  const imported = { ...DEFAULT_PROGRESS, completed: {
    'level-01': { moves: 500, stars: 1, hints: 20, date: '2026-09-24' },
    'level-02': { moves: 10, stars: 2, hints: 0, date: '2026-09-24' },
  } }
  await dialog.getByLabel('Paste a progress backup').fill(JSON.stringify(imported))
  await dialog.getByRole('button', { name: 'Import and keep existing progress' }).click()
  await expect(page.locator('.toast')).toContainText('Your gardens are safely restored')
  const after = await savedProgress(page)
  expect(after.completed['level-01']).toMatchObject({ stars: before.completed['level-01'].stars, moves: before.completed['level-01'].moves, hints: before.completed['level-01'].hints })
  expect(after.completed['level-02'].stars).toBe(2)
  await dialog.getByRole('button', { name: 'Export progress' }).click()
  await expect(dialog.getByLabel('Copy this backup or garden link')).toHaveValue(/level-01/)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.app-shell')).toHaveClass(/reduce-motion/)
  await expect(page.locator('.app-shell')).toHaveClass(/high-contrast/)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('switch', { name: 'Sound effects' })).toHaveAttribute('aria-checked', 'false')
})

test('finishing the final garden unlocks the ending and 48 completed records remain after reload', async ({ page }) => {
  await openLevel(page, LEVELS[47])
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const completed = Object.fromEntries(LEVELS.slice(0, 47).map(level => [level.id, { moves: level.par, stars: 3, hints: 0, date: '2026-09-24' }]))
  await page.getByLabel('Paste a progress backup').fill(JSON.stringify({ ...DEFAULT_PROGRESS, completed }))
  await page.getByRole('button', { name: 'Import and keep existing progress' }).click()
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await solveWithClicks(page, LEVELS[47])
  await page.getByRole('button', { name: 'Read the final memory' }).click()
  await expect(page.getByRole('heading', { name: 'The keeper was always you.' })).toBeVisible()
  await expect.poll(async () => Object.keys((await savedProgress(page)).completed).length).toBe(48)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'The keeper was always you.' })).toBeVisible()
  await page.getByRole('button', { name: /Collected blooms/ }).click()
  await expect(page.getByRole('dialog')).toContainText('144 of 144 campaign blooms collected')
  await expect(page.getByRole('dialog')).toContainText('A perfect constellation')
})

test('daily, workshop, shareable seed routes, and browser back navigation work', async ({ page }, testInfo) => {
  const daily = dailyLevel('2026-09-24')
  await openLevel(page, daily, 'daily/2026-09-24')
  await expect(page.locator('.breadcrumb')).toContainText('2026-09-24')
  await solveWithClicks(page, daily)
  expect((await savedProgress(page)).completed[daily.id]).toBeTruthy()
  await page.getByRole('button', { name: 'Workshop', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Make room for wonder.' })).toBeVisible()
  await page.getByLabel('Garden style').selectOption('5')
  await page.getByLabel('Seed number').fill('4294967296')
  await page.getByRole('button', { name: 'Grow this garden' }).click()
  await expect(page.locator('.toast')).toContainText('Choose a seed from 0')
  await page.getByLabel('Seed number').fill('314159')
  await page.screenshot({ path: testInfo.outputPath('workshop.png'), fullPage: true })
  await page.getByRole('button', { name: 'Grow this garden' }).click()
  await expect(page).toHaveURL(/#\/seed\/314159\/5$/)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(generateLevel(314159, 5).title)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(generateLevel(314159, 5).title)
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Make room for wonder.' })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(daily.title)
  expect((await savedProgress(page)).completed[daily.id]).toBeTruthy()
})

test('field guide supports keyboard close and all six atlas chapters are open', async ({ page }, testInfo) => {
  await openLevel(page, LEVELS[0])
  await page.getByRole('button', { name: 'How to play', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('One-way gates')
  await expect(page.getByRole('dialog')).toContainText('Portals')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Close dialog' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: 'Lumen, all gardens' }).click()
  await expect(page.getByRole('heading', { name: 'A world waiting for light.' })).toBeVisible()
  await expect(page.locator('.chapter-card')).toHaveCount(6)
  await page.screenshot({ path: testInfo.outputPath('atlas.png'), fullPage: true })
  await page.getByRole('button', { name: 'Explore The Far Gardens' }).click()
  await page.locator('.card-level-list button').last().click()
  await expect(page).toHaveURL(/#\/play\/level-48$/)
})

test('mobile layout keeps the board, toolbar, navigation, and dialogs usable without horizontal overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openLevel(page, LEVELS[0])
  await expect(page.getByRole('button', { name: /^Restart/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /A gentle nudge/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('first-garden-mobile.png'), fullPage: true })
  const stone = LEVELS[0].tiles.find(item => !item.fixed)!
  await page.locator(`[data-tile-id="${stone.id}"] .tile-hit`).click()
  await expect(page.getByTestId('move-count')).toHaveText('01')
  await page.getByRole('button', { name: /^Restart/ }).click()
  await page.getByRole('button', { name: 'Toggle chapter list' }).click()
  await expect(page.locator('.chapter-list')).toBeVisible()
  await page.locator('.chapter-button').last().click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(LEVELS[40].title)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Close dialog' }).click()
  await page.getByRole('button', { name: 'Workshop', exact: true }).click()
  await expect(page.getByLabel('Seed number')).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('an initial campaign deep link becomes the resumed journey and preserves in-progress turns', async ({ page }) => {
  const level = LEVELS[24]
  await openLevel(page, level)
  await expect.poll(async () => (await savedProgress(page)).currentLevel).toBe(level.id)
  const movable = level.tiles.filter(stone => !stone.fixed).slice(0, 3)
  for (const stone of movable) await page.locator(`[data-tile-id="${stone.id}"] .tile-hit`).click()
  await expect(page.getByTestId('move-count')).toHaveText('03')
  const labels = await Promise.all(movable.map(stone => page.locator(`[data-tile-id="${stone.id}"] .tile-hit`).getAttribute('aria-label')))
  await page.getByRole('button', { name: 'Lumen, all gardens' }).click()
  await page.getByRole('button', { name: 'The journey', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`#/play/${level.id}$`))
  await expect(page.getByTestId('move-count')).toHaveText('03')
  await page.reload()
  await expect(page.getByTestId('move-count')).toHaveText('03')
  // Returning without any hash must resume the deep-linked garden, not garden 1.
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText(level.title)
  await expect(page.getByTestId('move-count')).toHaveText('03')
  for (const [index, stone] of movable.entries()) {
    await expect(page.locator(`[data-tile-id="${stone.id}"] .tile-hit`)).toHaveAttribute('aria-label', labels[index]!)
  }
})

test('a session quota failure stays visible even when progress and settings save successfully', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key === 'lumen-garden-session-v1') throw new DOMException('Simulated session quota failure', 'QuotaExceededError')
      original.call(this, key, value)
    }
  })
  await openLevel(page, LEVELS[0])
  await expect(page.locator('.page-footer')).toContainText('Storage unavailable')
  expect((await savedProgress(page)).currentLevel).toBe('level-01')
  await page.getByRole('button', { name: 'Mute sound effects' }).click()
  await expect.poll(async () => (await savedProgress(page)).sound).toBe(false)
  await expect(page.locator('.page-footer')).toContainText('Storage unavailable')
  const stone = LEVELS[0].tiles.find(item => !item.fixed)!
  await page.locator(`[data-tile-id="${stone.id}"] .tile-hit`).click()
  await expect(page.getByTestId('move-count')).toHaveText('01')
  await expect(page.locator('.page-footer')).toContainText('Storage unavailable')
  expect(await page.evaluate(() => localStorage.getItem('lumen-garden-session-v1'))).toBeNull()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Enable sound effects' })).toBeVisible()
  await expect(page.locator('.page-footer')).toContainText('Storage unavailable')
})

test('saved ambience restores its controls without constructing audio before a player gesture', async ({ page }) => {
  await page.addInitScript(({ storageKey, progress }) => {
    localStorage.setItem(storageKey, JSON.stringify(progress))
    const metrics = window as Window & { __lumenAudioContexts: number }
    metrics.__lumenAudioContexts = 0
    window.AudioContext = new Proxy(window.AudioContext, {
      construct(target, argumentsList) {
        metrics.__lumenAudioContexts++
        return Reflect.construct(target, argumentsList)
      },
    })
  }, { storageKey: STORAGE_KEY, progress: { ...DEFAULT_PROGRESS, ambience: true, sound: false } })
  await openLevel(page, LEVELS[0])
  await expect(page.getByRole('button', { name: 'Pause garden ambience' })).toBeVisible()
  const audioContexts = () => page.evaluate(() => (window as Window & { __lumenAudioContexts: number }).__lumenAudioContexts)
  expect(await audioContexts()).toBe(0)
  expect((await savedProgress(page)).ambience).toBe(true)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('switch', { name: 'Garden ambience' })).toHaveAttribute('aria-checked', 'true')
  expect(await audioContexts()).toBe(0)
  await page.getByRole('button', { name: 'Close dialog' }).click()
  const stone = LEVELS[0].tiles.find(item => !item.fixed)!
  await page.locator(`[data-tile-id="${stone.id}"] .tile-hit`).click()
  await expect.poll(audioContexts).toBe(1)
})
