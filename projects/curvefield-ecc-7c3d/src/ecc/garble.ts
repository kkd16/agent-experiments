// Yao's Garbled Circuits — computing on encrypted wires.
//
// The garbler assigns every wire two random 128-bit labels (one per truth value)
// and replaces each gate by a small encrypted table that maps input labels to the
// right output label *without revealing which truth values they stand for*. The
// evaluator, holding one label per input wire, walks the tables and learns one
// label per output wire — then a public decoding turns those into output bits.
// It never learns any intermediate value.
//
// Two optimizations from the literature make this cheap:
//   • free-XOR (Kolesnikov–Schneider '08): a single global offset Δ (lsb=1) ties
//     each wire's two labels as W¹ = W⁰ ⊕ Δ, so XOR and NOT gates need *no*
//     ciphertext — the output label is just an XOR of input labels.
//   • half-gates (Zahur–Rosulek–Evans '15): an AND gate costs exactly two
//     ciphertexts, the proven minimum for a garbling scheme.
// Point-and-permute (the label's low bit is a random "color") tells the evaluator
// which table row to use without leaking the value.

import { sha256 } from './sha256'
import { randomBytes } from './rng'
import type { Circuit } from './circuit'

export const LABEL_BYTES = 16 // 128-bit wire labels
export type Label = Uint8Array

export function xorLabels(a: Label, b: Label): Label {
  const out = new Uint8Array(LABEL_BYTES)
  for (let i = 0; i < LABEL_BYTES; i++) out[i] = a[i] ^ b[i]
  return out
}

/** The "color" / select bit used by point-and-permute: the label's low bit. */
export function color(l: Label): number {
  return l[LABEL_BYTES - 1] & 1
}

/** Tweakable hash H(label, tweak) → 128 bits, from the lab's own SHA-256. */
function H(l: Label, tweak: number): Label {
  const inp = new Uint8Array(LABEL_BYTES + 4)
  inp.set(l, 0)
  inp[LABEL_BYTES] = (tweak >>> 24) & 0xff
  inp[LABEL_BYTES + 1] = (tweak >>> 16) & 0xff
  inp[LABEL_BYTES + 2] = (tweak >>> 8) & 0xff
  inp[LABEL_BYTES + 3] = tweak & 0xff
  return sha256(inp).subarray(0, LABEL_BYTES)
}

function randomLabel(): Label {
  return randomBytes(LABEL_BYTES)
}

/** A garbled AND gate: its two half-gate ciphertexts (each a 128-bit label). */
export type AndTable = [Label, Label]

export interface GarbledCircuit {
  delta: Label // the free-XOR offset Δ (secret to the garbler)
  zero: Label[] // per-wire 0-label (secret to the garbler)
  tables: (AndTable | null)[] // one entry per gate, aligned to circuit.gates; null for free gates
  decoding: number[] // per output wire: the color of its 0-label
}

