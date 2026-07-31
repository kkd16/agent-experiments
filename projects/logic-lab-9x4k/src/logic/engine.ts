// Event-ish simulation engine. Combinational logic is solved to a fixed point,
// then sequential elements (DFF, SR latch) advance, then we re-settle. This loop
// lets ripple counters and chained latches propagate correctly within one step.

import type { Comp, Wire, PinRef } from './geometry'
import type { Kind } from './kinds'
import { evaluate, kindMeta } from './kinds'

const SETTLE_ITERS = 200
const SEQ_ITERS = 64

let counter = 0
export function uid(prefix: string): string {
  counter += 1
  return `${prefix}${counter.toString(36)}${(performance.now() | 0).toString(36).slice(-3)}`
}

export interface Snapshot {
  comps: Comp[]
  wires: Wire[]
}

export class Engine {
  comps: Map<string, Comp> = new Map()
  wires: Wire[] = []
  /** Fast lookup: `${compId}:${pin}` (input side) -> source output PinRef. */
  private feed: Map<string, PinRef> = new Map()
  /** Whether the last step failed to reach a stable state (oscillation). */
  unstable = false

  private rebuildFeed() {
    this.feed.clear()
    for (const w of this.wires) {
      this.feed.set(`${w.to.comp}:${w.to.pin}`, w.from)
    }
  }

  load(snap: Snapshot) {
    this.comps = new Map(snap.comps.map((c) => [c.id, c]))
    this.wires = snap.wires.slice()
    this.rebuildFeed()
    this.reset()
  }

  snapshot(): Snapshot {
    return {
      comps: Array.from(this.comps.values()).map((c) => ({ ...c, outs: c.outs.slice() })),
      wires: this.wires.map((w) => ({ ...w, from: { ...w.from }, to: { ...w.to } })),
    }
  }

  addComp(c: Comp) {
    this.comps.set(c.id, c)
  }

  removeComp(id: string) {
    this.comps.delete(id)
    this.wires = this.wires.filter((w) => w.from.comp !== id && w.to.comp !== id)
    this.rebuildFeed()
  }

  addWire(from: PinRef, to: PinRef): Wire | null {
    if (from.comp === to.comp) return null
    const src = this.comps.get(from.comp)
    const dst = this.comps.get(to.comp)
    if (!src || !dst) return null
    if (from.pin >= kindMeta(src.kind).numOut) return null
    if (to.pin >= kindMeta(dst.kind).numIn) return null
    // one wire per input pin — replace any existing feed
    this.wires = this.wires.filter((w) => !(w.to.comp === to.comp && w.to.pin === to.pin))
    const w: Wire = { id: uid('w'), from, to }
    this.wires.push(w)
    this.rebuildFeed()
    return w
  }

  removeWire(id: string) {
    this.wires = this.wires.filter((w) => w.id !== id)
    this.rebuildFeed()
  }

  private inputs(comp: Comp): boolean[] {
    const n = kindMeta(comp.kind).numIn
    const res: boolean[] = new Array(n).fill(false)
    for (let i = 0; i < n; i++) {
      const src = this.feed.get(`${comp.id}:${i}`)
      if (src) {
        const c = this.comps.get(src.comp)
        if (c) res[i] = c.outs[src.pin] ?? false
      }
    }
    return res
  }

  /** Read the value present on a component's input pin (for LED/7-seg display). */
  inputValue(comp: Comp, pin: number): boolean {
    const src = this.feed.get(`${comp.id}:${pin}`)
    if (!src) return false
    const c = this.comps.get(src.comp)
    return c ? (c.outs[src.pin] ?? false) : false
  }

  private settle(): boolean {
    let stable = false
    for (let iter = 0; iter < SETTLE_ITERS; iter++) {
      let changed = false
      for (const comp of this.comps.values()) {
        if (kindMeta(comp.kind).stateful) continue
        if (kindMeta(comp.kind).numOut === 0) continue
        const next = evaluate(comp.kind, this.inputs(comp))
        for (let i = 0; i < next.length; i++) {
          if (comp.outs[i] !== next[i]) {
            comp.outs[i] = next[i]
            changed = true
          }
        }
      }
      if (!changed) {
        stable = true
        break
      }
    }
    return stable
  }

  private advanceSeq(): boolean {
    let changed = false
    for (const comp of this.comps.values()) {
      if (comp.kind === 'DFF') {
        const ins = this.inputs(comp)
        const d = ins[0]
        const clk = ins[1]
        if (clk && !comp.prevClk) {
          if (comp.outs[0] !== d) {
            comp.outs[0] = d
            comp.outs[1] = !d
            changed = true
          }
        }
        comp.prevClk = clk
      } else if (comp.kind === 'SRLATCH') {
        const ins = this.inputs(comp)
        const s = ins[0]
        const r = ins[1]
        const q = s ? true : r ? false : comp.outs[0]
        if (comp.outs[0] !== q) {
          comp.outs[0] = q
          comp.outs[1] = !q
          changed = true
        }
      }
    }
    return changed
  }

  /** Advance clocks by dt (seconds), then solve the network. */
  step(dt: number) {
    for (const comp of this.comps.values()) {
      if (comp.kind !== 'CLOCK') continue
      const period = clockPeriod(comp)
      comp.clkAccum += dt
      while (comp.clkAccum >= period / 2) {
        comp.clkAccum -= period / 2
        comp.outs[0] = !comp.outs[0]
      }
    }
    this.solve()
  }

  /** Solve combinational + sequential to steady state without advancing time. */
  solve() {
    let stable = this.settle()
    for (let i = 0; i < SEQ_ITERS; i++) {
      if (!this.advanceSeq()) break
      stable = this.settle() && stable
    }
    this.unstable = !stable
  }

  /** Clear gate/flip-flop state (keeps source values), then solve. */
  reset() {
    for (const comp of this.comps.values()) {
      comp.prevClk = false
      if (comp.kind === 'CONST1') comp.outs = [true]
      else if (comp.kind === 'CONST0') comp.outs = [false]
      else if (comp.kind === 'INPUT') comp.outs = [comp.outs[0] ?? false]
      else if (comp.kind === 'CLOCK') {
        comp.outs = [false]
        comp.clkAccum = 0
      } else comp.outs = defaultOuts(comp.kind)
    }
    // Settle combinational feed first, then seed each flip-flop's remembered clock
    // level from its real input so the first solve doesn't see a phantom edge
    // (e.g. an upstream Q' sitting at 1 reading as a false→1 rising edge).
    this.settle()
    for (const comp of this.comps.values()) {
      if (comp.kind === 'DFF') comp.prevClk = this.inputs(comp)[1]
    }
    this.solve()
  }
}

// Clock period (seconds) is stored in comp.label as a number string; default 1s.
export function clockPeriod(comp: Comp): number {
  const v = Number(comp.label)
  return Number.isFinite(v) && v > 0 ? v : 1
}

export function defaultOuts(kind: Kind): boolean[] {
  const n = kindMeta(kind).numOut
  if (kind === 'CONST1') return [true]
  // two-output memory cells start with Q=0, Q'=1 so the complement is valid
  if (kind === 'DFF' || kind === 'SRLATCH') return [false, true]
  return new Array(n).fill(false)
}
