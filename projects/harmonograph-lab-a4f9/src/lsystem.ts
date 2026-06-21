// Lindenmayer-system (L-system) fractal curves — a seventh curve family.
//
// An L-system grows a string from an `axiom` by repeatedly rewriting every
// symbol through a set of `rules`, then a *turtle* walks the final string:
// drawing letters step forward leaving ink, `+`/`-` turn by a fixed angle, and
// `|` turns around. The classic single-stroke fractals below (Koch, the Heighway
// dragon, Hilbert/Moore/Peano space-fillers, Gosper's flowsnake, the Sierpinski
// gasket, …) are all *one connected polyline* — the pen never lifts — so they
// flow through the exact same point→metric→render pipeline as every other
// family, including the speed/curvature/angle color engine and the kaleidoscope.
//
// The headline trick: the expanded string depends only on (system, iterations),
// never on the turn angle, so Live mode can sweep the fold angle every frame
// (re-running only the cheap turtle pass) and the fractal morphs continuously —
// a dragon unfolds, a Koch curve breathes between a flat line and a spike.

import { type Point, type SampledCurve } from './harmonograph'
import type { LSystemParams } from './types'

const DEG = Math.PI / 180

export interface LSystemDef {
  id: string
  label: string
  axiom: string
  rules: Record<string, string>
  angle: number // default turn angle, radians
  draw: string // the symbols that step forward AND draw a segment
  defaultIter: number
  maxIter: number // capped so the full curve always renders (no truncation)
  start?: number // initial turtle heading in radians (plants point up: -90°)
  branching?: boolean // uses `[` / `]` to push/pop turtle state (trees/plants)
  note?: string
}

