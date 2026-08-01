import { describe, it, expect } from 'vitest'
import { Engine } from '../src/logic/engine'
import type { Comp, PinRef } from '../src/logic/geometry'
import type { Kind } from '../src/logic/kinds'
import { evaluate } from '../src/logic/kinds'
import { makeComp, serialize, deserialize, cloneComps, isCombinational } from '../src/logic/factory'
import { buildTruthTable } from '../src/logic/truth'
import { encodeCircuit, decodeCircuit } from '../src/logic/share'
import { EXAMPLES } from '../src/logic/examples'
import { History } from '../src/logic/history'

// ---- small helpers ----------------------------------------------------------
function pin(c: Comp, p = 0): PinRef {
  return { comp: c.id, pin: p }
}
function build(...kinds: [Kind, ...unknown[]][]): { e: Engine; comps: Comp[] } {
  const e = new Engine()
  const comps = kinds.map(([k], i) => makeComp(k, i * 100, 0))
  for (const c of comps) e.addComp(c)
  return { e, comps }
}
/** Drive a value onto an INPUT and re-solve. */
function drive(e: Engine, input: Comp, v: boolean) {
  input.outs[0] = v
  e.solve()
}
/** A full low→high→low pulse on a clock INPUT (one rising edge). */
function pulse(e: Engine, clk: Comp) {
  drive(e, clk, false)
  drive(e, clk, true)
  drive(e, clk, false)
}

// ---- combinational truth ----------------------------------------------------
describe('gate evaluation', () => {
  const cases: [Kind, boolean[], boolean][] = [
    ['BUF', [true], true],
    ['NOT', [true], false],
    ['NOT', [false], true],
    ['AND', [true, true], true],
    ['AND', [true, false], false],
    ['OR', [false, false], false],
    ['OR', [true, false], true],
    ['NAND', [true, true], false],
    ['NOR', [false, false], true],
    ['XOR', [true, false], true],
    ['XOR', [true, true], false],
    ['XNOR', [true, true], true],
    ['MUX2', [true, false, false], true], // s=0 -> a
    ['MUX2', [true, false, true], false], // s=1 -> b
  ]
  it.each(cases)('%s(%j) = %s', (kind, ins, out) => {
    expect(evaluate(kind, ins)[0]).toBe(out)
  })

  it('NAND is universal — every combination inverts the AND', () => {
    for (const [a, b] of [[false, false], [false, true], [true, false], [true, true]] as const) {
      expect(evaluate('NAND', [a, b])[0]).toBe(!(a && b))
    }
  })
})

// ---- combinational networks -------------------------------------------------
describe('combinational solve', () => {
  it('half adder produces sum = A⊕B and carry = A·B', () => {
    const { e, comps } = build(['INPUT'], ['INPUT'], ['XOR'], ['AND'], ['OUTPUT'], ['OUTPUT'])
    const [a, b, x, an, sum, carry] = comps
    e.addWire(pin(a), pin(x, 0))
    e.addWire(pin(b), pin(x, 1))
    e.addWire(pin(a), pin(an, 0))
    e.addWire(pin(b), pin(an, 1))
    e.addWire(pin(x), pin(sum, 0))
    e.addWire(pin(an), pin(carry, 0))
    for (const [av, bv] of [[false, false], [false, true], [true, false], [true, true]] as const) {
      a.outs[0] = av
      b.outs[0] = bv
      e.solve()
      expect(e.inputValue(sum, 0)).toBe(av !== bv)
      expect(e.inputValue(carry, 0)).toBe(av && bv)
      expect(e.unstable).toBe(false)
    }
  })

  it('flags a 3-inverter ring as oscillating (unstable)', () => {
    const { e, comps } = build(['NOT'], ['NOT'], ['NOT'])
    const [n0, n1, n2] = comps
    e.addWire(pin(n0), pin(n1, 0))
    e.addWire(pin(n1), pin(n2, 0))
    e.addWire(pin(n2), pin(n0, 0))
    e.solve()
    expect(e.unstable).toBe(true)
  })

  it('a plain buffer chain settles cleanly', () => {
    const { e, comps } = build(['INPUT'], ['BUF'], ['BUF'], ['OUTPUT'])
    const [inp, b1, b2, led] = comps
    e.addWire(pin(inp), pin(b1, 0))
    e.addWire(pin(b1), pin(b2, 0))
    e.addWire(pin(b2), pin(led, 0))
    drive(e, inp, true)
    expect(e.unstable).toBe(false)
    expect(e.inputValue(led, 0)).toBe(true)
  })
})

