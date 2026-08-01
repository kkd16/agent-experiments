import { describe, it, expect } from 'vitest'
import { evaluate } from '../src/logic/kinds'
import { EXAMPLES } from '../src/logic/examples'
import { Engine } from '../src/logic/engine'

const bit = (n: number, i: number) => ((n >> i) & 1) === 1

describe('4:1 multiplexer', () => {
  it('routes the selected data input for every select value', () => {
    // data = [1,0,1,0]; check each select picks the right bit
    const data = [true, false, true, false]
    for (let sel = 0; sel < 4; sel++) {
      const out = evaluate('MUX4', [...data, bit(sel, 0), bit(sel, 1)])
      expect(out[0]).toBe(data[sel])
    }
  })
})

describe('1:4 demultiplexer', () => {
  it('steers the data bit to exactly the selected output', () => {
    for (let sel = 0; sel < 4; sel++) {
      const out = evaluate('DMX14', [true, bit(sel, 0), bit(sel, 1)])
      expect(out.map(Number)).toEqual([0, 1, 2, 3].map((i) => (i === sel ? 1 : 0)))
    }
  })
  it('holds every output low when the data bit is 0', () => {
    expect(evaluate('DMX14', [false, true, false])).toEqual([false, false, false, false])
  })
})

describe('mux4 example wired end-to-end', () => {
  it('passes the addressed data input through the built circuit', () => {
    const e = new Engine()
    e.load(EXAMPLES.find((x) => x.id === 'mux4')!.build())
    const byLabel = (l: string) => Array.from(e.comps.values()).find((c) => c.label === l)!
    const d = [byLabel('d0'), byLabel('d1'), byLabel('d2'), byLabel('d3')]
    const s0 = byLabel('s0')
    const s1 = byLabel('s1')
    const y = byLabel('y')
    // set data pattern 1,0,0,1
    d[0].outs[0] = true
    d[3].outs[0] = true
    for (let sel = 0; sel < 4; sel++) {
      s0.outs[0] = bit(sel, 0)
      s1.outs[0] = bit(sel, 1)
      e.solve()
      expect(e.inputValue(y, 0)).toBe(sel === 0 || sel === 3)
    }
  })
})
