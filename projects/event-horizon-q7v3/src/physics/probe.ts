// The photon probe. Click a pixel in the render and this module answers "what happened to *that*
// photon?" — it rebuilds the exact camera ray the fragment shader casts for that device coordinate,
// integrates the photon's null geodesic backwards with the same RK4 schemes the shader uses (the
// reduced-Cartesian Schwarzschild law, or the full Kerr Hamiltonian), and records the whole
// world-space trajectory together with its conserved quantities (E, L, Carter's Q), impact
// parameter, closest approach, lensing image order and ultimate fate.
//
// Two invariants make this trustworthy rather than decorative:
//   • the integrators are line-for-line the ones in gl/shaders.ts, so the recovered path is the one
//     the clicked pixel actually shows, and
//   • the camera-ray reconstruction includes the identical free-fall aberration boost, so a click in
//     the rain frame traces the photon you are really seeing.
//
// Units: rs = 1, so M = 0.5 (matches the shader's `MASS` and the rest of the app).

import type { Params } from '../types'
import { M, B_CRIT, effectiveDiskInner, chargeQ2 } from '../state'
import { horizons } from './kerr'
import { initKerrPhoton, kerrDeriv, kerrCov, worldToBL, carterConstant } from './cpu-geodesic'
import type { Vec3 } from '../math/vec'
import { cross, dot, length, normalize, orbitPosition, lookBasis, sub } from '../math/vec'

const PI = Math.PI

export type ProbeFate = 'captured' | 'disk' | 'sky'

export interface ProbeResult {
  kind: 'schwarzschild' | 'kerr'
  /** The photon's world-space trajectory, from the camera outward (backwards in time). */
  path: Vec3[]
  fate: ProbeFate
  /** True if the ray plunged through the outer horizon. */
  captured: boolean
  /** True if the ray crossed the luminous disk annulus (it may still continue — the disk is thin). */
  hitDisk: boolean
  /** Boyer–Lindquist radius of the first disk crossing (rs), if any. */
  diskHitRadius: number
  /** Final propagation direction if the photon escaped to the background sky. */
  skyDir: Vec3 | null
  /** Closest approach to the singularity along the path (rs). */
  rMin: number
  /** World-space point of closest approach (for the overlay marker). */
  rMinPoint: Vec3
  /** World-space point of the first disk crossing, if any. */
  diskHitPoint: Vec3 | null
  /** Equatorial-plane crossings — the gravitational-lensing image order (0 = direct image). */
  crossings: number
  /** Total turning of the ray (rad); can exceed 2π for photons that loop the hole. */
  deflection: number
  /** Conserved energy E = −p_t (affine normalisation; 1 for the Schwarzschild reduced model). */
  E: number
  /** Conserved axial angular momentum L = p_φ. */
  L: number
  /** Carter's constant Q — the third integral of motion (0 for a Schwarzschild equatorial ray). */
  Q: number
  /** Impact parameter b = |L/E| (rs); compare against b_crit = 3√3·M ≈ 2.598. */
  b: number
  /** Dimensionless spin a/M the trace was run at. */
  spin: number
  /** Dimensionless charge Q/M the trace was run at (0 for an uncharged hole). */
  charge: number
}

// ------------------------------------------------------------------ relativistic aberration
// Transform a light-ray direction seen in an observer's frame into the static coordinate frame,
// where the observer moves with velocity vector v (|v| < 1). Derived from the velocity-aberration
// formula and verified to reduce exactly to the shader's radial rain-frame boost when v is radial:
//   n' = ( n + [ (γ−1)(n·v̂) + γ|v| ] v̂ ) / ( γ (1 + |v|(n·v̂)) ),   D = γ (1 + |v|(n·v̂)).
// D is the Doppler factor ν_observed / ν_static for light arriving from direction n.
export function aberrate(dir: Vec3, v: Vec3): { dir: Vec3; D: number } {
  const bmag = length(v)
  if (bmag < 2e-4) return { dir, D: 1 }
  const vhat: Vec3 = [v[0] / bmag, v[1] / bmag, v[2] / bmag]
  const mu = dot(dir, vhat)
  const g = 1 / Math.sqrt(1 - bmag * bmag)
  const s = (g - 1) * mu + g * bmag
  const num: Vec3 = [dir[0] + s * vhat[0], dir[1] + s * vhat[1], dir[2] + s * vhat[2]]
  const denom = g * (1 + bmag * mu)
  return { dir: normalize([num[0] / denom, num[1] / denom, num[2] / denom]), D: denom }
}

