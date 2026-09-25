import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SunwakeEngine, terrain } from '../src/game/engine.ts'
import { TerrainSamples, displayScale } from '../src/game/presentation.ts'
import { ControllerInput } from '../src/game/controller.ts'
import { loadProgress } from '../src/game/progress.ts'

const options = { mode: 'zen', seed: 127, ship: 'sol' }

test('interpolated flight advances every high-refresh frame without changing simulation state', () => {
  for (const hz of [60, 90, 144, 240]) {
    const engine = new SunwakeEngine(options)
    engine.start()
    let previous = 200
    let repeats = 0
    let displayedTime = 0
    for (let i = 0; i < hz * 3; i++) {
      engine.step(1 / hz, { dive: false, boost: false })
      const before = structuredClone(engine.state)
      const display = engine.presentation()
      assert.deepEqual(
        engine.state,
        before,
        'Presentation must not mutate gameplay',
      )
      assert.ok(
        display.player.x >= previous - 1e-8,
        'The camera cannot move backward',
      )
      assert.ok(
        display.player.x <= engine.state.player.x + 1e-8,
        'Never predict across a collision',
      )
      assert.ok(
        engine.state.player.x - display.player.x < 9,
        'Display lag stays within one physics tick',
      )
      assert.ok(display.time >= displayedTime - 1e-8)
      if (i > 2 && display.player.x === previous) repeats++
      previous = display.player.x
      displayedTime = display.time
    }
    assert.equal(
      repeats,
      0,
      `${hz} Hz must not repeat positions between physics ticks`,
    )
    engine.pause()
    assert.equal(engine.presentation(), engine.state)
    engine.resume()
    assert.equal(
      engine.presentation(),
      engine.state,
      'Resuming cannot jump back to a stale pose',
    )
    engine.reset(options)
    assert.equal(engine.presentation(), engine.state)
  }
})

test('render samples stay subpixel accurate across seeds, regions, negative coordinates, and cache wrap', () => {
  const samples = new TerrainSamples()
  for (const seed of [127, 7079, 92847, 127]) {
    for (let x = -100; x < 80000; x += 7.13) {
      assert.ok(Math.abs(samples.height(x, seed) - terrain(x, seed)) < 0.02)
    }
    assert.equal(samples.height(0, seed), terrain(0, seed))
  }
})

test('automatic scenery respects a pixel budget while sharp/light remain explicit choices', () => {
  for (const [w, h, dpr] of [
    [390, 580, 3],
    [1440, 900, 2],
    [3840, 2160, 2],
  ]) {
    const scale = displayScale(w, h, dpr, 'auto')
    assert.ok(w * h * scale ** 2 <= 2_000_000 + 1e-6)
    assert.ok(scale <= Math.min(dpr, 2))
    assert.equal(displayScale(w, h, dpr, 'sharp'), Math.min(dpr, 2))
    assert.equal(displayScale(w, h, dpr, 'light'), 1)
  }
  assert.ok(Number.isFinite(displayScale(0, 0, 0, 'auto')))
})

test('losing the active controller pauses even when another controller is already connected', () => {
  const controller = new ControllerInput()
  const pad = (index, pressed = []) => ({
    index,
    connected: true,
    mapping: 'standard',
    buttons: Array.from({ length: 16 }, (_, i) => ({
      pressed: pressed.includes(i),
      value: Number(pressed.includes(i)),
    })),
  })
  controller.read([pad(0), pad(1)])
  const handoff = controller.read([null, pad(1, [0, 9])])
  assert.equal(handoff.connected, true)
  assert.equal(handoff.disconnected, true)
  assert.equal(handoff.start, false)
  assert.equal(handoff.pause, false)
  assert.equal(controller.read([null, pad(1, [0, 9])]).pause, false)
  controller.read([null, pad(1)])
  assert.equal(controller.read([null, pad(1, [9])]).pause, true)
})

test('display and motion preferences migrate and reject unsupported saved values', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  let save = {
    version: 1,
    bank: 400,
    owned: ['sol', 'comet'],
    selected: 'comet',
  }
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => JSON.stringify(save) },
  })
  try {
    assert.equal(loadProgress().detail, 'auto')
    assert.equal(loadProgress().motion, 'system')
    save = { ...save, detail: 'light', motion: 'reduced' }
    assert.equal(loadProgress().detail, 'light')
    assert.equal(loadProgress().motion, 'reduced')
    save = { ...save, detail: '<invalid>', motion: {} }
    const progress = loadProgress()
    assert.equal(progress.detail, 'auto')
    assert.equal(progress.motion, 'system')
    assert.equal(progress.bank, 400)
    assert.equal(progress.selected, 'comet')
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else delete globalThis.localStorage
  }
})
