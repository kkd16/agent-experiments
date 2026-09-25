// Run with Node 24+: node qa/engine-check.mjs
// These checks exercise real simulation time, not implementation snapshots.
import assert from 'node:assert/strict'
import { SunwakeEngine, terrain, terrainSlope } from '../src/game/engine.ts'

const options = { mode: 'voyage', ship: 'sol', seed: 42 }
const input = { dive: false, boost: false }
const run = (engine, seconds, controls = () => input, hz = 60) => {
  for (let frame = 0; frame < seconds * hz; frame++) engine.step(1 / hz, controls(engine, frame / hz))
}
const create = (overrides = {}) => {
  const engine = new SunwakeEngine({ ...options, ...overrides })
  engine.start()
  return engine
}

// Frame rate must not change a seeded run's outcome.
const thirty = create()
const sixty = create()
const fast = create()
run(thirty, 15, undefined, 30)
run(sixty, 15, undefined, 60)
run(fast, 15, undefined, 144)
assert.deepEqual(thirty.state, sixty.state)
assert.deepEqual(sixty.state, fast.state)

// Pause freezes all simulation, while resuming advances normally.
sixty.pause()
const paused = structuredClone(sixty.state)
run(sixty, 10)
assert.deepEqual(sixty.state, paused)
sixty.resume()
sixty.step(1 / 60, input)
assert.ok(sixty.state.distance > paused.distance)

// Holding catches a dune; releasing is an immediate, responsive launch.
const launched = create()
run(launched, 0.1, () => ({ dive: true, boost: false }))
assert.equal(launched.state.player.grounded, true)
launched.step(1 / 60, input)
assert.equal(launched.state.player.grounded, false)
assert.ok(launched.state.player.vy < -200)

// A charged burst spends exactly one charge per press and grants protection.
const burst = create()
burst.state.player.charge = 100
burst.step(1 / 60, { dive: false, boost: true })
assert.equal(burst.state.boosts, 1)
assert.equal(burst.state.player.charge, 35)
assert.ok(burst.state.player.boostTime > 2.7)
assert.ok(burst.state.player.invincible > 2.7)
run(burst, 0.3, () => ({ dive: false, boost: true }))
assert.equal(burst.state.boosts, 1)

// Forced contacts test pickups, damage grace, and the boost-through-obstacles path.
const contact = create()
contact.state.time = 9
const touching = (kind, id) => ({
  id, kind, x: contact.state.player.x + 3, y: contact.state.player.y,
  radius: 24, phase: 0, collected: false,
})
contact.state.entities = [touching('rock', -1), touching('storm', -2)]
contact.step(1 / 120, input)
assert.ok(contact.state.player.energy > 74 && contact.state.player.energy < 76)
assert.equal(contact.state.events.filter(event => event.kind === 'hit').length, 1)
contact.state.entities = [touching('ring', -3)]
contact.step(1 / 120, input)
assert.equal(contact.state.rings, 1)
assert.equal(contact.state.combo, 1)
contact.state.player.charge = 100
contact.state.entities = [touching('rock', -4)]
contact.step(1 / 120, { ...input, boost: true })
assert.equal(contact.state.entities[0].collected, true)
assert.equal(contact.state.events.filter(event => event.kind === 'hit').length, 1)

// Layout is independent of particles, input, and device frame rate.
const courseA = create()
const courseB = create()
run(courseA, 10, () => ({ dive: true, boost: false }))
run(courseB, 10, (_, time) => ({ dive: time % 1.5 < 0.75, boost: false }))
const farX = Math.max(courseA.state.player.x, courseB.state.player.x) + 250
const sharedIds = new Set(courseB.state.entities.filter(entity => entity.x > farX).map(entity => entity.id))
const commonA = courseA.state.entities.filter(entity => sharedIds.has(entity.id) && entity.x > farX)
const idsA = new Set(commonA.map(entity => entity.id))
const commonB = courseB.state.entities.filter(entity => idsA.has(entity.id))
assert.ok(commonA.length >= 6)
assert.deepEqual(commonA, commonB)

// Sunlight ends Voyage, but Zen is genuinely endless, including obstacle contacts.
const empty = create()
empty.state.player.energy = 0.001
empty.step(1 / 60, input)
assert.equal(empty.state.phase, 'ended')
const zen = create({ mode: 'zen' })
zen.state.player.energy = 0
run(zen, 240, engine => ({
  dive: terrainSlope(engine.state.player.x, engine.state.seed) > 0.02,
  boost: engine.state.player.charge >= 65 && engine.state.player.boostTime <= 0,
}))
assert.equal(zen.state.phase, 'running')
assert.equal(zen.state.player.energy, 100)
assert.ok(zen.state.distance > 10000)
assert.ok(zen.state.cleanLandings > 10)
assert.ok(zen.state.boosts > 10)
assert.ok(zen.state.entities.length < 60)
assert.ok(zen.state.particles.length <= 240)
assert.ok(zen.state.player.trail.length <= 50)
assert.ok(zen.state.events.length <= 6)
assert.ok(Number.isFinite(zen.state.player.x + zen.state.player.y + zen.state.score))

