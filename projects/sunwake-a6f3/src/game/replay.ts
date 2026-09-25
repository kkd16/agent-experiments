import type { GameMode, GameState, ShipId } from './types'

// Version the course rules so an old link never silently becomes a different route.
export const COURSE_VERSION = 2
export const GHOST_KEY = 'sunwake.ghosts.v2'
const LIMIT = 960
const MAX_RUNS = 4
export type GhostPoint = [time: number, x: number, y: number, angle: number]
export interface GhostRun {
  version: 2
  seed: number
  ship: ShipId
  distance: number
  duration: number
  points: GhostPoint[]
}
export interface GhostPosition {
  x: number
  y: number
  angle: number
  finished: boolean
}

export function courseFromHash(hash: string): number | null {
  const match = /^#\/course\/2\/([0-9a-z]{1,7})$/i.exec(hash)
  if (!match) return null
  const seed = parseInt(match[1], 36)
  return Number.isInteger(seed) && seed > 0 && seed <= 0xffffffff ? seed : null
}
export function courseHash(seed: number): string {
  return `#/course/${COURSE_VERSION}/${(seed >>> 0).toString(36)}`
}

/** Compact an arbitrarily long flight by progressively reducing the sample rate. */
export class FlightRecorder {
  private points: GhostPoint[] = []
  private interval = 0.2
  record(state: GameState): void {
    const last = this.points.at(-1)
    const roundedTime = +state.time.toFixed(3)
    if (last && state.time - last[0] < this.interval && state.phase !== 'ended')
      return
    if (last && roundedTime <= last[0]) return
    this.points.push([
      roundedTime,
      +state.player.x.toFixed(2),
      +state.player.y.toFixed(2),
      +state.player.rotation.toFixed(3),
    ])
    if (this.points.length >= LIMIT) {
      const lastIndex = this.points.length - 1
      this.points = this.points.filter(
        (_, index) => index % 2 === 0 || index === lastIndex,
      )
      this.interval *= 2
    }
  }
  finish(state: GameState): GhostRun {
    this.record(state)
    return {
      version: COURSE_VERSION,
      seed: state.seed,
      ship: state.ship,
      distance: state.distance,
      duration: state.time,
      points: this.points.map((point) => [...point]),
    }
  }
}

function validGhost(raw: unknown): raw is GhostRun {
  if (!raw || typeof raw !== 'object') return false
  const value = raw as GhostRun
  if (
    value.version !== COURSE_VERSION ||
    !Number.isInteger(value.seed) ||
    value.seed < 1 ||
    value.seed > 0xffffffff ||
    !['sol', 'manta', 'comet'].includes(value.ship)
  )
    return false
  if (
    !Number.isFinite(value.distance) ||
    value.distance < 0 ||
    value.distance > 1e7 ||
    !Number.isFinite(value.duration) ||
    value.duration <= 0 ||
    value.duration > 86400
  )
    return false
  if (
    !Array.isArray(value.points) ||
    value.points.length < 2 ||
    value.points.length > LIMIT
  )
    return false
  let previous = -1
  for (const point of value.points) {
    if (
      !Array.isArray(point) ||
      point.length !== 4 ||
      !point.every(Number.isFinite)
    )
      return false
    if (
      point[0] <= previous ||
      point[0] < 0 ||
      point[0] > value.duration + 0.01 ||
      point[1] < 150 ||
      point[1] > 1e8 ||
      point[2] < 0 ||
      point[2] > 760 ||
      Math.abs(point[3]) > Math.PI
    )
      return false
    previous = point[0]
  }
  return true
}

export class GhostLibrary {
  private runs: GhostRun[] = []
  constructor() {
    try {
      const text = localStorage.getItem(GHOST_KEY)
      if (!text || text.length > 600000) return
      const raw: unknown = JSON.parse(text)
      if (Array.isArray(raw))
        this.runs = raw.filter(validGhost).slice(0, MAX_RUNS)
    } catch {
      /* Flights still work when storage is unavailable. */
    }
  }
  get(seed: number): GhostRun | null {
    return this.runs.find((run) => run.seed === seed) ?? null
  }
  remember(run: GhostRun, mode: GameMode): boolean {
    if (mode === 'zen' || !validGhost(run)) return false
    const previous = this.get(run.seed)
    if (previous && previous.distance >= run.distance) return false
    this.runs = [
      run,
      ...this.runs.filter((item) => item.seed !== run.seed),
    ].slice(0, MAX_RUNS)
    try {
      localStorage.setItem(GHOST_KEY, JSON.stringify(this.runs))
    } catch {
      /* Retain the in-memory ghost. */
    }
    return true
  }
}

export function ghostAt(
  run: GhostRun | null,
  time: number,
): GhostPosition | null {
  if (!run || run.points.length < 2) return null
  const points = run.points
  let low = 0,
    high = points.length - 1
  while (low + 1 < high) {
    const middle = (low + high) >>> 1
    if (points[middle][0] <= time) low = middle
    else high = middle
  }
  const a = points[low],
    b = points[high]
  const t = Math.max(
    0,
    Math.min(1, (time - a[0]) / Math.max(0.001, b[0] - a[0])),
  )
  return {
    x: a[1] + (b[1] - a[1]) * t,
    y: a[2] + (b[2] - a[2]) * t,
    angle: a[3] + (b[3] - a[3]) * t,
    finished: time > run.duration,
  }
}
