import type { Point } from '../geometry/types'

// Voronoi cell coloring. Each scheme is a color ramp plus a function mapping a
// site's position to a parameter t ∈ [0,1] along that ramp, so colors flow
// smoothly across the plane rather than flickering per cell.

type RGB = [number, number, number]
type Ramp = RGB[]

export interface Scheme {
  id: string
  label: string
  ramp: Ramp
  value: (p: Point) => number // p in normalized [0,1] space → t ∈ [0,1]
}

const diagonal = (p: Point) => Math.min(1, Math.max(0, p.x * 0.55 + p.y * 0.45))
const radial = (p: Point) => Math.min(1, Math.hypot(p.x - 0.5, p.y - 0.5) * 1.6)

export const SCHEMES: Scheme[] = [
  {
    id: 'aurora',
    label: 'Aurora',
    ramp: [
      [34, 197, 130],
      [16, 185, 199],
      [56, 132, 240],
      [140, 92, 246],
    ],
    value: diagonal,
  },
  {
    id: 'sunset',
    label: 'Sunset',
    ramp: [
      [62, 28, 92],
      [196, 48, 122],
      [244, 114, 64],
      [251, 210, 110],
    ],
    value: diagonal,
  },
  {
    id: 'ocean',
    label: 'Ocean',
    ramp: [
      [12, 34, 76],
      [18, 90, 140],
      [38, 166, 184],
      [173, 232, 224],
    ],
    value: radial,
  },
  {
    id: 'ember',
    label: 'Ember',
    ramp: [
      [24, 12, 18],
      [120, 26, 38],
      [228, 92, 36],
      [248, 200, 84],
    ],
    value: radial,
  },
  {
    id: 'slate',
    label: 'Mono',
    ramp: [
      [38, 48, 66],
      [78, 96, 124],
      [138, 158, 186],
      [206, 220, 236],
    ],
    value: diagonal,
  },
]

function sampleRamp(ramp: Ramp, t: number): RGB {
  const clamped = Math.min(1, Math.max(0, t))
  const span = ramp.length - 1
  const x = clamped * span
  const i = Math.min(span - 1, Math.floor(x))
  const f = x - i
  const a = ramp[i]
  const b = ramp[i + 1]
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ]
}

export function cellFill(scheme: Scheme, site: Point, alpha = 1): string {
  const [r, g, b] = sampleRamp(scheme.ramp, scheme.value(site))
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function getScheme(id: string): Scheme {
  return SCHEMES.find((s) => s.id === id) ?? SCHEMES[0]
}
