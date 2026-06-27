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
import { conductorF0RGB } from './conductor'
import type { ConductorName } from './conductor'
import { subsurfacePreset } from './subsurface'
import type { MediumName } from './subsurface'
import { blackbodyEmission } from './blackbody'
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

// ---- Scene: Caustic Pool — water caustics on a tiled floor (an SPPM showcase) -

// A wind-rippled water surface as a single refractive sheet: a sine heightfield
// triangulated with *analytic* smooth normals. Light refracting through the
// undulating surface focuses into the shifting bright filaments of a swimming
// pool — a light→specular→diffuse caustic that only photon mapping (SPPM)
// resolves cleanly. The surface is a dielectric; photons emitted from the
// overhead panel bend through it and concentrate on the floor below.
function waterSheet(span: number, y0: number, res: number, amp: number, material: number): PrimDef[] {
  // Two interfering wave trains plus a diagonal ripple — the gradient is known in
  // closed form, so every vertex normal is exact (no finite differencing).
  const k1 = 1.7
  const k2 = 2.3
  const k3 = 1.1
  const height = (x: number, z: number): number =>
    amp * (Math.sin(k1 * x + 0.6) + 0.8 * Math.sin(k2 * z - 0.4) + 0.6 * Math.sin(k3 * (x + z) + 1.3))
  const normalAt = (x: number, z: number): Vec3 => {
    // ∂y/∂x and ∂y/∂z of the heightfield; surface normal = (−∂x, 1, −∂z).
    const dx = amp * (k1 * Math.cos(k1 * x + 0.6) + 0.6 * k3 * Math.cos(k3 * (x + z) + 1.3))
    const dz = amp * (0.8 * k2 * Math.cos(k2 * z - 0.4) + 0.6 * k3 * Math.cos(k3 * (x + z) + 1.3))
    return normalize(v(-dx, 1, -dz))
  }
  const pos = (i: number, j: number): Vec3 => {
    const x = -span + (2 * span * i) / res
    const z = -span + (2 * span * j) / res
    return v(x, y0 + height(x, z), z)
  }
  const tris: PrimDef[] = []
  for (let i = 0; i < res; i++) {
    for (let j = 0; j < res; j++) {
      const p00 = pos(i, j)
      const p10 = pos(i + 1, j)
      const p11 = pos(i + 1, j + 1)
      const p01 = pos(i, j + 1)
      const n00 = normalAt(p00.x, p00.z)
      const n10 = normalAt(p10.x, p10.z)
      const n11 = normalAt(p11.x, p11.z)
      const n01 = normalAt(p01.x, p01.z)
      tris.push({ kind: 'tri', p0: p00, p1: p10, p2: p11, material, n0: n00, n1: n10, n2: n11 })
      tris.push({ kind: 'tri', p0: p00, p1: p11, p2: p01, material, n0: n00, n1: n11, n2: n01 })
    }
  }
  return tris
}

function causticPool(): SceneDef {
  const materials: Material[] = [
    {
      kind: 'diffuse',
      albedo: v(0.8, 0.8, 0.8),
      tex: { kind: 'checker', even: v(0.16, 0.45, 0.62), odd: v(0.78, 0.86, 0.9), scale: 0.6 },
    }, // 0 tiled pool floor
    { kind: 'emissive', emission: v(34, 33, 30) }, // 1 bright overhead sun panel
    { kind: 'dielectric', ior: 1.33, tint: v(0.85, 0.95, 1.0) }, // 2 water
    { kind: 'diffuse', albedo: v(0.22, 0.4, 0.5) }, // 3 pool walls
  ]
  const prims: PrimDef[] = []
  const X = 7
  const Z = 7
  const yFloor = 0
  const yWater = 2.0
  const yTop = 9
  prims.push(...quad(v(-X, yFloor, -Z), v(X, yFloor, -Z), v(X, yFloor, Z), v(-X, yFloor, Z), 0)) // floor
  // Low pool walls (so the floor reads as a basin and bounces a little fill).
  prims.push(...quad(v(-X, yFloor, -Z), v(-X, yFloor, Z), v(-X, yWater + 0.4, Z), v(-X, yWater + 0.4, -Z), 3)) // left
  prims.push(...quad(v(X, yFloor, -Z), v(X, yWater + 0.4, -Z), v(X, yWater + 0.4, Z), v(X, yFloor, Z), 3)) // right
  prims.push(...quad(v(-X, yFloor, Z), v(X, yFloor, Z), v(X, yWater + 0.4, Z), v(-X, yWater + 0.4, Z), 3)) // back
  // The rippled water surface.
  prims.push(...waterSheet(X - 0.05, yWater, 60, 0.12, 2))
  // A bright overhead panel (a triangle light SPPM can emit photons from).
  prims.push(...quad(v(-3.5, yTop, -3.5), v(3.5, yTop, -3.5), v(3.5, yTop, 3.5), v(-3.5, yTop, 3.5), 1))

  return {
    name: 'Caustic Pool',
    materials,
    prims,
    camera: {
      eye: v(0, 6.2, 12.5),
      target: v(0, 1.4, 0),
      up: v(0, 1, 0),
      vfovDeg: 45,
      aperture: 0,
      focusDist: 13,
    },
    env: { kind: 'solid', color: v(0.01, 0.02, 0.03) },
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

// ---- Scene 11: Cathedral — volumetric god rays through haze ------------------

function cathedral(): SceneDef {
  // A tall, dark stone hall filled with a faint forward-scattering haze, lit by a
  // single narrow ceiling slit. The light shaft becomes *visible* where the haze
  // scatters it toward the camera, and a row of pillars breaks it into the
  // banded "god rays" of a cathedral — pure single+multiple scattering, no
  // billboards or fake glow.
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.12, 0.11, 0.1) }, // 0 dark stone walls/ceiling
    { kind: 'emissive', emission: v(26, 22, 16) }, // 1 warm skylight
    { kind: 'diffuse', albedo: v(0.32, 0.31, 0.29) }, // 2 stone floor
    { kind: 'diffuse', albedo: v(0.22, 0.21, 0.2) }, // 3 pillar stone
  ]
  const prims: PrimDef[] = []
  const x0 = -8
  const x1 = 8
  const z0 = -13
  const z1 = 7
  const yT = 15
  prims.push(...quad(v(x0, 0, z0), v(x1, 0, z0), v(x1, 0, z1), v(x0, 0, z1), 2)) // floor
  prims.push(...quad(v(x0, yT, z0), v(x0, yT, z1), v(x1, yT, z1), v(x1, yT, z0), 0)) // ceiling
  prims.push(...quad(v(x0, 0, z0), v(x0, yT, z0), v(x1, yT, z0), v(x1, 0, z0), 0)) // back wall
  prims.push(...quad(v(x0, 0, z1), v(x0, 0, z0), v(x0, yT, z0), v(x0, yT, z1), 0)) // left
  prims.push(...quad(v(x1, 0, z0), v(x1, 0, z1), v(x1, yT, z1), v(x1, yT, z0), 0)) // right
  // Narrow skylight slit in the ceiling (long in z, thin in x), facing down.
  const lh = yT - 0.05
  prims.push(...quad(v(-1.1, lh, -10), v(1.1, lh, -10), v(1.1, lh, 4), v(-1.1, lh, 4), 1))
  // A colonnade: pairs of tall pillars flanking the nave, which carve the shaft
  // into discrete beams and cast long volumetric shadows.
  for (let i = 0; i < 4; i++) {
    const z = -9 + i * 4
    prims.push(...box(v(-3.0, 4, z), v(0.5, 4, 0.5), 0, 3))
    prims.push(...box(v(3.0, 4, z), v(0.5, 4, 0.5), 0, 3))
  }
  // A diffuse sphere on the floor catching the pooled light.
  prims.push({ kind: 'sphere', center: v(0, 1.2, -3), radius: 1.2, material: 2 })

  return {
    name: 'Cathedral',
    materials,
    prims,
    camera: {
      eye: v(0.5, 4.5, 13),
      target: v(0, 5.5, -4),
      up: v(0, 1, 0),
      vfovDeg: 52,
      aperture: 0,
      focusDist: 16,
    },
    env: { kind: 'solid', color: v(0.003, 0.003, 0.005) },
    // Enclosing haze: thin extinction, mildly forward-scattering, so the shaft
    // glows but the rest of the hall stays dark — the contrast that reads as rays.
    media: [{ center: v(0, 6, -3), radius: 24, sigmaT: 0.04, albedo: v(0.86, 0.84, 0.8), g: 0.45 }],
  }
}

// ---- Scene 12: Iridescence — a thin-film thickness sweep ---------------------

function iridescence(): SceneDef {
  // Two rows of thin-film-coated spheres whose only difference is the film
  // thickness. Because reflectance is an interference effect, sweeping thickness
  // sweeps the whole spectrum: soap-bubble pastels, oil-slick greens and golds,
  // beetle-shell blues — all from the same physics that fans a prism's rainbow.
  const materials: Material[] = [
    {
      kind: 'diffuse',
      albedo: v(0.5, 0.5, 0.5),
      tex: { kind: 'checker', even: v(0.06, 0.06, 0.07), odd: v(0.02, 0.02, 0.03), scale: 0.4 },
    }, // 0 near-black checker floor
    { kind: 'emissive', emission: v(5.5, 5.5, 5.8) }, // 1 soft overhead light
  ]
  const prims: PrimDef[] = []
  const g = 30
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))

  const cols = 7
  const span = (i: number): number => (i - (cols - 1) / 2) * 2.3
  // Front row: film on a dense, mirror-like substrate (vivid, high-contrast sheen).
  for (let i = 0; i < cols; i++) {
    materials.push({ kind: 'thinfilm', thickness: 180 + i * 75, filmIor: 1.45, baseIor: 2.5 })
    prims.push({ kind: 'sphere', center: v(span(i), 1, 1.6), radius: 1, material: materials.length - 1 })
  }
  // Back row: film over a warm metallic base tint (anodised-titanium look).
  for (let i = 0; i < cols; i++) {
    materials.push({
      kind: 'thinfilm',
      thickness: 520 - i * 60,
      filmIor: 1.35,
      baseIor: 2.0,
      base: v(0.95, 0.86, 0.7),
    })
    prims.push({ kind: 'sphere', center: v(span(i), 1.15, -2.0), radius: 1.15, material: materials.length - 1 })
  }
  // Two soft overhead panels so the iridescence is read across a range of angles.
  prims.push(...quad(v(-9, 9, -6), v(9, 9, -6), v(9, 9, 0), v(-9, 9, 0), 1))
  prims.push(...quad(v(-9, 9, 0.5), v(9, 9, 0.5), v(9, 9, 6), v(-9, 9, 6), 1))

  return {
    name: 'Iridescence',
    materials,
    prims,
    camera: {
      eye: v(0, 3.6, 12),
      target: v(0, 1, -0.2),
      up: v(0, 1, 0),
      vfovDeg: 40,
      aperture: 0.03,
      focusDist: 12,
    },
    // A soft studio backdrop (not black): a thin-film sphere reflects the whole
    // surround, and each viewing angle samples a different film angle, so the
    // iridescence reads as a full rainbow across the ball, not just at highlights.
    env: { kind: 'gradient', top: v(0.24, 0.26, 0.32), bottom: v(0.09, 0.095, 0.11) },
  }
}

// ---- Scene 13: Nebula — a coloured scattering orb beside iridescent glass -----

