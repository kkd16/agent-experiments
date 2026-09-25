import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { LEVELS, rotateTile, simulate } from '../src/game.ts'
import { SESSION_LIBRARY_KEY, newSession, loadSession, saveSession, getSessionSummaries } from '../src/sessions.ts'

const LEGACY_KEY = 'lumen-garden-session-v1'
let values
beforeEach(() => {
  values = new Map()
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  }
})
const clone = value => JSON.parse(JSON.stringify(value))
const rotatable = tile => !tile.fixed && !['source', 'crystal', 'rock'].includes(tile.kind)
function turn(session) {
  const id = session.tiles.find(rotatable).id
  return { ...session, tiles: session.tiles.map(tile => tile.id === id ? rotateTile(tile) : tile), moves: session.moves + 1,
    history: [...session.history, { tiles: session.tiles, moves: session.moves }], future: [] }
}
function library() { return JSON.parse(values.get(SESSION_LIBRARY_KEY)) }
function mutateLibrary(mutate) {
  const saved = library()
  mutate(saved)
  values.set(SESSION_LIBRARY_KEY, JSON.stringify(saved))
}

test('fresh gardens are independent clones with empty undo and redo stacks', () => {
  const a = newSession(LEVELS[0])
  const b = loadSession(LEVELS[0])
  assert.deepEqual(a, b)
  a.tiles[0].rotation = (a.tiles[0].rotation + 1) % 4
  assert.notDeepEqual(a.tiles, b.tiles)
  assert.deepEqual(b.tiles, LEVELS[0].tiles)
  assert.deepEqual(a.history, [])
  assert.deepEqual(a.future, [])
  assert.equal(a.won, false)
})

test('different gardens retain independent arrangements and summary records', () => {
  const a = turn(newSession(LEVELS[0]))
  const b = turn(turn(newSession(LEVELS[8])))
  b.hints = 1
  assert.equal(saveSession(a), true)
  assert.equal(saveSession(b), true)
  assert.deepEqual(loadSession(LEVELS[0]).tiles, a.tiles)
  assert.deepEqual(loadSession(LEVELS[8]).tiles, b.tiles)
  assert.equal(loadSession(LEVELS[0]).moves, 1)
  assert.equal(loadSession(LEVELS[8]).moves, 2)
  const summaries = getSessionSummaries()
  assert.equal(summaries[a.level.id].moves, 1)
  assert.equal(summaries[b.level.id].hints, 1)
  assert.ok(Number.isFinite(Date.parse(summaries[a.level.id].updatedAt)))
})

test('undo and redo stacks, hint penalty, and pending hint round-trip', () => {
  const initial = newSession(LEVELS[16])
  const first = turn(initial)
  const second = turn(first)
  const current = { ...first, future: [{ tiles: second.tiles, moves: second.moves }], hints: 2,
    hintId: first.tiles.find(rotatable).id, hintRotation: 2 }
  assert.equal(saveSession(current), true)
  const loaded = loadSession(initial.level)
  assert.deepEqual(loaded.history, current.history)
  assert.deepEqual(loaded.future, current.future)
  assert.deepEqual(loaded.tiles, current.tiles)
  assert.equal(loaded.hints, 2)
  assert.equal(loaded.hintId, current.hintId)
  assert.equal(loaded.hintRotation, 2)
  assert.notEqual(loaded.history[0].tiles, current.history[0].tiles)
  assert.equal(saveSession({ ...loaded, ...loaded.future.at(-1), history: [...loaded.history, { tiles: loaded.tiles, moves: loaded.moves }], future: [] }), true)
  assert.deepEqual(loadSession(initial.level).tiles, second.tiles)
})