// ------------------------------------------------------------------ free-fall observer velocity
/**
 * The free-fall camera's velocity vector in world coordinates, or the zero vector for a static
 * camera. The radial part is the Gullstrand–Painlevé raindrop speed β = √(rs/r). For a spinning
 * hole (a > 0) we add the zero-angular-momentum (ZAMO) azimuthal drift ω = −g_tφ/g_φφ, converted
 * to a local speed via the proper circumferential radius √(g_φφ), so plunging into a Kerr hole
 * swirls the sky as frame dragging demands. This is the single source of truth shared by the
 * renderer (which uploads it as `uObserverVel`) and the probe (which aberrates its camera ray with
 * it), so the two never drift apart.
 */
export function observerVelocity(params: Params): Vec3 {
  if (!params.freeFall) return [0, 0, 0]
  const eye = orbitPosition(params.cameraDistance, params.inclination, params.azimuth)
  const r = Math.max(length(eye), 1.0001)
  const betaR = Math.min(Math.sqrt(1 / r), 0.9985) // GP radial infall speed
  const eR: Vec3 = [-eye[0] / r, -eye[1] / r, -eye[2] / r] // radially inward
  const rho = Math.max(Math.hypot(eye[0], eye[2]), 1e-6)
  const ePhi: Vec3 = [-eye[2] / rho, 0, eye[0] / rho] // azimuthal about the +Y spin axis

  let betaPhi = 0
  const a = params.spin * M
  const q2 = chargeQ2(params.charge)
  if (a > 1e-5) {
    const bl = worldToBL(eye, a)
    const c = kerrCov(bl.r, bl.th, a, q2)
    const omega = -c.gtp / c.gpp // ZAMO coordinate angular velocity
    betaPhi = omega * Math.sqrt(Math.max(c.gpp, 0)) // ω · proper circumferential radius
  }

  let v: Vec3 = [
    eR[0] * betaR + ePhi[0] * betaPhi,
    eR[1] * betaR + ePhi[1] * betaPhi,
    eR[2] * betaR + ePhi[2] * betaPhi,
  ]
  const mag = length(v)
  if (mag > 0.9985) v = [(v[0] / mag) * 0.9985, (v[1] / mag) * 0.9985, (v[2] / mag) * 0.9985]
  return v
}

// ------------------------------------------------------------------ camera ray reconstruction
/**
 * Rebuild the exact ray the fragment shader casts for a normalised device coordinate. `ndcX` must
 * already carry the aspect factor the shader applies (uv.x *= aspect); `ndcY` is +up. Returns the
 * world-space camera position, the (possibly aberrated) ray direction, and the free-fall Doppler
 * factor for that direction.
 */
export function cameraRay(params: Params, ndcX: number, ndcY: number): { pos: Vec3; dir: Vec3; D: number } {
  const eye = orbitPosition(params.cameraDistance, params.inclination, params.azimuth)
  const { right, up, forward } = lookBasis(eye, [0, 0, 0])
  const tanHalf = Math.tan((params.fov * PI) / 180 / 2)
  const raw = normalize([
    forward[0] + ndcX * tanHalf * right[0] + ndcY * tanHalf * up[0],
    forward[1] + ndcX * tanHalf * right[1] + ndcY * tanHalf * up[1],
    forward[2] + ndcX * tanHalf * right[2] + ndcY * tanHalf * up[2],
  ])
  const v = observerVelocity(params)
  const { dir, D } = aberrate(raw, v)
  return { pos: eye, dir, D }
}

