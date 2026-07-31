// Prebuilt demonstration circuits. Each returns a fresh Snapshot.
import type { Comp, Wire } from './geometry'
import type { Kind } from './kinds'
import type { Snapshot } from './engine'
import { makeComp } from './factory'

// Tiny fluent builder so example wiring stays readable.
class Build {
  private comps: Comp[] = []
  private wires: Wire[] = []
  private named = new Map<string, Comp>()

  add(name: string, kind: Kind, x: number, y: number, label?: string): this {
    const c = makeComp(kind, x, y, label)
    this.comps.push(c)
    this.named.set(name, c)
    return this
  }

  label(name: string, label: string): this {
    const c = this.named.get(name)
    if (c) c.label = label
    return this
  }

  wire(from: string, fromPin: number, to: string, toPin: number): this {
    const a = this.named.get(from)
    const b = this.named.get(to)
    if (a && b) this.wires.push({ id: `w${this.wires.length}`, from: { comp: a.id, pin: fromPin }, to: { comp: b.id, pin: toPin } })
    return this
  }

  done(): Snapshot {
    return { comps: this.comps, wires: this.wires }
  }
}

export interface Example {
  id: string
  title: string
  note: string
  build: () => Snapshot
}

const halfAdder = (): Snapshot =>
  new Build()
    .add('A', 'INPUT', 60, 120).label('A', 'A')
    .add('B', 'INPUT', 60, 220).label('B', 'B')
    .add('x', 'XOR', 260, 120)
    .add('a', 'AND', 260, 240)
    .add('S', 'OUTPUT', 460, 120).label('S', 'Sum')
    .add('C', 'OUTPUT', 460, 240).label('C', 'Carry')
    .wire('A', 0, 'x', 0).wire('B', 0, 'x', 1)
    .wire('A', 0, 'a', 0).wire('B', 0, 'a', 1)
    .wire('x', 0, 'S', 0).wire('a', 0, 'C', 0)
    .done()

const fullAdder = (): Snapshot =>
  new Build()
    .add('A', 'INPUT', 40, 100).label('A', 'A')
    .add('B', 'INPUT', 40, 200).label('B', 'B')
    .add('Ci', 'INPUT', 40, 300).label('Ci', 'Cin')
    .add('x1', 'XOR', 220, 120)
    .add('x2', 'XOR', 420, 180)
    .add('a1', 'AND', 220, 300)
    .add('a2', 'AND', 420, 320)
    .add('o1', 'OR', 600, 320)
    .add('S', 'OUTPUT', 620, 180).label('S', 'Sum')
    .add('Co', 'OUTPUT', 780, 320).label('Co', 'Cout')
    .wire('A', 0, 'x1', 0).wire('B', 0, 'x1', 1)
    .wire('x1', 0, 'x2', 0).wire('Ci', 0, 'x2', 1)
    .wire('x2', 0, 'S', 0)
    .wire('x1', 0, 'a2', 0).wire('Ci', 0, 'a2', 1)
    .wire('A', 0, 'a1', 0).wire('B', 0, 'a1', 1)
    .wire('a2', 0, 'o1', 0).wire('a1', 0, 'o1', 1)
    .wire('o1', 0, 'Co', 0)
    .done()

const srLatch = (): Snapshot =>
  new Build()
    .add('S', 'INPUT', 60, 120).label('S', 'S')
    .add('R', 'INPUT', 60, 300).label('R', 'R')
    .add('n1', 'NOR', 300, 140)
    .add('n2', 'NOR', 300, 300)
    .add('Q', 'OUTPUT', 520, 140).label('Q', 'Q')
    .add('Qn', 'OUTPUT', 520, 300).label('Qn', "Q'")
    // Q = NOR(R, Q'),  Q' = NOR(S, Q)  → S sets Q high, R resets it low
    .wire('R', 0, 'n1', 0)
    .wire('n2', 0, 'n1', 1)
    .wire('S', 0, 'n2', 0)
    .wire('n1', 0, 'n2', 1)
    .wire('n1', 0, 'Q', 0)
    .wire('n2', 0, 'Qn', 0)
    .done()

