// Small, dependency-free vector/matrix helpers for the renderer. Everything the
// GPU needs is a handful of vec3s and one 3x3 rotation matrix per node.

import type { Vec3 } from '../scene/types'

const DEG = Math.PI / 180

/** Camera eye position from orbit parameters around a target. */
export function orbitPosition(
  target: Vec3,
  distance: number,
  azimuthDeg: number,
  elevationDeg: number,
): Vec3 {
  const az = azimuthDeg * DEG
  const el = elevationDeg * DEG
  const ce = Math.cos(el)
  return [
    target[0] + distance * ce * Math.sin(az),
    target[1] + distance * Math.sin(el),
    target[2] + distance * ce * Math.cos(az),
  ]
}

/** Unit direction pointing toward the sun from azimuth/elevation. */
export function sunDirection(azimuthDeg: number, elevationDeg: number): Vec3 {
  const az = azimuthDeg * DEG
  const el = elevationDeg * DEG
  const ce = Math.cos(el)
  const d: Vec3 = [ce * Math.sin(az), Math.sin(el), ce * Math.cos(az)]
  const len = Math.hypot(d[0], d[1], d[2]) || 1
  return [d[0] / len, d[1] / len, d[2] / len]
}

/**
 * World→object rotation matrix for a node, packed column-major for
 * `uniformMatrix3fv`. Object→world is Rx·Ry·Rz; we upload its transpose so the
 * shader can map a world point into the primitive's local frame with `uRot * p`.
 */
export function worldToObjectMat3(rotationDeg: Vec3, out: Float32Array): Float32Array {
  const rx = rotationDeg[0] * DEG
  const ry = rotationDeg[1] * DEG
  const rz = rotationDeg[2] * DEG
  const cx = Math.cos(rx)
  const sx = Math.sin(rx)
  const cy = Math.cos(ry)
  const sy = Math.sin(ry)
  const cz = Math.cos(rz)
  const sz = Math.sin(rz)

  // R = Rx * Ry * Rz  (object → world), row-major r[row][col].
  const r00 = cy * cz
  const r01 = -cy * sz
  const r02 = sy
  const r10 = sx * sy * cz + cx * sz
  const r11 = -sx * sy * sz + cx * cz
  const r12 = -sx * cy
  const r20 = -cx * sy * cz + sx * sz
  const r21 = cx * sy * sz + sx * cz
  const r22 = cx * cy
  const r = [
    [r00, r01, r02],
    [r10, r11, r12],
    [r20, r21, r22],
  ]

  // Upload W = Rᵀ, column-major: out[col*3 + row] = W[row][col] = R[col][row].
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      out[col * 3 + row] = r[col][row]
    }
  }
  return out
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
