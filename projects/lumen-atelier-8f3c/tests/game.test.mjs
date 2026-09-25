import test from 'node:test'
import assert from 'node:assert/strict'
import { CHAPTERS, LEVELS, ports, simulate, rotateTile, getHint, generateLevel, dailyLevel } from '../src/game.ts'

const tile = (id, x, y, kind, rotation = 0, extra = {}) => ({ id, x, y, kind, rotation, ...extra })
const solvedTiles = (level) => level.tiles.map((stone) => ({ ...stone, rotation: level.solution[stone.id] }))

test('48 complete campaign boards have valid solutions, stable IDs, and unsolved starts', () => {
  assert.equal(LEVELS.length, 48)
  assert.equal(CHAPTERS.length, 6)
  assert.equal(new Set(LEVELS.map((level) => level.id)).size, 48)
  for (const level of LEVELS) {
    assert.equal(level.chapter, Math.floor(level.index / 8))
    assert.equal(level.tiles.length, level.size ** 2)
    assert.equal(new Set(level.tiles.map((stone) => `${stone.x},${stone.y}`)).size, level.size ** 2)
    assert.equal(simulate(solvedTiles(level)).solved, true, `${level.id} is solvable`)
    assert.equal(simulate(level.tiles).solved, false, `${level.id} starts unfinished`)
    assert.ok(level.par > 0)
    for (const stone of level.tiles) {
      assert.ok(stone.x >= 0 && stone.x < level.size && stone.y >= 0 && stone.y < level.size)
      if (stone.fixed) assert.equal(stone.rotation, level.solution[stone.id])
      if (stone.kind === 'crystal' || stone.kind === 'source') assert.equal(stone.fixed, true)
    }
  }
})

test('every chapter actually introduces its promised mechanic', () => {
  for (const level of LEVELS) {
    const kinds = level.tiles.map((stone) => stone.kind)
    if (level.chapter > 0) assert.ok(kinds.includes('tee'))
    if (level.chapter >= 2) assert.ok(level.tiles.some((stone) => stone.fixed && ['straight', 'elbow', 'tee'].includes(stone.kind)))
    if (level.chapter >= 3) assert.ok(kinds.includes('gate'))
    if (level.chapter === 4) assert.ok(kinds.includes('bridge'))
    if (level.chapter === 5) assert.equal(kinds.filter((kind) => kind === 'portal').length, 2)
  }
})

test('ports rotate correctly and locked tiles are immutable', () => {
  assert.deepEqual(ports(tile('a', 0, 0, 'elbow')), [0, 1])
  assert.deepEqual(ports(tile('a', 0, 0, 'elbow', 3)), [3, 0])
  assert.deepEqual(ports(tile('a', 0, 0, 'straight', 1)), [1, 3])
  assert.deepEqual(ports(tile('a', 0, 0, 'rock')), [])
  const fixed = tile('a', 0, 0, 'tee', 1, { fixed: true })
  assert.equal(rotateTile(fixed), fixed)
  assert.equal(rotateTile(tile('a', 0, 0, 'elbow'), -1).rotation, 3)
  assert.equal(rotateTile(tile('a', 0, 0, 'elbow', 3)).rotation, 0)
})

test('light requires matching ports, and terminal crystals never transmit', () => {
  const source = tile('s', 0, 0, 'source')
  const crystal = tile('c', 2, 0, 'crystal')
  assert.equal(simulate([source, tile('p', 1, 0, 'straight', 1), crystal]).solved, true)
  assert.equal(simulate([source, tile('p', 1, 0, 'straight', 0), crystal]).solved, false)
  assert.equal(simulate([source, tile('p', 1, 0, 'crystal'), crystal]).litCrystals, 1)
  assert.equal(simulate([source]).solved, false)
})

test('directional gates accept light only from behind their arrow', () => {
  const source = tile('s', 0, 0, 'source')
  const crystal = tile('c', 2, 0, 'crystal')
  const forward = simulate([source, tile('g', 1, 0, 'gate', 1), crystal])
  assert.equal(forward.solved, true)
  assert.deepEqual([...forward.litPorts.get('g')].sort(), [1, 3])
  const backward = simulate([source, tile('g', 1, 0, 'gate', 3), crystal])
  assert.equal(backward.solved, false)
  assert.equal(backward.lit.has('g'), false)
})

