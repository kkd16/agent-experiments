import type { GameState } from './types'

export interface Expedition {
  id: string
  name: string
  subtitle: string
  story: string
  seed: number
  start: number
  distance: number
  par: number
  skill: {
    kind: 'cleanLandings' | 'rings' | 'hits' | 'sparks' | 'thermalsRidden'
    target: number
    label: string
    maximum?: boolean
  }
  condition: string
  conditionNote: string
  wind: number
  gravity: number
  drain: number
  energy: number
  color: string
}
export interface ExpeditionRecord {
  medals: number
  bestTime: number
  attempts: number
}
export type ExpeditionRecords = Record<string, ExpeditionRecord>

export const EXPEDITIONS: Expedition[] = [
  {
    id: 'first-post',
    name: 'First post',
    subtitle: 'A letter to the horizon',
    story:
      'The first beacon is waiting across the amber dunes. Find a gentle rhythm and bring it a little sunlight.',
    seed: 127,
    start: 0,
    distance: 650,
    par: 16,
    skill: { kind: 'cleanLandings', target: 3, label: 'Make 3 clean landings' },
    condition: 'Open sky',
    conditionNote: 'Familiar dunes. A perfect place to learn the route.',
    wind: 0,
    gravity: 1,
    drain: 1,
    energy: 100,
    color: '#bc8951',
  },
  {
    id: 'rose-express',
    name: 'Rose express',
    subtitle: 'The wind is on your side',
    story:
      'Thread the broken arches of an old city. A steady tailwind turns every well-timed dive into a little promise.',
    seed: 281,
    start: 1000,
    distance: 900,
    par: 20,
    skill: { kind: 'rings', target: 6, label: 'Thread 6 sun rings' },
    condition: 'Tailwind',
    conditionNote: 'A steady wind adds speed on the ground and in the air.',
    wind: 28,
    gravity: 1,
    drain: 1,
    energy: 100,
    color: '#b77890',
  },
  {
    id: 'glass-crossing',
    name: 'Glass crossing',
    subtitle: 'Carry the light carefully',
    story:
      'Suspended islands mark the way through the violet reach. Stay clear of storms; this light is precious.',
    seed: 9137,
    start: 2000,
    distance: 1100,
    par: 26,
    skill: {
      kind: 'hits',
      target: 0,
      label: 'Arrive without taking a hit',
      maximum: true,
    },
    condition: 'Fading light',
    conditionNote: 'Sunlight fades 25% faster. Checkpoint beacons refill it.',
    wind: 0,
    gravity: 1,
    drain: 1.25,
    energy: 100,
    color: '#917ba7',
  },
  {
    id: 'lantern-run',
    name: 'Lantern run',
    subtitle: 'Gather a pocket of stars',
    story:
      'Leave at blue hour with a half-lit lantern. Gather sparks under the aurora and carry their glow to dawn.',
    seed: 6023,
    start: 3000,
    distance: 1400,
    par: 32,
    skill: { kind: 'sparks', target: 35, label: 'Collect 35 sparks' },
    condition: 'Half-lit lantern',
    conditionNote:
      'Start with 60 sunlight. Sparks and checkpoints keep you aloft.',
    wind: 0,
    gravity: 1,
    drain: 1.2,
    energy: 60,
    color: '#578a9b',
  },
  {
    id: 'updraft-alley',
    name: 'Updraft alley',
    subtitle: 'Take the long way up',
    story:
      'Warm air rises through the rose ruins. Open your sail inside the thermals and sail between the clouds.',
    seed: 491,
    start: 1200,
    distance: 1700,
    par: 38,
    skill: {
      kind: 'thermalsRidden',
      target: 3,
      label: 'Ride 3 rising thermals',
    },
    condition: 'Buoyant air',
    conditionNote:
      'Gentler gravity gives you longer glides. Release inside thermals.',
    wind: 0,
    gravity: 0.82,
    drain: 1,
    energy: 100,
    color: '#ad748a',
  },
  {
    id: 'last-beacon',
    name: 'Last beacon',
    subtitle: 'A horizon of your own',
    story:
      'One long crossing links the floating islands, the blue hour, and the returning sun. Bring everything you have learned.',
    seed: 7079,
    start: 2200,
    distance: 2400,
    par: 52,
    skill: { kind: 'rings', target: 12, label: 'Thread 12 sun rings' },
    condition: 'Long crossing',
    conditionNote:
      'Sunlight fades 15% faster. Save bursts for the right moment.',
    wind: 0,
    gravity: 1,
    drain: 1.15,
    energy: 100,
    color: '#6b7da0',
  },
]

export const expeditionById = (id: string | null | undefined) =>
  EXPEDITIONS.find((route) => route.id === id) ?? null
export const expeditionHash = (id: string) => `#/expedition/1/${id}`
export const expeditionFromHash = (hash: string) =>
  expeditionById(/^#\/expedition\/1\/([a-z-]+)$/.exec(hash)?.[1])
export const medalCount = (mask: number) =>
  Number(Boolean(mask & 1)) +
  Number(Boolean(mask & 2)) +
  Number(Boolean(mask & 4))
export const sealCount = (records: ExpeditionRecords) =>
  EXPEDITIONS.reduce(
    (sum, route) => sum + medalCount(records[route.id]?.medals ?? 0),
    0,
  )
export function routeUnlocked(id: string, records: ExpeditionRecords): boolean {
  const index = EXPEDITIONS.findIndex((route) => route.id === id)
  return (
    index === 0 ||
    (index > 0 && Boolean(records[EXPEDITIONS[index - 1].id]?.medals & 1))
  )
}
export function skillMet(route: Expedition, state: GameState): boolean {
  return route.skill.maximum
    ? state[route.skill.kind] <= route.skill.target
    : state[route.skill.kind] >= route.skill.target
}
export const swiftMet = (route: Expedition, time: number) =>
  time <= route.par + 1e-6

export function expeditionMedals(route: Expedition, state: GameState): number {
  if (
    state.phase !== 'ended' ||
    !state.arrived ||
    state.mode !== 'expedition' ||
    state.expeditionId !== route.id ||
    state.seed !== route.seed ||
    state.distance < route.distance
  )
    return 0
  return (
    1 | (skillMet(route, state) ? 2 : 0) | (swiftMet(route, state.time) ? 4 : 0)
  )
}
export function readExpeditions(raw: unknown): ExpeditionRecords {
  if (!raw || typeof raw !== 'object') return {}
  const records: ExpeditionRecords = {}
  for (const route of EXPEDITIONS) {
    const item = (raw as Record<string, unknown>)[route.id]
    if (!item || typeof item !== 'object') continue
    const value = item as Record<string, unknown>
    const medals =
      Number.isInteger(value.medals) &&
      Number(value.medals) >= 0 &&
      Number(value.medals) <= 7 &&
      Number(value.medals) & 1
        ? Number(value.medals)
        : 0
    records[route.id] = {
      medals,
      bestTime:
        medals &&
        typeof value.bestTime === 'number' &&
        Number.isFinite(value.bestTime) &&
        value.bestTime > 0 &&
        value.bestTime < 86400
          ? value.bestTime
          : 0,
      attempts:
        typeof value.attempts === 'number' && Number.isFinite(value.attempts)
          ? Math.min(1e9, Math.max(0, Math.floor(value.attempts)))
          : 0,
    }
  }
  return records
}
