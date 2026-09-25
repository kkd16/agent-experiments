import { BIOMES } from './types.ts'
import { expeditionById } from './expeditions.ts'
import type { Expedition } from './expeditions'
import { trailById } from './cosmetics.ts'
import type {
  Entity,
  EventKind,
  GameInput,
  GameState,
  RunOptions,
} from './types.ts'

const STEP = 1 / 120
const START_X = 200
const HULL = 14
const CHUNK = 820
const TAU = Math.PI * 2
const clamp = (n: number, low: number, high: number) =>
  Math.max(low, Math.min(high, n))

/** Coordinate hashing keeps the course identical regardless of how it is flown. */
function noise(seed: number, coordinate: number): number {
  let value = Math.imul(
    (seed | 0) ^ Math.imul(coordinate | 0, 0x45d9f3b),
    0x45d9f3b,
  )
  value ^= value >>> 16
  value = Math.imul(value, 0x45d9f3b)
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296
}

/** Continuous region profiles: long swells, steep dunes, close ripples, and broad bowls. */
const PROFILES = [
  [132, 66],
  [154, 87],
  [113, 58],
  [174, 77],
] as const
let cachedSeed = NaN
let cachedPhase = 0
function phaseFor(seed: number): number {
  if (seed !== cachedSeed) {
    cachedSeed = seed
    cachedPhase = noise(seed, 1) * TAU
  }
  return cachedPhase
}
function profile(
  x: number,
  phase: number,
  region: number,
  slope: boolean,
): number {
  const [length, height] = PROFILES[region]
  const swell = x / 2700 + phase
  const wave = x / length + phase + Math.sin(swell) * 0.65
  if (slope)
    return (
      Math.cos(wave) * (1 / length + (Math.cos(swell) * 0.65) / 2700) * height +
      (Math.cos(x / 311 + phase * 0.7) * 25) / 311 +
      (Math.cos(x / 67 + phase * 1.3) * 8) / 67
    )
  return (
    523 +
    Math.sin(wave) * height +
    Math.sin(x / 311 + phase * 0.7) * 25 +
    Math.sin(x / 67 + phase * 1.3) * 8
  )
}
function dune(x: number, seed: number, slope: boolean): number {
  const phase = phaseFor(seed)
  const progress = Math.max(0, (x - START_X) / 10000)
  const region = Math.floor(progress) % 4
  const t = clamp(((progress % 1) - 0.8) / 0.2, 0, 1)
  const current = profile(x, phase, region, slope)
  if (t === 0) return current
  const next = profile(x, phase, (region + 1) % 4, slope)
  const blend = t * t * t * (t * (t * 6 - 15) + 10)
  const result = current + (next - current) * blend
  if (!slope) return result
  const derivative = (30 * t * t * (t - 1) * (t - 1)) / 2000
  return (
    result +
    (profile(x, phase, (region + 1) % 4, false) -
      profile(x, phase, region, false)) *
      derivative
  )
}
export function terrain(x: number, seed: number): number {
  return dune(x, seed, false)
}
export function terrainSlope(x: number, seed: number): number {
  return dune(x, seed, true)
}

export class SunwakeEngine {
  state: GameState
  private route: Expedition | null = null
  private accumulator = 0
  private nextChunk = 0
  private nextEntity = 0
  private nextEvent = 0
  private effectCounter = 0
  private lastDive = false
  private lastBoost = false
  private launchCooldown = 0
  private airDuration = 0
  private scoreBonus = 0
  private trailClock = 0
  private exhaustClock = 0

  constructor(options: RunOptions) {
    this.state = this.initialState(options)
    this.populate()
  }

