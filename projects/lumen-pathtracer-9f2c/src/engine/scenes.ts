// scenes.ts — a registry of preset scenes, each returning a plain SceneDef.
// These are designed to exercise every part of the renderer: diffuse global
// illumination and colour bleeding (Cornell), perfect specular reflection,
// dielectric refraction, GGX roughness sweeps, depth of field, and a sky dome
// acting as a large area light.

import type { Vec3 } from './vec3'
import { add, cross, normalize, scale, sub, v } from './vec3'
import type { Material } from './material'
import type { PrimDef, SceneDef } from './types'
import { Rng } from './rng'

// ---- small builders ----------------------------------------------------------

function quad(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, material: number): PrimDef[] {
  return [
    { kind: 'tri', p0, p1, p2, material },
    { kind: 'tri', p0, p1: p2, p2: p3, material },
  ]
}

// Axis-aligned box centred at `c`, half-extents `h`, optionally rotated about Y.
function box(c: Vec3, h: Vec3, rotY: number, material: number): PrimDef[] {
  const cs = Math.cos(rotY)
  const sn = Math.sin(rotY)
  const corner = (sx: number, sy: number, sz: number): Vec3 => {
    const lx = sx * h.x
    const lz = sz * h.z
    return v(c.x + lx * cs - lz * sn, c.y + sy * h.y, c.z + lx * sn + lz * cs)
  }
  const c000 = corner(-1, -1, -1)
  const c100 = corner(1, -1, -1)
  const c110 = corner(1, 1, -1)
  const c010 = corner(-1, 1, -1)
  const c001 = corner(-1, -1, 1)
  const c101 = corner(1, -1, 1)
  const c111 = corner(1, 1, 1)
  const c011 = corner(-1, 1, 1)
  return [
    ...quad(c000, c100, c110, c010, material), // -z
    ...quad(c101, c001, c011, c111, material), // +z
    ...quad(c001, c000, c010, c011, material), // -x
    ...quad(c100, c101, c111, c110, material), // +x
    ...quad(c010, c110, c111, c011, material), // +y
    ...quad(c001, c101, c100, c000, material), // -y
  ]
}

// ---- Scene 1: Cornell box ----------------------------------------------------

function cornell(): SceneDef {
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.725, 0.71, 0.68) }, // 0 white
    { kind: 'diffuse', albedo: v(0.63, 0.065, 0.05) }, // 1 red
    { kind: 'diffuse', albedo: v(0.14, 0.45, 0.091) }, // 2 green
    { kind: 'emissive', emission: v(17, 12, 4) }, // 3 warm light
    { kind: 'metal', albedo: v(0.95, 0.93, 0.88), roughness: 0.0 }, // 4 mirror
    { kind: 'dielectric', ior: 1.5, tint: v(1, 1, 1) }, // 5 glass
  ]
  const prims: PrimDef[] = []
  // Walls.
  prims.push(...quad(v(552.8, 0, 0), v(0, 0, 0), v(0, 0, 559.2), v(549.6, 0, 559.2), 0)) // floor
  prims.push(...quad(v(556, 548.8, 0), v(556, 548.8, 559.2), v(0, 548.8, 559.2), v(0, 548.8, 0), 0)) // ceiling
  prims.push(...quad(v(549.6, 0, 559.2), v(0, 0, 559.2), v(0, 548.8, 559.2), v(556, 548.8, 559.2), 0)) // back
  prims.push(...quad(v(552.8, 0, 0), v(549.6, 0, 559.2), v(556, 548.8, 559.2), v(556, 548.8, 0), 1)) // left red
  prims.push(...quad(v(0, 0, 559.2), v(0, 0, 0), v(0, 548.8, 0), v(0, 548.8, 559.2), 2)) // right green
  // Ceiling light (normal faces down into the room).
  const lh = 548.7
  prims.push(
    ...quad(v(213, lh, 227), v(343, lh, 227), v(343, lh, 332), v(213, lh, 332), 3),
  )
  // A mirrored tall box, a glass sphere, and a metal sphere.
  prims.push(...box(v(185, 165, 169), v(82, 165, 82), 0.29, 4))
  prims.push({ kind: 'sphere', center: v(370, 90, 280), radius: 90, material: 5 })
  prims.push({ kind: 'sphere', center: v(420, 50, 110), radius: 50, material: 0 })
  return {
    name: 'Cornell Box',
    materials,
    prims,
    camera: {
      eye: v(278, 273, -800),
      target: v(278, 273, 0),
      up: v(0, 1, 0),
      vfovDeg: 40,
      aperture: 0,
      focusDist: 800,
    },
    env: { kind: 'solid', color: v(0, 0, 0) },
  }
}