// ------------------------------------------------------------------ Boyer–Lindquist → world
function blToWorld(r: number, th: number, ph: number, a: number): Vec3 {
  const s = Math.sqrt(r * r + a * a)
  const st = Math.sin(th)
  return [s * st * Math.cos(ph), r * Math.cos(th), s * st * Math.sin(ph)]
}

// ------------------------------------------------------------------ Schwarzschild path recorder
function tracePhotonPathSchw(pos0: Vec3, dir0: Vec3, params: Params): ProbeResult {
  const steps = Math.max(Math.round(params.steps), 700)
  const stepSize = params.stepSize
  const camR = length(pos0)
  const escapeR = Math.max(32, camR * 1.7)
  const diskInner = effectiveDiskInner(params)
  const diskOuter = Math.max(params.diskOuter, diskInner + 0.5)

  let pos: Vec3 = [pos0[0], pos0[1], pos0[2]]
  let vel = normalize(dir0)
  const Lvec = cross(pos, vel)
  const h2 = dot(Lvec, Lvec)

  const accel = (p: Vec3): Vec3 => {
    const r2 = Math.max(dot(p, p), 0.09)
    const k = (-1.5 * h2) / (r2 * r2 * Math.sqrt(r2))
    return [k * p[0], k * p[1], k * p[2]]
  }

  const path: Vec3[] = [[pos[0], pos[1], pos[2]]]
  let rMin = camR
  let rMinPoint: Vec3 = [pos[0], pos[1], pos[2]]
  let crossings = 0
  let deflection = 0
  let captured = false
  let escaped = false
  let hitDisk = false
  let diskHitRadius = 0
  let diskHitPoint: Vec3 | null = null

  for (let i = 0; i < steps; i++) {
    const r = length(pos)
    if (r < rMin) {
      rMin = r
      rMinPoint = [pos[0], pos[1], pos[2]]
    }
    if (r < 1.0) {
      captured = true
      break
    }
    if (r > escapeR && dot(pos, vel) > 0) {
      escaped = true
      break
    }

    const dt = stepSize * (0.35 + 0.22 * r)
    const a1 = accel(pos)
    const v2: Vec3 = [vel[0] + 0.5 * dt * a1[0], vel[1] + 0.5 * dt * a1[1], vel[2] + 0.5 * dt * a1[2]]
    const a2 = accel([pos[0] + 0.5 * dt * vel[0], pos[1] + 0.5 * dt * vel[1], pos[2] + 0.5 * dt * vel[2]])
    const v3: Vec3 = [vel[0] + 0.5 * dt * a2[0], vel[1] + 0.5 * dt * a2[1], vel[2] + 0.5 * dt * a2[2]]
    const a3 = accel([pos[0] + 0.5 * dt * v2[0], pos[1] + 0.5 * dt * v2[1], pos[2] + 0.5 * dt * v2[2]])
    const v4: Vec3 = [vel[0] + dt * a3[0], vel[1] + dt * a3[1], vel[2] + dt * a3[2]]
    const a4 = accel([pos[0] + dt * v3[0], pos[1] + dt * v3[1], pos[2] + dt * v3[2]])

    const newPos: Vec3 = [
      pos[0] + (dt / 6) * (vel[0] + 2 * v2[0] + 2 * v3[0] + v4[0]),
      pos[1] + (dt / 6) * (vel[1] + 2 * v2[1] + 2 * v3[1] + v4[1]),
      pos[2] + (dt / 6) * (vel[2] + 2 * v2[2] + 2 * v3[2] + v4[2]),
    ]
    const newVel: Vec3 = [
      vel[0] + (dt / 6) * (a1[0] + 2 * a2[0] + 2 * a3[0] + a4[0]),
      vel[1] + (dt / 6) * (a1[1] + 2 * a2[1] + 2 * a3[1] + a4[1]),
      vel[2] + (dt / 6) * (a1[2] + 2 * a2[2] + 2 * a3[2] + a4[2]),
    ]

    // equatorial-plane crossing → lensing image order (and the first disk interaction)
    if (pos[1] * newPos[1] < 0) {
      crossings++
      const tt = pos[1] / (pos[1] - newPos[1])
      const hit: Vec3 = [pos[0] + tt * (newPos[0] - pos[0]), 0, pos[2] + tt * (newPos[2] - pos[2])]
      const rr = length(hit)
      if (!hitDisk && rr > diskInner && rr < diskOuter) {
        hitDisk = true
        diskHitRadius = rr
        diskHitPoint = hit
      }
    }
    // accumulate total turning of the ray direction
    const nv = normalize(newVel)
    deflection += Math.acos(Math.min(Math.max(dot(normalize(vel), nv), -1), 1))

    pos = newPos
    vel = newVel
    path.push([pos[0], pos[1], pos[2]])
  }

  const fate: ProbeFate = captured ? 'captured' : hitDisk && !escaped ? 'disk' : escaped ? 'sky' : 'sky'
  return {
    kind: 'schwarzschild',
    path,
    fate,
    captured,
    hitDisk,
    diskHitRadius,
    skyDir: escaped ? normalize(vel) : null,
    rMin,
    rMinPoint,
    diskHitPoint,
    crossings,
    deflection,
    E: 1,
    L: Math.sqrt(h2),
    Q: 0,
    b: Math.sqrt(h2),
    spin: 0,
    charge: 0,
  }
}

