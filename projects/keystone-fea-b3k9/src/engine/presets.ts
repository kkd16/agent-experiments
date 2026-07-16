// A library of ready-made models — classic trusses, frames, and continuum parts
// — so the studio opens onto something worth looking at and users have known
// structures to explore. Frame presets are concrete FrameModels; continuum
// presets are parameterised by a mesh-density knob.

import type { FrameModel } from './frame'
import type { ContinuumInput } from './continuum'
import { cantileverMesh, lBracket, plateWithHole, rectPlate, nodeNearest } from './mesh'

const STEEL = 210e9
const A_TRUSS = 4e-3 // 40 cm²
const A_FRAME = 1e-2 // 100 cm²
const I_FRAME = 2e-4 // m⁴

export interface FramePreset {
  kind: 'frame'
  id: string
  name: string
  blurb: string
  model: FrameModel
}
export interface ContinuumPreset {
  kind: 'continuum'
  id: string
  name: string
  blurb: string
  make: (density: number) => ContinuumInput
}
export type Preset = FramePreset | ContinuumPreset

// ---------------------------------------------------------------- truss makers

function warren(panels: number, d: number, h: number, load: number): FrameModel {
  const nodes: FrameModel['nodes'] = []
  for (let i = 0; i <= panels; i++) nodes.push({ x: i * d, y: 0, support: 'free' })
  const topBase = nodes.length
  for (let i = 0; i < panels; i++) nodes.push({ x: (i + 0.5) * d, y: h, support: 'free' })
  nodes[0].support = 'pin'
  nodes[panels].support = 'roller-x'
  const members: FrameModel['members'] = []
  const bar = (a: number, b: number) => members.push({ a, b, E: STEEL, A: A_TRUSS, I: 1 })
  for (let i = 0; i < panels; i++) bar(i, i + 1) // bottom chord
  for (let i = 0; i < panels - 1; i++) bar(topBase + i, topBase + i + 1) // top chord
  for (let i = 0; i < panels; i++) {
    bar(i, topBase + i) // up diagonal
    bar(topBase + i, i + 1) // down diagonal
  }
  const loads: FrameModel['loads'] = []
  for (let i = 1; i < panels; i++) loads.push({ node: i, fx: 0, fy: -load, mz: 0 })
  return { type: 'truss', nodes, members, loads }
}

function parallelChord(panels: number, d: number, h: number, load: number): FrameModel {
  const nodes: FrameModel['nodes'] = []
  for (let i = 0; i <= panels; i++) nodes.push({ x: i * d, y: 0, support: 'free' })
  const top = nodes.length
  for (let i = 0; i <= panels; i++) nodes.push({ x: i * d, y: h, support: 'free' })
  nodes[0].support = 'pin'
  nodes[panels].support = 'roller-x'
  const members: FrameModel['members'] = []
  const bar = (a: number, b: number) => members.push({ a, b, E: STEEL, A: A_TRUSS, I: 1 })
  for (let i = 0; i < panels; i++) bar(i, i + 1) // bottom chord
  for (let i = 0; i < panels; i++) bar(top + i, top + i + 1) // top chord
  for (let i = 0; i <= panels; i++) bar(i, top + i) // verticals
  for (let i = 0; i < panels; i++) bar(i, top + i + 1) // diagonals (Pratt-style)
  const loads: FrameModel['loads'] = []
  for (let i = 1; i < panels; i++) loads.push({ node: i, fx: 0, fy: -load, mz: 0 })
  return { type: 'truss', nodes, members, loads }
}

