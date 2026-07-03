// GMW — secret-sharing secure computation, the other paradigm.
//
// Where garbled circuits (`garble.ts`) encrypt whole gate truth tables and the
// evaluator walks them once, the **Goldreich–Micali–Wigderson** protocol keeps
// every wire value XOR-shared between the two parties and processes gates one at
// a time on the shares. XOR and NOT gates are purely *local* (no interaction); an
// AND gate needs exactly one **oblivious transfer** to combine the parties'
// shares. Same boolean circuits (`circuit.ts`), a completely different mechanism
// — so the lab now shows both MPC families side by side, and both must agree.
//
// This is the semi-honest two-party GMW. An AND of shared bits x = xA⊕xB and
// y = yA⊕yB expands to (xA⊕xB)∧(yA⊕yB); Bob draws his output share r and offers,
// by 1-of-4 OT, the four values r ⊕ ((xA⊕xB)∧(yA⊕yB)) indexed by Alice's (xA,yA).
// Alice selects her row, so cA ⊕ cB = x∧y while neither share leaks a value.

import type { Circuit } from './circuit'
import { evalPlain } from './circuit'
import { otOneOfN } from './ot'
import { randomBytes } from './rng'

const randBit = (): number => randomBytes(1)[0] & 1

export interface GmwTranscript {
  andGates: number // one 1-of-4 OT each (the only interaction)
  xorGates: number // local, free
  invGates: number // local, free
  otInstances: number // total oblivious transfers run (one per AND gate)
}

export interface GmwResult {
  outputBits: number[]
  transcript: GmwTranscript
  plainBits: number[]
  agrees: boolean
}

/**
 * Evaluate `circuit` with Alice holding `aliceBits` and Bob holding `bobBits`,
 * under 2-party GMW. Every wire carries XOR shares [sA, sB]; the output is
 * reconstructed as sA ⊕ sB. AND gates are resolved by a 1-of-4 OT (`otOneOfN`).
 */
export function gmwCompute(circuit: Circuit, aliceBits: number[], bobBits: number[]): GmwResult {
  const sA = new Array<number>(circuit.numWires).fill(0)
  const sB = new Array<number>(circuit.numWires).fill(0)

  // Input sharing: each party's bit is split so the other's share is uniform.
  circuit.aliceInputs.forEach((w, i) => {
    const r = randBit()
    sA[w] = (aliceBits[i] & 1) ^ r
    sB[w] = r
  })
  circuit.bobInputs.forEach((w, i) => {
    const r = randBit()
    sA[w] = r
    sB[w] = (bobBits[i] & 1) ^ r
  })

  let andGates = 0
  let xor = 0
  let inv = 0
  for (const g of circuit.gates) {
    if (g.type === 'XOR') {
      sA[g.out] = sA[g.a] ^ sA[g.b]
      sB[g.out] = sB[g.a] ^ sB[g.b]
      xor++
    } else if (g.type === 'INV') {
      // NOT of a shared bit: flip exactly one party's share.
      sA[g.out] = sA[g.a] ^ 1
      sB[g.out] = sB[g.a]
      inv++
    } else {
      // AND via a 1-of-4 OT. Bob picks his output share r and tabulates
      // r ⊕ ((xA⊕xB) ∧ (yA⊕yB)) for all four of Alice's (xA, yA); Alice selects.
      const r = randBit()
      const xB = sB[g.a]
      const yB = sB[g.b]
      const msgs = [0, 1, 2, 3].map((i) => {
        const xa = (i >> 1) & 1
        const ya = i & 1
        return new Uint8Array([r ^ ((xa ^ xB) & (ya ^ yB))])
      })
      const choice = (sA[g.a] << 1) | sA[g.b]
      sA[g.out] = otOneOfN(msgs, choice).received[0] & 1
      sB[g.out] = r
      andGates++
    }
  }

  const outputBits = circuit.outputs.map((w) => sA[w] ^ sB[w])
  const plainBits = evalPlain(circuit, aliceBits, bobBits)
  const agrees = outputBits.length === plainBits.length && outputBits.every((b, i) => b === plainBits[i])
  return {
    outputBits,
    transcript: { andGates, xorGates: xor, invGates: inv, otInstances: andGates },
    plainBits,
    agrees,
  }
}