function nebula(): SceneDef {
  // A dense, coloured single-scattering volume — a glowing cloud — flanked by two
  // coloured key lights, with a thin-film sphere nearby picking up the coloured
  // illumination as a metallic sheen. The orb is lit purely by light scattering
  // through its own body, so it self-shadows and glows from within.
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.08, 0.08, 0.1) }, // 0 dark floor
    { kind: 'emissive', emission: v(44, 12, 58) }, // 1 magenta key
    { kind: 'emissive', emission: v(9, 30, 48) }, // 2 cyan key
    { kind: 'thinfilm', thickness: 360, filmIor: 1.4, baseIor: 2.4 }, // 3 iridescent sphere
  ]
  const prims: PrimDef[] = []
  const g = 40
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))
  // Two coloured area lights flanking the orb.
  prims.push(...quad(v(-6.5, 0.5, -3), v(-6.5, 0.5, 3), v(-6.5, 6.5, 3), v(-6.5, 6.5, -3), 1)) // left magenta
  prims.push(...quad(v(6.5, 6.5, -3), v(6.5, 6.5, 3), v(6.5, 0.5, 3), v(6.5, 0.5, -3), 2)) // right cyan
  // The iridescent sphere off to the side.
  prims.push({ kind: 'sphere', center: v(3.0, 1.3, 1.2), radius: 1.3, material: 3 })

  return {
    name: 'Nebula',
    materials,
    prims,
    camera: {
      eye: v(0, 2.6, 10),
      target: v(-0.4, 2.0, 0),
      up: v(0, 1, 0),
      vfovDeg: 42,
      aperture: 0.04,
      focusDist: 10,
    },
    env: { kind: 'solid', color: v(0.01, 0.01, 0.02) },
    // A dense, slightly forward cloud with a cool-violet single-scattering albedo.
    media: [{ center: v(-1.6, 2.4, 0), radius: 2.0, sigmaT: 1.15, albedo: v(0.74, 0.58, 0.88), g: 0.35 }],
  }
}

// ---- Scene 14: Cumulus — a sunlit procedural cloud (heterogeneous media) -----

function cumulus(): SceneDef {
  // A single fluffy fBm cloud floating over a hazy plain under the analytic sky.
  // The cloud is a *heterogeneous* medium: its extinction varies continuously
  // through space (delta tracking), so it self-shadows into soft grey undersides
  // and — because the droplets scatter strongly forward (g≈0.6) — flares into a
  // bright "silver lining" where the sun sits just behind a billow. Nudge the sun
  // azimuth/elevation to walk the highlight around the cloud, and the Cloud-
  // coverage knob to puff it up or break it into scattered cumulus.
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.46, 0.5, 0.42) }, // 0 distant ground
  ]
  const prims: PrimDef[] = []
  const g = 400
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))
  return {
    name: 'Cumulus',
    materials,
    prims,
    camera: {
      eye: v(0, 5.5, 22),
      target: v(0, 7.5, 0),
      up: v(0, 1, 0),
      vfovDeg: 46,
      aperture: 0,
      focusDist: 22,
    },
    env: { kind: 'sky', sunDir: sunFromAzEl(155, 22), turbidity: 2.4, intensity: 1.0, sunSize: 0.04 },
    media: [
      {
        center: v(0, 8.5, 0),
        radius: 7.5,
        sigmaT: 3.2, // majorant extinction (dense core reads as a solid cloud)
        albedo: v(0.96, 0.97, 1.0), // near-lossless scattering → bright cloud
        g: 0.6, // forward scattering → silver lining toward the sun
        density: {
          kind: 'fbm',
          frequency: 0.34,
          octaves: 5,
          lacunarity: 2.1,
          gain: 0.55,
          coverage: 0.46,
          edge: 0.55, // soft round envelope, no hard rim
          warp: 1.1, // curl the billows
          seed: 7,
        },
      },
    ],
  }
}

// ---- Scene 15: Smoke Plume — a rising, self-shadowing column (heterogeneous) --

function smokePlume(): SceneDef {
  // A dark smoke column rising off a dim floor, lit hard from the right by a warm
  // panel. The medium is an fBm field with a strong upward density bias, so it is
  // thick and opaque at the base and dissipates into thinning wisps as it rises —
  // and because the albedo is low (sooty smoke absorbs most of what it scatters),
  // it self-shadows into deep, volumetric darks with a bright lit edge.
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.16, 0.16, 0.18) }, // 0 dim floor
    { kind: 'emissive', emission: v(60, 46, 28) }, // 1 warm key panel
    { kind: 'diffuse', albedo: v(0.05, 0.05, 0.06) }, // 2 dark backdrop
  ]
  const prims: PrimDef[] = []
  const g = 30
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))
  // A tall dark backdrop behind the plume to read the wisps against.
  prims.push(...quad(v(-g, 0, -12), v(g, 0, -12), v(g, 30, -12), v(-g, 30, -12), 2))
  // A bright warm panel on the right, facing left into the smoke.
  prims.push(...quad(v(9, 1.5, -3), v(9, 1.5, 3), v(9, 11, 3), v(9, 11, -3), 1))
  return {
    name: 'Smoke Plume',
    materials,
    prims,
    camera: {
      eye: v(-2.5, 6.5, 18),
      target: v(0, 6.0, 0),
      up: v(0, 1, 0),
      vfovDeg: 48,
      aperture: 0,
      focusDist: 18,
    },
    env: { kind: 'solid', color: v(0.01, 0.011, 0.014) },
    media: [
      {
        center: v(0, 6, 0),
        radius: 6.5,
        sigmaT: 6.0,
        albedo: v(0.34, 0.33, 0.32), // sooty: mostly absorbing
        g: 0.1,
        density: {
          kind: 'fbm',
          frequency: 0.42,
          octaves: 6,
          lacunarity: 2.0,
          gain: 0.55,
          coverage: 0.42,
          edge: 0.4,
          verticalBias: 0.26, // thick at the base, thinning as it rises
          warp: 1.4, // turbulent curls
          seed: 19,
        },
      },
    ],
  }
}

// ---- Scene 16: Drifting Fog — an exponential ground-fog layer + god rays ------

function driftingFog(): SceneDef {
  // A low bank of ground fog pooling in a colonnade, lit by a single overhead
  // skylight slit. The medium's density is an *exponential vertical layer* —
  // dense at the floor, fading with height — so the light shaft passes through
  // clear air above and only ignites into a visible beam where it grazes the fog
  // top, and the pillars carve it into banded god-rays that pool along the floor.
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.3, 0.29, 0.27) }, // 0 stone floor
    { kind: 'diffuse', albedo: v(0.1, 0.095, 0.09) }, // 1 dark walls/ceiling
    { kind: 'emissive', emission: v(85, 74, 56) }, // 2 warm skylight
    { kind: 'diffuse', albedo: v(0.2, 0.19, 0.18) }, // 3 pillar stone
  ]
  const prims: PrimDef[] = []
  const x0 = -8
  const x1 = 8
  const z0 = -13
  const z1 = 7
  const yT = 14
  prims.push(...quad(v(x0, 0, z0), v(x1, 0, z0), v(x1, 0, z1), v(x0, 0, z1), 0)) // floor
  prims.push(...quad(v(x0, yT, z0), v(x0, yT, z1), v(x1, yT, z1), v(x1, yT, z0), 1)) // ceiling
  prims.push(...quad(v(x0, 0, z0), v(x0, yT, z0), v(x1, yT, z0), v(x1, 0, z0), 1)) // back
  prims.push(...quad(v(x0, 0, z1), v(x0, 0, z0), v(x0, yT, z0), v(x0, yT, z1), 1)) // left
  prims.push(...quad(v(x1, 0, z0), v(x1, 0, z1), v(x1, yT, z1), v(x1, yT, z0), 1)) // right
  const lh = yT - 0.05
  prims.push(...quad(v(-1.2, lh, -9), v(1.2, lh, -9), v(1.2, lh, 4), v(-1.2, lh, 4), 2)) // skylight slit
  // Colonnade — pairs of pillars to break the shaft into beams.
  for (let i = 0; i < 4; i++) {
    const z = -9 + i * 4
    prims.push(...box(v(-3.0, 4, z), v(0.5, 4, 0.5), 0, 3))
    prims.push(...box(v(3.0, 4, z), v(0.5, 4, 0.5), 0, 3))
  }
  return {
    name: 'Drifting Fog',
    materials,
    prims,
    camera: {
      eye: v(0.5, 3.0, 13),
      target: v(0, 2.2, -4),
      up: v(0, 1, 0),
      vfovDeg: 54,
      aperture: 0,
      focusDist: 16,
    },
    env: { kind: 'solid', color: v(0.003, 0.003, 0.005) },
    media: [
      {
        center: v(0, 4, -3),
        radius: 22,
        sigmaT: 0.55, // majorant; the layer profile keeps most of the volume thin
        albedo: v(0.9, 0.89, 0.86),
        g: 0.5, // forward-scattering haze → bright beams toward the light
        density: {
          kind: 'layer',
          base: 0.4, // fog floor a touch above the ground
          scaleHeight: 1.4, // e-folding height — a low bank
          noiseAmount: 0.55, // lumpy, drifting fog
          frequency: 0.35,
          seed: 5,
        },
      },
    ],
  }
}

// ---- Scene 17: Ember — a self-luminous volumetric fireball (emissive media) --

function emberCloud(): SceneDef {
  // A glowing ember/fireball floating in a dark room: a heterogeneous fBm medium
  // that *emits* light volumetrically. At every real collision the path picks up
  // (1−albedo)·emission of warm self-radiance, and because delta tracking makes
  // collisions density-proportional, the glow pools in the dense core and fades
  // through the wisps at the edges — a soft, physically integrated fire, not a
  // billboard. The faint floor catches the spill from the lower scattering lobe.
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.18, 0.13, 0.1) }, // 0 dim warm floor
  ]
  const prims: PrimDef[] = []
  const g = 60
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))
  return {
    name: 'Ember',
    materials,
    prims,
    camera: {
      eye: v(0, 4.0, 15),
      target: v(0, 4.2, 0),
      up: v(0, 1, 0),
      vfovDeg: 46,
      aperture: 0,
      focusDist: 15,
    },
    env: { kind: 'solid', color: v(0.006, 0.004, 0.006) },
    media: [
      {
        center: v(0, 4.2, 0),
        radius: 3.4,
        sigmaT: 4.5, // many collisions ⇒ a bright, opaque core
        albedo: v(0.22, 0.14, 0.1), // sooty, slightly warm scattering
        g: 0.3,
        emission: v(7.0, 2.6, 0.7), // warm blackbody glow (orange → yellow core)
        density: {
          kind: 'fbm',
          frequency: 0.5,
          octaves: 5,
          lacunarity: 2.1,
          gain: 0.55,
          coverage: 0.4,
          edge: 0.5,
          verticalBias: 0.16, // a touch denser low, thinning upward like flame
          warp: 1.3,
          seed: 11,
        },
      },
    ],
  }
}

// ---- Scene: Rayleigh Haze — a chromatic atmosphere (16.0) -------------------