  private initialState(options: RunOptions): GameState {
    const route =
      options.mode === 'expedition'
        ? expeditionById(options.expeditionId)
        : null
    this.route = route
    const seed = route?.seed ?? options.seed
    const startX = START_X + (route?.start ?? 0) * 10
    this.nextChunk = Math.floor(startX / CHUNK)
    return {
      phase: 'ready',
      mode: route
        ? 'expedition'
        : options.mode === 'expedition'
          ? 'voyage'
          : options.mode,
      ship: options.ship,
      trail: options.trail ?? 'sunlight',
      seed,
      expeditionId: route?.id ?? null,
      startX,
      worldDistance: route?.start ?? 0,
      checkpoints: 0,
      arrived: false,
      time: 0,
      distance: 0,
      score: 0,
      sparks: 0,
      rings: 0,
      combo: 0,
      bestCombo: 0,
      cleanLandings: 0,
      airtime: 0,
      maxAirtime: 0,
      nearMisses: 0,
      boosts: 0,
      hits: 0,
      perfectLandings: 0,
      skyChains: 0,
      ringChain: 0,
      chainDeadline: 0,
      magneticSparks: 0,
      thermalsRidden: 0,
      maxSpeed: 360,
      diving: false,
      flightCue: 'dive',
      landing: 'none',
      landingAt: -10,
      biome: Math.floor((route?.start ?? 0) / 1000) % BIOMES.length,
      reason: '',
      shake: 0,
      player: {
        x: startX,
        y: terrain(startX, seed) - HULL,
        vx: 360,
        vy: 0,
        rotation: Math.atan(terrainSlope(startX, seed)),
        grounded: true,
        energy: route?.energy ?? 100,
        charge: 25,
        invincible: 0,
        boostTime: 0,
        shield: false,
        magnetTime: 0,
        trail: [],
      },
      entities: [],
      particles: [],
      events: [],
    }
  }

  reset(options: RunOptions): void {
    this.accumulator = 0
    this.nextChunk = 0
    this.nextEntity = 0
    this.nextEvent = 0
    this.effectCounter = 0
    this.lastDive = false
    this.lastBoost = false
    this.launchCooldown = 0
    this.airDuration = 0
    this.scoreBonus = 0
    this.trailClock = 0
    this.exhaustClock = 0
    this.state = this.initialState(options)
    this.populate()
  }

  start(): void {
    if (this.state.phase === 'ready') this.state.phase = 'running'
  }

  pause(): void {
    if (this.state.phase === 'running') {
      this.state.phase = 'paused'
      this.accumulator = 0
    }
  }

  resume(): void {
    if (this.state.phase === 'paused') this.state.phase = 'running'
  }

  finish(): void {
    if (this.state.phase === 'ended') return
    this.state.phase = 'ended'
    this.state.reason = 'A beautiful place to rest.'
    this.event('end', 'Journey complete')
  }

  /** A bounded fixed clock keeps handling stable on both 60 Hz and 144 Hz screens. */
  step(dt: number, input: GameInput): void {
    if (this.state.phase !== 'running' || !Number.isFinite(dt) || dt <= 0)
      return
    this.accumulator += Math.min(dt, 0.1)
    while (this.accumulator + 1e-9 >= STEP && this.state.phase === 'running') {
      this.tick(STEP, input)
      this.accumulator -= STEP
    }
  }