test('locked rotations and all tile geometry come only from canonical level data', () => {
  const level = LEVELS[24]
  assert.equal(saveSession(turn(newSession(level))), true)
  mutateLibrary(saved => {
    const entry = saved.gardens[level.id]
    entry.rotations = entry.rotations.map((rotation, index) => level.tiles[index].fixed ? (rotation + 1) % 4 : rotation)
    entry.history[0].rotations = entry.rotations
    entry.tiles = [{ id: 'injected', kind: 'source', x: 0, y: 0, rotation: 0 }]
    entry.won = true
    entry.hintId = level.tiles.find(tile => tile.fixed).id
    entry.hintRotation = 1
  })
  const loaded = loadSession(level)
  assert.equal(loaded.won, simulate(loaded.tiles).solved)
  assert.equal(loaded.hintId, null)
  for (let index = 0; index < level.tiles.length; index++) {
    const canonical = level.tiles[index]
    assert.deepEqual({ ...loaded.tiles[index], rotation: canonical.rotation }, canonical)
    if (canonical.fixed) {
      assert.equal(loaded.tiles[index].rotation, canonical.rotation)
      assert.equal(loaded.history[0].tiles[index].rotation, canonical.rotation)
    }
  }
})

test('solved status is recomputed and completed gardens survive reload', () => {
  const level = LEVELS[0]
  const session = newSession(level)
  session.tiles = level.tiles.map(tile => ({ ...tile, rotation: level.solution[tile.id] }))
  session.moves = level.par
  session.won = false
  assert.equal(saveSession(session), true)
  const loaded = loadSession(level)
  assert.equal(loaded.won, true)
  assert.equal(getSessionSummaries()[level.id].won, true)
  assert.equal(loaded.moves, level.par)
})

test('malformed JSON, entry fields, and prototype keys cannot poison other saves', () => {
  for (const bad of ['{broken', 'null', '[]', '{"version":1,"gardens":{}}']) {
    values.set(SESSION_LIBRARY_KEY, bad)
    assert.deepEqual(loadSession(LEVELS[0]), newSession(LEVELS[0]))
    assert.deepEqual(getSessionSummaries(), {})
  }
  saveSession(turn(newSession(LEVELS[0])))
  saveSession(turn(newSession(LEVELS[1])))
  mutateLibrary(saved => {
    saved.gardens[LEVELS[0].id].rotations[0] = 9
    saved.gardens.constructor = clone(saved.gardens[LEVELS[1].id])
  })
  assert.equal(loadSession(LEVELS[0]).moves, 0)
  assert.equal(loadSession(LEVELS[1]).moves, 1)
  assert.deepEqual(Object.keys(getSessionSummaries()), [LEVELS[1].id])
  assert.equal(saveSession(turn(newSession(LEVELS[2]))), true)
  assert.equal(loadSession(LEVELS[1]).moves, 1)
})

test('a malformed undo or redo stack is discarded without losing current play', () => {
  const session = turn(turn(newSession(LEVELS[0])))
  session.future = [{ tiles: session.tiles, moves: 3 }]
  saveSession(session)
  mutateLibrary(saved => {
    saved.gardens[session.level.id].history[0].rotations = [0]
    saved.gardens[session.level.id].future[0].moves = -1
  })
  const loaded = loadSession(session.level)
  assert.equal(loaded.moves, 2)
  assert.deepEqual(loaded.tiles, session.tiles)
  assert.deepEqual(loaded.history, [])
  assert.deepEqual(loaded.future, [])
})

test('canonical layout, original rotation, lock, or solution changes invalidate stale sessions', () => {
  const level = LEVELS[16]
  saveSession(turn(newSession(level)))
  const variants = [
    { ...level, size: level.size + 1 },
    { ...level, tiles: level.tiles.map((tile, index) => index ? tile : { ...tile, x: tile.x + 1 }) },
    { ...level, tiles: level.tiles.map((tile, index) => index ? tile : { ...tile, rotation: (tile.rotation + 1) % 4 }) },
    { ...level, tiles: level.tiles.map((tile, index) => index ? tile : { ...tile, fixed: !tile.fixed }) },
    { ...level, solution: { ...level.solution, [level.tiles[0].id]: (level.solution[level.tiles[0].id] + 1) % 4 } },
  ]
  for (const changed of variants) {
    assert.equal(loadSession(changed).moves, 0)
    assert.deepEqual(loadSession(changed).tiles, changed.tiles)
  }
  assert.equal(loadSession(level).moves, 1)
})

