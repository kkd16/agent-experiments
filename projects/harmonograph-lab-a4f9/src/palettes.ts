// Color ramps (multi-stop) used for strokes, and background swatches for the
// canvas. A layer holds its own resolved `colors` array, but these named
// palettes make picking and randomising easy, and back the palette editor.

export interface Palette {
  id: string
  name: string
  colors: string[]
}

export const PALETTES: Palette[] = [
  { id: 'aurora', name: 'Aurora', colors: ['#22d3ee', '#6366f1', '#a855f7', '#f472b6'] },
  { id: 'ember', name: 'Ember', colors: ['#fde68a', '#fbbf24', '#f97316', '#ef4444'] },
  { id: 'mint', name: 'Mint', colors: ['#bef264', '#5eead4', '#34d399', '#0ea5e9'] },
  { id: 'sunset', name: 'Sunset', colors: ['#fef08a', '#fb7185', '#c026d3', '#4f46e5'] },
  { id: 'ice', name: 'Ice', colors: ['#e0f2fe', '#7dd3fc', '#38bdf8', '#2563eb'] },
  { id: 'magma', name: 'Magma', colors: ['#fff7ed', '#fdba74', '#ea580c', '#7f1d1d'] },
  { id: 'viridis', name: 'Viridis', colors: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'] },
  { id: 'plasma', name: 'Plasma', colors: ['#0d0887', '#7e03a8', '#cc4778', '#f89540', '#f0f921'] },
  { id: 'spectrum', name: 'Spectrum', colors: ['#ef4444', '#f59e0b', '#84cc16', '#06b6d4', '#6366f1', '#d946ef'] },
  { id: 'rose-gold', name: 'Rose Gold', colors: ['#fecdd3', '#fda4af', '#f59e0b', '#fde68a'] },
  { id: 'jade', name: 'Jade', colors: ['#ecfccb', '#86efac', '#10b981', '#065f46'] },
  { id: 'neon', name: 'Neon', colors: ['#f0abfc', '#22d3ee', '#a3e635', '#fb7185'] },
  { id: 'mono-light', name: 'Mono Light', colors: ['#f8fafc', '#94a3b8', '#1e293b'] },
  { id: 'gold-ink', name: 'Gold on Ink', colors: ['#fde68a', '#f59e0b', '#b45309'] },
]

export interface Background {
  id: string
  name: string
  color: string
}

export const BACKGROUNDS: Background[] = [
  { id: 'midnight', name: 'Midnight', color: '#070b1a' },
  { id: 'void', name: 'Void', color: '#0a0a0a' },
  { id: 'ink', name: 'Ink', color: '#0b1220' },
  { id: 'espresso', name: 'Espresso', color: '#1a0f0a' },
  { id: 'forest', name: 'Forest', color: '#03140f' },
  { id: 'plum', name: 'Plum', color: '#160a1e' },
  { id: 'slate', name: 'Slate', color: '#1e293b' },
  { id: 'paper', name: 'Paper', color: '#f5f5f0' },
  { id: 'bone', name: 'Bone', color: '#efe9dd' },
]

export function paletteById(id: string): Palette | undefined {
  return PALETTES.find((p) => p.id === id)
}

export function randomPalette(): Palette {
  return PALETTES[Math.floor(Math.random() * PALETTES.length)]
}
