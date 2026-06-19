// An orthographic orbit camera — the minimal 3D maths the from-scratch voxel renderer needs.
//
// State is two angles (yaw about world +Y, pitch about the camera's right axis), a uniform scale
// (zoom) and a screen centre. A world point is yaw-then-pitch rotated and dropped onto the screen
// orthographically; the rotated z becomes the painter's-algorithm depth (the camera sits on +Z
// looking toward −Z, so a larger rotated z is nearer). Face visibility uses the rotated normal's
// z (a face is seen when its normal turns to face the camera); Lambert shading instead uses the
// *world* normal against a fixed light, so the lighting stays glued to the scene as you orbit.

export type Projected = { sx: number; sy: number; depth: number };

export class Camera {
  yaw: number;
  pitch: number;
  scale: number;
  cx: number;
  cy: number;
  // centre of the scene in world space (so we orbit around the model, not the origin)
  ox = 0;
  oy = 0;
  oz = 0;

  private cyaw = 1;
  private syaw = 0;
  private cpit = 1;
  private spit = 0;

  constructor(yaw = 0.7, pitch = 0.62, scale = 10, cx = 0, cy = 0) {
    this.yaw = yaw;
    this.pitch = pitch;
    this.scale = scale;
    this.cx = cx;
    this.cy = cy;
    this.refresh();
  }

  /** Recompute the cached sin/cos — call after mutating yaw/pitch. */
  refresh(): void {
    this.cyaw = Math.cos(this.yaw);
    this.syaw = Math.sin(this.yaw);
    this.cpit = Math.cos(this.pitch);
    this.spit = Math.sin(this.pitch);
  }

  center(ox: number, oy: number, oz: number): void {
    this.ox = ox;
    this.oy = oy;
    this.oz = oz;
  }

  /** Rotate a world vector (no translation) by yaw-then-pitch; returns [x,y,z] in camera space. */
  private rot(x: number, y: number, z: number): [number, number, number] {
    const x1 = x * this.cyaw - z * this.syaw;
    const z1 = x * this.syaw + z * this.cyaw;
    const y2 = y * this.cpit - z1 * this.spit;
    const z2 = y * this.spit + z1 * this.cpit;
    return [x1, y2, z2];
  }

  project(x: number, y: number, z: number): Projected {
    const [rx, ry, rz] = this.rot(x - this.ox, y - this.oy, z - this.oz);
    return { sx: rx * this.scale + this.cx, sy: -ry * this.scale + this.cy, depth: rz };
  }

  /** Camera-space z of a (world) normal — > 0 means the face turns toward the viewer. */
  facing(nx: number, ny: number, nz: number): number {
    return this.rot(nx, ny, nz)[2];
  }
}
