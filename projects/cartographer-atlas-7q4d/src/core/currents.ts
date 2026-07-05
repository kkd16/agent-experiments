// Named ocean currents & gyres — the sea's answer to the named great rivers.
//
// The circulation model already gives a divergence-free surface current (the curl of the
// Stommel streamfunction ψ). This module reads structure out of that field:
//
//   • GYRES — connected patches of ocean where |ψ| clears a fraction of its peak, split by
//     sign. Each is a closed rotating cell; its rotation sense is the sign of the water's net
//     angular momentum about the patch centroid.
//   • GREAT CURRENTS — the strongest streamlines, traced the way rivers trace their main stem:
//     seed on the fastest unclaimed water, follow the flow downstream and upstream into a
//     single ribbon, measure it in leagues, and name it. The western boundary currents (the
//     Gulf-Stream-like jets the β term produces) come out as the longest, fastest ones.
//
// Everything is deterministic from the seed and worker-clone-safe (typed arrays + plain data).

import type { Mesh, WorldParams } from './types'
import { Rng } from './rng'

export interface NamedCurrent {
  name: string
  /** Ordered region indices along the current's main ribbon. */
  cells: number[]
  /** Ribbon length in leagues (same world scale as the rivers & scale bar). */
  lengthLeagues: number
  /** Mean normalised speed (0..1) along the ribbon. */
  meanSpeed: number
}

export interface GyreInfo {
  id: number
  /** Ocean cells in the gyre. */
  area: number
  /** Rotation sense: +1 anticlockwise, −1 clockwise (screen axes). */
  sense: number
  /** Peak normalised current speed inside the gyre. */
  peak: number
  /** Centroid (world coordinates). */
  cx: number
  cy: number
}

export interface CurrentAtlas {
  named: NamedCurrent[]
  /** Per region: index into `named` of the current running through it, or −1. */
  currentName: Int32Array
  gyres: GyreInfo[]
}

const ONSETS = ['b', 'd', 'g', 'k', 'l', 'm', 'n', 'r', 's', 't', 'v', 'th', 'br', 'dr', 'gl', 'st']
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ae', 'ia', 'oo']
const CODAS = ['', 'n', 'r', 's', 'l', 'th', 'rn', '']
const CURRENT_FORMS = ['%s Current', 'The %s Drift', '%s Stream', 'The %s Race', '%s Flow']

