import { simulate } from './game.ts'
import type { Level, Tile } from './game.ts'

export type GardenSnapshot = { tiles: Tile[]; moves: number }
export type GardenSession = GardenSnapshot & {
  level: Level
  history: GardenSnapshot[]
  future: GardenSnapshot[]
  hints: number
  hintId: string | null
  hintRotation: number | null
  won: boolean
}
export type GardenSessionSummary = { moves: number; hints: number; won: boolean; updatedAt: string }

export const SESSION_LIBRARY_KEY = 'lumen-garden-library-v2'
const LEGACY_KEY = 'lumen-garden-session-v1'
const MAX_GARDENS = 200
const MAX_STATES = 100
const MAX_TILES = 256
const MAX_STORAGE_LENGTH = 16000000

type StoredSnapshot = { rotations: number[]; moves: number }
type StoredGarden = StoredSnapshot & GardenSessionSummary & {
  signature: string
  history: StoredSnapshot[]
  future: StoredSnapshot[]
  hintId: string | null
  hintRotation: number | null
}
type Library = Record<string, StoredGarden>

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function integer(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)
    && !['__proto__', 'constructor', 'prototype'].includes(value)
}
function locked(tile: Tile): boolean {
  return Boolean(tile.fixed) || ['source', 'crystal', 'rock'].includes(tile.kind)
}
function signature(level: Level): string {
  // Exact canonical geometry, original orientations, and solution: no hash collisions.
  return JSON.stringify([level.size, level.tiles.map(tile => [
    tile.id, tile.x, tile.y, tile.kind, tile.rotation, Boolean(tile.fixed), tile.pair ?? null, level.solution[tile.id],
  ])])
}
function date(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}
function readSnapshot(value: unknown, length?: number): StoredSnapshot | null {
  if (!record(value) || !integer(value.moves, 1000000) || !Array.isArray(value.rotations)) return null
  if (value.rotations.length < 1 || value.rotations.length > MAX_TILES
    || (length !== undefined && value.rotations.length !== length)
    || !value.rotations.every(rotation => integer(rotation, 3))) return null
  return { rotations: [...value.rotations] as number[], moves: value.moves }
}
function readStack(value: unknown, length: number): StoredSnapshot[] {
  if (!Array.isArray(value)) return []
  const states = value.slice(-MAX_STATES).map(item => readSnapshot(item, length))
  // Dropping one middle snapshot would silently skip an undo step; discard that stack.
  return states.every((state): state is StoredSnapshot => state !== null) ? states : []
}
function readGarden(value: unknown): StoredGarden | null {
  const snapshot = readSnapshot(value)
  if (!snapshot || !record(value) || !integer(value.hints, 10000) || typeof value.won !== 'boolean'
    || typeof value.signature !== 'string' || value.signature.length > 50000 || !date(value.updatedAt)) return null
  const hintValid = validId(value.hintId) && integer(value.hintRotation, 3)
  return {
    ...snapshot, hints: value.hints, won: value.won, signature: value.signature, updatedAt: value.updatedAt,
    history: readStack(value.history, snapshot.rotations.length),
    future: readStack(value.future, snapshot.rotations.length),
    hintId: hintValid ? value.hintId as string : null,
    hintRotation: hintValid ? value.hintRotation as number : null,
  }
}
function readLibrary(): Library {
  const text = localStorage.getItem(SESSION_LIBRARY_KEY)
  if (!text || text.length > MAX_STORAGE_LENGTH) return {}
  let parsed: unknown
  try { parsed = JSON.parse(text) as unknown } catch { return {} }
  if (!record(parsed) || parsed.version !== 2 || !record(parsed.gardens)) return {}
  const gardens: [string, StoredGarden][] = []
  for (const [id, value] of Object.entries(parsed.gardens)) {
    if (!validId(id)) continue
    const garden = readGarden(value)
    if (garden) gardens.push([id, garden])
  }
  return Object.fromEntries(gardens.sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt)).slice(0, MAX_GARDENS))
}
function unpackSnapshot(snapshot: StoredSnapshot, level: Level): GardenSnapshot {
  return {
    moves: snapshot.moves,
    tiles: level.tiles.map((tile, index) => ({ ...tile, rotation: locked(tile) ? tile.rotation : snapshot.rotations[index] })),
  }
}
function packSnapshot(snapshot: GardenSnapshot, level: Level): StoredSnapshot | null {
  if (!integer(snapshot.moves, 1000000) || !Array.isArray(snapshot.tiles) || snapshot.tiles.length !== level.tiles.length) return null
  const byId = new Map(snapshot.tiles.map(tile => [tile.id, tile]))
  if (byId.size !== level.tiles.length) return null
  const rotations: number[] = []
  for (const canonical of level.tiles) {
    const tile = byId.get(canonical.id)
    if (!tile || !integer(tile.rotation, 3)) return null
    rotations.push(locked(canonical) ? canonical.rotation : tile.rotation)
  }
  return { rotations, moves: snapshot.moves }
}
function packStack(stack: GardenSnapshot[], level: Level): StoredSnapshot[] {
  if (!Array.isArray(stack)) return []
  const snapshots = stack.slice(-MAX_STATES).map(snapshot => packSnapshot(snapshot, level))
  return snapshots.every((snapshot): snapshot is StoredSnapshot => snapshot !== null) ? snapshots : []
}
function unpackGarden(stored: StoredGarden, level: Level): GardenSession {
  const snapshot = unpackSnapshot(stored, level)
  const won = simulate(snapshot.tiles).solved
  const hintTile = level.tiles.find(tile => tile.id === stored.hintId && !locked(tile))
  const hintValid = !won && Boolean(hintTile) && integer(stored.hintRotation, 3)
  return {
    ...snapshot, level, won, hints: stored.hints,
    history: stored.history.map(state => unpackSnapshot(state, level)),
    future: stored.future.map(state => unpackSnapshot(state, level)),
    hintId: hintValid ? stored.hintId : null,
    hintRotation: hintValid ? stored.hintRotation : null,
  }
}