// Why the sky is blue and the setting sun is red, in one scene. A bright warm
// sun-disc sits far behind a large homogeneous scattering haze whose extinction is
// strongly **chromatic** — blue is scattered out of the beam many times more than
// red (a Rayleigh-like σ_t ∝ ~1/λ⁴, approximated at the R/G/B wavelengths). Looking
// straight at the sun *through* the haze, the blue is stripped away and the disc
// reddens to a deep orange (transmission); everywhere else the haze glows a cool
// blue from the single-scattered light it stole (in-scatter). One scalar σ_t could
// never do this — the colour is the wavelength dependence of the extinction itself.
function rayleighHaze(): SceneDef {
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.12, 0.12, 0.14), sigma: 0.5 }, // 0 dim floor
    { kind: 'emissive', emission: v(34, 30, 24) }, // 1 the sun disc (warm, very bright)
  ]
  const prims: PrimDef[] = []
  const g = 60
  prims.push(...quad(v(-g, -6, -g), v(g, -6, -g), v(g, -6, g), v(-g, -6, g), 0))
  // The sun, a large bright panel far behind the haze, facing the camera.
  prims.push(...quad(v(-6, 1, -22), v(6, 1, -22), v(6, 13, -22), v(-6, 13, -22), 1))
  return {
    name: 'Rayleigh Haze',
    materials,
    prims,
    camera: { eye: v(0, 4, 20), target: v(0, 5.5, -22), up: v(0, 1, 0), vfovDeg: 46, aperture: 0, focusDist: 42 },
    env: { kind: 'gradient', top: v(0.02, 0.03, 0.06), bottom: v(0.02, 0.025, 0.035) },
    media: [
      {
        center: v(0, 5, -4),
        radius: 17,
        sigmaT: 0.16, // scalar fallback (channel-mean-ish) for non-spectral integrators
        // Rayleigh-like: blue scattered far more than red (∝ ~1/λ⁴ at 650/550/450 nm).
        sigmaTSpectral: v(0.055, 0.13, 0.36),
        albedo: v(1, 1, 1), // pure scattering — energy only redistributed
        g: 0.0,
      },
    ],
  }
}

// ---- Scene: Amber Smoke — a chromatic heterogeneous plume (16.0) ------------

// A rising fBm smoke column whose extinction is chromatic: red passes through it
// far more freely than blue, so where a grey smoke would read sooty neutral this
// one glows a warm amber in its lit, thinner reaches and turns teal-shadowed in its
// dense core — the colour emerging from delta/ratio tracking at the path's hero
// wavelength, not from a tinted albedo. Lit hard from the right against a dark
// backdrop, side by side with the achromatic Smoke Plume for contrast.
function amberSmoke(): SceneDef {
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.14, 0.14, 0.15) }, // 0 dim floor
    { kind: 'emissive', emission: v(70, 58, 40) }, // 1 warm key panel
    { kind: 'diffuse', albedo: v(0.04, 0.04, 0.05) }, // 2 dark backdrop
  ]
  const prims: PrimDef[] = []
  const g = 30
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))
  prims.push(...quad(v(-g, 0, -12), v(g, 0, -12), v(g, 30, -12), v(-g, 30, -12), 2))
  prims.push(...quad(v(9, 1.5, -3), v(9, 1.5, 3), v(9, 11, 3), v(9, 11, -3), 1))
  return {
    name: 'Amber Smoke',
    materials,
    prims,
    camera: { eye: v(-2.5, 6.5, 18), target: v(0, 6.0, 0), up: v(0, 1, 0), vfovDeg: 48, aperture: 0, focusDist: 18 },
    env: { kind: 'solid', color: v(0.01, 0.011, 0.014) },
    media: [
      {
        center: v(0, 6, 0),
        radius: 6.5,
        sigmaT: 4.4, // scalar fallback (channel mean)
        sigmaTSpectral: v(2.6, 4.6, 6.0), // red penetrates; blue/green scattered & absorbed near the surface
        albedo: v(0.6, 0.6, 0.6), // neutral grey albedo — the hue is purely the chromatic extinction
        g: 0.15,
        density: {
          kind: 'fbm',
          frequency: 0.42,
          octaves: 6,
          lacunarity: 2.0,
          gain: 0.55,
          coverage: 0.42,
          edge: 0.4,
          verticalBias: 0.26,
          warp: 1.4,
          seed: 23,
        },
      },
    ],
  }
}

// ---- Scene: Cove — an indirect-lit room (a BDPT showcase) -------------------

// A neutral room whose only emitter is a small, bright strip tucked *above* a
// baffle and aimed at the ceiling. Nothing in the room can see the light: a
// next-event shadow ray from any floor/wall point is blocked by the baffle, and
// the light is one-sided (it faces up), so the room is lit *entirely* by light
// that bounces off the ceiling and back down — the textbook regime where a
// unidirectional path tracer's NEE is useless and only lucky multi-bounce BSDF
// paths find the light. Bidirectional path tracing carries radiance out of the
// cove along the light subpath and connects it straight to the camera vertices,
// so the same sample budget renders dramatically cleaner. Switch the Integrator
// control between Path Tracer and Bidirectional to see the difference.
function cove(): SceneDef {
  const W = 10
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.74, 0.73, 0.70) }, // 0 neutral shell
    { kind: 'diffuse', albedo: v(0.62, 0.11, 0.10) }, // 1 red wall
    { kind: 'diffuse', albedo: v(0.12, 0.31, 0.54) }, // 2 blue wall
    { kind: 'emissive', emission: v(230, 195, 140) }, // 3 hidden warm uplight (small + bright)
    { kind: 'diffuse', albedo: v(0.88, 0.88, 0.9) }, // 4 baffle (hides the light)
    { kind: 'metal', albedo: v(0.96, 0.94, 0.9), roughness: 0.16 }, // 5 glossy sphere
    { kind: 'diffuse', albedo: v(0.83, 0.78, 0.5) }, // 6 warm pedestal
  ]
  const prims: PrimDef[] = []
  // Shell: floor, ceiling, back, and two coloured side walls (open toward camera).
  prims.push(...quad(v(0, 0, 0), v(W, 0, 0), v(W, 0, W), v(0, 0, W), 0)) // floor
  prims.push(...quad(v(0, W, 0), v(0, W, W), v(W, W, W), v(W, W, 0), 0)) // ceiling
  prims.push(...quad(v(0, 0, W), v(W, 0, W), v(W, W, W), v(0, W, W), 0)) // back
  prims.push(...quad(v(0, 0, 0), v(0, 0, W), v(0, W, W), v(0, W, 0), 1)) // left red
  prims.push(...quad(v(W, 0, 0), v(W, W, 0), v(W, W, W), v(W, 0, W), 2)) // right blue
  // The cove: a baffle shelf just under the ceiling, with the emitter strip on
  // top of it facing straight up. The baffle is wider than the strip, so the
  // strip is invisible (and unsamplable by NEE) from anywhere in the room below.
  const by = 8.3
  prims.push(...quad(v(1.2, by, 5.4), v(8.8, by, 5.4), v(8.8, by, 9.4), v(1.2, by, 9.4), 4)) // baffle (down-facing winding)
  prims.push(...quad(v(1.2, by, 5.4), v(1.2, by, 9.4), v(8.8, by, 9.4), v(8.8, by, 5.4), 4)) // baffle (up-facing winding) — two-sided
  const ey = 8.55
  // Emitter strip, wound so its geometric normal points +y (up, toward ceiling).
  // Small + bright: hard for the path tracer to hit, easy for the light subpath.
  prims.push(...quad(v(3.9, ey, 7.2), v(3.9, ey, 8.6), v(6.1, ey, 8.6), v(6.1, ey, 7.2), 3))
  // A couple of objects to catch the soft bounced light.
  prims.push({ kind: 'sphere', center: v(6.7, 1.6, 4.0), radius: 1.6, material: 5 })
  prims.push(...box(v(3.0, 1.1, 5.4), v(1.1, 1.1, 1.1), 0.5, 6)) // pedestal block
  return {
    name: 'Cove',
    materials,
    prims,
    camera: {
      eye: v(5, 4.4, -7.2),
      target: v(5, 3.6, 5),
      up: v(0, 1, 0),
      vfovDeg: 46,
      aperture: 0,
      focusDist: 12,
    },
    env: { kind: 'solid', color: v(0, 0, 0) },
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

// ---- Scene 11: Spectral Caustic — rainbow caustics (a spectral-SPPM showcase) -

// A dense, dispersive glass sphere and a glass prism above a white catch-floor in
// an otherwise dark room, lit by one small bright panel. Under the Photon Map
// integrator, photons commit a hero wavelength on the glass and refract per
// colour, so the focused caustic on the floor fans into a *rainbow* — the
// daylight-prism effect, but as a caustic the other integrators cannot resolve.
function spectralCaustic(): SceneDef {
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.86, 0.86, 0.88) }, // 0 white catch floor
    { kind: 'diffuse', albedo: v(0.04, 0.04, 0.05) }, // 1 dark surrounds
    { kind: 'emissive', emission: v(170, 158, 140) }, // 2 small bright panel
    // Dense flint-style glass with strong Cauchy dispersion → a wide rainbow.
    { kind: 'dielectric', ior: 1.62, tint: v(1, 1, 1), cauchyB: 0.02 }, // 3 dispersive glass
  ]
  const X = 6
  const Y = 8
  const Z = 6
  const prims: PrimDef[] = []
  prims.push(...quad(v(-X, 0, -Z), v(X, 0, -Z), v(X, 0, Z), v(-X, 0, Z), 0)) // white floor
  prims.push(...quad(v(-X, Y, -Z), v(-X, Y, Z), v(X, Y, Z), v(X, Y, -Z), 1)) // dark ceiling
  prims.push(...quad(v(-X, 0, Z), v(X, 0, Z), v(X, Y, Z), v(-X, Y, Z), 1)) // dark back
  prims.push(...quad(v(-X, 0, -Z), v(-X, 0, Z), v(-X, Y, Z), v(-X, Y, -Z), 1)) // dark left
  prims.push(...quad(v(X, 0, -Z), v(X, Y, -Z), v(X, Y, Z), v(X, 0, Z), 1)) // dark right
  const lh = Y - 0.02
  prims.push(...quad(v(-0.7, lh, -0.7), v(0.7, lh, -0.7), v(0.7, lh, 0.7), v(-0.7, lh, 0.7), 2)) // panel
  prims.push({ kind: 'sphere', center: v(-1.7, 2.2, 0.2), radius: 1.25, material: 3 }) // dispersive lens
  prims.push(...prism(2.4, 1.4, 0.0, 0.9, 3)) // dispersive prism
  return {
    name: 'Spectral Caustic',
    materials,
    prims,
    camera: {
      eye: v(0, 5.6, -9),
      target: v(-0.3, 0.6, 0.4),
      up: v(0, 1, 0),
      vfovDeg: 46,
      aperture: 0,
      focusDist: 9,
    },
    env: { kind: 'solid', color: v(0, 0, 0) },
  }
}

// ---- Scene 12: Daylight Lens — a sun caustic (an environment-photon showcase) -

// A glass sphere and a gold torus on a tiled floor under the analytic sky. The
// sun is a *distant* light, so the caustic it focuses through the glass onto the
// floor is a light→specular→diffuse path next-event estimation cannot sample —
// only environment photons, emitted from the sun disc, resolve it. Best viewed
// with the Photon Map integrator.
function daylightLens(): SceneDef {
  const materials: Material[] = [
    {
      kind: 'diffuse',
      albedo: v(0.85, 0.85, 0.86),
      tex: { kind: 'checker', even: v(0.82, 0.82, 0.84), odd: v(0.34, 0.36, 0.4), scale: 0.7 },
    }, // 0 tiled floor
    { kind: 'dielectric', ior: 1.5, tint: v(1, 1, 1) }, // 1 clear glass
    { kind: 'metal', albedo: v(0.97, 0.79, 0.4), roughness: 0.1 }, // 2 gold torus
  ]
  const prims: PrimDef[] = []
  const g = 40
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))
  prims.push({ kind: 'sphere', center: v(-1.6, 1.5, 0), radius: 1.5, material: 1 }) // glass lens
  prims.push(
    ...emitMesh(
      transformMesh(torus(1.0, 0.36, 56, 28), { translate: v(2.4, 1.0, 0.3), rotate: { axis: v(1, 0, 0.3), angle: 1.1 } }),
      2,
    ),
  )
  return {
    name: 'Daylight Lens',
    materials,
    prims,
    camera: {
      eye: v(0, 3.4, 10),
      target: v(-0.4, 0.4, 0),
      up: v(0, 1, 0),
      vfovDeg: 42,
      aperture: 0,
      focusDist: 10,
    },
    env: { kind: 'sky', sunDir: sunFromAzEl(150, 38), turbidity: 2.2, intensity: 1.0, sunSize: 0.035 },
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

// ---- Material lab scenes (Lumen 10.0) ---------------------------------------

// A neutral studio: a large soft area light overhead and a matte floor, used by
// the three material-lab scenes so the new BSDFs are compared under identical,
// physically meaningful lighting.
function studioShell(floorMat: Material): { materials: Material[]; prims: PrimDef[]; light: number } {
  const materials: Material[] = [floorMat]
  const prims: PrimDef[] = []
  const g = 40
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))
  materials.push({ kind: 'emissive', emission: v(5.5, 5.5, 5.6) })
  const light = materials.length - 1
  prims.push(...quad(v(-7, 11, -5), v(7, 11, -5), v(7, 11, 7), v(-7, 11, 7), light))
  return { materials, prims, light }
}

