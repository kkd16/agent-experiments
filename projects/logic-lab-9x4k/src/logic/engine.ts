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

/** A single traced signal in the logic analyzer. */
export interface Probe {
  id: string
  label: string
  role: 'in' | 'clk' | 'q' | 'out'
}

/** One recorded moment: the value of every probe at time `t` (seconds). */
export interface TraceSample {
  t: number
  v: boolean[]
}

const TRACE_CAP = 4000


export class Engine {
  comps: Map<string, Comp> = new Map()
  wires: Wire[] = []
  /** Fast lookup: `${compId}:${pin}` (input side) -> source output PinRef. */
  private feed: Map<string, PinRef> = new Map()
  /** Whether the last step failed to reach a stable state (oscillation). */
  unstable = false

  // ---- logic analyzer -------------------------------------------------------
  /** Simulated wall-clock, in seconds, accumulated across steps while tracing. */
  time = 0
  /** Signals sampled into the trace, fixed for the life of a recording. */
  traceProbes: Probe[] = []
  /** Recorded waveform samples, oldest first, capped at TRACE_CAP. */
  trace: TraceSample[] = []

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

  /** Remove several components (and their wires) at once, rebuilding the feed once. */
  removeComps(ids: Iterable<string>) {
    const set = ids instanceof Set ? ids : new Set(ids)
    for (const id of set) this.comps.delete(id)
    this.wires = this.wires.filter((w) => !set.has(w.from.comp) && !set.has(w.to.comp))
    this.rebuildFeed()
  }

  /** Insert already-built components and wires (e.g. a duplicated group), feed rebuilt once. */
  addCluster(comps: Comp[], wires: Wire[]) {
    for (const c of comps) this.comps.set(c.id, c)
    for (const w of wires) this.wires.push(w)
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
    // Two-phase: compute every memory cell's next Q from the CURRENT outputs, then
    // commit them together. Without this, a register of D flip-flops sharing one
    // clock would read a neighbour's freshly-written value and "shoot through"
    // several stages in a single edge; two-phase makes synchronous registers correct.
    const updates: { comp: Comp; q: boolean }[] = []
    for (const comp of this.comps.values()) {
      if (comp.kind === 'DFF') {
        const ins = this.inputs(comp)
        const clk = ins[1]
        if (clk && !comp.prevClk) updates.push({ comp, q: ins[0] })
        comp.prevClk = clk
      } else if (comp.kind === 'TFF') {
        // T flip-flop: rising edge toggles Q when T is high, otherwise holds.
        const ins = this.inputs(comp)
        const clk = ins[1]
        if (clk && !comp.prevClk && ins[0]) updates.push({ comp, q: !comp.outs[0] })
        comp.prevClk = clk
      } else if (comp.kind === 'JKFF') {
        // JK flip-flop: on a rising edge, JK selects hold(00)/reset(01)/set(10)/toggle(11).
        const ins = this.inputs(comp)
        const clk = ins[2]
        if (clk && !comp.prevClk) {
          const q = comp.outs[0]
          const j = ins[0]
          const k = ins[1]
          updates.push({ comp, q: j && k ? !q : j ? true : k ? false : q })
        }
        comp.prevClk = clk
      } else if (comp.kind === 'DLATCH') {
        // Level-sensitive: transparent while Enable is high, holds its last value otherwise.
        const ins = this.inputs(comp)
        if (ins[1]) updates.push({ comp, q: ins[0] })
      } else if (comp.kind === 'SRLATCH') {
        const ins = this.inputs(comp)
        const s = ins[0]
        const r = ins[1]
        updates.push({ comp, q: s ? true : r ? false : comp.outs[0] })
      }
    }
    let changed = false
    for (const u of updates) changed = setQ(u.comp, u.q) || changed
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
    this.time += dt
    this.record()
  }

  // ---- logic analyzer -------------------------------------------------------
  /** The value currently on a probe (out pin for sources / flip-flops, driven pin for LEDs). */
  private probeValue(p: Probe): boolean {
    const c = this.comps.get(p.id)
    if (!c) return false
    if (p.role === 'out') return this.inputValue(c, 0)
    return c.outs[0] ?? false
  }

  /** Enumerate the interesting signals to plot, ordered top-to-bottom by board position. */
  buildProbes(): Probe[] {
    const probes: Probe[] = []
    for (const c of this.comps.values()) {
      if (c.kind === 'INPUT') probes.push({ id: c.id, label: labelOr(c, 'IN'), role: 'in' })
      // CLOCK stores its period in `label`, so it never names the probe — use a fixed tag.
      else if (c.kind === 'CLOCK') probes.push({ id: c.id, label: 'CLK', role: 'clk' })
      else if (c.kind === 'OUTPUT') probes.push({ id: c.id, label: labelOr(c, 'LED'), role: 'out' })
      else if (c.kind === 'DFF' || c.kind === 'TFF' || c.kind === 'JKFF' || c.kind === 'DLATCH' || c.kind === 'SRLATCH')
        probes.push({ id: c.id, label: labelOr(c, 'Q'), role: 'q' })
    }
    const pos = (id: string) => this.comps.get(id)
    return probes.sort((a, b) => {
      const ca = pos(a.id)!
      const cb = pos(b.id)!
      return ca.y - cb.y || ca.x - cb.x
    })
  }

  /** Begin a fresh recording: fix the probe set, reset the clock, capture t=0. */
  beginTrace() {
    this.traceProbes = this.buildProbes()
    this.trace = []
    this.time = 0
    this.record()
  }

  clearTrace() {
    this.trace = []
    this.time = 0
    this.traceProbes = []
  }

  private record() {
    if (this.traceProbes.length === 0) return
    this.trace.push({ t: this.time, v: this.traceProbes.map((p) => this.probeValue(p)) })
    if (this.trace.length > TRACE_CAP) this.trace.splice(0, this.trace.length - TRACE_CAP)
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
      if (comp.kind === 'DFF' || comp.kind === 'TFF') comp.prevClk = this.inputs(comp)[1]
      else if (comp.kind === 'JKFF') comp.prevClk = this.inputs(comp)[2]
    }
    this.solve()
  }
}

/** A component's trimmed label, or a fallback tag when it has none. */
function labelOr(comp: Comp, fallback: string): string {
  const l = (comp.label ?? '').trim()
  return l.length ? l : fallback
}

/** Write a two-output flip-flop's Q / Q' pair, returning whether anything changed. */
function setQ(comp: Comp, q: boolean): boolean {
  if (comp.outs[0] === q && comp.outs[1] === !q) return false
  comp.outs[0] = q
  comp.outs[1] = !q
  return true
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
  if (kind === 'DFF' || kind === 'TFF' || kind === 'JKFF' || kind === 'DLATCH' || kind === 'SRLATCH')
    return [false, true]
  return new Array(n).fill(false)
}
