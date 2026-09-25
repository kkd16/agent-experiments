/** A deterministic, renderer-independent light-routing puzzle engine. */
export type TileKind = 'source' | 'crystal' | 'straight' | 'elbow' | 'tee' | 'cross' | 'bridge' | 'gate' | 'portal' | 'rock'
export interface Tile {
  id: string
  x: number
  y: number
  kind: TileKind
  rotation: number
  fixed?: boolean
  pair?: string
}
export interface Level {
  id: string
  index: number
  chapter: number
  title: string
  subtitle: string
  story: string
  size: number
  tiles: Tile[]
  solution: Record<string, number>
  par: number
}
export interface Chapter {
  id: number
  title: string
  subtitle: string
  color: string
  description: string
  mechanic: string
}
export const CHAPTERS: Chapter[] = [
  { id: 0, title: 'The First Light', subtitle: 'Every garden begins with a spark.', color: '#f5c76b', description: 'Wake a forgotten garden, one small constellation at a time.', mechanic: 'Turn the stones to carry light from the sun to every crystal.' },
  { id: 1, title: 'The Glasswood', subtitle: 'A single light can become many.', color: '#80cbb2', description: 'In the glasswood, even the smallest branch remembers the sun.', mechanic: 'Three-way stones split the light. Every crystal must awaken.' },
  { id: 2, title: 'Silent Monuments', subtitle: 'Listen to what cannot be moved.', color: '#9cbbe8', description: 'The old keepers left their stones in place. Discover the paths between them.', mechanic: 'Stones with a lock cannot turn. Build your route around their position.' },
  { id: 3, title: 'The Golden Current', subtitle: 'Some rivers flow only one way.', color: '#efad78', description: 'Follow the golden current through the ruins of the water garden.', mechanic: 'Arrow stones carry light in one direction. Light must enter behind the arrow.' },
  { id: 4, title: 'The Woven Sky', subtitle: 'Two paths meet, but never mingle.', color: '#b7a1de', description: 'High above the garden, ribbons of light weave a quiet sky.', mechanic: 'Bridge stones keep the two crossing paths separate. Light goes straight through.' },
  { id: 5, title: 'The Far Gardens', subtitle: 'Distance is only another doorway.', color: '#e6a5bd', description: 'Beyond the last arch, distant gardens share the same heart.', mechanic: 'Matching portals carry light between distant stones. Connect both ends.' },
]

const STEPS = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const
const BASE_PORTS: Record<TileKind, number[]> = {
  source: [1], crystal: [3], straight: [0, 2], elbow: [0, 1], tee: [0, 1, 3],
  cross: [0, 1, 2, 3], bridge: [0, 1, 2, 3], gate: [0, 2], portal: [0], rock: [],
}
const mod = (n: number, m = 4) => ((n % m) + m) % m
const key = (x: number, y: number) => `${x},${y}`
export const ports = (tile: Tile): number[] => BASE_PORTS[tile.kind].map((port) => mod(port + tile.rotation))
export function rotateTile(tile: Tile, delta = 1): Tile {
  return tile.fixed || tile.kind === 'rock' || tile.kind === 'source' || tile.kind === 'crystal'
    ? tile : { ...tile, rotation: mod(tile.rotation + delta) }
}