// Brushed metal: a row of spheres whose anisotropy ramps 0 → ~0.95, each rotated
// so the streak highlight rakes a different way — the signature of milled/brushed
// metal that an isotropic GGX lobe simply cannot produce.
function brushedMetal(): SceneDef {
  const { materials, prims } = studioShell({ kind: 'diffuse', albedo: v(0.06, 0.06, 0.07) })
  const cols = 6
  const steel = v(0.95, 0.95, 0.97)
  for (let i = 0; i < cols; i++) {
    const aniso = (i / (cols - 1)) * 0.95
    materials.push({
      kind: 'metal',
      albedo: steel,
      roughness: 0.32,
      aniso,
      anisoAngle: (i / cols) * Math.PI,
    })
    const mat = materials.length - 1
    prims.push({ kind: 'sphere', center: v((i - (cols - 1) / 2) * 2.5, 1.1, 0), radius: 1.1, material: mat })
  }
  // A back row of brushed copper discs (spheres) with a fixed strong anisotropy
  // but sweeping orientation, to show the highlight rotate.
  const copper = v(0.95, 0.64, 0.45)
  for (let i = 0; i < cols; i++) {
    materials.push({ kind: 'metal', albedo: copper, roughness: 0.22, aniso: 0.9, anisoAngle: (i / cols) * Math.PI })
    const mat = materials.length - 1
    prims.push({ kind: 'sphere', center: v((i - (cols - 1) / 2) * 2.5, 0.8, -3.4), radius: 0.8, material: mat })
  }
  return {
    name: 'Brushed Metal',
    materials,
    prims,
    camera: { eye: v(0, 4.2, 12), target: v(0, 1, -1), up: v(0, 1, 0), vfovDeg: 40, aperture: 0.04, focusDist: 12 },
    env: { kind: 'gradient', top: v(0.16, 0.18, 0.24), bottom: v(0.03, 0.03, 0.04) },
  }
}

// Energy comparison: two rows of identical gold spheres at rising roughness — the
// back row single-scatter (darkening as it roughens), the front row with
// Kulla–Conty multiscatter (staying bright and saturated). The visible split is
// the energy the multiscatter lobe puts back.
function roughConductors(): SceneDef {
  const { materials, prims } = studioShell({ kind: 'diffuse', albedo: v(0.5, 0.5, 0.52) })
  const cols = 6
  const gold = v(1.0, 0.77, 0.34)
  for (let i = 0; i < cols; i++) {
    const r = 0.15 + (i / (cols - 1)) * 0.85
    materials.push({ kind: 'metal', albedo: gold, roughness: r }) // single-scatter
    const ss = materials.length - 1
    prims.push({ kind: 'sphere', center: v((i - (cols - 1) / 2) * 2.5, 1.0, -3.0), radius: 1.0, material: ss })
    materials.push({ kind: 'metal', albedo: gold, roughness: r, multiscatter: true }) // compensated
    const ms = materials.length - 1
    prims.push({ kind: 'sphere', center: v((i - (cols - 1) / 2) * 2.5, 1.0, 0.6), radius: 1.0, material: ms })
  }
  return {
    name: 'Rough Conductors',
    materials,
    prims,
    camera: { eye: v(0, 5, 13), target: v(0, 0.9, -1), up: v(0, 1, 0), vfovDeg: 40, aperture: 0, focusDist: 13 },
    env: { kind: 'gradient', top: v(0.45, 0.5, 0.6), bottom: v(0.2, 0.22, 0.26) },
  }
}

// Ceramics & clay: a front row of clear-coated (lacquered/glazed) colour spheres
// — a sharp white gloss floating over saturated pigment — beside a back row of
// Oren–Nayar matte clay (chalky, flat, no specular). The contrast shows the
// layered coat and the rough-diffuse model side by side.
function ceramics(): SceneDef {
  const { materials, prims } = studioShell({ kind: 'diffuse', albedo: v(0.22, 0.2, 0.18), sigma: 0.7 })
  const cols = 6
  for (let i = 0; i < cols; i++) {
    const hue = i / cols
    materials.push({ kind: 'diffuse', albedo: hsv(hue, 0.75, 0.55), coat: { roughness: 0.06, ior: 1.5 } })
    const glazed = materials.length - 1
    prims.push({ kind: 'sphere', center: v((i - (cols - 1) / 2) * 2.4, 1.0, 0.4), radius: 1.0, material: glazed })
    materials.push({ kind: 'diffuse', albedo: hsv(hue, 0.45, 0.7), sigma: 0.8 })
    const clay = materials.length - 1
    prims.push({ kind: 'sphere', center: v((i - (cols - 1) / 2) * 2.4, 1.0, -3.0), radius: 1.0, material: clay })
  }
  return {
    name: 'Ceramics & Clay',
    materials,
    prims,
    camera: { eye: v(0, 4.8, 12.5), target: v(0, 0.9, -1), up: v(0, 1, 0), vfovDeg: 40, aperture: 0.03, focusDist: 12.5 },
    env: { kind: 'gradient', top: v(0.2, 0.23, 0.3), bottom: v(0.05, 0.06, 0.08) },
  }
}

// Metals of the World — the six measured conductors (gold, copper, silver,
// aluminium, chromium, iron) as a front row of glossy spheres under the analytic
// Preetham sky, where the warm sun and broad skylight reveal each metal's true
// spectral hue (gold/copper warm, silver/aluminium bright-neutral, iron/chromium
// grey). The back row shows the complex-IOR Fresnel composed with the other
// material upgrades: brushed (anisotropic) gold, multiscatter-compensated rough
// copper, and a smooth silver mirror — proving the new physical Fresnel rides on
// every existing lobe at once.
function metalsOfTheWorld(): SceneDef {
  const materials: Material[] = [{ kind: 'diffuse', albedo: v(0.32, 0.33, 0.35), sigma: 0.4 }]
  const prims: PrimDef[] = []
  const g = 60
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))

  const names: ConductorName[] = ['gold', 'copper', 'silver', 'aluminium', 'chromium', 'iron']
  const cols = names.length
  for (let i = 0; i < cols; i++) {
    const name = names[i]
    materials.push({ kind: 'metal', albedo: conductorF0RGB(name), roughness: 0.12, spectrum: name })
    prims.push({ kind: 'sphere', center: v((i - (cols - 1) / 2) * 2.5, 1.1, 0), radius: 1.1, material: materials.length - 1 })
  }
  materials.push({
    kind: 'metal',
    albedo: conductorF0RGB('gold'),
    roughness: 0.3,
    spectrum: 'gold',
    aniso: 0.85,
    anisoAngle: 0.4,
  })
  prims.push({ kind: 'sphere', center: v(-3.2, 0.85, -3.7), radius: 0.85, material: materials.length - 1 })
  materials.push({ kind: 'metal', albedo: conductorF0RGB('copper'), roughness: 0.55, spectrum: 'copper', multiscatter: true })
  prims.push({ kind: 'sphere', center: v(0, 0.85, -3.7), radius: 0.85, material: materials.length - 1 })
  materials.push({ kind: 'metal', albedo: conductorF0RGB('silver'), roughness: 0.02, spectrum: 'silver' })
  prims.push({ kind: 'sphere', center: v(3.2, 0.85, -3.7), radius: 0.85, material: materials.length - 1 })

  return {
    name: 'Metals of the World',
    materials,
    prims,
    camera: { eye: v(0, 4.5, 13), target: v(0, 1.0, -1), up: v(0, 1, 0), vfovDeg: 40, aperture: 0.03, focusDist: 13 },
    env: { kind: 'sky', sunDir: sunFromAzEl(140, 26), turbidity: 2.4, intensity: 1.0, sunSize: 0.04 },
  }
}

// ---- Subsurface scattering (Lumen 12.0) -------------------------------------

// A translucent dielectric: clear glass of index `ior` whose interior is a
// scattering medium, so light refracts in, random-walks among the scatterers, and
// glows back out. `tint` stays white — the colour comes entirely from the
// interior single-scattering albedo (1−albedo is absorbed per collision).
function translucent(ior: number, sigmaT: number, albedo: Vec3, g: number, roughness = 0): Material {
  return { kind: 'dielectric', ior, tint: v(1, 1, 1), roughness, interior: { sigmaT, albedo, g } }
}

// Subsurface Studio — a row of translucent spheres (marble, jade, honey-wax,
// rose-quartz) strongly *back-lit* so light bleeds through each one: the
// unmistakable subsurface glow that an opaque BRDF can never fake — the rim stays
// lit and the shadow side is warmed from within. The colour of each is set by its
// interior albedo, not a surface pigment. Raise **Max Depth** for a creamier,
// deeper-penetrating, milkier look (every interior scatter is one path bounce, so
// a higher budget lets light walk further before it is cut off).
function subsurfaceStudio(): SceneDef {
  const materials: Material[] = [{ kind: 'diffuse', albedo: v(0.26, 0.26, 0.29), sigma: 0.5 }]
  const prims: PrimDef[] = []
  const g = 40
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))
  // A bright warm back-light low behind the row → transmission through the spheres.
  materials.push({ kind: 'emissive', emission: v(7.5, 6.9, 6.1) })
  const back = materials.length - 1
  prims.push(...quad(v(-10, 0.15, -6), v(10, 0.15, -6), v(10, 6, -6), v(-10, 6, -6), back))
  // A soft cool key from high in front to read the surface form.
  materials.push({ kind: 'emissive', emission: v(2.0, 2.2, 2.7) })
  const key = materials.length - 1
  prims.push(...quad(v(-7, 12, 3), v(7, 12, 3), v(7, 12, 10), v(-7, 12, 10), key))

  const specs: { ior: number; sigmaT: number; albedo: Vec3; g: number }[] = [
    { ior: 1.46, sigmaT: 1.2, albedo: v(0.93, 0.92, 0.9), g: 0.35 }, // marble
    { ior: 1.5, sigmaT: 1.0, albedo: v(0.36, 0.8, 0.52), g: 0.6 }, // jade
    { ior: 1.44, sigmaT: 0.85, albedo: v(0.96, 0.74, 0.42), g: 0.78 }, // honey wax
    { ior: 1.4, sigmaT: 1.4, albedo: v(0.94, 0.56, 0.55), g: 0.5 }, // rose quartz / skin
  ]
  const n = specs.length
  for (let i = 0; i < n; i++) {
    const s = specs[i]
    materials.push(translucent(s.ior, s.sigmaT, s.albedo, s.g))
    prims.push({ kind: 'sphere', center: v((i - (n - 1) / 2) * 2.6, 1.1, 0), radius: 1.1, material: materials.length - 1 })
  }
  return {
    name: 'Subsurface Studio',
    materials,
    prims,
    camera: { eye: v(0, 3.0, 11), target: v(0, 1.0, -1), up: v(0, 1, 0), vfovDeg: 40, aperture: 0.03, focusDist: 11 },
    env: { kind: 'gradient', top: v(0.04, 0.045, 0.06), bottom: v(0.015, 0.015, 0.02) },
  }
}

