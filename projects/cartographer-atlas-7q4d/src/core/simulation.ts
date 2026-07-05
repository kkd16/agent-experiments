// The Ages — a deterministic, turn-based history simulation.
//
// A terrain map with cities is a *place*; this makes it a *story*. Realms are seeded on
// the richest ground and then, turn by turn across roughly a millennium, they:
//   • grow logistically toward the land's carrying capacity (its food ceiling),
//   • push their frontier into the best unclaimed neighbours they can afford to hold,
//   • throw off colonies onto rich, empty, distant land (new realms are born),
//   • wage war — the stronger annexing a band of the weaker's border, a broken realm
//     collapsing back into open frontier,
//   • shed a breakaway state when they overreach (secession),
//   • and suffer plague, famine, eruption and flood tied to their own geography.
//
// Every turn is snapshotted, so the UI can scrub the whole history and watch the political
// map breathe. The chronicle is no longer scripted — it is whatever actually happened here.
// Same seed ⇒ same saga: a single `${seed}:ages` RNG drives every decision, and every
// iteration order is deterministic.

import type {
  ChronicleEvent,
  ChronicleKind,
  HistoryFrame,
  Mesh,
  NamedRiver,
  RealmSnapshot,
  SimCity,
  SimRealm,
  WorldHistory,
  WorldParams,
} from './types'
import { B } from './biomes'
import { Rng } from './rng'

/** The world fields the simulation reads (all per-region, indexed by region id). */
export interface SimContext {
  elevation: Float64Array
  ocean: Uint8Array
  lake: Uint8Array
  coast: Uint8Array
  flux: Float64Array
  moisture: Float64Array
  temperature: Float64Array
  biome: Uint8Array
  continentality: Float64Array
  plateBoundary: Uint8Array
  namedRivers: NamedRiver[]
}

// --- Tunables -------------------------------------------------------------
const TURNS = 40 // snapshots in the timeline (plus the founding frame)
const STEP = 30 // years per turn
const START_YEAR = 18 // the first settlements
const PEOPLE_PER_CAP = 9000 // souls one unit of carrying capacity supports
const GROWTH = 0.34 // logistic growth rate per turn
const SEED_POP = 9000 // starting population of a fresh realm
const MIN_SURVIVE_AREA = 4 // below this a realm collapses
const MIN_SURVIVE_POP = 2500
// A realm id is never reused, so total realms grows with foundings — size the per-realm
// scratch arrays past the worst case (initial + one colony + one secession per turn).
const REALM_SLOTS = 12 + TURNS * 2

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

// --- Name grammar (self-contained, like the other engine modules) ---------
const ONSET = ['B', 'Br', 'C', 'D', 'Dr', 'F', 'G', 'Gl', 'H', 'K', 'Kh', 'L', 'M', 'N', 'P', 'R', 'S', 'St', 'T', 'Th', 'V', 'W', 'Z']
const VOW = ['a', 'e', 'i', 'o', 'u', 'ae', 'io', 'ea', 'ou', 'ai']
const CODA = ['n', 'r', 'l', 's', 'th', 'ld', 'rk', 'st', 'm', 'nd', 'x', 'rn']
const REALM_FORM = ['%s', 'The %s Hegemony', 'Kingdom of %s', '%s', '%s Empire', 'The %s Dominion', 'Duchy of %s', '%s', 'The %s League']
const CITY_SUFFIX = ['ford', 'burg', 'ton', 'holm', 'gate', 'mere', 'wick', 'bury', 'stead', 'fell', 'grad', 'car']
const ERA_FORMS = ['the %s Age', 'the Age of %s', 'the %s Epoch', 'the %s Era', 'the Reign of %s']
const ORDINAL = ['First', 'Second', 'Third', 'Elder', 'Golden', 'Sundered', 'Long', 'Middle']