function roofTruss(span: number, rise: number, load: number): FrameModel {
  // Fink-style roof truss: bottom tie, two rafters, king post, two struts.
  const nodes: FrameModel['nodes'] = [
    { x: 0, y: 0, support: 'pin' }, // 0 left support
    { x: span, y: 0, support: 'roller-x' }, // 1 right support
    { x: span / 2, y: 0, support: 'free' }, // 2 bottom mid
    { x: span / 2, y: rise, support: 'free' }, // 3 apex
    { x: span / 4, y: rise / 2, support: 'free' }, // 4 left rafter mid
    { x: (3 * span) / 4, y: rise / 2, support: 'free' }, // 5 right rafter mid
  ]
  const members: FrameModel['members'] = []
  const bar = (a: number, b: number) => members.push({ a, b, E: STEEL, A: A_TRUSS, I: 1 })
  bar(0, 2) // bottom tie (left)
  bar(2, 1) // bottom tie (right)
  bar(0, 4) // left rafter lower
  bar(4, 3) // left rafter upper
  bar(3, 5) // right rafter upper
  bar(5, 1) // right rafter lower
  bar(3, 2) // king post
  bar(4, 2) // left strut
  bar(5, 2) // right strut
  const loads: FrameModel['loads'] = [
    { node: 3, fx: 0, fy: -load, mz: 0 },
    { node: 4, fx: 0, fy: -load / 2, mz: 0 },
    { node: 5, fx: 0, fy: -load / 2, mz: 0 },
  ]
  return { type: 'truss', nodes, members, loads }
}

function tower(levels: number, base: number, top: number, h: number, wind: number): FrameModel {
  const nodes: FrameModel['nodes'] = []
  const hl = h / levels
  for (let l = 0; l <= levels; l++) {
    const t = l / levels
    const half = (base + (top - base) * t) / 2
    const y = l * hl
    nodes.push({ x: -half, y, support: l === 0 ? 'pin' : 'free' })
    nodes.push({ x: half, y, support: l === 0 ? 'pin' : 'free' })
  }
  const members: FrameModel['members'] = []
  const bar = (a: number, b: number) => members.push({ a, b, E: STEEL, A: A_TRUSS, I: 1 })
  for (let l = 0; l < levels; l++) {
    const lL = l * 2
    const lR = l * 2 + 1
    const uL = l * 2 + 2
    const uR = l * 2 + 3
    bar(lL, uL) // left leg
    bar(lR, uR) // right leg
    bar(uL, uR) // horizontal brace
    bar(lL, uR) // cross brace
    bar(lR, uL) // cross brace
  }
  const loads: FrameModel['loads'] = [
    { node: levels * 2, fx: wind, fy: 0, mz: 0 },
    { node: levels * 2 + 1, fx: wind, fy: 0, mz: 0 },
  ]
  return { type: 'truss', nodes, members, loads }
}

// ---------------------------------------------------------------- frame makers

function cantileverFrame(L: number, load: number): FrameModel {
  const n = 6
  const nodes: FrameModel['nodes'] = []
  for (let i = 0; i <= n; i++) nodes.push({ x: (i / n) * L, y: 0, support: i === 0 ? 'fixed' : 'free' })
  const members: FrameModel['members'] = []
  for (let i = 0; i < n; i++) members.push({ a: i, b: i + 1, E: STEEL, A: A_FRAME, I: I_FRAME })
  return { type: 'frame', nodes, members, loads: [{ node: n, fx: 0, fy: -load, mz: 0 }] }
}

function slenderColumn(height: number, load: number): FrameModel {
  // A pin-based vertical column, laterally guided at the top (roller-y), under
  // an axial compressive tip load — the textbook Euler buckling case.
  const n = 10
  const nodes: FrameModel['nodes'] = []
  for (let i = 0; i <= n; i++)
    nodes.push({ x: 0, y: (i / n) * height, support: i === 0 ? 'pin' : 'free' })
  nodes[n].support = 'roller-y' // top slides vertically, held horizontally
  const members: FrameModel['members'] = []
  for (let i = 0; i < n; i++) members.push({ a: i, b: i + 1, E: STEEL, A: 3e-3, I: 6e-7 })
  return { type: 'frame', nodes, members, loads: [{ node: n, fx: 0, fy: -load, mz: 0 }] }
}

