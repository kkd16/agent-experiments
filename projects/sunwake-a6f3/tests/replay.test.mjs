import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { FlightRecorder, GhostLibrary, courseFromHash, courseHash, ghostAt, GHOST_KEY } from '../src/game/replay.ts'
import { FlightInput } from '../src/game/input.ts'
let storage
beforeEach(() => {
  storage = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) } })
})
const sample = (time, phase = 'running', seed = 42) => ({ seed, mode: 'voyage', ship: 'sol', time, distance: time * 40, phase, player: { x: 200 + time * 400, y: 480 + Math.sin(time) * 50, rotation: Math.sin(time) * .4 } })
const record = (seconds = 10, seed = 42) => {
  const recorder = new FlightRecorder()
  for (let frame = 0; frame <= seconds * 60; frame++) recorder.record(sample(frame / 60, 'running', seed))
  return recorder.finish(sample(seconds, 'ended', seed))
}

test('course links round trip only supported versions and valid unsigned seeds', () => {
  for (const seed of [1, 42, 0xffffffff]) assert.equal(courseFromHash(courseHash(seed)), seed)
  for (const hash of ['#/course/1/42', '#/course/2/0', '#/course/2/zzzzzzz', '#/course/2/42?bad', '#/course/2/<script>', '']) assert.equal(courseFromHash(hash), null)
})

test('ghost interpolation follows the real flight and finishes at its last position', () => {
  const run = record()
  const half = ghostAt(run, 5.1)
  assert.ok(Math.abs(half.x - 2240) < 1)
  assert.ok(half.y >= 430 && half.y <= 530)
  assert.equal(half.finished, false)
  const last = ghostAt(run, 20)
  assert.equal(last.finished, true)
  assert.equal(last.x, 4200)
})

test('long flights compact to a bounded trace without losing start/end or ordering', () => {
  const run = record(3600)
  assert.ok(run.points.length <= 960)
  assert.equal(run.points[0][0], 0)
  assert.equal(run.points.at(-1)[0], 3600)
  assert.ok(Math.abs(ghostAt(run, 1800).x - 720200) < 1)
  for (let i = 1; i < run.points.length; i++) assert.ok(run.points[i][0] > run.points[i - 1][0])
})

test('rounding at a finish cannot create duplicate timestamps and lose a ghost', () => {
  const recorder = new FlightRecorder()
  recorder.record(sample(0)); recorder.record(sample(.6));
  const run = recorder.finish(sample(.60000000000003, 'ended'))
  assert.equal(run.points.length, 2)
  assert.equal(new GhostLibrary().remember(run, 'voyage'), true)
})

test('finishing on the trace limit preserves the exact final position', () => {
  const recorder = new FlightRecorder()
  for (let i = 0; i < 959; i++) recorder.record(sample(i * .25))
  const run = recorder.finish(sample(959 * .25, 'ended'))
  assert.equal(run.points.at(-1)[0], run.duration)
  assert.equal(ghostAt(run, run.duration + 1).x, sample(run.duration).player.x)
})

test('only the best competitive ghost per course is saved; recent courses are bounded', () => {
  const library = new GhostLibrary()
  assert.equal(library.remember(record(5), 'zen'), false)
  assert.equal(library.remember(record(10), 'voyage'), true)
  assert.equal(library.remember(record(5), 'daily'), false)
  assert.equal(library.get(42).distance, 400)
  for (let seed = 1; seed <= 6; seed++) library.remember(record(2, seed), 'voyage')
  assert.equal(library.get(42), null)
  assert.equal(new GhostLibrary().get(6).distance, 80)
  assert.equal(JSON.parse(storage.get(GHOST_KEY)).length, 4)
})

test('corrupt, out-of-order, oversized, and wrong-version traces are ignored', () => {
  const valid = record()
  for (const bad of ['broken', JSON.stringify([{ ...valid, version: 1 }]), JSON.stringify([{ ...valid, points: [valid.points[1], valid.points[0]] }]), ' '.repeat(600001)]) {
    storage.set(GHOST_KEY, bad)
    assert.equal(new GhostLibrary().get(42), null)
  }
})

test('multi-source input releases independently; blur clears keys and pending bursts', () => {
  const input = new FlightInput()
  input.set('dive', 'Space', true); input.set('dive', 'pointer-1', true)
  input.set('boost', 'ShiftLeft', true)
  input.release('Space')
  assert.deepEqual(input.value(100), { dive: true, boost: true })
  input.release('pointer-1')
  assert.deepEqual(input.value(100), { dive: false, boost: true })
  input.pulse(200); input.release('ShiftLeft')
  assert.equal(input.value(300).boost, true)
  input.clear()
  assert.deepEqual(input.value(300), { dive: false, boost: false })
})