function stem(rng: Rng): string {
  let s = rng.pick(ONSET) + rng.pick(VOW)
  if (rng.next() < 0.55) s += rng.pick(CODA)
  return s
}
function cap1(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
function realmName(rng: Rng): string {
  const base = cap1(stem(rng) + (rng.next() < 0.5 ? rng.pick(VOW) + rng.pick(CODA) : rng.pick(CODA)))
  return rng.pick(REALM_FORM).replace('%s', base)
}
function cityName(rng: Rng, coastal: boolean): string {
  const base = cap1(stem(rng))
  if (rng.next() < 0.72) {
    const suf = coastal && rng.next() < 0.5 ? rng.pick(['port', 'haven', 'mouth', 'bay']) : rng.pick(CITY_SUFFIX)
    return base + suf
  }
  return base + rng.pick(VOW) + rng.pick(CODA)
}
/** Strip grammatical dressing to a bare stem, for compact war / event titles. */
function short(realm: string): string {
  return realm
    .replace(/^The\s+/i, '')
    .replace(/\s+(Hegemony|Dominion|Duchy|Kingdom|Empire|League)$/i, '')
    .replace(/^(Kingdom|Duchy) of\s+/i, '')
    .split(' ')[0]
}

// --- Static terrain scoring ----------------------------------------------

/** Biome "richness" — the baseline food a cell's ecosystem can yield. */
function biomeFood(b: number): number {
  switch (b) {
    case B.grassland:
    case B.deciduous:
      return 1.0
    case B.tropical_sf:
    case B.savanna:
      return 0.82
    case B.temperate_rf:
    case B.tropical_rf:
      return 0.7
    case B.taiga:
      return 0.42
    case B.wetland:
      return 0.5
    case B.tundra:
      return 0.22
    case B.desert:
      return 0.08
    case B.bare:
      return 0.05
    case B.snow:
      return 0.0
    default:
      return 0.35
  }
}

/**
 * Per-cell carrying capacity: the food ceiling a realm grows toward. Combines the
 * biome's richness with a moderate-moisture preference, a warm-temperate optimum, a
 * lowland bonus, and lifts from rivers and the sea. Water and dead ground carry none.
 */
function computeCapacity(mesh: Mesh, params: WorldParams, ctx: SimContext): Float64Array {
  const n = mesh.numSolid
  const cap = new Float64Array(mesh.numRegions)
  const denom = 1 - params.seaLevel || 1
  let maxFlux = 0
  for (let r = 0; r < n; r++) if (ctx.flux[r] > maxFlux) maxFlux = ctx.flux[r]
  for (let r = 0; r < n; r++) {
    if (ctx.ocean[r] || ctx.lake[r]) continue
    const above = Math.max(0, ctx.elevation[r] - params.seaLevel) / denom
    const temp = ctx.temperature[r]
    const moist = ctx.moisture[r]
    let food = biomeFood(ctx.biome[r])
    // Best farmland sits at moderate moisture; bone-dry and waterlogged both hurt.
    food *= 0.45 + 0.55 * clamp01(1 - Math.abs(moist - 0.55) * 1.6)
    // A warm-temperate optimum; frozen and scorching ground both fall away.
    food *= clamp01(1 - Math.abs(temp - 0.62) * 1.8) * 0.7 + 0.3
    // Lowlands feed more than crags.
    food *= 1 - clamp01(above / 0.7) * 0.7
    // Rivers and coasts are the cradles of population.
    const river = maxFlux > 0 ? Math.sqrt(ctx.flux[r] / maxFlux) : 0
    food += river * 0.5
    if (ctx.coast[r]) food += 0.22
    cap[r] = Math.max(0, food)
  }
  return cap
}

/** Terrain defensibility 0..~1: highlands and river lines are dear to assault. */
function computeDefense(mesh: Mesh, params: WorldParams, ctx: SimContext): Float64Array {
  const n = mesh.numSolid
  const def = new Float64Array(mesh.numRegions)
  const denom = 1 - params.seaLevel || 1
  let maxFlux = 0
  for (let r = 0; r < n; r++) if (ctx.flux[r] > maxFlux) maxFlux = ctx.flux[r]
  for (let r = 0; r < n; r++) {
    if (ctx.ocean[r] || ctx.lake[r]) continue
    const above = Math.max(0, ctx.elevation[r] - params.seaLevel) / denom
    const river = maxFlux > 0 ? Math.sqrt(ctx.flux[r] / maxFlux) : 0
    def[r] = clamp01(above * 0.9 + river * 0.4)
  }
  return def
}

// --- Simulation state -----------------------------------------------------

interface Realm extends SimRealm {
  alive: boolean
  pop: number
  capital: number
  lastWar: number // turn index, to space conflicts out
}

interface CityRec {
  r: number
  name: string
  realm: number // -1 once its realm has fallen and it becomes a free town / ruin
  foundedYear: number
  coastal: boolean
}

type LogFn = (year: number, kind: ChronicleKind, title: string, text: string, x?: number, y?: number) => void

export function simulateHistory(mesh: Mesh, params: WorldParams, ctx: SimContext): WorldHistory {
  const rng = new Rng(`${params.seed}:ages`)
  const eraStem = rng.next() < 0.5 ? rng.pick(ORDINAL) : cap1(stem(rng))
  const era = rng.pick(ERA_FORMS).replace('%s', eraStem)
  const endYear = START_YEAR + TURNS * STEP

  const n = mesh.numSolid
  const cap = computeCapacity(mesh, params, ctx)
  const defense = computeDefense(mesh, params, ctx)
  const isLand = (r: number): boolean => r < n && !ctx.ocean[r] && !ctx.lake[r]

  let numLand = 0
  for (let r = 0; r < n; r++) if (isLand(r)) numLand++

  const owner = new Int32Array(mesh.numRegions).fill(-1)
  const realms: Realm[] = []
  const cities: CityRec[] = []
  const events: ChronicleEvent[] = []
  const frames: HistoryFrame[] = []
  // Per-realm scratch, indexed by realm id (never reused), recomputed each turn.
  const area = new Int32Array(REALM_SLOTS)
  const capSum = new Float64Array(REALM_SLOTS)

  // Empty / uninhabitable worlds: hand back an empty-but-valid history.
  if (numLand < MIN_SURVIVE_AREA * 3) {
    for (let t = 0; t <= TURNS; t++) {
      frames.push({ year: START_YEAR + t * STEP, owner: owner.slice(), realms: [], cities: [], events: [] })
    }
    return { era, startYear: START_YEAR, endYear, realms: [], frames, events }
  }

  const HUES = [12, 205, 145, 45, 280, 175, 95, 330, 240, 65, 300, 20, 190, 120, 350, 260, 80, 160, 30, 220, 140, 310]
  const maxRealms = clamp(Math.round((params.cities || 8) * 1.4), 4, HUES.length)

  const dist2 = (a: number, b: number): number => {
    const dx = mesh.px[a] - mesh.px[b]
    const dy = mesh.py[a] - mesh.py[b]
    return dx * dx + dy * dy
  }

  const foundRealm = (r: number, year: number): number => {
    const id = realms.length
    const coastal = ctx.coast[r] === 1
    realms.push({
      id,
      name: realmName(rng),
      hue: HUES[id % HUES.length],
      origin: r,
      foundedYear: year,
      deathYear: -1,
      peakPop: SEED_POP,
      peakArea: 1,
      alive: true,
      pop: SEED_POP,
      capital: r,
      lastWar: -99,
    })
    owner[r] = id
    cities.push({ r, name: cityName(rng, coastal), realm: id, foundedYear: year, coastal })
    return id
  }

  const eventsThisTurn: number[] = []
  const logEvent: LogFn = (year, kind, title, text, x, y) => {
    eventsThisTurn.push(events.length)
    events.push({ year, kind, title, text, x, y })
  }

  const recomputeAggregates = (): void => {
    area.fill(0)
    capSum.fill(0)
    for (let r = 0; r < n; r++) {
      const o = owner[r]
      if (o < 0) continue
      area[o]++
      capSum[o] += cap[r]
    }
  }

  const realmCapital = (id: number): number => {
    if (owner[realms[id].origin] === id) return realms[id].origin
    let best = -1
    let bestCap = -1
    for (const c of cities) {
      if (c.realm === id && owner[c.r] === id && cap[c.r] > bestCap) {
        bestCap = cap[c.r]
        best = c.r
      }
    }
    if (best >= 0) return best
    for (let r = 0; r < n; r++) if (owner[r] === id && cap[r] > bestCap) { bestCap = cap[r]; best = r }
    return best
  }

  const killRealm = (id: number, year: number, freeLand: boolean): void => {
    const rl = realms[id]
    if (!rl.alive) return
    rl.alive = false
    rl.deathYear = year
    if (freeLand) for (let r = 0; r < n; r++) if (owner[r] === id) owner[r] = -1
    for (const c of cities) if (c.realm === id) c.realm = -1
  }

  const snapshot = (year: number, turnEvents: number[]): void => {
    const snaps: RealmSnapshot[] = []
    for (const rl of realms) {
      if (!rl.alive || area[rl.id] === 0) continue
      snaps.push({ id: rl.id, area: area[rl.id], population: Math.round(rl.pop), capital: rl.capital })
    }
    snaps.sort((a, b) => b.area - a.area)
    const rank = new Map<number, number>()
    snaps.forEach((s, i) => rank.set(s.id, i))
    const simCities: SimCity[] = []
    for (const c of cities) {
      if (!isLand(c.r)) continue
      const o = owner[c.r]
      const rl = o >= 0 ? realms[o] : null
      const isCap = rl != null && rl.capital === c.r
      let tier = 0
      if (o >= 0) {
        const pos = rank.get(o) ?? 99
        tier = isCap ? 3 : pos < 3 ? 2 : pos < 7 ? 1 : 0
      }
      simCities.push({ r: c.r, name: c.name, realm: o, capital: isCap, tier })
    }
    frames.push({ year, owner: owner.slice(), realms: snaps, cities: simCities, events: turnEvents })
  }

  // --- Seed the founding realms on the richest, well-spaced ground ---
  const seeds: number[] = []
  for (let r = 0; r < n; r++) if (isLand(r) && cap[r] > 0.28) seeds.push(r)
  seeds.sort((a, b) => cap[b] - cap[a])
  const initialRealms = clamp(Math.round((params.cities || 8) * 0.5), 2, Math.min(8, Math.floor(numLand / 40) + 2))
  const minSeedDist = Math.sqrt((params.width * params.height) / Math.max(1, initialRealms)) * 0.55
  const minSeed2 = minSeedDist * minSeedDist
  const founded: number[] = []
  for (const r of seeds) {
    if (founded.length >= initialRealms) break
    let ok = true
    for (const q of founded) if (dist2(q, r) < minSeed2) { ok = false; break }
    if (ok) {
      founded.push(r)
      foundRealm(r, START_YEAR)
    }
  }
  if (realms.length === 0 && seeds.length) foundRealm(seeds[0], START_YEAR)

  for (const rl of realms) {
    events.push({
      year: rl.foundedYear,
      kind: 'realm',
      title: `${rl.name} founded`,
      text: `A people take root on fertile ground and raise the first walls of ${cities[rl.id].name}, seat of ${rl.name}.`,
      x: mesh.px[rl.origin],
      y: mesh.py[rl.origin],
    })
  }

  // Turn 0 — the founding snapshot.
  recomputeAggregates()
  snapshot(START_YEAR, realms.map((_, i) => i))

  // --- The turn loop --------------------------------------------------------
  for (let t = 1; t <= TURNS; t++) {
    const year = START_YEAR + t * STEP
    eventsThisTurn.length = 0
    const eraT = t / TURNS // 0..1 — later ages march, conquer and multiply faster

    recomputeAggregates()

    // 1) Logistic population growth toward carrying capacity.
    for (const rl of realms) {
      if (!rl.alive) continue
      const ceil = capSum[rl.id] * PEOPLE_PER_CAP + SEED_POP
      const g = GROWTH * (0.7 + 0.6 * rng.next())
      rl.pop += rl.pop * g * (1 - rl.pop / ceil)
      rl.pop = Math.max(SEED_POP * 0.5, rl.pop)
      rl.peakPop = Math.max(rl.peakPop, rl.pop)
      rl.peakArea = Math.max(rl.peakArea, area[rl.id])
    }

    // 2) Disasters — each tied to real geography, each a chance per turn.
    maybePlague(rng, year, realms, mesh, logEvent)
    maybeFamine(rng, year, realms, ctx, mesh, owner, n, logEvent)
    maybeEruption(rng, year, ctx, mesh, owner, realms, n, logEvent)
    maybeFlood(rng, year, ctx, mesh, owner, realms, logEvent)

    // 3) Frontier expansion.
    expandRealms(eraT, realms, owner, area, capSum, cap, defense, mesh, ctx, n)

    // 4) Colonisation — a new realm born on rich, empty, distant frontier.
    if (realms.filter((r) => r.alive).length < maxRealms && rng.next() < 0.55) {
      const site = colonySite(rng, cap, owner, realms, mesh, n, isLand)
      if (site >= 0) {
        const id = foundRealm(site, year)
        recomputeAggregates()
        logEvent(year, 'realm', `${realms[id].name} rises`, `Colonists strike out for the open frontier and found ${cities[id].name}, first seat of ${realms[id].name}.`, mesh.px[site], mesh.py[site])
      }
    }

    // 5) Wars — the strong annex the weak; the broken collapse.
    recomputeAggregates()
    resolveWars(rng, year, t, eraT, realms, owner, area, defense, mesh, n, cities, logEvent, killRealm)

    // 6) Secession — an overstretched realm sheds a breakaway state.
    recomputeAggregates()
    if (rng.next() < 0.28) {
      maybeSecession(rng, year, realms, owner, area, mesh, n, maxRealms, foundRealm, cities, logEvent)
    }

    // 7) New cities as realms swell; retire realms that lost all land.
    recomputeAggregates()
    foundCities(rng, year, realms, owner, area, cap, mesh, cities, ctx, n, logEvent)
    for (const rl of realms) {
      if (!rl.alive) continue
      if (area[rl.id] === 0 || rl.pop < MIN_SURVIVE_POP) {
        const cap0 = rl.capital
        killRealm(rl.id, year, true)
        logEvent(year, 'collapse', `The fall of ${short(rl.name)}`, `${rl.name} dwindles and is undone; its lands pass to its neighbours and the wild.`, mesh.px[cap0], mesh.py[cap0])
      } else {
        rl.capital = realmCapital(rl.id)
      }
    }

    recomputeAggregates()
    snapshot(year, eventsThisTurn.slice())
  }

  // Golden age — crown the realm at its zenith with a flourish in the annals.
  const zenith = [...realms].filter((r) => r.peakArea >= 12).sort((a, b) => b.peakPop - a.peakPop)[0]
  if (zenith) {
    const gy = clamp(Math.round(zenith.foundedYear + (endYear - zenith.foundedYear) * 0.55), START_YEAR, endYear)
    events.push({
      year: gy,
      kind: 'golden',
      title: `The Golden Age of ${short(zenith.name)}`,
      text: `At its height ${zenith.name} numbers some ${Math.round(zenith.peakPop).toLocaleString()} souls across ${zenith.peakArea} provinces — the paramount power of ${era}.`,
      x: mesh.px[zenith.origin],
      y: mesh.py[zenith.origin],
    })
  }

  events.sort((a, b) => a.year - b.year)

  const outRealms: SimRealm[] = realms.map((r) => ({
    id: r.id,
    name: r.name,
    hue: r.hue,
    origin: r.origin,
    foundedYear: r.foundedYear,
    deathYear: r.deathYear,
    peakPop: Math.round(r.peakPop),
    peakArea: r.peakArea,
  }))

  return { era, startYear: START_YEAR, endYear, realms: outRealms, frames, events }
}

// --- Expansion ------------------------------------------------------------

function expandRealms(
  eraT: number,
  realms: Realm[],
  owner: Int32Array,
  area: Int32Array,
  capSum: Float64Array,
  cap: Float64Array,
  defense: Float64Array,
  mesh: Mesh,
  ctx: SimContext,
  n: number,
): void {
  // Strongest realms move first (deterministic).
  const order = realms.filter((r) => r.alive).sort((a, b) => b.pop - a.pop)
  for (const rl of order) {
    const id = rl.id
    const ceil = capSum[id] * PEOPLE_PER_CAP + SEED_POP
    const pressure = rl.pop / ceil
    if (pressure < 0.5) continue
    const budget = clamp(Math.round((pressure - 0.4) * 6 + eraT * 3 + area[id] * 0.02), 0, 14)
    if (budget <= 0) continue

    const frontier: Array<{ r: number; s: number }> = []
    const seen = new Set<number>()
    for (let r = 0; r < n; r++) {
      if (owner[r] !== id) continue
      for (const j of mesh.neighbors[r]) {
        if (j >= n || owner[j] >= 0 || ctx.ocean[j] || ctx.lake[j] || seen.has(j)) continue
        seen.add(j)
        frontier.push({ r: j, s: cap[j] * 1.3 + defense[j] * 0.25 + 0.05 })
      }
    }
    if (frontier.length === 0) continue
    frontier.sort((a, b) => b.s - a.s)
    const take = Math.min(budget, frontier.length)
    for (let k = 0; k < take; k++) owner[frontier[k].r] = id
    area[id] += take
  }
}

/** A site for a fresh colony: rich, unclaimed, and far from every living capital. */
function colonySite(
  rng: Rng,
  cap: Float64Array,
  owner: Int32Array,
  realms: Realm[],
  mesh: Mesh,
  n: number,
  isLand: (r: number) => boolean,
): number {
  const caps = realms.filter((r) => r.alive).map((r) => r.capital)
  let best = -1
  let bestScore = 0.4
  const stride = Math.max(1, Math.floor(n / 1500))
  for (let r = rng.int(0, stride - 1); r < n; r += stride) {
    if (!isLand(r) || owner[r] >= 0 || cap[r] < 0.35) continue
    let nearest = Infinity
    for (const c of caps) {
      const dx = mesh.px[c] - mesh.px[r]
      const dy = mesh.py[c] - mesh.py[r]
      const d = dx * dx + dy * dy
      if (d < nearest) nearest = d
    }
    const far = Math.min(1, Math.sqrt(nearest) / 260)
    const score = cap[r] * (0.4 + far)
    if (score > bestScore) {
      bestScore = score
      best = r
    }
  }
  return best
}

// --- War ------------------------------------------------------------------

interface Pair {
  a: number
  b: number
}

/** Realm adjacency this turn, as ordered pairs (a<b) in a deterministic order. */
function realmPairs(owner: Int32Array, mesh: Mesh, n: number): Pair[] {
  const seen = new Set<number>()
  const out: Pair[] = []
  for (let r = 0; r < n; r++) {
    const a = owner[r]
    if (a < 0) continue
    for (const j of mesh.neighbors[r]) {
      if (j >= n) continue
      const b = owner[j]
      if (b < 0 || b === a) continue
      const lo = Math.min(a, b)
      const hi = Math.max(a, b)
      const key = lo * 100000 + hi
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ a: lo, b: hi })
    }
  }
  out.sort((p, q) => p.a - q.a || p.b - q.b)
  return out
}

