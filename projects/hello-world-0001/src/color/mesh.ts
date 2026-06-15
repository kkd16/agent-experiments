// Mesh gradients — the thing CSS can't do. Each control point has a position and a color; every
// pixel is an inverse-distance-weighted blend of the points. We blend in Oklab (not sRGB) so the
// field stays perceptually smooth and never develops grey saddles between colored points.

import { oklabToRgb, rgbToOklab } from './convert'
import type { OkLab, RGBA } from './types'

export interface MeshPoint {
  id: string
  x: number // 0..1
  y: number // 0..1
  color: RGBA
}

/** Render the mesh into a canvas context at native (w,h) resolution. */
export function renderMesh(points: MeshPoint[], ctx: CanvasRenderingContext2D, w: number, h: number, power = 2): void {
  const img = ctx.createImageData(w, h)
  const data = img.data
  if (points.length === 0) {
    ctx.putImageData(img, 0, 0)
    return
  }
  const labs: OkLab[] = points.map((p) => rgbToOklab(p.color))
  const alphas: number[] = points.map((p) => p.color.a)
  const px = points.map((p) => p.x * w)
  const py = points.map((p) => p.y * h)
  const eps = 1e-6

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let wSum = 0
      let L = 0
      let aa = 0
      let bb = 0
      let alpha = 0
      let snapped = -1
      for (let i = 0; i < points.length; i++) {
        const dx = x - px[i]
        const dy = y - py[i]
        const d2 = dx * dx + dy * dy
        if (d2 < 1) {
          snapped = i
          break
        }
        const wgt = 1 / Math.pow(d2, power / 2 + eps)
        wSum += wgt
        L += labs[i].L * wgt
        aa += labs[i].a * wgt
        bb += labs[i].b * wgt
        alpha += alphas[i] * wgt
      }
      let rgb
      let al
      if (snapped >= 0) {
        rgb = points[snapped].color
        al = points[snapped].color.a
      } else {
        rgb = oklabToRgb({ L: L / wSum, a: aa / wSum, b: bb / wSum })
        al = alpha / wSum
      }
      const o = (y * w + x) * 4
      data[o] = clampByte(rgb.r * 255)
      data[o + 1] = clampByte(rgb.g * 255)
      data[o + 2] = clampByte(rgb.b * 255)
      data[o + 3] = clampByte(al * 255)
    }
  }
  ctx.putImageData(img, 0, 0)
}

const clampByte = (x: number) => (x < 0 ? 0 : x > 255 ? 255 : Math.round(x))
