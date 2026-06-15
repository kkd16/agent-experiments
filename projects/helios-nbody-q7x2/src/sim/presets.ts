// Preset initial conditions.
//
// Each preset fills struct-of-arrays buffers and returns the body count plus a
// recommended set of simulation parameters and an initial view scale. Velocity
// fields are chosen so that disks orbit rather than instantly collapse: for a
// body at radius r around enclosed mass M(r), the circular speed is
// v = √(G · M(r) / r).

import { Rng } from './rng'
import type { SimParams } from './types'

export interface PresetBuffers {
  n: number
  posX: Float64Array
  posY: Float64Array
  velX: Float64Array
  velY: Float64Array
  mass: Float64Array
}

export interface PresetResult extends PresetBuffers {
  params: Partial<SimParams>
  /** Half-extent the camera should frame initially (world units). */
  viewExtent: number
}

export interface PresetDef {
  id: string
  name: string
  description: string
  /** Suggested body count; the UI may override within [min, max]. */
  defaultCount: number
  minCount: number
  maxCount: number
  build: (count: number, seed: number) => PresetResult
}

function alloc(n: number): PresetBuffers {
  return {
    n,
    posX: new Float64Array(n),
    posY: new Float64Array(n),
    velX: new Float64Array(n),
    velY: new Float64Array(n),
    mass: new Float64Array(n),
  }
}

interface DiskOptions {
  count: number
  cx: number
  cy: number
  bulkVx: number
  bulkVy: number
  radius: number
  scaleLength: number
  centralMass: number
  starMass: number
  g: number
  spin: number // +1 counter-clockwise, -1 clockwise
  dispersion: number // fractional random scatter on the circular speed
  thickness: number // positional jitter as a fraction of radius
}

/**
 * Fill a slice of the buffers (starting at `offset`) with a rotating disk plus a
 * central mass. Returns the number of bodies written.
 */
function fillDisk(buf: PresetBuffers, offset: number, rng: Rng, o: DiskOptions): number {
  let i = offset
  const diskMass = (o.count - 1) * o.starMass

  // Central concentration (galactic bulge / black hole).
  buf.posX[i] = o.cx
  buf.posY[i] = o.cy
  buf.velX[i] = o.bulkVx
  buf.velY[i] = o.bulkVy
  buf.mass[i] = o.centralMass
  i++

  for (let k = 1; k < o.count; k++, i++) {
    // Exponential-disk radius sampling, truncated at the visible radius.
    let r = -Math.log(1 - 0.98 * rng.next()) * o.scaleLength
    if (r > o.radius) r = o.radius * rng.next()
    const theta = rng.next() * 2 * Math.PI
    const ux = Math.cos(theta)
    const uy = Math.sin(theta)

    const jitter = o.thickness * o.radius
    const x = o.cx + ux * r + rng.gaussian(0, jitter)
    const y = o.cy + uy * r + rng.gaussian(0, jitter)

    // Enclosed mass: central mass + a fraction of the disk growing like r².
    const frac = Math.min(1, (r / o.radius) * (r / o.radius))
    const enclosed = o.centralMass + diskMass * frac
    const vCirc = Math.sqrt((o.g * enclosed) / (r + o.scaleLength * 0.25))
    const speed = vCirc * (1 + rng.gaussian(0, o.dispersion))

    // Tangential direction (perpendicular to the radius), signed by spin.
    const tx = -uy * o.spin
    const ty = ux * o.spin

    buf.posX[i] = x
    buf.posY[i] = y
    buf.velX[i] = o.bulkVx + tx * speed
    buf.velY[i] = o.bulkVy + ty * speed
    buf.mass[i] = o.starMass
  }
  return i - offset
}

const spiralGalaxy: PresetDef = {
  id: 'spiral-galaxy',
  name: 'Spiral Galaxy',
  description:
    'A rotating exponential disk around a heavy galactic core. Differential rotation winds up transient spiral arms.',
  defaultCount: 4000,
  minCount: 200,
  maxCount: 20000,
  build(count, seed) {
    const buf = alloc(count)
    const rng = new Rng(seed)
    const radius = 320
    fillDisk(buf, 0, rng, {
      count,
      cx: 0,
      cy: 0,
      bulkVx: 0,
      bulkVy: 0,
      radius,
      scaleLength: radius * 0.32,
      centralMass: count * 0.6,
      starMass: 1,
      g: 1,
      spin: 1,
      dispersion: 0.06,
      thickness: 0.02,
    })
    return { ...buf, params: { g: 1, dt: 0.08, softening: 4, theta: 0.7 }, viewExtent: radius * 1.4 }
  },
}

