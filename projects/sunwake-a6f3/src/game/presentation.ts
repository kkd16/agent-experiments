import { terrain } from './engine.ts'

export type DisplayDetail = 'auto' | 'sharp' | 'light'
export type MotionPreference = 'system' | 'reduced' | 'full'

/** Keep large/retina canvases within a sensible pixel budget without capping FPS. */
export function displayScale(
  width: number,
  height: number,
  deviceScale: number,
  detail: DisplayDetail,
): number {
  const native = Math.min(2, Math.max(1, deviceScale || 1))
  if (detail === 'sharp') return native
  if (detail === 'light') return 1
  return Math.min(native, Math.sqrt(2_000_000 / Math.max(1, width * height)))
}

const SPACING = 4
const CAPACITY = 4096

/** Render-only terrain samples. Physics always evaluates the exact terrain. */
export class TerrainSamples {
  private seed = NaN
  private heights = new Float64Array(CAPACITY)
  private indices = new Float64Array(CAPACITY).fill(NaN)

  height(x: number, seed: number): number {
    if (seed !== this.seed) {
      this.seed = seed
      this.indices.fill(NaN)
    }
    const index = Math.floor(x / SPACING)
    const a = this.sample(index)
    const b = this.sample(index + 1)
    return a + (b - a) * (x / SPACING - index)
  }

  private sample(index: number): number {
    const slot = ((index % CAPACITY) + CAPACITY) % CAPACITY
    if (this.indices[slot] !== index) {
      this.indices[slot] = index
      this.heights[slot] = terrain(index * SPACING, this.seed)
    }
    return this.heights[slot]
  }
}
