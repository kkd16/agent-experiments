import type { GameMode, GameState, ShipId } from './types'
import {
  expeditionById,
  expeditionMedals,
  medalCount,
  readExpeditions,
  sealCount,
} from './expeditions.ts'
import type { ExpeditionRecords } from './expeditions'
import { TRAILS, trailById } from './cosmetics.ts'
import type { TrailId } from './cosmetics'

export interface FlightLog {
  id: string
  date: string
  mode: GameMode
  seed: number
  distance: number
  score: number
  duration: number
  sparks: number
  rings: number
  perfect: number
  chains: number
  expeditionId?: string
}

export interface Progress {
  version: 1
  bank: number
  best: number
  bestScore: number
  totalDistance: number
  totalRuns: number
  owned: ShipId[]
  selected: ShipId
  completed: string[]
  daily: { date: string; best: number }
  sound: boolean
  history: FlightLog[]
  coach: boolean
  ghost: boolean
  expeditions: ExpeditionRecords
  trail: TrailId
}

export interface Mission {
  id: string
  title: string
  description: string
  reward: number
  kind:
    | 'distance'
    | 'sparks'
    | 'rings'
    | 'cleanLandings'
    | 'maxAirtime'
    | 'bestCombo'
    | 'boosts'
    | 'nearMisses'
    | 'perfectLandings'
    | 'skyChains'
    | 'thermalsRidden'
    | 'magneticSparks'
  target: number
}

export const SHIPS: {
  id: ShipId
  name: string
  subtitle: string
  price: number
  color: string
  seals?: number
}[] = [
  {
    id: 'sol',
    name: 'Sol',
    subtitle: 'A little sail. An endless sky.',
    price: 0,
    color: '#75d8ce',
  },
  {
    id: 'manta',
    name: 'Manta',
    subtitle: 'A violet-colored daydream.',
    price: 150,
    color: '#b798db',
  },
  {
    id: 'comet',
    name: 'Comet',
    subtitle: 'Leave a little stardust.',
    price: 400,
    color: '#ec8a67',
  },
  {
    id: 'kestrel',
    name: 'Kestrel',
    subtitle: 'Two wings. Every horizon.',
    price: 0,
    color: '#e9bb72',
    seals: 12,
  },
]

export const MISSIONS: Mission[] = [
  {
    id: 'first-light',
    title: 'First light',
    description: 'Travel 500 m in one run',
    kind: 'distance',
    target: 500,
    reward: 25,
  },
  {
    id: 'pocket-sunshine',
    title: 'Pocket sunshine',
    description: 'Collect 12 sparks in one run',
    kind: 'sparks',
    target: 12,
    reward: 25,
  },
  {
    id: 'soft-touch',
    title: 'Soft touch',
    description: 'Make 2 clean landings in one run',
    kind: 'cleanLandings',
    target: 2,
    reward: 30,
  },
  {
    id: 'ring-seeker',
    title: 'Ring seeker',
    description: 'Thread 3 sun rings in one run',
    kind: 'rings',
    target: 3,
    reward: 40,
  },
  {
    id: 'air-mail',
    title: 'Air mail',
    description: 'Stay airborne for 3 seconds',
    kind: 'maxAirtime',
    target: 3,
    reward: 40,
  },
  {
    id: 'sun-powered',
    title: 'Sun-powered',
    description: 'Use 2 solar bursts in one run',
    kind: 'boosts',
    target: 2,
    reward: 50,
  },
  {
    id: 'far-from-home',
    title: 'Far from home',
    description: 'Travel 2,000 m in one run',
    kind: 'distance',
    target: 2000,
    reward: 60,
  },
  {
    id: 'close-call',
    title: 'Close call',
    description: 'Make 2 near misses in one run',
    kind: 'nearMisses',
    target: 2,
    reward: 60,
  },
  {
    id: 'in-the-flow',
    title: 'In the flow',
    description: 'Reach a 5× combo',
    kind: 'bestCombo',
    target: 5,
    reward: 70,
  },
  {
    id: 'gold-rush',
    title: 'Gold rush',
    description: 'Collect 60 sparks in one run',
    kind: 'sparks',
    target: 60,
    reward: 80,
  },
  {
    id: 'cloud-surfer',
    title: 'Cloud surfer',
    description: 'Make 12 clean landings in one run',
    kind: 'cleanLandings',
    target: 12,
    reward: 90,
  },
  {
    id: 'last-light',
    title: 'Chase the last light',
    description: 'Travel 5,000 m in one run',
    kind: 'distance',
    target: 5000,
    reward: 120,
  },
]