function resonatorMast(height: number, load: number): FrameModel {
  // A slender vertical cantilever mast, fixed at the base, with a lateral drive
  // load at the tip. Its well-separated bending frequencies make a textbook
  // frequency-response function — switch to Harmonic and sweep the drive
  // frequency to watch it scream through each resonance.
  const n = 8
  const nodes: FrameModel['nodes'] = []
  for (let i = 0; i <= n; i++)
    nodes.push({ x: 0, y: (i / n) * height, support: i === 0 ? 'fixed' : 'free' })
  const members: FrameModel['members'] = []
  // A real slender steel section → low, cleanly separated bending modes.
  for (let i = 0; i < n; i++) members.push({ a: i, b: i + 1, E: STEEL, A: 4e-3, I: 8e-6 })
  return { type: 'frame', nodes, members, loads: [{ node: n, fx: load, fy: 0, mz: 0 }] }
}

function floorBeam(L: number, w: number): FrameModel {
  // A simply-supported floor beam under a uniform distributed load — bending
  // plus a rich set of vertical vibration modes.
  const n = 10
  const nodes: FrameModel['nodes'] = []
  for (let i = 0; i <= n; i++) nodes.push({ x: (i / n) * L, y: 0, support: 'free' })
  nodes[0].support = 'pin'
  nodes[n].support = 'roller-x'
  const members: FrameModel['members'] = []
  for (let i = 0; i < n; i++) members.push({ a: i, b: i + 1, E: STEEL, A: 6e-3, I: 1.2e-4, w })
  return { type: 'frame', nodes, members, loads: [] }
}

function portalFrame(width: number, height: number, load: number): FrameModel {
  const nodes: FrameModel['nodes'] = [
    { x: 0, y: 0, support: 'fixed' }, // 0 base left
    { x: 0, y: height, support: 'free' }, // 1 top left
    { x: width, y: height, support: 'free' }, // 2 top right
    { x: width, y: 0, support: 'fixed' }, // 3 base right
  ]
  const members: FrameModel['members'] = [
    { a: 0, b: 1, E: STEEL, A: A_FRAME, I: I_FRAME }, // left column
    { a: 1, b: 2, E: STEEL, A: A_FRAME, I: I_FRAME }, // beam
    { a: 2, b: 3, E: STEEL, A: A_FRAME, I: I_FRAME }, // right column
  ]
  return { type: 'frame', nodes, members, loads: [{ node: 1, fx: load, fy: 0, mz: 0 }] }
}

// ----------------------------------------------------------- pushover makers
//
// Plastic-collapse showcases: members carry an explicit plastic moment Mₚ so the
// capacity is defined, and are subdivided enough for a hinge to appear in a span.
// Each is a textbook mechanism whose collapse load factor has a closed form.

const A_PLASTIC = 8e-3 // 80 cm²
const I_PLASTIC = 1.2e-4 // m⁴
const MP = 6e5 // N·m plastic moment capacity

function proppedCantileverUDL(L: number, w: number): FrameModel {
  // Fixed at the left, propped (roller) at the right, under a downward UDL. The
  // first hinge forms at the fixed end; load redistributes until a second hinge
  // opens in the span — collapse at w_c = 11.66·Mₚ/L².
  const n = 12
  const nodes: FrameModel['nodes'] = []
  for (let i = 0; i <= n; i++) nodes.push({ x: (i / n) * L, y: 0, support: 'free' })
  nodes[0].support = 'fixed'
  nodes[n].support = 'roller-x'
  const members: FrameModel['members'] = []
  for (let i = 0; i < n; i++)
    members.push({ a: i, b: i + 1, E: STEEL, A: A_PLASTIC, I: I_PLASTIC, w, Mp: MP })
  return { type: 'frame', nodes, members, loads: [] }
}

