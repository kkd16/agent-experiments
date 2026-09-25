import { simulate } from './game.ts'
import type { Level, Tile, TileKind } from './game.ts'

/** A share contains only a small solved board. IDs, hints and the scramble are derived here. */
export const CUSTOM_KINDS: TileKind[] = ['source', 'crystal', 'straight', 'elbow', 'tee', 'cross', 'bridge', 'gate', 'portal', 'rock']
export const CUSTOM_TITLE_LIMIT = 60
const MAX_CODE_LENGTH = 6000
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const movableKinds = new Set<TileKind>(['straight', 'elbow', 'tee', 'gate', 'portal'])
const mod = (n: number, by = 4) => ((n % by) + by) % by
export const isCustomMovable = (tile: Tile): boolean => !tile.fixed && movableKinds.has(tile.kind)

type Payload = { v: 1; n: string; s: number; t: number[][] }
function hash(text: string, initial = 2166136261): number {
  let value = initial
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619) >>> 0
  return value
}
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let result = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const value = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    result += ALPHABET[(value >>> 18) & 63] + ALPHABET[(value >>> 12) & 63]
    if (i + 1 < bytes.length) result += ALPHABET[(value >>> 6) & 63]
    if (i + 2 < bytes.length) result += ALPHABET[value & 63]
  }
  return result
}
function fromBase64(code: string): string | null {
  if (!code || code.length > MAX_CODE_LENGTH || !/^[A-Za-z0-9_-]+$/.test(code) || code.length % 4 === 1) return null
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const character of code) {
    buffer = (buffer << 6) | ALPHABET.indexOf(character)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >>> bits) & 255)
      buffer &= (1 << bits) - 1
    }
  }
  if (buffer !== 0) return null
  try {
    const result = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes))
    return toBase64(result) === code ? result : null
  } catch { return null }
}
function normalize(tiles: Tile[]): Tile[] {
  return [...tiles].sort((a, b) => a.y - b.y || a.x - b.x).map((tile) => ({
    id: `cell-${tile.x}-${tile.y}`, x: tile.x, y: tile.y, kind: tile.kind,
    rotation: tile.kind === 'rock' || tile.kind === 'cross' || tile.kind === 'bridge' ? 0 : tile.rotation,
    fixed: !movableKinds.has(tile.kind) || Boolean(tile.fixed),
    ...(tile.kind === 'portal' ? { pair: tile.pair } : {}),
  }))
}
function serialize(title: string, size: number, tiles: Tile[]): string {
  const payload: Payload = { v: 1, n: title, s: size, t: tiles.map((tile) => [CUSTOM_KINDS.indexOf(tile.kind), tile.rotation, tile.fixed ? 1 : 0, tile.kind === 'portal' ? tile.pair === 'a' ? 1 : 2 : 0]) }
  return JSON.stringify(payload)
}
function scramble(tiles: Tile[], seed: number): Tile[] | null {
  let state = seed
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
  // Every turnable conduit changes its orientation. A fixed bypass cannot become a puzzle.
  for (let attempt = 0; attempt < 96; attempt++) {
    const result = tiles.map((tile) => !isCustomMovable(tile) ? { ...tile } : {
      ...tile, rotation: mod(tile.rotation + (tile.kind === 'straight' ? 1 : 1 + Math.floor(next() * 3))),
    })
    if (!simulate(result).solved) return result
  }
  // Redundant routes can hide a puzzle if all channels change together. Find a useful single turn.
  for (const tile of tiles.filter(isCustomMovable)) {
    for (let turn = 1; turn < 4; turn++) {
      const result = tiles.map((other) => ({ ...other, rotation: other.id === tile.id ? mod(other.rotation + turn) : other.rotation }))
      if (!simulate(result).solved) return result
    }
  }
  return null
}

