// Helpers for constructing components + serialising circuits.
import type { Comp, Wire } from './geometry'
import type { Kind } from './kinds'
import { kindMeta } from './kinds'
import { defaultOuts, uid } from './engine'
import type { Snapshot } from './engine'

export function makeComp(kind: Kind, x: number, y: number, label?: string): Comp {
  return {
    id: uid('c'),
    kind,
    x,
    y,
    label: label ?? (kind === 'CLOCK' ? '1' : undefined),
    outs: defaultOuts(kind),
    prevClk: false,
    clkAccum: 0,
  }
}

/**
 * Clone a set of components (and every wire whose endpoints are both inside the
 * set) with fresh ids, offset by (dx, dy). Used by duplicate + paste so the copy
 * keeps its internal wiring but shares nothing with the original.
 */
export function cloneComps(
  comps: Comp[],
  wires: Wire[],
  ids: Set<string>,
  dx: number,
  dy: number,
): { comps: Comp[]; wires: Wire[] } {
  const idMap = new Map<string, string>()
  const cloned: Comp[] = []
  for (const c of comps) {
    if (!ids.has(c.id)) continue
    const nid = uid('c')
    idMap.set(c.id, nid)
    cloned.push({ ...c, id: nid, x: c.x + dx, y: c.y + dy, outs: c.outs.slice() })
  }
  const clonedWires: Wire[] = []
  for (const w of wires) {
    const nf = idMap.get(w.from.comp)
    const nt = idMap.get(w.to.comp)
    if (nf && nt) clonedWires.push({ id: uid('w'), from: { comp: nf, pin: w.from.pin }, to: { comp: nt, pin: w.to.pin } })
  }
  return { comps: cloned, wires: clonedWires }
}

// ---- Serialisation (localStorage / export) -----------------------------------

interface SavedComp {
  id: string
  kind: Kind
  x: number
  y: number
  label?: string
  value?: boolean // INPUT switch position
}
interface SavedWire {
  from: [string, number]
  to: [string, number]
}
export interface SavedCircuit {
  v: 1
  comps: SavedComp[]
  wires: SavedWire[]
}

export function serialize(snap: Snapshot): SavedCircuit {
  return {
    v: 1,
    comps: snap.comps.map((c) => ({
      id: c.id,
      kind: c.kind,
      x: c.x,
      y: c.y,
      label: c.label,
      value: c.kind === 'INPUT' ? c.outs[0] : undefined,
    })),
    wires: snap.wires.map((w) => ({ from: [w.from.comp, w.from.pin], to: [w.to.comp, w.to.pin] })),
  }
}

export function deserialize(data: SavedCircuit): Snapshot {
  const comps: Comp[] = data.comps.map((c) => {
    const outs = defaultOuts(c.kind)
    if (c.kind === 'INPUT') outs[0] = !!c.value
    return { id: c.id, kind: c.kind, x: c.x, y: c.y, label: c.label, outs, prevClk: false, clkAccum: 0 }
  })
  const known = new Set(comps.map((c) => c.id))
  const wires: Wire[] = data.wires
    .filter((w) => known.has(w.from[0]) && known.has(w.to[0]))
    .map((w) => ({ id: uid('w'), from: { comp: w.from[0], pin: w.from[1] }, to: { comp: w.to[0], pin: w.to[1] } }))
  return { comps, wires }
}

export function isCombinational(snap: Snapshot): boolean {
  return snap.comps.every((c) => {
    const stateful = kindMeta(c.kind).stateful
    return !stateful || c.kind === 'INPUT' || c.kind === 'CONST0' || c.kind === 'CONST1'
  })
}
