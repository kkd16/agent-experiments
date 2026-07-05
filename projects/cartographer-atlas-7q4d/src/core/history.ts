// A chronicle for the world. Once a map has cities, realms, rivers, mountains and an
// economy, it has the raw material for a *history* — and a fantasy atlas without a little
// history feels empty. This builds a deterministic timeline from the world's own
// structure: the oldest ports are founded first, kingdoms are proclaimed, neighbouring
// realms go to war (the richer usually swallowing the weaker), volcanoes erupt on plate
// boundaries, great rivers flood, plagues strike the trade hubs, and golden ages and
// famines track wealth and drought. Same seed ⇒ same saga.

import type {
  ChronicleEvent,
  City,
  Mesh,
  NamedRiver,
  ProvinceInfo,
  WorldParams,
} from './types'
import { B } from './biomes'
import { Rng } from './rng'

export interface HistoryCtx {
  cities: City[]
  province: Int32Array
  provinceInfo: ProvinceInfo[]
  namedRivers: NamedRiver[]
  plateBoundary: Uint8Array
  elevation: Float64Array
  biome: Uint8Array
}

export interface History {
  events: ChronicleEvent[]
  era: string
}

const ONSETS = ['B', 'C', 'D', 'F', 'G', 'H', 'K', 'L', 'M', 'N', 'R', 'S', 'T', 'V', 'W', 'Th', 'Dr', 'Gl']
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ae', 'ei', 'ia', 'or']
const CODAS = ['n', 'r', 'l', 's', 'th', 'nd', 'rn', 'x', 'k', 'm']

