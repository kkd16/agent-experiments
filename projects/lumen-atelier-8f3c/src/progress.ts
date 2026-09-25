/** Portable, version-independent player progress. Never trusts stored JSON. */
export type Completion = { moves: number; stars: number; hints: number; date: string }

export type Progress = {
  completed: Record<string, Completion>
  currentLevel: string
  sound: boolean
  ambience: boolean
  reduceMotion: boolean
  highContrast: boolean
}

export const STORAGE_KEY = 'lumen-lost-gardens-v1'
export const DEFAULT_PROGRESS: Progress = {
  completed: {},
  currentLevel: 'level-01',
  sound: true,
  ambience: false,
  reduceMotion: false,
  highContrast: false,
}

function freshProgress(): Progress {
  return { ...DEFAULT_PROGRESS, completed: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)
    && value !== '__proto__' && value !== 'constructor' && value !== 'prototype'
}

function integer(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum
}

function sanitize(value: unknown): Progress | null {
  if (!isRecord(value) || !isRecord(value.completed) || !validId(value.currentLevel)) return null
  const result = freshProgress()
  result.currentLevel = value.currentLevel
  for (const key of ['sound', 'ambience', 'reduceMotion', 'highContrast'] as const) {
    if (typeof value[key] === 'boolean') result[key] = value[key]
  }
  for (const [id, completion] of Object.entries(value.completed).slice(0, 20000)) {
    if (!validId(id) || !isRecord(completion)) continue
    const { moves, stars, hints, date } = completion
    if (!integer(moves, 1000000) || !integer(stars, 3) || !integer(hints, 10000)) continue
    if (typeof date !== 'string' || date.length > 40 || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(date)
      || !Number.isFinite(Date.parse(date))) continue
    const calendarDay = new Date(`${date.slice(0, 10)}T00:00:00.000Z`)
    if (!Number.isFinite(calendarDay.getTime()) || calendarDay.toISOString().slice(0, 10) !== date.slice(0, 10)) continue
    result.completed[id] = { moves, stars, hints, date }
  }
  return result
}

/** Invalid, unavailable, or full browser storage never prevents playing. */
export function loadProgress(): Progress {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? importProgress(stored) ?? freshProgress() : freshProgress()
  } catch {
    return freshProgress()
  }
}

export function saveProgress(progress: Progress): boolean {
  try {
    const sanitized = sanitize(progress)
    if (!sanitized) return false
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized))
    return true
  } catch {
    return false
  }
}

export function exportProgress(progress: Progress): string {
  return JSON.stringify(sanitize(progress) ?? freshProgress(), null, 2)
}

export function importProgress(json: string): Progress | null {
  try {
    if (json.length > 5000000) return null
    return sanitize(JSON.parse(json) as unknown)
  } catch {
    return null
  }
}