// ------------------------------------------------------------------ Kerr path recorder
function tracePhotonPathKerr(pos0: Vec3, dir0: Vec3, params: Params): ProbeResult {
  const a = params.spin * M
  const q2 = chargeQ2(params.charge)
  const { rPlus } = horizons(a, q2)
  const init = initKerrPhoton(pos0, normalize(dir0), a, q2)
  let { r, th, ph, pr, pth } = init
  const { E, L } = init
  const Q = carterConstant(th, pth, E, L, a)

  const steps = Math.max(Math.round(params.steps), 700)
  const stepSize = params.stepSize
  const escapeR = Math.max(32, length(pos0) * 1.7)
  const diskInner = effectiveDiskInner(params)
  const diskOuter = Math.max(params.diskOuter, diskInner + 0.5)

  const path: Vec3[] = [blToWorld(r, th, ph, a)]
  let prevWorld = path[0]
  let prevY = prevWorld[1]
  let rMin = r
  let rMinPoint: Vec3 = path[0]
  let crossings = 0
  let deflection = 0
  let captured = false
  let escaped = false
  let hitDisk = false
  let diskHitRadius = 0
  let diskHitPoint: Vec3 | null = null

  for (let i = 0; i < steps; i++) {
    if (r < rMin) {
      rMin = r
      rMinPoint = prevWorld
    }
    if (r < rPlus + 0.06 * rPlus) {
      captured = true
      break
    }
    if (r > escapeR && pr > 0) {
      escaped = true
      break
    }

    const prox = Math.min(Math.max((r - rPlus) * 1.6, 0.12), 1)
    const dt = stepSize * (0.35 + 0.22 * r) * prox

    const k1 = kerrDeriv(r, th, pr, pth, E, L, a, q2)
    const k2 = kerrDeriv(r + 0.5 * dt * k1.dr, th + 0.5 * dt * k1.dth, pr + 0.5 * dt * k1.dpr, pth + 0.5 * dt * k1.dpth, E, L, a, q2)
    const k3 = kerrDeriv(r + 0.5 * dt * k2.dr, th + 0.5 * dt * k2.dth, pr + 0.5 * dt * k2.dpr, pth + 0.5 * dt * k2.dpth, E, L, a, q2)
    const k4 = kerrDeriv(r + dt * k3.dr, th + dt * k3.dth, pr + dt * k3.dpr, pth + dt * k3.dpth, E, L, a, q2)

    const nr = r + (dt / 6) * (k1.dr + 2 * k2.dr + 2 * k3.dr + k4.dr)
    let nth = th + (dt / 6) * (k1.dth + 2 * k2.dth + 2 * k3.dth + k4.dth)
    let nph = ph + (dt / 6) * (k1.dphi + 2 * k2.dphi + 2 * k3.dphi + k4.dphi)
    const npr = pr + (dt / 6) * (k1.dpr + 2 * k2.dpr + 2 * k3.dpr + k4.dpr)
    let npth = pth + (dt / 6) * (k1.dpth + 2 * k2.dpth + 2 * k3.dpth + k4.dpth)

    // pole reflection keeps the reconstructed world path continuous across the Boyer–Lindquist axis
    if (nth < 0) {
      nth = -nth
      nph += PI
      npth = -npth
    } else if (nth > PI) {
      nth = 2 * PI - nth
      nph += PI
      npth = -npth
    }

    const world = blToWorld(nr, nth, nph, a)
    if (prevY * world[1] < 0) {
      crossings++
      const tt = prevY / (prevY - world[1])
      const rHit = r + tt * (nr - r)
      if (!hitDisk && rHit > diskInner && rHit < diskOuter) {
        hitDisk = true
        diskHitRadius = rHit
        diskHitPoint = [
          prevWorld[0] + tt * (world[0] - prevWorld[0]),
          0,
          prevWorld[2] + tt * (world[2] - prevWorld[2]),
        ]
      }
    }
    // total turning of the world-space ray direction
    const d0 = normalize(sub(world, prevWorld))
    if (path.length >= 2) {
      const dPrev = normalize(sub(prevWorld, path[path.length - 2]))
      deflection += Math.acos(Math.min(Math.max(dot(dPrev, d0), -1), 1))
    }

    path.push(world)
    prevWorld = world
    prevY = world[1]
    r = nr
    th = nth
    ph = nph
    pr = npr
    pth = npth
  }

  const skyDir = escaped && path.length >= 2 ? normalize(sub(path[path.length - 1], path[path.length - 2])) : null
  const fate: ProbeFate = captured ? 'captured' : escaped ? 'sky' : hitDisk ? 'disk' : 'sky'
  return {
    kind: 'kerr',
    path,
    fate,
    captured,
    hitDisk,
    diskHitRadius,
    skyDir,
    rMin,
    rMinPoint,
    diskHitPoint,
    crossings,
    deflection,
    E,
    L,
    Q,
    b: Math.abs(L / (Math.abs(E) < 1e-9 ? 1e-9 : E)),
    spin: params.spin,
    charge: params.charge,
  }
}