function makeName(rng: Rng): string {
  const n = rng.int(2, 3)
  let s = ''
  for (let i = 0; i < n; i++) {
    const onset = i === 0 && rng.next() < 0.2 ? '' : rng.pick(ONSETS)
    s += onset + rng.pick(VOWELS) + rng.pick(CODAS)
  }
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function buildCurrentAtlas(
  mesh: Mesh,
  params: WorldParams,
  ocean: Uint8Array,
  curU: Float32Array,
  curV: Float32Array,
  curSpeed: Float32Array,
  psi: Float32Array,
): CurrentAtlas {
  const n = mesh.numRegions
  const inSea = (r: number): boolean => ocean[r] === 1 && !mesh.isFrame[r]

  // --- Gyres: sign-split components of the streamfunction above a threshold ---
  let peakPsi = 0
  for (let r = 0; r < n; r++) if (inSea(r)) peakPsi = Math.max(peakPsi, Math.abs(psi[r]))
  const psiThr = peakPsi * 0.18
  const gyreOf = new Int32Array(n).fill(-1)
  const gyres: GyreInfo[] = []
  for (let r = 0; r < n; r++) {
    if (!inSea(r) || gyreOf[r] !== -1 || Math.abs(psi[r]) < psiThr) continue
    const sign = psi[r] > 0 ? 1 : -1
    const stack = [r]
    gyreOf[r] = gyres.length
    const comp: number[] = []
    while (stack.length) {
      const cptr = stack.pop() as number
      comp.push(cptr)
      for (const j of mesh.neighbors[cptr]) {
        if (inSea(j) && gyreOf[j] === -1 && Math.abs(psi[j]) >= psiThr && (psi[j] > 0 ? 1 : -1) === sign) {
          gyreOf[j] = gyres.length
          stack.push(j)
        }
      }
    }
    if (comp.length < 6) {
      for (const cptr of comp) gyreOf[cptr] = -1
      continue
    }
    // Centroid, peak speed, and rotation sense (net angular momentum about the centroid).
    let sx = 0
    let sy = 0
    let peak = 0
    for (const cptr of comp) {
      sx += mesh.px[cptr]
      sy += mesh.py[cptr]
      peak = Math.max(peak, curSpeed[cptr])
    }
    const cx = sx / comp.length
    const cy = sy / comp.length
    let angMom = 0
    for (const cptr of comp) {
      const dx = mesh.px[cptr] - cx
      const dy = mesh.py[cptr] - cy
      angMom += dx * curV[cptr] - dy * curU[cptr]
    }
    gyres.push({ id: gyres.length, area: comp.length, sense: angMom >= 0 ? 1 : -1, peak, cx, cy })
  }

  // --- Great currents: trace the strongest streamlines into ribbons ---
  const rng = new Rng(`${params.seed}:currents`)
  const currentName = new Int32Array(n).fill(-1)
  const used = new Uint8Array(n)
  let peakSpeed = 0
  for (let r = 0; r < n; r++) if (inSea(r)) peakSpeed = Math.max(peakSpeed, curSpeed[r])
  const seeds: number[] = []
  for (let r = 0; r < n; r++) if (inSea(r) && curSpeed[r] > 0.35 * peakSpeed) seeds.push(r)
  seeds.sort((a, b) => curSpeed[b] - curSpeed[a])

  // Follow the flow one step in the given direction (+1 downstream, −1 upstream).
  const walk = (start: number, dir: number, out: number[]): void => {
    let cur = start
    for (let step = 0; step < 400; step++) {
      const speed = curSpeed[cur]
      if (speed < 0.18 * peakSpeed) break
      const dx = (dir * curU[cur]) / (speed || 1)
      const dy = (dir * curV[cur]) / (speed || 1)
      let best = -1
      let bestAlign = 0.2
      for (const j of mesh.neighbors[cur]) {
        if (!inSea(j) || used[j]) continue
        let ex = mesh.px[j] - mesh.px[cur]
        let ey = mesh.py[j] - mesh.py[cur]
        const el = Math.hypot(ex, ey) || 1
        ex /= el
        ey /= el
        const align = ex * dx + ey * dy
        if (align > bestAlign) {
          bestAlign = align
          best = j
        }
      }
      if (best < 0) break
      used[best] = 1
      out.push(best)
      cur = best
    }
  }

  const leaguesPerWorld = 1600 / params.width
  const named: NamedCurrent[] = []
  for (const seed of seeds) {
    if (used[seed] || named.length >= 6) continue
    used[seed] = 1
    const back: number[] = []
    walk(seed, -1, back)
    const fwd: number[] = []
    walk(seed, 1, fwd)
    const cells = [...back.reverse(), seed, ...fwd]
    if (cells.length < 8) continue
    let len = 0
    let spdSum = 0
    for (let i = 0; i < cells.length; i++) {
      spdSum += curSpeed[cells[i]]
      if (i > 0) {
        len += Math.hypot(mesh.px[cells[i]] - mesh.px[cells[i - 1]], mesh.py[cells[i]] - mesh.py[cells[i - 1]])
      }
    }
    const idx = named.length
    for (const cptr of cells) if (currentName[cptr] === -1) currentName[cptr] = idx
    named.push({
      name: CURRENT_FORMS[rng.int(0, CURRENT_FORMS.length - 1)].replace('%s', makeName(rng)),
      cells,
      lengthLeagues: Math.round(len * leaguesPerWorld),
      meanSpeed: spdSum / cells.length,
    })
  }
  // Sort by prominence, then (re)label each region with its current's final index.
  named.sort((a, b) => b.lengthLeagues - a.lengthLeagues)
  currentName.fill(-1)
  named.forEach((nc, i) => {
    for (const cptr of nc.cells) if (currentName[cptr] === -1) currentName[cptr] = i
  })

  gyres.sort((a, b) => b.area - a.area)
  return { named, currentName, gyres }
}