function resolveWars(
  rng: Rng,
  year: number,
  turn: number,
  eraT: number,
  realms: Realm[],
  owner: Int32Array,
  area: Int32Array,
  defense: Float64Array,
  mesh: Mesh,
  n: number,
  cities: CityRec[],
  logEvent: LogFn,
  killRealm: (id: number, year: number, free: boolean) => void,
): void {
  const pairs = realmPairs(owner, mesh, n)
  if (pairs.length === 0) return
  const maxWars = clamp(1 + Math.floor(eraT * 3) + Math.floor(pairs.length / 8), 1, 4)
  let wars = 0
  for (const p of pairs) {
    if (wars >= maxWars) break
    const A = realms[p.a]
    const D0 = realms[p.b]
    if (!A.alive || !D0.alive) continue
    if (turn - A.lastWar < 2 && turn - D0.lastWar < 2) continue
    const chance = 0.16 + eraT * 0.28
    if (rng.next() > chance) continue

    const attacker = A.pop >= D0.pop ? A : D0
    const defender = attacker === A ? D0 : A

    const front: number[] = []
    for (let r = 0; r < n; r++) {
      if (owner[r] !== defender.id) continue
      for (const j of mesh.neighbors[r]) {
        if (j < n && owner[j] === attacker.id) { front.push(r); break }
      }
    }
    if (front.length === 0) continue

    let borderDef = 0
    for (const r of front) borderDef += defense[r]
    borderDef /= front.length
    const sAtt = attacker.pop * (0.6 + 0.8 * rng.next())
    const sDef = defender.pop * (0.6 + 0.8 * rng.next()) * (1 + borderDef * 0.7)
    wars++
    attacker.lastWar = turn
    defender.lastWar = turn

    const px = (mesh.px[attacker.capital] + mesh.px[defender.capital]) / 2
    const py = (mesh.py[attacker.capital] + mesh.py[defender.capital]) / 2

    if (sAtt <= sDef) {
      attacker.pop *= 0.9
      logEvent(year, 'war', `The ${short(defender.name)}–${short(attacker.name)} War`, `${defender.name} throws back the armies of ${attacker.name} at its frontier, and the border holds.`, px, py)
      continue
    }

    const ratio = sAtt / (sDef + 1)
    const spoils = clamp(Math.round(area[defender.id] * (0.14 + 0.16 * rng.next()) * clamp(ratio, 1, 2.2)), 1, 60)
    const taken = bfsAnnex(front, defender.id, attacker.id, owner, mesh, n, spoils)
    const lostFrac = area[defender.id] > 0 ? taken / area[defender.id] : 1
    area[defender.id] -= taken
    area[attacker.id] += taken
    const moved = defender.pop * lostFrac * 0.6
    defender.pop = defender.pop * (1 - lostFrac) * 0.92
    attacker.pop = attacker.pop * 0.97 + moved

    if (area[defender.id] < MIN_SURVIVE_AREA || defender.pop < MIN_SURVIVE_POP) {
      for (let r = 0; r < n; r++) if (owner[r] === defender.id) { owner[r] = attacker.id; area[attacker.id]++ }
      for (const c of cities) if (c.realm === defender.id) c.realm = attacker.id
      attacker.pop += defender.pop * 0.5
      killRealm(defender.id, year, false)
      logEvent(year, 'war', `${short(attacker.name)} conquers ${short(defender.name)}`, `After the war, ${attacker.name} overruns the last holdings of ${defender.name} and swallows the realm whole.`, px, py)
    } else {
      logEvent(year, 'war', `The ${short(attacker.name)}–${short(defender.name)} War`, `${attacker.name} defeats ${defender.name} and annexes the marches along their border.`, px, py)
    }
  }
}