/** Validation accepts only complete 5–7 square boards and reports actionable design problems. */
export function validateCustomGarden(size: number, tiles: Tile[]): string[] {
  if (![5, 6, 7].includes(size)) return ['Choose a garden size of 5, 6, or 7.']
  if (!Array.isArray(tiles) || tiles.length !== size * size) return ['Every square needs a stone; use empty ground for unused squares.']
  const coordinates = new Set<string>()
  for (const tile of tiles) {
    if (!tile || typeof tile !== 'object' || !Number.isInteger(tile.x) || !Number.isInteger(tile.y) || tile.x < 0 || tile.y < 0 || tile.x >= size || tile.y >= size) return ['A stone lies outside this garden.']
    const coordinate = `${tile.x},${tile.y}`
    if (coordinates.has(coordinate)) return ['Two stones occupy the same square.']
    coordinates.add(coordinate)
    if (tile.id !== `cell-${tile.x}-${tile.y}`) return ['A stone has an invalid identity.']
    if (!CUSTOM_KINDS.includes(tile.kind) || !Number.isInteger(tile.rotation) || tile.rotation < 0 || tile.rotation > 3 || (tile.fixed !== undefined && typeof tile.fixed !== 'boolean')) return ['A stone has an invalid type or orientation.']
    if (tile.kind === 'portal' ? tile.pair !== 'a' && tile.pair !== 'b' : tile.pair !== undefined) return ['Portals must belong to pair A or pair B.']
  }
  const problems: string[] = []
  if (!tiles.some((tile) => tile.kind === 'source')) problems.push('Place a sun well to give your garden light.')
  if (!tiles.some((tile) => tile.kind === 'crystal')) problems.push('Place at least one crystal for the player to awaken.')
  for (const pair of ['a', 'b']) {
    const count = tiles.filter((tile) => tile.kind === 'portal' && tile.pair === pair).length
    if (count !== 0 && count !== 2) problems.push(`Portal pair ${pair.toUpperCase()} needs exactly two stones; this garden has ${count}.`)
  }
  if (!tiles.some(isCustomMovable)) problems.push('Add an unlocked channel, bend, branch, gate, or portal for the player to turn.')
  if (problems.length) return problems
  const normalized = normalize(tiles)
  const light = simulate(normalized)
  if (!light.solved) problems.push(`Connect every crystal to the light: ${light.litCrystals} of ${light.totalCrystals} are awake.`)
  else if (!scramble(normalized, hash(serialize('', size, normalized)))) problems.push('The crystals stay lit when stones turn. Add an unlocked stone that changes the light’s path.')
  return problems
}

export function encodeCustomGarden(title: string, size: number, tiles: Tile[]): { code: string; level: Level } | null {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > CUSTOM_TITLE_LIMIT || Array.from(title).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return null
  if (validateCustomGarden(size, tiles).length) return null
  const normalized = normalize(tiles)
  const serialized = serialize(title.trim(), size, normalized)
  const scrambled = scramble(normalized, hash(serialized))
  if (!scrambled) return null
  const code = toBase64(serialized)
  if (code.length > MAX_CODE_LENGTH) return null
  const chapter = normalized.some((tile) => tile.kind === 'portal') ? 5 : normalized.some((tile) => tile.kind === 'bridge') ? 4 : normalized.some((tile) => tile.kind === 'gate') ? 3 : normalized.some((tile) => tile.fixed && movableKinds.has(tile.kind)) ? 2 : normalized.some((tile) => tile.kind === 'tee' || tile.kind === 'cross') ? 1 : 0
  const solution = Object.fromEntries(normalized.map((tile) => [tile.id, tile.rotation]))
  const par = scrambled.reduce((sum, tile) => sum + (isCustomMovable(tile) ? mod(solution[tile.id] - tile.rotation, tile.kind === 'straight' ? 2 : 4) : 0), 0)
  return { code, level: {
    id: `custom-${hash(serialized).toString(16).padStart(8, '0')}${hash(serialized, 3335557771).toString(16).padStart(8, '0')}`,
    index: -1, chapter, title: title.trim(), subtitle: 'A garden made by a fellow keeper.',
    story: 'Someone arranged these stones and left a little light for you to find. Every crystal has a path home.',
    size, tiles: scrambled, solution, par,
  } }
}

export function decodeCustomLevel(code: string): Level | null {
  if (typeof code !== 'string') return null
  const serialized = fromBase64(code)
  if (!serialized) return null
  let payload: unknown
  try { payload = JSON.parse(serialized) } catch { return null }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const value = payload as Record<string, unknown>
  if (Object.keys(value).sort().join(',') !== 'n,s,t,v' || value.v !== 1 || typeof value.n !== 'string' || !Number.isInteger(value.s) || ![5, 6, 7].includes(value.s as number) || !Array.isArray(value.t) || value.t.length !== (value.s as number) ** 2) return null
  const size = value.s as number
  const tiles: Tile[] = []
  for (let index = 0; index < value.t.length; index++) {
    const tuple: unknown = value.t[index]
    if (!Array.isArray(tuple) || tuple.length !== 4 || !tuple.every(Number.isInteger)) return null
    const [kind, rotation, fixed, pair] = tuple as number[]
    if (kind < 0 || kind >= CUSTOM_KINDS.length || rotation < 0 || rotation > 3 || (fixed !== 0 && fixed !== 1) || (CUSTOM_KINDS[kind] === 'portal' ? pair !== 1 && pair !== 2 : pair !== 0)) return null
    const x = index % size
    const y = Math.floor(index / size)
    const stone: Tile = { id: `cell-${x}-${y}`, x, y, kind: CUSTOM_KINDS[kind], rotation, fixed: fixed === 1, ...(pair ? { pair: pair === 1 ? 'a' : 'b' } : {}) }
    if (!movableKinds.has(stone.kind) && !stone.fixed) return null
    tiles.push(stone)
  }
  return encodeCustomGarden(value.n, size, tiles)?.level ?? null
}
