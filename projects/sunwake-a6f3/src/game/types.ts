export type GamePhase = 'ready' | 'running' | 'paused' | 'ended'
export type GameMode = 'voyage' | 'daily' | 'zen'
export type ShipId = 'sol' | 'manta' | 'comet'
export type EntityKind = 'spark' | 'ring' | 'storm' | 'rock' | 'sunwell'
export type EventKind =
  'spark' | 'ring' | 'landing' | 'hit' | 'boost' | 'near' | 'biome' | 'end'

export interface Player {
  x: number
  y: number
  vx: number
  vy: number
  rotation: number
  grounded: boolean
  energy: number
  charge: number
  invincible: number
  boostTime: number
  trail: { x: number; y: number; life: number }[]
}

export interface Entity {
  id: number
  kind: EntityKind
  x: number
  y: number
  radius: number
  collected: boolean
  nearMissed?: boolean
  phase: number
}

export interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  size: number
  color: string
}

export interface GameEvent {
  id: number
  kind: EventKind
  text: string
  time: number
}

export interface GameState {
  phase: GamePhase
  mode: GameMode
  seed: number
  ship: ShipId
  time: number
  distance: number
  score: number
  sparks: number
  rings: number
  combo: number
  bestCombo: number
  cleanLandings: number
  airtime: number
  maxAirtime: number
  nearMisses: number
  boosts: number
  biome: number
  player: Player
  entities: Entity[]
  particles: Particle[]
  events: GameEvent[]
  reason: string
  shake: number
}

export interface GameInput {
  dive: boolean
  boost: boolean
}
export interface RunOptions {
  mode: GameMode
  ship: ShipId
  seed: number
}

export const WORLD_HEIGHT = 720
export const BIOMES = [
  {
    name: 'The amber sea',
    short: 'Amber sea',
    color: '#f6c779',
    mark: 'I',
    note: 'Where every journey catches the light.',
  },
  {
    name: 'The rose ruins',
    short: 'Rose ruins',
    color: '#f5a6ae',
    mark: 'II',
    note: 'Old worlds. New horizons.',
  },
  {
    name: 'The violet reach',
    short: 'Violet reach',
    color: '#c4acf4',
    mark: 'III',
    note: 'Follow the stars beyond the dunes.',
  },
  {
    name: 'The blue hour',
    short: 'Blue hour',
    color: '#91d7dc',
    mark: 'IV',
    note: 'Even the longest night gives way.',
  },
] as const
