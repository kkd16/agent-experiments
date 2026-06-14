// scenes.ts — a registry of preset scenes, each returning a plain SceneDef.
// These are designed to exercise every part of the renderer: diffuse global
// illumination and colour bleeding (Cornell), perfect specular reflection,
// dielectric refraction, GGX roughness sweeps, depth of field, and a sky dome
// acting as a large area light.

import type { Vec3 } from './vec3'
import { add, cross, dot, normalize, scale, sub, v } from './vec3'
import type { Material } from './material'
import type { PrimDef, SceneDef } from './types'
import { Rng } from './rng'
import { emitMesh, icosphere, surfaceOfRevolution, torus, transformMesh, uvSphere } from './mesh'
import { CUBE_OBJ, parseObj } from './obj'

// ---- small builders ----------------------------------------------------------

function quad(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, material: number): PrimDef[] {
  return [
    { kind: 'tri', p0, p1, p2, material },
    { kind: 'tri', p0, p1: p2, p2: p3, material },
  ]
}

// Emit a triangle whose winding is chosen so its geometric normal points *away*
// from `center`. This lets a closed convex solid (e.g. a prism) be built without
// hand-tracking winding — essential for dielectrics, whose entering/exiting IOR
// depends on which side of the surface the ray strikes.
function outwardTri(a: Vec3, b: Vec3, c: Vec3, center: Vec3, material: number): PrimDef {
  const n = cross(sub(b, a), sub(c, a))
  const centroid = scale(add(add(a, b), c), 1 / 3)
  if (dot(n, sub(centroid, center)) < 0) return { kind: 'tri', p0: a, p1: c, p2: b, material }
  return { kind: 'tri', p0: a, p1: b, p2: c, material }
}

// A triangular prism: an apex-up triangle in the Y–Z plane extruded along X. The
// two slanted faces are non-parallel, so a ray entering one and leaving another
// is dispersed into a spectrum — the canonical Newton prism.
function prism(cx: number, cy: number, cz: number, ex: number, material: number): PrimDef[] {
  // Cross-section vertices (z, y), apex up.
  const A = v(cx, cy + 1.5, cz + 0.0) // apex
  const B = v(cx, cy - 0.75, cz - 1.3) // back-bottom
  const C = v(cx, cy - 0.75, cz + 1.3) // front-bottom
  const A0 = v(A.x - ex, A.y, A.z)
  const A1 = v(A.x + ex, A.y, A.z)
  const B0 = v(B.x - ex, B.y, B.z)
  const B1 = v(B.x + ex, B.y, B.z)
  const C0 = v(C.x - ex, C.y, C.z)
  const C1 = v(C.x + ex, C.y, C.z)
  const center = v(cx, cy, cz)
  const faces: PrimDef[] = []
  // End caps.
  faces.push(outwardTri(A0, B0, C0, center, material))
  faces.push(outwardTri(A1, B1, C1, center, material))
  // Three rectangular sides (two triangles each).
  const side = (p: Vec3, q: Vec3, qq: Vec3, pp: Vec3): void => {
    faces.push(outwardTri(p, q, qq, center, material))
    faces.push(outwardTri(p, qq, pp, center, material))
  }
  side(A0, B0, B1, A1)
  side(B0, C0, C1, B1)
  side(C0, A0, A1, C1)
  return faces
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

// ---- Scene 5: Prism — spectral dispersion -----------------------------------

function prismScene(): SceneDef {
  // A dispersive glass prism in a dark room, lit by a bright panel behind it.
  // Camera rays refract through two non-parallel faces and fan into a spectrum;
  // the high-contrast bright/dark edges behind the prism reveal the colour split.
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.05, 0.05, 0.06) }, // 0 dark surrounds
    { kind: 'diffuse', albedo: v(0.6, 0.6, 0.62) }, // 1 catch floor
    { kind: 'emissive', emission: v(6, 6, 6) }, // 2 bright backdrop panel
    // Dense flint-style glass: high IOR and strong Cauchy dispersion → wide rainbow.
    { kind: 'dielectric', ior: 1.62, tint: v(1, 1, 1), cauchyB: 0.018 }, // 3 prism glass
  ]
  const prims: PrimDef[] = []
  // Floor + dark ceiling/walls forming a shallow box.
  prims.push(...quad(v(-12, -2, -10), v(12, -2, -10), v(12, -2, 12), v(-12, -2, 12), 1)) // floor
  prims.push(...quad(v(-12, 8, -10), v(-12, 8, 12), v(12, 8, 12), v(12, 8, -10), 0)) // ceiling
  prims.push(...quad(v(-12, -2, -9.5), v(-12, 8, -9.5), v(12, 8, -9.5), v(12, -2, -9.5), 0)) // back (dark)
  // Bright vertical backdrop slab a little in front of the dark wall: its sharp
  // edges, seen through the prism, are what disperse most visibly.
  prims.push(...quad(v(-2.2, -1.5, -9), v(-2.2, 6.5, -9), v(2.2, 6.5, -9), v(2.2, -1.5, -9), 2))
  // The prism, broadside to the camera.
  prims.push(...prism(0, 0.6, -3.2, 1.7, 3))
  // A couple of dispersive glass spheres for extra sparkle.
  prims.push({ kind: 'sphere', center: v(-3.6, 0.0, -1.5), radius: 1.0, material: 3 })
  prims.push({ kind: 'sphere', center: v(3.6, -0.3, -1.0), radius: 0.8, material: 3 })

  return {
    name: 'Prism',
    materials,
    prims,
    camera: {
      eye: v(0, 1.4, 7.5),
      target: v(0, 0.6, -3.2),
      up: v(0, 1, 0),
      vfovDeg: 42,
      aperture: 0,
      focusDist: 11,
    },
    env: { kind: 'solid', color: v(0.01, 0.01, 0.015) },
  }
}