const galaxyCollision: PresetDef = {
  id: 'galaxy-collision',
  name: 'Galaxy Collision',
  description:
    'Two disk galaxies on a hyperbolic encounter. Tidal forces fling out spectacular bridges and tails.',
  defaultCount: 5000,
  minCount: 400,
  maxCount: 20000,
  build(count, seed) {
    const buf = alloc(count)
    const rng = new Rng(seed)
    const half = Math.floor(count / 2)
    const radius = 220
    const sep = 520
    const approach = 4.2

    fillDisk(buf, 0, rng, {
      count: half,
      cx: -sep / 2,
      cy: -120,
      bulkVx: approach,
      bulkVy: 0,
      radius,
      scaleLength: radius * 0.3,
      centralMass: half * 0.7,
      starMass: 1,
      g: 1,
      spin: 1,
      dispersion: 0.05,
      thickness: 0.02,
    })
    fillDisk(buf, half, rng, {
      count: count - half,
      cx: sep / 2,
      cy: 120,
      bulkVx: -approach,
      bulkVy: 0,
      radius: radius * 0.85,
      scaleLength: radius * 0.27,
      centralMass: (count - half) * 0.7,
      starMass: 1,
      g: 1,
      spin: -1,
      dispersion: 0.05,
      thickness: 0.02,
    })
    return { ...buf, params: { g: 1, dt: 0.06, softening: 4, theta: 0.7 }, viewExtent: 620 }
  },
}

const plummerCluster: PresetDef = {
  id: 'plummer-cluster',
  name: 'Plummer Cluster',
  description:
    'A pressure-supported globular cluster sampled from a Plummer density profile, near virial equilibrium.',
  defaultCount: 3000,
  minCount: 200,
  maxCount: 15000,
  build(count, seed) {
    const buf = alloc(count)
    const rng = new Rng(seed)
    const a = 80 // Plummer scale radius
    const g = 1
    const starMass = 1
    const totalMass = count * starMass

    for (let i = 0; i < count; i++) {
      // Inverse-CDF radius for the Plummer mass profile:
      //   M(<r)/M = r³ / (r² + a²)^{3/2}  ⇒  r = a / √(X^{-2/3} − 1).
      let x = rng.next()
      if (x < 1e-6) x = 1e-6
      const r = a / Math.sqrt(Math.pow(x, -2 / 3) - 1)
      const theta = rng.next() * 2 * Math.PI
      buf.posX[i] = r * Math.cos(theta)
      buf.posY[i] = r * Math.sin(theta)

      // Local circular speed scaled down to a velocity dispersion, with an
      // isotropic random direction → roughly virialised, pressure-supported.
      const enclosed = totalMass * (r * r * r) / Math.pow(r * r + a * a, 1.5)
      const vScale = Math.sqrt((g * (enclosed + 1)) / (r + a)) * 0.7
      const phi = rng.next() * 2 * Math.PI
      const speed = Math.abs(rng.gaussian(0, vScale))
      buf.velX[i] = speed * Math.cos(phi)
      buf.velY[i] = speed * Math.sin(phi)
      buf.mass[i] = starMass
    }
    return { ...buf, params: { g: 1, dt: 0.06, softening: 4, theta: 0.65 }, viewExtent: a * 5 }
  },
}

const coldCollapse: PresetDef = {
  id: 'cold-collapse',
  name: 'Cold Collapse',
  description:
    'A uniform, non-rotating cloud released from rest. Self-gravity drives a dramatic collapse and violent relaxation.',
  defaultCount: 3000,
  minCount: 200,
  maxCount: 15000,
  build(count, seed) {
    const buf = alloc(count)
    const rng = new Rng(seed)
    const radius = 240
    for (let i = 0; i < count; i++) {
      const [dx, dy] = rng.inUnitDisk()
      buf.posX[i] = dx * radius
      buf.posY[i] = dy * radius
      buf.velX[i] = 0
      buf.velY[i] = 0
      buf.mass[i] = 1
    }
    return { ...buf, params: { g: 1, dt: 0.04, softening: 5, theta: 0.7 }, viewExtent: radius * 1.5 }
  },
}