// ---- Scene 2: "Weekend" daylight spheres ------------------------------------

function weekend(): SceneDef {
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.5, 0.5, 0.5) }, // 0 ground
    { kind: 'dielectric', ior: 1.5, tint: v(1, 1, 1) }, // 1 glass hero
    { kind: 'diffuse', albedo: v(0.4, 0.2, 0.1) }, // 2 brown hero
    { kind: 'metal', albedo: v(0.7, 0.6, 0.5), roughness: 0.0 }, // 3 mirror hero
  ]
  const prims: PrimDef[] = []
  // Ground as a large flat quad.
  const g = 40
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))

  const rng = new Rng(20260614, 7)
  for (let a = -11; a < 11; a++) {
    for (let b = -11; b < 11; b++) {
      const cx = a + 0.9 * rng.next()
      const cz = b + 0.9 * rng.next()
      const center = v(cx, 0.2, cz)
      if (Math.hypot(cx - 4, cz) < 0.9) continue
      const choose = rng.next()
      let mat: number
      if (choose < 0.8) {
        const albedo = v(rng.next() * rng.next(), rng.next() * rng.next(), rng.next() * rng.next())
        materials.push({ kind: 'diffuse', albedo })
        mat = materials.length - 1
      } else if (choose < 0.95) {
        const albedo = v(0.5 + 0.5 * rng.next(), 0.5 + 0.5 * rng.next(), 0.5 + 0.5 * rng.next())
        materials.push({ kind: 'metal', albedo, roughness: 0.3 * rng.next() })
        mat = materials.length - 1
      } else {
        mat = 1 // glass
      }
      prims.push({ kind: 'sphere', center, radius: 0.2, material: mat })
    }
  }
  // Three hero spheres.
  prims.push({ kind: 'sphere', center: v(0, 1, 0), radius: 1, material: 1 })
  prims.push({ kind: 'sphere', center: v(-4, 1, 0), radius: 1, material: 2 })
  prims.push({ kind: 'sphere', center: v(4, 1, 0), radius: 1, material: 3 })

  return {
    name: 'Weekend Daylight',
    materials,
    prims,
    camera: {
      eye: v(13, 2, 3),
      target: v(0, 0, 0),
      up: v(0, 1, 0),
      vfovDeg: 20,
      aperture: 0.1,
      focusDist: 10,
    },
    env: {
      kind: 'gradient',
      top: v(0.5, 0.7, 1.0),
      bottom: v(1.0, 1.0, 1.0),
      sunDir: v(0.5, 0.8, 0.2),
      sunColor: v(8, 7.5, 6.5),
      sunSize: 0.04,
    },
  }
}

// ---- Scene 3: material gallery ----------------------------------------------

function gallery(): SceneDef {
  const materials: Material[] = [{ kind: 'diffuse', albedo: v(0.2, 0.2, 0.22) }] // 0 floor
  const prims: PrimDef[] = []
  const g = 30
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))

  const cols = 6
  const gold = v(1.0, 0.78, 0.34)
  // Row of metal spheres with roughness sweeping 0 → 1.
  for (let i = 0; i < cols; i++) {
    materials.push({ kind: 'metal', albedo: gold, roughness: i / (cols - 1) })
    const mat = materials.length - 1
    prims.push({ kind: 'sphere', center: v((i - (cols - 1) / 2) * 2.4, 1, 0), radius: 1, material: mat })
  }
  // Row of dielectrics with varying IOR.
  for (let i = 0; i < cols; i++) {
    materials.push({ kind: 'dielectric', ior: 1.2 + i * 0.18, tint: v(1, 1, 1) })
    const mat = materials.length - 1
    prims.push({ kind: 'sphere', center: v((i - (cols - 1) / 2) * 2.4, 1, -3), radius: 1, material: mat })
  }
  // Row of colourful diffuse spheres.
  for (let i = 0; i < cols; i++) {
    const hue = i / cols
    materials.push({ kind: 'diffuse', albedo: hsv(hue, 0.65, 0.85) })
    const mat = materials.length - 1
    prims.push({ kind: 'sphere', center: v((i - (cols - 1) / 2) * 2.4, 1, 3), radius: 1, material: mat })
  }
  // A soft overhead area light.
  materials.push({ kind: 'emissive', emission: v(6, 6, 6) })
  const lm = materials.length - 1
  prims.push(...quad(v(-6, 9, -6), v(6, 9, -6), v(6, 9, 6), v(-6, 9, 6), lm))

  return {
    name: 'Material Gallery',
    materials,
    prims,
    camera: {
      eye: v(0, 4.5, 13),
      target: v(0, 1, 0),
      up: v(0, 1, 0),
      vfovDeg: 38,
      aperture: 0.05,
      focusDist: 13,
    },
    env: { kind: 'gradient', top: v(0.18, 0.21, 0.28), bottom: v(0.05, 0.06, 0.08) },
  }
}

