// Truth-table generation for purely combinational circuits.
import type { Comp } from './geometry'
import { Engine } from './engine'
import type { Snapshot } from './engine'
import { isCombinational } from './factory'

export interface TruthTable {
  inputs: { id: string; name: string }[]
  outputs: { id: string; name: string }[]
  rows: { in: boolean[]; out: boolean[] }[]
  truncated: boolean
  reason?: string
}

const MAX_INPUTS = 8

function labelOf(c: Comp, fallback: string): string {
  const l = (c.label ?? '').trim()
  return l.length ? l : fallback
}

function ordered(comps: Comp[]): Comp[] {
  return comps.slice().sort((a, b) => a.y - b.y || a.x - b.x)
}

export function buildTruthTable(snap: Snapshot): TruthTable | null {
  if (!isCombinational(snap)) {
    return { inputs: [], outputs: [], rows: [], truncated: false, reason: 'sequential' }
  }
  const inputComps = ordered(snap.comps.filter((c) => c.kind === 'INPUT'))
  const outputComps = ordered(snap.comps.filter((c) => c.kind === 'OUTPUT'))
  if (inputComps.length === 0 || outputComps.length === 0) return null

  const truncated = inputComps.length > MAX_INPUTS
  const used = inputComps.slice(0, MAX_INPUTS)

  const eng = new Engine()
  const combos = 1 << used.length
  const rows: { in: boolean[]; out: boolean[] }[] = []

  for (let mask = 0; mask < combos; mask++) {
    // fresh engine per row keeps state independent
    eng.load(snapWithInputs(snap, used, mask))
    const outVals = outputComps.map((oc) => {
      const live = eng.comps.get(oc.id)
      return live ? eng.inputValue(live, 0) : false
    })
    const inVals = used.map((_, i) => !!(mask & (1 << i)))
    rows.push({ in: inVals, out: outVals })
  }

  return {
    inputs: used.map((c, i) => ({ id: c.id, name: labelOf(c, `I${i}`) })),
    outputs: outputComps.map((c, i) => ({ id: c.id, name: labelOf(c, `O${i}`) })),
    rows,
    truncated,
  }
}

function snapWithInputs(snap: Snapshot, inputs: Comp[], mask: number): Snapshot {
  const idx = new Map(inputs.map((c, i) => [c.id, i]))
  return {
    wires: snap.wires,
    comps: snap.comps.map((c) => {
      const i = idx.get(c.id)
      if (i === undefined) return c
      return { ...c, outs: [!!(mask & (1 << i))] }
    }),
  }
}
