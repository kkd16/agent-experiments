// An orbit camera: yaw/pitch/distance around a target. Produces the eye position,
// view matrix and projection matrix the pipeline needs.
import type { Mat4 } from '../math/mat4.ts'
import { lookAt, perspective } from '../math/mat4.ts'
import { clamp, DEG2RAD } from '../math/scalar.ts'
import type { Vec3 } from '../math/vec.ts'

export class OrbitCamera {
  yaw = 0.7
  pitch = 0.5
  distance = 6
  target: Vec3 = [0, 0.4, 0]
  fovDeg = 55
  near = 0.1
  far = 100

  private readonly minPitch = -1.45
  private readonly maxPitch = 1.45
  private readonly minDist = 1.6
  private readonly maxDist = 30

  reset(): void {
    this.yaw = 0.7
    this.pitch = 0.5
    this.distance = 6
  }

  rotate(dYaw: number, dPitch: number): void {
    this.yaw += dYaw
    this.pitch = clamp(this.pitch + dPitch, this.minPitch, this.maxPitch)
  }

  zoom(factor: number): void {
    this.distance = clamp(this.distance * factor, this.minDist, this.maxDist)
  }

  eye(): Vec3 {
    const cp = Math.cos(this.pitch)
    return [
      this.target[0] + this.distance * cp * Math.sin(this.yaw),
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * cp * Math.cos(this.yaw),
    ]
  }

  view(): Mat4 {
    return lookAt(this.eye(), this.target, [0, 1, 0])
  }

  projection(aspect: number): Mat4 {
    return perspective(this.fovDeg * DEG2RAD, aspect, this.near, this.far)
  }
}
