// 4×4 matrices, column-major (OpenGL layout): element (row r, col c) lives at
// index c*4 + r. All builders return a fresh `number[16]`.
import type { Vec3, Vec4 } from './vec.ts'
import { cross, dot, normalize, sub } from './vec.ts'

export type Mat4 = number[]
export type Mat3 = number[]

export const identity = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

// C = A · B
export const multiply = (a: Mat4, b: Mat4): Mat4 => {
  const out = new Array<number>(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]
      out[c * 4 + r] = s
    }
  }
  return out
}

// Compose left-to-right: chain(A, B, C) applies A first, then B, then C.
export const chain = (...ms: Mat4[]): Mat4 => ms.reduce((acc, m) => multiply(m, acc), identity())

export const transformVec4 = (m: Mat4, v: Vec4): Vec4 => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
  m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
]

export const transformPoint = (m: Mat4, p: Vec3): Vec3 => {
  const r = transformVec4(m, [p[0], p[1], p[2], 1])
  return [r[0], r[1], r[2]]
}

export const translation = (x: number, y: number, z: number): Mat4 => [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1,
]

export const scaling = (x: number, y: number, z: number): Mat4 => [
  x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1,
]

export const rotationX = (a: number): Mat4 => {
  const c = Math.cos(a), s = Math.sin(a)
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]
}

export const rotationY = (a: number): Mat4 => {
  const c = Math.cos(a), s = Math.sin(a)
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]
}

export const rotationZ = (a: number): Mat4 => {
  const c = Math.cos(a), s = Math.sin(a)
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

// Right-handed perspective; maps view-space depth to clip z in [-1, 1].
export const perspective = (fovYRad: number, aspect: number, near: number, far: number): Mat4 => {
  const f = 1 / Math.tan(fovYRad / 2)
  const nf = 1 / (near - far)
  const out = new Array<number>(16).fill(0)
  out[0] = f / aspect
  out[5] = f
  out[10] = (far + near) * nf
  out[11] = -1
  out[14] = 2 * far * near * nf
  return out
}

// Right-handed look-at: camera at `eye` looking toward `center`.
export const lookAt = (eye: Vec3, center: Vec3, up: Vec3): Mat4 => {
  const f = normalize(sub(center, eye))
  const s = normalize(cross(f, up))
  const u = cross(s, f)
  return [
    s[0], u[0], -f[0], 0,
    s[1], u[1], -f[1], 0,
    s[2], u[2], -f[2], 0,
    -dot(s, eye), -dot(u, eye), dot(f, eye), 1,
  ]
}

// Normal matrix: inverse-transpose of the model's upper-left 3×3, so normals
// stay perpendicular to surfaces even under non-uniform scale. Returns a Mat3.
export const normalMatrix = (m: Mat4): Mat3 => {
  // upper-left 3×3 (column-major within the 4×4)
  const a = m[0], b = m[1], c = m[2]
  const d = m[4], e = m[5], f = m[6]
  const g = m[8], h = m[9], i = m[10]
  const det = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e)
  if (Math.abs(det) < 1e-12) return [a, d, g, b, e, h, c, f, i] // fall back to plain transpose
  const id = 1 / det
  // inverse of the 3×3 (column-major), then transpose by swapping the read order.
  const inv = [
    (e * i - f * h) * id, (c * h - b * i) * id, (b * f - c * e) * id,
    (f * g - d * i) * id, (a * i - c * g) * id, (c * d - a * f) * id,
    (d * h - e * g) * id, (b * g - a * h) * id, (a * e - b * d) * id,
  ]
  // transpose
  return [inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]]
}

export const transformMat3 = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
]
