// A Fiat–Shamir transcript: the coin that turns an interactive proof into a
// non-interactive one. Instead of a live verifier sending random challenges, the
// prover derives them by hashing everything said so far. Because the hash is
// unpredictable and binds to every prior message, the prover cannot choose its
// commitments *after* seeing the challenge — the soundness of the interactive
// protocol carries over (in the random-oracle model).
//
// The same running SHA-256 state is threaded through the STARK's constraint
// coefficients, its out-of-domain point, and every FRI folding challenge and
// query index, so prover and verifier deterministically agree on all of them.

import { sha256, concat, utf8, hexToBytes, bytesToBig, bigToBytes } from './sha256'
import { P } from './goldilocks'

export class Transcript {
  private state: Uint8Array

  constructor(label: string) {
    this.state = sha256(utf8('curvefield/stark/' + label))
  }

  /** Fold arbitrary bytes into the transcript. */
  absorbBytes(b: Uint8Array): void {
    this.state = sha256(concat(this.state, b))
  }

  /** Fold a hex string (e.g. a Merkle root) in. */
  absorbHex(hex: string): void {
    this.absorbBytes(hexToBytes(hex))
  }

  /** Fold a field element in (8 bytes). */
  absorbField(x: bigint): void {
    this.absorbBytes(bigToBytes(((x % P) + P) % P, 8))
  }

  private next(): Uint8Array {
    // Advance the chain: the new state is the SHA-256 of the old one. Each squeeze
    // is a fresh 32-byte block, and future absorbs still bind to this point.
    this.state = sha256(this.state)
    return this.state
  }

  /**
   * A uniform-ish challenge in 𝔽_p. Reducing 256 hash bits mod a 64-bit prime
   * leaves a bias below 2^-192 — cryptographically negligible.
   */
  challengeField(): bigint {
    return bytesToBig(this.next()) % P
  }

  /**
   * A challenge integer in [0, bound). For a power-of-two bound this is exactly
   * uniform (a clean mask of the low bits).
   */
  challengeInt(bound: number): number {
    if (bound <= 0) throw new Error('challengeInt: bound must be positive')
    const raw = bytesToBig(this.next())
    if ((bound & (bound - 1)) === 0) return Number(raw & BigInt(bound - 1))
    return Number(raw % BigInt(bound))
  }
}
