import { describe, it, expect } from 'vitest'
import { Engine, clockPeriod } from '../src/logic/engine'
import type { Comp, PinRef } from '../src/logic/geometry'
import type { Kind } from '../src/logic/kinds'
import { makeComp } from '../src/logic/factory'
import { traceToCsv } from '../src/logic/exporter'
import { EXAMPLES } from '../src/logic/examples'

function pin(c: Comp, p = 0): PinRef {
  return { comp: c.id, pin: p }
}
function add(e: Engine, kind: Kind, label?: string): Comp {
  const c = makeComp(kind, 0, 0, label)
  e.addComp(c)
  return c
}
function drive(e: Engine, input: Comp, v: boolean) {
  input.outs[0] = v
  e.solve()
}
function pulse(e: Engine, clk: Comp) {
  drive(e, clk, false)
  drive(e, clk, true)
  drive(e, clk, false)
}

describe('two-phase synchronous update', () => {
  it('a shared-clock D-register shifts exactly one stage per edge (no shoot-through)', () => {
    const e = new Engine()
    const din = add(e, 'INPUT')
    const clk = add(e, 'INPUT')
    const f0 = add(e, 'DFF')
    const f1 = add(e, 'DFF')
    const f2 = add(e, 'DFF')
    e.addWire(pin(din), pin(f0, 0))
    e.addWire(pin(f0), pin(f1, 0))
    e.addWire(pin(f1), pin(f2, 0))
    for (const f of [f0, f1, f2]) e.addWire(pin(clk), pin(f, 1))
    e.reset()
    const state = () => [f0.outs[0], f1.outs[0], f2.outs[0]]

    drive(e, din, true)
    pulse(e, clk)
    expect(state()).toEqual([true, false, false]) // only stage 0 loaded — not all three
    drive(e, din, false)
    pulse(e, clk)
    expect(state()).toEqual([false, true, false])
    pulse(e, clk)
    expect(state()).toEqual([false, false, true])
    pulse(e, clk)
    expect(state()).toEqual([false, false, false])
    expect(e.unstable).toBe(false)
  })

  it('a 4-bit Johnson (twisted-ring) counter walks its 8 states', () => {
    const e = new Engine()
    const clk = add(e, 'INPUT')
    const f = [add(e, 'DFF'), add(e, 'DFF'), add(e, 'DFF'), add(e, 'DFF')]
    for (const ff of f) e.addWire(pin(clk), pin(ff, 1))
    e.addWire(pin(f[3], 1), pin(f[0], 0)) // Q3' -> D0
    e.addWire(pin(f[0]), pin(f[1], 0))
    e.addWire(pin(f[1]), pin(f[2], 0))
    e.addWire(pin(f[2]), pin(f[3], 0))
    e.reset()
    const state = () => f.map((ff) => (ff.outs[0] ? 1 : 0)).join('')
    const seq: string[] = []
    for (let i = 0; i < 8; i++) {
      pulse(e, clk)
      seq.push(state())
    }
    expect(seq).toEqual(['1000', '1100', '1110', '1111', '0111', '0011', '0001', '0000'])
  })
})

describe('clock period', () => {
  it('parses the label as a positive period, falling back to 1s', () => {
    expect(clockPeriod(makeComp('CLOCK', 0, 0, '0.5'))).toBe(0.5)
    expect(clockPeriod(makeComp('CLOCK', 0, 0, '2'))).toBe(2)
    expect(clockPeriod(makeComp('CLOCK', 0, 0, 'abc'))).toBe(1)
    expect(clockPeriod(makeComp('CLOCK', 0, 0, '-3'))).toBe(1)
  })
})

describe('trace CSV export', () => {
  it('emits a time column plus one 0/1 column per probe', () => {
    const e = new Engine()
    e.load(EXAMPLES.find((x) => x.id === 'toggle')!.build())
    e.beginTrace()
    for (let i = 0; i < 3; i++) e.step(0.1)
    const csv = traceToCsv(e.traceProbes, e.trace)
    const lines = csv.split('\n')
    expect(lines[0].split(',')[0]).toBe('time')
    expect(lines[0].split(',').length).toBe(e.traceProbes.length + 1)
    expect(lines.length).toBe(e.trace.length + 1) // header + one row per sample
    for (const row of lines.slice(1)) {
      for (const cell of row.split(',').slice(1)) expect(cell === '0' || cell === '1').toBe(true)
    }
  })

  it('disambiguates duplicate probe labels in the header', () => {
    const probes = [
      { id: 'a', label: 'Q', role: 'q' as const },
      { id: 'b', label: 'Q', role: 'q' as const },
    ]
    const csv = traceToCsv(probes, [{ t: 0, v: [true, false] }])
    expect(csv.split('\n')[0]).toBe('time,Q,Q_2')
  })
})

describe('new example circuits build', () => {
  it.each(['shift-reg', 'johnson'])('%s is present and wired', (id) => {
    const ex = EXAMPLES.find((x) => x.id === id)!
    expect(ex).toBeTruthy()
    const snap = ex.build()
    expect(snap.comps.length).toBeGreaterThan(0)
    expect(snap.wires.length).toBeGreaterThan(0)
  })
})
