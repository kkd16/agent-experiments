import test from 'node:test'
import assert from 'node:assert/strict'
import { LEVELS, simulate, getHint } from '../src/game.ts'
import { decodeCustomLevel, encodeCustomGarden, validateCustomGarden } from '../src/custom.ts'

const solved = (level) => level.tiles.map((tile) => ({ ...tile, rotation: level.solution[tile.id] }))
function board(stones, size = 5) {
  return Array.from({ length: size * size }, (_, i) => {
    const x = i % size
    const y = Math.floor(i / size)
    return { id: `cell-${x}-${y}`, x, y, kind: 'rock', rotation: 0, fixed: true, ...stones.find((tile) => tile.x === x && tile.y === y) }
  })
}
const gateBoard = () => board([{ x: 0, y: 0, kind: 'source' }, { x: 1, y: 0, kind: 'gate', rotation: 1, fixed: false }, { x: 2, y: 0, kind: 'crystal' }])
const portalBoard = () => board([{ x: 0, y: 0, kind: 'source' }, { x: 1, y: 0, kind: 'portal', rotation: 3, pair: 'a', fixed: false }, { x: 3, y: 3, kind: 'portal', rotation: 1, pair: 'a', fixed: false }, { x: 4, y: 3, kind: 'crystal' }])
const pack = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const unpack = (code) => JSON.parse(Buffer.from(code, 'base64url').toString())

test('every campaign solution becomes a stable share with an unsolved, hint-solvable start', () => {
  for (const original of LEVELS) {
    const tiles = solved(original)
    const before = structuredClone(tiles)
    const encoded = encodeCustomGarden(original.title, original.size, tiles)
    assert.ok(encoded, original.id)
    assert.deepEqual(tiles, before)
    assert.match(encoded.level.id, /^custom-[0-9a-f]{16}$/)
    assert.equal(encoded.level.index, -1)
    assert.ok(encoded.code.length < 6000)
    assert.deepEqual(decodeCustomLevel(encoded.code), encoded.level)
    assert.deepEqual(encodeCustomGarden(original.title, original.size, [...tiles].reverse()), encoded)
    assert.equal(simulate(encoded.level.tiles).solved, false)
    assert.equal(simulate(solved(encoded.level)).solved, true)
    assert.ok(encoded.level.par > 0)
    let current = encoded.level.tiles
    for (let i = 0; !simulate(current).solved && i <= current.length; i++) {
      const hint = getHint(encoded.level, current)
      assert.ok(hint)
      const changing = current.find((tile) => tile.id === hint.tileId)
      assert.equal(changing.fixed, false)
      assert.ok(!['source', 'crystal'].includes(changing.kind))
      current = current.map((tile) => tile.id === hint.tileId ? { ...tile, rotation: hint.rotation } : tile)
    }
    assert.equal(simulate(current).solved, true)
  }
})

test('custom gates and portals retain their mechanics and fixed terminals', () => {
  for (const [tiles, chapter] of [[gateBoard(), 3], [portalBoard(), 5]]) {
    assert.deepEqual(validateCustomGarden(5, tiles), [])
    const { level, code } = encodeCustomGarden('A gate & a doorway', 5, tiles)
    assert.equal(level.chapter, chapter)
    assert.equal(simulate(level.tiles).solved, false)
    assert.equal(simulate(solved(level)).solved, true)
    assert.deepEqual(decodeCustomLevel(code), level)
    for (const tile of level.tiles.filter((stone) => ['source', 'crystal'].includes(stone.kind))) {
      assert.equal(tile.fixed, true)
      assert.equal(tile.rotation, level.solution[tile.id])
    }
  }
})

test('titles support Unicode and affect deterministic identity', () => {
  const a = encodeCustomGarden('  月の庭 🌿  ', 5, gateBoard())
  assert.equal(a.level.title, '月の庭 🌿')
  assert.equal(decodeCustomLevel(a.code).title, '月の庭 🌿')
  assert.deepEqual(a, encodeCustomGarden('月の庭 🌿', 5, gateBoard()))
  assert.notEqual(a.level.id, encodeCustomGarden('Another keeper', 5, gateBoard()).level.id)
  assert.equal(encodeCustomGarden('', 5, gateBoard()), null)
  assert.equal(encodeCustomGarden('a'.repeat(61), 5, gateBoard()), null)
  assert.equal(encodeCustomGarden('New\nline', 5, gateBoard()), null)
})

test('validation explains incomplete designs, disconnected light and unmatched portals', () => {
  const blank = board([])
  const problems = validateCustomGarden(5, blank)
  assert.ok(problems.some((problem) => problem.includes('sun well')))
  assert.ok(problems.some((problem) => problem.includes('crystal')))
  assert.equal(encodeCustomGarden('Empty', 5, blank), null)
  const wrongGate = gateBoard().map((tile) => tile.kind === 'gate' ? { ...tile, rotation: 3 } : tile)
  assert.match(validateCustomGarden(5, wrongGate).join(' '), /0 of 1/)
  assert.equal(encodeCustomGarden('Disconnected', 5, wrongGate), null)
  const lonePortal = portalBoard().map((tile) => tile.x === 3 && tile.y === 3 ? { ...tile, pair: 'b' } : tile)
  assert.match(validateCustomGarden(5, lonePortal).join(' '), /pair A needs exactly two/)
  assert.match(validateCustomGarden(5, lonePortal).join(' '), /pair B needs exactly two/)
  const threePortals = portalBoard().map((tile) => tile.x === 2 && tile.y === 2 ? { ...tile, kind: 'portal', pair: 'a' } : tile)
  assert.match(validateCustomGarden(5, threePortals).join(' '), /has 3/)
})

