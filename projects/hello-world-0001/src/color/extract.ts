// Extract a palette from an image by k-means clustering its pixels in Oklab (so "near" means
// perceptually near, not RGB-cube near). k-means++ seeding keeps the result stable and spread out.

import { oklabToRgb, rgbToOklab } from './convert'
import { makeRng } from './random'
import type { OkLab, RGBA } from './types'

/** Pull up to `maxSamples` pixels (as Oklab points) out of ImageData, skipping near-transparent. */
function sampleLab(img: ImageData, maxSamples = 4000): OkLab[] {
  const { data, width, height } = img
  const total = width * height
  const stride = Math.max(1, Math.floor(total / maxSamples))
  const pts: OkLab[] = []
  for (let i = 0; i < total; i += stride) {
    const o = i * 4
    if (data[o + 3] < 32) continue
    pts.push(rgbToOklab({ r: data[o] / 255, g: data[o + 1] / 255, b: data[o + 2] / 255 }))
  }
  return pts
}

function dist2(a: OkLab, b: OkLab): number {
  const dL = a.L - b.L
  const da = a.a - b.a
  const db = a.b - b.b
  return dL * dL + da * da + db * db
}

/** Returns up to `k` dominant colors, brightest-spread first. */
export function extractPalette(img: ImageData, k = 5, seed = 1): RGBA[] {
  const pts = sampleLab(img)
  if (pts.length === 0) return []
  const rng = makeRng(seed)
  k = Math.min(k, pts.length)

  // k-means++ seeding
  const centers: OkLab[] = [pts[Math.floor(rng() * pts.length)]]
  while (centers.length < k) {
    const d2 = pts.map((p) => Math.min(...centers.map((c) => dist2(p, c))))
    const sum = d2.reduce((a, b) => a + b, 0)
    let r = rng() * sum
    let idx = 0
    for (; idx < d2.length; idx++) {
      r -= d2[idx]
      if (r <= 0) break
    }
    centers.push(pts[Math.min(idx, pts.length - 1)])
  }

  // Lloyd iterations
  const assign = new Array(pts.length).fill(0)
  for (let iter = 0; iter < 12; iter++) {
    let moved = false
    for (let i = 0; i < pts.length; i++) {
      let best = 0
      let bestD = Infinity
      for (let c = 0; c < centers.length; c++) {
        const d = dist2(pts[i], centers[c])
        if (d < bestD) {
          bestD = d
          best = c
        }
      }
      if (assign[i] !== best) {
        assign[i] = best
        moved = true
      }
    }
    const sumL = new Array(k).fill(0)
    const sumA = new Array(k).fill(0)
    const sumB = new Array(k).fill(0)
    const count = new Array(k).fill(0)
    for (let i = 0; i < pts.length; i++) {
      const c = assign[i]
      sumL[c] += pts[i].L
      sumA[c] += pts[i].a
      sumB[c] += pts[i].b
      count[c] += 1
    }
    for (let c = 0; c < k; c++) {
      if (count[c] > 0) centers[c] = { L: sumL[c] / count[c], a: sumA[c] / count[c], b: sumB[c] / count[c] }
    }
    if (!moved && iter > 0) break
  }

  // order clusters by population (most dominant first)
  const pop = new Array(k).fill(0)
  for (const c of assign) pop[c] += 1
  const order = centers.map((_, i) => i).sort((x, y) => pop[y] - pop[x])
  return order
    .filter((i) => pop[i] > 0)
    .map((i) => ({ ...clamp01Rgb(oklabToRgb(centers[i])), a: 1 }))
}

function clamp01Rgb(c: { r: number; g: number; b: number }) {
  const cl = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
  return { r: cl(c.r), g: cl(c.g), b: cl(c.b) }
}
