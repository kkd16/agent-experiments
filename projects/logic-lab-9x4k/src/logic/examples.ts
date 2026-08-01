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

const jkToggle = (): Snapshot =>
  new Build()
    .add('one', 'CONST1', 60, 110)
    .add('clk', 'CLOCK', 60, 250, '0.6')
    .add('jk', 'JKFF', 280, 150)
    .add('q', 'OUTPUT', 500, 160).label('q', 'Q')
    // J=K=1 makes a JK flip-flop toggle on every rising edge — a divide-by-two.
    .wire('one', 0, 'jk', 0)
    .wire('one', 0, 'jk', 1)
    .wire('clk', 0, 'jk', 2)
    .wire('jk', 0, 'q', 0)
    .done()

const gatedLatch = (): Snapshot =>
  new Build()
    .add('d', 'INPUT', 60, 120).label('d', 'D')
    .add('e', 'INPUT', 60, 240).label('e', 'En')
    .add('dl', 'DLATCH', 280, 150)
    .add('q', 'OUTPUT', 500, 160).label('q', 'Q')
    // While En=1 the latch is transparent (Q follows D); drop En to freeze the bit.
    .wire('d', 0, 'dl', 0)
    .wire('e', 0, 'dl', 1)
    .wire('dl', 0, 'q', 0)
    .done()

const tCounter = (): Snapshot =>
  new Build()
    .add('one', 'CONST1', 40, 110)
    .add('clk', 'CLOCK', 40, 260, '0.5')
    .add('t0', 'TFF', 240, 160)
    .add('t1', 'TFF', 460, 160)
    .add('q0', 'OUTPUT', 680, 140).label('q0', 'b0')
    .add('q1', 'OUTPUT', 680, 250).label('q1', 'b1')
    // Two toggling T flip-flops; stage 1 clocks off stage 0's Q' so the pair counts 0→3.
    .wire('one', 0, 't0', 0)
    .wire('one', 0, 't1', 0)
    .wire('clk', 0, 't0', 1)
    .wire('t0', 1, 't1', 1)
    .wire('t0', 0, 'q0', 0)
    .wire('t1', 0, 'q1', 0)
    .done()

const comparator2 = (): Snapshot =>
  new Build()
    .add('a0', 'INPUT', 40, 80).label('a0', 'A0')
    .add('a1', 'INPUT', 40, 180).label('a1', 'A1')
    .add('b0', 'INPUT', 40, 320).label('b0', 'B0')
    .add('b1', 'INPUT', 40, 420).label('b1', 'B1')
    .add('x0', 'XNOR', 260, 120)
    .add('x1', 'XNOR', 260, 340)
    .add('and', 'AND', 480, 230)
    .add('eq', 'OUTPUT', 700, 240).label('eq', 'A=B')
    // Equality bit-by-bit (XNOR), AND-ed together: 1 only when the two 2-bit numbers match.
    .wire('a0', 0, 'x0', 0).wire('b0', 0, 'x0', 1)
    .wire('a1', 0, 'x1', 0).wire('b1', 0, 'x1', 1)
    .wire('x0', 0, 'and', 0).wire('x1', 0, 'and', 1)
    .wire('and', 0, 'eq', 0)
    .done()

const shiftReg = (): Snapshot =>
  new Build()
    .add('din', 'INPUT', 40, 90).label('din', 'Din')
    .add('clk', 'CLOCK', 40, 260, '0.6')
    .add('f0', 'DFF', 240, 150)
    .add('f1', 'DFF', 440, 150)
    .add('f2', 'DFF', 640, 150)
    .add('q0', 'OUTPUT', 840, 120).label('q0', 'Q0')
    .add('q1', 'OUTPUT', 840, 210).label('q1', 'Q1')
    .add('q2', 'OUTPUT', 840, 300).label('q2', 'Q2')
    // Synchronous 3-stage shift register: every edge moves Din one stage right.
    // (Correct only because the engine samples all flip-flops before committing.)
    .wire('din', 0, 'f0', 0)
    .wire('f0', 0, 'f1', 0)
    .wire('f1', 0, 'f2', 0)
    .wire('clk', 0, 'f0', 1).wire('clk', 0, 'f1', 1).wire('clk', 0, 'f2', 1)
    .wire('f0', 0, 'q0', 0).wire('f1', 0, 'q1', 0).wire('f2', 0, 'q2', 0)
    .done()

const johnson = (): Snapshot => {
  const b = new Build()
  b.add('clk', 'CLOCK', 40, 300, '0.5')
  const xs = [220, 400, 580, 760]
  for (let i = 0; i < 4; i++) {
    b.add(`f${i}`, 'DFF', xs[i], 150)
    b.wire('clk', 0, `f${i}`, 1)
    b.add(`q${i}`, 'OUTPUT', xs[i] + 8, 40).label(`q${i}`, `Q${i}`)
    b.wire(`f${i}`, 0, `q${i}`, 0)
  }
  // Twisted-ring counter: the last stage's Q' feeds back to the first stage's D,
  // producing an 8-state 0000→1000→1100→1110→1111→0111→0011→0001 walk.
  b.wire('f3', 1, 'f0', 0)
  b.wire('f0', 0, 'f1', 0)
  b.wire('f1', 0, 'f2', 0)
  b.wire('f2', 0, 'f3', 0)
  return b.done()
}

export const EXAMPLES: Example[] = [
  { id: 'half-adder', title: 'Half adder', note: 'A ⊕ B → Sum, A · B → Carry. Open the truth table.', build: halfAdder },
  { id: 'full-adder', title: 'Full adder', note: 'Three inputs, ripple-carry cell of every ALU.', build: fullAdder },
  { id: 'mux', title: '2:1 multiplexer', note: 'Sel routes A or B to the output.', build: muxDemo },
  { id: 'nand', title: 'XOR from NAND', note: 'NAND is universal — four of them make XOR.', build: nandUniversal },
  { id: 'sr-latch', title: 'SR latch (NOR)', note: 'Cross-coupled NORs remember one bit. Run it.', build: srLatch },
  { id: 'toggle', title: 'T flip-flop', note: 'Q̄→D turns a D-FF into a divide-by-two. Press Run.', build: toggle },
  { id: 'jk-toggle', title: 'JK toggle', note: 'J=K=1 → the JK flip-flop toggles every edge. Open the Analyzer.', build: jkToggle },
  { id: 'gated-latch', title: 'Gated D latch', note: 'Transparent while Enable is high; drop it to hold the bit.', build: gatedLatch },
  { id: 't-counter', title: '2-bit T counter', note: 'Two T flip-flops ripple-count 0→3. Run with the Analyzer open.', build: tCounter },
  { id: 'comparator', title: '2-bit comparator', note: 'A=B via XNOR + AND. Open the truth table.', build: comparator2 },
  { id: 'shift-reg', title: '3-bit shift register', note: 'Toggle Din, then Step — one bit marches across per edge. Analyzer on.', build: shiftReg },
  { id: 'johnson', title: '4-bit Johnson counter', note: 'A twisted ring cycles 8 states. Run with the Analyzer open.', build: johnson },
  { id: 'hex-counter', title: '4-bit hex counter', note: 'Ripple counter driving a 7-segment digit. Press Run.', build: hexCounter },
]