test('legacy active save migrates once while retaining other library gardens', () => {
  const legacy = turn(turn(newSession(LEVELS[0])))
  values.set(LEGACY_KEY, JSON.stringify({ id: legacy.level.id, rotations: legacy.tiles.map(tile => tile.rotation), moves: legacy.moves, hints: 1 }))
  saveSession(turn(newSession(LEVELS[8])))
  assert.equal(loadSession(LEVELS[8]).moves, 1)
  assert.ok(values.has(LEGACY_KEY))
  const migrated = loadSession(legacy.level)
  assert.deepEqual(migrated.tiles, legacy.tiles)
  assert.equal(migrated.moves, 2)
  assert.equal(migrated.hints, 1)
  assert.deepEqual(migrated.history, [])
  assert.deepEqual(migrated.future, [])
  assert.equal(values.has(LEGACY_KEY), false)
  assert.equal(loadSession(LEVELS[8]).moves, 1)
  assert.equal(loadSession(legacy.level).moves, 2)
})

test('failed migration keeps legacy data and quota failures preserve the previous library', () => {
  const original = turn(newSession(LEVELS[0]))
  saveSession(original)
  const savedText = values.get(SESSION_LIBRARY_KEY)
  const legacy = turn(newSession(LEVELS[1]))
  values.set(LEGACY_KEY, JSON.stringify({ id: legacy.level.id, rotations: legacy.tiles.map(tile => tile.rotation), moves: 1, hints: 0 }))
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError') }
  assert.equal(saveSession(turn(original)), false)
  assert.equal(values.get(SESSION_LIBRARY_KEY), savedText)
  assert.equal(loadSession(original.level).moves, 1)
  assert.equal(loadSession(legacy.level).moves, 1)
  assert.ok(values.has(LEGACY_KEY))
})

test('disabled storage and invalid main snapshots fail safely', () => {
  globalThis.localStorage.getItem = () => { throw new Error('Storage is disabled') }
  assert.deepEqual(loadSession(LEVELS[0]), newSession(LEVELS[0]))
  assert.deepEqual(getSessionSummaries(), {})
  assert.equal(saveSession(newSession(LEVELS[0])), false)
  globalThis.localStorage.getItem = key => values.get(key) ?? null
  const invalid = newSession(LEVELS[0])
  invalid.tiles.pop()
  assert.equal(saveSession(invalid), false)
  assert.equal(saveSession({ ...newSession(LEVELS[0]), moves: -1 }), false)
  assert.equal(saveSession({ ...newSession(LEVELS[0]), hints: Infinity }), false)
})

test('history and redo retain their newest 100 states', () => {
  const session = turn(newSession(LEVELS[0]))
  session.history = Array.from({ length: 150 }, (_, moves) => ({ tiles: session.tiles, moves }))
  session.future = Array.from({ length: 130 }, (_, moves) => ({ tiles: session.tiles, moves: moves + 150 }))
  saveSession(session)
  const loaded = loadSession(session.level)
  assert.equal(loaded.history.length, 100)
  assert.equal(loaded.history[0].moves, 50)
  assert.equal(loaded.history.at(-1).moves, 149)
  assert.equal(loaded.future.length, 100)
  assert.equal(loaded.future[0].moves, 180)
  assert.equal(loaded.future.at(-1).moves, 279)
})

test('garden library is bounded to 200 entries and keeps recently saved gardens', () => {
  for (let index = 0; index < 205; index++) {
    assert.equal(saveSession(turn(newSession({ ...LEVELS[0], id: `bounded-${index}` }))), true)
  }
  const summaries = getSessionSummaries()
  assert.equal(Object.keys(summaries).length, 200)
  assert.ok(summaries['bounded-204'])
  assert.equal(summaries['bounded-0'], undefined)
  const revisited = { ...LEVELS[0], id: 'bounded-5' }
  saveSession(turn(loadSession(revisited)))
  saveSession(newSession({ ...LEVELS[0], id: 'bounded-205' }))
  assert.equal(getSessionSummaries()['bounded-5'].moves, 2)
  assert.equal(Object.keys(getSessionSummaries()).length, 200)
})