function fixedFixedBeam(L: number, load: number): FrameModel {
  // Both ends built in, a central point load. Three hinges (both ends + centre)
  // and a 50 % reserve over first yield — collapse at P_c = 8·Mₚ/L.
  const n = 8
  const nodes: FrameModel['nodes'] = []
  for (let i = 0; i <= n; i++) nodes.push({ x: (i / n) * L, y: 0, support: 'free' })
  nodes[0].support = 'fixed'
  nodes[n].support = 'fixed'
  const members: FrameModel['members'] = []
  for (let i = 0; i < n; i++)
    members.push({ a: i, b: i + 1, E: STEEL, A: A_PLASTIC, I: I_PLASTIC, Mp: MP })
  return { type: 'frame', nodes, members, loads: [{ node: n / 2, fx: 0, fy: -load, mz: 0 }] }
}

function swayPortal(width: number, height: number, load: number): FrameModel {
  // Fixed-base portal under a lateral load — the sway mechanism forms four hinges
  // (both column bases and both beam-column joints): H_c = 4·Mₚ/h. Columns are
  // subdivided so the hinges read cleanly on the deflected shape.
  const nc = 3
  const nodes: FrameModel['nodes'] = []
  const idxL: number[] = []
  for (let i = 0; i <= nc; i++) {
    idxL.push(nodes.length)
    nodes.push({ x: 0, y: (i / nc) * height, support: i === 0 ? 'fixed' : 'free' })
  }
  const idxR: number[] = []
  for (let i = 0; i <= nc; i++) {
    idxR.push(nodes.length)
    nodes.push({ x: width, y: (i / nc) * height, support: i === 0 ? 'fixed' : 'free' })
  }
  const members: FrameModel['members'] = []
  const beam = (a: number, b: number) => members.push({ a, b, E: STEEL, A: A_PLASTIC, I: I_PLASTIC, Mp: MP })
  for (let i = 0; i < nc; i++) beam(idxL[i], idxL[i + 1]) // left column
  for (let i = 0; i < nc; i++) beam(idxR[i], idxR[i + 1]) // right column
  beam(idxL[nc], idxR[nc]) // beam
  return {
    type: 'frame',
    nodes,
    members,
    loads: [{ node: idxL[nc], fx: load, fy: 0, mz: 0 }],
  }
}

// ------------------------------------------------------------- seismic makers
//
// Multi-storey moment frames for the Seismic time-history mode. Member density is
// scaled up (rho_eff) to lump realistic tributary floor mass onto the steel, so
// the fundamental period lands in the earthquake-sensitive 0.3–1.2 s band rather
// than the sub-0.1 s of a self-mass-only bare frame — i.e. the response spectrum
// bites where it matters and the sway is dramatic.

function momentFrame(
  stories: number,
  bays: number,
  storyH: number,
  bayW: number,
  rhoEff: number,
  floorLoad: number,
  mp?: { col: number; beam: number },
): FrameModel {
  const Acol = 1.2e-2
  const Icol = 1.0e-4
  const Abeam = 8e-3
  const Ibeam = 1.4e-4
  const cols = bays + 1
  const levels = stories + 1
  const id = (col: number, lvl: number) => lvl * cols + col
  const nodes: FrameModel['nodes'] = []
  for (let lvl = 0; lvl < levels; lvl++)
    for (let col = 0; col < cols; col++)
      nodes.push({ x: col * bayW, y: lvl * storyH, support: lvl === 0 ? 'fixed' : 'free' })
  const members: FrameModel['members'] = []
  // Columns (a defined Mₚ gives the sections a plastic capacity for the
  // inelastic time-history — "strong column, weak beam" capacity design).
  for (let lvl = 0; lvl < stories; lvl++)
    for (let col = 0; col < cols; col++)
      members.push({ a: id(col, lvl), b: id(col, lvl + 1), E: STEEL, A: Acol, I: Icol, rho: rhoEff, ...(mp ? { Mp: mp.col } : {}) })
  // Beams.
  for (let lvl = 1; lvl < levels; lvl++)
    for (let col = 0; col < bays; col++)
      members.push({ a: id(col, lvl), b: id(col + 1, lvl), E: STEEL, A: Abeam, I: Ibeam, rho: rhoEff, ...(mp ? { Mp: mp.beam } : {}) })
  // A modest lateral floor load at the leftmost column of every level, so the
  // Static view already shows the sway shape the earthquake will excite.
  const loads: FrameModel['loads'] = []
  for (let lvl = 1; lvl < levels; lvl++) loads.push({ node: id(0, lvl), fx: floorLoad, fy: 0, mz: 0 })
  return { type: 'frame', nodes, members, loads }
}

