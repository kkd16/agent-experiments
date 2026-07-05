// Köppen–Geiger climate classification — the real thing, from a modelled monthly
// climate. For every land cell we synthesise a twelve-month temperature and
// precipitation cycle from four controls the engine already knows about:
//
//   • latitude       — the primary temperature gradient (equator warm, poles cold);
//   • altitude lapse — already folded into the annual-mean temperature field;
//   • continentality — interiors swing hard between summer and winter, coasts stay mild;
//   • hemisphere     — the north's warm season is the south's cold season (season phase).
//
// Precipitation is spread across the months with a seasonal shape: tropical and
// continental cells concentrate their rain in the high-sun months (a monsoon with a
// dry winter), a subtropical maritime band gets a Mediterranean dry-summer regime,
// and everywhere else trends even. From the twelve monthly pairs we apply the standard
// Köppen decision rules (aridity threshold, the A/B/C/D/E groups and their second/third
// letters) to land each cell in one of ~30 zones — coloured with the familiar Köppen map
// palette so the overlay reads like the climate map in an atlas.

import type { Mesh, WorldParams } from './types'
import { Noise2D } from './noise'

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

export interface KoppenInfo {
  code: string
  name: string
  color: string
}

// Ordered table — the index is the id stored per region. The colours are the widely
// reproduced Köppen–Geiger map colours (Peel/Finlayson/McMahon 2007 style).
export const KOPPEN: readonly KoppenInfo[] = [
  { code: 'Af', name: 'Tropical rainforest', color: '#0000fe' },
  { code: 'Am', name: 'Tropical monsoon', color: '#0077ff' },
  { code: 'Aw', name: 'Tropical savanna', color: '#46a9fa' },
  { code: 'BWh', name: 'Hot desert', color: '#fe0000' },
  { code: 'BWk', name: 'Cold desert', color: '#fe9695' },
  { code: 'BSh', name: 'Hot steppe', color: '#f5a300' },
  { code: 'BSk', name: 'Cold steppe', color: '#ffdb63' },
  { code: 'Csa', name: 'Mediterranean, hot summer', color: '#ffff00' },
  { code: 'Csb', name: 'Mediterranean, warm summer', color: '#c6c700' },
  { code: 'Csc', name: 'Mediterranean, cold summer', color: '#969600' },
  { code: 'Cwa', name: 'Humid subtropical, dry winter', color: '#96ff96' },
  { code: 'Cwb', name: 'Subtropical highland, dry winter', color: '#63c763' },
  { code: 'Cwc', name: 'Cold subtropical highland', color: '#329633' },
  { code: 'Cfa', name: 'Humid subtropical', color: '#c8ff50' },
  { code: 'Cfb', name: 'Oceanic', color: '#66ff33' },
  { code: 'Cfc', name: 'Subpolar oceanic', color: '#33c701' },
  { code: 'Dsa', name: 'Continental, dry hot summer', color: '#ff00ff' },
  { code: 'Dsb', name: 'Continental, dry warm summer', color: '#c600c7' },
  { code: 'Dsc', name: 'Continental, dry cold summer', color: '#963196' },
  { code: 'Dsd', name: 'Continental, dry, very cold winter', color: '#966494' },
  { code: 'Dwa', name: 'Continental, dry winter, hot summer', color: '#abb1ff' },
  { code: 'Dwb', name: 'Continental, dry winter, warm summer', color: '#5a77db' },
  { code: 'Dwc', name: 'Subarctic, dry winter', color: '#4c51b5' },
  { code: 'Dwd', name: 'Subarctic, dry, very cold winter', color: '#320087' },
  { code: 'Dfa', name: 'Continental, hot summer', color: '#00ffff' },
  { code: 'Dfb', name: 'Continental, warm summer', color: '#38c7ff' },
  { code: 'Dfc', name: 'Subarctic', color: '#007e7d' },
  { code: 'Dfd', name: 'Subarctic, very cold winter', color: '#00455e' },
  { code: 'ET', name: 'Tundra', color: '#b2b2b2' },
  { code: 'EF', name: 'Ice cap', color: '#686868' },
]

/** id used for ocean / lake / non-land cells. */
export const KOPPEN_NONE = 255

const CODE_ID: Record<string, number> = {}
KOPPEN.forEach((k, i) => (CODE_ID[k.code] = i))

export interface KoppenResult {
  koppen: Uint8Array
  tWarm: Float32Array
  tCold: Float32Array
  precipMm: Float32Array
}

/**
 * Classify every land cell. Requires the annual-mean temperature field (0..1, already
 * lapse-corrected), the 0..1 precipitation field, and the continentality field.
 */