  private tick(dt: number, input: GameInput): void {
    const state = this.state
    const route = this.route
    const player = state.player
    state.time += dt
    state.diving = input.dive
    player.magnetTime = Math.max(0, player.magnetTime - dt)
    if (state.time > state.chainDeadline) state.ringChain = 0
    state.shake = Math.max(0, state.shake - dt * 3.5)
    player.invincible = Math.max(0, player.invincible - dt)
    player.boostTime = Math.max(0, player.boostTime - dt)
    this.launchCooldown = Math.max(0, this.launchCooldown - dt)

    if (
      input.boost &&
      !this.lastBoost &&
      player.charge >= 65 &&
      player.boostTime <= 0
    )
      this.boost()
    const boosting = player.boostTime > 0
    const oldSlope = terrainSlope(player.x, state.seed)
    const released = this.lastDive && !input.dive

    if (player.grounded) {
      // Holding catches the slope: gravity rewards the downhill and punishes the uphill.
      const gravityAlongSlope = oldSlope * (input.dive ? 1050 : 525)
      const cruise = (365 - player.vx) * (input.dive ? 0.22 : 0.46)
      player.vx += (gravityAlongSlope + cruise + (boosting ? 285 : 18)) * dt
      if (released && this.launchCooldown <= 0) {
        this.launch(245 + Math.max(0, -oldSlope) * player.vx * 0.85)
      }
    } else {
      player.vx += ((input.dive ? 420 : 445) - player.vx) * dt * 0.12
      if (boosting) player.vx += 145 * dt
      player.vy +=
        (input.dive ? 1550 : boosting ? 245 : 445) * dt * (route?.gravity ?? 1)
      player.vy = Math.min(player.vy, 1100)
      this.airDuration += dt
      state.airtime += dt
      state.maxAirtime = Math.max(state.maxAirtime, this.airDuration)
    }

    player.vx += (route?.wind ?? 0) * dt
    player.vx = clamp(player.vx, 230, boosting ? 940 : 740)
    player.x += player.vx * dt
    const slope = terrainSlope(player.x, state.seed)
    const ground = terrain(player.x, state.seed) - HULL

    if (player.grounded) {
      player.y = ground
      player.vy = slope * player.vx
      // An open sail naturally floats off a crest; a held sail stays on the sand.
      if (
        !input.dive &&
        oldSlope < -0.055 &&
        slope >= -0.055 &&
        player.vx > 330 &&
        this.launchCooldown <= 0
      ) {
        this.launch(190 + Math.max(0, player.vx - 360) * 0.3)
      }
    } else {
      player.y += player.vy * dt
      // Keep the tall sail inside the view even on a powerful uphill launch.
      if (player.y < 82) {
        player.y = 82
        player.vy = Math.max(0, player.vy)
      }
      if (player.y >= ground) this.land(ground, slope)
    }

    const targetRotation = player.grounded
      ? Math.atan(slope)
      : clamp(Math.atan2(player.vy, player.vx) * 0.72, -0.72, 0.85)
    player.rotation +=
      (targetRotation - player.rotation) * (1 - Math.exp(-dt * 12))
    state.distance = Math.max(0, (player.x - state.startX) / 10)
    state.worldDistance = Math.max(0, (player.x - START_X) / 10)
    const biome = Math.floor(state.worldDistance / 1000) % BIOMES.length
    if (biome !== state.biome) {
      state.biome = biome
      this.event('biome', BIOMES[biome].name)
      player.energy = Math.min(100, player.energy + 16)
      this.spray(player.x, player.y, 35, '#fae2ad', 240)
    }

    state.maxSpeed = Math.max(state.maxSpeed, player.vx)
    state.flightCue = player.grounded
      ? slope > -0.07
        ? 'dive'
        : 'release'
      : 'glide'
    this.populate()
    this.collide(dt)
    this.effects(dt, input.dive)
    state.entities = state.entities.filter(
      (entity) => entity.x > player.x - 260,
    )
    state.events = state.events
      .filter((event) => state.time - event.time < 3.2)
      .slice(-6)
    state.score = Math.floor(state.distance * 3 + this.scoreBonus)

    if (route) {
      while (
        state.checkpoints < 2 &&
        state.distance >= (route.distance * (state.checkpoints + 1)) / 3
      ) {
        state.checkpoints++
        player.energy = Math.min(100, player.energy + 12)
        this.charge(8)
        this.event('checkpoint', `Beacon ${state.checkpoints} · +12 sunlight`)
        this.spray(player.x, player.y, 28, '#b9f3dc', 200)
      }
      if (state.distance >= route.distance) {
        state.arrived = true
        state.phase = 'ended'
        state.reason = `${route.name} complete. The beacon is glowing.`
        this.event('arrival', 'Beacon reached!')
        this.spray(player.x, player.y - 35, 60, '#ffe1a4', 330)
        return
      }
    }

    if (state.mode !== 'zen') {
      // The opening stretch is deliberately generous while the pilot learns the sail.
      player.energy = Math.max(
        0,
        player.energy -
          dt *
            (route?.drain ?? 1) *
            (state.time < 8
              ? 0.35
              : 4.5 + clamp((state.distance - 1800) / 4000, 0, 1) * 2),
      )
      if (player.energy <= 0) {
        state.phase = 'ended'
        state.reason = 'Your sunlight ran out. Catch sparks to keep the glow.'
        this.event('end', 'Until the next sunrise')
      }
    } else {
      player.energy = 100
    }
    this.lastDive = input.dive
    this.lastBoost = input.boost
  }

  private launch(strength: number): void {
    const player = this.state.player
    player.grounded = false
    player.y -= 2
    player.vy = -Math.min(590, strength)
    this.airDuration = 0
    this.launchCooldown = 0.42
    this.spray(player.x - 14, player.y + 16, 7, '#fbe1aa', 90)
  }

