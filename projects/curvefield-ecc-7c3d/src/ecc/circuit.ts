// Boolean circuits — the language a garbled computation is written in.
//
// A circuit is a topologically-ordered list of two-input gates over wires. Only
// three gate kinds are needed and they map perfectly onto the garbling scheme in
// `garble.ts`: XOR and INV (NOT) are *free* (no ciphertext) thanks to free-XOR,
// and AND costs two ciphertexts via half-gates. Everything richer — OR, MUX,
// adders, comparators, multipliers — is compiled down to these here, so the cost
// of a private computation is just its AND count.

export type GateType = 'AND' | 'XOR' | 'INV'

export interface Gate {
  type: GateType
  /** input wire ids (INV uses only a) */
  a: number
  b: number
  /** output wire id */
  out: number
}

export interface Circuit {
  numWires: number
  aliceInputs: number[] // wire ids fed by the garbler (Alice)
  bobInputs: number[] // wire ids fed by the evaluator (Bob)
  gates: Gate[]
  outputs: number[] // wire ids read out
}

/** A tiny builder that hands out fresh wire ids and records gates in order. */
export class CircuitBuilder {
  private next = 0
  private gates: Gate[] = []
  aliceInputs: number[] = []
  bobInputs: number[] = []

  private fresh(): number {
    return this.next++
  }

  aliceInput(): number {
    const w = this.fresh()
    this.aliceInputs.push(w)
    return w
  }

  bobInput(): number {
    const w = this.fresh()
    this.bobInputs.push(w)
    return w
  }

  aliceInputs_(n: number): number[] {
    return Array.from({ length: n }, () => this.aliceInput())
  }

  bobInputs_(n: number): number[] {
    return Array.from({ length: n }, () => this.bobInput())
  }

  xor(a: number, b: number): number {
    const out = this.fresh()
    this.gates.push({ type: 'XOR', a, b, out })
    return out
  }

  and(a: number, b: number): number {
    const out = this.fresh()
    this.gates.push({ type: 'AND', a, b, out })
    return out
  }

  inv(a: number): number {
    const out = this.fresh()
    this.gates.push({ type: 'INV', a, b: a, out })
    return out
  }

  // Derived gates, expanded to the {AND, XOR, INV} basis.
  or(a: number, b: number): number {
    // a ∨ b = ¬(¬a ∧ ¬b)
    return this.inv(this.and(this.inv(a), this.inv(b)))
  }

  xnor(a: number, b: number): number {
    return this.inv(this.xor(a, b))
  }

  /** 1-bit multiplexer: sel ? x : y. */
  mux(sel: number, x: number, y: number): number {
    // y ⊕ (sel ∧ (x ⊕ y))
    return this.xor(y, this.and(sel, this.xor(x, y)))
  }

  build(outputs: number[]): Circuit {
    return {
      numWires: this.next,
      aliceInputs: this.aliceInputs.slice(),
      bobInputs: this.bobInputs.slice(),
      gates: this.gates.slice(),
      outputs: outputs.slice(),
    }
  }

  gateCount(): { and: number; xor: number; inv: number } {
    let and = 0
    let xor = 0
    let inv = 0
    for (const g of this.gates) {
      if (g.type === 'AND') and++
      else if (g.type === 'XOR') xor++
      else inv++
    }
    return { and, xor, inv }
  }
}

// ── Gadgets (little-endian bit vectors, index 0 = least significant) ─────────

/** Full adder: returns { sum, carryOut } for a + b + carryIn. */
export function fullAdder(bld: CircuitBuilder, a: number, b: number, cin: number): { sum: number; cout: number } {
  const axb = bld.xor(a, b)
  const sum = bld.xor(axb, cin)
  // cout = (a∧b) ∨ (cin ∧ (a⊕b))
  const cout = bld.or(bld.and(a, b), bld.and(cin, axb))
  return { sum, cout }
}

/** Ripple-carry adder of two n-bit numbers → (n+1)-bit sum (little-endian). */
export function rippleAdd(bld: CircuitBuilder, a: number[], b: number[]): number[] {
  const n = Math.max(a.length, b.length)
  const zero = bld.and(a[0] ?? b[0], bld.inv(a[0] ?? b[0])) // a wire hardwired to 0
  let carry = zero
  const sum: number[] = []
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? zero
    const bi = b[i] ?? zero
    const fa = fullAdder(bld, ai, bi, carry)
    sum.push(fa.sum)
    carry = fa.cout
  }
  sum.push(carry)
  return sum
}

