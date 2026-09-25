import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { dailySeed, freshProgress, loadProgress, MISSIONS, saveProgress, settleRun } from '../src/game/progress.ts'

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const key = 'sunwake.progress.v1'
let storage

beforeEach(() => {
  storage = new Map()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  })
})

after(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else delete globalThis.localStorage
})

const run = (overrides = {}) => ({
  phase: 'ended', mode: 'voyage', seed: 42, time: 30, perfectLandings: 0, skyChains: 0, distance: 1000, score: 4000, sparks: 20,
  rings: 10, cleanLandings: 8, maxAirtime: 7, bestCombo: 10, boosts: 6, nearMisses: 6,
  ...overrides,
})

test('new players get a silent game, the free Sol, and no invented records', () => {
  assert.deepEqual(loadProgress(), freshProgress())
  const progress = freshProgress()
  assert.equal(progress.sound, false)
  assert.deepEqual(progress.owned, ['sol'])
  assert.equal(progress.bank, 0)
  assert.equal(progress.daily.date, new Date().toISOString().slice(0, 10))
})

test('malformed JSON, unexpected versions, and non-object saves recover safely', () => {
  for (const bad of ['{broken', 'null', '12', 'true', '[]', '{"version":2}', '{"version":"1"}']) {
    storage.set(key, bad)
    assert.deepEqual(loadProgress(), freshProgress())
  }
})

test('corrupt saves cannot select locked ships or inject unknown mission IDs', () => {
  storage.set(key, JSON.stringify({
    version: 1, bank: -300, best: '999', bestScore: null, totalDistance: 9.9, totalRuns: 1e99,
    owned: ['manta', 'manta', 'imaginary', 42], selected: 'comet', sound: 'true',
    completed: ['first-light', 'first-light', 'fake-mission', null],
    daily: { date: '2026-02-31', best: 1000 },
  }))
  const saved = loadProgress()
  assert.equal(saved.bank, 0)
  assert.equal(saved.best, 0)
  assert.equal(saved.bestScore, 0)
  assert.equal(saved.totalDistance, 9)
  assert.equal(saved.totalRuns, 1e12)
  assert.deepEqual(saved.owned, ['sol', 'manta'])
  assert.equal(saved.selected, 'sol')
  assert.deepEqual(saved.completed, ['first-light'])
  assert.equal(saved.sound, false)
  assert.equal(saved.daily.best, 0)
})

test('overflow and nonfinite numbers never load into records', () => {
  storage.set(key, '{"version":1,"bank":1e999,"best":-1e999,"bestScore":1e999}')
  const saved = loadProgress()
  assert.equal(saved.bank, 0)
  assert.equal(saved.best, 0)
  assert.equal(saved.bestScore, 0)
})

test('storage errors do not prevent play or throw during saves', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('Storage access denied') },
  })
  assert.deepEqual(loadProgress(), freshProgress())
  assert.doesNotThrow(() => saveProgress(freshProgress()))
})

test('progress round trips with independent ownership and mission state', () => {
  const expected = { ...freshProgress(), bank: 91, best: 3821, owned: ['sol', 'manta'], selected: 'manta', completed: ['first-light'], sound: true }
  saveProgress(expected)
  const actual = loadProgress()
  assert.deepEqual(actual, expected)
  actual.owned.push('comet')
  assert.deepEqual(loadProgress().owned, ['sol', 'manta'])
})

test('unfinished runs never award sparks, records, or missions', () => {
  for (const phase of ['ready', 'running', 'paused']) {
    const progress = freshProgress()
    const result = settleRun(progress, run({ phase }), '2026-09-24')
    assert.equal(result.progress, progress)
    assert.equal(result.earned, 0)
    assert.equal(result.newBest, false)
    assert.deepEqual(result.completed, [])
  }
})

test('only the first three incomplete missions are eligible, even on an exceptional run', () => {
  const progress = freshProgress()
  const result = settleRun(progress, run({ distance: 10000, sparks: 100 }), '2026-09-24')
  assert.deepEqual(result.completed.map(m => m.id), MISSIONS.slice(0, 3).map(m => m.id))
  assert.equal(result.earned, 100 + 25 + 25 + 30)
  assert.equal(result.progress.bank, result.earned)
  assert.equal(result.progress.totalRuns, 1)
  assert.equal(result.progress.best, 10000)
  assert.equal(result.newBest, true)
  assert.deepEqual(progress, freshProgress(), 'settlement must not mutate the caller state')
})