  private land(ground: number, slope: number): void {
    const state = this.state
    const player = state.player
    const impact = player.vy - slope * player.vx
    const flew = this.airDuration > 0.42
    const clean =
      flew && ((slope > 0.09 && impact < 590) || Math.abs(impact) < 200)
    const perfect =
      clean && slope > 0.12 && Math.abs(impact) < 430 && this.airDuration > 0.65
    state.landing = perfect
      ? 'perfect'
      : clean
        ? 'clean'
        : flew
          ? 'rough'
          : 'none'
    if (flew) state.landingAt = state.time
    player.y = ground
    player.grounded = true
    player.vy = slope * player.vx
    this.launchCooldown = Math.max(this.launchCooldown, 0.18)
    if (clean) {
      state.cleanLandings++
      if (perfect) {
        state.perfectLandings++
        this.charge(8)
        this.scoreBonus += 120 * Math.max(1, state.combo)
      }
      this.addCombo()
      this.charge(14)
      player.energy = Math.min(100, player.energy + 1.5)
      player.vx = Math.min(760, player.vx + 32 + Math.max(0, slope) * 45)
      this.scoreBonus += 80 * Math.max(1, state.combo)
      this.event(
        perfect ? 'perfect' : 'landing',
        perfect
          ? `Perfect landing · ×${state.combo}`
          : state.combo > 1
            ? `Silky landing · ×${state.combo}`
            : 'Silky landing',
      )
      this.spray(player.x, player.y + 12, 20, '#a2efe0', 160)
    } else if (flew) {
      player.vx *= impact > 650 ? 0.83 : 0.96
      state.combo = Math.max(0, state.combo - 1)
      this.spray(player.x, player.y + 12, 10, '#f2cda2', 100)
    }
    this.airDuration = 0
  }

  private charge(amount: number): void {
    const player = this.state.player
    player.charge = Math.min(
      100,
      player.charge + amount * (player.boostTime > 0 ? 0.3 : 1),
    )
  }

  private boost(): void {
    const state = this.state
    const player = state.player
    player.charge -= 65
    player.boostTime = 2.8
    player.invincible = Math.max(player.invincible, 2.8)
    player.vx = Math.min(940, player.vx + 240)
    if (player.grounded) this.launch(255)
    state.boosts++
    state.shake = 0.3
    this.scoreBonus += 150
    this.event('boost', 'Solar burst!')
    this.spray(player.x, player.y, 32, '#8ce8dc', 320)
  }

  private addCombo(): void {
    this.state.combo = Math.min(8, this.state.combo + 1)
    this.state.bestCombo = Math.max(this.state.bestCombo, this.state.combo)
  }

  private populate(): void {
    const state = this.state
    while (this.nextChunk * CHUNK < state.player.x + 2300) {
      const index = this.nextChunk++
      const base = index * CHUNK
      const r = (offset: number) => noise(state.seed, index * 37 + offset + 20)
      const aerial = index > 1 && r(1) > 0.45
      const start = base + 290
      for (let i = 0; i < 6; i++) {
        const x = start + i * 48
        const arch = aerial
          ? Math.sin(((i + 1) / 7) * Math.PI) * (85 + r(2) * 55)
          : 0
        this.entity(
          'spark',
          x,
          terrain(x, state.seed) - 31 - arch,
          9,
          r(3 + i) * TAU,
        )
      }
      if (index % 6 === 3) {
        // Three aligned gates invite a deliberate arcing flight across a safe chunk.
        const xs = [base + 270, base + 440, base + 610]
        const ceiling = Math.min(...xs.map((x) => terrain(x, state.seed))) - 65
        xs.forEach((x, i) =>
          this.entity('ring', x, ceiling - (i === 1 ? 28 : 0), 35, r(11) * TAU),
        )
      } else {
        const ringX = base + 640
        this.entity(
          'ring',
          ringX,
          terrain(ringX, state.seed) - (85 + r(10) * 100),
          32,
          r(11) * TAU,
        )
      }
      const powerChunk = index > 1 && (index % 8 === 3 || index % 8 === 5)
      if (powerChunk) {
        const x = base + 110
        this.entity(
          index % 8 === 3 ? 'shield' : 'magnet',
          x,
          terrain(x, state.seed) - 45,
          24,
          r(21) * TAU,
        )
      }
      if (index > 1 && index % 7 === 4) {
        const x = base + 180
        this.entity('thermal', x, terrain(x, state.seed) - 115, 55, r(22) * TAU)
      }
      if (index > 0 && index % 4 === 2) {
        const x = base + 130
        this.entity('sunwell', x, terrain(x, state.seed) - 38, 23, r(12) * TAU)
      }
      // Obstacles never share a chunk with the first lesson. Every obstacle has an open route.
      if (
        base > 4100 &&
        (!this.route || base > state.startX + 550) &&
        index % 4 !== 2 &&
        index % 6 !== 3 &&
        index % 7 !== 4 &&
        !powerChunk &&
        r(14) > 0.12
      ) {
        const x = base + 160
        if (r(15) < 0.56) {
          this.entity(
            'rock',
            x,
            terrain(x, state.seed) - 15,
            23 + r(16) * 7,
            r(17) * TAU,
          )
        } else {
          this.entity(
            'storm',
            x,
            terrain(x, state.seed) - 150 - r(16) * 75,
            32 + r(17) * 9,
            r(18) * TAU,
          )
        }
      }
    }
  }