// The catalog. Every rule set here is a standard, well-documented single-stroke
// L-system; `maxIter` is chosen so even the deepest setting stays well under the
// renderer's comfortable point budget (the highest is the dragon at 2^16 segs).
export const LSYSTEMS: LSystemDef[] = [
  {
    id: 'dragon',
    label: 'Dragon',
    axiom: 'FX',
    rules: { X: 'X+YF+', Y: '-FX-Y' },
    angle: 90 * DEG,
    draw: 'F',
    defaultIter: 12,
    maxIter: 16,
    note: 'The Heighway dragon — fold a strip of paper in half over and over.',
  },
  {
    id: 'koch',
    label: 'Koch',
    axiom: 'F',
    rules: { F: 'F+F--F+F' },
    angle: 60 * DEG,
    draw: 'F',
    defaultIter: 4,
    maxIter: 6,
    note: 'The pointed Koch curve. Sweep the angle in Live and it spikes & relaxes.',
  },
  {
    id: 'snowflake',
    label: 'Snowflake',
    axiom: 'F++F++F',
    rules: { F: 'F-F++F-F' },
    angle: 60 * DEG,
    draw: 'F',
    defaultIter: 4,
    maxIter: 5,
    note: 'Three Koch curves closed into the Koch snowflake.',
  },
  {
    id: 'square-koch',
    label: 'Quadratic',
    axiom: 'F',
    rules: { F: 'F+F-F-F+F' },
    angle: 90 * DEG,
    draw: 'F',
    defaultIter: 3,
    maxIter: 4,
    note: 'The quadratic (90°) Koch curve.',
  },
  {
    id: 'levy',
    label: 'Lévy C',
    axiom: 'F',
    rules: { F: '+F--F+' },
    angle: 45 * DEG,
    draw: 'F',
    defaultIter: 10,
    maxIter: 14,
    note: 'The Lévy C curve — a right-angle cousin of the dragon.',
  },
  {
    id: 'terdragon',
    label: 'Terdragon',
    axiom: 'F',
    rules: { F: 'F+F-F' },
    angle: 120 * DEG,
    draw: 'F',
    defaultIter: 7,
    maxIter: 9,
    note: 'The terdragon — a three-fold relative of the Heighway dragon.',
  },
  {
    id: 'hilbert',
    label: 'Hilbert',
    axiom: 'A',
    rules: { A: '+BF-AFA-FB+', B: '-AF+BFB+FA-' },
    angle: 90 * DEG,
    draw: 'F',
    defaultIter: 5,
    maxIter: 7,
    note: 'The Hilbert space-filling curve — one stroke that visits every cell.',
  },
  {
    id: 'moore',
    label: 'Moore',
    axiom: 'LFL+F+LFL',
    rules: { L: '-RF+LFL+FR-', R: '+LF-RFR-FL+' },
    angle: 90 * DEG,
    draw: 'F',
    defaultIter: 4,
    maxIter: 6,
    note: 'The Moore curve — a Hilbert variant that closes into a loop.',
  },
  {
    id: 'peano',
    label: 'Peano',
    axiom: 'X',
    rules: {
      X: 'XFYFX+F+YFXFY-F-XFYFX',
      Y: 'YFXFY-F-XFYFX+F+YFXFY',
    },
    angle: 90 * DEG,
    draw: 'F',
    defaultIter: 3,
    maxIter: 4,
    note: "Peano's original space-filling curve (fills a 3×3 self-similar grid).",
  },
  {
    id: 'gosper',
    label: 'Gosper',
    axiom: 'A',
    rules: { A: 'A-B--B+A++AA+B-', B: '+A-BB--B-A++A+B' },
    angle: 60 * DEG,
    draw: 'AB',
    defaultIter: 4,
    maxIter: 5,
    note: "Gosper's flowsnake — a hexagonal space-filling curve.",
  },
  {
    id: 'arrowhead',
    label: 'Arrowhead',
    axiom: 'A',
    rules: { A: 'B-A-B', B: 'A+B+A' },
    angle: 60 * DEG,
    draw: 'AB',
    defaultIter: 6,
    maxIter: 9,
    note: 'The Sierpinski arrowhead — one stroke that traces the Sierpinski gasket.',
  },
  {
    id: 'sierpinski',
    label: 'Sierpinski',
    axiom: 'F-G-G',
    rules: { F: 'F-G+F+G-F', G: 'GG' },
    angle: 120 * DEG,
    draw: 'FG',
    defaultIter: 5,
    maxIter: 7,
    note: 'The Sierpinski triangle drawn along its edges.',
  },
  {
    id: 'pentigree',
    label: 'Pentigree',
    axiom: 'F',
    rules: { F: '+F++F----F--F++F++F-' },
    angle: 36 * DEG,
    draw: 'F',
    defaultIter: 3,
    maxIter: 4,
    note: "McWorter's pentigree — a five-fold self-similar tile.",
  },
  // --- branching systems (plants / trees) ---------------------------------
  // These use `[` / `]` to push / pop the turtle's position+heading, so the pen
  // lifts and jumps back to a saved branch point — the turtle traces *many*
  // sub-paths (a tree), which the renderer draws as separate strokes via the
  // pen-up `breaks` flags. They start pointing up so plants grow skyward.
  {
    id: 'plant',
    label: 'Plant',
    axiom: 'X',
    rules: { X: 'F+[[X]-X]-F[-FX]+X', F: 'FF' },
    angle: 25 * DEG,
    draw: 'F',
    defaultIter: 5,
    maxIter: 6,
    start: -90 * DEG,
    branching: true,
    note: "Lindenmayer's fractal plant — a branching weed. Sweep the angle in Live to make it sway.",
  },
  {
    id: 'bush',
    label: 'Bush',
    axiom: 'F',
    rules: { F: 'FF+[+F-F-F]-[-F+F+F]' },
    angle: 22.5 * DEG,
    draw: 'F',
    defaultIter: 4,
    maxIter: 5,
    start: -90 * DEG,
    branching: true,
    note: 'A dense, bushy branching plant.',
  },
  {
    id: 'tree',
    label: 'Tree',
    axiom: 'F',
    rules: { F: 'F[+F]F[-F]F' },
    angle: 25.7 * DEG,
    draw: 'F',
    defaultIter: 4,
    maxIter: 5,
    start: -90 * DEG,
    branching: true,
    note: 'A symmetric branching tree.',
  },
  {
    id: 'twig',
    label: 'Twig',
    axiom: 'X',
    rules: { X: 'F[+X]F[-X]+X', F: 'FF' },
    angle: 20 * DEG,
    draw: 'F',
    defaultIter: 5,
    maxIter: 6,
    start: -90 * DEG,
    branching: true,
    note: 'A wispy, asymmetric fractal twig.',
  },
  {
    id: 'seaweed',
    label: 'Seaweed',
    axiom: 'F',
    rules: { F: 'F[+F]F[-F][F]' },
    angle: 25 * DEG,
    draw: 'F',
    defaultIter: 4,
    maxIter: 5,
    start: -90 * DEG,
    branching: true,
    note: 'Drifting branching seaweed.',
  },
]

const byId = new Map(LSYSTEMS.map((s) => [s.id, s]))

export function lsystemById(id: string): LSystemDef | undefined {
  return byId.get(id)
}

