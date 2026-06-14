// vec3.ts — a small, allocation-conscious 3D vector library.
//
// Vectors are plain { x, y, z } records. Most helpers are pure (they return a
// fresh vector), but the hottest paths in the integrator use the in-place
// variants (those whose name ends in `_`) to keep the garbage collector quiet.

export interface Vec3 {
  x: number
  y: number
  z: number
}

export const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z })
export const vzero = (): Vec3 => ({ x: 0, y: 0, z: 0 })
export const vsplat = (s: number): Vec3 => ({ x: s, y: s, z: s })
export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z })

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
export const mul = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x * b.x, y: a.y * b.y, z: a.z * b.z })
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s })
export const neg = (a: Vec3): Vec3 => ({ x: -a.x, y: -a.y, z: -a.z })

// a + b*s — fused multiply-add, the workhorse of ray marching and shading.
export const madd = (a: Vec3, b: Vec3, s: number): Vec3 => ({
  x: a.x + b.x * s,
  y: a.y + b.y * s,
  z: a.z + b.z * s,
})

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z

export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})

export const len2 = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z
export const len = (a: Vec3): number => Math.sqrt(len2(a))

export const normalize = (a: Vec3): Vec3 => {
  const l = len(a)
  return l > 0 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 }
}

export const distance = (a: Vec3, b: Vec3): number => len(sub(a, b))

export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
})

export const minV = (a: Vec3, b: Vec3): Vec3 => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  z: Math.min(a.z, b.z),
})
export const maxV = (a: Vec3, b: Vec3): Vec3 => ({
  x: Math.max(a.x, b.x),
  y: Math.max(a.y, b.y),
  z: Math.max(a.z, b.z),
})

export const maxComponent = (a: Vec3): number => Math.max(a.x, Math.max(a.y, a.z))
export const luminance = (a: Vec3): number => 0.2126 * a.x + 0.7152 * a.y + 0.0722 * a.z
export const isBlack = (a: Vec3): boolean => a.x === 0 && a.y === 0 && a.z === 0
export const isFiniteV = (a: Vec3): boolean =>
  Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z)

// Reflect d about normal n (n unit). d points toward the surface.
export const reflect = (d: Vec3, n: Vec3): Vec3 => madd(d, n, -2 * dot(d, n))

// Refract d (unit, toward surface) across n with relative ior eta = ni/nt.
// Returns null on total internal reflection.
export const refract = (d: Vec3, n: Vec3, eta: number): Vec3 | null => {
  const cosI = -dot(d, n)
  const sin2T = eta * eta * (1 - cosI * cosI)
  if (sin2T > 1) return null // total internal reflection
  const cosT = Math.sqrt(1 - sin2T)
  return add(scale(d, eta), scale(n, eta * cosI - cosT))
}

// Build an orthonormal basis around a unit normal n (Duff et al. 2017).
export const onb = (n: Vec3): { t: Vec3; b: Vec3 } => {
  const sign = n.z >= 0 ? 1 : -1
  const a = -1 / (sign + n.z)
  const b = n.x * n.y * a
  return {
    t: { x: 1 + sign * n.x * n.x * a, y: sign * b, z: -sign * n.x },
    b: { x: b, y: sign + n.y * n.y * a, z: -n.y },
  }
}

// Transform a vector expressed in the local tangent frame (t, b, n) to world.
export const toWorld = (local: Vec3, t: Vec3, b: Vec3, n: Vec3): Vec3 => ({
  x: local.x * t.x + local.y * b.x + local.z * n.x,
  y: local.x * t.y + local.y * b.y + local.z * n.y,
  z: local.x * t.z + local.y * b.z + local.z * n.z,
})

export const faceForward = (n: Vec3, d: Vec3): Vec3 => (dot(n, d) < 0 ? n : neg(n))

export const clamp = (x: number, lo: number, hi: number): number =>
  x < lo ? lo : x > hi ? hi : x
