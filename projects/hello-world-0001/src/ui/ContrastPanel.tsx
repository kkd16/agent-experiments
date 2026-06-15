// Contrast between consecutive stops — both the WCAG 2.1 ratio (the AA/AAA standard) and an
// APCA-style Lc (the perceptual model). Useful when a gradient is the background behind text, or
// when you want adjacent stops to read as distinct bands.

import { rgbaToCss, round } from '../color/convert'
import { apcaLc, apcaRating, contrastRatio, wcagLevel } from '../color/contrast'
import { sortedStops } from '../color/interpolate'
import type { Gradient } from '../color/types'

export function ContrastPanel({ gradient }: { gradient: Gradient }) {
  const stops = sortedStops(gradient.stops)
  const pairs = stops.slice(0, -1).map((s, i) => ({ a: s, b: stops[i + 1] }))
  return (
    <div className="contrast">
      {pairs.map(({ a, b }, i) => {
        const ratio = contrastRatio(a.color, b.color)
        const level = wcagLevel(ratio)
        const lc = apcaLc(b.color, a.color)
        return (
          <div className="contrast-row" key={i}>
            <span className="contrast-pair">
              <span className="dot" style={{ background: rgbaToCss(a.color) }} />
              <span className="dot" style={{ background: rgbaToCss(b.color) }} />
            </span>
            <span className="contrast-nums">
              <b>{round(ratio, 2)}:1</b>
              <span className={`badge badge-${level === 'Fail' ? 'bad' : level === 'AAA' ? 'good' : 'ok'}`}>{level}</span>
            </span>
            <span className="contrast-apca" title={apcaRating(lc)}>
              APCA Lc {round(Math.abs(lc), 0)}
            </span>
          </div>
        )
      })}
      {pairs.length === 0 && <p className="muted">Add a second stop to compare contrast.</p>}
    </div>
  )
}