MISSIONS.push(
  {
    id: 'sky-weaver',
    title: 'Sky weaver',
    description: 'Link 3 rings without missing one',
    kind: 'skyChains',
    target: 1,
    reward: 75,
  },
  {
    id: 'wind-rider',
    title: 'Wind rider',
    description: 'Ride 3 thermals in one flight',
    kind: 'thermalsRidden',
    target: 3,
    reward: 75,
  },
  {
    id: 'golden-touch',
    title: 'Golden touch',
    description: 'Make 5 perfect landings in one flight',
    kind: 'perfectLandings',
    target: 5,
    reward: 100,
  },
  {
    id: 'magnetic-personality',
    title: 'Magnetic personality',
    description: 'Attract 30 sparks in one flight',
    kind: 'magneticSparks',
    target: 30,
    reward: 100,
  },
)

const SAVE_KEY = 'sunwake.progress.v1'
const MAX_VALUE = 1_000_000_000_000
const today = () => new Date().toISOString().slice(0, 10)

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_VALUE, Math.max(0, Math.floor(value)))
    : 0
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  )
}

function isShip(value: unknown): value is ShipId {
  return (
    value === 'sol' ||
    value === 'manta' ||
    value === 'comet' ||
    value === 'kestrel'
  )
}

export function freshProgress(): Progress {
  return {
    version: 1,
    bank: 0,
    best: 0,
    bestScore: 0,
    totalDistance: 0,
    totalRuns: 0,
    owned: ['sol'],
    selected: 'sol',
    completed: [],
    daily: { date: today(), best: 0 },
    sound: false,
    history: [],
    coach: true,
    ghost: true,
    expeditions: {},
    trail: 'sunlight',
  }
}

function readHistory(raw: unknown): FlightLog[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is FlightLog => {
      if (!item || typeof item !== 'object') return false
      const row = item as FlightLog
      return (
        typeof row.id === 'string' &&
        row.id.length < 80 &&
        validDate(row.date) &&
        ['voyage', 'daily', 'zen', 'expedition'].includes(row.mode) &&
        (row.mode !== 'expedition' ||
          expeditionById(row.expeditionId)?.seed === row.seed) &&
        Number.isInteger(row.seed) &&
        row.seed > 0 &&
        row.seed <= 0xffffffff &&
        [
          'distance',
          'score',
          'duration',
          'sparks',
          'rings',
          'perfect',
          'chains',
        ].every((key) => {
          const n = row[key as keyof FlightLog]
          return (
            typeof n === 'number' &&
            Number.isFinite(n) &&
            n >= 0 &&
            n <= MAX_VALUE
          )
        })
      )
    })
    .slice(0, 12)
    .map((row) => ({ ...row }))
}
function historyEntry(
  progress: Progress,
  state: GameState,
  date: string,
): FlightLog[] {
  const entry: FlightLog = {
    id: `${date}-${progress.totalRuns + 1}-${state.seed}`,
    date,
    mode: state.mode,
    seed: state.seed,
    distance: count(state.distance),
    score: count(state.score),
    duration: count(state.time),
    sparks: count(state.sparks),
    rings: count(state.rings),
    perfect: count(state.perfectLandings),
    chains: count(state.skyChains),
    ...(state.expeditionId ? { expeditionId: state.expeditionId } : {}),
  }
  return [entry, ...progress.history].slice(0, 12)
}

export function loadProgress(): Progress {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null')
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('version' in raw) ||
      raw.version !== 1
    )
      return freshProgress()
    const data = raw as Record<string, unknown>
    const expeditions = readExpeditions(data.expeditions)
    const seals = sealCount(expeditions)
    const owned: ShipId[] = ['sol']
    if (Array.isArray(data.owned)) {
      for (const id of data.owned)
        if (
          isShip(id) &&
          !owned.includes(id) &&
          (id !== 'kestrel' || seals >= 12)
        )
          owned.push(id)
    }
    if (seals >= 12 && !owned.includes('kestrel')) owned.push('kestrel')
    const knownMissions = new Set(MISSIONS.map((mission) => mission.id))
    const completed = Array.isArray(data.completed)
      ? [
          ...new Set(
            data.completed.filter(
              (id): id is string =>
                typeof id === 'string' && knownMissions.has(id),
            ),
          ),
        ]
      : []
    const daily =
      data.daily && typeof data.daily === 'object'
        ? (data.daily as Record<string, unknown>)
        : {}
    const date = today()
    return {
      version: 1,
      bank: count(data.bank),
      best: count(data.best),
      bestScore: count(data.bestScore),
      totalDistance: count(data.totalDistance),
      totalRuns: count(data.totalRuns),
      owned,
      selected:
        isShip(data.selected) && owned.includes(data.selected)
          ? data.selected
          : 'sol',
      completed,
      sound: data.sound === true,
      coach: data.coach !== false,
      ghost: data.ghost !== false,
      history: readHistory(data.history),
      expeditions,
      trail:
        trailById(data.trail).seals <= seals
          ? trailById(data.trail).id
          : 'sunlight',
      daily: {
        date,
        best:
          validDate(daily.date) && daily.date === date ? count(daily.best) : 0,
      },
    }
  } catch {
    // Private browsing and blocked storage still allow a complete in-memory game.
    return freshProgress()
  }
}