// A solid, closed, organic lathe form (egg → waist → flared lip → base), r = 0 at
// both poles so the revolved mesh is a *watertight solid* the subsurface walk can
// fill and be bounded by.
function idolProfile(): { r: number; y: number }[] {
  return [
    { r: 0.0, y: 0.0 },
    { r: 0.62, y: 0.18 },
    { r: 0.78, y: 0.55 },
    { r: 0.66, y: 1.05 },
    { r: 0.9, y: 1.7 },
    { r: 0.82, y: 2.35 },
    { r: 0.45, y: 2.9 },
    { r: 0.52, y: 3.15 },
    { r: 0.3, y: 3.35 },
    { r: 0.0, y: 3.5 },
  ]
}

// Jade Idol — a single hand-turned figurine of translucent jade under one warm
// key light and a cool rim, on a dark plinth. Light pours into the rounded belly
// and re-emerges as a deep green inner glow that pools where the form is thinnest
// (the neck, the lip); the high-IOR boundary throws a glassy Fresnel sheen and
// total-internal-reflection keeps light bouncing inside. The same lathe rendered
// opaque would be a flat green silhouette.
function jadeIdol(): SceneDef {
  const materials: Material[] = [{ kind: 'diffuse', albedo: v(0.08, 0.085, 0.1), sigma: 0.6 }]
  const prims: PrimDef[] = []
  const g = 40
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))
  // Warm key, high and to the left.
  materials.push({ kind: 'emissive', emission: v(9, 7.8, 6 ) })
  prims.push(...quad(v(-9, 9, 1), v(-3, 9, -3), v(-3, 13, -3), v(-9, 13, 1), materials.length - 1))
  // Cool rim, low behind to the right → backlit translucency.
  materials.push({ kind: 'emissive', emission: v(2.6, 3.0, 4.0) })
  prims.push(...quad(v(2.5, 0.2, -5), v(8, 0.2, -5), v(8, 5, -5), v(2.5, 5, -5), materials.length - 1))

  materials.push(translucent(1.52, 1.05, v(0.3, 0.74, 0.46), 0.62))
  const jade = materials.length - 1
  prims.push(...emitMesh(transformMesh(surfaceOfRevolution(idolProfile(), 96), { scale: 1.25, translate: v(0, 0, 0) }), jade))

  return {
    name: 'Jade Idol',
    materials,
    prims,
    camera: { eye: v(0.6, 3.0, 9), target: v(0, 2.0, 0), up: v(0, 1, 0), vfovDeg: 38, aperture: 0.02, focusDist: 9 },
    env: { kind: 'gradient', top: v(0.03, 0.04, 0.05), bottom: v(0.01, 0.012, 0.016) },
  }
}

// A translucent dielectric filled with a measured (Jensen 2001) BSSRDF medium —
// its chromatic mean free path (red travels far, blue scatters out near the
// surface) is baked into `interior.sigmaTSpectral`, so the dielectric is spectral
// and the path commits a hero wavelength at the boundary (see subsurface.ts /
// integrator). `tint` stays white; all colour is physical.
function measured(name: MediumName, scale: number, ior: number, g = 0, roughness = 0): Material {
  return { kind: 'dielectric', ior, tint: v(1, 1, 1), roughness, interior: subsurfacePreset(name, scale, g) }
}

// Living Skin (15.0) — the headline for chromatic subsurface. A hand-turned
// figurine of measured *skin2* and a marble companion are raked by a warm light
// from behind: where the form is thin (the neck, the lip, the rim) red light —
// which alone penetrates that far — bleeds straight through and the silhouette
// lights up a deep flesh red, while the thick body stays pale. That red-edged glow
// is impossible for the scalar 12.0 walk (one mean free path per colour); it is the
// chromatic extinction of real skin, rendered. Raise **Max Depth** for a softer,
// deeper bleed.
function livingSkin(): SceneDef {
  const materials: Material[] = [{ kind: 'diffuse', albedo: v(0.07, 0.07, 0.08), sigma: 0.6 }]
  const prims: PrimDef[] = []
  const g = 40
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))
  // Strong warm back-light low behind the forms → transmission through thin edges.
  materials.push({ kind: 'emissive', emission: v(9.5, 7.4, 5.6) })
  prims.push(...quad(v(-9, 0.15, -6), v(9, 0.15, -6), v(9, 7, -6), v(-9, 7, -6), materials.length - 1))
  // Soft cool key from high front to read the surface form without washing the glow.
  materials.push({ kind: 'emissive', emission: v(1.5, 1.7, 2.2) })
  prims.push(...quad(v(-7, 12, 4), v(7, 12, 4), v(7, 12, 11), v(-7, 12, 11), materials.length - 1))

  // The hero: a skin figurine (the same watertight lathe as the Jade Idol).
  materials.push(measured('skin2', 1.15, 1.4, 0.0))
  const skin = materials.length - 1
  prims.push(...emitMesh(transformMesh(surfaceOfRevolution(idolProfile(), 96), { scale: 1.15, translate: v(-1.7, 0, 0) }), skin))
  // A marble companion sphere — paler, with its own (subtler) red-deepest extinction.
  materials.push(measured('marble', 0.55, 1.46, 0.0))
  prims.push({ kind: 'sphere', center: v(2.2, 1.15, 0.3), radius: 1.15, material: materials.length - 1 })

  return {
    name: 'Living Skin',
    materials,
    prims,
    camera: { eye: v(0.4, 3.2, 10.5), target: v(0, 1.8, -0.5), up: v(0, 1, 0), vfovDeg: 40, aperture: 0.03, focusDist: 10.5 },
    env: { kind: 'gradient', top: v(0.03, 0.035, 0.045), bottom: v(0.012, 0.012, 0.016) },
  }
}

// Apothecary (15.0) — the measured-media library on a shelf. A row of glass
// spheres, each filled with a different real BSSRDF medium from Jensen et al. 2001
// — whole milk, skim milk, marble, ketchup, cream, apple — lit from above and the
// front. No two read alike: skim milk goes faintly blue (it scatters blue most),
// whole milk is a dense warm white, ketchup is a near-opaque deep red (only red
// penetrates its measured extinction at all), cream a rich off-white, marble cool
// and stony. Every colour here is *measured*, not painted.
function apothecary(): SceneDef {
  const materials: Material[] = [{ kind: 'diffuse', albedo: v(0.5, 0.49, 0.47), sigma: 0.4 }]
  const prims: PrimDef[] = []
  const g = 40
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))
  // A back wall to catch shadows and ground the jars.
  materials.push({ kind: 'diffuse', albedo: v(0.32, 0.31, 0.3), sigma: 0.5 })
  prims.push(...quad(v(-g, 0, -4.5), v(g, 0, -4.5), v(g, g, -4.5), v(-g, g, -4.5), materials.length - 1))
  // Broad soft key from above, a gentle warm fill from the front-left.
  materials.push({ kind: 'emissive', emission: v(5.2, 5.2, 5.4) })
  prims.push(...quad(v(-8, 11, -3), v(8, 11, -3), v(8, 11, 5), v(-8, 11, 5), materials.length - 1))
  materials.push({ kind: 'emissive', emission: v(3.0, 2.7, 2.2) })
  prims.push(...quad(v(-11, 1, 3), v(-11, 1, -3), v(-11, 7, -3), v(-11, 7, 3), materials.length - 1))

  const jars: { name: MediumName; scale: number; g: number }[] = [
    { name: 'wholemilk', scale: 0.6, g: 0.0 },
    { name: 'skimmilk', scale: 1.1, g: 0.0 },
    { name: 'marble', scale: 0.5, g: 0.0 },
    { name: 'ketchup', scale: 1.0, g: 0.0 },
    { name: 'cream', scale: 0.32, g: 0.0 },
    { name: 'apple', scale: 0.6, g: 0.0 },
  ]
  const n = jars.length
  for (let i = 0; i < n; i++) {
    const j = jars[i]
    materials.push(measured(j.name, j.scale, 1.45, j.g))
    prims.push({ kind: 'sphere', center: v((i - (n - 1) / 2) * 2.35, 1.05, 0), radius: 1.05, material: materials.length - 1 })
  }
  return {
    name: 'Apothecary',
    materials,
    prims,
    camera: { eye: v(0, 3.4, 12), target: v(0, 1.0, 0), up: v(0, 1, 0), vfovDeg: 42, aperture: 0.02, focusDist: 12 },
    env: { kind: 'gradient', top: v(0.05, 0.05, 0.06), bottom: v(0.02, 0.02, 0.025) },
  }
}

// Colour Temperature (18.0) — the Planckian locus, lit. A row of emissive panels
// climbs from 2000 K (a candle/sodium amber) through ~5500 K (neutral daylight) to
// 12000 K (a cold blue north sky), each panel's colour computed from Planck's law
// integrated against the CIE colour-matching functions (see blackbody.ts) — not a
// hand-picked RGB. Each panel washes a neutral matte sphere and the wall behind it,
// so the warm→cool sweep reads directly off physically-coloured light. The middle
// panels are near-white; only the ends are strongly tinted — exactly as the locus
// predicts.
function colourTemperature(): SceneDef {
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.6, 0.6, 0.6), sigma: 0.3 }, // 0 neutral floor
    { kind: 'diffuse', albedo: v(0.55, 0.55, 0.56), sigma: 0.4 }, // 1 neutral back wall
    { kind: 'diffuse', albedo: v(0.82, 0.82, 0.82) }, // 2 matte spheres (read the cast)
  ]
  const prims: PrimDef[] = []
  const W = 22
  prims.push(...quad(v(-W, 0, -W), v(W, 0, -W), v(W, 0, W), v(-W, 0, W), 0)) // floor
  prims.push(...quad(v(-W, 0, -6), v(W, 0, -6), v(W, 16, -6), v(-W, 16, -6), 1)) // back wall
  const temps = [2000, 3000, 4000, 5500, 7000, 9000, 12000]
  const n = temps.length
  const spacing = 3.0
  for (let i = 0; i < n; i++) {
    const cx = (i - (n - 1) / 2) * spacing
    // The emissive panel (flush to the back wall), its hue from the blackbody locus.
    materials.push({ kind: 'emissive', emission: blackbodyEmission(temps[i], 11) })
    const em = materials.length - 1
    prims.push(...quad(v(cx - 1.1, 0.4, -5.9), v(cx + 1.1, 0.4, -5.9), v(cx + 1.1, 4.4, -5.9), v(cx - 1.1, 4.4, -5.9), em))
    // A neutral sphere in front to catch the coloured light.
    prims.push({ kind: 'sphere', center: v(cx, 1.0, -2.6), radius: 1.0, material: 2 })
  }
  return {
    name: 'Colour Temperature',
    materials,
    prims,
    camera: { eye: v(0, 4.0, 11.5), target: v(0, 1.6, -4), up: v(0, 1, 0), vfovDeg: 55, aperture: 0, focusDist: 12 },
    env: { kind: 'solid', color: v(0.01, 0.01, 0.012) },
  }
}

