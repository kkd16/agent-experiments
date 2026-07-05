// Naming the great rivers. Hydrology gives us a downslope forest (every land cell
// points at its lowest neighbour) and a flux per cell (accumulated rainfall). A river's
// *main stem* is the path you get by starting at a mouth — a land cell that drains
// straight into the sea or a lake — and walking upstream, always following the tributary
// that carries the most water. That traces the trunk from the coast to the remotest
// headwater. We measure each stem's length, keep the longest, and give them names so the
// atlas can label its Nile and its Danube.

import type { Mesh, NamedRiver, WorldParams } from './types'
import { Rng } from './rng'

const ONSETS = ['B', 'Br', 'C', 'D', 'Dr', 'F', 'G', 'Gl', 'H', 'K', 'L', 'M', 'N', 'R', 'S', 'T', 'Th', 'V', 'W']
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ae', 'ei', 'io', 'ou']
const CODAS = ['n', 'r', 'l', 's', 'th', 'nd', 'rn', 'ne', 'll', 'm']
const FORMS = ['%s', 'The %s', '%s', 'River %s', 'The %s', '%s Water', 'The %s Run']

function riverName(rng: Rng): string {
  const syl = rng.int(2, 3)
  let s = ''
  for (let i = 0; i < syl; i++) {
    s += (i === 0 ? rng.pick(ONSETS) : rng.pick(ONSETS).toLowerCase()) + rng.pick(VOWELS)
    if (rng.next() < 0.55) s += rng.pick(CODAS)
  }
  const name = s.charAt(0).toUpperCase() + s.slice(1)
  return rng.pick(FORMS).replace('%s', name)
}

/**
 * Trace and name the main stems. Returns the great rivers, longest first.
 *
 * @param downslope steepest-descent neighbour per land cell (−1 for ocean/sink).
 * @param flux      accumulated water flux per cell.
 * @param water     1 for ocean + lake cells.
 * @param edges     the threshold-passing river edges (used to size the naming cut-off).
 */
export function traceNamedRivers(
  mesh: Mesh,
  params: WorldParams,
  downslope: Int32Array,
  flux: Float64Array,
  water: Uint8Array,
  edges: Array<{ a: number; b: number; flux: number }>,
): NamedRiver[] {
  const n = mesh.numSolid
  if (edges.length === 0) return []

  // The flux a cell must carry to count as flowing water — the same cut-off hydrology
  // used to draw a river line, so stems never wander up dry gullies.
  let riverThr = Infinity
  for (const e of edges) if (e.flux < riverThr) riverThr = e.flux
  if (!isFinite(riverThr)) return []

  // Upstream children: invert the downslope forest.
  const children: number[][] = Array.from({ length: n }, () => [])
  for (let r = 0; r < n; r++) {
    const d = downslope[r]
    if (d >= 0 && d < n && flux[r] >= riverThr) children[d].push(r)
  }

  const leaguesPerUnit = 1600 / params.width

  // Mouths: flowing land cells whose downslope neighbour is water.
  interface Stem {
    cells: number[]
    length: number
    mouth: number
    flux: number
  }
  const stems: Stem[] = []
  for (let r = 0; r < n; r++) {
    if (water[r] || flux[r] < riverThr) continue
    const d = downslope[r]
    if (d < 0 || !water[d]) continue

    // Walk upstream, always up the biggest tributary.
    const stem: number[] = [r]
    let cur = r
    let guard = 0
    for (;;) {
      const kids = children[cur]
      if (kids.length === 0 || ++guard > 100000) break
      let best = -1
      let bestF = -Infinity
      for (const k of kids) {
        if (flux[k] > bestF) {
          bestF = flux[k]
          best = k
        }
      }
      if (best < 0) break
      stem.push(best)
      cur = best
    }
    // stem is mouth→source; reverse to source→mouth for a natural read.
    stem.reverse()

    let len = 0
    for (let i = 1; i < stem.length; i++) {
      const a = stem[i - 1]
      const b = stem[i]
      len += Math.hypot(mesh.px[a] - mesh.px[b], mesh.py[a] - mesh.py[b])
    }
    stems.push({ cells: stem, length: len * leaguesPerUnit, mouth: r, flux: flux[r] })
  }

  stems.sort((a, b) => b.length - a.length)

  const rng = new Rng(`${params.seed}:rivers`)
  const out: NamedRiver[] = []
  const maxNamed = 9
  for (const s of stems) {
    if (out.length >= maxNamed) break
    // Only worthwhile stems get a name: long enough to read on the map.
    if (s.cells.length < 6 || s.length < 120) continue
    out.push({ name: riverName(rng), cells: s.cells, lengthLeagues: Math.round(s.length), mouth: s.mouth })
  }
  return out
}