const solarSystem: PresetDef = {
  id: 'solar-system',
  name: 'Solar System',
  description:
    'A central star with planets on circular Keplerian orbits — a clean demonstration of two-body gravity.',
  defaultCount: 9,
  minCount: 2,
  maxCount: 40,
  build(count, seed) {
    const buf = alloc(count)
    const rng = new Rng(seed)
    const g = 1
    const starMass = 12000
    buf.posX[0] = 0
    buf.posY[0] = 0
    buf.velX[0] = 0
    buf.velY[0] = 0
    buf.mass[0] = starMass

    for (let i = 1; i < count; i++) {
      const r = 60 + (i - 1) * 42 + rng.range(-6, 6)
      const theta = rng.next() * 2 * Math.PI
      const v = Math.sqrt((g * starMass) / r)
      const ux = Math.cos(theta)
      const uy = Math.sin(theta)
      buf.posX[i] = ux * r
      buf.posY[i] = uy * r
      buf.velX[i] = -uy * v
      buf.velY[i] = ux * v
      buf.mass[i] = rng.range(1, 30)
    }
    return { ...buf, params: { g: 1, dt: 0.02, softening: 1, theta: 0.5 }, viewExtent: 60 + count * 44 }
  },
}

const binaryStars: PresetDef = {
  id: 'binary-stars',
  name: 'Binary + Disk',
  description:
    'Two massive stars in a tight binary, wrapped by a disk of test particles carved into resonant gaps.',
  defaultCount: 3000,
  minCount: 200,
  maxCount: 15000,
  build(count, seed) {
    const buf = alloc(count)
    const rng = new Rng(seed)
    const g = 1
    const m = 4000
    const sep = 70
    // Two equal masses separated by `sep` each orbit the centre at radius
    // sep/2 with speed v = √(G m / (2 sep)).
    const vOrbit = Math.sqrt((g * m) / (2 * sep))
    buf.posX[0] = -sep / 2
    buf.posY[0] = 0
    buf.velX[0] = 0
    buf.velY[0] = -vOrbit
    buf.mass[0] = m
    buf.posX[1] = sep / 2
    buf.posY[1] = 0
    buf.velX[1] = 0
    buf.velY[1] = vOrbit
    buf.mass[1] = m

    const radius = 360
    for (let i = 2; i < count; i++) {
      const r = sep * 1.8 + rng.next() * (radius - sep * 1.8)
      const theta = rng.next() * 2 * Math.PI
      const ux = Math.cos(theta)
      const uy = Math.sin(theta)
      const v = Math.sqrt((g * 2 * m) / r)
      buf.posX[i] = ux * r
      buf.posY[i] = uy * r
      buf.velX[i] = -uy * v
      buf.velY[i] = ux * v
      buf.mass[i] = 0.2
    }
    return { ...buf, params: { g: 1, dt: 0.015, softening: 2, theta: 0.6 }, viewExtent: radius * 1.2 }
  },
}

const randomCloud: PresetDef = {
  id: 'random-cloud',
  name: 'Random Cloud',
  description: 'Particles scattered with random positions and velocities — gravity does the rest.',
  defaultCount: 2000,
  minCount: 100,
  maxCount: 15000,
  build(count, seed) {
    const buf = alloc(count)
    const rng = new Rng(seed)
    const radius = 300
    for (let i = 0; i < count; i++) {
      const [dx, dy] = rng.inUnitDisk()
      buf.posX[i] = dx * radius
      buf.posY[i] = dy * radius
      buf.velX[i] = rng.gaussian(0, 2)
      buf.velY[i] = rng.gaussian(0, 2)
      buf.mass[i] = rng.range(0.5, 2)
    }
    return { ...buf, params: { g: 1, dt: 0.05, softening: 5, theta: 0.7 }, viewExtent: radius * 1.5 }
  },
}

