// 2D camera mapping world coordinates ↔ screen pixels.
//
// The world is in arbitrary simulation units; the camera holds a centre (the
// world point shown at the canvas middle) and a scale (pixels per world unit).
// Zoom keeps the point under the cursor fixed, which is what feels natural.

export class Camera {
  centerX = 0
  centerY = 0
  scale = 1

  // Canvas size in device pixels.
  width = 1
  height = 1

  setViewport(width: number, height: number): void {
    this.width = width
    this.height = height
  }

  /** Frame a world half-extent so it fits the smaller canvas dimension. */
  fitExtent(extent: number): void {
    const minDim = Math.min(this.width, this.height)
    this.scale = minDim / (2 * Math.max(extent, 1e-6))
  }

  worldToScreenX(x: number): number {
    return (x - this.centerX) * this.scale + this.width / 2
  }

  worldToScreenY(y: number): number {
    return (y - this.centerY) * this.scale + this.height / 2
  }

  screenToWorldX(sx: number): number {
    return (sx - this.width / 2) / this.scale + this.centerX
  }

  screenToWorldY(sy: number): number {
    return (sy - this.height / 2) / this.scale + this.centerY
  }

  /** Pan by a screen-space pixel delta. */
  panByPixels(dxPixels: number, dyPixels: number): void {
    this.centerX -= dxPixels / this.scale
    this.centerY -= dyPixels / this.scale
  }

  /** Zoom by a multiplicative factor around a screen anchor point. */
  zoomAt(factor: number, screenX: number, screenY: number): void {
    const wx = this.screenToWorldX(screenX)
    const wy = this.screenToWorldY(screenY)
    this.scale *= factor
    // Re-anchor so (wx, wy) stays under the cursor.
    this.centerX = wx - (screenX - this.width / 2) / this.scale
    this.centerY = wy - (screenY - this.height / 2) / this.scale
  }
}
