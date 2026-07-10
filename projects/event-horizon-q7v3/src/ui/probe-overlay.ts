// 2-D overlay drawing for the photon probe. The traced geodesic lives in world space; this module
// re-projects it onto the render each frame with the *live* camera, so once you've clicked a pixel
// you can orbit around the frozen photon path and watch it bend in three dimensions. The projection
// is the exact inverse of the fragment shader's camera model (orbit basis + fov + aspect), so the
// overlaid curve lands precisely on the pixels it describes.

import type { ProbeResult } from '../physics/probe'
import type { Vec3 } from '../math/vec'
import { dot, sub } from '../math/vec'

export interface ProbeCamera {
  eye: Vec3
  right: Vec3
  up: Vec3
  forward: Vec3
  tanHalf: number
  aspect: number
  /** Overlay canvas size in device pixels. */
  w: number
  h: number
}

interface Projected {
  x: number
  y: number
  cz: number
  visible: boolean
}

/** Project a world point to device-pixel coordinates on the overlay canvas. */
function project(p: Vec3, cam: ProbeCamera): Projected {
  const rel = sub(p, cam.eye)
  const cz = dot(rel, cam.forward)
  if (cz <= 1e-3) return { x: 0, y: 0, cz, visible: false }
  const uvx = dot(rel, cam.right) / cz / cam.tanHalf // = shader uv.x (carries aspect)
  const uvy = dot(rel, cam.up) / cz / cam.tanHalf // = shader uv.y
  const fx = (uvx / cam.aspect + 1) / 2
  const fy = (uvy + 1) / 2
  return { x: fx * cam.w, y: (1 - fy) * cam.h, cz, visible: true }
}

// Warm near the hole (deep gravitational well), cool far away — a legible stand-in for the
// gravitational potential along the ray.
function potentialColor(p: Vec3): string {
  const r = Math.hypot(p[0], p[1], p[2])
  const t = Math.min(Math.max((r - 1) / 10, 0), 1)
  const hot = [255, 120, 60]
  const cool = [120, 190, 255]
  const c = hot.map((h, i) => Math.round(h + (cool[i] - h) * t))
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}

function marker(ctx: CanvasRenderingContext2D, pr: Projected, radius: number, stroke: string, fill: string | null, dpr: number) {
  // Dark backing ring so the marker reads over the bright disk as well as the black shadow.
  ctx.beginPath()
  ctx.arc(pr.x, pr.y, radius + 1.4 * dpr, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)'
  ctx.lineWidth = 3.2 * dpr
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(pr.x, pr.y, radius, 0, Math.PI * 2)
  if (fill) {
    ctx.fillStyle = fill
    ctx.fill()
  }
  ctx.lineWidth = 2 * dpr
  ctx.strokeStyle = stroke
  ctx.stroke()
}

/** Draw the probe's trajectory + markers. `dpr` scales line widths / fonts to device pixels. */
export function drawProbe(ctx: CanvasRenderingContext2D, res: ProbeResult, cam: ProbeCamera, dpr: number): void {
  ctx.clearRect(0, 0, cam.w, cam.h)
  const pts = res.path.map((p) => ({ world: p, pj: project(p, cam) }))

  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // Pass 1 — a dark casing under the whole path, so the curve stays visible where it crosses the
  // blown-out disk (a plain additive stroke would vanish against white).
  ctx.beginPath()
  let penDown = false
  for (let i = 0; i < pts.length; i++) {
    const pj = pts[i].pj
    if (!pj.visible) {
      penDown = false
      continue
    }
    if (!penDown) {
      ctx.moveTo(pj.x, pj.y)
      penDown = true
    } else {
      ctx.lineTo(pj.x, pj.y)
    }
  }
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)'
  ctx.lineWidth = 4.6 * dpr
  ctx.stroke()

  // Pass 2 — the coloured core, graded by gravitational potential, with a soft glow.
  ctx.save()
  ctx.shadowBlur = 5 * dpr
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    if (!a.pj.visible || !b.pj.visible) continue
    const col = potentialColor(b.world)
    ctx.beginPath()
    ctx.moveTo(a.pj.x, a.pj.y)
    ctx.lineTo(b.pj.x, b.pj.y)
    ctx.strokeStyle = col
    ctx.shadowColor = col
    ctx.lineWidth = 2.2 * dpr
    ctx.stroke()
  }
  ctx.restore()

  // Markers.
  const start = project(res.path[0], cam)
  if (start.visible) marker(ctx, start, 4 * dpr, '#e8ecf6', '#0c0f18', dpr) // camera

  const rmin = project(res.rMinPoint, cam)
  if (rmin.visible) marker(ctx, rmin, 5 * dpr, '#ffd27a', null, dpr) // closest approach

  if (res.diskHitPoint) {
    const dh = project(res.diskHitPoint, cam)
    if (dh.visible) marker(ctx, dh, 4 * dpr, '#ff7a46', '#ff7a46', dpr)
  }

  const end = pts[pts.length - 1]?.pj
  if (end?.visible) {
    if (res.fate === 'captured') {
      // a dark-cased ✕ where it crosses the horizon
      const s = 5 * dpr
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)'
      ctx.lineWidth = 4.2 * dpr
      ctx.beginPath()
      ctx.moveTo(end.x - s, end.y - s)
      ctx.lineTo(end.x + s, end.y + s)
      ctx.moveTo(end.x + s, end.y - s)
      ctx.lineTo(end.x - s, end.y + s)
      ctx.stroke()
      ctx.strokeStyle = '#ff5a5a'
      ctx.lineWidth = 2.2 * dpr
      ctx.beginPath()
      ctx.moveTo(end.x - s, end.y - s)
      ctx.lineTo(end.x + s, end.y + s)
      ctx.moveTo(end.x + s, end.y - s)
      ctx.lineTo(end.x - s, end.y + s)
      ctx.stroke()
    } else {
      marker(ctx, end, 4 * dpr, '#8fd0ff', null, dpr) // escapes toward the sky
    }
  }
}
