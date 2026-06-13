import { Vec2 } from '../engine';

/**
 * A 2D camera mapping world meters to screen pixels. World space is y-up; the
 * screen is y-down, so the vertical axis is flipped. Handles pan and
 * zoom-about-cursor for the interactive viewport.
 */
export class Camera {
  /** World-space point at the center of the viewport. */
  center: Vec2;
  /** Pixels per world meter. */
  scale: number;
  width = 800;
  height = 600;

  constructor(center = new Vec2(0, 5), scale = 40) {
    this.center = center;
    this.scale = scale;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  worldToScreen(p: Vec2): Vec2 {
    return new Vec2(
      this.width / 2 + (p.x - this.center.x) * this.scale,
      this.height / 2 - (p.y - this.center.y) * this.scale,
    );
  }

  screenToWorld(p: Vec2): Vec2 {
    return new Vec2(
      this.center.x + (p.x - this.width / 2) / this.scale,
      this.center.y - (p.y - this.height / 2) / this.scale,
    );
  }

  /** Pan by a screen-space pixel delta. */
  panPixels(dx: number, dy: number): void {
    this.center = new Vec2(this.center.x - dx / this.scale, this.center.y + dy / this.scale);
  }

  /** Zoom by `factor` while keeping the world point under `screenAnchor` fixed. */
  zoomAt(screenAnchor: Vec2, factor: number): void {
    const before = this.screenToWorld(screenAnchor);
    this.scale = Math.max(4, Math.min(400, this.scale * factor));
    const after = this.screenToWorld(screenAnchor);
    this.center = this.center.add(before.sub(after));
  }

  /** Length in pixels of a world-space distance. */
  toPixels(meters: number): number {
    return meters * this.scale;
  }
}