/** Flood-fill up to `limit` cells of `fromId` (starting at `seedCells`) over to `toId`. */
function bfsAnnex(
  seedCells: number[],
  fromId: number,
  toId: number,
  owner: Int32Array,
  mesh: Mesh,
  n: number,
  limit: number,
): number {
  const queue = seedCells.filter((r) => owner[r] === fromId)
  const inQ = new Set<number>(queue)
  let head = 0
  let taken = 0
  while (head < queue.length && taken < limit) {
    const r = queue[head++]
    if (owner[r] !== fromId) continue
    owner[r] = toId
    taken++
    for (const j of mesh.neighbors[r]) {
      if (j < n && owner[j] === fromId && !inQ.has(j)) {
        inQ.add(j)
        queue.push(j)
      }
    }
  }
  return taken
}

// --- Secession ------------------------------------------------------------

function maybeSecession(
  rng: Rng,
  year: number,
  realms: Realm[],
  owner: Int32Array,
  area: Int32Array,
  mesh: Mesh,
  n: number,
  maxRealms: number,
  foundRealm: (r: number, year: number) => number,
  cities: CityRec[],
  logEvent: LogFn,
): void {
  if (realms.filter((r) => r.alive).length >= maxRealms) return
  const candidates = realms.filter((r) => r.alive && area[r.id] >= 26)
  if (candidates.length === 0) return
  candidates.sort((a, b) => area[b.id] - area[a.id])
  const rl = candidates[0]
  // Start the breakaway far from the capital.
  let start = -1
  let far = -1
  for (let r = 0; r < n; r++) {
    if (owner[r] !== rl.id) continue
    const dx = mesh.px[rl.capital] - mesh.px[r]
    const dy = mesh.py[rl.capital] - mesh.py[r]
    const d = dx * dx + dy * dy
    if (d > far) { far = d; start = r }
  }
  if (start < 0) return
  const want = clamp(Math.round(area[rl.id] * (0.3 + 0.15 * rng.next())), 6, 80)
  const parentArea = area[rl.id]

  const newId = foundRealm(start, year) // claims `start` for the breakaway
  const seeds = [start, ...mesh.neighbors[start].filter((j) => j < n && owner[j] === rl.id)]
  const taken = bfsAnnex(seeds, rl.id, newId, owner, mesh, n, want - 1) + 1
  area[rl.id] = Math.max(0, parentArea - taken)
  area[newId] = taken
  const child = realms[newId]
  child.pop = rl.pop * (taken / parentArea) * 0.85
  rl.pop *= 1 - (taken / parentArea) * 0.85
  for (const c of cities) if (owner[c.r] === newId) c.realm = newId
  logEvent(year, 'secession', `${short(child.name)} breaks away`, `The far provinces of ${rl.name} rise in revolt and proclaim ${child.name}, free of the old crown.`, mesh.px[start], mesh.py[start])
}

