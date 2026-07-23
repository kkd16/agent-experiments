import type { Sketch } from './sketch'
import type { MotionProfile } from '../solver/kinematics'

// ---------------------------------------------------------------------------
// Export: turn a solved sketch into portable vector formats, and the motion
// profile into a spreadsheet-ready table. All pure string builders — no DOM, no
// dependency — so they are unit-testable and the caller wraps the result in a Blob.
//
//   • SVG — the exact drawing (cubic Béziers stay cubic, arcs stay arcs), y flipped
//     to screen convention, for the web / Illustrator / Figma.
//   • DXF — a minimal AC1015 (R2000) drawing with true LINE / CIRCLE / ARC entities
//     and de-Casteljau-sampled splines as LWPOLYLINEs; opens in any real CAD package.
//   • CSV — the driven mechanism's velocity/acceleration profile over a full sweep.
// ---------------------------------------------------------------------------

// Fixed-precision number, trimmed of trailing zeros, never in exponent form (some
// DXF/SVG readers choke on "1e-7"), and normalising -0 to 0.
function num(x: number, dp = 4): string {
  if (!Number.isFinite(x)) return '0'
  const s = x.toFixed(dp)
  const t = s.replace(/\.?0+$/, '')
  return t === '-0' || t === '' ? '0' : t
}

// Sample a cubic Bézier P0,C0,C1,P1 at n+1 points via the Bernstein basis.
function sampleCubic(
  p0: [number, number],
  c0: [number, number],
  c1: [number, number],
  p1: [number, number],
  n = 48,
): [number, number][] {
  const pts: [number, number][] = []
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    const b0 = u * u * u
    const b1 = 3 * u * u * t
    const b2 = 3 * u * t * t
    const b3 = t * t * t
    pts.push([
      b0 * p0[0] + b1 * c0[0] + b2 * c1[0] + b3 * p1[0],
      b0 * p0[1] + b1 * c0[1] + b2 * c1[1] + b3 * p1[1],
    ])
  }
  return pts
}

// --- SVG ------------------------------------------------------------------

export function sketchToSVG(sketch: Sketch, opts: { margin?: number } = {}): string {
  const margin = opts.margin ?? 12
  const bb = sketch.boundingBox()
  const w = Math.max(bb.maxX - bb.minX, 1)
  const h = Math.max(bb.maxY - bb.minY, 1)
  const pt = (id: number) => {
    const p = sketch.point(id)
    return [p.x, p.y] as [number, number]
  }
  const body: string[] = []
  const stroke = (construction?: boolean) =>
    construction
      ? 'stroke="#7a8aa0" stroke-width="0.6" stroke-dasharray="3 3" fill="none"'
      : 'stroke="#1c2530" stroke-width="1.2" fill="none"'

  for (const e of sketch.entities) {
    if (e.kind === 'line') {
      const a = pt(e.p1)
      const b = pt(e.p2)
      body.push(`<line x1="${num(a[0])}" y1="${num(a[1])}" x2="${num(b[0])}" y2="${num(b[1])}" ${stroke(e.construction)}/>`)
    } else if (e.kind === 'circle') {
      const c = pt(e.c)
      body.push(`<circle cx="${num(c[0])}" cy="${num(c[1])}" r="${num(e.r)}" ${stroke(e.construction)}/>`)
    } else if (e.kind === 'arc') {
      const g = sketch.arcGeom(e)
      const x0 = g.cx + g.r * Math.cos(g.a0)
      const y0 = g.cy + g.r * Math.sin(g.a0)
      const x1 = g.cx + g.r * Math.cos(g.a0 + g.sweep)
      const y1 = g.cy + g.r * Math.sin(g.a0 + g.sweep)
      const large = g.sweep > Math.PI ? 1 : 0
      // The whole drawing is y-flipped by the wrapping <g> transform, which reverses
      // orientation, so a CCW world arc needs sweep-flag 0 in the flipped frame.
      body.push(`<path d="M ${num(x0)} ${num(y0)} A ${num(g.r)} ${num(g.r)} 0 ${large} 0 ${num(x1)} ${num(y1)}" ${stroke(e.construction)}/>`)
    } else if (e.kind === 'spline') {
      const p0 = pt(e.p0)
      const c0 = pt(e.c0)
      const c1 = pt(e.c1)
      const p1 = pt(e.p1)
      body.push(
        `<path d="M ${num(p0[0])} ${num(p0[1])} C ${num(c0[0])} ${num(c0[1])}, ${num(c1[0])} ${num(c1[1])}, ${num(p1[0])} ${num(p1[1])}" ${stroke(e.construction)}/>`,
      )
    }
  }
  // Points as small dots (skip construction points to keep the drawing clean).
  for (const e of sketch.entities) {
    if (e.kind === 'point' && !e.construction) {
      body.push(`<circle cx="${num(e.x)}" cy="${num(e.y)}" r="1.6" fill="#1c2530" stroke="none"/>`)
    }
  }

  const vbw = w + 2 * margin
  const vbh = h + 2 * margin
  // Flip y (world is y-up, SVG is y-down) and shift the bounding box to the origin.
  const tx = margin - bb.minX
  const ty = margin + bb.maxY
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(vbw)} ${num(vbh)}" width="${num(vbw)}" height="${num(vbh)}">`,
    `<rect x="0" y="0" width="${num(vbw)}" height="${num(vbh)}" fill="#ffffff"/>`,
    `<g transform="translate(${num(tx)} ${num(ty)}) scale(1 -1)">`,
    ...body,
    `</g>`,
    `</svg>`,
    '',
  ].join('\n')
}