// ---- Scene 6: Glass Menagerie — rough dielectrics + Beer–Lambert tint --------

function glassMenagerie(): SceneDef {
  // Front row: smooth → frosted glass (a roughness sweep). Back row: clear glass
  // tinted by *physical absorption* — Beer–Lambert attenuation through the volume
  // colours thick glass the way real amber, emerald and sapphire glass behave.
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.62, 0.62, 0.64) }, // 0 floor
    { kind: 'emissive', emission: v(7, 6.8, 6.4) }, // 1 ceiling light
  ]
  const prims: PrimDef[] = []
  const g = 30
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))

  const cols = 5
  const span = (i: number): number => (i - (cols - 1) / 2) * 2.6
  // Front row — roughness sweep (frosted glass).
  for (let i = 0; i < cols; i++) {
    materials.push({ kind: 'dielectric', ior: 1.5, tint: v(1, 1, 1), roughness: (i / (cols - 1)) * 0.5 })
    prims.push({ kind: 'sphere', center: v(span(i), 1, 2.2), radius: 1, material: materials.length - 1 })
  }
  // Back row — absorption-tinted clear glass (amber / gold / emerald / teal / sapphire).
  const tints: Vec3[] = [
    v(0.2, 1.0, 2.2), // amber
    v(0.4, 0.7, 2.4), // gold
    v(1.6, 0.25, 1.4), // emerald
    v(1.4, 0.4, 1.0), // teal
    v(2.2, 1.3, 0.25), // sapphire
  ]
  for (let i = 0; i < cols; i++) {
    materials.push({ kind: 'dielectric', ior: 1.52, tint: v(1, 1, 1), absorption: tints[i] })
    prims.push({ kind: 'sphere', center: v(span(i), 1.2, -2.0), radius: 1.2, material: materials.length - 1 })
  }
  // Overhead area light.
  prims.push(...quad(v(-7, 9, -7), v(7, 9, -7), v(7, 9, 7), v(-7, 9, 7), 1))

  return {
    name: 'Glass Menagerie',
    materials,
    prims,
    camera: {
      eye: v(0, 3.4, 12),
      target: v(0, 1, 0),
      up: v(0, 1, 0),
      vfovDeg: 40,
      aperture: 0.04,
      focusDist: 12,
    },
    env: { kind: 'gradient', top: v(0.16, 0.19, 0.26), bottom: v(0.04, 0.05, 0.07) },
  }
}