export function saveProgress(progress: Progress): boolean {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(progress))
    return true
  } catch {
    // The caller keeps the live state even when the browser cannot persist it.
    return false
  }
}

export function dailySeed(date: string): number {
  let hash = 2166136261
  for (const char of `sunwake:${date}`)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return hash >>> 0
}

export function settleRun(
  progress: Progress,
  state: GameState,
  date: string,
): {
  progress: Progress
  earned: number
  completed: typeof MISSIONS
  newBest: boolean
  expedition: {
    routeId: string
    medals: number
    newMedals: number
    totalMedals: number
    unlocked: string[]
  } | null
} {
  if (state.phase !== 'ended')
    return {
      progress,
      earned: 0,
      completed: [],
      newBest: false,
      expedition: null,
    }
  const runDate = validDate(date) ? date : today()
  const history = historyEntry(progress, state, runDate)
  if (state.mode === 'zen') {
    return {
      progress: {
        ...progress,
        history,
        totalDistance: count(progress.totalDistance + count(state.distance)),
        totalRuns: count(progress.totalRuns + 1),
      },
      earned: 0,
      completed: [],
      newBest: false,
      expedition: null,
    }
  }
  if (state.mode === 'expedition') {
    const route = expeditionById(state.expeditionId)
    const previous = route ? progress.expeditions[route.id] : undefined
    const medals = route ? expeditionMedals(route, state) : 0
    const oldMedals = previous?.medals ?? 0
    const newMedals = medals & ~oldMedals
    const totalMedals = oldMedals | medals
    const expeditions = { ...progress.expeditions }
    if (route)
      expeditions[route.id] = {
        medals: totalMedals,
        bestTime:
          medals & 1
            ? Math.min(previous?.bestTime || Infinity, state.time)
            : (previous?.bestTime ?? 0),
        attempts: count((previous?.attempts ?? 0) + 1),
      }
    const owned = [...progress.owned]
    const beforeSeals = sealCount(progress.expeditions)
    const afterSeals = sealCount(expeditions)
    const unlocked = TRAILS.filter(
      (trail) => trail.seals > beforeSeals && trail.seals <= afterSeals,
    ).map((trail) => `${trail.name} wake`)
    if (beforeSeals < 12 && afterSeals >= 12) unlocked.unshift('Kestrel skiff')
    if (afterSeals >= 12 && !owned.includes('kestrel')) owned.push('kestrel')
    const earned = route ? count(state.sparks) + medalCount(newMedals) * 40 : 0
    return {
      progress: {
        ...progress,
        history,
        expeditions,
        owned,
        bank: count(progress.bank + earned),
        totalRuns: count(progress.totalRuns + 1),
        totalDistance: count(progress.totalDistance + count(state.distance)),
      },
      earned,
      completed: [],
      newBest: false,
      expedition: route
        ? { routeId: route.id, medals, newMedals, totalMedals, unlocked }
        : null,
    }
  }
  // Snapshot eligibility before awarding so a single run never skips ahead in the journal.
  const eligible = MISSIONS.filter(
    (mission) => !progress.completed.includes(mission.id),
  ).slice(0, 3)
  const completed = eligible.filter(
    (mission) => state[mission.kind] >= mission.target,
  )
  const earned =
    count(state.sparks) +
    completed.reduce((sum, mission) => sum + mission.reward, 0)
  const distance = count(state.distance)
  const dailyBest = progress.daily.date === runDate ? progress.daily.best : 0
  const next: Progress = {
    ...progress,
    history,
    bank: count(progress.bank + earned),
    best: Math.max(progress.best, distance),
    bestScore: Math.max(progress.bestScore, count(state.score)),
    totalDistance: count(progress.totalDistance + distance),
    totalRuns: count(progress.totalRuns + 1),
    owned: [...progress.owned],
    completed: [
      ...progress.completed,
      ...completed.map((mission) => mission.id),
    ],
    daily: {
      date: runDate,
      best: state.mode === 'daily' ? Math.max(dailyBest, distance) : dailyBest,
    },
  }
  return {
    progress: next,
    earned,
    completed,
    newBest: distance > progress.best,
    expedition: null,
  }
}

export const formatTime = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0')}`
