// Component kinds and their static metadata + combinational evaluation.
// Stateful kinds (INPUT, CLOCK, CONST*, DFF, SRLATCH) are driven by the engine,
// not by the combinational evaluator here.

export type Kind =
  | 'INPUT'
  | 'CLOCK'
  | 'CONST0'
  | 'CONST1'
  | 'OUTPUT'
  | 'SEG7'
  | 'BUF'
  | 'NOT'
  | 'AND'
  | 'OR'
  | 'NAND'
  | 'NOR'
  | 'XOR'
  | 'XNOR'
  | 'MUX2'
  | 'DEC24'
  | 'FADD'
  | 'ENC42'
  | 'DFF'
  | 'TFF'
  | 'JKFF'
  | 'DLATCH'
  | 'SRLATCH'

export type Category = 'io' | 'gate' | 'block'

export interface KindMeta {
  label: string
  short: string
  category: Category
  numIn: number
  numOut: number
  inLabels: string[]
  outLabels: string[]
  /** Not recomputed during the combinational settle pass — the engine owns it. */
  stateful: boolean
  /** Shown in the palette + help. */
  blurb: string
}

const meta: Record<Kind, KindMeta> = {
  INPUT: { label: 'Input', short: 'IN', category: 'io', numIn: 0, numOut: 1, inLabels: [], outLabels: [''], stateful: true, blurb: 'Toggle switch. Click its body to flip 0/1.' },
  CLOCK: { label: 'Clock', short: 'CLK', category: 'io', numIn: 0, numOut: 1, inLabels: [], outLabels: [''], stateful: true, blurb: 'Square-wave source that ticks while the sim runs.' },
  CONST0: { label: 'Const 0', short: '0', category: 'io', numIn: 0, numOut: 1, inLabels: [], outLabels: [''], stateful: true, blurb: 'Always logic 0.' },
  CONST1: { label: 'Const 1', short: '1', category: 'io', numIn: 0, numOut: 1, inLabels: [], outLabels: [''], stateful: true, blurb: 'Always logic 1.' },
  OUTPUT: { label: 'LED', short: 'LED', category: 'io', numIn: 1, numOut: 0, inLabels: [''], outLabels: [], stateful: false, blurb: 'Lights up when its input is 1.' },
  SEG7: { label: '7-Seg', short: 'HEX', category: 'io', numIn: 4, numOut: 0, inLabels: ['1', '2', '4', '8'], outLabels: [], stateful: false, blurb: '4-bit value shown as a hex digit (0–F).' },
  BUF: { label: 'Buffer', short: 'BUF', category: 'gate', numIn: 1, numOut: 1, inLabels: [''], outLabels: [''], stateful: false, blurb: 'Passes its input straight through.' },
  NOT: { label: 'NOT', short: 'NOT', category: 'gate', numIn: 1, numOut: 1, inLabels: [''], outLabels: [''], stateful: false, blurb: 'Inverts the input.' },
  AND: { label: 'AND', short: 'AND', category: 'gate', numIn: 2, numOut: 1, inLabels: ['', ''], outLabels: [''], stateful: false, blurb: '1 only when both inputs are 1.' },
  OR: { label: 'OR', short: 'OR', category: 'gate', numIn: 2, numOut: 1, inLabels: ['', ''], outLabels: [''], stateful: false, blurb: '1 when any input is 1.' },
  NAND: { label: 'NAND', short: 'NAND', category: 'gate', numIn: 2, numOut: 1, inLabels: ['', ''], outLabels: [''], stateful: false, blurb: 'Inverted AND — the universal gate.' },
  NOR: { label: 'NOR', short: 'NOR', category: 'gate', numIn: 2, numOut: 1, inLabels: ['', ''], outLabels: [''], stateful: false, blurb: 'Inverted OR.' },
  XOR: { label: 'XOR', short: 'XOR', category: 'gate', numIn: 2, numOut: 1, inLabels: ['', ''], outLabels: [''], stateful: false, blurb: '1 when the inputs differ.' },
  XNOR: { label: 'XNOR', short: 'XNOR', category: 'gate', numIn: 2, numOut: 1, inLabels: ['', ''], outLabels: [''], stateful: false, blurb: '1 when the inputs match.' },
  MUX2: { label: 'Mux 2:1', short: 'MUX', category: 'block', numIn: 3, numOut: 1, inLabels: ['a', 'b', 's'], outLabels: ['y'], stateful: false, blurb: 'Selects a or b based on the s line.' },
  DEC24: { label: 'Decoder 2:4', short: 'DEC', category: 'block', numIn: 3, numOut: 4, inLabels: ['a0', 'a1', 'en'], outLabels: ['0', '1', '2', '3'], stateful: false, blurb: 'Drives one of four outputs high, chosen by the 2-bit address (gated by en).' },
  FADD: { label: 'Full Adder', short: 'FADD', category: 'block', numIn: 3, numOut: 2, inLabels: ['A', 'B', 'Ci'], outLabels: ['S', 'Co'], stateful: false, blurb: 'One-bit adder: S = A⊕B⊕Cin, Co = the carry. Chain them for a ripple adder.' },
  ENC42: { label: 'Priority Enc 4:2', short: 'ENC', category: 'block', numIn: 4, numOut: 3, inLabels: ['0', '1', '2', '3'], outLabels: ['o0', 'o1', 'V'], stateful: false, blurb: 'Encodes the highest active input to a 2-bit code; V flags any input set.' },
  DFF: { label: 'D Flip-Flop', short: 'DFF', category: 'block', numIn: 2, numOut: 2, inLabels: ['D', '>'], outLabels: ['Q', "Q'"], stateful: true, blurb: 'Captures D on each rising clock edge.' },
  TFF: { label: 'T Flip-Flop', short: 'TFF', category: 'block', numIn: 2, numOut: 2, inLabels: ['T', '>'], outLabels: ['Q', "Q'"], stateful: true, blurb: 'Toggles Q on a rising edge while T is 1 — a divide-by-two.' },
  JKFF: { label: 'JK Flip-Flop', short: 'JKFF', category: 'block', numIn: 3, numOut: 2, inLabels: ['J', 'K', '>'], outLabels: ['Q', "Q'"], stateful: true, blurb: 'Universal edge-triggered cell: hold / reset / set / toggle.' },
  DLATCH: { label: 'D Latch', short: 'DL', category: 'block', numIn: 2, numOut: 2, inLabels: ['D', 'E'], outLabels: ['Q', "Q'"], stateful: true, blurb: 'Transparent while Enable is 1, holds when it drops.' },
  SRLATCH: { label: 'SR Latch', short: 'SR', category: 'block', numIn: 2, numOut: 2, inLabels: ['S', 'R'], outLabels: ['Q', "Q'"], stateful: true, blurb: 'Set/Reset memory cell.' },
}

