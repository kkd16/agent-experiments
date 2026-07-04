// Procedural place names + where to stamp them. Names come from a small syllable
// grammar; placement finds connected landmasses (kingdoms), highland clusters
// (mountain ranges), and the open sea, then labels the largest of each.

import { Rng } from './rng'
import type { Label, Mesh } from './types'

const ONSETS = [
  'b', 'br', 'c', 'd', 'dr', 'f', 'g', 'gr', 'h', 'k', 'kr', 'l', 'm', 'n', 'p',
  'r', 's', 'sh', 'st', 't', 'th', 'tr', 'v', 'w',
]
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ae', 'ei', 'ia', 'ou', 'y']
const CODAS = ['', 'n', 'r', 's', 'l', 'th', 'nd', 'rn', 'st', 'ld', 'm', '']

function syllable(rng: Rng, first: boolean): string {
  const onset = first && rng.next() < 0.25 ? '' : rng.pick(ONSETS)
  return onset + rng.pick(VOWELS) + rng.pick(CODAS)
}

function makeName(rng: Rng): string {
  const n = rng.int(2, 3)
  let s = ''
  for (let i = 0; i < n; i++) s += syllable(rng, i === 0)
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const RANGE_FORMS = ['%s Mountains', 'The %s Range', '%s Peaks', '%s Highlands', 'Spine of %s']
const SEA_FORMS = ['The %s Ocean', '%s Sea', 'The %s Deep', 'Gulf of %s']

/** Connected components over regions for which `member(r)` is true. */
function components(mesh: Mesh, member: (r: number) => boolean): number[][] {
  const seen = new Uint8Array(mesh.numRegions)
  const out: number[][] = []
  for (let r = 0; r < mesh.numSolid; r++) {
    if (seen[r] || !member(r)) continue
    const stack = [r]
    seen[r] = 1
    const comp: number[] = []
    while (stack.length) {
      const c = stack.pop() as number
      comp.push(c)
      for (const j of mesh.neighbors[c]) {
        if (j < mesh.numSolid && !seen[j] && member(j)) {
          seen[j] = 1
          stack.push(j)
        }
      }
    }
    out.push(comp)
  }
  return out
}

/** The component member closest to the component's centroid (keeps labels on land). */
function centroidRegion(mesh: Mesh, comp: number[]): { x: number; y: number; r: number } {
  let sx = 0
  let sy = 0
  for (const r of comp) {
    sx += mesh.px[r]
    sy += mesh.py[r]
  }
  const cx = sx / comp.length
  const cy = sy / comp.length
  let best = comp[0]
  let bestD = Infinity
  for (const r of comp) {
    const dx = mesh.px[r] - cx
    const dy = mesh.py[r] - cy
    const d = dx * dx + dy * dy
    if (d < bestD) {
      bestD = d
      best = r
    }
  }
  return { x: mesh.px[best], y: mesh.py[best], r: best }
}

export function generateLabels(
  mesh: Mesh,
  elevation: Float64Array,
  ocean: Uint8Array,
  seaLevel: number,
  seed: string,
): Label[] {
  const rng = new Rng(`${seed}:names`)
  const labels: Label[] = []
  const elevAbove = (r: number): number =>
    Math.max(0, elevation[r] - seaLevel) / (1 - seaLevel || 1)

  // --- Kingdoms: the biggest landmasses ---
  const landmasses = components(mesh, (r) => !ocean[r]).sort((a, b) => b.length - a.length)
  const maxLand = landmasses[0]?.length ?? 1
  let kingdoms = 0
  for (const comp of landmasses) {
    if (comp.length < Math.max(12, maxLand * 0.05)) break
    if (kingdoms >= 5) break
    const { x, y } = centroidRegion(mesh, comp)
    labels.push({ x, y, text: makeName(rng), kind: 'kingdom', weight: comp.length / maxLand })
    kingdoms++
  }

  // --- Mountain ranges: connected highland clusters ---
  const highlands = components(mesh, (r) => !ocean[r] && elevAbove(r) > 0.58).sort(
    (a, b) => b.length - a.length,
  )
  const maxRange = highlands[0]?.length ?? 1
  let ranges = 0
  for (const comp of highlands) {
    if (comp.length < 8) break
    if (ranges >= 3) break
    const { x, y } = centroidRegion(mesh, comp)
    const form = rng.pick(RANGE_FORMS)
    labels.push({
      x,
      y,
      text: form.replace('%s', makeName(rng)),
      kind: 'range',
      weight: comp.length / maxRange,
    })
    ranges++
  }

  // --- Open sea: the ocean cell farthest from any land ---
  const dist = new Int32Array(mesh.numRegions).fill(-1)
  let q: number[] = []
  for (let r = 0; r < mesh.numRegions; r++) {
    if (!ocean[r]) {
      dist[r] = 0
      q.push(r)
    }
  }
  let farthest = -1
  let farDist = -1
  while (q.length) {
    const nq: number[] = []
    for (const c of q) {
      for (const j of mesh.neighbors[c]) {
        if (dist[j] === -1 && ocean[j]) {
          dist[j] = dist[c] + 1
          if (dist[j] > farDist && !mesh.isFrame[j]) {
            farDist = dist[j]
            farthest = j
          }
          nq.push(j)
        }
      }
    }
    q = nq
  }
  if (farthest >= 0 && farDist > 2) {
    const form = rng.pick(SEA_FORMS)
    labels.push({
      x: mesh.px[farthest],
      y: mesh.py[farthest],
      text: form.replace('%s', makeName(rng)),
      kind: 'sea',
      weight: 1,
    })
  }

  return labels
}