// ---- Scene 7: Textured Studio — procedural textures -------------------------

function texturedStudio(): SceneDef {
  // A procedurally textured stage: a checkerboard floor, a blueprint-grid back
  // wall, a marble sphere, plus a gold metal and a clear glass sphere so the
  // textures are reflected and refracted through the scene's other materials.
  const materials: Material[] = [
    {
      kind: 'diffuse',
      albedo: v(0.8, 0.8, 0.8),
      tex: { kind: 'checker', even: v(0.82, 0.83, 0.85), odd: v(0.08, 0.09, 0.11), scale: 0.35 },
    }, // 0 checker floor
    {
      kind: 'diffuse',
      albedo: v(0.2, 0.3, 0.45),
      tex: { kind: 'grid', base: v(0.10, 0.14, 0.22), line: v(0.35, 0.55, 0.8), scale: 0.5, width: 0.04 },
    }, // 1 blueprint grid wall
    {
      kind: 'diffuse',
      albedo: v(0.7, 0.7, 0.7),
      tex: { kind: 'marble', lo: v(0.05, 0.05, 0.08), hi: v(0.85, 0.83, 0.8), scale: 1.4, turbulence: 1.2 },
    }, // 2 marble
    { kind: 'metal', albedo: v(1.0, 0.78, 0.34), roughness: 0.08 }, // 3 gold
    { kind: 'dielectric', ior: 1.5, tint: v(1, 1, 1) }, // 4 glass
    { kind: 'emissive', emission: v(9, 9, 9) }, // 5 light
  ]
  const prims: PrimDef[] = []
  const g = 24
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0)) // checker floor
  prims.push(...quad(v(-g, 0, -8), v(-g, 16, -8), v(g, 16, -8), v(g, 0, -8), 1)) // grid wall
  prims.push({ kind: 'sphere', center: v(-2.6, 1.4, -1.5), radius: 1.4, material: 2 }) // marble
  prims.push({ kind: 'sphere', center: v(0.6, 1.1, 0.5), radius: 1.1, material: 3 }) // gold
  prims.push({ kind: 'sphere', center: v(3.0, 1.0, -0.5), radius: 1.0, material: 4 }) // glass
  prims.push(...quad(v(-4, 11, -4), v(4, 11, -4), v(4, 11, 4), v(-4, 11, 4), 5)) // ceiling light

  return {
    name: 'Textured Studio',
    materials,
    prims,
    camera: {
      eye: v(0.5, 3.2, 10),
      target: v(0, 1.2, -1),
      up: v(0, 1, 0),
      vfovDeg: 42,
      aperture: 0.03,
      focusDist: 11,
    },
    env: { kind: 'gradient', top: v(0.5, 0.62, 0.85), bottom: v(0.85, 0.88, 0.95) },
  }
}

// ---- Sun helpers -------------------------------------------------------------

// A unit direction pointing toward the sun from an azimuth (degrees clockwise
// from +Z, looking down) and an elevation (degrees above the horizon).
export function sunFromAzEl(azDeg: number, elDeg: number): Vec3 {
  const az = (azDeg * Math.PI) / 180
  const el = (elDeg * Math.PI) / 180
  const ce = Math.cos(el)
  return normalize(v(ce * Math.sin(az), Math.sin(el), ce * Math.cos(az)))
}

// ---- Scene 8: Sky Studio — meshes under the Preetham daylight model ----------

