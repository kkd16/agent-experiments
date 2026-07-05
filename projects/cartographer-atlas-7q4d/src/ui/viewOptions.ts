// The user-toggleable rendering flags, kept separate from the heavy Palette object
// so they stay serialisable and cheap to store.

/** A full-cell thematic recolour of the land — the atlas's data maps. */
export type Overlay =
  | 'none'
  | 'koppen'
  | 'resource'
  | 'temperature'
  | 'precip'
  | 'elevation'
  // --- Session-5 circulation fields (recolour the ocean too) ---
  | 'pressure'
  | 'wind'
  | 'current'
  | 'sst'

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
  // --- Session-5 circulation layers ---
  /** Static streamline arrows for the chosen circulation field. */
  showFlow: boolean
  /** Animate the circulation field with drifting particles (live app only). */
  animateFlow: boolean
  /** Which field the flow layer visualises. */
  flowField: 'wind' | 'current'
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
  showFlow: false,
  animateFlow: false,
  flowField: 'wind',
}

export const OVERLAYS: readonly { value: Overlay; label: string }[] = [
  { value: 'none', label: 'Natural' },
  { value: 'koppen', label: 'Köppen' },
  { value: 'resource', label: 'Resources' },
  { value: 'temperature', label: 'Temperature' },
  { value: 'precip', label: 'Rainfall' },
  { value: 'elevation', label: 'Elevation' },
  { value: 'pressure', label: 'Pressure' },
  { value: 'wind', label: 'Winds' },
  { value: 'current', label: 'Currents' },
  { value: 'sst', label: 'Sea temp' },
]
