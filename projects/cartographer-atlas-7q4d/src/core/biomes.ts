// Whittaker-style biome classification: given how high a cell sits above sea
// level, how wet it is, and how warm it is, pick an ecosystem. Temperature already
// bakes in an altitude lapse (see terrain.ts), so cold highlands fall out naturally.

export interface BiomeInfo {
  key: string
  name: string
  /** Representative natural colour, used by the Terra palette and the legend. */
  color: string
}

// Order defines the biome id stored per region. Keep ids stable.
export const BIOMES: readonly BiomeInfo[] = [
  { key: 'ocean', name: 'Ocean', color: '#2a5b86' },
  { key: 'beach', name: 'Beach', color: '#e6d8a8' },
  { key: 'snow', name: 'Snow & Ice', color: '#f2f5f8' },
  { key: 'bare', name: 'Bare Rock', color: '#9a9186' },
  { key: 'tundra', name: 'Tundra', color: '#b0b7a4' },
  { key: 'taiga', name: 'Boreal Forest', color: '#4e6d55' },
  { key: 'grassland', name: 'Temperate Grassland', color: '#a9c069' },
  { key: 'deciduous', name: 'Temperate Forest', color: '#5b8a47' },
  { key: 'temperate_rf', name: 'Temperate Rainforest', color: '#356f49' },
  { key: 'savanna', name: 'Savanna', color: '#c6ba63' },
  { key: 'desert', name: 'Desert', color: '#e3cb8a' },
  { key: 'tropical_sf', name: 'Tropical Seasonal Forest', color: '#6faa3c' },
  { key: 'tropical_rf', name: 'Tropical Rainforest', color: '#2f7d3b' },
  { key: 'wetland', name: 'Wetland', color: '#6d7f52' },
]

export const B = {
  ocean: 0,
  beach: 1,
  snow: 2,
  bare: 3,
  tundra: 4,
  taiga: 5,
  grassland: 6,
  deciduous: 7,
  temperate_rf: 8,
  savanna: 9,
  desert: 10,
  tropical_sf: 11,
  tropical_rf: 12,
  wetland: 13,
} as const

/**
 * @param elevAbove elevation above sea level, normalised 0..1
 * @param moisture  0 (arid) .. 1 (saturated)
 * @param temp      0 (frozen) .. 1 (tropical)
 * @param coast     true if the cell borders the ocean
 */
export function classify(
  elevAbove: number,
  moisture: number,
  temp: number,
  coast: boolean,
): number {
  if (coast && elevAbove < 0.05) return B.beach
  if (elevAbove < 0.06 && moisture > 0.82) return B.wetland

  // High, exposed ground.
  if (elevAbove > 0.8 && temp < 0.32) return B.snow
  if (elevAbove > 0.78 && moisture < 0.28) return B.bare

  if (temp < 0.16) return B.snow
  if (temp < 0.34) return moisture < 0.35 ? B.tundra : B.taiga

  if (temp < 0.62) {
    if (moisture < 0.28) return B.grassland
    if (moisture < 0.58) return B.deciduous
    return B.temperate_rf
  }

  // Warm.
  if (moisture < 0.2) return B.desert
  if (moisture < 0.4) return B.savanna
  if (moisture < 0.66) return B.tropical_sf
  return B.tropical_rf
}
