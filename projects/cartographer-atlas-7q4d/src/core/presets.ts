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
  terrainMode: 'noise',
  plates: 9,
  windAngle: 200,
  orographic: 0.7,
  cities: 12,
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
  {
    name: 'Tectonic',
    blurb: 'Plate-driven mountain arcs & rift seas',
    patch: {
      terrainMode: 'tectonic',
      plates: 10,
      seaLevel: 0.35,
      shape: 'pangaea',
      islandFalloff: 0.7,
      orographic: 0.8,
    },
  },
  {
    name: 'Monsoon',
    blurb: 'Strong wind, sharp rain-shadow deserts',
    patch: { shape: 'continent', seaLevel: 0.4, orographic: 1, windAngle: 250, rainfall: 1.6, octaves: 7 },
  },
  {
    name: 'Lakelands',
    blurb: 'A low, wet world thick with lakes',
    patch: { shape: 'continent', seaLevel: 0.34, rainfall: 1.8, erosion: 0, riverThreshold: 0.006, orographic: 0.5 },
  },
  {
    name: 'Köppen Earth',
    blurb: 'A broad, varied world spanning every climate belt',
    patch: {
      shape: 'pangaea',
      terrainMode: 'tectonic',
      plates: 11,
      seaLevel: 0.36,
      islandFalloff: 0.6,
      octaves: 6,
      rainfall: 1.2,
      orographic: 0.75,
      windAngle: 210,
      cities: 16,
    },
  },
  {
    name: 'Ice Age',
    blurb: 'A frozen world of tundra, taiga and glaciers',
    patch: { shape: 'continent', seaLevel: 0.46, rainfall: 0.9, orographic: 0.6, octaves: 6, cities: 8 },
  },
  {
    name: 'Desert World',
    blurb: 'Vast rain-shadow deserts behind sharp ranges',
    patch: {
      shape: 'pangaea',
      seaLevel: 0.4,
      islandFalloff: 0.55,
      rainfall: 0.6,
      orographic: 1,
      windAngle: 180,
      octaves: 7,
      cities: 10,
    },
  },
]

export const SHAPES: readonly { value: WorldShape; label: string }[] = [
  { value: 'continent', label: 'Continent' },
  { value: 'archipelago', label: 'Archipelago' },
  { value: 'pangaea', label: 'Pangaea' },
]