// ---- flip-flops -------------------------------------------------------------
describe('sequential primitives', () => {
  it('D flip-flop captures D only on a rising edge', () => {
    const { e, comps } = build(['INPUT'], ['INPUT'], ['DFF'])
    const [d, clk, ff] = comps
    e.addWire(pin(d), pin(ff, 0))
    e.addWire(pin(clk), pin(ff, 1))
    e.reset()
    drive(e, d, true) // D high but no edge yet
    expect(ff.outs[0]).toBe(false)
    pulse(e, clk) // rising edge captures D=1
    expect(ff.outs[0]).toBe(true)
    expect(ff.outs[1]).toBe(false)
    drive(e, d, false) // change D with clock low — Q holds
    expect(ff.outs[0]).toBe(true)
    pulse(e, clk) // next edge captures D=0
    expect(ff.outs[0]).toBe(false)
  })

  it('T flip-flop toggles on each edge while T is high, holds while low', () => {
    const { e, comps } = build(['INPUT'], ['INPUT'], ['TFF'])
    const [t, clk, ff] = comps
    e.addWire(pin(t), pin(ff, 0))
    e.addWire(pin(clk), pin(ff, 1))
    e.reset()
    drive(e, t, true)
    expect(ff.outs[0]).toBe(false)
    pulse(e, clk)
    expect(ff.outs[0]).toBe(true)
    pulse(e, clk)
    expect(ff.outs[0]).toBe(false)
    drive(e, t, false) // T low — edges no longer toggle
    pulse(e, clk)
    expect(ff.outs[0]).toBe(false)
  })

  it('JK flip-flop realises hold / reset / set / toggle', () => {
    const { e, comps } = build(['INPUT'], ['INPUT'], ['INPUT'], ['JKFF'])
    const [j, k, clk, ff] = comps
    e.addWire(pin(j), pin(ff, 0))
    e.addWire(pin(k), pin(ff, 1))
    e.addWire(pin(clk), pin(ff, 2))
    e.reset()
    // set: J=1,K=0
    j.outs[0] = true
    k.outs[0] = false
    e.solve()
    pulse(e, clk)
    expect(ff.outs[0]).toBe(true)
    // hold: J=0,K=0
    j.outs[0] = false
    e.solve()
    pulse(e, clk)
    expect(ff.outs[0]).toBe(true)
    // reset: J=0,K=1
    k.outs[0] = true
    e.solve()
    pulse(e, clk)
    expect(ff.outs[0]).toBe(false)
    // toggle: J=1,K=1
    j.outs[0] = true
    e.solve()
    pulse(e, clk)
    expect(ff.outs[0]).toBe(true)
    pulse(e, clk)
    expect(ff.outs[0]).toBe(false)
  })

  it('D latch is transparent while enabled and holds when disabled', () => {
    const { e, comps } = build(['INPUT'], ['INPUT'], ['DLATCH'])
    const [d, en, lat] = comps
    e.addWire(pin(d), pin(lat, 0))
    e.addWire(pin(en), pin(lat, 1))
    e.reset()
    drive(e, en, true) // enabled, transparent
    drive(e, d, true)
    expect(lat.outs[0]).toBe(true)
    drive(e, d, false)
    expect(lat.outs[0]).toBe(false)
    drive(e, d, true)
    drive(e, en, false) // freeze at 1
    drive(e, d, false) // ignored while frozen
    expect(lat.outs[0]).toBe(true)
  })

  it('SR latch sets, resets and holds', () => {
    const { e, comps } = build(['INPUT'], ['INPUT'], ['SRLATCH'])
    const [s, r, sr] = comps
    e.addWire(pin(s), pin(sr, 0))
    e.addWire(pin(r), pin(sr, 1))
    e.reset()
    drive(e, s, true)
    expect(sr.outs[0]).toBe(true)
    drive(e, s, false) // hold
    expect(sr.outs[0]).toBe(true)
    drive(e, r, true)
    expect(sr.outs[0]).toBe(false)
  })
})

