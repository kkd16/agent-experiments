// The user-toggleable rendering flags, kept separate from the heavy Palette object
// so they stay serialisable and cheap to store.

export interface ViewOptions {
  paletteKey: string
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
}

export const DEFAULT_VIEW: ViewOptions = {
  paletteKey: 'terra',
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
}
