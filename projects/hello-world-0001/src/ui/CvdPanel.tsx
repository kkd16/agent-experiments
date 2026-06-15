// How the gradient reads to viewers with color-vision deficiencies. We re-map every sampled color
// through the CVD simulation and show the resulting ramp next to "normal", so you can catch a
// red→green gradient that collapses into a single muddy band for ~8% of men.

import { useState } from 'react'
import { rgbaToCss } from '../color/convert'
import { ramp } from '../color/interpolate'
import { CVD_LABELS, simulateCvd } from '../color/cvd'
import type { CvdType } from '../color/cvd'
import type { Gradient } from '../color/types'

const TYPES: CvdType[] = ['normal', 'protan', 'deutan', 'tritan']

function cvdCss(g: Gradient, type: CvdType, severity: number): string {
  const cols = ramp(g, 32).map((c) => ({ ...simulateCvd(c, type, severity), a: c.a }))
  const stops = cols.map((c, i) => `${rgbaToCss(c)} ${(i / (cols.length - 1)) * 100}%`).join(', ')
  return `linear-gradient(90deg, ${stops})`
}

export function CvdPanel({ gradient }: { gradient: Gradient }) {
  const [severity, setSeverity] = useState(1)
  return (
    <div className="cvd">
      {TYPES.map((type) => (
        <div className="cvd-row" key={type}>
          <span className="cvd-name">{CVD_LABELS[type].split(' (')[0]}</span>
          <span className="cvd-bar" style={{ background: cvdCss(gradient, type, severity) }} />
        </div>
      ))}
      <label className="cvd-severity">
        <span>Severity</span>
        <input type="range" min={0} max={1} step={0.01} value={severity} onChange={(e) => setSeverity(Number(e.target.value))} />
        <b>{Math.round(severity * 100)}%</b>
      </label>
    </div>
  )
}