export function simulate(tiles: Tile[]): {
  lit: Set<string>
  litPorts: Map<string, Set<number>>
  litCrystals: number
  totalCrystals: number
  solved: boolean
} {
  const cells = new Map(tiles.map((tile) => [key(tile.x, tile.y), tile]))
  const pairs = new Map<string, Tile[]>()
  for (const tile of tiles) {
    if (tile.kind === 'portal' && tile.pair) pairs.set(tile.pair, [...(pairs.get(tile.pair) ?? []), tile])
  }
  const lit = new Set<string>()
  const litPorts = new Map<string, Set<number>>()
  // Entry -1 starts a source; entry 4 arrives through a portal's inner doorway.
  const queue: { tile: Tile; entry: number }[] = tiles.filter((tile) => tile.kind === 'source').map((tile) => ({ tile, entry: -1 }))
  const visited = new Set<string>()
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const { tile, entry } = queue[cursor]
    const state = `${tile.id}:${entry}`
    if (visited.has(state) || tile.kind === 'rock') continue
    visited.add(state)
    const sockets = ports(tile)
    if (entry >= 0 && entry < 4 && !sockets.includes(entry)) continue
    if (tile.kind === 'gate' && entry !== mod(2 + tile.rotation)) continue
    lit.add(tile.id)
    const illuminated = litPorts.get(tile.id) ?? new Set<number>()
    litPorts.set(tile.id, illuminated)
    if (entry >= 0 && entry < 4) illuminated.add(entry)
    let exits = sockets
    if (tile.kind === 'crystal') exits = []
    if (tile.kind === 'gate') exits = [mod(tile.rotation)]
    if (tile.kind === 'bridge') exits = entry < 4 && entry >= 0 ? [mod(entry + 2)] : []
    if (tile.kind === 'portal' && entry !== 4) {
      exits = []
      const partners = tile.pair ? pairs.get(tile.pair) : undefined
      if (partners?.length === 2) {
        const partner = partners.find((candidate) => candidate.id !== tile.id)
        if (partner) queue.push({ tile: partner, entry: 4 })
      }
    }
    for (const exit of exits) {
      illuminated.add(exit)
      const [dx, dy] = STEPS[exit]
      const next = cells.get(key(tile.x + dx, tile.y + dy))
      if (next && ports(next).includes(mod(exit + 2))) queue.push({ tile: next, entry: mod(exit + 2) })
    }
  }
  const crystals = tiles.filter((tile) => tile.kind === 'crystal')
  const litCrystals = crystals.filter((tile) => lit.has(tile.id)).length
  return { lit, litPorts, litCrystals, totalCrystals: crystals.length, solved: crystals.length > 0 && litCrystals === crystals.length }
}

function equivalent(tile: Tile, rotation: number): boolean {
  if (tile.kind === 'cross' || tile.kind === 'bridge' || tile.kind === 'rock') return true
  return mod(tile.rotation - rotation, tile.kind === 'straight' ? 2 : 4) === 0
}
export function getHint(level: Level, tiles: Tile[]): { tileId: string; rotation: number } | null {
  const state = simulate(tiles)
  if (state.solved) return null
  const candidates = tiles.filter((tile) => !tile.fixed && level.solution[tile.id] !== undefined && !equivalent(tile, level.solution[tile.id]))
  // Prefer the illuminated frontier, so a hint usually makes visible progress.
  const frontier = candidates.find((tile) => state.lit.has(tile.id) || STEPS.some(([dx, dy]) => {
    const neighbor = tiles.find((other) => other.x === tile.x + dx && other.y === tile.y + dy)
    return neighbor && state.lit.has(neighbor.id)
  }))
  const tile = frontier ?? candidates[0]
  return tile ? { tileId: tile.id, rotation: level.solution[tile.id] } : null
}

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let n = Math.imul(state ^ state >>> 15, state | 1)
    n ^= n + Math.imul(n ^ n >>> 7, n | 61)
    return ((n ^ n >>> 14) >>> 0) / 4294967296
  }
}
function shuffled<T>(values: T[], rng: () => number): T[] {
  const result = [...values]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}