// ---- ripple counter over real clock time ------------------------------------
describe('4-bit ripple counter', () => {
  it('counts 0→15 and wraps, driven by the CLOCK part', () => {
    const e = new Engine()
    e.load(EXAMPLES.find((x) => x.id === 'hex-counter')!.build())
    const ffs = Array.from(e.comps.values()).filter((c) => c.kind === 'DFF').sort((a, b) => a.x - b.x)
    const clk = Array.from(e.comps.values()).find((c) => c.kind === 'CLOCK')!
    const val = () => ffs.reduce((acc, ff, i) => acc | ((ff.outs[0] ? 1 : 0) << i), 0)
    const seen: number[] = []
    let prev = clk.outs[0]
    // half-period is 0.25s; step in half-periods so every other step is a rising edge
    for (let i = 0; i < 40 && seen.length < 17; i++) {
      e.step(0.25)
      if (clk.outs[0] && !prev) seen.push(val())
      prev = clk.outs[0]
    }
    expect(seen.slice(0, 17)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1])
    expect(e.unstable).toBe(false)
  })
})

// ---- truth tables -----------------------------------------------------------
describe('truth table', () => {
  it('enumerates the 2-bit comparator (A=B) correctly', () => {
    const snap = EXAMPLES.find((x) => x.id === 'comparator')!.build()
    const tt = buildTruthTable(snap)!
    expect(tt).toBeTruthy()
    expect(tt.inputs.length).toBe(4)
    expect(tt.rows.length).toBe(16)
    // one output: equality. Verify against A0,A1 vs B0,B1 read back from row order.
    // input order follows y,x sort: A0,A1,B0,B1
    for (const row of tt.rows) {
      const [a0, a1, b0, b1] = row.in
      const eq = a0 === b0 && a1 === b1
      expect(row.out[0]).toBe(eq)
    }
  })

  it('reports sequential circuits instead of tabulating them', () => {
    const snap = EXAMPLES.find((x) => x.id === 't-counter')!.build()
    const tt = buildTruthTable(snap)
    expect(tt?.reason).toBe('sequential')
    expect(isCombinational(snap)).toBe(false)
  })
})

// ---- serialisation & sharing ------------------------------------------------
describe('serialisation', () => {
  it('round-trips a circuit through serialize/deserialize', () => {
    const snap = EXAMPLES.find((x) => x.id === 'full-adder')!.build()
    const saved = serialize({ comps: snap.comps, wires: snap.wires })
    const back = deserialize(saved)
    expect(back.comps.length).toBe(snap.comps.length)
    expect(back.wires.length).toBe(snap.wires.length)
    // input values survive
    const savedAgain = serialize(back)
    expect(savedAgain.comps.map((c) => c.kind).sort()).toEqual(saved.comps.map((c) => c.kind).sort())
  })

  it('preserves INPUT switch positions', () => {
    const { e, comps } = build(['INPUT'], ['OUTPUT'])
    const [inp, led] = comps
    e.addWire(pin(inp), pin(led, 0))
    inp.outs[0] = true
    const saved = serialize(e.snapshot())
    const back = deserialize(saved)
    const restored = back.comps.find((c) => c.kind === 'INPUT')!
    expect(restored.outs[0]).toBe(true)
  })

  it('drops wires that reference unknown components', () => {
    const saved = { v: 1 as const, comps: [], wires: [{ from: ['ghost', 0] as [string, number], to: ['nope', 0] as [string, number] }] }
    const back = deserialize(saved)
    expect(back.wires.length).toBe(0)
  })

  it('encodes and decodes a shareable circuit token', () => {
    const saved = serialize(new Engine().snapshot())
    saved.comps.push({ id: 'x', kind: 'INPUT', x: 0, y: 0, value: true })
    const token = encodeCircuit(saved)
    expect(token.length).toBeGreaterThan(0)
    expect(/[+/=]/.test(token)).toBe(false) // URL-safe alphabet only
    const back = decodeCircuit(token)
    expect(back?.comps[0]?.value).toBe(true)
  })

  it('rejects a corrupt share token', () => {
    expect(decodeCircuit('!!!not-base64!!!')).toBeNull()
    expect(decodeCircuit('')).toBeNull()
  })
})