test('always-solved designs with irrelevant unlocked stones cannot be shared as puzzles', () => {
  const permanentLight = board([{ x: 0, y: 0, kind: 'source' }, { x: 1, y: 0, kind: 'crystal' }, { x: 4, y: 4, kind: 'elbow', fixed: false }])
  assert.equal(simulate(permanentLight).solved, true)
  assert.match(validateCustomGarden(5, permanentLight).join(' '), /stay lit/)
  assert.equal(encodeCustomGarden('No puzzle', 5, permanentLight), null)
  const allFixed = gateBoard().map((tile) => ({ ...tile, fixed: true }))
  assert.match(validateCustomGarden(5, allFixed).join(' '), /unlocked/)
})

test('coordinates, identities, rotations, bounds and pair types are validated before simulation', () => {
  const change = (patch) => gateBoard().map((tile, i) => i === 1 ? { ...tile, ...patch } : tile)
  for (const tiles of [change({ x: 5 }), change({ x: -1 }), change({ x: 1.5 }), change({ x: 0, y: 0, id: 'cell-0-0' }), change({ id: '__proto__' }), change({ rotation: 4 }), change({ rotation: -1 }), change({ kind: 'mystery' }), change({ fixed: 'yes' }), change({ pair: 'a' }), change({ kind: 'portal', pair: {} })]) {
    assert.ok(validateCustomGarden(5, tiles).length)
    assert.equal(encodeCustomGarden('Invalid', 5, tiles), null)
  }
  assert.ok(validateCustomGarden(4, gateBoard()).length)
  assert.ok(validateCustomGarden(5, gateBoard().slice(1)).length)
  assert.ok(validateCustomGarden(5, null).length)
})

test('decoder rejects malformed, oversized, noncanonical and hostile payloads', () => {
  const { code } = encodeCustomGarden('A valid garden', 5, gateBoard())
  const payload = unpack(code)
  const edited = (mutate) => { const next = structuredClone(payload); mutate(next); return pack(next) }
  const invalid = ['', '!', 'a', 'a'.repeat(6001), code + '=', Buffer.from([0xff, 0xfe]).toString('base64url'), pack(null), pack([]), pack({}), pack({ ...payload, v: 2 }), pack({ ...payload, s: 1000 }), pack({ ...payload, s: '5' }), pack({ ...payload, n: 7 }), pack({ ...payload, id: '__proto__' }), pack({ ...payload, solution: {} }), pack({ ...payload, t: [] }), edited((next) => { next.t[1] = [7, 1, 0] }), edited((next) => { next.t[1][0] = 99 }), edited((next) => { next.t[1][1] = 1.25 }), edited((next) => { next.t[1][2] = 'false' }), edited((next) => { next.t[1][3] = 3 }), edited((next) => { next.t[0][2] = 0 }), edited((next) => { next.t[2][2] = 0 }), edited((next) => { next.t[1][1] = 3 }), edited((next) => { next.n = 'x'.repeat(61) })]
  for (const input of invalid) assert.equal(decodeCustomLevel(input), null, input.slice(0, 50))
  assert.equal(decodeCustomLevel(null), null)
  assert.equal(decodeCustomLevel(42), null)
})

test('two independently paired portal routes and multiple sun wells survive sharing', () => {
  const tiles = board([
    { x: 0, y: 0, kind: 'source' }, { x: 1, y: 0, kind: 'portal', rotation: 3, pair: 'a', fixed: false },
    { x: 3, y: 3, kind: 'portal', rotation: 1, pair: 'a', fixed: false }, { x: 4, y: 3, kind: 'crystal' },
    { x: 0, y: 1, kind: 'source' }, { x: 1, y: 1, kind: 'portal', rotation: 3, pair: 'b', fixed: false },
    { x: 3, y: 4, kind: 'portal', rotation: 1, pair: 'b', fixed: false }, { x: 4, y: 4, kind: 'crystal' },
  ])
  assert.deepEqual(validateCustomGarden(5, tiles), [])
  const result = encodeCustomGarden('Two far gardens', 5, tiles)
  const decoded = decodeCustomLevel(result.code)
  assert.equal(decoded.tiles.filter((tile) => tile.kind === 'source').length, 2)
  assert.equal(decoded.tiles.filter((tile) => tile.pair === 'a').length, 2)
  assert.equal(decoded.tiles.filter((tile) => tile.pair === 'b').length, 2)
  assert.equal(simulate(decoded.tiles).solved, false)
  assert.equal(simulate(solved(decoded)).litCrystals, 2)
})
