// A library of real structural cross-sections. Until now a member carried a raw
// area A and second moment I, and bending stress was recovered with a
// *rectangular* fibre-distance guess c = √(3I/A). Real sections break that
// assumption — a wide-flange puts most of its material far from the neutral
// axis, so its true c (half the depth) is much larger than a solid rectangle of
// the same A and I would have. This module supplies the genuine A, I and c (plus
// the plastic modulus Z) for a curated set of AISC shapes and for parametric
// solid/hollow sections, so `Mc/I` uses the *actual* extreme-fibre distance.
//
// AISC values are stored in their native US units (in², in⁴, in) exactly as they
// appear in the Steel Construction Manual, then converted to SI here — so the
// numbers are auditable against the handbook rather than hand-transcribed metres.

/** Cross-section properties, all SI (metres). */
export interface Section {
  id: string
  label: string
  family: 'W' | 'HSS' | 'PIPE' | 'RECT' | 'ROUND'
  A: number // area, m²
  I: number // strong-axis second moment of area, m⁴
  c: number // extreme-fibre distance = depth/2, m
  Z: number // plastic section modulus, m³ (for reference / plastic checks)
  depth: number // overall depth, m
  blurb: string
}

// Unit conversions (exact).
const IN2 = 6.4516e-4 // in² → m²
const IN4 = 4.162314256e-7 // in⁴ → m⁴
const IN = 0.0254 // in → m
const IN3 = 1.6387064e-5 // in³ → m³

interface RawW {
  label: string
  A: number // in²
  I: number // in⁴  (Ix, strong axis)
  d: number // in   (overall depth)
  Z: number // in³  (Zx, plastic)
  fam: Section['family']
  blurb: string
}

// Representative AISC shapes spanning a useful range of sizes. Values are the
// published Ix, A, depth and Zx (strong axis) from the Steel Construction Manual.
const RAW: RawW[] = [
  { label: 'W8×10', A: 2.96, I: 30.8, d: 7.89, Z: 8.87, fam: 'W', blurb: 'light beam / brace' },
  { label: 'W10×22', A: 6.49, I: 118, d: 10.2, Z: 26.0, fam: 'W', blurb: 'floor beam' },
  { label: 'W12×26', A: 7.65, I: 204, d: 12.2, Z: 37.2, fam: 'W', blurb: 'common floor beam' },
  { label: 'W14×48', A: 14.1, I: 484, d: 13.8, Z: 78.4, fam: 'W', blurb: 'column / girder' },
  { label: 'W16×40', A: 11.8, I: 518, d: 16.0, Z: 73.0, fam: 'W', blurb: 'long-span beam' },
  { label: 'W18×50', A: 14.7, I: 800, d: 18.0, Z: 101, fam: 'W', blurb: 'girder' },
  { label: 'W21×62', A: 18.3, I: 1330, d: 21.0, Z: 144, fam: 'W', blurb: 'heavy girder' },
  { label: 'W24×76', A: 22.4, I: 2100, d: 23.9, Z: 200, fam: 'W', blurb: 'deep girder' },
  { label: 'HSS6×6×¼', A: 5.24, I: 27.4, d: 6.0, Z: 10.6, fam: 'HSS', blurb: 'square tube' },
  { label: 'HSS8×8×½', A: 13.5, I: 106, d: 8.0, Z: 32.7, fam: 'HSS', blurb: 'heavy square tube' },
  { label: 'Pipe 6 Std', A: 5.2, I: 28.1, d: 6.625, Z: 11.3, fam: 'PIPE', blurb: 'round pipe' },
]

function fromRaw(r: RawW): Section {
  return {
    id: r.label,
    label: r.label,
    family: r.fam,
    A: r.A * IN2,
    I: r.I * IN4,
    c: (r.d * IN) / 2,
    Z: r.Z * IN3,
    depth: r.d * IN,
    blurb: r.blurb,
  }
}

/** The curated catalogue of standard shapes (SI). */
export const SECTIONS: Section[] = RAW.map(fromRaw)

export function findSection(id: string | undefined): Section | undefined {
  if (!id) return undefined
  return SECTIONS.find((s) => s.id === id)
}

// ----------------------------------------------------- parametric builders

/** Solid rectangle b (width) × h (depth), strong axis about the b-face. */
export function rectSection(b: number, h: number): Section {
  const A = b * h
  const I = (b * h * h * h) / 12
  const Z = (b * h * h) / 4
  return {
    id: `RECT ${round(b)}×${round(h)}`,
    label: `Rect ${mm(b)}×${mm(h)} mm`,
    family: 'RECT',
    A,
    I,
    c: h / 2,
    Z,
    depth: h,
    blurb: 'solid rectangle',
  }
}

/** Solid round bar of diameter d. */
export function roundSection(d: number): Section {
  const r = d / 2
  const A = Math.PI * r * r
  const I = (Math.PI * r ** 4) / 4
  const Z = (d ** 3) / 6 // plastic modulus of a solid circle
  return {
    id: `ROUND ${round(d)}`,
    label: `Round ⌀${mm(d)} mm`,
    family: 'ROUND',
    A,
    I,
    c: r,
    Z,
    depth: d,
    blurb: 'solid round bar',
  }
}

/** Circular hollow section (pipe): outer diameter od, wall thickness t. */
export function pipeSection(od: number, t: number): Section {
  const ro = od / 2
  const ri = Math.max(0, ro - t)
  const A = Math.PI * (ro * ro - ri * ri)
  const I = (Math.PI * (ro ** 4 - ri ** 4)) / 4
  const Z = ((od ** 3 - (2 * ri) ** 3) / 6) // solid-minus-hole plastic modulus
  return {
    id: `PIPE ${round(od)}×${round(t)}`,
    label: `Pipe ⌀${mm(od)}×${mm(t)} mm`,
    family: 'PIPE',
    A,
    I,
    c: ro,
    Z,
    depth: od,
    blurb: 'circular hollow',
  }
}

function round(m: number): number {
  return Math.round(m * 1000) // for id stability (mm, integer-ish)
}
function mm(m: number): string {
  return (m * 1000).toFixed(0)
}

/**
 * Extreme-fibre distance actually used for bending stress. If the member was
 * assigned a section its published c is used; otherwise we fall back to the
 * historical rectangular assumption c = √(3I/A) (I = bh³/12, A = bh ⇒ c = h/2).
 */
export function fibreDistance(A: number, I: number, c?: number): number {
  if (c && c > 0) return c
  return Math.sqrt((3 * I) / A)
}
