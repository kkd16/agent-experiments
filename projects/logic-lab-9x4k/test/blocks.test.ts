import { describe, it, expect } from 'vitest'
import { evaluate } from '../src/logic/kinds'
import { buildTruthTable } from '../src/logic/truth'
import { EXAMPLES } from '../src/logic/examples'

const B = (n: number, bits: number) => Array.from({ length: bits }, (_, i) => ((n >> i) & 1) === 1)

describe('decoder 2:4', () => {
  it('lights exactly the addressed output when enabled', () => {
    for (let addr = 0; addr < 4; addr++) {
      const [a0, a1] = B(addr, 2)
      const out = evaluate('DEC24', [a0, a1, true])
      expect(out.map(Number)).toEqual([0, 1, 2, 3].map((i) => (i === addr ? 1 : 0)))
    }
  })
  it('drives everything low when disabled', () => {
    expect(evaluate('DEC24', [true, true, false])).toEqual([false, false, false, false])
  })
})

describe('full adder', () => {
  it('matches sum/carry for all 8 input combinations', () => {
    for (let m = 0; m < 8; m++) {
      const [a, b, ci] = B(m, 3)
      const total = Number(a) + Number(b) + Number(ci)
      const [s, co] = evaluate('FADD', [a, b, ci])
      expect(Number(s)).toBe(total & 1)
      expect(Number(co)).toBe(total >> 1)
    }
  })
})

describe('priority encoder 4:2', () => {
  it('encodes the highest set input and flags validity', () => {
    expect(evaluate('ENC42', [false, false, false, false])).toEqual([false, false, false]) // none: V=0
    expect(evaluate('ENC42', [true, false, false, false]).map(Number)).toEqual([0, 0, 1]) // idx0
    expect(evaluate('ENC42', [true, true, false, false]).map(Number)).toEqual([1, 0, 1]) // idx1 wins
    expect(evaluate('ENC42', [true, true, true, false]).map(Number)).toEqual([0, 1, 1]) // idx2
    expect(evaluate('ENC42', [true, true, true, true]).map(Number)).toEqual([1, 1, 1]) // idx3
  })
})

describe('block-based example circuits', () => {
  it('the 2-bit adder computes a+b across its truth table', () => {
    const tt = buildTruthTable(EXAMPLES.find((x) => x.id === 'adder2')!.build())!
    expect(tt.inputs.length).toBe(4) // a0,a1,b0,b1
    expect(tt.rows.length).toBe(16)
    // input order is y,x sorted: a0,a1,b0,b1; outputs y,x sorted: s0,s1,cout
    for (const row of tt.rows) {
      const [a0, a1, b0, b1] = row.in.map(Number)
      const a = a0 + 2 * a1
      const b = b0 + 2 * b1
      const sum = a + b
      const [s0, s1, co] = row.out.map(Number)
      expect(s0 + 2 * s1 + 4 * co).toBe(sum)
    }
  })

  it('the 2:4 decoder truth table lights one output per address', () => {
    const tt = buildTruthTable(EXAMPLES.find((x) => x.id === 'decoder')!.build())!
    for (const row of tt.rows) {
      const [a0, a1, en] = row.in.map(Number)
      const hot = row.out.map(Number).reduce((a, b) => a + b, 0)
      expect(hot).toBe(en ? 1 : 0)
      if (en) expect(row.out[a0 + 2 * a1]).toBe(true)
    }
  })
})