// Saturn's rings: a heavy planet wrapped by a thin annulus of test particles on
// circular orbits, with a single shepherd moon. Mean-motion resonances with the
// moon clear gaps in the ring, à la the Cassini division.
const saturnRings: PresetDef = {
  id: 'saturn-rings',
  name: "Saturn's Rings",
  description:
    'A heavy planet, a thin ring of test particles on circular orbits, and a shepherd moon whose resonances carve gaps into the ring.',
  defaultCount: 4000,
  minCount: 500,
  maxCount: 15000,
  build(count, seed) {
    const buf = alloc(count)
    const rng = new Rng(seed)
    const g = 1
    const planet = 8000
    buf.posX[0] = 0
    buf.posY[0] = 0
    buf.velX[0] = 0
    buf.velY[0] = 0
    buf.mass[0] = planet

    // Shepherd moon on a circular orbit just outside the ring.
    const rMoon = 230
    const moonMass = 70
    const vMoon = Math.sqrt((g * planet) / rMoon)
    buf.posX[1] = rMoon
    buf.posY[1] = 0
    buf.velX[1] = 0
    buf.velY[1] = vMoon
    buf.mass[1] = moonMass

    const rIn = 110
    const rOut = 200
    for (let i = 2; i < count; i++) {
      const r = rIn + rng.next() * (rOut - rIn)
      const theta = rng.next() * 2 * Math.PI
      const ux = Math.cos(theta)
      const uy = Math.sin(theta)
      const v = Math.sqrt((g * planet) / r)
      buf.posX[i] = ux * r + rng.gaussian(0, 1.2)
      buf.posY[i] = uy * r + rng.gaussian(0, 1.2)
      buf.velX[i] = -uy * v
      buf.velY[i] = ux * v
      buf.mass[i] = 0.02
    }
    return {
      ...buf,
      params: { g: 1, dt: 0.05, softening: 1.5, theta: 0.6 },
      viewExtent: rMoon * 1.5,
    }
  },
}

// Sun–Jupiter Trojans: the Sun, one giant planet, and two asteroid swarms that
// librate around the L4 and L5 Lagrange points 60° ahead of and behind the
// planet — the real Jupiter Trojans, in miniature.
const trojans: PresetDef = {
  id: 'trojans',
  name: 'Trojan Swarms',
  description:
    'The Sun, a giant planet, and two asteroid clouds librating around the L4/L5 Lagrange points 60° ahead of and behind the planet.',
  defaultCount: 3000,
  minCount: 500,
  maxCount: 12000,
  build(count, seed) {
    const buf = alloc(count)
    const rng = new Rng(seed)
    const g = 1
    const sun = 14000
    const R = 260
    const planetMass = 16
    const vP = Math.sqrt((g * sun) / R)

    // Planet on a circular orbit at angle 0; the Sun gets a tiny recoil so the
    // total momentum starts near zero.
    buf.posX[1] = R
    buf.posY[1] = 0
    buf.velX[1] = 0
    buf.velY[1] = vP
    buf.mass[1] = planetMass

    buf.posX[0] = 0
    buf.posY[0] = 0
    buf.velX[0] = 0
    buf.velY[0] = -(planetMass * vP) / sun
    buf.mass[0] = sun

    const L4 = Math.PI / 3 // +60°
    const L5 = -Math.PI / 3 // −60°
    for (let i = 2; i < count; i++) {
      const lead = i % 2 === 0
      const base = lead ? L4 : L5
      const ang = base + rng.gaussian(0, 0.12)
      const r = R + rng.gaussian(0, 10)
      const ux = Math.cos(ang)
      const uy = Math.sin(ang)
      const v = Math.sqrt((g * sun) / r)
      buf.posX[i] = ux * r
      buf.posY[i] = uy * r
      buf.velX[i] = -uy * v
      buf.velY[i] = ux * v
      buf.mass[i] = 0.01
    }
    return { ...buf, params: { g: 1, dt: 0.05, softening: 2, theta: 0.6 }, viewExtent: R * 1.5 }
  },
}

// The figure-eight choreography (Chenciner–Montgomery, 2000): three equal masses
// chasing one another along a single figure-eight curve. A stunning exact
// solution and a brutal test of an integrator — symplectic schemes trace the
// eight indefinitely; explicit Euler unravels it within an orbit.
const figureEight: PresetDef = {
  id: 'figure-eight',
  name: 'Figure-Eight',
  description:
    'Three equal masses chasing each other along one figure-eight curve — the famous Chenciner–Montgomery choreography, and a brutal integrator test.',
  defaultCount: 3,
  minCount: 3,
  maxCount: 3,
  build() {
    const buf = alloc(3)
    const L = 150 // length scale
    const M = 300 // mass of each body
    const vmul = Math.sqrt(M / L) // velocity rescale for G = 1
    // Canonical initial conditions (G = m = 1).
    const px = 0.97000436
    const py = -0.24308753
    const vx = 0.4662036850
    const vy = 0.4323657300
    // Body 1 and 2 (mirror images), then body 3 at the origin.
    buf.posX[0] = px * L
    buf.posY[0] = py * L
    buf.velX[0] = vx * vmul
    buf.velY[0] = vy * vmul
    buf.posX[1] = -px * L
    buf.posY[1] = -py * L
    buf.velX[1] = vx * vmul
    buf.velY[1] = vy * vmul
    buf.posX[2] = 0
    buf.posY[2] = 0
    buf.velX[2] = -2 * vx * vmul
    buf.velY[2] = -2 * vy * vmul
    buf.mass[0] = M
    buf.mass[1] = M
    buf.mass[2] = M
    return { ...buf, params: { g: 1, dt: 0.25, softening: 0.5, theta: 0.2 }, viewExtent: L * 1.6 }
  },
}