// --- Cities ---------------------------------------------------------------

function foundCities(
  rng: Rng,
  year: number,
  realms: Realm[],
  owner: Int32Array,
  area: Int32Array,
  cap: Float64Array,
  mesh: Mesh,
  cities: CityRec[],
  ctx: SimContext,
  n: number,
  logEvent: LogFn,
): void {
  const minCityDist2 = 82 * 82
  for (const rl of realms) {
    if (!rl.alive) continue
    const owned = area[rl.id]
    let cityCount = 0
    for (const c of cities) if (c.realm === rl.id) cityCount++
    if (cityCount >= Math.floor(owned / 30) + 1) continue
    if (rng.next() > 0.5) continue
    let best = -1
    let bestCap = 0.25
    for (let r = 0; r < n; r++) {
      if (owner[r] !== rl.id || cap[r] <= bestCap) continue
      let tooClose = false
      for (const c of cities) {
        const dx = mesh.px[c.r] - mesh.px[r]
        const dy = mesh.py[c.r] - mesh.py[r]
        if (dx * dx + dy * dy < minCityDist2) { tooClose = true; break }
      }
      if (tooClose) continue
      bestCap = cap[r]
      best = r
    }
    if (best < 0) continue
    const coastal = ctx.coast[best] === 1
    const name = cityName(rng, coastal)
    cities.push({ r: best, name, realm: rl.id, foundedYear: year, coastal })
    logEvent(year, 'founding', `${name} founded`, `${rl.name} raises the town of ${name} on the growing frontier.`, mesh.px[best], mesh.py[best])
  }
}