function skyStudio(): SceneDef {
  // A geodesic glass sphere, a gold torus and a diffuse sphere on a soft checker
  // floor, lit *only* by the analytic sky — no artificial lights. The sun is a
  // sampled light (NEE), so crisp daylight shadows resolve in a handful of spp.
  const materials: Material[] = [
    {
      kind: 'diffuse',
      albedo: v(0.8, 0.8, 0.8),
      tex: { kind: 'checker', even: v(0.78, 0.78, 0.8), odd: v(0.2, 0.21, 0.24), scale: 0.32 },
    }, // 0 checker floor
    { kind: 'dielectric', ior: 1.5, tint: v(1, 1, 1) }, // 1 glass
    { kind: 'metal', albedo: v(1.0, 0.82, 0.43), roughness: 0.12 }, // 2 gold
    { kind: 'diffuse', albedo: v(0.85, 0.25, 0.22) }, // 3 red clay
    { kind: 'metal', albedo: v(0.95, 0.96, 0.98), roughness: 0.04 }, // 4 chrome
  ]
  const prims: PrimDef[] = []
  const g = 60
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))
  // Geodesic glass sphere.
  prims.push(...emitMesh(transformMesh(icosphere(3), { scale: 1.5, translate: v(-3.1, 1.5, 0) }), 1))
  // Gold torus, tipped toward the camera.
  prims.push(
    ...emitMesh(
      transformMesh(torus(1.1, 0.42, 56, 28), {
        translate: v(0, 1.0, 0),
        rotate: { axis: v(1, 0, 0.25), angle: 1.15 },
      }),
      2,
    ),
  )
  // Diffuse clay sphere + a small chrome geodesic sphere.
  prims.push(...emitMesh(transformMesh(uvSphere(28, 56), { scale: 1.2, translate: v(3.1, 1.2, 0.4) }), 3))
  prims.push(...emitMesh(transformMesh(icosphere(3), { scale: 0.7, translate: v(1.0, 0.7, 2.6) }), 4))

  return {
    name: 'Sky Studio',
    materials,
    prims,
    camera: {
      eye: v(0, 3.0, 11),
      target: v(0, 1.1, 0),
      up: v(0, 1, 0),
      vfovDeg: 40,
      aperture: 0.03,
      focusDist: 11,
    },
    env: { kind: 'sky', sunDir: sunFromAzEl(135, 24), turbidity: 2.6, intensity: 1.0, sunSize: 0.04 },
  }
}

// ---- Scene 9: Revolution — lathed surfaces of revolution --------------------

// A goblet profile (radius as a function of height): a wide foot, a thin stem,
// and a flared cup, all lathed into a single smooth surface.
function gobletProfile(): { r: number; y: number }[] {
  const pts: { r: number; y: number }[] = []
  pts.push({ r: 0.0, y: 0.0 })
  pts.push({ r: 0.9, y: 0.0 }) // foot rim
  pts.push({ r: 0.85, y: 0.12 })
  pts.push({ r: 0.16, y: 0.25 }) // into the stem
  pts.push({ r: 0.13, y: 0.95 }) // stem
  pts.push({ r: 0.2, y: 1.15 })
  pts.push({ r: 0.95, y: 1.45 }) // cup flare
  pts.push({ r: 1.05, y: 2.0 })
  pts.push({ r: 1.0, y: 2.02 }) // lip
  pts.push({ r: 0.18, y: 1.7 }) // hollow bowl (inner wall)
  pts.push({ r: 0.12, y: 1.2 })
  return pts
}