// ------------------------------------------------------------- continuum makers

function continuumPlateTension(density: number): ContinuumInput {
  const nx = Math.round(16 * density)
  const mesh = rectPlate(3, 1.5, nx, Math.max(2, Math.round(nx / 2)))
  return {
    mesh,
    E: 70e9,
    nu: 0.33,
    thickness: 0.01,
    fix: [
      { edge: 'left', dofs: ['x'] },
      { nodes: [nodeNearest(mesh, 0, 0)], dofs: ['y'] },
    ],
    traction: { edge: 'right', tx: 50e6, ty: 0 },
  }
}

function continuumCantilever(density: number): ContinuumInput {
  const nx = Math.round(30 * density)
  const mesh = cantileverMesh(5, 1, nx, Math.max(3, Math.round(nx / 5)))
  return {
    mesh,
    E: 200e9,
    nu: 0.3,
    thickness: 0.05,
    fix: [{ edge: 'left', dofs: ['x', 'y'] }],
    traction: { edge: 'right', tx: 0, ty: -2e6 },
  }
}

function continuumPlateHole(density: number): ContinuumInput {
  const nx = Math.round(28 * density)
  const mesh = plateWithHole(4, 4, 0.8, nx, nx)
  return {
    mesh,
    E: 70e9,
    nu: 0.33,
    thickness: 0.01,
    fix: [
      { edge: 'left', dofs: ['x'] },
      { nodes: [nodeNearest(mesh, 0, 0)], dofs: ['y'] },
    ],
    traction: { edge: 'right', tx: 40e6, ty: 0 },
  }
}

function continuumLBracket(density: number): ContinuumInput {
  const nx = Math.round(24 * density)
  const mesh = lBracket(3, 3, nx, nx)
  return {
    mesh,
    E: 200e9,
    nu: 0.3,
    thickness: 0.02,
    fix: [{ edge: 'top', dofs: ['x', 'y'] }],
    traction: { edge: 'right', tx: 0, ty: -8e6 },
  }
}

// ------------------------------------------------------------------- registry

