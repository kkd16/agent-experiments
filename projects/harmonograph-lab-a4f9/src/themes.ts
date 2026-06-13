export interface Theme {
  id: string
  name: string
  background: string
  // Stops sampled along the curve to build a gradient stroke.
  stroke: [string, string, string]
}

export const THEMES: Theme[] = [
  {
    id: 'aurora',
    name: 'Aurora',
    background: '#070b1a',
    stroke: ['#22d3ee', '#a855f7', '#f472b6'],
  },
  {
    id: 'ember',
    name: 'Ember',
    background: '#1a0a06',
    stroke: ['#fbbf24', '#f97316', '#ef4444'],
  },
  {
    id: 'ink',
    name: 'Ink',
    background: '#f5f5f0',
    stroke: ['#1e293b', '#475569', '#0f172a'],
  },
  {
    id: 'mint',
    name: 'Mint',
    background: '#03140f',
    stroke: ['#5eead4', '#34d399', '#a3e635'],
  },
  {
    id: 'mono',
    name: 'Mono',
    background: '#0a0a0a',
    stroke: ['#f5f5f5', '#a3a3a3', '#f5f5f5'],
  },
]