export function kindMeta(k: Kind): KindMeta {
  return meta[k]
}

export const ALL_KINDS = Object.keys(meta) as Kind[]

/** Pure combinational truth of a gate. Stateful kinds return []. */
export function evaluate(kind: Kind, ins: boolean[]): boolean[] {
  switch (kind) {
    case 'BUF':
      return [ins[0] ?? false]
    case 'NOT':
      return [!(ins[0] ?? false)]
    case 'AND':
      return [(ins[0] ?? false) && (ins[1] ?? false)]
    case 'OR':
      return [(ins[0] ?? false) || (ins[1] ?? false)]
    case 'NAND':
      return [!((ins[0] ?? false) && (ins[1] ?? false))]
    case 'NOR':
      return [!((ins[0] ?? false) || (ins[1] ?? false))]
    case 'XOR':
      return [(ins[0] ?? false) !== (ins[1] ?? false)]
    case 'XNOR':
      return [(ins[0] ?? false) === (ins[1] ?? false)]
    case 'MUX2':
      return [(ins[2] ?? false) ? (ins[1] ?? false) : (ins[0] ?? false)]
    case 'DEC24': {
      // 2:4 decoder: address a1a0 selects one output, all low unless en is high.
      const en = ins[2] ?? false
      const idx = (ins[0] ? 1 : 0) | (ins[1] ? 2 : 0)
      return [en && idx === 0, en && idx === 1, en && idx === 2, en && idx === 3]
    }
    case 'FADD': {
      // Full adder: sum is the 3-input XOR, carry-out is the majority.
      const a = ins[0] ?? false
      const b = ins[1] ?? false
      const ci = ins[2] ?? false
      const sum = (a !== b) !== ci
      const cout = (a && b) || (ci && (a !== b))
      return [sum, cout]
    }
    case 'ENC42': {
      // 4:2 priority encoder: highest set input wins; V flags "any input active".
      const i0 = ins[0] ?? false
      const i1 = ins[1] ?? false
      const i2 = ins[2] ?? false
      const i3 = ins[3] ?? false
      const idx = i3 ? 3 : i2 ? 2 : i1 ? 1 : 0
      const valid = i0 || i1 || i2 || i3
      return [valid && (idx & 1) === 1, valid && (idx & 2) === 2, valid]
    }
    default:
      return []
  }
}
