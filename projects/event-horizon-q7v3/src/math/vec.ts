// Minimal 3-vector helpers — just enough to build the camera basis on the CPU each frame.
// Kept as plain tuples to avoid allocation churn in the render loop.

export type Vec3 = [number, number, number]

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]

export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]

export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])

export const normalize = (a: Vec3): Vec3 => {
  const l = length(a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** A right-handed camera basis (right, up, forward) that looks from `eye` toward `target`. */
export function lookBasis(eye: Vec3, target: Vec3, worldUp: Vec3 = [0, 1, 0]) {
  const forward = normalize(sub(target, eye))
  // Guard against the degenerate case where forward is parallel to worldUp (top-down view).
  let up = worldUp
  if (Math.abs(dot(forward, worldUp)) > 0.999) up = [0, 0, 1]
  const right = normalize(cross(forward, up))
  const trueUp = cross(right, forward)
  return { right, up: trueUp, forward }
}

/** Camera position from spherical coordinates centred on the black hole. */
export function orbitPosition(distance: number, inclinationDeg: number, azimuthDeg: number): Vec3 {
  const el = (inclinationDeg * Math.PI) / 180
  const az = (azimuthDeg * Math.PI) / 180
  const ce = Math.cos(el)
  return [distance * ce * Math.cos(az), distance * Math.sin(el), distance * ce * Math.sin(az)]
}