type Point = { x: number; y: number }
type Node = Point & { neighbors: Set<string>; parent?: string; special?: 'source' | 'bridge' | 'portal'; pair?: string }
function direction(a: Point, b: Point): number {
  return a.x === b.x ? (b.y < a.y ? 0 : 2) : (b.x > a.x ? 1 : 3)
}
function pathFrom(start: Point, length: number, size: number, occupied: Set<string>, rng: () => number, allowed: (p: Point) => boolean = () => true): Point[] {
  const path = [start]
  const used = new Set(occupied)
  used.add(key(start.x, start.y))
  let attempts = 0
  const search = (): boolean => {
    if (path.length >= length) return true
    if (++attempts > 18000) return false
    const current = path[path.length - 1]
    for (const [dx, dy] of shuffled([...STEPS], rng)) {
      const next = { x: current.x + dx, y: current.y + dy }
      const nextKey = key(next.x, next.y)
      if (next.x < 0 || next.y < 0 || next.x >= size || next.y >= size || used.has(nextKey) || !allowed(next)) continue
      path.push(next)
      used.add(nextKey)
      if (search()) return true
      path.pop()
      used.delete(nextKey)
    }
    return false
  }
  if (search()) return path
  // A shorter path is preferable to a costly unbounded generator search.
  return length > 3 ? pathFrom(start, length - 1, size, occupied, rng, allowed) : []
}
function addPath(nodes: Map<string, Node>, path: Point[]): void {
  for (let i = 0; i < path.length; i++) {
    const point = path[i]
    const id = key(point.x, point.y)
    if (!nodes.has(id)) nodes.set(id, { ...point, neighbors: new Set(), ...(i > 0 ? { parent: key(path[i - 1].x, path[i - 1].y) } : {}) })
    if (i > 0) {
      const previous = key(path[i - 1].x, path[i - 1].y)
      nodes.get(id)!.neighbors.add(previous)
      nodes.get(previous)!.neighbors.add(id)
    }
  }
}
function branch(nodes: Map<string, Node>, size: number, length: number, rng: () => number, allowed: (p: Point) => boolean = () => true): boolean {
  const occupied = new Set(nodes.keys())
  for (const node of shuffled([...nodes.values()].filter((n) => !n.special && n.neighbors.size === 2 && allowed(n)), rng)) {
    const path = pathFrom(node, length, size, occupied, rng, allowed)
    if (path.length >= 3) {
      addPath(nodes, path)
      return true
    }
  }
  return false
}
function rotationFor(kind: TileKind, sockets: number[]): number {
  for (let rotation = 0; rotation < 4; rotation++) {
    const candidate = BASE_PORTS[kind].map((port) => mod(port + rotation))
    if (candidate.length === sockets.length && candidate.every((port) => sockets.includes(port))) return rotation
  }
  throw new Error(`Cannot orient ${kind} with sockets ${sockets.join(',')}`)
}
function transform(point: Point, size: number, turns: number, mirror: boolean): Point {
  let { x, y } = point
  if (mirror) x = size - 1 - x
  for (let i = 0; i < turns; i++) [x, y] = [size - 1 - y, x]
  return { x, y }
}
function createBoard(seed: number, chapter: number, local: number): Pick<Level, 'size' | 'tiles' | 'solution' | 'par'> {
  const rng = random(seed)
  const size = chapter === 0 ? 5 : chapter === 1 && local < 4 ? 5 : chapter < 4 ? 6 : 7
  const nodes = new Map<string, Node>()
  if (chapter === 4) {
    // A continuous ribbon visits the central bridge twice on independent axes.
    const ribbon = [[0, 3], [1, 3], [2, 3], [3, 3], [4, 3], [5, 3], [5, 2], [5, 1], [4, 1], [3, 1], [3, 2], [3, 3], [3, 4], [3, 5], [2, 5], [1, 5], [1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [6, 6]].map(([x, y]) => ({ x, y }))
    addPath(nodes, ribbon)
    nodes.get('0,3')!.special = 'source'
    nodes.get('3,3')!.special = 'bridge'
    branch(nodes, size, 4 + local % 3, rng)
    if (local > 2) branch(nodes, size, 4, rng)
  } else if (chapter === 5) {
    const left = pathFrom({ x: 0, y: 1 + Math.floor(rng() * 5) }, 10 + local % 4, size, new Set(), rng, (p) => p.x <= 2)
    const right = pathFrom({ x: 4, y: 1 + Math.floor(rng() * 5) }, 10 + local % 4, size, new Set(), rng, (p) => p.x >= 4)
    addPath(nodes, left)
    addPath(nodes, right)
    nodes.get(key(left[0].x, left[0].y))!.special = 'source'
    const portalA = nodes.get(key(left.at(-1)!.x, left.at(-1)!.y))!
    const portalB = nodes.get(key(right[0].x, right[0].y))!
    portalA.special = 'portal'
    portalB.special = 'portal'
    portalA.pair = portalB.pair = 'a'
    branch(nodes, size, 4, rng, (p) => p.x >= 4)
    if (local > 1) branch(nodes, size, 4, rng, (p) => p.x <= 2)
  } else {
    const length = chapter === 0 ? 7 + local * 2 : 12 + local
    const path = pathFrom({ x: 0, y: 1 + Math.floor(rng() * (size - 2)) }, length, size, new Set(), rng)
    addPath(nodes, path)
    nodes.get(key(path[0].x, path[0].y))!.special = 'source'
    if (chapter > 0) {
      branch(nodes, size, 4 + local % 3, rng)
      if (chapter > 1 || local > 3) branch(nodes, size, 4, rng)
    }
  }

  const turns = Math.floor(rng() * 4)
  const mirror = rng() > .5
  const tiles: Tile[] = []
  const gateCandidates: { tile: Tile; input: number }[] = []
  for (const node of nodes.values()) {
    const point = transform(node, size, turns, mirror)
    const sockets = [...node.neighbors].map((neighbor) => direction(point, transform(nodes.get(neighbor)!, size, turns, mirror)))
    const kind: TileKind = node.special ?? (sockets.length === 1 ? 'crystal' : sockets.length === 3 ? 'tee' : sockets.length === 4 ? 'cross' : mod(sockets[0] - sockets[1], 2) === 0 ? 'straight' : 'elbow')
    const tile: Tile = {
      id: `cell-${point.x}-${point.y}`, ...point, kind,
      rotation: rotationFor(kind, sockets),
      fixed: kind === 'source' || kind === 'crystal' || kind === 'bridge' || kind === 'cross',
      ...(node.pair ? { pair: node.pair } : {}),
    }
    if (kind === 'straight' && node.parent) {
      gateCandidates.push({ tile, input: direction(point, transform(nodes.get(node.parent)!, size, turns, mirror)) })
    }
    tiles.push(tile)
  }
  if (chapter >= 3) {
    const count = Math.min(gateCandidates.length, chapter === 3 ? 1 + Math.floor(local / 3) : 2)
    for (const { tile, input } of shuffled(gateCandidates, rng).slice(0, count)) {
      tile.kind = 'gate'
      tile.rotation = mod(input - 2)
    }
  }
  if (chapter >= 2) {
    const candidates = shuffled(tiles.filter((tile) => !tile.fixed && tile.kind !== 'gate' && tile.kind !== 'portal'), rng)
    for (const tile of candidates.slice(0, 2 + Math.floor(local / 3))) tile.fixed = true
  }
  const routeIds = new Set(tiles.map((tile) => tile.id))
  const occupied = new Set(tiles.map((tile) => key(tile.x, tile.y)))
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (occupied.has(key(x, y))) continue
    const decoy = chapter > 0 && rng() < .18
    tiles.push({ id: `cell-${x}-${y}`, x, y, kind: decoy ? rng() > .5 ? 'elbow' : 'straight' : 'rock', rotation: Math.floor(rng() * 4), fixed: !decoy })
  }
  tiles.sort((a, b) => a.y - b.y || a.x - b.x)
  const solution = Object.fromEntries(tiles.map((tile) => [tile.id, tile.rotation]))
  if (!simulate(tiles).solved) throw new Error(`Invalid generated solution for seed ${seed}, chapter ${chapter}`)
  const movable = tiles.filter((tile) => !tile.fixed && routeIds.has(tile.id))
  for (let attempt = 0; attempt < 30; attempt++) {
    for (const tile of movable) tile.rotation = Math.floor(rng() * 4)
    if (!simulate(tiles).solved) break
  }
  // Deterministically break the first route in the extremely unlikely all-solved shuffle.
  if (simulate(tiles).solved) {
    for (const tile of movable) {
      tile.rotation = mod(solution[tile.id] + 1)
      if (!simulate(tiles).solved) break
    }
  }
  const par = tiles.reduce((moves, tile) => moves + (tile.fixed ? 0 : mod(solution[tile.id] - tile.rotation, tile.kind === 'straight' ? 2 : 4)), 0)
  return { size, tiles, solution, par }
}