export const LSYSTEM_KINDS = LSYSTEMS.map((s) => ({ value: s.id, label: s.label }))

export function clampIter(def: LSystemDef, iter: number): number {
  return Math.max(0, Math.min(def.maxIter, Math.round(iter)))
}

// The expanded string depends only on (system, iterations) — never the angle —
// so memoising it makes Live's per-frame angle sweep nearly free (only the
// turtle re-runs). A small LRU-ish cap keeps memory bounded.
const expandCache = new Map<string, string>()
const HARD_LEN_CAP = 4_000_000 // safety net; maxIter already keeps us far below

export function expandLSystem(def: LSystemDef, iterations: number): string {
  const iter = clampIter(def, iterations)
  const key = `${def.id}:${iter}`
  const cached = expandCache.get(key)
  if (cached !== undefined) return cached

  let s = def.axiom
  for (let i = 0; i < iter; i++) {
    let next = ''
    for (let j = 0; j < s.length; j++) {
      const c = s[j]
      next += def.rules[c] ?? c
    }
    s = next
    if (s.length > HARD_LEN_CAP) break
  }

  if (expandCache.size > 48) expandCache.clear()
  expandCache.set(key, s)
  return s
}

// Walk the expanded string with a turtle, returning the polyline(s) in model
// space (unit step length — the renderer auto-fits, so absolute scale is
// irrelevant). `[` pushes the current position+heading, `]` pops it: popping
// emits a pen-up jump (a `breaks: true` point) so the next stroke restarts at
// the saved branch point instead of drawing a line back to it. Single-stroke
// systems never use the stack, so they come back with `breaks` all false.
export function turtleFull(
  str: string,
  angle: number,
  draw: string,
  start = 0,
): { points: Point[]; breaks: boolean[] } {
  const drawSet = new Set(draw)
  const points: Point[] = [{ x: 0, y: 0 }]
  const breaks: boolean[] = [false]
  let x = 0
  let y = 0
  let dir = start
  const stack: { x: number; y: number; dir: number }[] = []
  for (let i = 0; i < str.length; i++) {
    const c = str[i]
    if (drawSet.has(c)) {
      x += Math.cos(dir)
      y += Math.sin(dir)
      points.push({ x, y })
      breaks.push(false)
    } else if (c === '+') {
      dir += angle
    } else if (c === '-') {
      dir -= angle
    } else if (c === '|') {
      dir += Math.PI
    } else if (c === '[') {
      stack.push({ x, y, dir })
    } else if (c === ']') {
      const s = stack.pop()
      if (s) {
        x = s.x
        y = s.y
        dir = s.dir
        // Anchor the next stroke at the restored branch point (pen-up jump).
        points.push({ x, y })
        breaks.push(true)
      }
    }
  }
  return { points, breaks }
}

// Single-stroke convenience wrapper (used by the self-tests). Returns just the
// polyline; for branching systems the branch jumps are included as points but
// the pen-up structure is dropped.
export function turtle(str: string, angle: number, draw: string, start = 0): Point[] {
  return turtleFull(str, angle, draw, start).points
}

export function sampleLSystem(p: LSystemParams): Point[] {
  const def = lsystemById(p.system) ?? LSYSTEMS[0]
  const str = expandLSystem(def, p.iterations)
  return turtle(str, p.angle, def.draw, def.start ?? 0)
}

// Full sampler with pen-up breaks — what the renderer actually consumes.
export function sampleLSystemFull(p: LSystemParams): SampledCurve {
  const def = lsystemById(p.system) ?? LSYSTEMS[0]
  const str = expandLSystem(def, p.iterations)
  const r = turtleFull(str, p.angle, def.draw, def.start ?? 0)
  return { points: r.points, breaks: r.breaks }
}

export function defaultLSystem(): LSystemParams {
  const def = LSYSTEMS[0] // dragon
  return { system: def.id, iterations: def.defaultIter, angle: def.angle }
}

export function randomLSystem(): LSystemParams {
  const def = LSYSTEMS[Math.floor(Math.random() * LSYSTEMS.length)]
  // Bias toward the richer (deeper) end of each system's range, then jitter the
  // fold angle a few degrees off the canonical value for organic variety.
  const lo = Math.max(2, def.maxIter - 2)
  const iterations = lo + Math.floor(Math.random() * (def.maxIter - lo + 1))
  const jitter = (Math.random() - 0.5) * 16 * DEG
  return { system: def.id, iterations, angle: def.angle + jitter }
}
