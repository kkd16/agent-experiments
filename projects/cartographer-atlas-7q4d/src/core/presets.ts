// Default parameters and a few hand-tuned presets the studio exposes as one-click
// starting points.

import type { WorldParams, WorldShape } from './types'

export const DEFAULT_PARAMS: WorldParams = {
  seed: 'azimuth',
  width: 1000,
  height: 700,
  regions: 7000,
  shape: 'continent',
  seaLevel: 0.42,
  noiseScale: 3.2,
  octaves: 6,
  erosion: 1,
  rainfall: 1,
  riverThreshold: 0.012,
  islandFalloff: 0.9,
}

export interface Preset {
  name: string
  blurb: string
  patch: Partial<WorldParams>
}

export const PRESETS: readonly Preset[] = [
  {
    name: 'Continent',
    blurb: 'One big landmass ringed by sea',
    patch: { shape: 'continent', seaLevel: 0.42, islandFalloff: 0.95, noiseScale: 3.2 },
  },
  {
    name: 'Archipelago',
    blurb: 'Scattered islands and shallow straits',
    patch: { shape: 'archipelago', seaLevel: 0.44, islandFalloff: 0.9, noiseScale: 4.3 },
  },
  {
    name: 'Pangaea',
    blurb: 'A sprawling supercontinent',
    patch: { shape: 'pangaea', seaLevel: 0.28, islandFalloff: 0.6, noiseScale: 2.4 },
  },
  {
    name: 'Highlands',
    blurb: 'Rugged, river-carved uplands',
    patch: { shape: 'continent', seaLevel: 0.3, octaves: 7, erosion: 0, riverThreshold: 0.008 },
  },
  {
    name: 'Drowned',
    blurb: 'A flooded world of narrow capes',
    patch: { shape: 'continent', seaLevel: 0.52, islandFalloff: 1.0, noiseScale: 4 },
  },
]

export const SHAPES: readonly { value: WorldShape; label: string }[] = [
  { value: 'continent', label: 'Continent' },
  { value: 'archipelago', label: 'Archipelago' },
  { value: 'pangaea', label: 'Pangaea' },
]