// --- DXF (AC1015 / R2000) --------------------------------------------------

function dxfPair(code: number, value: string | number): string {
  return `${code}\n${value}\n`
}

export function sketchToDXF(sketch: Sketch): string {
  const pt = (id: number) => {
    const p = sketch.point(id)
    return [p.x, p.y] as [number, number]
  }
  let out = ''
  out += dxfPair(0, 'SECTION') + dxfPair(2, 'HEADER')
  out += dxfPair(9, '$ACADVER') + dxfPair(1, 'AC1015')
  out += dxfPair(9, '$INSUNITS') + dxfPair(70, 4) // millimetres
  out += dxfPair(0, 'ENDSEC')
  out += dxfPair(0, 'SECTION') + dxfPair(2, 'ENTITIES')

  const line = (a: [number, number], b: [number, number]) => {
    out += dxfPair(0, 'LINE') + dxfPair(8, '0')
    out += dxfPair(10, num(a[0])) + dxfPair(20, num(a[1])) + dxfPair(30, 0)
    out += dxfPair(11, num(b[0])) + dxfPair(21, num(b[1])) + dxfPair(31, 0)
  }

  for (const e of sketch.entities) {
    if (e.kind === 'line') {
      line(pt(e.p1), pt(e.p2))
    } else if (e.kind === 'circle') {
      const c = pt(e.c)
      out += dxfPair(0, 'CIRCLE') + dxfPair(8, '0')
      out += dxfPair(10, num(c[0])) + dxfPair(20, num(c[1])) + dxfPair(30, 0) + dxfPair(40, num(e.r))
    } else if (e.kind === 'arc') {
      const g = sketch.arcGeom(e)
      const startDeg = (g.a0 * 180) / Math.PI
      const endDeg = ((g.a0 + g.sweep) * 180) / Math.PI
      // DXF arcs sweep counter-clockwise from start angle to end angle — exactly our
      // arcGeom convention.
      out += dxfPair(0, 'ARC') + dxfPair(8, '0')
      out += dxfPair(10, num(g.cx)) + dxfPair(20, num(g.cy)) + dxfPair(30, 0) + dxfPair(40, num(g.r))
      out += dxfPair(50, num(startDeg)) + dxfPair(51, num(endDeg))
    } else if (e.kind === 'spline') {
      const poly = sampleCubic(pt(e.p0), pt(e.c0), pt(e.c1), pt(e.p1))
      out += dxfPair(0, 'LWPOLYLINE') + dxfPair(8, '0')
      out += dxfPair(100, 'AcDbEntity') + dxfPair(100, 'AcDbPolyline')
      out += dxfPair(90, poly.length) + dxfPair(70, 0)
      for (const [x, y] of poly) out += dxfPair(10, num(x)) + dxfPair(20, num(y))
    }
  }
  out += dxfPair(0, 'ENDSEC')
  out += dxfPair(0, 'EOF')
  return out
}

// --- CSV (motion profile) --------------------------------------------------

export function motionProfileToCSV(profile: MotionProfile): string {
  const unit = profile.unit === 'rad' ? 'theta_rad' : 'theta_len'
  const rows = [`${unit},speed,accel,vx,vy`]
  for (const s of profile.samples) {
    rows.push(`${num(s.theta, 6)},${num(s.speed, 6)},${num(s.accel, 6)},${num(s.vx, 6)},${num(s.vy, 6)}`)
  }
  return rows.join('\n') + '\n'
}