// The Pythagorean three-body problem (Burrau, 1913): masses 3, 4, 5 released
// from rest at the corners of a 3-4-5 right triangle. Deterministic yet wildly
// chaotic — repeated close encounters eventually eject a body and leave a binary.
const pythagorean: PresetDef = {
  id: 'pythagorean',
  name: 'Pythagorean 3-Body',
  description:
    'Masses 3, 4, 5 released from rest at the corners of a 3-4-5 right triangle — the Burrau problem, deterministic but famously chaotic.',
  defaultCount: 3,
  minCount: 3,
  maxCount: 3,
  build() {
    const buf = alloc(3)
    const L = 40 // length scale
    const mf = 80 // mass scale
    // Classic Burrau placement.
    buf.posX[0] = 1 * L
    buf.posY[0] = 3 * L
    buf.mass[0] = 3 * mf
    buf.posX[1] = -2 * L
    buf.posY[1] = -1 * L
    buf.mass[1] = 4 * mf
    buf.posX[2] = 1 * L
    buf.posY[2] = -1 * L
    buf.mass[2] = 5 * mf
    // All at rest.
    return { ...buf, params: { g: 1, dt: 0.02, softening: 2, theta: 0.3 }, viewExtent: 220 }
  },
}

// Kepler Showcase: a heavy star with a fan of planets on increasingly eccentric
// orbits, each launched exactly from periapsis. Built to exercise the osculating
// orbit overlay — every planet's drawn ellipse should hug its path. Runs on the
// 4th-order Yoshida integrator so even the high-e orbits close cleanly.
const keplerShowcase: PresetDef = {
  id: 'kepler-showcase',
  name: 'Kepler Showcase',
  description:
    'A star with planets on a ladder of eccentric orbits (e ≈ 0.1 → 0.75), each started from periapsis — turn on the osculating orbit overlay to watch each ellipse hug its body.',
  defaultCount: 7,
  minCount: 3,
  maxCount: 24,
  build(count, seed) {
    const buf = alloc(count)
    const rng = new Rng(seed)
    const g = 1
    const starMass = 16000
    buf.mass[0] = starMass

    const planets = count - 1
    for (let k = 0; k < planets; k++) {
      const i = k + 1
      const a = 70 + k * 38 // semi-major axis ladder
      const e = planets > 1 ? 0.1 + 0.65 * (k / (planets - 1)) : 0.4
      const mu = g * (starMass + 1)
      // Periapsis radius and speed for this ellipse (vis-viva at periapsis).
      const rp = a * (1 - e)
      const vp = Math.sqrt((mu / a) * ((1 + e) / (1 - e)))
      const w = rng.range(0, Math.PI * 2) // orient periapsis randomly
      const ux = Math.cos(w)
      const uy = Math.sin(w)
      // At periapsis the velocity is perpendicular to the radius (prograde).
      buf.posX[i] = rp * ux
      buf.posY[i] = rp * uy
      buf.velX[i] = -uy * vp
      buf.velY[i] = ux * vp
      buf.mass[i] = rng.range(2, 18)
    }
    const aMax = 70 + (planets - 1) * 38
    const eMax = planets > 1 ? 0.75 : 0.4
    return {
      ...buf,
      params: { g: 1, dt: 0.01, softening: 1, theta: 0.4, integrator: 'yoshida4' },
      viewExtent: aMax * (1 + eMax) * 1.1,
    }
  },
}

