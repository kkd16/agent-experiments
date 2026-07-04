// Green's relations — the structure theory of finite monoids, and the "egg-box" picture.
//
// For elements a, b of a monoid M (with identity, so M¹ = M):
//   a R b   ⟺  aM = bM        (same principal right ideal)
//   a L b   ⟺  Ma = Mb        (same principal left ideal)
//   a J b   ⟺  MaM = MbM      (same principal two-sided ideal)
//   a H b   ⟺  a R b and a L b
//   a D b   ⟺  ∃c: a R c and c L b     (= a J b for finite monoids)
//
// A D-class is drawn as an "egg-box": its R-classes are the rows, its L-classes the columns, and
// each cell is one H-class (Green's lemma guarantees every row meets every column in exactly one
// non-empty H-class). An H-class is a group iff it contains an idempotent, and all group H-classes
// of a D-class are isomorphic. This is the picture the view renders.

import type { Monoid } from './monoid'

export interface GreenClasses {
  /** Class index each element belongs to, indexed by element id. */
  r: number[]
  l: number[]
  j: number[]
  h: number[]
  /** Members of each class (element ids), ordered by first appearance. */
  rClasses: number[][]
  lClasses: number[][]
  jClasses: number[][]
  hClasses: number[][]
}

/** Group a keyed list of element ids into equivalence classes; returns (labels, classes). */
function classify(order: number, keyOf: (a: number) => string): { label: number[]; classes: number[][] } {
  const label = new Array<number>(order)
  const classes: number[][] = []
  const seen = new Map<string, number>()
  for (let a = 0; a < order; a++) {
    const k = keyOf(a)
    let c = seen.get(k)
    if (c === undefined) {
      c = classes.length
      seen.set(k, c)
      classes.push([])
    }
    label[a] = c
    classes[c].push(a)
  }
  return { label, classes }
}

const idealKey = (ids: Set<number>): string => [...ids].sort((x, y) => x - y).join(',')

export function greenRelations(mon: Monoid): GreenClasses {
  const m = mon.order
  const mult = mon.mult

  // Principal ideals of every element.
  const rightKey = new Array<string>(m)
  const leftKey = new Array<string>(m)
  const jKey = new Array<string>(m)
  for (let a = 0; a < m; a++) {
    const right = new Set<number>()
    const left = new Set<number>()
    for (let x = 0; x < m; x++) {
      right.add(mult[a][x]) // a·x  ∈ aM
      left.add(mult[x][a]) //  x·a ∈ Ma
    }
    rightKey[a] = idealKey(right)
    leftKey[a] = idealKey(left)
    // Two-sided ideal MaM = { x·a·y }.
    const two = new Set<number>()
    for (let x = 0; x < m; x++) {
      const xa = mult[x][a]
      for (let y = 0; y < m; y++) two.add(mult[xa][y])
    }
    jKey[a] = idealKey(two)
  }

  const R = classify(m, (a) => rightKey[a])
  const L = classify(m, (a) => leftKey[a])
  const J = classify(m, (a) => jKey[a])
  const H = classify(m, (a) => `${R.label[a]}|${L.label[a]}`)

  return {
    r: R.label,
    l: L.label,
    j: J.label,
    h: H.label,
    rClasses: R.classes,
    lClasses: L.classes,
    jClasses: J.classes,
    hClasses: H.classes,
  }
}

export interface EggCell {
  /** Element ids of this H-class. */
  hClass: number[]
  /** Contains an idempotent (⟺ the H-class is a group). */
  group: boolean
  /** |H| — the order of the group when `group` is true. */
  order: number
  /** Global H-class index. */
  hIndex: number
}

export interface EggBox {
  jIndex: number
  /** Global R-class ids forming the rows, top-to-bottom. */
  rows: number[]
  /** Global L-class ids forming the columns, left-to-right. */
  cols: number[]
  /** `cells[row][col]` — the H-class at that (R,L) intersection, or null if empty. */
  cells: (EggCell | null)[][]
  /** Element ids in this D(=J)-class. */
  members: number[]
  /** The J-class is *regular* (contains an idempotent) — then every column/row has a group. */
  regular: boolean
}

/** Build the egg-box diagrams, one per J-class, ordered with the identity's class first. */
export function eggBoxes(mon: Monoid, g: GreenClasses): EggBox[] {
  const idem = new Set(mon.elements.filter((e) => e.idempotent).map((e) => e.id))
  const hIndexOfSet = new Map<string, number>() // "r|l" -> global hIndex, reuse g.h labels
  mon.elements.forEach((e) => hIndexOfSet.set(`${g.r[e.id]}|${g.l[e.id]}`, g.h[e.id]))

  const boxes: EggBox[] = g.jClasses.map((members, jIndex) => {
    const rowSet: number[] = []
    const colSet: number[] = []
    for (const a of members) {
      if (!rowSet.includes(g.r[a])) rowSet.push(g.r[a])
      if (!colSet.includes(g.l[a])) colSet.push(g.l[a])
    }
    const cells: (EggCell | null)[][] = rowSet.map(() => colSet.map(() => null))
    // Bucket members by (R-row, L-col).
    const bucket = new Map<string, number[]>()
    for (const a of members) {
      const key = `${g.r[a]}|${g.l[a]}`
      const arr = bucket.get(key)
      if (arr) arr.push(a)
      else bucket.set(key, [a])
    }
    for (let ri = 0; ri < rowSet.length; ri++) {
      for (let ci = 0; ci < colSet.length; ci++) {
        const hc = bucket.get(`${rowSet[ri]}|${colSet[ci]}`)
        if (!hc) continue
        cells[ri][ci] = {
          hClass: hc,
          group: hc.some((x) => idem.has(x)),
          order: hc.length,
          hIndex: g.h[hc[0]],
        }
      }
    }
    return {
      jIndex,
      rows: rowSet,
      cols: colSet,
      cells,
      members,
      regular: members.some((x) => idem.has(x)),
    }
  })

  // Put the identity's J-class first (it is the maximal ⋝-class), then the rest by size desc.
  const idJ = g.j[mon.identity]
  return boxes.sort((a, b) => {
    if (a.jIndex === idJ) return -1
    if (b.jIndex === idJ) return 1
    return b.members.length - a.members.length
  })
}
