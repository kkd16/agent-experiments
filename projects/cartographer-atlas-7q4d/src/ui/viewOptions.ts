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
}

export const DEFAULT_VIEW: ViewOptions = {
  paletteKey: 'terra',
  showRivers: true,
  showCoast: true,
  showHillshade: true,
  showBorders: false,
  showLabels: true,
  showGrain: true,
}
