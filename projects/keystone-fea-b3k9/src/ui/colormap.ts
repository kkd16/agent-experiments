// Colour ramps for stress fields and member forces.

export type RGB = [number, number, number]

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function ramp(stops: [number, RGB][], t: number): RGB {
  const x = Math.max(0, Math.min(1, t))
  for (let i = 0; i < stops.length - 1; i++) {
    const [x0, c0] = stops[i]
    const [x1, c1] = stops[i + 1]
    if (x >= x0 && x <= x1) {
      const f = (x - x0) / (x1 - x0 || 1)
      return [lerp(c0[0], c1[0], f), lerp(c0[1], c1[1], f), lerp(c0[2], c1[2], f)]
    }
  }
  return stops[stops.length - 1][1]
}

// A perceptually-ordered "turbo"-like sequential map (dark blue → cyan → green
// → yellow → red) for magnitude fields such as von Mises stress.
const TURBO: [number, RGB][] = [
  [0.0, [48, 18, 89]],
  [0.13, [50, 90, 189]],
  [0.28, [30, 160, 210]],
  [0.43, [40, 200, 150]],
  [0.58, [150, 220, 60]],
  [0.72, [240, 200, 40]],
  [0.86, [240, 120, 30]],
  [1.0, [180, 30, 30]],
]

// A diverging blue↔red map for signed quantities (compression ↔ tension).
const DIVERGING: [number, RGB][] = [
  [0.0, [40, 110, 220]], // compression (blue)
  [0.5, [225, 228, 235]], // ~zero (near white)
  [1.0, [220, 55, 55]], // tension (red)
]

export type Colormap = 'turbo' | 'viridis' | 'grayscale'

const VIRIDIS: [number, RGB][] = [
  [0.0, [68, 1, 84]],
  [0.25, [59, 82, 139]],
  [0.5, [33, 145, 140]],
  [0.75, [94, 201, 98]],
  [1.0, [253, 231, 37]],
]

const GRAY: [number, RGB][] = [
  [0.0, [30, 33, 40]],
  [1.0, [235, 238, 245]],
]

export function fieldColor(t: number, map: Colormap = 'turbo'): RGB {
  switch (map) {
    case 'viridis':
      return ramp(VIRIDIS, t)
    case 'grayscale':
      return ramp(GRAY, t)
    default:
      return ramp(TURBO, t)
  }
}

/** Signed value in [-1, 1] → diverging colour (compression negative, tension positive). */
export function signedColor(t: number): RGB {
  return ramp(DIVERGING, (Math.max(-1, Math.min(1, t)) + 1) / 2)
}

export function rgbStr(c: RGB, alpha = 1): string {
  return `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${alpha})`
}

export const COLORMAP_STOPS: Record<Colormap, [number, RGB][]> = {
  turbo: TURBO,
  viridis: VIRIDIS,
  grayscale: GRAY,
}