function name(rng: Rng, syl = 2): string {
  let s = ''
  for (let i = 0; i < syl; i++) {
    s += (i === 0 ? rng.pick(ONSETS) : rng.pick(ONSETS).toLowerCase()) + rng.pick(VOWELS)
    if (rng.next() < 0.5) s += rng.pick(CODAS)
  }
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const ERA_FORMS = ['the %s Age', 'the Age of %s', 'the %s Epoch', 'the Reign of %s', 'the %s Era']
const ORDINAL = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Elder', 'Golden', 'Sundered']

/** Province adjacency: which realms share a border (by cell neighbours). */
function realmAdjacency(mesh: Mesh, province: Int32Array, k: number): Set<number>[] {
  const adj: Set<number>[] = Array.from({ length: k }, () => new Set<number>())
  for (let r = 0; r < mesh.numSolid; r++) {
    const a = province[r]
    if (a < 0) continue
    for (const j of mesh.neighbors[r]) {
      const b = province[j]
      if (b >= 0 && b !== a) {
        adj[a].add(b)
        adj[b].add(a)
      }
    }
  }
  return adj
}

export function buildChronicle(mesh: Mesh, params: WorldParams, ctx: HistoryCtx): History {
  const rng = new Rng(`${params.seed}:history`)
  const era = (rng.next() < 0.5 ? `${rng.pick(ORDINAL)}` : name(rng))
  const eraName = rng.pick(ERA_FORMS).replace('%s', era)

  const events: ChronicleEvent[] = []
  const { cities, provinceInfo } = ctx
  const K = cities.length
  if (K === 0) return { events, era: eraName }

  const push = (year: number, kind: ChronicleEvent['kind'], title: string, text: string, x?: number, y?: number): void => {
    events.push({ year, kind, title, text, x, y })
  }

  // Rank realms by prosperity (wealth first, then area).
  const rank = [...Array(K).keys()].sort((a, b) => {
    const wa = provinceInfo[a]?.wealth ?? 0
    const wb = provinceInfo[b]?.wealth ?? 0
    if (wb !== wa) return wb - wa
    return (provinceInfo[b]?.area ?? 0) - (provinceInfo[a]?.area ?? 0)
  })

  // --- Foundings: the great seats first, spread across the early centuries ---
  const founders = rank.slice(0, Math.min(K, 7))
  founders.forEach((ci, idx) => {
    const c = cities[ci]
    const year = 20 + idx * rng.int(45, 80)
    if (c.capital) {
      push(year, 'realm', `${c.realm} founded`, `Settlers raise the walls of ${c.name}, seat of ${c.realm}, upon fertile ground.`, c.x, c.y)
    } else {
      push(year, 'founding', `${c.name} founded`, `The port of ${c.name} is established and soon prospers on the trade of ${c.realm}.`, c.x, c.y)
    }
  })

  // --- Wars between neighbouring realms; the richer tends to annex the weaker ---
  const adj = realmAdjacency(mesh, ctx.province, K)
  const warPairs: Array<[number, number]> = []
  const used = new Set<string>()
  for (const a of rank) {
    for (const b of adj[a]) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`
      if (used.has(key)) continue
      used.add(key)
      warPairs.push([a, b])
    }
  }
  const wars = Math.min(warPairs.length, rng.int(2, 4) + Math.floor(K / 6))
  let warYear = 380
  for (let i = 0; i < wars; i++) {
    const [a, b] = warPairs[i]
    warYear += rng.int(40, 130)
    const wa = provinceInfo[a]?.wealth ?? 0
    const wb = provinceInfo[b]?.wealth ?? 0
    const victor = wa >= wb ? a : b
    const loser = victor === a ? b : a
    const cv = cities[victor]
    const cl = cities[loser]
    const decisive = rng.next() < 0.5
    if (decisive) {
      push(warYear, 'war', `The ${short(cl.realm)}–${short(cv.realm)} War`, `${cv.realm} defeats ${cl.realm} and annexes the marches about ${cl.name}.`, (cv.x + cl.x) / 2, (cv.y + cl.y) / 2)
    } else {
      push(warYear, 'war', `The ${short(cv.realm)}–${short(cl.realm)} War`, `A long, ruinous war between ${cv.realm} and ${cl.realm} ends in an uneasy truce.`, (cv.x + cl.x) / 2, (cv.y + cl.y) / 2)
    }
  }

  // --- Eruption on a plate boundary / high peak ---
  const peak = highLandCell(mesh, ctx)
  if (peak >= 0) {
    push(rng.int(120, 900), 'eruption', `Mount ${name(rng)} awakens`, `The great peak that dominates the interior erupts, blanketing the highlands in ash for a year and a day.`, mesh.px[peak], mesh.py[peak])
  }

  // --- Flood on the greatest river ---
  if (ctx.namedRivers.length > 0) {
    const rv = ctx.namedRivers[0]
    const mid = rv.cells[Math.floor(rv.cells.length / 2)]
    push(rng.int(200, 1000), 'flood', `The Great Flood of ${short(rv.name)}`, `${rv.name} bursts its banks in a season of endless rain, drowning the lowlands along its ${rv.lengthLeagues}-league course.`, mesh.px[mid], mesh.py[mid])
  }

  // --- Plague in the richest trade hub ---
  if (rank.length) {
    const hub = cities[rank[0]]
    push(rng.int(500, 1100), 'plague', `The Pallid Plague`, `A sickness carried by trade ships takes hold in ${hub.name}, richest of cities, and a third of its people are lost.`, hub.x, hub.y)
  }

  // --- Golden age of the wealthiest realm ---
  if (rank.length) {
    const g = cities[rank[0]]
    push(rng.int(700, 1200), 'golden', `The Golden Age of ${short(g.realm)}`, `Under a long peace, ${g.realm} grows fat on trade; its ${describeExports(provinceInfo[rank[0]])} flow to every port.`, g.x, g.y)
  }

  // --- Famine in the driest realm ---
  const dry = driestRealm(mesh, ctx, K)
  if (dry >= 0) {
    const d = cities[dry]
    push(rng.int(300, 1150), 'famine', `The Long Famine`, `Drought withers the fields of ${d.realm}; its people abandon the parched interior for the coasts.`, d.x, d.y)
  }

  // --- A great road opened between the two richest capitals ---
  if (rank.length >= 2) {
    const a = cities[rank[0]]
    const b = cities[rank[1]]
    push(rng.int(900, 1300), 'road', `The ${name(rng)} Road`, `A paved way is completed between ${a.name} and ${b.name}, binding the realms and quickening their trade.`, (a.x + b.x) / 2, (a.y + b.y) / 2)
  }

  events.sort((e1, e2) => e1.year - e2.year)
  return { events, era: eraName }
}

/** Strip a realm's grammatical dressing to a bare stem for compact war titles. */
function short(realm: string): string {
  return realm
    .replace(/^The\s+/i, '')
    .replace(/\s+(Marches|Dominion|Duchy|Kingdom)$/i, '')
    .replace(/^(Kingdom|Duchy) of\s+/i, '')
    .split(' ')[0]
}

function describeExports(info?: ProvinceInfo): string {
  if (!info || info.exports.length === 0) return 'wares'
  return info.exports.join(', ')
}

/** The highest land cell (preferring plate boundaries) — where a volcano would sit. */
function highLandCell(mesh: Mesh, ctx: HistoryCtx): number {
  let best = -1
  let bestScore = -Infinity
  const hasPlates = ctx.plateBoundary.length > 0
  for (let r = 0; r < mesh.numSolid; r++) {
    if (ctx.biome[r] === B.ocean) continue
    let s = ctx.elevation[r]
    if (hasPlates && ctx.plateBoundary[r]) s += 0.5
    if (s > bestScore) {
      bestScore = s
      best = r
    }
  }
  return best
}

/** The realm whose cells are on average the most arid (desert/steppe). */
function driestRealm(mesh: Mesh, ctx: HistoryCtx, k: number): number {
  const dryCount = new Int32Array(k)
  const total = new Int32Array(k)
  for (let r = 0; r < mesh.numSolid; r++) {
    const p = ctx.province[r]
    if (p < 0) continue
    total[p]++
    if (ctx.biome[r] === B.desert) dryCount[p]++
  }
  let best = -1
  let bestFrac = 0.25 // must be meaningfully dry to earn a famine
  for (let i = 0; i < k; i++) {
    if (total[i] < 8) continue
    const frac = dryCount[i] / total[i]
    if (frac > bestFrac) {
      bestFrac = frac
      best = i
    }
  }
  return best
}