test('bridges preserve isolated channels while crosses split light', () => {
  const stones = [tile('s', 0, 1, 'source'), tile('b', 1, 1, 'bridge'), tile('east', 2, 1, 'crystal'), tile('south', 1, 2, 'crystal', 1)]
  const bridge = simulate(stones)
  assert.equal(bridge.litCrystals, 1)
  assert.equal(bridge.lit.has('south'), false)
  assert.deepEqual([...bridge.litPorts.get('b')].sort(), [1, 3])
  assert.equal(simulate(stones.map((stone) => stone.id === 'b' ? { ...stone, kind: 'cross' } : stone)).solved, true)
  const both = simulate([...stones, tile('s2', 1, 0, 'source', 1)])
  assert.equal(both.solved, true)
  assert.equal(both.litPorts.get('b').size, 4)
})

test('paired portals transport light, with directional sockets on both ends', () => {
  const source = tile('s', 0, 0, 'source')
  const a = tile('a', 1, 0, 'portal', 3, { pair: 'moon' })
  const b = tile('b', 4, 2, 'portal', 1, { pair: 'moon' })
  const crystal = tile('c', 5, 2, 'crystal')
  assert.equal(simulate([source, a, b, crystal]).solved, true)
  assert.equal(simulate([source, { ...a, rotation: 1 }, b, crystal]).solved, false)
  assert.equal(simulate([source, a, { ...b, rotation: 0 }, crystal]).solved, false)
  assert.equal(simulate([source, a, { ...b, pair: 'sun' }, crystal]).solved, false)
  assert.equal(simulate([source, a, crystal]).solved, false)
})

test('cycles terminate and illuminate connected targets', () => {
  const stones = [
    tile('s', 0, 1, 'source'), tile('a', 1, 1, 'tee', 0),
    tile('b', 1, 0, 'elbow', 1), tile('c', 2, 0, 'elbow', 2),
    tile('d', 2, 1, 'tee', 0), tile('crystal', 3, 1, 'crystal'),
  ]
  assert.equal(simulate(stones).solved, true)
})

test('repeated hints solve every campaign board without changing locks', () => {
  for (const level of LEVELS) {
    let stones = level.tiles.map((stone) => ({ ...stone }))
    let hints = 0
    while (!simulate(stones).solved && hints <= stones.length) {
      const hint = getHint(level, stones)
      assert.ok(hint, `Hint exists for ${level.id}`)
      assert.equal(stones.find((stone) => stone.id === hint.tileId).fixed, false)
      stones = stones.map((stone) => stone.id === hint.tileId ? { ...stone, rotation: hint.rotation } : stone)
      hints++
    }
    assert.equal(simulate(stones).solved, true, `Hints solve ${level.id}`)
    assert.equal(getHint(level, stones), null)
  }
})

test('daily boards are deterministic across calls and vary by date', () => {
  assert.deepEqual(dailyLevel('2026-09-24'), dailyLevel('2026-09-24'))
  assert.equal(dailyLevel('2026-09-24').id, 'daily-2026-09-24')
  assert.notDeepEqual(dailyLevel('2026-09-24').tiles, dailyLevel('2026-09-25').tiles)
  assert.equal(simulate(solvedTiles(dailyLevel('2026-09-24'))).solved, true)
})

test('600 seeded endless boards are reproducible, solvable, and initially unsolved', () => {
  for (let seed = 0; seed < 600; seed++) {
    const level = generateLevel(seed * 7919, seed % 6)
    assert.equal(simulate(solvedTiles(level)).solved, true, `Seed ${seed}`)
    assert.equal(simulate(level.tiles).solved, false, `Seed ${seed}`)
    if (seed < 12) assert.deepEqual(level, generateLevel(seed * 7919, seed % 6))
  }
})