/** Garble a circuit: pick Δ, random input 0-labels, and derive every gate. */
export function garbleCircuit(circuit: Circuit): GarbledCircuit {
  // Δ with low bit forced to 1 so that lsb(W⁰) ⊕ lsb(W¹) = 1 (point-and-permute).
  const delta = randomLabel()
  delta[LABEL_BYTES - 1] |= 1

  const zero: Label[] = new Array(circuit.numWires)
  for (const w of circuit.aliceInputs) zero[w] = randomLabel()
  for (const w of circuit.bobInputs) zero[w] = randomLabel()

  const tables: (AndTable | null)[] = new Array(circuit.gates.length).fill(null)

  circuit.gates.forEach((g, i) => {
    if (g.type === 'XOR') {
      zero[g.out] = xorLabels(zero[g.a], zero[g.b]) // free-XOR
    } else if (g.type === 'INV') {
      // NOT is free too: flipping the 0-label's role. Eval passes the label through.
      zero[g.out] = xorLabels(zero[g.a], delta)
    } else {
      // half-gate AND (ZRE'15)
      const a0 = zero[g.a]
      const b0 = zero[g.b]
      const a1 = xorLabels(a0, delta)
      const b1 = xorLabels(b0, delta)
      const pa = color(a0)
      const pb = color(b0)
      const jG = 2 * i
      const jE = 2 * i + 1

      const Ha0 = H(a0, jG)
      const Ha1 = H(a1, jG)
      // TG = H(a0) ⊕ H(a1) ⊕ pb·Δ
      const TG = pb ? xorLabels(xorLabels(Ha0, Ha1), delta) : xorLabels(Ha0, Ha1)
      // WG0 = H(a0) ⊕ pa·TG
      const WG0 = pa ? xorLabels(Ha0, TG) : Ha0

      const Hb0 = H(b0, jE)
      const Hb1 = H(b1, jE)
      // TE = H(b0) ⊕ H(b1) ⊕ a0
      const TE = xorLabels(xorLabels(Hb0, Hb1), a0)
      // WE0 = H(b0) ⊕ pb·(TE ⊕ a0)
      const WE0 = pb ? xorLabels(Hb0, xorLabels(TE, a0)) : Hb0

      zero[g.out] = xorLabels(WG0, WE0)
      tables[i] = [TG, TE]
    }
  })

  const decoding = circuit.outputs.map((w) => color(zero[w]))
  return { delta, zero, tables, decoding }
}

/** The active label a party should present for `wire` carrying truth value `bit`. */
export function inputLabel(gc: GarbledCircuit, wire: number, bit: number): Label {
  return bit ? xorLabels(gc.zero[wire], gc.delta) : gc.zero[wire].slice()
}

/** The two labels of a wire (used as the two OT messages for an evaluator input). */
export function labelPair(gc: GarbledCircuit, wire: number): [Label, Label] {
  return [gc.zero[wire].slice(), xorLabels(gc.zero[wire], gc.delta)]
}

/** What the evaluator receives: gate tables + output decoding (circuit is public). */
export interface GarbledTables {
  tables: (AndTable | null)[]
  decoding: number[]
}

export function publicTables(gc: GarbledCircuit): GarbledTables {
  return { tables: gc.tables, decoding: gc.decoding }
}

/**
 * Evaluate a garbled circuit. `activeInputs[wire]` holds the one label the
 * evaluator has for each input wire; the function returns the output *labels*
 * plus their decoded bits.
 */
export function evaluateCircuit(
  circuit: Circuit,
  gt: GarbledTables,
  activeInputs: Label[],
): { bits: number[]; outLabels: Label[] } {
  const active: Label[] = new Array(circuit.numWires)
  for (const w of circuit.aliceInputs) active[w] = activeInputs[w]
  for (const w of circuit.bobInputs) active[w] = activeInputs[w]

  circuit.gates.forEach((g, i) => {
    if (g.type === 'XOR') {
      active[g.out] = xorLabels(active[g.a], active[g.b])
    } else if (g.type === 'INV') {
      active[g.out] = active[g.a] // NOT carries the label through; decoding flips it
    } else {
      const A = active[g.a]
      const B = active[g.b]
      const [TG, TE] = gt.tables[i] as AndTable
      const sa = color(A)
      const sb = color(B)
      // WG = H(A) ⊕ sa·TG
      const WG = sa ? xorLabels(H(A, 2 * i), TG) : H(A, 2 * i)
      // WE = H(B) ⊕ sb·(TE ⊕ A)
      const WE = sb ? xorLabels(H(B, 2 * i + 1), xorLabels(TE, A)) : H(B, 2 * i + 1)
      active[g.out] = xorLabels(WG, WE)
    }
  })

  const outLabels = circuit.outputs.map((w) => active[w])
  const bits = circuit.outputs.map((w, k) => color(active[w]) ^ gt.decoding[k])
  return { bits, outLabels }
}

/** Total bytes an evaluator must download for the garbled tables. */
export function tablesByteSize(gt: GarbledTables): number {
  let n = 0
  for (const t of gt.tables) if (t) n += 2 * LABEL_BYTES
  return n
}
