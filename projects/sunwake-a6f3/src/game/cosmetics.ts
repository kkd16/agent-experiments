export type TrailId = 'sunlight' | 'seafoam' | 'violet' | 'aurora' | 'stardust'
export const TRAILS: {
  id: TrailId
  name: string
  color: string
  accent: string
  seals: number
}[] = [
  {
    id: 'sunlight',
    name: 'Sunlight',
    color: '#ffe3a2',
    accent: '#fff2c6',
    seals: 0,
  },
  {
    id: 'seafoam',
    name: 'Seafoam',
    color: '#83e3cb',
    accent: '#dcffe9',
    seals: 3,
  },
  {
    id: 'violet',
    name: 'Wild violet',
    color: '#c0a0ef',
    accent: '#f0dcff',
    seals: 6,
  },
  {
    id: 'aurora',
    name: 'Aurora',
    color: '#8cdbef',
    accent: '#b7f4ca',
    seals: 12,
  },
  {
    id: 'stardust',
    name: 'Stardust',
    color: '#ffe8ce',
    accent: '#ffffff',
    seals: 18,
  },
]
export const trailById = (id: unknown) =>
  TRAILS.find((trail) => trail.id === id) ?? TRAILS[0]
