import type { Vec3 } from './vector3'
import { mulberry32 } from './random'

// Seeded 3-D point-cloud generators for the Space axis — the spatial analogue of
// `random.ts`. Every preset returns points in roughly the [-1,1]³ cube so the camera
// framing is stable across presets.

export type Cloud3Kind = 'ball' | 'sphere' | 'gauss' | 'cube' | 'torus' | 'spiral' | 'clusters'

export interface Cloud3Preset {
  id: Cloud3Kind
  label: string
}

export const CLOUD3_PRESETS: Cloud3Preset[] = [
  { id: 'ball', label: 'Ball' },
  { id: 'sphere', label: 'Sphere' },
  { id: 'gauss', label: 'Gaussian' },
  { id: 'cube', label: 'Cube' },
  { id: 'torus', label: 'Torus' },
  { id: 'spiral', label: 'Spiral' },
  { id: 'clusters', label: 'Clusters' },
]

/** Approximate unit normal via the central limit theorem (sum of 6 uniforms). */
function gaussian(rng: () => number): number {
  let s = 0
  for (let i = 0; i < 6; i++) s += rng()
  return (s - 3) / 1.2
}

export function makeCloud3(kind: Cloud3Kind, n: number, seed: number): Vec3[] {
  const rng = mulberry32(seed * 2654435761 + 12345)
  const pts: Vec3[] = []

  if (kind === 'ball') {
    while (pts.length < n) {
      const x = rng() * 2 - 1, y = rng() * 2 - 1, z = rng() * 2 - 1
      if (x * x + y * y + z * z <= 1) pts.push({ x, y, z })
    }
  } else if (kind === 'sphere') {
    // Fibonacci sphere — every point is an extreme point (all hull vertices).
    const golden = Math.PI * (3 - Math.sqrt(5))
    for (let i = 0; i < n; i++) {
      const y = 1 - (i + 0.5) / n * 2
      const r = Math.sqrt(Math.max(0, 1 - y * y))
      const th = i * golden
      // A whisper of jitter breaks exact cocircularity without denting the sphere.
      const j = 1 + (rng() - 0.5) * 0.01
      pts.push({ x: Math.cos(th) * r * j, y: y * j, z: Math.sin(th) * r * j })
    }
  } else if (kind === 'gauss') {
    for (let i = 0; i < n; i++) pts.push({ x: gaussian(rng), y: gaussian(rng), z: gaussian(rng) })
  } else if (kind === 'cube') {
    for (let i = 0; i < n; i++) pts.push({ x: rng() * 2 - 1, y: rng() * 2 - 1, z: rng() * 2 - 1 })
  } else if (kind === 'torus') {
    const R = 0.68, r = 0.28
    for (let i = 0; i < n; i++) {
      const u = rng() * Math.PI * 2
      const v = rng() * Math.PI * 2
      const jr = r * (0.85 + rng() * 0.3)
      pts.push({
        x: (R + jr * Math.cos(v)) * Math.cos(u),
        y: jr * Math.sin(v),
        z: (R + jr * Math.cos(v)) * Math.sin(u),
      })
    }
  } else if (kind === 'spiral') {
    const turns = 3.5
    for (let i = 0; i < n; i++) {
      const t = i / Math.max(1, n - 1)
      const a = t * Math.PI * 2 * turns
      const rad = 0.25 + 0.7 * t
      const jit = () => (rng() - 0.5) * 0.06
      pts.push({ x: Math.cos(a) * rad + jit(), y: (t - 0.5) * 1.7 + jit(), z: Math.sin(a) * rad + jit() })
    }
  } else {
    // clusters — a few gaussian blobs, nice for a chunky Voronoi foam.
    const k = 3 + Math.floor(rng() * 3)
    const centers: Vec3[] = []
    for (let c = 0; c < k; c++) centers.push({ x: rng() * 1.4 - 0.7, y: rng() * 1.4 - 0.7, z: rng() * 1.4 - 0.7 })
    for (let i = 0; i < n; i++) {
      const c = centers[i % k]
      pts.push({ x: c.x + gaussian(rng) * 0.28, y: c.y + gaussian(rng) * 0.28, z: c.z + gaussian(rng) * 0.28 })
    }
  }
  return pts
}