function revolution(): SceneDef {
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.55, 0.56, 0.6) }, // 0 floor
    { kind: 'metal', albedo: v(0.95, 0.64, 0.54), roughness: 0.08 }, // 1 copper goblet
    { kind: 'dielectric', ior: 1.5, tint: v(1, 1, 1) }, // 2 glass goblet
    { kind: 'metal', albedo: v(0.97, 0.97, 0.99), roughness: 0.18 }, // 3 brushed torus
    { kind: 'emissive', emission: v(9, 8.6, 8) }, // 4 key light
  ]
  const prims: PrimDef[] = []
  const g = 40
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))
  prims.push(...emitMesh(transformMesh(surfaceOfRevolution(gobletProfile(), 72), { translate: v(-2.2, 0, 0) }), 1))
  prims.push(...emitMesh(transformMesh(surfaceOfRevolution(gobletProfile(), 72), { translate: v(0.6, 0, -0.4) }), 2))
  prims.push(
    ...emitMesh(
      transformMesh(torus(0.9, 0.3, 56, 28), { translate: v(2.9, 0.95, 0.6), rotate: { axis: v(1, 0.2, 0), angle: 1.4 } }),
      3,
    ),
  )
  // A soft overhead key light (so glass and metal pick up highlights).
  prims.push(...quad(v(-3, 7, -3), v(3, 7, -3), v(3, 7, 3), v(-3, 7, 3), 4))

  return {
    name: 'Revolution',
    materials,
    prims,
    camera: {
      eye: v(0, 2.6, 8.5),
      target: v(0, 1.1, 0),
      up: v(0, 1, 0),
      vfovDeg: 42,
      aperture: 0.04,
      focusDist: 8.6,
    },
    env: { kind: 'sky', sunDir: sunFromAzEl(40, 16), turbidity: 3.2, intensity: 0.7, sunSize: 0.05 },
  }
}

// ---- Scene 10: Custom OBJ — paste-your-own mesh on a turntable ---------------

export function buildCustomScene(objText: string): SceneDef {
  const materials: Material[] = [
    {
      kind: 'diffuse',
      albedo: v(0.8, 0.8, 0.8),
      tex: { kind: 'grid', base: v(0.12, 0.13, 0.16), line: v(0.4, 0.42, 0.5), scale: 0.5, width: 0.03 },
    }, // 0 grid floor
    { kind: 'metal', albedo: v(0.92, 0.78, 0.5), roughness: 0.16 }, // 1 hero metal
  ]
  const prims: PrimDef[] = []
  const g = 50
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))
  let triCount = 0
  try {
    const res = parseObj(objText && objText.trim().length > 0 ? objText : CUBE_OBJ, 1.6)
    // Sit the fitted mesh on the floor (its fit box is centred on the origin).
    const mesh = transformMesh(res.mesh, { translate: v(0, 1.7, 0), rotate: { axis: v(0, 1, 0), angle: 0.5 } })
    prims.push(...emitMesh(mesh, 1))
    triCount = res.faceCount
  } catch {
    // Malformed paste → fall back to the cube so the scene still renders.
    const res = parseObj(CUBE_OBJ, 1.6)
    prims.push(...emitMesh(transformMesh(res.mesh, { translate: v(0, 1.7, 0) }), 1))
  }
  void triCount
  return {
    name: 'Custom OBJ',
    materials,
    prims,
    camera: {
      eye: v(0, 2.4, 7),
      target: v(0, 1.5, 0),
      up: v(0, 1, 0),
      vfovDeg: 44,
      aperture: 0.02,
      focusDist: 7,
    },
    env: { kind: 'sky', sunDir: sunFromAzEl(120, 30), turbidity: 2.4, intensity: 1.0, sunSize: 0.04 },
  }
}

function customScene(): SceneDef {
  return buildCustomScene(CUBE_OBJ)
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
  sky?: boolean // exposes interactive sun/turbidity controls
  obj?: boolean // accepts a pasted OBJ model
}

export const SCENES: ScenePreset[] = [
  { id: 'cornell', label: 'Cornell Box', build: cornell },
  { id: 'weekend', label: 'Weekend Daylight', build: weekend },
  { id: 'gallery', label: 'Material Gallery', build: gallery },
  { id: 'caustic', label: 'Caustic Room', build: causticRoom },
  { id: 'prism', label: 'Prism', build: prismScene },
  { id: 'menagerie', label: 'Glass Menagerie', build: glassMenagerie },
  { id: 'textured', label: 'Textured Studio', build: texturedStudio },
  { id: 'sky', label: 'Sky Studio', build: skyStudio, sky: true },
  { id: 'revolution', label: 'Revolution', build: revolution, sky: true },
  { id: 'custom', label: 'Custom OBJ', build: customScene, sky: true, obj: true },
]

// Re-exports used by the orbit camera helper in the UI.
export const sceneMath = { add, sub, scale, normalize, cross }