export function classifyKoppen(
  mesh: Mesh,
  params: WorldParams,
  water: Uint8Array,
  temperature: Float64Array,
  precip: Float64Array,
  continentality: Float64Array,
): KoppenResult {
  const n = mesh.numRegions
  const koppen = new Uint8Array(n).fill(KOPPEN_NONE)
  const tWarm = new Float32Array(n)
  const tCold = new Float32Array(n)
  const precipMm = new Float32Array(n)

  // A little longitudinal noise gates which subtropical coasts get a Mediterranean
  // (dry-summer) regime, so the winter-rain zones cluster rather than ring the globe.
  const medNoise = new Noise2D(`${params.seed}:koppen`)

  const mt = new Float64Array(12) // monthly temperature, °C
  const mp = new Float64Array(12) // monthly precipitation, mm

  for (let r = 0; r < mesh.numSolid; r++) {
    if (water[r]) continue

    const ny = mesh.py[r] / params.height
    const lat = Math.abs(ny * 2 - 1) // 0 equator .. 1 pole
    const north = ny < 0.5 // top half of the map is the northern hemisphere
    const cont = continentality[r]

    // Annual-mean temperature in °C (shares the inspector's mapping: 0..1 → -25..35 °C).
    const meanT = temperature[r] * 60 - 25
    // Half of the peak-to-peak seasonal swing. Grows with latitude and continentality.
    const amp = (2 + 16 * lat) * (0.35 + 0.9 * cont)
    // Warmest month: July (index 6) in the north, January (0) in the south.
    const warmMonth = north ? 6 : 0

    // Annual precipitation total (mm). Deserts land near a few hundred mm, rainforests
    // brush 3000 mm.
    const annualMm = 80 + Math.pow(clamp01(precip[r]), 1.2) * 3000
    precipMm[r] = annualMm

    // Seasonal regime: +1 → summer-wet (monsoon, dry winter); −1 → winter-wet
    // (Mediterranean, dry summer); 0 → even.
    const summerWet = clamp01(1 - lat * 1.8) * (0.35 + 0.75 * cont)
    const gate = medNoise.fbm((mesh.px[r] / params.width) * 2.2 + 4, ny * 2.2, 2)
    const medBand =
      Math.exp(-Math.pow((lat - 0.37) / 0.09, 2)) * (1 - cont) * clamp01((gate - 0.45) * 3)
    const season = Math.max(-1, Math.min(1, summerWet - 1.5 * medBand))

    // Build the twelve months.
    let tMax = -Infinity
    let tMin = Infinity
    let shapeSum = 0
    for (let m = 0; m < 12; m++) {
      const ph = (2 * Math.PI * (m - warmMonth)) / 12
      const c = Math.cos(ph)
      mt[m] = meanT + amp * c
      if (mt[m] > tMax) tMax = mt[m]
      if (mt[m] < tMin) tMin = mt[m]
      // Wet peak follows the warm season when season>0, the cold season when season<0.
      const shape = Math.max(0.03, 1 + 0.95 * season * c)
      mp[m] = shape
      shapeSum += shape
    }
    const norm = annualMm / shapeSum
    for (let m = 0; m < 12; m++) mp[m] *= norm

    tWarm[r] = tMax
    tCold[r] = tMin

    koppen[r] = CODE_ID[classifyCell(mt, mp, meanT, tMax, tMin, annualMm)] ?? CODE_ID['ET']
  }

  return { koppen, tWarm, tCold, precipMm }
}

/** Apply the Köppen decision tree to one cell's twelve monthly (T, P) pairs. */
function classifyCell(
  mt: Float64Array,
  mp: Float64Array,
  meanT: number,
  tWarm: number,
  tCold: number,
  annualMm: number,
): string {
  // Warm vs cold half of the year (the 6 hottest months are "summer").
  const idx = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].sort((a, b) => mt[b] - mt[a])
  const summer = new Set(idx.slice(0, 6))

  let pSummer = 0
  let pDry = Infinity
  let pSummerDriest = Infinity
  let pSummerWettest = 0
  let pWinterDriest = Infinity
  let pWinterWettest = 0
  let monthsOver10 = 0
  for (let m = 0; m < 12; m++) {
    if (mp[m] < pDry) pDry = mp[m]
    if (mt[m] >= 10) monthsOver10++
    if (summer.has(m)) {
      pSummer += mp[m]
      if (mp[m] < pSummerDriest) pSummerDriest = mp[m]
      if (mp[m] > pSummerWettest) pSummerWettest = mp[m]
    } else {
      if (mp[m] < pWinterDriest) pWinterDriest = mp[m]
      if (mp[m] > pWinterWettest) pWinterWettest = mp[m]
    }
  }

  // --- B (arid): tested before everything else ---
  const frac = annualMm > 0 ? pSummer / annualMm : 0.5
  const adj = frac >= 0.7 ? 280 : frac <= 0.3 ? 0 : 140
  const threshold = 20 * meanT + adj
  if (annualMm < threshold) {
    const hot = meanT >= 18
    if (annualMm < threshold * 0.5) return hot ? 'BWh' : 'BWk'
    return hot ? 'BSh' : 'BSk'
  }

  // --- E (polar) ---
  if (tWarm < 10) return tWarm > 0 ? 'ET' : 'EF'

  // --- A (tropical) ---
  if (tCold >= 18) {
    if (pDry >= 60) return 'Af'
    if (pDry >= 100 - annualMm / 25) return 'Am'
    return 'Aw'
  }

  // --- C / D temperate & continental ---
  const group = tCold >= -3 ? 'C' : 'D'
  // Second letter: dry-summer (s), dry-winter (w) or without (f).
  let second: string
  if (pSummerDriest < pWinterWettest / 3 && pSummerDriest < 40) second = 's'
  else if (pWinterDriest < pSummerWettest / 10) second = 'w'
  else second = 'f'
  // Third letter.
  let third: string
  if (group === 'D' && tCold < -38) third = 'd'
  else if (tWarm >= 22) third = 'a'
  else if (monthsOver10 >= 4) third = 'b'
  else third = 'c'

  const code = group + second + third
  return CODE_ID[code] != null ? code : group + second + 'b'
}