// The Glowing Orb — a path-guiding showcase. The room's only light is a small,
// bright *emissive sphere*. Lumen samples lights by next-event estimation only on
// triangle emitters, so an emissive sphere is INVISIBLE to NEE: every photon the
// camera sees must be found by a scattered ray that happens to strike the orb —
// which cosine BSDF sampling does only ~0.5 % of the time, so the plain path
// tracer is a storm of fireflies. The guided integrator learns, per region of the
// room, the direction back to the orb and aims a share of its samples there
// (hitting it ~9 % of the time after a few iterations), cutting the error
// markedly. It is the textbook case where path guiding earns its keep — and it
// still converges to the very same image (unbiased), only faster.
function glowingOrb(): SceneDef {
  const W = 10
  const orbR = 0.55
  const em = 60 / (orbR * orbR)
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.78, 0.77, 0.74) }, // 0 neutral shell
    { kind: 'diffuse', albedo: v(0.62, 0.13, 0.12) }, // 1 red wall
    { kind: 'diffuse', albedo: v(0.13, 0.33, 0.55) }, // 2 blue wall
    { kind: 'emissive', emission: v(em, em * 0.86, em * 0.66) }, // 3 the orb (NEE-invisible)
    { kind: 'metal', albedo: v(0.96, 0.95, 0.92), roughness: 0.16 }, // 4 glossy sphere
    { kind: 'diffuse', albedo: v(0.82, 0.78, 0.55) }, // 5 pedestal
  ]
  const prims: PrimDef[] = []
  prims.push(...quad(v(0, 0, 0), v(W, 0, 0), v(W, 0, W), v(0, 0, W), 0)) // floor
  prims.push(...quad(v(0, W, 0), v(0, W, W), v(W, W, W), v(W, W, 0), 0)) // ceiling
  prims.push(...quad(v(0, 0, W), v(W, 0, W), v(W, W, W), v(0, W, W), 0)) // back
  prims.push(...quad(v(0, 0, 0), v(0, 0, W), v(0, W, W), v(0, W, 0), 1)) // left red
  prims.push(...quad(v(W, 0, 0), v(W, W, 0), v(W, W, W), v(W, 0, W), 2)) // right blue
  prims.push({ kind: 'sphere', center: v(5, 6.7, 5.6), radius: orbR, material: 3 }) // the orb
  prims.push({ kind: 'sphere', center: v(6.7, 1.7, 3.0), radius: 1.7, material: 4 }) // glossy catcher
  prims.push(...box(v(3.0, 1.05, 3.4), v(1.05, 1.05, 1.05), 0.4, 5)) // pedestal
  return {
    name: 'Glowing Orb',
    materials,
    prims,
    camera: {
      eye: v(5, 4.6, -6.8),
      target: v(5, 3.6, 5),
      up: v(0, 1, 0),
      vfovDeg: 50,
      aperture: 0,
      focusDist: 11.5,
    },
    env: { kind: 'solid', color: v(0, 0, 0) },
  }
}

// The Hidden Door — a two-chamber indirect-light scene (good for BDPT/guiding).
// A wall with a single doorway separates the camera's room from a chamber holding
// a bright down-facing strip light; everything the camera sees is light that has
// streamed through the doorway and bounced around the near room.
function hiddenDoor(): SceneDef {
  const W = 10
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.76, 0.75, 0.72) }, // 0 neutral shell
    { kind: 'diffuse', albedo: v(0.62, 0.13, 0.12) }, // 1 near-room red wall
    { kind: 'diffuse', albedo: v(0.13, 0.33, 0.55) }, // 2 near-room blue wall
    { kind: 'emissive', emission: v(48, 40, 28) }, // 3 hidden warm strip (far chamber)
    { kind: 'diffuse', albedo: v(0.85, 0.62, 0.32) }, // 4 far-chamber warm wall (colour bleed)
    { kind: 'metal', albedo: v(0.96, 0.95, 0.92), roughness: 0.14 }, // 5 glossy sphere
    { kind: 'diffuse', albedo: v(0.82, 0.78, 0.55) }, // 6 pedestal
  ]
  const prims: PrimDef[] = []
  // Shell (front, at z=0, is open toward the camera).
  prims.push(...quad(v(0, 0, 0), v(W, 0, 0), v(W, 0, W), v(0, 0, W), 0)) // floor
  prims.push(...quad(v(0, W, 0), v(0, W, W), v(W, W, W), v(W, W, 0), 0)) // ceiling
  prims.push(...quad(v(0, 0, 0), v(0, 0, W), v(0, W, W), v(0, W, 0), 1)) // left red
  prims.push(...quad(v(W, 0, 0), v(W, W, 0), v(W, W, W), v(W, 0, W), 2)) // right blue
  prims.push(...quad(v(0, 0, W), v(4, 0, W), v(4, W, W), v(0, W, W), 4)) // far back (warm)
  prims.push(...quad(v(4, 0, W), v(W, 0, W), v(W, W, W), v(4, W, W), 4)) // far back (warm)
  // Dividing wall at z=Z, with a doorway hole (x∈[3.8,6.2], y∈[0,3.6]).
  const Z = 5
  const dx0 = 3.8,
    dx1 = 6.2,
    dy = 3.6
  prims.push(...quad(v(0, 0, Z), v(dx0, 0, Z), v(dx0, W, Z), v(0, W, Z), 0)) // left of door
  prims.push(...quad(v(dx1, 0, Z), v(W, 0, Z), v(W, W, Z), v(dx1, W, Z), 0)) // right of door
  prims.push(...quad(v(dx0, dy, Z), v(dx1, dy, Z), v(dx1, W, Z), v(dx0, W, Z), 0)) // lintel above door
  // The hidden emitter: a down-facing ceiling strip in the far chamber (z>Z),
  // wound (like the Cornell light) so its geometric normal points −y, into the
  // far room. Bright and fully occluded from the near room except via the door.
  const ey = W - 0.02
  prims.push(...quad(v(2.6, ey, 6.6), v(7.4, ey, 6.6), v(7.4, ey, 9.2), v(2.6, ey, 9.2), 3))
  // Near-room objects to catch the soft, directional bounce light.
  prims.push({ kind: 'sphere', center: v(6.6, 1.7, 2.3), radius: 1.7, material: 5 })
  prims.push(...box(v(2.7, 1.15, 2.6), v(1.15, 1.15, 1.15), 0.4, 6))
  return {
    name: 'Hidden Door',
    materials,
    prims,
    camera: {
      eye: v(5, 4.6, -7.6),
      target: v(5, 3.4, 5),
      up: v(0, 1, 0),
      vfovDeg: 48,
      aperture: 0,
      focusDist: 12.5,
    },
    env: { kind: 'solid', color: v(0, 0, 0) },
  }
}

// ---- Scene: Star Field (many lights) -----------------------------------------
// A wide diffuse plaza under a canopy of hundreds of tiny, jewel-coloured emitters.
// Each floor point is lit overwhelmingly by the handful of lamps directly above it,
// so picking a light *uniformly* (Lumen's original NEE) wastes almost every shadow
// ray on a far, irrelevant lamp and the floor renders as a storm of colour noise;
// the light BVH (Many lights) finds the local lamps and the colour resolves. This is
// the scene the 14.0 light tree was built for — flip "Many lights" on and off to see
// the noise collapse at equal samples.
function starField(): SceneDef {
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.62, 0.62, 0.66) }, // 0 plaza floor
    { kind: 'metal', albedo: v(0.95, 0.95, 0.97), roughness: 0.18 }, // 1 brushed pillars
    { kind: 'diffuse', albedo: v(0.78, 0.76, 0.72) }, // 2 matte spheres (catch colour)
  ]
  // A palette of saturated emitter colours, all of comparable luminance so the win
  // comes from *spatial* selection, not just power.
  const palette: Vec3[] = [
    v(9, 1.2, 1.2), v(1.2, 7.5, 2.0), v(1.4, 2.4, 9.5), v(9, 6.5, 1.2),
    v(8.5, 1.6, 7.5), v(1.4, 8.5, 8.5), v(9.5, 4.5, 1.2), v(5.5, 1.6, 9.5),
  ]
  for (const c of palette) materials.push({ kind: 'emissive', emission: c })
  const EMIT0 = 3 // first emissive material index
  const prims: PrimDef[] = []
  const R = 26
  prims.push(...quad(v(-R, 0, -R), v(R, 0, -R), v(R, 0, R), v(-R, 0, R), 0)) // floor
  // The canopy: a jittered grid of small downward-facing emissive quads at varying
  // height, each a random palette colour. ~121 lamps ⇒ ~242 emissive triangles.
  const rng = mulberry(20260625)
  const downQuad = (cx: number, cz: number, y: number, s: number, mat: number): PrimDef[] => [
    { kind: 'tri', p0: v(cx - s, y, cz - s), p1: v(cx + s, y, cz - s), p2: v(cx + s, y, cz + s), material: mat },
    { kind: 'tri', p0: v(cx - s, y, cz - s), p1: v(cx + s, y, cz + s), p2: v(cx - s, y, cz + s), material: mat },
  ]
  const G = 11
  for (let i = 0; i < G; i++) {
    for (let j = 0; j < G; j++) {
      const cx = -R + 2 + ((2 * (R - 2)) * (i + 0.5)) / G + (rng() - 0.5) * 2.6
      const cz = -R + 2 + ((2 * (R - 2)) * (j + 0.5)) / G + (rng() - 0.5) * 2.6
      const y = 4.5 + rng() * 3.5
      const mat = EMIT0 + ((rng() * palette.length) | 0)
      prims.push(...downQuad(cx, cz, y, 0.18, mat))
    }
  }
  // A few matte spheres + brushed pillars to read the coloured pools of light.
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2
    prims.push({ kind: 'sphere', center: v(Math.cos(a) * 7, 1.4, Math.sin(a) * 7 + 1), radius: 1.4, material: 2 })
    prims.push(...box(v(Math.cos(a + 0.6) * 13, 2.2, Math.sin(a + 0.6) * 13), v(0.5, 2.2, 0.5), 0, 1))
  }
  return {
    name: 'Star Field',
    materials,
    prims,
    camera: { eye: v(0, 4.2, -17), target: v(0, 1.4, 1), up: v(0, 1, 0), vfovDeg: 52, aperture: 0, focusDist: 18 },
    env: { kind: 'solid', color: v(0.012, 0.014, 0.022) },
  }
}

// ---- Scene: Light Cage (receiver-aware many lights, 17.0) -------------------