// Horseshoe & Tadpole: the Sun, one small planet, and a swarm of co-orbital test
// particles sharing the planet's orbit at slightly different semi-major axes.
// In the co-rotating frame some librate around L4/L5 (tadpoles) and some swing
// all the way around through L3 (horseshoes). Pair with the Lagrange overlay (l).
const horseshoe: PresetDef = {
  id: 'horseshoe',
  name: 'Horseshoe & Tadpole',
  description:
    'A small planet and a swarm of co-orbital particles on the same orbit — some librate around L4/L5 (tadpoles), some swing right around through L3 (horseshoes). Turn on Lagrange & Hill curves (key: l).',
  defaultCount: 2500,
  minCount: 400,
  maxCount: 10000,
  build(count, seed) {
    const buf = alloc(count)
    const rng = new Rng(seed)
    const g = 1
    const sun = 24000
    const R = 240
    const planetMass = 9 // μ ≈ 3.7e-4 — small enough for horseshoe orbits
    const vP = Math.sqrt((g * sun) / R)

    buf.posX[1] = R
    buf.posY[1] = 0
    buf.velX[1] = 0
    buf.velY[1] = vP
    buf.mass[1] = planetMass

    // Sun at the origin with a tiny recoil so total momentum ≈ 0.
    buf.posX[0] = 0
    buf.posY[0] = 0
    buf.velX[0] = 0
    buf.velY[0] = -(planetMass * vP) / sun
    buf.mass[0] = sun

    for (let i = 2; i < count; i++) {
      // Spread broadly in longitude (avoiding the planet) at near-co-orbital
      // radius; the small radial offset sets the libration amplitude.
      let ang = rng.range(0, Math.PI * 2)
      // Nudge particles away from the planet's immediate vicinity.
      if (Math.abs(ang) < 0.18) ang += 0.36
      const r = R + rng.gaussian(0, 2.2)
      const ux = Math.cos(ang)
      const uy = Math.sin(ang)
      const v = Math.sqrt((g * sun) / r)
      buf.posX[i] = ux * r
      buf.posY[i] = uy * r
      buf.velX[i] = -uy * v
      buf.velY[i] = ux * v
      buf.mass[i] = 0.005
    }
    return { ...buf, params: { g: 1, dt: 0.04, softening: 1.5, theta: 0.6 }, viewExtent: R * 1.4 }
  },
}

// Three-Body Waltz: a stable hierarchical triple — a tight inner binary orbited
// by a distant third star. The inner pair traces a thick ribbon as its centre of
// mass swings around the outer orbit. A clean, long-lived three-body system, in
// contrast to the chaotic Pythagorean problem.
const waltz: PresetDef = {
  id: 'three-body-waltz',
  name: 'Three-Body Waltz',
  description:
    'A stable hierarchical triple: a tight inner binary orbited by a distant third star. The inner pair traces a ribbon as its barycentre rides the wide orbit.',
  defaultCount: 3,
  minCount: 3,
  maxCount: 3,
  build() {
    const buf = alloc(3)
    const g = 1
    const m = 1000 // all three equal
    const Min = 2 * m
    const m3 = m
    const D = 300 // inner-COM ↔ outer separation
    const s = 40 // inner binary separation

    // Outer two-body split about the system barycentre (origin).
    const dIn = (D * m3) / (Min + m3) // 100
    const dOut = (D * Min) / (Min + m3) // 200
    const vRel = Math.sqrt((g * (Min + m3)) / D)
    const vInner = (vRel * m3) / (Min + m3) // inner-COM speed
    const vOuter = (vRel * Min) / (Min + m3) // outer-body speed

    // Inner COM on the −x side, moving −y; outer on +x, moving +y.
    const innerCx = -dIn
    const innerCy = 0
    const innerVx = 0
    const innerVy = -vInner

    // Inner binary: pair separated along y, orbiting their COM in the plane.
    const vBin = Math.sqrt((g * m) / (2 * s)) // each star's speed about inner COM
    buf.posX[0] = innerCx
    buf.posY[0] = innerCy + s / 2
    buf.velX[0] = innerVx + vBin
    buf.velY[0] = innerVy
    buf.mass[0] = m
    buf.posX[1] = innerCx
    buf.posY[1] = innerCy - s / 2
    buf.velX[1] = innerVx - vBin
    buf.velY[1] = innerVy
    buf.mass[1] = m

    // Outer star.
    buf.posX[2] = dOut
    buf.posY[2] = 0
    buf.velX[2] = 0
    buf.velY[2] = vOuter
    buf.mass[2] = m3

    return {
      ...buf,
      params: { g: 1, dt: 0.015, softening: 1, theta: 0.3, integrator: 'yoshida4' },
      viewExtent: D * 1.25,
    }
  },
}

export const PRESETS: PresetDef[] = [
  spiralGalaxy,
  galaxyCollision,
  plummerCluster,
  coldCollapse,
  solarSystem,
  binaryStars,
  saturnRings,
  trojans,
  figureEight,
  pythagorean,
  keplerShowcase,
  horseshoe,
  waltz,
  randomCloud,
]

export function presetById(id: string): PresetDef {
  return PRESETS.find((p) => p.id === id) ?? spiralGalaxy
}