// ---- clone / duplicate ------------------------------------------------------
describe('cloneComps', () => {
  it('clones a group with fresh ids and preserves internal wiring', () => {
    const { e, comps } = build(['INPUT'], ['NOT'], ['OUTPUT'])
    const [a, n, o] = comps
    e.addWire(pin(a), pin(n, 0))
    e.addWire(pin(n), pin(o, 0))
    const ids = new Set(comps.map((c) => c.id))
    const { comps: cloned, wires } = cloneComps(Array.from(e.comps.values()), e.wires, ids, 50, 50)
    expect(cloned.length).toBe(3)
    expect(wires.length).toBe(2)
    // no id overlap with originals
    for (const c of cloned) expect(ids.has(c.id)).toBe(false)
    // offset applied
    expect(cloned[0].x).toBe(a.x + 50)
    // clones don't share the outs array with the source
    cloned[0].outs[0] = !cloned[0].outs[0]
    expect(cloned[0].outs[0]).not.toBe(a.outs[0])
  })

  it('excludes wires that cross the selection boundary', () => {
    const { e, comps } = build(['INPUT'], ['NOT'], ['OUTPUT'])
    const [a, n, o] = comps
    e.addWire(pin(a), pin(n, 0))
    e.addWire(pin(n), pin(o, 0))
    const ids = new Set([n.id]) // only the NOT
    const { comps: cloned, wires } = cloneComps(Array.from(e.comps.values()), e.wires, ids, 0, 0)
    expect(cloned.length).toBe(1)
    expect(wires.length).toBe(0) // both its wires reach outside the set
  })
})

// ---- logic analyzer trace ---------------------------------------------------
describe('logic analyzer', () => {
  it('records a waveform sample per step for every probe', () => {
    const e = new Engine()
    e.load(EXAMPLES.find((x) => x.id === 'toggle')!.build())
    e.beginTrace()
    expect(e.trace.length).toBe(1) // t=0 baseline
    expect(e.traceProbes.length).toBeGreaterThan(0)
    for (let i = 0; i < 10; i++) e.step(0.1)
    expect(e.trace.length).toBe(11)
    // times are monotonically increasing
    for (let i = 1; i < e.trace.length; i++) expect(e.trace[i].t).toBeGreaterThan(e.trace[i - 1].t)
    // each sample has one value per probe
    for (const s of e.trace) expect(s.v.length).toBe(e.traceProbes.length)
  })

  it('clearTrace stops recording', () => {
    const e = new Engine()
    e.load(EXAMPLES.find((x) => x.id === 'toggle')!.build())
    e.beginTrace()
    e.clearTrace()
    e.step(0.1)
    expect(e.trace.length).toBe(0)
  })
})

// ---- undo/redo history ------------------------------------------------------
describe('history', () => {
  it('records only real changes and steps back and forth', () => {
    const h = new History()
    h.begin('A')
    h.commit('A') // no change — nothing recorded
    expect(h.canUndo()).toBe(false)
    h.begin('A')
    h.commit('B') // A -> B
    expect(h.canUndo()).toBe(true)
    expect(h.undo('B')).toBe('A')
    expect(h.canRedo()).toBe(true)
    expect(h.redo('A')).toBe('B')
  })

  it('clears the redo stack after a new edit', () => {
    const h = new History()
    h.record('A', 'B')
    h.undo('B') // back at A, redo has B
    expect(h.canRedo()).toBe(true)
    h.record('A', 'C') // new branch wipes redo
    expect(h.canRedo()).toBe(false)
  })
})