// ---- Scene 4: dark-room caustic glass ---------------------------------------

function causticRoom(): SceneDef {
  // A white room enclosed on five sides (the camera-facing front is left open,
  // Cornell-style), lit by a bright ceiling panel so the glass and copper
  // spheres throw visible caustics and coloured reflections onto the floor.
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.82, 0.82, 0.84) }, // 0 white walls/floor
    { kind: 'emissive', emission: v(26, 24, 20) }, // 1 ceiling light
    { kind: 'dielectric', ior: 1.52, tint: v(0.96, 0.99, 1) }, // 2 glass
    { kind: 'metal', albedo: v(0.96, 0.66, 0.46), roughness: 0.06 }, // 3 copper
    { kind: 'diffuse', albedo: v(0.25, 0.35, 0.75) }, // 4 blue back wall
  ]
  const prims: PrimDef[] = []
  const x0 = -6
  const x1 = 6
  const z0 = -6
  const z1 = 6
  const yT = 9
  prims.push(...quad(v(x0, 0, z0), v(x1, 0, z0), v(x1, 0, z1), v(x0, 0, z1), 0)) // floor
  prims.push(...quad(v(x0, yT, z0), v(x0, yT, z1), v(x1, yT, z1), v(x1, yT, z0), 0)) // ceiling
  prims.push(...quad(v(x0, 0, z0), v(x0, yT, z0), v(x1, yT, z0), v(x1, 0, z0), 4)) // back wall
  prims.push(...quad(v(x0, 0, z1), v(x0, 0, z0), v(x0, yT, z0), v(x0, yT, z1), 0)) // left
  prims.push(...quad(v(x1, 0, z0), v(x1, 0, z1), v(x1, yT, z1), v(x1, yT, z0), 0)) // right
  // Ceiling light panel (normal faces down into the room).
  const lh = yT - 0.02
  prims.push(...quad(v(-2.4, lh, -2.4), v(2.4, lh, -2.4), v(2.4, lh, 2.4), v(-2.4, lh, 2.4), 1))
  prims.push({ kind: 'sphere', center: v(-2.1, 1.6, -0.5), radius: 1.6, material: 2 })
  prims.push({ kind: 'sphere', center: v(2.0, 1.3, 1.3), radius: 1.3, material: 3 })
  prims.push({ kind: 'sphere', center: v(0.2, 0.85, -2.2), radius: 0.85, material: 2 })

  return {
    name: 'Caustic Room',
    materials,
    prims,
    camera: {
      eye: v(0, 4.2, 15.5),
      target: v(0, 3.0, 0),
      up: v(0, 1, 0),
      vfovDeg: 40,
      aperture: 0.03,
      focusDist: 15,
    },
    env: { kind: 'solid', color: v(0.0, 0.0, 0.0) },
  }
}

// Simple HSV→RGB for the diffuse colour wheel.
function hsv(h: number, s: number, val: number): Vec3 {
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = val * (1 - s)
  const q = val * (1 - f * s)
  const t = val * (1 - (1 - f) * s)
  switch (i % 6) {
    case 0:
      return v(val, t, p)
    case 1:
      return v(q, val, p)
    case 2:
      return v(p, val, t)
    case 3:
      return v(p, q, val)
    case 4:
      return v(t, p, val)
    default:
      return v(val, p, q)
  }
}

export interface ScenePreset {
  id: string
  label: string
  build: () => SceneDef
}

export const SCENES: ScenePreset[] = [
  { id: 'cornell', label: 'Cornell Box', build: cornell },
  { id: 'weekend', label: 'Weekend Daylight', build: weekend },
  { id: 'gallery', label: 'Material Gallery', build: gallery },
  { id: 'caustic', label: 'Caustic Room', build: causticRoom },
]

// Re-exports used by the orbit camera helper in the UI.
export const sceneMath = { add, sub, scale, normalize, cross }
