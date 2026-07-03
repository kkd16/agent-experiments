// Secure two-party computation, end to end.
//
// This is the whole Yao protocol wired together from this lab's own parts:
//   1. Alice (the garbler) garbles the agreed circuit and sends the encrypted
//      gate tables, the output decoding, and the active labels for *her* input
//      bits (labels leak nothing without Δ).
//   2. For each of Bob's input bits, the two run one **oblivious transfer**
//      (`ot.ts`): Bob fetches the label for his bit without Alice learning the
//      bit, and without Bob learning the other label.
//   3. Bob evaluates the garbled circuit (`garble.ts`) and decodes the outputs.
// Both sides learn only the function's output — never each other's inputs. The
// classic instance is Yao's original **Millionaires' Problem**: two people learn
// who is richer without revealing their wealth.

import {
  garbleCircuit,
  inputLabel,
  labelPair,
  publicTables,
  evaluateCircuit,
  tablesByteSize,
  LABEL_BYTES,
  type Label,
} from './garble'
import {
  batchOtSenderInit,
  batchOtChoose,
  batchOtEncrypt,
  batchOtDecrypt,
} from './ot'
import {
  type Circuit,
  evalPlain,
  fromBits,
  toBits,
  millionairesCircuit,
  equalityCircuit,
  sumCircuit,
  productCircuit,
} from './circuit'
import { edEncode, type EdPoint } from './ed25519'
import { bytesToHex } from './sha256'

/** A record of the protocol run, for display and auditing. */
export interface TwoPcTranscript {
  numAliceInputs: number
  numBobInputs: number
  numOts: number // one OT per Bob input bit
  andGates: number
  xorGates: number
  invGates: number
  tableBytes: number // ciphertext bytes Alice sends Bob
  otBase: string // the shared OT setup point S (hex)
  otRs: string[] // Bob's OT reply points (hex), one per input bit
  outputBits: number[]
}

export interface TwoPcResult {
  outputBits: number[]
  transcript: TwoPcTranscript
  /** Cross-check: the same outputs computed in the clear (both inputs known). */
  plainBits: number[]
  agrees: boolean
}

/**
 * Run the full protocol for `circuit` with Alice holding `aliceBits` and Bob
 * holding `bobBits`. Returns Bob's decoded outputs plus a transcript.
 */
export function secureCompute(circuit: Circuit, aliceBits: number[], bobBits: number[]): TwoPcResult {
  // ── Alice garbles ──
  const gc = garbleCircuit(circuit)
  const gt = publicTables(gc)

  // Alice's own input labels (sent directly).
  const active: Label[] = new Array(circuit.numWires)
  circuit.aliceInputs.forEach((w, i) => (active[w] = inputLabel(gc, w, aliceBits[i] & 1)))

  // ── Oblivious transfer for Bob's input labels ──
  const sender = batchOtSenderInit()
  const pairs: [Label, Label][] = circuit.bobInputs.map((w) => labelPair(gc, w))
  const choices = bobBits.map((b) => (b & 1) as 0 | 1)
  const chooser = batchOtChoose(sender.S, choices)
  const cts = batchOtEncrypt(sender, chooser.Rs, pairs)
  const bobLabels = batchOtDecrypt(sender.S, chooser.Rs, chooser.xs, choices, cts)
  circuit.bobInputs.forEach((w, i) => (active[w] = bobLabels[i]))

  // ── Bob evaluates ──
  const { bits } = evaluateCircuit(circuit, gt, active)

  // gate tallies
  let and = 0
  let xor = 0
  let inv = 0
  for (const g of circuit.gates) {
    if (g.type === 'AND') and++
    else if (g.type === 'XOR') xor++
    else inv++
  }

  const ptHex = (P: EdPoint): string => bytesToHex(edEncode(P))
  const transcript: TwoPcTranscript = {
    numAliceInputs: circuit.aliceInputs.length,
    numBobInputs: circuit.bobInputs.length,
    numOts: circuit.bobInputs.length,
    andGates: and,
    xorGates: xor,
    invGates: inv,
    tableBytes: tablesByteSize(gt),
    otBase: ptHex(sender.S),
    otRs: chooser.Rs.map(ptHex),
    outputBits: bits,
  }

  const plainBits = evalPlain(circuit, aliceBits, bobBits)
  const agrees = bits.length === plainBits.length && bits.every((b, i) => b === plainBits[i])
  return { outputBits: bits, transcript, plainBits, agrees }
}

// ── Named demonstrations ────────────────────────────────────────────────────

export interface MillionairesResult extends TwoPcResult {
  aliceWealth: number
  bobWealth: number
  aliceRicher: boolean
  bits: number
}

/** Yao's Millionaires' Problem: who is richer, revealing nothing else. */
export function runMillionaires(aliceWealth: number, bobWealth: number, bits: number): MillionairesResult {
  const circuit = millionairesCircuit(bits)
  const r = secureCompute(circuit, toBits(aliceWealth, bits), toBits(bobWealth, bits))
  return { ...r, aliceWealth, bobWealth, aliceRicher: r.outputBits[0] === 1, bits }
}

export interface EqualityResult extends TwoPcResult {
  equal: boolean
}

/** Private equality: do the two secret values match? */
export function runEquality(a: number, b: number, bits: number): EqualityResult {
  const circuit = equalityCircuit(bits)
  const r = secureCompute(circuit, toBits(a, bits), toBits(b, bits))
  return { ...r, equal: r.outputBits[0] === 1 }
}

export interface SumResult extends TwoPcResult {
  sum: number
}

/** Private sum: reveal only a + b, not the addends. */
export function runSum(a: number, b: number, bits: number): SumResult {
  const circuit = sumCircuit(bits)
  const r = secureCompute(circuit, toBits(a, bits), toBits(b, bits))
  return { ...r, sum: fromBits(r.outputBits) }
}

export interface ProductResult extends TwoPcResult {
  product: number
}

/** Private product: reveal only a · b. */
export function runProduct(a: number, b: number, bits: number): ProductResult {
  const circuit = productCircuit(bits)
  const r = secureCompute(circuit, toBits(a, bits), toBits(b, bits))
  return { ...r, product: fromBits(r.outputBits) }
}

/** The size, in bytes, of the labels that flow (for the UI's cost readout). */
export const LABEL_SIZE = LABEL_BYTES
