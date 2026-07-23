// A compact "inferno"-flavoured colour ramp for density fields, plus the
// accent palette shared with the CSS. Interpolation is in sRGB — perceptually
// imperfect but more than good enough for a glowing heatmap.

type RGB = [number, number, number]

const STOPS: { t: number; c: RGB }[] = [
  { t: 0.0, c: [8, 10, 22] },
  { t: 0.18, c: [37, 21, 75] },
  { t: 0.38, c: [104, 26, 122] },
  { t: 0.58, c: [181, 43, 96] },
  { t: 0.76, c: [237, 104, 60] },
  { t: 0.9, c: [251, 179, 74] },
  { t: 1.0, c: [252, 238, 173] },
]

/** Map t ∈ [0,1] to an [r,g,b] triple on the inferno-ish ramp. */
export function inferno(t: number): RGB {
  const x = Math.max(0, Math.min(1, t))
  for (let i = 1; i < STOPS.length; i++) {
    if (x <= STOPS[i].t) {
      const a = STOPS[i - 1]
      const b = STOPS[i]
      const f = (x - a.t) / (b.t - a.t || 1)
      return [
        Math.round(a.c[0] + (b.c[0] - a.c[0]) * f),
        Math.round(a.c[1] + (b.c[1] - a.c[1]) * f),
        Math.round(a.c[2] + (b.c[2] - a.c[2]) * f),
      ]
    }
  }
  return STOPS[STOPS.length - 1].c
}

export const ACCENT = '#6ea8ff'
export const ACCENT_WARM = '#ffb54a'
export const ACCENT_HOT = '#ff5d7e'
export const INK = '#e8ecf4'
export const MUTED = '#8792a8'