const TITLES = [
  ['A Small Awakening', 'The Winding Path', 'A Quiet Corner', 'Sun Through Stone', 'Little Constellations', 'The Patient Bloom', 'A Longer Way Home', 'The Garden Remembers'],
  ['Where Light Divides', 'Three Wishes', 'The Glass Orchard', 'Branches of Gold', 'A Shared Sunrise', 'The Crystal Grove', 'Many Small Miracles', 'All Things Connected'],
  ['The First Monument', 'Written in Stone', 'The Keepers’ Path', 'A Stillness Between', 'The Old Arrangement', 'A Promise Unmoved', 'Reading the Ruins', 'The Silent Choir'],
  ['Follow the Current', 'The River Knows', 'Against the Silence', 'Golden Tributaries', 'A Turn of Fortune', 'The Water Clock', 'Every River Returns', 'The Sunward Tide'],
  ['Threads of Heaven', 'The Crossing', 'Ribbons in the Air', 'Above and Below', 'The Weaver’s Walk', 'Parallel Wishes', 'A Tapestry of Stars', 'The Sky Unfolds'],
  ['The First Doorway', 'Somewhere, a Garden', 'Across the Quiet', 'A Distant Answer', 'Two Halves of Dawn', 'The Other Side', 'A World Reawakened', 'Where the Light Lives'],
]
const STORIES = [
  ['You find a sleeping crystal at the edge of the garden. Somewhere beneath the moss, an old path is waiting for the sun.', 'The keepers believed that a single lit window could guide someone home. Tonight, you are the keeper.'],
  ['Leaves of glass chime in the morning air. Their roots share the same light; no branch needs to be left in shadow.', 'You begin to understand the garden: the more light it gives away, the more beautiful it becomes.'],
  ['Some stones have stood here for a thousand years. They cannot turn, but their silence is a map.', 'A keeper’s note is carved beneath the ivy: “Start with what remains. The rest will find its place.”'],
  ['Once, golden rivers flowed through these channels. Find their direction, and the water garden will sing again.', 'The current has a memory. Give it a clear way forward, and it will carry the morning with it.'],
  ['The old weavers learned to let two journeys cross without changing either one. Their sky bridges still hold.', 'Above the garden, the pathways trace a constellation no one has seen for centuries. You are nearly there.'],
  ['A doorway hums softly. On its other side, another garden has been waiting for the very same sunrise.', 'The world was never a collection of separate gardens. It was one garden, waiting for someone to connect its light.'],
]