// A faceted object suspended inside a full spherical CAGE of ~200 small inward-
// facing lights. The point: at any surface point on the object, roughly *half* the
// cage is behind the local normal and can contribute nothing — so a light tree that
// ignores the receiver wastes half its shadow rays on the dark hemisphere. The 17.0
// receiver-aware importance folds the shade normal into the cluster weight, so a
// facet's samples land on the lights that actually face it. Toggle **Many lights**
// to compare. (The cage encloses the camera too, lighting the scene from all sides.)
function lightCage(): SceneDef {
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.74, 0.72, 0.68) }, // 0 faceted object
    { kind: 'metal', albedo: v(0.96, 0.96, 0.98), roughness: 0.12 }, // 1 inner accent
  ]
  const palette: Vec3[] = [
    v(9, 1.4, 1.4), v(1.3, 7.8, 2.2), v(1.5, 2.6, 9.5), v(9, 6.8, 1.4),
    v(8.5, 1.8, 7.8), v(1.5, 8.8, 8.8), v(9.5, 4.8, 1.4), v(5.8, 1.8, 9.5),
  ]
  for (const c of palette) materials.push({ kind: 'emissive', emission: c })
  const EMIT0 = 2
  const prims: PrimDef[] = []
  const C = v(0, 3.2, 0) // cage / object centre
  const Rc = 9 // cage radius
  const rng = mulberry(20260626)
  // ~220 inward-facing emissive triangles spread over the cage sphere (Fibonacci-ish
  // jittered), each built so its geometric normal points back at the centre.
  const NLAMP = 220
  for (let i = 0; i < NLAMP; i++) {
    const u = 1 - (2 * (i + 0.5)) / NLAMP // cosθ ∈ (−1,1)
    const r = Math.sqrt(Math.max(0, 1 - u * u))
    const phi = i * 2.399963 + (rng() - 0.5) * 0.3 // golden angle + jitter
    const dir = v(Math.cos(phi) * r, u, Math.sin(phi) * r) // outward unit
    const P = add(C, scale(dir, Rc))
    const n = scale(dir, -1) // inward (toward C)
    const ref = Math.abs(n.y) < 0.95 ? v(0, 1, 0) : v(1, 0, 0)
    const t = normalize(cross(ref, n))
    const b = cross(n, t) // t × b = n ⇒ the triangle below faces inward
    const s = 0.17
    const p0 = P
    const p1 = add(P, scale(t, s))
    const p2 = add(P, scale(b, s))
    const mat = EMIT0 + ((rng() * palette.length) | 0)
    prims.push({ kind: 'tri', p0, p1, p2, material: mat })
  }
  // The faceted object: an icosphere (lots of differently-facing facets) plus a
  // smaller glossy companion, so the receiver term matters all over the surface.
  prims.push(...emitMesh(transformMesh(icosphere(1), { scale: 2.2, translate: C }), 0))
  prims.push(...emitMesh(transformMesh(icosphere(1), { scale: 1.0, translate: v(2.6, 1.4, 2.2) }), 1))
  return {
    name: 'Light Cage',
    materials,
    prims,
    camera: { eye: v(0, 3.4, -7.4), target: C, up: v(0, 1, 0), vfovDeg: 60, aperture: 0, focusDist: 7.4 },
    env: { kind: 'solid', color: v(0.01, 0.011, 0.016) },
  }
}

// ---- Scene: Lantern Hall (many lights) ---------------------------------------
// A long colonnade hung with many warm lanterns. At any point on the floor or walls
// only the nearest few lanterns matter — the rest are far down the hall — which is
// exactly the regime where uniform light selection collapses and the distance-aware
// light tree shines. Warm, architectural, and an unmistakable A/B for "Many lights".
function lanternHall(): SceneDef {
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.34, 0.3, 0.26) }, // 0 stone floor
    { kind: 'diffuse', albedo: v(0.52, 0.46, 0.4) }, // 1 walls
    { kind: 'diffuse', albedo: v(0.2, 0.18, 0.16) }, // 2 lantern housing
    { kind: 'emissive', emission: v(15, 9.5, 4.2) }, // 3 warm lantern flame
    { kind: 'metal', albedo: v(0.96, 0.86, 0.6), roughness: 0.12 }, // 4 brass sphere
  ]
  const prims: PrimDef[] = []
  const HW = 5 // half-width of the hall
  const H = 7 // height
  const L = 60 // length down +z
  prims.push(...quad(v(-HW, 0, -2), v(HW, 0, -2), v(HW, 0, L), v(-HW, 0, L), 0)) // floor
  prims.push(...quad(v(-HW, H, -2), v(-HW, H, L), v(HW, H, L), v(HW, H, -2), 0)) // ceiling
  prims.push(...quad(v(-HW, 0, -2), v(-HW, 0, L), v(-HW, H, L), v(-HW, H, -2), 1)) // left wall
  prims.push(...quad(v(HW, 0, -2), v(HW, H, -2), v(HW, H, L), v(HW, 0, L), 1)) // right wall
  prims.push(...quad(v(-HW, 0, L), v(HW, 0, L), v(HW, H, L), v(-HW, H, L), 1)) // far wall
  // A double row of lanterns down both walls: a small dark housing box with a
  // downward-facing emissive panel beneath it (the flame). ~2×22 = 44 lanterns.
  const downQuad = (cx: number, cz: number, y: number, sx: number, sz: number, mat: number): PrimDef[] => [
    { kind: 'tri', p0: v(cx - sx, y, cz - sz), p1: v(cx + sx, y, cz - sz), p2: v(cx + sx, y, cz + sz), material: mat },
    { kind: 'tri', p0: v(cx - sx, y, cz - sz), p1: v(cx + sx, y, cz + sz), p2: v(cx - sx, y, cz + sz), material: mat },
  ]
  const N = 22
  for (let i = 0; i < N; i++) {
    const z = 1.5 + (i / (N - 1)) * (L - 4)
    for (const sx of [-1, 1]) {
      const x = sx * (HW - 0.55)
      prims.push(...box(v(x, H - 0.7, z), v(0.4, 0.45, 0.4), 0, 2)) // housing
      prims.push(...downQuad(x, z, H - 1.18, 0.32, 0.32, 3)) // flame panel (faces down)
    }
  }
  // A row of brass spheres down the centreline to read the travelling pools of light.
  for (let i = 0; i < 6; i++) {
    prims.push({ kind: 'sphere', center: v(0, 1.1, 5 + i * 9), radius: 1.1, material: 4 })
  }
  return {
    name: 'Lantern Hall',
    materials,
    prims,
    camera: { eye: v(0, 2.6, -7), target: v(0, 2.6, 20), up: v(0, 1, 0), vfovDeg: 62, aperture: 0, focusDist: 12 },
    env: { kind: 'solid', color: v(0.008, 0.006, 0.004) },
  }
}

// ---- Scene: Plasma Lamps (sphere-light NEE, 20.0) ---------------------------
// A still life lit ENTIRELY by emissive spheres — three vivid glass-bulb "plasma
// lamps" of different size and distance hanging over a dark plinth. Until 20.0
// Lumen's NEE could only sample triangle lights, so these spheres were invisible
// to it: every photon the camera saw had to be found by a scattered ray that
// happened to strike a bulb, which cosine BSDF sampling does a fraction of a
// percent of the time — a firefly storm. Flip "Sphere lights (cone NEE)" on and
// each shadow ray lands directly on a bulb (the cone it subtends is sampled
// exactly), and the coloured pools of light resolve in a handful of samples. It
// converges to the very same image either way — only the noise collapses.
function plasmaLamps(): SceneDef {
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.32, 0.31, 0.3) }, // 0 dark stone floor
    { kind: 'diffuse', albedo: v(0.7, 0.68, 0.64) }, // 1 neutral plinth top
    { kind: 'metal', albedo: v(0.96, 0.95, 0.92), roughness: 0.08 }, // 2 polished steel sphere
    { kind: 'metal', albedo: v(0.95, 0.78, 0.4), roughness: 0.22 }, // 3 brushed brass sphere
    { kind: 'diffuse', albedo: v(0.82, 0.8, 0.76) }, // 4 matte catcher
    { kind: 'emissive', emission: v(22, 4.5, 5.5) }, // 5 ruby bulb (large, high)
    { kind: 'emissive', emission: v(4.0, 9.5, 26) }, // 6 sapphire bulb (small, near)
    { kind: 'emissive', emission: v(7.0, 24, 9.0) }, // 7 emerald bulb (mid)
  ]
  const prims: PrimDef[] = []
  const W = 14
  prims.push(...quad(v(-W, 0, -W), v(W, 0, -W), v(W, 0, W), v(-W, 0, W), 0)) // floor
  // A low plinth the objects sit on.
  prims.push(...box(v(0, 0.5, 1.5), v(3.2, 0.5, 2.4), 0, 1))
  // Catcher objects on the plinth — a polished steel sphere (sharp coloured
  // reflections of the bulbs), a brass sphere, and a matte ball + box for soft
  // diffuse pools.
  prims.push({ kind: 'sphere', center: v(-1.7, 2.1, 1.4), radius: 1.1, material: 2 })
  prims.push({ kind: 'sphere', center: v(1.9, 1.85, 1.9), radius: 0.85, material: 3 })
  prims.push({ kind: 'sphere', center: v(0.3, 1.55, 0.0), radius: 0.55, material: 4 })
  prims.push(...box(v(2.0, 1.45, 0.0), v(0.6, 0.45, 0.6), 0.5, 4))
  // The three emissive bulbs (the only light), varied in radius and distance so
  // their subtended cones — and thus the cone sampler's win — differ markedly.
  prims.push({ kind: 'sphere', center: v(-3.6, 6.4, 2.2), radius: 0.9, material: 5 }) // ruby, large/high
  prims.push({ kind: 'sphere', center: v(2.9, 3.5, -1.6), radius: 0.42, material: 6 }) // sapphire, small/near
  prims.push({ kind: 'sphere', center: v(0.6, 5.2, 4.6), radius: 0.62, material: 7 }) // emerald, mid
  return {
    name: 'Plasma Lamps',
    materials,
    prims,
    camera: { eye: v(0.4, 4.3, -8.6), target: v(0.2, 2.0, 1.4), up: v(0, 1, 0), vfovDeg: 46, aperture: 0, focusDist: 11 },
    env: { kind: 'solid', color: v(0.004, 0.005, 0.008) },
  }
}

// ---- Scene: Firefly Swarm (many sphere lights, 20.0) ------------------------
// A wide diffuse meadow under a swarm of ~50 tiny, bright emissive spheres — warm
// motes drifting at varied height. Each is a vanishingly small target for a
// scattered ray, so without sphere NEE the ground is pure firefly noise; the cone
// sampler lands a shadow ray on a chosen mote every time, and the soft overlapping
// pools of warm light read cleanly. It is the sphere-light analogue of Star Field
// (whose hundreds of TRIANGLE lamps motivated the light BVH) — here the win comes
// from being able to sample the spheres at all. Combine with "Many lights" off
// (the spheres take a uniform 1/N selection slot) to isolate the cone-sampling win.
function fireflySwarm(): SceneDef {
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.4, 0.42, 0.38) }, // 0 meadow floor
    { kind: 'diffuse', albedo: v(0.78, 0.76, 0.72) }, // 1 matte catcher spheres
    { kind: 'metal', albedo: v(0.95, 0.95, 0.97), roughness: 0.16 }, // 2 glossy pillar
  ]
  // A few warm-to-cool mote colours, all comparable luminance.
  const palette: Vec3[] = [
    v(34, 24, 10), v(30, 26, 14), v(26, 22, 28), v(18, 26, 30), v(34, 18, 14),
  ]
  const EMIT0 = 3
  for (const c of palette) materials.push({ kind: 'emissive', emission: c })
  const prims: PrimDef[] = []
  const R = 24
  prims.push(...quad(v(-R, 0, -R), v(R, 0, -R), v(R, 0, R), v(-R, 0, R), 0)) // floor
  // The swarm: ~50 tiny emissive spheres on a jittered dome of positions.
  const rng = mulberry(0x5eed20)
  const N = 50
  for (let i = 0; i < N; i++) {
    const a = rng() * Math.PI * 2
    const rad = 3 + rng() * 15
    const cx = Math.cos(a) * rad + (rng() - 0.5) * 3
    const cz = Math.sin(a) * rad + 2 + (rng() - 0.5) * 3
    const cy = 1.4 + rng() * 5.5
    const r = 0.06 + rng() * 0.12 // tiny — a hard BSDF-sampling target
    const mat = EMIT0 + ((rng() * palette.length) | 0)
    prims.push({ kind: 'sphere', center: v(cx, cy, cz), radius: r, material: mat })
  }
  // Catchers to read the pooled light: a ring of matte spheres + a glossy pillar.
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2
    prims.push({ kind: 'sphere', center: v(Math.cos(a) * 6, 1.2, Math.sin(a) * 6 + 2), radius: 1.2, material: 1 })
  }
  prims.push(...box(v(0, 2.6, 2), v(0.6, 2.6, 0.6), 0, 2))
  return {
    name: 'Firefly Swarm',
    materials,
    prims,
    camera: { eye: v(0, 3.4, -15), target: v(0, 1.6, 2), up: v(0, 1, 0), vfovDeg: 54, aperture: 0, focusDist: 17 },
    env: { kind: 'solid', color: v(0.01, 0.011, 0.016) },
  }
}

