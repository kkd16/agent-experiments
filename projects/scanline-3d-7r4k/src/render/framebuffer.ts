// The render target: a packed 32-bit colour buffer (ABGR in memory, which is the
// byte order an ImageData expects on little-endian machines), a Float32 depth
// buffer, and an overdraw counter used by the debug heatmap.
import { clamp01 } from '../math/scalar.ts'
import type { Vec3 } from '../math/vec.ts'

export class Framebuffer {
  readonly width: number
  readonly height: number
  readonly color: Uint32Array
  readonly depth: Float32Array
  readonly overdraw: Uint16Array
  private image: ImageData | null = null
  private view: Uint32Array | null = null

  constructor(width: number, height: number) {
    this.width = Math.max(1, width | 0)
    this.height = Math.max(1, height | 0)
    const n = this.width * this.height
    this.color = new Uint32Array(n)
    this.depth = new Float32Array(n)
    this.overdraw = new Uint16Array(n)
  }

  // Pack 0..1 linear-ish rgb (already gamma-encoded by the caller) into ABGR.
  static pack(r: number, g: number, b: number, a = 255): number {
    const R = (clamp01(r) * 255 + 0.5) | 0
    const G = (clamp01(g) * 255 + 0.5) | 0
    const B = (clamp01(b) * 255 + 0.5) | 0
    return ((a << 24) | (B << 16) | (G << 8) | R) >>> 0
  }

  static packVec(c: Vec3, a = 255): number {
    return Framebuffer.pack(c[0], c[1], c[2], a)
  }

  clear(bgTop: Vec3, bgBottom: Vec3, farDepth = Infinity): void {
    const { width, height, color, depth, overdraw } = this
    depth.fill(farDepth)
    overdraw.fill(0)
    // vertical gradient background
    for (let y = 0; y < height; y++) {
      const t = height > 1 ? y / (height - 1) : 0
      const r = bgTop[0] + (bgBottom[0] - bgTop[0]) * t
      const g = bgTop[1] + (bgBottom[1] - bgTop[1]) * t
      const b = bgTop[2] + (bgBottom[2] - bgTop[2]) * t
      const packed = Framebuffer.pack(r, g, b)
      const row = y * width
      for (let x = 0; x < width; x++) color[row + x] = packed
    }
  }

  // Copy the working buffer into the ImageData and present it, scaling up to the
  // canvas' device size with nearest-neighbour (crisp pixels) via drawImage.
  present(ctx: CanvasRenderingContext2D): void {
    if (!this.image || !this.view) {
      this.image = new ImageData(this.width, this.height)
      this.view = new Uint32Array(this.image.data.buffer)
    }
    this.view.set(this.color)
    ctx.putImageData(this.image, 0, 0)
  }
}