  private entity(
    kind: Entity['kind'],
    x: number,
    y: number,
    radius: number,
    phase: number,
  ): void {
    this.state.entities.push({
      id: this.nextEntity++,
      kind,
      x,
      y,
      radius,
      collected: false,
      phase,
    })
  }

  private collide(dt: number): void {
    const state = this.state
    const player = state.player
    for (const entity of state.entities) {
      if (entity.collected) continue
      if (
        entity.kind === 'ring' &&
        !entity.missed &&
        entity.x < player.x - 80
      ) {
        entity.missed = true
        state.ringChain = 0
      }
      if (Math.abs(entity.x - player.x) > 210) continue
      if (entity.kind === 'thermal') {
        if (
          !state.diving &&
          Math.abs(entity.x - player.x) < 65 &&
          player.y > entity.y - 145 &&
          player.y < entity.y + 135
        ) {
          entity.collected = true
          player.grounded = false
          player.vy = Math.min(player.vy, -390)
          player.y -= 2
          this.launchCooldown = 0.3
          state.thermalsRidden++
          this.charge(10)
          this.scoreBonus += 150
          this.event('thermal', 'Rising wind · ride the thermal')
          this.spray(player.x, player.y, 20, '#baf3e1', 180)
        }
        continue
      }
      let dx = entity.x - player.x
      let dy = entity.y - player.y
      let distance = Math.hypot(dx, dy)
      if (entity.kind === 'spark' && player.magnetTime > 0 && distance < 195) {
        // Pull faster than the skiff can fly, including during a solar burst.
        const attraction = Math.min(1, (1750 * dt) / Math.max(1, distance))
        entity.x -= dx * attraction
        entity.y -= dy * attraction
        dx = entity.x - player.x
        dy = entity.y - player.y
        distance = Math.hypot(dx, dy)
      }
      const hazard = entity.kind === 'rock' || entity.kind === 'storm'
      const reach =
        entity.radius + (hazard ? 10 : entity.kind === 'spark' ? 23 : 20)
      if (distance < reach) {
        if (hazard) {
          if (player.boostTime > 0) {
            entity.collected = true
            this.scoreBonus += 100
            this.spray(entity.x, entity.y, 20, '#fce2bd', 220)
          } else if (
            player.invincible <= 0 &&
            state.time > 8 &&
            player.shield
          ) {
            entity.collected = true
            player.shield = false
            player.invincible = 1.5
            this.event('power', 'Sun shield saved your flow')
            this.spray(player.x, player.y, 32, '#aef5dc', 220)
          } else if (player.invincible <= 0 && state.time > 8) {
            entity.collected = true
            state.hits++
            state.ringChain = 0
            player.invincible = 1.8
            player.energy = Math.max(
              state.mode === 'zen' ? 100 : 0,
              player.energy - 25,
            )
            player.vx = Math.max(245, player.vx * 0.74)
            player.charge = Math.max(0, player.charge - 8)
            state.combo = 0
            state.shake = 0.72
            this.event(
              'hit',
              state.mode === 'zen'
                ? 'A bump in the breeze · keep flying'
                : entity.kind === 'rock'
                  ? 'Rough sand · −25 sunlight'
                  : 'Storm brushed · −25 sunlight',
            )
            this.spray(player.x, player.y, 24, '#ee927e', 210)
          }
        } else {
          entity.collected = true
          const multiplier = Math.max(1, state.combo)
          if (entity.kind === 'spark') {
            state.sparks++
            if (player.magnetTime > 0) state.magneticSparks++
            player.energy = Math.min(100, player.energy + 0.38)
            this.charge(2)
            this.scoreBonus += 15 * multiplier
            this.spray(entity.x, entity.y, 5, '#ffecaf', 85)
          } else if (entity.kind === 'ring') {
            state.rings++
            this.addCombo()
            player.energy = Math.min(100, player.energy + 5)
            this.charge(15)
            this.scoreBonus += 120 * Math.max(1, state.combo)
            this.event('ring', `Sun ring · ×${Math.max(1, state.combo)}`)
            this.spray(entity.x, entity.y, 22, '#ffdea0', 180)
            state.ringChain++
            state.chainDeadline = state.time + 9
            if (state.ringChain >= 3) {
              state.ringChain = 0
              state.skyChains++
              player.magnetTime = Math.max(player.magnetTime, 8)
              player.energy = Math.min(100, player.energy + 12)
              this.charge(25)
              this.scoreBonus += 600 * Math.max(1, state.combo)
              this.event('chain', 'Sky chain! · light magnet + bonus')
              this.spray(player.x, player.y, 40, '#cdefff', 260)
            }
          } else if (entity.kind === 'shield') {
            player.shield = true
            this.event('power', 'Sun shield · one free hit')
            this.spray(entity.x, entity.y, 24, '#b1f2d2', 160)
          } else if (entity.kind === 'magnet') {
            player.magnetTime = 10
            this.event('power', 'Light magnet · 10 seconds')
            this.spray(entity.x, entity.y, 24, '#c9c2ff', 160)
          } else {
            player.energy = Math.min(100, player.energy + 20)
            this.charge(12)
            this.scoreBonus += 100
            this.event('spark', 'Sunwell · +20 sunlight')
            this.spray(entity.x, entity.y, 26, '#a4eee0', 180)
          }
        }
      } else if (
        hazard &&
        !entity.nearMissed &&
        dx < -entity.radius - 10 &&
        distance < entity.radius + 75
      ) {
        entity.nearMissed = true
        state.nearMisses++
        this.charge(7)
        this.scoreBonus += 60 * Math.max(1, state.combo)
        this.event('near', 'Close call · +7 charge')
      }
    }
  }

