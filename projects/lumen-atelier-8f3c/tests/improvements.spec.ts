import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { LEVELS } from '../src/game'
import type { Level } from '../src/game'
import { decodeCustomLevel } from '../src/custom'
import { STORAGE_KEY } from '../src/progress'

const errors = new WeakMap<Page, string[]>()
test.beforeEach(async ({ page }) => {
  errors.set(page, [])
  page.on('pageerror', error => errors.get(page)!.push(error.message))
})
test.afterEach(async ({ page }) => {
  expect(errors.get(page), 'No uncaught browser errors').toEqual([])
})

const tileTarget = (page: Page, id: string) => page.locator(`[data-tile-id="${id}"] .tile-hit`)
const movable = (level: Level) => level.tiles.filter(tile => !tile.fixed && !['source', 'crystal', 'rock'].includes(tile.kind))
async function openGarden(page: Page, level: Level) {
  await page.goto(`/#/play/${level.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText(level.title)
}
async function openDesigner(page: Page) {
  await page.goto('/#/workshop')
  await page.getByRole('button', { name: /Design a garden/ }).click()
  await expect(page.getByRole('region', { name: 'Garden designer' })).toBeVisible()
}
async function solveByClicking(page: Page, level: Level) {
  for (const tile of movable(level)) {
    const period = tile.kind === 'straight' ? 2 : 4
    const turns = ((level.solution[tile.id] - tile.rotation) % period + period) % period
    for (let turn = 0; turn < turns; turn++) {
      if (await page.locator('.garden-complete').count()) break
      await tileTarget(page, tile.id).click()
    }
    if (await page.locator('.garden-complete').count()) break
  }
  await expect(page.getByRole('heading', { name: 'A garden, reborn.', exact: true })).toBeVisible()
}

test('each campaign garden remembers its arrangement and undo/redo when switching and reloading', async ({ page }) => {
  const first = LEVELS[0], second = LEVELS[1]
  await openGarden(page, first)
  const stone = movable(first)[0]
  await tileTarget(page, stone.id).click()
  const firstTurn = await tileTarget(page, stone.id).getAttribute('aria-label')
  await tileTarget(page, stone.id).click()
  const secondTurn = await tileTarget(page, stone.id).getAttribute('aria-label')
  await page.getByRole('button', { name: /^Undo/ }).click()
  await expect(page.getByTestId('move-count')).toHaveText('01')
  await expect(page.getByRole('button', { name: /^Redo/ })).toBeEnabled()
  await page.getByRole('button', { name: `Garden 2: ${second.title}`, exact: true }).click()
  await expect(page.getByTestId('move-count')).toHaveText('00')
  const otherStone = movable(second)[0]
  await tileTarget(page, otherStone.id).click()
  const otherTurn = await tileTarget(page, otherStone.id).getAttribute('aria-label')
  await page.reload()
  await expect(page.getByTestId('move-count')).toHaveText('01')
  await expect(tileTarget(page, otherStone.id)).toHaveAttribute('aria-label', otherTurn!)
  await expect(page.getByRole('button', { name: /^Undo/ })).toBeEnabled()
  await expect(page.getByRole('button', { name: /^Redo/ })).toBeDisabled()
  await page.getByRole('button', { name: 'Lumen, all gardens' }).click()
  const resumes = page.getByRole('region', { name: 'Unfinished gardens' })
  await expect(resumes).toContainText(first.title)
  await expect(resumes).toContainText(second.title)
  await resumes.getByRole('button', { name: new RegExp(first.title) }).click()
  await expect(page.getByTestId('move-count')).toHaveText('01')
  await expect(tileTarget(page, stone.id)).toHaveAttribute('aria-label', firstTurn!)
  await expect(page.getByRole('button', { name: /^Undo/ })).toBeEnabled()
  await expect(page.getByRole('button', { name: /^Redo/ })).toBeEnabled()
  await page.getByRole('button', { name: /^Redo/ }).click()
  await expect(page.getByTestId('move-count')).toHaveText('02')
  await expect(tileTarget(page, stone.id)).toHaveAttribute('aria-label', secondTurn!)
  await page.reload()
  await page.getByRole('button', { name: /^Undo/ }).click()
  await expect(page.getByTestId('move-count')).toHaveText('01')
  await page.reload()
  await expect(page.getByRole('button', { name: /^Redo/ })).toBeEnabled()
  await page.keyboard.press('y')
  await expect(page.getByTestId('move-count')).toHaveText('02')
  await expect(tileTarget(page, stone.id)).toHaveAttribute('aria-label', secondTurn!)
})

test('a new turn clears the redo branch and keyboard redo remains correct', async ({ page }) => {
  const level = LEVELS[8]
  await openGarden(page, level)
  const [first, second] = movable(level)
  await tileTarget(page, first.id).click()
  await tileTarget(page, first.id).click()
  await page.keyboard.press('z')
  await expect(page.getByTestId('move-count')).toHaveText('01')
  await page.keyboard.press('Shift+Z')
  await expect(page.getByTestId('move-count')).toHaveText('02')
  await page.keyboard.press('z')
  await expect(page.getByRole('button', { name: /^Redo/ })).toBeEnabled()
  await tileTarget(page, second.id).click()
  await expect(page.getByRole('button', { name: /^Redo/ })).toBeDisabled()
  await expect(page.getByTestId('move-count')).toHaveText('02')
  await page.reload()
  await expect(page.getByRole('button', { name: /^Redo/ })).toBeDisabled()
  await expect(page.getByRole('button', { name: /^Undo/ })).toBeEnabled()
  await page.keyboard.press('y')
  await expect(page.getByTestId('move-count')).toHaveText('02')
})

test('overhead and isometric views persist without changing stones or move counts', async ({ page }, testInfo) => {
  const level = LEVELS[40]
  await openGarden(page, level)
  const scene = page.locator('.garden-scene')
  await expect(scene).toHaveAttribute('data-view', 'isometric')
  await expect(scene).toHaveAttribute('data-chapter', '5')
  const stone = movable(level)[0]
  await tileTarget(page, stone.id).click()
  const label = await tileTarget(page, stone.id).getAttribute('aria-label')
  await page.getByRole('button', { name: 'Switch to overhead view', exact: true }).click()
  await expect(scene).toHaveAttribute('data-view', 'overhead')
  await expect(page.getByTestId('move-count')).toHaveText('01')
  await expect(tileTarget(page, stone.id)).toHaveAttribute('aria-label', label!)
  await page.reload()
  await expect(scene).toHaveAttribute('data-view', 'overhead')
  await expect(page.getByTestId('move-count')).toHaveText('01')
  await page.keyboard.press('v')
  await expect(scene).toHaveAttribute('data-view', 'isometric')
  await expect(page.getByTestId('move-count')).toHaveText('01')
  await expect(tileTarget(page, stone.id)).toHaveAttribute('aria-label', label!)
  await page.keyboard.press('v')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('overhead-mobile.png'), fullPage: true })
  await tileTarget(page, stone.id).click()
  await expect(page.getByTestId('move-count')).toHaveText('02')
  await page.reload()
  await expect(scene).toHaveAttribute('data-view', 'overhead')
  await expect(page.getByTestId('move-count')).toHaveText('02')
})

test('an invalid shared custom link safely opens the designer with an explanation', async ({ page }) => {
  await page.goto('/#/custom/bad')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Make room for wonder.')
  await expect(page.locator('.toast')).toContainText('This garden link is incomplete or invalid')
  await expect(page.getByRole('button', { name: /Design a garden/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('region', { name: 'Garden designer' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Test this garden' })).toBeEnabled()
})

test('a designer puzzle becomes a shareable custom route and is solvable through real clicks', async ({ page }, testInfo) => {
  await openDesigner(page)
  await expect(page.getByRole('heading', { name: 'A new garden is ready to awaken.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Test this garden' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Copy puzzle link' })).toBeEnabled()
  await page.getByLabel('Garden name').fill('The Paper Garden')
  await page.screenshot({ path: testInfo.outputPath('garden-designer-desktop.png'), fullPage: true })
  await page.getByRole('button', { name: 'Test this garden' }).click()
  await expect(page).toHaveURL(/#\/custom\/[A-Za-z0-9_-]+$/)
  const code = page.url().split('#/custom/')[1]
  const level = decodeCustomLevel(code)
  expect(level).not.toBeNull()
  expect(level!.title).toBe('The Paper Garden')
  await expect(page.getByRole('heading', { level: 1 })).toContainText(level!.title)
  await expect(page.getByTestId('move-count')).toHaveText('00')
  await page.getByRole('button', { name: 'Switch to overhead view' }).click()
  await solveByClicking(page, level!)
  await expect.poll(() => page.evaluate(({ key, id }) => JSON.parse(localStorage.getItem(key) || '{}').completed?.[id]?.stars, { key: STORAGE_KEY, id: level!.id })).toBe(3)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'A garden, reborn.', exact: true })).toBeVisible()
  await expect(page.locator('.garden-scene')).toHaveAttribute('data-view', 'overhead')
})

test('designer draft edits survive reload and invalid designs cannot be tested or shared', async ({ page }) => {
  await openDesigner(page)
  await page.getByLabel('Garden name').fill('A Map for Tomorrow')
  const source = LEVELS[0].tiles.find(tile => tile.kind === 'source')!
  const sourceName = new RegExp(`^Row ${source.y + 1}, column ${source.x + 1}:`)
  const sourceCell = page.getByRole('group', { name: '5 by 5 editable garden' }).getByRole('button', { name: sourceName })
  await page.getByRole('group', { name: 'Editing tool' }).getByRole('button', { name: 'Turn', exact: true }).click()
  await sourceCell.click()
  const editedLabel = await sourceCell.getAttribute('aria-label')
  await expect(page.getByRole('button', { name: 'Test this garden' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Copy puzzle link' })).toBeDisabled()
  await page.reload()
  await page.getByRole('button', { name: /Design a garden/ }).click()
  await expect(page.getByLabel('Garden name')).toHaveValue('A Map for Tomorrow')
  await expect(sourceCell).toHaveAttribute('aria-label', editedLabel!)
  await expect(page.getByRole('button', { name: 'Test this garden' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Copy puzzle link' })).toBeDisabled()
  await page.getByRole('button', { name: 'Load example' }).click()
  await expect(page.getByRole('button', { name: 'Test this garden' })).toBeEnabled()
  await page.getByRole('button', { name: 'Clear all stones' }).click()
  await expect(page.getByRole('button', { name: 'Test this garden' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Copy puzzle link' })).toBeDisabled()
  await expect(page.locator('.designer-validation')).toContainText('sun well')
  await page.getByRole('button', { name: 'Undo edit' }).click()
  await expect(page.getByRole('button', { name: 'Test this garden' })).toBeEnabled()
  await page.getByLabel('Garden name').fill('   ')
  await expect(page.locator('.designer-validation')).toContainText('Give your garden a name')
  await expect(page.getByRole('button', { name: 'Test this garden' })).toBeDisabled()
})

test('the designer supports mobile sizing and keyboard editing without horizontal overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openDesigner(page)
  const grid = page.getByRole('group', { name: '5 by 5 editable garden' })
  await expect(grid.getByRole('button')).toHaveCount(25)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const first = grid.getByRole('button').first()
  await first.focus()
  await page.keyboard.press('ArrowRight')
  await expect(grid.getByRole('button').nth(1)).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(grid.getByRole('button').nth(6)).toBeFocused()
  await page.getByRole('group', { name: 'Garden size' }).getByRole('button', { name: '7 × 7' }).click()
  await expect(page.getByRole('group', { name: '7 by 7 editable garden' }).getByRole('button')).toHaveCount(49)
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('garden-designer-mobile.png'), fullPage: true })
})


test('mobile quick brush changes stone type and orientation beside the drawing grid', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/#/workshop/design')
  await page.getByLabel('Quick stone choice').selectOption('gate')
  await page.getByRole('button', { name: 'Rotate quick brush', exact: true }).click()
  const empty = page.getByRole('button', { name: /^Row 1, column 1:/ })
  await empty.click()
  await expect(empty).toHaveAccessibleName(/Gate, sockets east and west/)
  await page.getByLabel('Quick stone choice').selectOption('portal')
  await page.getByLabel('Quick portal pair').selectOption('b')
  await empty.click()
  await expect(empty).toHaveAccessibleName(/Portal B/)
  await expect(page.getByRole('button', { name: 'Test this garden', exact: true })).toBeDisabled()
})