export function newSession(level: Level): GardenSession {
  const tiles = level.tiles.map(tile => ({ ...tile }))
  return { level, tiles, moves: 0, history: [], future: [], hints: 0, hintId: null, hintRotation: null, won: simulate(tiles).solved }
}

export function loadSession(level: Level): GardenSession {
  try {
    const stored = readLibrary()[level.id]
    if (stored) {
      if (stored.signature !== signature(level) || stored.rotations.length !== level.tiles.length) return newSession(level)
      return unpackGarden(stored, level)
    }
    const text = localStorage.getItem(LEGACY_KEY)
    if (!text || text.length > 100000) return newSession(level)
    const legacy: unknown = JSON.parse(text)
    const snapshot = readSnapshot(legacy, level.tiles.length)
    if (!snapshot || !record(legacy) || legacy.id !== level.id || !integer(legacy.hints, 10000)) return newSession(level)
    const restored = { ...newSession(level), ...unpackSnapshot(snapshot, level), hints: legacy.hints }
    restored.won = simulate(restored.tiles).solved
    // Keep the old save intact if the browser refuses the migration write.
    if (saveSession(restored)) {
      try { localStorage.removeItem(LEGACY_KEY) } catch { /* A later load prefers the migrated library. */ }
    }
    return restored
  } catch {
    return newSession(level)
  }
}

export function saveSession(session: GardenSession): boolean {
  try {
    if (!validId(session.level.id) || !integer(session.hints, 10000)
      || session.level.tiles.length < 1 || session.level.tiles.length > MAX_TILES) return false
    const snapshot = packSnapshot(session, session.level)
    if (!snapshot) return false
    const tiles = unpackSnapshot(snapshot, session.level).tiles
    const hintTile = session.level.tiles.find(tile => tile.id === session.hintId && !locked(tile))
    const won = simulate(tiles).solved
    const hintValid = !won && Boolean(hintTile) && integer(session.hintRotation, 3)
    const entry: StoredGarden = {
      ...snapshot, hints: session.hints, won, signature: signature(session.level), updatedAt: new Date().toISOString(),
      history: packStack(session.history, session.level), future: packStack(session.future, session.level),
      hintId: hintValid ? session.hintId : null, hintRotation: hintValid ? session.hintRotation : null,
    }
    const existing = readLibrary()
    delete existing[session.level.id]
    // Always retain the garden just saved, even when the device clock moved backward.
    const others = Object.entries(existing).sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt)).slice(0, MAX_GARDENS - 1)
    const gardens = { [session.level.id]: entry, ...Object.fromEntries(others) }
    localStorage.setItem(SESSION_LIBRARY_KEY, JSON.stringify({ version: 2, gardens }))
    return true
  } catch {
    return false
  }
}

export function getSessionSummaries(): Record<string, GardenSessionSummary> {
  try {
    return Object.fromEntries(Object.entries(readLibrary()).map(([id, { moves, hints, won, updatedAt }]) => [id, { moves, hints, won, updatedAt }]))
  } catch {
    return {}
  }
}