// The advanced airtime challenge is attainable by bursting near a jump's apex.
const soaring = create({ mode: 'zen', seed: 127 })
let lowestY = 720
run(soaring, 90, engine => {
  const { player, seed } = engine.state
  lowestY = Math.min(lowestY, player.y)
  return {
    dive: player.grounded && terrainSlope(player.x, seed) > -0.3,
    boost: player.charge >= 65 && player.boostTime <= 0 && !player.grounded && player.vy > -120,
  }
})
assert.ok(soaring.state.maxAirtime >= 3, 'The three-second flight mission must be achievable')
assert.ok(lowestY >= 82, 'Keep the mast visible during high flights')
zen.finish()
assert.equal(zen.state.phase, 'ended')
zen.reset(options)
assert.equal(zen.state.phase, 'ready')
assert.equal(zen.state.distance, 0)
assert.equal(zen.state.player.y, terrain(200, options.seed) - 14)

console.log('Engine checks passed: fixed clock, pause, launch, bursts, collision grace, seeded course, sunlight, advanced airtime, and four-minute bounded Zen run.')


// New pickups change real gameplay, not merely the decoration.
const gifted = create({ mode: 'zen' })
gifted.state.time = 10
const put = kind => { const p = gifted.state.player; gifted.state.entities = [{ id: -50, kind, x: p.x + 3, y: p.y, radius: 28, phase: 0, collected: false }] }
put('shield'); gifted.step(1 / 120, input)
assert.equal(gifted.state.player.shield, true)
put('rock'); gifted.step(1 / 120, input)
assert.equal(gifted.state.player.shield, false)
assert.equal(gifted.state.hits, 0)
assert.ok(gifted.state.player.invincible > 1)
for (let i = 0; i < 3; i++) { put('ring'); gifted.step(1 / 120, input) }
assert.equal(gifted.state.skyChains, 1)
assert.equal(gifted.state.ringChain, 0)
assert.ok(gifted.state.player.magnetTime > 7)
gifted.state.player.grounded = true
gifted.state.player.y = terrain(gifted.state.player.x, gifted.state.seed) - 14
put('thermal'); gifted.step(1 / 120, input)
assert.equal(gifted.state.thermalsRidden, 1)
assert.equal(gifted.state.player.grounded, false)
assert.ok(gifted.state.player.vy < -350)

// Every regional boundary remains position- and slope-continuous.
for (let index = 1; index <= 12; index++) {
  const x = 200 + index * 10000
  assert.ok(Math.abs(terrain(x + .001, 42) - terrain(x - .001, 42)) < .01)
  assert.ok(Math.abs(terrainSlope(x + .001, 42) - terrainSlope(x - .001, 42)) < .001)
}
console.log('Expansion checks passed: shields, chain rewards, thermals, and continuous region profiles.')


const magnet = create({ mode: 'zen' })
magnet.state.player.magnetTime = 10
magnet.state.entities = [{ id: -70, kind: 'spark', x: magnet.state.player.x + 60, y: magnet.state.player.y - 85, radius: 9, phase: 0, collected: false }]
run(magnet, .6)
assert.equal(magnet.state.magneticSparks, 1, 'The magnet must collect sparks outside the ordinary hull reach')
const fastMagnet = create({ mode: 'zen' })
Object.assign(fastMagnet.state.player, { magnetTime: 10, vx: 900, vy: -100, y: 250, grounded: false, boostTime: 1 })
fastMagnet.state.entities = [{ id: -71, kind: 'spark', x: fastMagnet.state.player.x - 100, y: 190, radius: 9, phase: 0, collected: false }]
run(fastMagnet, .4)
assert.equal(fastMagnet.state.magneticSparks, 1, 'A spark must catch a skiff moving at burst speed')
const missed = create()
missed.state.ringChain = 2
missed.state.chainDeadline = 20
missed.state.entities = [{ id: -80, kind: 'ring', x: missed.state.player.x - 85, y: 120, radius: 32, phase: 0, collected: false }]
missed.step(1 / 120, input)
assert.equal(missed.state.ringChain, 0, 'Missing a ring must break a chain')
const repeatBurst = create()
repeatBurst.state.player.charge = 100
repeatBurst.step(1 / 60, { dive: false, boost: true })
repeatBurst.step(1 / 60, input)
repeatBurst.state.player.charge = 100
repeatBurst.step(1 / 60, { dive: false, boost: true })
assert.equal(repeatBurst.state.boosts, 1, 'An active burst cannot be renewed before it ends')
console.log('Pickup checks passed: magnet attraction, missed-ring reset, and active-burst guard.')