  private effects(dt: number, diving: boolean): void {
    const state = this.state
    const player = state.player
    this.trailClock += dt
    if (this.trailClock >= 1 / 60) {
      this.trailClock = 0
      player.trail.push({
        x: player.x - 14,
        y: player.y + 5,
        life: player.boostTime > 0 ? 0.8 : 0.58,
      })
    }
    for (const dot of player.trail) dot.life -= dt
    player.trail = player.trail.filter((dot) => dot.life > 0).slice(-50)
    this.exhaustClock += dt
    if (this.exhaustClock > (player.boostTime > 0 ? 0.035 : 0.095)) {
      this.exhaustClock = 0
      if (player.boostTime > 0 || (diving && player.grounded)) {
        this.spray(
          player.x - 20,
          player.y + 10,
          1,
          state.trail === 'sunlight'
            ? player.boostTime > 0
              ? '#95ebdb'
              : '#f4d8b2'
            : trailById(state.trail).color,
          55,
        )
      }
    }
    for (const particle of state.particles) {
      particle.life -= dt
      particle.x += particle.vx * dt
      particle.y += particle.vy * dt
      particle.vy += dt * 130
    }
    state.particles = state.particles
      .filter((particle) => particle.life > 0)
      .slice(-240)
  }

  private spray(
    x: number,
    y: number,
    count: number,
    color: string,
    speed: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const random = () =>
        noise(this.state.seed ^ 0x27d4eb2d, this.effectCounter++)
      const angle = random() * TAU
      const velocity = (0.25 + random() * 0.75) * speed
      const life = 0.3 + random() * 0.5
      this.state.particles.push({
        x,
        y,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity - 35,
        life,
        maxLife: life,
        size: 1.5 + random() * 3,
        color,
      })
    }
  }

  private event(kind: EventKind, text: string): void {
    this.state.events.push({
      id: this.nextEvent++,
      kind,
      text,
      time: this.state.time,
    })
  }
}