// --- Disasters ------------------------------------------------------------

function maybePlague(rng: Rng, year: number, realms: Realm[], mesh: Mesh, logEvent: LogFn): void {
  if (rng.next() > 0.16) return
  const alive = realms.filter((r) => r.alive)
  if (alive.length === 0) return
  const target = alive.sort((a, b) => b.pop - a.pop)[0]
  target.pop *= 0.62 + 0.1 * rng.next()
  logEvent(year, 'plague', `The Pallid Plague`, `A sickness carried on the trade roads takes hold in ${target.name}, and a third of its people are lost.`, mesh.px[target.capital], mesh.py[target.capital])
}

function maybeFamine(
  rng: Rng,
  year: number,
  realms: Realm[],
  ctx: SimContext,
  mesh: Mesh,
  owner: Int32Array,
  n: number,
  logEvent: LogFn,
): void {
  if (rng.next() > 0.14) return
  let worst = -1
  let worstFrac = 0.28
  for (const rl of realms) {
    if (!rl.alive) continue
    let dry = 0
    let total = 0
    for (let r = 0; r < n; r++) {
      if (owner[r] !== rl.id) continue
      total++
      if (ctx.biome[r] === B.desert || ctx.biome[r] === B.savanna) dry++
    }
    if (total < 8) continue
    const frac = dry / total
    if (frac > worstFrac) { worstFrac = frac; worst = rl.id }
  }
  if (worst < 0) return
  const rl = realms[worst]
  rl.pop *= 0.72
  logEvent(year, 'famine', `The Long Famine`, `Drought withers the fields of ${rl.name}; its people abandon the parched interior for the coasts.`, mesh.px[rl.capital], mesh.py[rl.capital])
}