/**
 * Trace the photon a clicked pixel is showing. The fast reduced-Cartesian Schwarzschild recorder is
 * used only for the truly static, uncharged hole; any spin *or* charge routes through the full
 * Kerr–Newman Hamiltonian recorder (which handles a = 0, Q > 0 as the Reissner–Nordström limit).
 */
export function tracePhoton(pos: Vec3, dir: Vec3, params: Params): ProbeResult {
  const kerrNewman = params.spin >= 0.0015 || chargeQ2(params.charge) > 1e-6
  return kerrNewman ? tracePhotonPathKerr(pos, dir, params) : tracePhotonPathSchw(pos, dir, params)
}

/** A short, plain-language verdict for the probe read-out. */
export function fateLabel(res: ProbeResult): string {
  switch (res.fate) {
    case 'captured':
      return 'Captured — crossed the event horizon'
    case 'disk':
      return `Absorbed by the accretion disk at r = ${res.diskHitRadius.toFixed(2)} rs`
    case 'sky':
      return res.hitDisk
        ? `Grazed the disk (r = ${res.diskHitRadius.toFixed(2)} rs), then escaped to the sky`
        : 'Escaped to the background sky'
  }
}

/** Whether the photon's impact parameter puts it inside the capture cross-section (b < b_crit). */
export function subCritical(res: ProbeResult): boolean {
  return res.b < B_CRIT
}
