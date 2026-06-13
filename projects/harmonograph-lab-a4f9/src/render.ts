import type { Point } from './harmonograph'
import type { Theme } from './themes'

// Map a normalised point (-1..1) into pixel space with padding.
function project(pt: Point, size: number, pad: number) {
  const usable = size - pad * 2
  return {
    x: pad + (pt.x + 0.5) * usable,
    y: pad + (pt.y + 0.5) * usable,
  }
}

// Interpolate the three theme stops across the curve so the stroke shifts hue
// as it winds inward.
function colorAt(theme: Theme, frac: number): string {
  const [a, b, c] = theme.stroke
  return frac < 0.5 ? lerpHex(a, b, frac * 2) : lerpHex(b, c, (frac - 0.5) * 2)
}

function lerpHex(a: string, b: string, t: number): string {
  const pa = hexToRgb(a)
  const pb = hexToRgb(b)
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t)
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t)
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t)
  return `rgb(${r}, ${g}, ${bl})`
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

export function drawCanvas(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  theme: Theme,
  size: number,
  lineWidth: number,
) {
  const pad = size * 0.08
  ctx.clearRect(0, 0, size, size)
  ctx.fillStyle = theme.background
  ctx.fillRect(0, 0, size, size)
  ctx.lineWidth = lineWidth
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  // Draw in short colored segments so the gradient follows the path.
  const segments = 64
  const per = Math.ceil(points.length / segments)
  for (let s = 0; s < segments; s++) {
    const start = s * per
    const end = Math.min(start + per + 1, points.length)
    if (end - start < 2) continue
    ctx.strokeStyle = colorAt(theme, s / segments)
    ctx.beginPath()
    const first = project(points[start], size, pad)
    ctx.moveTo(first.x, first.y)
    for (let i = start + 1; i < end; i++) {
      const p = project(points[i], size, pad)
      ctx.lineTo(p.x, p.y)
    }
    ctx.stroke()
  }
}

export function toSvg(
  points: Point[],
  theme: Theme,
  size: number,
  lineWidth: number,
): string {
  const pad = size * 0.08
  const segments = 64
  const per = Math.ceil(points.length / segments)
  const paths: string[] = []
  for (let s = 0; s < segments; s++) {
    const start = s * per
    const end = Math.min(start + per + 1, points.length)
    if (end - start < 2) continue
    let d = ''
    for (let i = start; i < end; i++) {
      const p = project(points[i], size, pad)
      d += `${i === start ? 'M' : 'L'}${p.x.toFixed(2)} ${p.y.toFixed(2)} `
    }
    paths.push(
      `<path d="${d.trim()}" fill="none" stroke="${colorAt(theme, s / segments)}" stroke-width="${lineWidth}" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect width="${size}" height="${size}" fill="${theme.background}"/>
${paths.join('\n')}
</svg>`
}