export const LEVELS: Level[] = Array.from({ length: 48 }, (_, index) => {
  const chapter = Math.floor(index / 8)
  const local = index % 8
  return {
    id: `level-${String(index + 1).padStart(2, '0')}`, index, chapter,
    title: TITLES[chapter][local], subtitle: CHAPTERS[chapter].subtitle,
    story: STORIES[chapter][local > 3 ? 1 : 0],
    ...createBoard(0x1a2b3000 + index * 7919, chapter, local),
  }
})
export function generateLevel(seed: number, chapter = 5): Level {
  const normalizedSeed = seed >>> 0
  const normalizedChapter = Math.max(0, Math.min(5, Number.isFinite(chapter) ? Math.floor(chapter) : 5))
  const local = normalizedSeed % 8
  return {
    id: `generated-${normalizedSeed}-${normalizedChapter}`, index: -1, chapter: normalizedChapter,
    title: `Garden ${normalizedSeed.toString(36).toUpperCase()}`,
    subtitle: 'A new path, just for this moment.',
    story: 'Every seed holds a garden no one has walked before. Take your time. Find its light.',
    ...createBoard(normalizedSeed, normalizedChapter, local),
  }
}
export function dailyLevel(date = new Date().toISOString().slice(0, 10)): Level {
  let seed = 2166136261
  for (const character of date) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0
  const level = generateLevel(seed, 3 + seed % 3)
  return { ...level, id: `daily-${date}`, title: 'Today’s Garden', subtitle: 'One shared garden. A new beginning each day.', story: `A garden for ${date}. The same stones wait for every traveler today. Find your own way through them.` }
}
