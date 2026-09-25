import type { GameState, ShipId } from './types'

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
  target: number
}

export const SHIPS: {
  id: ShipId
  name: string
  subtitle: string
  price: number
  color: string
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
  return value === 'sol' || value === 'manta' || value === 'comet'
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
  }
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
    const owned: ShipId[] = ['sol']
    if (Array.isArray(data.owned)) {
      for (const id of data.owned)
        if (isShip(id) && !owned.includes(id)) owned.push(id)
    }
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
} {
  if (state.phase !== 'ended')
    return { progress, earned: 0, completed: [], newBest: false }
  if (state.mode === 'zen') {
    return {
      progress: {
        ...progress,
        totalDistance: count(progress.totalDistance + count(state.distance)),
        totalRuns: count(progress.totalRuns + 1),
      },
      earned: 0,
      completed: [],
      newBest: false,
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
  const runDate = validDate(date) ? date : today()
  const dailyBest = progress.daily.date === runDate ? progress.daily.best : 0
  const next: Progress = {
    ...progress,
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
  }
}