function maybeEruption(
  rng: Rng,
  year: number,
  ctx: SimContext,
  mesh: Mesh,
  owner: Int32Array,
  realms: Realm[],
  n: number,
  logEvent: LogFn,
): void {
  if (rng.next() > 0.1 || ctx.plateBoundary.length === 0) return
  let peak = -1
  let bestE = -Infinity
  for (let r = 0; r < n; r++) {
    if (ctx.ocean[r] || ctx.lake[r] || !ctx.plateBoundary[r]) continue
    if (ctx.elevation[r] > bestE) { bestE = ctx.elevation[r]; peak = r }
  }
  if (peak < 0) return
  const o = owner[peak]
  if (o >= 0 && realms[o].alive) realms[o].pop *= 0.9
  logEvent(year, 'eruption', `The awakening of a mountain`, `A great peak on the plate line erupts, blanketing the highlands in ash for a year and a day.`, mesh.px[peak], mesh.py[peak])
}

function maybeFlood(
  rng: Rng,
  year: number,
  ctx: SimContext,
  mesh: Mesh,
  owner: Int32Array,
  realms: Realm[],
  logEvent: LogFn,
): void {
  if (rng.next() > 0.1 || ctx.namedRivers.length === 0) return
  const rv = ctx.namedRivers[0]
  const mid = rv.cells[Math.floor(rv.cells.length / 2)]
  const o = owner[mid]
  if (o >= 0 && realms[o].alive) realms[o].pop *= 0.93
  logEvent(year, 'flood', `The Great Flood of ${short(rv.name)}`, `${rv.name} bursts its banks in a season of endless rain, drowning the lowlands along its ${rv.lengthLeagues.toLocaleString()}-league course.`, mesh.px[mid], mesh.py[mid])
}