const toggle = (): Snapshot =>
  new Build()
    .add('clk', 'CLOCK', 60, 180, '0.6')
    .add('dff', 'DFF', 260, 160)
    .add('led', 'OUTPUT', 480, 160).label('led', 'Q')
    .wire('clk', 0, 'dff', 1)
    .wire('dff', 1, 'dff', 0) // Q' -> D makes it toggle every edge
    .wire('dff', 0, 'led', 0)
    .done()

const hexCounter = (): Snapshot => {
  const b = new Build()
  b.add('clk', 'CLOCK', 40, 260, '0.5')
  const xs = [200, 380, 560, 740]
  for (let i = 0; i < 4; i++) {
    b.add(`ff${i}`, 'DFF', xs[i], 120 + i * 8)
    b.wire(`ff${i}`, 1, `ff${i}`, 0) // toggle
  }
  b.wire('clk', 0, 'ff0', 1)
  // ripple the clock from each stage's Q' (pin 1) so the count runs upward 0→F
  for (let i = 1; i < 4; i++) b.wire(`ff${i - 1}`, 1, `ff${i}`, 1)
  b.add('seg', 'SEG7', 900, 150)
  for (let i = 0; i < 4; i++) b.wire(`ff${i}`, 0, 'seg', i)
  return b.done()
}

const muxDemo = (): Snapshot =>
  new Build()
    .add('a', 'INPUT', 60, 120).label('a', 'A')
    .add('b', 'INPUT', 60, 220).label('b', 'B')
    .add('s', 'INPUT', 60, 320).label('s', 'Sel')
    .add('m', 'MUX2', 300, 180)
    .add('y', 'OUTPUT', 520, 200).label('y', 'Y')
    .wire('a', 0, 'm', 0).wire('b', 0, 'm', 1).wire('s', 0, 'm', 2)
    .wire('m', 0, 'y', 0)
    .done()

const nandUniversal = (): Snapshot =>
  new Build()
    .add('a', 'INPUT', 60, 160).label('a', 'A')
    .add('b', 'INPUT', 60, 320).label('b', 'B')
    .add('n1', 'NAND', 280, 180)
    .add('n2', 'NAND', 280, 320)
    .add('n3', 'NAND', 280, 460)
    .add('n4', 'NAND', 500, 320)
    .add('xor', 'OUTPUT', 720, 320).label('xor', 'A XOR B')
    .wire('a', 0, 'n1', 0).wire('b', 0, 'n1', 1)
    .wire('a', 0, 'n2', 0).wire('n1', 0, 'n2', 1)
    .wire('n1', 0, 'n3', 0).wire('b', 0, 'n3', 1)
    .wire('n2', 0, 'n4', 0).wire('n3', 0, 'n4', 1)
    .wire('n4', 0, 'xor', 0)
    .done()

export const EXAMPLES: Example[] = [
  { id: 'half-adder', title: 'Half adder', note: 'A ⊕ B → Sum, A · B → Carry. Open the truth table.', build: halfAdder },
  { id: 'full-adder', title: 'Full adder', note: 'Three inputs, ripple-carry cell of every ALU.', build: fullAdder },
  { id: 'mux', title: '2:1 multiplexer', note: 'Sel routes A or B to the output.', build: muxDemo },
  { id: 'nand', title: 'XOR from NAND', note: 'NAND is universal — four of them make XOR.', build: nandUniversal },
  { id: 'sr-latch', title: 'SR latch (NOR)', note: 'Cross-coupled NORs remember one bit. Run it.', build: srLatch },
  { id: 'toggle', title: 'T flip-flop', note: 'Q̄→D turns a D-FF into a divide-by-two. Press Run.', build: toggle },
  { id: 'hex-counter', title: '4-bit hex counter', note: 'Ripple counter driving a 7-segment digit. Press Run.', build: hexCounter },
]
