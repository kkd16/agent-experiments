import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { SunwakeEngine } from '../src/game/engine.ts'
import { EXPEDITIONS, expeditionHash, expeditionFromHash, expeditionMedals, medalCount, readExpeditions, routeUnlocked, sealCount } from '../src/game/expeditions.ts'
import { freshProgress, loadProgress, saveProgress, settleRun } from '../src/game/progress.ts'
import { GhostLibrary, FlightRecorder } from '../src/game/replay.ts'
import { ControllerInput } from '../src/game/controller.ts'

let storage
beforeEach(() => {
  storage = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } })
})
const fly = (route, period = 1.5, duty = .7 / 1.5, hz = 60) => {
  const game = new SunwakeEngine({ mode: 'expedition', expeditionId: route.id, seed: 1, ship: 'sol' })
  const checkpoints = new Set()
  game.start()
  while (game.state.phase === 'running' && game.state.time < 120) {
    const s = game.state
    game.step(1 / hz, { dive: s.time % period < period * duty, boost: s.player.charge >= 65 && s.player.boostTime <= 0 })
    for (const event of s.events) if (event.kind === 'checkpoint') checkpoints.add(event.id)
  }
  return { state: game.state, checkpoints }
}
const journey = () => fly(EXPEDITIONS[0], .65, .2).state

test('atlas links identify fixed routes and reject unknown or future rules', () => {
  assert.equal(new Set(EXPEDITIONS.map(route => route.id)).size, 6)
  for (const route of EXPEDITIONS) assert.equal(expeditionFromHash(expeditionHash(route.id)), route)
  for (const hash of ['#/expedition/2/first-post', '#/expedition/1/missing', '#/expedition/1/first-post?bad', '#/course/2/3j']) assert.equal(expeditionFromHash(hash), null)
  assert.equal(routeUnlocked('first-post', {}), true)
  assert.equal(routeUnlocked('rose-express', {}), false)
  assert.equal(routeUnlocked('missing', {}), false)
})

test('all six expeditions are completable with every seal and exactly two checkpoint rewards', () => {
  for (const route of EXPEDITIONS) {
    const { state, checkpoints } = fly(route, route.id === 'first-post' || route.id === 'rose-express' ? .65 : 1.5, route.id === 'first-post' ? .2 : route.id === 'rose-express' ? .35 : .7 / 1.5)
    assert.equal(state.arrived, true, route.id)
    assert.equal(expeditionMedals(route, state), 7, `${route.id} must offer attainable finesse and swift seals`)
    assert.equal(checkpoints.size, 2, `${route.id} must award each checkpoint once`)
    assert.equal(state.checkpoints, 2)
    assert.ok(state.distance >= route.distance && state.distance < route.distance + 1)
    assert.ok(Math.abs(state.worldDistance - state.distance - route.start) < 1e-8)
    assert.ok(state.entities.length < 60)
  }
})

test('offset starts use the intended biome and finite deterministic layouts', () => {
  for (const route of EXPEDITIONS) {
    const a = new SunwakeEngine({ mode: 'expedition', expeditionId: route.id, seed: 0, ship: 'sol' })
    const b = new SunwakeEngine({ mode: 'expedition', expeditionId: route.id, seed: 900, ship: 'sol' })
    assert.deepEqual(a.state, b.state, 'The route owns its seed, not a stale caller value')
    assert.equal(a.state.distance, 0)
    assert.equal(a.state.biome, Math.floor(route.start / 1000) % 4)
    assert.equal(a.state.player.energy, route.energy)
    assert.ok(a.state.entities.length < 50)
  }
})

test('arrival freezes simulation, while aborting never awards arrival or skill seals', () => {
  const state = journey()
  const aborted = { ...state, arrived: false, reason: 'A beautiful place to rest.' }
  assert.equal(expeditionMedals(EXPEDITIONS[0], aborted), 0)
  assert.equal(settleRun(freshProgress(), aborted, '2026-09-24').expedition.medals, 0)
  const game = new SunwakeEngine({ mode: 'expedition', expeditionId: 'first-post', seed: 127, ship: 'sol' })
  game.state = structuredClone(state)
  game.step(10, { dive: true, boost: true })
  assert.deepEqual(game.state, state)
})

