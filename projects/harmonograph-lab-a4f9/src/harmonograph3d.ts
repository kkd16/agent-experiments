// The spatial (3D) harmonograph. A planar harmonograph swings two pendulums in a
// plane and the pen traces their interference; lift the apparatus into space and
// each of the three axes is driven by its own pair of damped sinusoids. The pen
// then wanders a knotted 3D Lissajous figure — a smooth space curve rather than
// the chaotic point-cloud of a strange-attractor flow.
//
// The trick that makes it cheap: it is an exact closed form (a sum of decaying
// sines), so we just sample it and hand the 3D points to the *same* orbit camera
// the strange-attractor flows use (`makeProjector` / `geometryFromPoints` in
// `attractors3d.ts`). The renderer never learns it's looking at a 3D object — it
// receives a projected 2D polyline exactly like every other curve family — so
// drag-to-orbit, the depth cue, stereoscopy and the seamless looping export all
// work unchanged.

import type { Point } from './harmonograph'
import type { Harmonograph3DParams, Pendulum } from './types'
import { geometryFromPoints, makeProjector, type Vec3 } from './attractors3d'

const TWO_PI = Math.PI * 2
const rand = (a: number, b: number) => a + Math.random() * (b - a)
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)]

// One axis = the sum of its two damped pendulums, evaluated at time t. Matches
// the planar harmonograph's convention exactly (amp·sin(t·freq + phase)·e^{-damp·t}).
function axis(a: Pendulum, b: Pendulum, t: number): number {
  return (
    a.amp * Math.sin(t * a.freq + a.phase) * Math.exp(-a.damp * t) +
    b.amp * Math.sin(t * b.freq + b.phase) * Math.exp(-b.damp * t)
  )
}

// Sample the space curve into `n` 3D points over the drawing window.
export function sampleH3DPoints(p: Harmonograph3DParams, n: number): Vec3[] {
  const steps = Math.max(2, Math.floor(n))
  const dt = p.duration / steps
  const pts: Vec3[] = new Array(steps + 1)
  for (let i = 0; i <= steps; i++) {
    const t = i * dt
    pts[i] = {
      x: axis(p.x1, p.x2, t),
      y: axis(p.y1, p.y2, t),
      z: axis(p.z1, p.z2, t),
    }
  }
  return pts
}

// Geometry (centre + normalising scale) depends only on the *shape* of the curve
// — never the camera — so cache it by a shape signature. This keeps a spinning
// camera (Live / looping export rebuilds the params each frame) from re-measuring
// the curve every frame, mirroring the flow geometry cache in `attractors3d.ts`.
interface Geometry {
  center: Vec3
  scale: number
}
const geomCache = new Map<string, Geometry>()

function pendSig(p: Pendulum): string {
  return `${p.freq},${p.phase},${p.amp},${p.damp}`
}
function shapeSig(p: Harmonograph3DParams): string {
  return [p.x1, p.x2, p.y1, p.y2, p.z1, p.z2].map(pendSig).join('|') + `|${p.duration}|${p.steps}`
}

function getGeometry(p: Harmonograph3DParams): Geometry {
  const sig = shapeSig(p)
  let g = geomCache.get(sig)
  if (!g) {
    g = geometryFromPoints(sampleH3DPoints(p, Math.min(p.steps, 6000)))
    geomCache.set(sig, g)
  }
  return g
}

// Project the curve to a 2D polyline through the orbit camera — the `line` render
// style and the auto-fit framing both consume this.
export function sampleH3DPolyline(p: Harmonograph3DParams): Point[] {
  const { center, scale } = getGeometry(p)
  const project = makeProjector(center, scale, p)
  const n = Math.max(2, p.steps)
  const pts = sampleH3DPoints(p, n)
  const out: Point[] = new Array(pts.length)
  for (let i = 0; i < pts.length; i++) {
    const pr = project(pts[i].x, pts[i].y, pts[i].z)
    out[i] = { x: pr.x, y: pr.y }
  }
  return out
}

// Project `count` densely-sampled points with their normalised depth — the
// density renderer splats these into the glowing volumetric ribbon.
export function projectH3DPoints(
  p: Harmonograph3DParams,
  count: number,
  fn: (x: number, y: number, dn: number) => void,
): void {
  const { center, scale } = getGeometry(p)
  const project = makeProjector(center, scale, p)
  const n = Math.max(2, Math.floor(count))
  const dt = p.duration / n
  for (let i = 0; i <= n; i++) {
    const t = i * dt
    const x = axis(p.x1, p.x2, t)
    const y = axis(p.y1, p.y2, t)
    const z = axis(p.z1, p.z2, t)
    const pr = project(x, y, z)
    fn(pr.x, pr.y, pr.dn)
  }
}

// ---- defaults / randomisers ----------------------------------------------

const CAMERA = { yaw: 0.7, pitch: 0.42, dist: 2.6, fov: 1.0, depthCue: true, fog: 0, spin: 0.6 }

const pend = (freq: number, phase: number, amp: number, damp: number): Pendulum => ({
  freq,
  phase,
  amp,
  damp,
})

export function default3DHarmonograph(): Harmonograph3DParams {
  return {
    x1: pend(2, 0, 1, 0.0016),
    x2: pend(3, Math.PI / 2, 0.42, 0.004),
    y1: pend(3, Math.PI / 4, 1, 0.0016),
    y2: pend(2, 0, 0.42, 0.004),
    z1: pend(4, Math.PI / 3, 0.85, 0.0026),
    z2: pend(5, Math.PI / 6, 0.3, 0.005),
    duration: 240,
    steps: 9000,
    ...CAMERA,
  }
}

export function random3DHarmonograph(): Harmonograph3DParams {
  // Small-integer frequency ratios give clean, closed knots; a touch of damping
  // winds the figure gently inward. Two pendulums per axis, the second a quieter
  // higher harmonic, keep the curve rich without tangling into mush.
  const lo = [1, 2, 3]
  const hi = [2, 3, 4, 5, 6]
  const ax = () =>
    [
      pend(pick(lo), rand(0, TWO_PI), rand(0.8, 1), rand(0.001, 0.004)),
      pend(pick(hi), rand(0, TWO_PI), rand(0.25, 0.55), rand(0.003, 0.008)),
    ] as const
  const [x1, x2] = ax()
  const [y1, y2] = ax()
  const [z1, z2] = ax()
  return {
    x1,
    x2,
    y1,
    y2,
    z1,
    z2,
    duration: rand(180, 300),
    steps: 9000,
    ...CAMERA,
    yaw: rand(0, TWO_PI),
    pitch: rand(0.15, 0.7),
  }
}
