// The same two-or-more stops, interpolated through every working space at once. This is the
// app's thesis made visible: pick sRGB and the middle of a blue→yellow ramp goes grey; pick Oklab
// or Oklch and it stays luminous. Click a strip to adopt that space.

import { rgbaToCss } from '../color/convert'
import { ramp } from '../color/interpolate'
import { SPACE_LABELS } from '../color/types'
import type { Gradient, InterpSpace } from '../color/types'

const ORDER: InterpSpace[] = ['srgb', 'linear', 'oklab', 'oklch', 'lab', 'lch', 'hsl']

function stripCss(g: Gradient, space: InterpSpace): string {
  const cols = ramp({ ...g, space }, 32)
  const stops = cols.map((c, i) => `${rgbaToCss(c)} ${(i / (cols.length - 1)) * 100}%`).join(', ')
  return `linear-gradient(90deg, ${stops})`
}

export function ComparisonStrip({
  gradient,
  onPick,
}: {
  gradient: Gradient
  onPick: (s: InterpSpace) => void
}) {
  return (
    <div className="compare">
      {ORDER.map((space) => (
        <button
          key={space}
          className={`compare-row${space === gradient.space ? ' is-active' : ''}`}
          onClick={() => onPick(space)}
          title={`Interpolate in ${SPACE_LABELS[space]}`}
        >
          <span className="compare-label">{SPACE_LABELS[space]}</span>
          <span className="compare-bar" style={{ background: stripCss(gradient, space) }} />
        </button>
      ))}
    </div>
  )
}
