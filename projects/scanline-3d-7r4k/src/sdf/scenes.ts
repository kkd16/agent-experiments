// A gallery of implicit scenes — each is a signed distance field, built by composing
// the primitives and CSG operators in `sdf.ts`. The `smooth` knob (a blend radius) and
// `iso` (the level set) are exposed to the UI so the same field can be rendered as a
// crisp boolean or a melted blob. Each scene also declares the box it lives in so the
// marcher knows where to look.
import type { Sdf, Field } from './sdf.ts'
import {
  sphere, box, roundBox, torus, cylinder, capsule, gyroid,
  union, subtract, intersect, smoothUnion, smoothUnionAll, smoothSubtract, smoothIntersect,
  translate, rotateX, rotateZ, twistY, onion,
} from './sdf.ts'
import type { Vec3 } from '../math/vec.ts'

export interface SdfPreset {
  key: string
  label: string
  blurb: string
  // Build the field given the user's smoothing radius `k` and iso level.
  build: (k: number, iso: number) => Sdf
}

const cube = (lo: number, hi: number): { min: Vec3; max: Vec3 } => ({ min: [lo, lo, lo], max: [hi, hi, hi] })

// Six spheres orbiting a core, blended with a smooth-union so they fuse into one molten
// surface — the canonical "metaballs" that show off what implicit blending buys you.
const metaballs = (k: number): Sdf => {
  const balls: Field[] = []
  const N = 6
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2
    const r = 0.55
    balls.push(translate(sphere(0.42 + 0.1 * Math.sin(i * 1.7)), Math.cos(a) * r, Math.sin(a * 2) * 0.35, Math.sin(a) * r))
  }
  balls.push(sphere(0.5))
  return { name: 'Metaballs', f: smoothUnionAll(balls, Math.max(0.001, k)), bounds: cube(-1.4, 1.4) }
}

// A rounded block with three cylindrical bores drilled through it and the corners
// chamfered by a sphere intersection — a "machined part", pure CSG subtraction.
const mechanical = (k: number): Sdf => {
  const body = intersect(roundBox(0.95, 0.62, 0.95, 0.12), sphere(1.32))
  const boreY = cylinder(0.32, 2) // vertical bore
  const boreX = rotateZ(cylinder(0.26, 2), Math.PI / 2) // bore along X
  const boreZ = rotateX(cylinder(0.26, 2), Math.PI / 2) // bore along Z
  let f: Field = subtract(body, boreY)
  f = subtract(f, boreX)
  f = subtract(f, boreZ)
  // a smooth pocket milled into the top face
  f = smoothSubtract(f, translate(sphere(0.42), 0, 0.62, 0), Math.max(0.001, k))
  return { name: 'Machined Part', f, bounds: cube(-1.3, 1.3) }
}

// A bar of square cross-section twisted into a helix around the vertical axis — domain
// warping turns a static primitive into something that couldn't be modelled by hand.
const twist = (k: number): Sdf => {
  const bar = roundBox(0.42, 1.05, 0.42, 0.08)
  const f = twistY(bar, 2.4)
  // union a couple of beads so the smoothing knob has something to do
  const beads = smoothUnion(translate(sphere(0.45), 0, 1.0, 0), translate(sphere(0.45), 0, -1.0, 0), Math.max(0.001, k))
  return { name: 'Twisted Bar', f: smoothUnion(f, beads, Math.max(0.001, k)), bounds: { min: [-1.1, -1.6, -1.1], max: [1.1, 1.6, 1.1] } }
}

// A solid clipped out of the gyroid triply-periodic minimal surface — a labyrinthine
// shell that only an implicit representation makes tractable. Intersected with a sphere
// so it reads as a finished object rather than an infinite lattice.
const gyroidScene = (k: number, iso: number): Sdf => {
  // Iso shifts the wall thickness; Smoothness rounds the clip seam against the sphere.
  const thickness = Math.max(0.06, 0.2 + iso)
  const g = onion(gyroid(1.15, 0), thickness)
  const f = smoothIntersect(g, sphere(1.15), Math.max(0.001, k))
  return { name: 'Gyroid', f, bounds: cube(-1.3, 1.3) }
}

// A toy creature: a body sphere, a head, two ears and a snout, all melted together —
// the metaball idiom pushed toward character modelling.
const creature = (k: number): Sdf => {
  const kk = Math.max(0.001, k)
  const body = translate(sphere(0.6), 0, -0.2, 0)
  const head = translate(sphere(0.45), 0, 0.55, 0.1)
  const earL = translate(sphere(0.16), -0.28, 0.92, 0.05)
  const earR = translate(sphere(0.16), 0.28, 0.92, 0.05)
  const snout = translate(capsule(0.12, 0.16), 0, 0.45, 0.5)
  let f = smoothUnion(body, head, kk)
  f = smoothUnion(f, earL, kk * 0.6)
  f = smoothUnion(f, earR, kk * 0.6)
  f = smoothUnion(f, snout, kk)
  return { name: 'Critter', f, bounds: cube(-1.2, 1.4) }
}

// A torus fused with a sphere — the simplest scene that has non-trivial genus when the
// blend is small (a hole) and genus 0 when the blend swallows it. Good for the topology
// story in the UI.
const ring = (k: number): Sdf => {
  const t = torus(0.78, 0.28)
  const core = translate(sphere(0.42), 0, 0, 0)
  return { name: 'Ring & Core', f: smoothUnion(t, core, Math.max(0.001, k)), bounds: cube(-1.25, 1.25) }
}

// Sphere with a box subtracted (a Pac-Man-ish bite) plus a smaller sphere added back —
// shows union and subtraction in one field.
const carved = (k: number): Sdf => {
  const s = sphere(0.95)
  const bite = translate(box(0.7, 0.7, 0.7), 0.7, 0.4, 0.7)
  let f: Field = subtract(s, bite)
  f = union(f, translate(sphere(0.3), -0.5, 0.5, 0.5))
  if (k > 0.001) f = smoothUnion(f, translate(sphere(0.25), 0.2, -0.6, 0.4), k)
  return { name: 'Carved', f, bounds: cube(-1.15, 1.15) }
}

export const SDF_PRESETS: SdfPreset[] = [
  { key: 'metaballs', label: 'Metaballs', blurb: 'Seven spheres fused by a smooth-minimum — drag Smoothness to melt them together.', build: (k) => metaballs(k) },
  { key: 'mechanical', label: 'Machined Part', blurb: 'Boolean subtraction: a rounded block with drilled bores and a chamfered pocket.', build: (k) => mechanical(k) },
  { key: 'gyroid', label: 'Gyroid', blurb: 'A shell of the gyroid triply-periodic minimal surface, clipped to a sphere.', build: (k, iso) => gyroidScene(k, iso) },
  { key: 'twist', label: 'Twisted Bar', blurb: 'A square bar warped into a helix by a height-dependent rotation of the domain.', build: (k) => twist(k) },
  { key: 'creature', label: 'Critter', blurb: 'Body, head, ears and snout blended into one watertight character.', build: (k) => creature(k) },
  { key: 'ring', label: 'Ring & Core', blurb: 'A torus blended with a sphere — small blends keep the hole, large ones fill it.', build: (k) => ring(k) },
  { key: 'carved', label: 'Carved', blurb: 'A sphere with a cubic bite taken out and smaller spheres unioned back in.', build: (k) => carved(k) },
]

export const buildSdf = (key: string, k: number, iso: number): Sdf => {
  const p = SDF_PRESETS.find((s) => s.key === key) ?? SDF_PRESETS[0]
  return p.build(k, iso)
}