export const PRESETS: Preset[] = [
  {
    kind: 'frame',
    id: 'warren',
    name: 'Warren truss bridge',
    blurb: 'Six-panel triangulated deck, pin + roller supports, deck load at each joint.',
    model: warren(6, 3, 3, 60e3),
  },
  {
    kind: 'frame',
    id: 'pratt',
    name: 'Pratt truss bridge',
    blurb: 'Parallel-chord truss with verticals and tension diagonals under gravity load.',
    model: parallelChord(6, 3, 3.2, 60e3),
  },
  {
    kind: 'frame',
    id: 'roof',
    name: 'Fink roof truss',
    blurb: 'Pitched roof truss — tie, rafters, king post and struts carrying roof load.',
    model: roofTruss(12, 4, 40e3),
  },
  {
    kind: 'frame',
    id: 'tower',
    name: 'Lattice tower',
    blurb: 'Tapered cross-braced tower fixed at the base under a lateral wind load.',
    model: tower(6, 6, 2.5, 15, 25e3),
  },
  {
    kind: 'frame',
    id: 'cantilever',
    name: 'Cantilever beam',
    blurb: 'Fixed-end beam under a tip load — bending, shear and moment (frame elements).',
    model: cantileverFrame(6, 40e3),
  },
  {
    kind: 'frame',
    id: 'portal',
    name: 'Portal frame',
    blurb: 'Rigid-jointed portal with fixed bases resisting a lateral load by frame action.',
    model: portalFrame(6, 4, 50e3),
  },
  {
    kind: 'frame',
    id: 'column',
    name: 'Slender column',
    blurb: 'Pin-based column under axial load — switch to Buckling to find the Euler load & mode.',
    model: slenderColumn(5, 80e3),
  },
  {
    kind: 'frame',
    id: 'floor-beam',
    name: 'Loaded floor beam',
    blurb: 'Simply-supported beam with a uniform load — try Modal to see its vibration modes.',
    model: floorBeam(6, -12e3),
  },
  {
    kind: 'frame',
    id: 'resonator',
    name: 'Resonator mast',
    blurb: 'Slender fixed-base mast with a lateral drive — switch to Harmonic and sweep through its resonances.',
    model: resonatorMast(6, 2e3),
  },
  {
    kind: 'frame',
    id: 'propped-plastic',
    name: 'Propped cantilever (plastic)',
    blurb: 'Fixed–roller beam under a UDL — switch to Pushover to watch hinges form and collapse at 11.66Mₚ/L².',
    model: proppedCantileverUDL(8, -22e3),
  },
  {
    kind: 'frame',
    id: 'fixed-plastic',
    name: 'Fixed-fixed beam (plastic)',
    blurb: 'Built-in beam, central load — Pushover shows 3 hinges and a 50 % reserve beyond first yield (8Mₚ/L).',
    model: fixedFixedBeam(6, 220e3),
  },
  {
    kind: 'frame',
    id: 'sway-portal',
    name: 'Sway portal (plastic)',
    blurb: 'Fixed-base portal under lateral load — Pushover traces the sway mechanism collapse at 4Mₚ/h.',
    model: swayPortal(6, 4, 110e3),
  },
  {
    kind: 'frame',
    id: 'moment-frame',
    name: 'Moment frame (5-storey)',
    blurb: 'A 5-storey, 2-bay steel moment frame — Seismic reads its response spectrum; Inelastic yields its hinges and traces the hysteresis loops.',
    model: momentFrame(5, 2, 3.5, 5, 62000, 8e3),
  },
  {
    kind: 'frame',
    id: 'tall-building',
    name: 'Tall building (10-storey)',
    blurb: 'A slender 10-storey tower with a long fundamental period — near-fault pulses hit it hardest. Best seen in Seismic / Inelastic.',
    model: momentFrame(10, 2, 3.4, 5.5, 80000, 6e3),
  },
  {
    kind: 'frame',
    id: 'ductile-frame',
    name: 'Ductile frame (inelastic)',
    blurb: 'A 4-storey moment frame with capacity-designed plastic hinges (weak beam, strong column) — switch to Inelastic and shake it past yield to open the hysteresis loops.',
    model: momentFrame(4, 2, 3.5, 5, 70000, 9e3, { col: 9e5, beam: 5e5 }),
  },
  {
    kind: 'continuum',
    id: 'c-tension',
    name: 'Plate in tension',
    blurb: 'Uniform edge traction — a clean uniaxial stress field (the FEM patch test).',
    make: continuumPlateTension,
  },
  {
    kind: 'continuum',
    id: 'c-cantilever',
    name: 'Cantilever plate',
    blurb: 'Deep cantilever under tip shear — bending stress varies through the depth.',
    make: continuumCantilever,
  },
  {
    kind: 'continuum',
    id: 'c-hole',
    name: 'Plate with a hole',
    blurb: 'Classic stress concentration — tension around a central circular hole (Kt ≈ 3).',
    make: continuumPlateHole,
  },
  {
    kind: 'continuum',
    id: 'c-lbracket',
    name: 'L-bracket',
    blurb: 'Re-entrant corner under tip shear — stress peaks sharply at the inside corner.',
    make: continuumLBracket,
  },
]
