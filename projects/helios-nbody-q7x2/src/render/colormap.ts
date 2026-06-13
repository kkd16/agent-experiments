// Perceptual colour maps, evaluated from polynomial approximations so we do not
// need to ship lookup tables. Each returns [r, g, b] in 0..255.

export type ColorMapId = 'inferno' | 'viridis' | 'plasma' | 'ice'

type RGB = [number, number, number]

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0
}

// Polynomial fits to the matplotlib maps (good to a few % over [0,1]).
function inferno(t: number): RGB {
  const r = 255 * (-0.0002 + 0.149 * t + 4.13 * t * t - 7.0 * t * t * t + 3.84 * t * t * t * t)
  const g = 255 * (0.012 - 0.39 * t + 2.31 * t * t - 1.9 * t * t * t + 0.97 * t * t * t * t)
  const b = 255 * (0.013 + 2.0 * t - 6.7 * t * t + 8.2 * t * t * t - 3.45 * t * t * t * t)
  return [clamp255(r), clamp255(g), clamp255(b)]
}

function viridis(t: number): RGB {
  const r = 255 * (0.28 - 0.33 * t + 0.9 * t * t - 0.2 * t * t * t)
  const g = 255 * (0.0 + 0.78 * t + 0.2 * t * t)
  const b = 255 * (0.33 + 0.86 * t - 2.2 * t * t + 1.1 * t * t * t)
  return [clamp255(r), clamp255(g), clamp255(b)]
}

function plasma(t: number): RGB {
  const r = 255 * (0.05 + 1.6 * t - 0.7 * t * t)
  const g = 255 * (0.03 - 0.2 * t + 1.1 * t * t)
  const b = 255 * (0.53 + 0.9 * t - 2.6 * t * t + 1.3 * t * t * t)
  return [clamp255(r), clamp255(g), clamp255(b)]
}

function ice(t: number): RGB {
  const r = 255 * (0.0 + 0.35 * t + 0.6 * t * t)
  const g = 255 * (0.02 + 0.55 * t + 0.4 * t * t)
  const b = 255 * (0.1 + 1.4 * t - 0.5 * t * t)
  return [clamp255(r), clamp255(g), clamp255(b)]
}

const MAPS: Record<ColorMapId, (t: number) => RGB> = { inferno, viridis, plasma, ice }

export const COLORMAP_IDS: ColorMapId[] = ['inferno', 'viridis', 'plasma', 'ice']

/** Sample a colour map at t ∈ [0, 1]. */
export function sampleColorMap(id: ColorMapId, t: number): RGB {
  const tt = t < 0 ? 0 : t > 1 ? 1 : t
  return MAPS[id](tt)
}