test('free flight tracks practice distance without awarding sparks, missions, or competitive records', () => {
  const progress = {
    ...freshProgress(), bank: 75, best: 1200, bestScore: 6000, totalDistance: 2000, totalRuns: 3,
    completed: ['first-light'], daily: { date: '2026-09-24', best: 1100 },
  }
  const before = structuredClone(progress)
  const result = settleRun(progress, run({ mode: 'zen', distance: 100000, sparks: 20000, score: 900000 }), '2026-09-25')
  assert.deepEqual(result.progress, { ...progress, totalDistance: 102000, totalRuns: 4, history: result.progress.history })
  assert.equal(result.progress.history[0].mode, 'zen')
  assert.equal(result.progress.history[0].distance, 100000)
  assert.equal(result.earned, 0)
  assert.deepEqual(result.completed, [])
  assert.equal(result.newBest, false)
  assert.deepEqual(progress, before)
})

test('completed missions never pay again, and new missions wait for the next run', () => {
  const first = settleRun(freshProgress(), run(), '2026-09-24')
  const second = settleRun(first.progress, run({ distance: 900 }), '2026-09-24')
  assert.deepEqual(second.completed.map(m => m.id), MISSIONS.slice(3, 6).map(m => m.id))
  assert.equal(second.earned, 20 + 40 + 40 + 50)
  assert.equal(second.progress.bank, first.progress.bank + second.earned)
  assert.equal(second.progress.totalDistance, 1900)
  assert.equal(second.progress.best, 1000)
  assert.equal(second.progress.totalRuns, 2)
  assert.equal(second.newBest, false)
})

test('a daily best belongs to its UTC date and only daily runs improve it', () => {
  const progress = { ...freshProgress(), daily: { date: '2026-09-24', best: 600 } }
  const voyage = settleRun(progress, run({ distance: 900 }), '2026-09-24')
  assert.deepEqual(voyage.progress.daily, { date: '2026-09-24', best: 600 })
  const daily = settleRun(progress, run({ mode: 'daily', distance: 900 }), '2026-09-24')
  assert.deepEqual(daily.progress.daily, { date: '2026-09-24', best: 900 })
  const nextDay = settleRun(daily.progress, run({ mode: 'daily', distance: 300 }), '2026-09-25')
  assert.deepEqual(nextDay.progress.daily, { date: '2026-09-25', best: 300 })
})

test('daily terrain seeds are repeatable, date-dependent unsigned integers', () => {
  assert.equal(dailySeed('2026-09-24'), dailySeed('2026-09-24'))
  assert.notEqual(dailySeed('2026-09-24'), dailySeed('2026-09-25'))
  assert.equal(dailySeed('2026-09-24') >>> 0, dailySeed('2026-09-24'))
})


test('old saves retain earned progress and receive new preference/history defaults', () => {
  storage.set(key, JSON.stringify({ version: 1, bank: 160, best: 2400, owned: ['sol', 'manta'], selected: 'manta', completed: ['first-light'] }))
  const saved = loadProgress()
  assert.equal(saved.bank, 160)
  assert.equal(saved.best, 2400)
  assert.equal(saved.selected, 'manta')
  assert.equal(saved.coach, true)
  assert.equal(saved.ghost, true)
  assert.deepEqual(saved.history, [])
})

test('flight history is bounded, ordered, reloadable, and rejects corrupt rows', () => {
  let progress = freshProgress()
  for (let i = 0; i < 20; i++) progress = settleRun(progress, run({ seed: i + 1, distance: 100 + i }), '2026-09-25').progress
  assert.equal(progress.history.length, 12)
  assert.equal(progress.history[0].seed, 20)
  saveProgress({ ...progress, history: [{ bad: true }, ...progress.history] })
  assert.deepEqual(loadProgress().history, progress.history)
})