// A tiny deterministic PRNG (mulberry32) for scene-time jitter — kept local so the
// scene builders stay pure and reproducible without touching the render RNG.
function mulberry(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- (21.0) Image-based lighting: HDRI environment showcases ----------------
//
// These scenes carry NO emitters at all — every photon comes from the
// equirectangular HDRI wrapped around them (see envmap.ts), importance-sampled
// for next-event estimation. They are the proof, by eye, that the environment is
// a real sampled light: switch the "Env importance sampling" off (in the engine
// the env would fall back to BSDF-only) and a glossy surface dissolves into noise.

// A row of varied hero materials on a polished floor, lit only by the studio
// softbox HDRI — the product-shot setup where most of the dome is black and
// importance sampling is the whole ballgame.
function studioHdri(): SceneDef {
  const materials: Material[] = [
    { kind: 'metal', albedo: v(0.55, 0.56, 0.58), roughness: 0.09 }, // 0 polished floor
    { kind: 'metal', albedo: v(0.95, 0.96, 0.98), roughness: 0.0 }, // 1 chrome
    { kind: 'metal', albedo: conductorF0RGB('gold'), roughness: 0.06, multiscatter: true, spectrum: 'gold' }, // 2 gold
    { kind: 'dielectric', ior: 1.5, tint: v(1, 1, 1) }, // 3 glass
    { kind: 'diffuse', albedo: v(0.85, 0.2, 0.18), coat: { ior: 1.5, roughness: 0.05 } }, // 4 red ceramic
    { kind: 'metal', albedo: conductorF0RGB('copper'), roughness: 0.28, multiscatter: true, spectrum: 'copper' }, // 5 brushed copper
  ]
  const prims: PrimDef[] = []
  const g = 60
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))
  const order = [4, 2, 1, 3, 5]
  for (let i = 0; i < order.length; i++) {
    prims.push({ kind: 'sphere', center: v((i - (order.length - 1) / 2) * 2.3, 1, 0), radius: 1, material: order[i] })
  }
  return {
    name: 'Studio HDRI',
    materials,
    prims,
    camera: { eye: v(0, 2.4, 8.5), target: v(0, 0.9, 0), up: v(0, 1, 0), vfovDeg: 40, aperture: 0.03, focusDist: 8.5 },
    env: { kind: 'hdri', preset: 'studio', intensity: 1.4 },
  }
}

// An outdoor still life under a graded sunset sky with a blinding low sun. The
// sun is a tiny fraction of the panorama carrying most of the energy, so the
// importance sampler is the difference between crisp warm highlights and a
// firefly storm. Strong directional key from the sun, soft sky fill.
function sunsetHdri(): SceneDef {
  const materials: Material[] = [
    { kind: 'diffuse', albedo: v(0.45, 0.42, 0.38) }, // 0 sandy ground
    { kind: 'metal', albedo: v(0.92, 0.93, 0.95), roughness: 0.04 }, // 1 polished steel
    { kind: 'dielectric', ior: 1.5, tint: v(0.85, 0.95, 1.0) }, // 2 glass
    { kind: 'diffuse', albedo: v(0.2, 0.45, 0.7) }, // 3 blue diffuse
    { kind: 'metal', albedo: conductorF0RGB('gold'), roughness: 0.18, multiscatter: true, spectrum: 'gold' }, // 4 gold
    { kind: 'diffuse', albedo: v(0.85, 0.85, 0.86), sigma: 0.6 }, // 5 chalky white (Oren–Nayar)
  ]
  const prims: PrimDef[] = []
  const g = 200
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))
  prims.push({ kind: 'sphere', center: v(-2.6, 1, 0.4), radius: 1, material: 1 })
  prims.push({ kind: 'sphere', center: v(0, 1.3, -0.6), radius: 1.3, material: 2 })
  prims.push({ kind: 'sphere', center: v(2.7, 1, 0.2), radius: 1, material: 4 })
  prims.push({ kind: 'sphere', center: v(-1.1, 0.6, 2.0), radius: 0.6, material: 3 })
  prims.push({ kind: 'sphere', center: v(1.3, 0.6, 2.1), radius: 0.6, material: 5 })
  return {
    name: 'Sunset HDRI',
    materials,
    prims,
    camera: { eye: v(0.5, 2.0, 9), target: v(0, 0.9, 0), up: v(0, 1, 0), vfovDeg: 42, aperture: 0.04, focusDist: 9 },
    env: { kind: 'hdri', preset: 'sunset', intensity: 1.0, rotation: 0 },
  }
}

// A cluster of chrome and glass on a dark glossy floor reflecting a city horizon
// of hundreds of small warm lights at twilight — the many-tiny-emitters regime,
// breathtaking in a mirror and a torture test for the sampler (it must resolve a
// crowd of point-like lights, not one broad source).
function twilightHdri(): SceneDef {
  const materials: Material[] = [
    { kind: 'metal', albedo: v(0.32, 0.33, 0.36), roughness: 0.12 }, // 0 dark glossy floor
    { kind: 'metal', albedo: v(0.96, 0.97, 0.99), roughness: 0.0 }, // 1 chrome
    { kind: 'dielectric', ior: 1.5, tint: v(1, 1, 1) }, // 2 glass
    { kind: 'metal', albedo: v(0.9, 0.9, 0.92), roughness: 0.22 }, // 3 satin steel
  ]
  const prims: PrimDef[] = []
  const g = 80
  prims.push(...quad(v(-g, 0, -g), v(g, 0, -g), v(g, 0, g), v(-g, 0, g), 0))
  prims.push({ kind: 'sphere', center: v(0, 1.4, 0), radius: 1.4, material: 1 })
  prims.push({ kind: 'sphere', center: v(-2.6, 0.9, 1.2), radius: 0.9, material: 2 })
  prims.push({ kind: 'sphere', center: v(2.5, 0.8, 1.0), radius: 0.8, material: 3 })
  prims.push({ kind: 'sphere', center: v(1.3, 0.5, 2.6), radius: 0.5, material: 1 })
  return {
    name: 'Twilight HDRI',
    materials,
    prims,
    camera: { eye: v(0, 2.1, 8.5), target: v(0, 1.1, 0), up: v(0, 1, 0), vfovDeg: 44, aperture: 0.05, focusDist: 8.5 },
    env: { kind: 'hdri', preset: 'twilight', intensity: 1.2 },
  }
}

export interface ScenePreset {
  id: string
  label: string
  build: () => SceneDef
  sky?: boolean // exposes interactive sun/turbidity controls
  obj?: boolean // accepts a pasted OBJ model
  fog?: boolean // contains participating media; exposes a fog-density control
  cloud?: boolean // heterogeneous fBm cloud; also exposes a coverage control
  manyLights?: boolean // many emitters — defaults the "Many lights (light BVH)" toggle on
  sphereLights?: boolean // (20.0) sphere emitters — defaults the "Sphere lights (cone NEE)" toggle on
  hdri?: boolean // (21.0) HDRI environment — exposes the env rotation/intensity controls
}

export const SCENES: ScenePreset[] = [
  { id: 'cornell', label: 'Cornell Box', build: cornell },
  { id: 'cove', label: 'Cove (BDPT)', build: cove },
  { id: 'glowing-orb', label: 'Glowing Orb (Guided)', build: glowingOrb },
  { id: 'plasma-lamps', label: 'Plasma Lamps (sphere lights)', build: plasmaLamps, sphereLights: true },
  { id: 'fireflies', label: 'Firefly Swarm (sphere lights)', build: fireflySwarm, sphereLights: true },
  { id: 'star-field', label: 'Star Field (many lights)', build: starField, manyLights: true },
  { id: 'lantern-hall', label: 'Lantern Hall (many lights)', build: lanternHall, manyLights: true },
  { id: 'light-cage', label: 'Light Cage (receiver-aware)', build: lightCage, manyLights: true },
  { id: 'studio-hdri', label: 'Studio HDRI (IBL)', build: studioHdri, hdri: true },
  { id: 'sunset-hdri', label: 'Sunset HDRI (IBL)', build: sunsetHdri, hdri: true },
  { id: 'twilight-hdri', label: 'Twilight HDRI (IBL)', build: twilightHdri, hdri: true },
  { id: 'hidden-door', label: 'Hidden Door', build: hiddenDoor },
  { id: 'weekend', label: 'Weekend Daylight', build: weekend },
  { id: 'gallery', label: 'Material Gallery', build: gallery },
  { id: 'brushed', label: 'Brushed Metal', build: brushedMetal },
  { id: 'conductors', label: 'Rough Conductors', build: roughConductors },
  { id: 'metals', label: 'Metals of the World', build: metalsOfTheWorld, sky: true },
  { id: 'colour-temp', label: 'Colour Temperature (blackbody)', build: colourTemperature },
  { id: 'ceramics', label: 'Ceramics & Clay', build: ceramics },
  { id: 'subsurface', label: 'Subsurface Studio', build: subsurfaceStudio },
  { id: 'jade', label: 'Jade Idol', build: jadeIdol },
  { id: 'living-skin', label: 'Living Skin (spectral SSS)', build: livingSkin },
  { id: 'apothecary', label: 'Apothecary (measured SSS)', build: apothecary },
  { id: 'caustic', label: 'Caustic Room', build: causticRoom },
  { id: 'pool', label: 'Caustic Pool', build: causticPool },
  { id: 'spectral-caustic', label: 'Spectral Caustic', build: spectralCaustic },
  { id: 'daylight-lens', label: 'Daylight Lens', build: daylightLens, sky: true },
  { id: 'prism', label: 'Prism', build: prismScene },
  { id: 'menagerie', label: 'Glass Menagerie', build: glassMenagerie },
  { id: 'textured', label: 'Textured Studio', build: texturedStudio },
  { id: 'cathedral', label: 'Cathedral', build: cathedral, fog: true },
  { id: 'cumulus', label: 'Cumulus (cloud)', build: cumulus, sky: true, fog: true, cloud: true },
  { id: 'smoke', label: 'Smoke Plume', build: smokePlume, fog: true, cloud: true },
  { id: 'fog', label: 'Drifting Fog', build: driftingFog, fog: true },
  { id: 'ember', label: 'Ember (glowing)', build: emberCloud, fog: true, cloud: true },
  { id: 'rayleigh', label: 'Rayleigh Haze (chromatic)', build: rayleighHaze, fog: true },
  { id: 'amber-smoke', label: 'Amber Smoke (chromatic)', build: amberSmoke, fog: true, cloud: true },
  { id: 'iridescence', label: 'Iridescence', build: iridescence },
  { id: 'nebula', label: 'Nebula', build: nebula, fog: true },
  { id: 'sky', label: 'Sky Studio', build: skyStudio, sky: true },
  { id: 'revolution', label: 'Revolution', build: revolution, sky: true },
  { id: 'custom', label: 'Custom OBJ', build: customScene, sky: true, obj: true },
]

// Re-exports used by the orbit camera helper in the UI.
export const sceneMath = { add, sub, scale, normalize, cross }
