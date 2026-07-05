// The user-toggleable rendering flags, kept separate from the heavy Palette object
// so they stay serialisable and cheap to store.

/** A full-cell thematic recolour of the land — the atlas's data maps. */
export type Overlay = 'none' | 'koppen' | 'resource' | 'temperature' | 'precip' | 'elevation'

export interface ViewOptions {
  paletteKey: string
  /** Active thematic overlay (recolours the land by a data field). */
  overlay: Overlay
  showRivers: boolean
  showCoast: boolean
  showHillshade: boolean
  showBorders: boolean
  showLabels: boolean
  showGrain: boolean
  // --- Session-2 layers ---
  showContours: boolean
  showFrame: boolean
  showGraticule: boolean
  showCompass: boolean
  showScale: boolean
  showProvinces: boolean
  showRoads: boolean
  showCities: boolean
  showPlates: boolean
  // --- Session-3 layers ---
  /** Prevailing-wind rhumb arrows over the sea. */
  showWind: boolean
}

export const DEFAULT_VIEW: ViewOptions = {
  paletteKey: 'terra',
  overlay: 'none',
  showRivers: true,
  showCoast: true,
  showHillshade: true,
  showBorders: false,
  showLabels: true,
  showGrain: true,
  showContours: false,
  showFrame: true,
  showGraticule: false,
  showCompass: true,
  showScale: true,
  showProvinces: false,
  showRoads: true,
  showCities: true,
  showPlates: false,
  showWind: false,
}

export const OVERLAYS: readonly { value: Overlay; label: string }[] = [
  { value: 'none', label: 'Natural' },
  { value: 'koppen', label: 'Köppen' },
  { value: 'resource', label: 'Resources' },
  { value: 'temperature', label: 'Temperature' },
  { value: 'precip', label: 'Rainfall' },
  { value: 'elevation', label: 'Elevation' },
]