/** Unsigned greater-than: 1 iff a > b, scanning MSB→LSB with a running equal-prefix. */
export function greaterThan(bld: CircuitBuilder, a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length)
  const zero = bld.and(a[0] ?? b[0], bld.inv(a[0] ?? b[0]))
  const one = bld.inv(zero)
  let gt = zero
  let eqPrefix = one // all higher bits equal so far
  for (let i = n - 1; i >= 0; i--) {
    const ai = a[i] ?? zero
    const bi = b[i] ?? zero
    // this bit decides only while every higher bit was equal
    const thisGt = bld.and(eqPrefix, bld.and(ai, bld.inv(bi)))
    gt = bld.or(gt, thisGt)
    eqPrefix = bld.and(eqPrefix, bld.xnor(ai, bi))
  }
  return gt
}

/** Unsigned equality: 1 iff a == b. */
export function equalTo(bld: CircuitBuilder, a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length)
  const zero = bld.and(a[0] ?? b[0], bld.inv(a[0] ?? b[0]))
  const one = bld.inv(zero)
  let eq = one
  for (let i = 0; i < n; i++) {
    const ai = a[i] ?? zero
    const bi = b[i] ?? zero
    eq = bld.and(eq, bld.xnor(ai, bi))
  }
  return eq
}

/** Schoolbook unsigned multiplier: n-bit × n-bit → 2n-bit product (little-endian). */
export function multiply(bld: CircuitBuilder, a: number[], b: number[]): number[] {
  const n = a.length
  const zero = bld.and(a[0], bld.inv(a[0]))
  // acc holds the running 2n-bit sum
  let acc: number[] = Array.from({ length: 2 * n }, () => zero)
  for (let i = 0; i < n; i++) {
    // partial = (a ∧ b[i]) shifted left by i
    const partial: number[] = Array.from({ length: 2 * n }, () => zero)
    for (let k = 0; k < n; k++) {
      if (i + k < 2 * n) partial[i + k] = bld.and(a[k], b[i])
    }
    acc = rippleAdd(bld, acc, partial).slice(0, 2 * n)
  }
  return acc
}

// ── Named circuits for the demos ────────────────────────────────────────────

/** Millionaires' problem: Alice's n-bit wealth vs Bob's — output 1 iff Alice > Bob. */
export function millionairesCircuit(bits: number): Circuit {
  const bld = new CircuitBuilder()
  const a = bld.aliceInputs_(bits)
  const b = bld.bobInputs_(bits)
  const gt = greaterThan(bld, a, b)
  return bld.build([gt])
}

/** Private equality test: output 1 iff Alice's value == Bob's value. */
export function equalityCircuit(bits: number): Circuit {
  const bld = new CircuitBuilder()
  const a = bld.aliceInputs_(bits)
  const b = bld.bobInputs_(bits)
  return bld.build([equalTo(bld, a, b)])
}

/** Private sum: (n+1)-bit sum of Alice's and Bob's n-bit values (little-endian). */
export function sumCircuit(bits: number): Circuit {
  const bld = new CircuitBuilder()
  const a = bld.aliceInputs_(bits)
  const b = bld.bobInputs_(bits)
  return bld.build(rippleAdd(bld, a, b))
}

/** Private product: 2n-bit product of two n-bit values (little-endian). */
export function productCircuit(bits: number): Circuit {
  const bld = new CircuitBuilder()
  const a = bld.aliceInputs_(bits)
  const b = bld.bobInputs_(bits)
  return bld.build(multiply(bld, a, b))
}

// ── Plaintext reference evaluator (for testing & the UI's "expected" column) ──

export function evalPlain(c: Circuit, aliceBits: number[], bobBits: number[]): number[] {
  const val = new Array<number>(c.numWires).fill(0)
  c.aliceInputs.forEach((w, i) => (val[w] = aliceBits[i] & 1))
  c.bobInputs.forEach((w, i) => (val[w] = bobBits[i] & 1))
  for (const g of c.gates) {
    if (g.type === 'XOR') val[g.out] = val[g.a] ^ val[g.b]
    else if (g.type === 'AND') val[g.out] = val[g.a] & val[g.b]
    else val[g.out] = val[g.a] ^ 1
  }
  return c.outputs.map((w) => val[w])
}

/** Little-endian bit vector ↔ integer helpers (index 0 = LSB). */
export function toBits(n: number, width: number): number[] {
  return Array.from({ length: width }, (_, i) => (n >> i) & 1)
}

export function fromBits(bits: number[]): number {
  let n = 0
  for (let i = bits.length - 1; i >= 0; i--) n = (n << 1) | (bits[i] & 1)
  return n
}