test('seals accumulate across attempts without paying twice or affecting competitive records', () => {
  const fresh = freshProgress()
  const state = journey()
  const first = settleRun(fresh, { ...state, time: 30 }, '2026-09-24')
  assert.equal(first.expedition.medals, 3)
  assert.equal(first.earned, state.sparks + 80)
  assert.equal(first.progress.best, 0)
  assert.equal(first.progress.bestScore, 0)
  assert.deepEqual(first.progress.completed, [])
  assert.deepEqual(first.progress.daily, fresh.daily)
  assert.equal(routeUnlocked('rose-express', first.progress.expeditions), true)
  const second = settleRun(first.progress, { ...state, cleanLandings: 0 }, '2026-09-24')
  assert.equal(second.expedition.newMedals, 4)
  assert.equal(second.expedition.totalMedals, 7)
  assert.equal(second.earned, state.sparks + 40)
  const third = settleRun(second.progress, state, '2026-09-24')
  assert.equal(third.earned, state.sparks)
  assert.equal(third.progress.expeditions['first-post'].attempts, 3)
  assert.equal(third.progress.expeditions['first-post'].bestTime, state.time)
  assert.equal(third.progress.history[0].expeditionId, 'first-post')
  assert.equal(sealCount(third.progress.expeditions), 3)
  assert.equal(saveProgress(third.progress), true)
  assert.deepEqual(loadProgress().expeditions, third.progress.expeditions)
})

test('cosmetic unlocks migrate safely and expedition traces never replace voyage ghosts', () => {
  const save = freshProgress()
  save.selected = 'kestrel'; save.owned.push('kestrel'); save.trail = 'stardust'
  saveProgress(save)
  assert.equal(loadProgress().selected, 'sol')
  assert.equal(loadProgress().trail, 'sunlight')
  for (const route of EXPEDITIONS) save.expeditions[route.id] = { medals: 3, bestTime: 50, attempts: 1 }
  save.trail = 'aurora'; saveProgress(save)
  assert.equal(loadProgress().selected, 'kestrel')
  assert.equal(loadProgress().trail, 'aurora')
  assert.equal(sealCount(loadProgress().expeditions), 12)
  assert.equal(medalCount(7), 3)
  const recorder = new FlightRecorder()
  const state = journey()
  recorder.record({ ...state, time: 0, phase: 'running' })
  assert.equal(new GhostLibrary().remember(recorder.finish(state), 'expedition'), false)
})

test('bad expedition data cannot inject routes or invalid seal counts', () => {
  const records = readExpeditions({ 'first-post': { medals: 6, bestTime: -1, attempts: Infinity }, 'rose-express': { medals: 99 }, invented: { medals: 7 } })
  assert.deepEqual(records['first-post'], { medals: 0, bestTime: 0, attempts: 0 })
  assert.equal(records['rose-express'].medals, 0)
  assert.equal(records.invented, undefined)
  assert.deepEqual(readExpeditions(null), {})
})

const pad = (buttons = [], overrides = {}) => ({ index: 0, connected: true, mapping: 'standard', buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: buttons.includes(i), value: buttons.includes(i) ? 1 : 0 })), ...overrides })
test('controllers distinguish holds, menu edges, unsupported mappings, and disconnects', () => {
  const controls = new ControllerInput()
  assert.equal(controls.read([pad([], { mapping: '' })]).connected, false)
  const first = controls.read([pad([0, 2, 9])])
  assert.deepEqual(first, { connected: true, dive: true, boost: true, start: true, pause: true, disconnected: false })
  const held = controls.read([pad([0, 9])])
  assert.equal(held.start, false); assert.equal(held.pause, false)
  assert.equal(controls.read([pad([7])]).dive, true)
  assert.equal(controls.read([]).disconnected, true)
  assert.equal(controls.read([]).disconnected, false)
  const analog = pad(); analog.buttons[7].value = .6
  assert.equal(controls.read([analog]).dive, true)
})

test('new seal thresholds announce and grant cosmetic rewards only once', () => {
  const progress = freshProgress()
  for (let i = 1; i < EXPEDITIONS.length; i++) progress.expeditions[EXPEDITIONS[i].id] = { medals: i === 5 ? 1 : 3, bestTime: 30, attempts: 1 }
  assert.equal(sealCount(progress.expeditions), 9)
  const result = settleRun(progress, journey(), '2026-09-24')
  assert.equal(sealCount(result.progress.expeditions), 12)
  assert.ok(result.progress.owned.includes('kestrel'))
  assert.deepEqual(result.expedition.unlocked, ['Kestrel skiff', 'Aurora wake'])
  assert.deepEqual(settleRun(result.progress, journey(), '2026-09-24').expedition.unlocked, [])
})

test('finite finishes are frame-rate independent for the same held input', () => {
  const states = [30, 60, 144].map(hz => {
    const game = new SunwakeEngine({ mode: 'expedition', expeditionId: 'first-post', seed: 0, ship: 'sol' })
    game.start()
    while (game.state.phase === 'running') game.step(1 / hz, { dive: false, boost: false })
    return game.state
  })
  assert.deepEqual(states[0], states[1]); assert.deepEqual(states[1], states[2])
})

test('swift seals tolerate floating-point drift but reject a genuinely late finish', () => {
  const route = EXPEDITIONS[0], state = journey()
  assert.ok(expeditionMedals(route, { ...state, time: route.par + 1e-12 }) & 4)
  assert.equal(expeditionMedals(route, { ...state, time: route.par + 1 / 120 }) & 4, 0)
})
