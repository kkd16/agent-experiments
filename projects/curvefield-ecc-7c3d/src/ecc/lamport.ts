// Lamport one-time signatures (Lamport 1979) — the pencil-and-paper root of the
// whole hash-based family, the signing analogue of drawing chord-and-tangent
// addition by hand before touching 256-bit arithmetic.
//
// The idea is disarmingly simple. To sign a b-bit digest, keep 2·b random secret
// strings arranged as two rows sk[0][·], sk[1][·]; publish their hashes as the
// public key. To sign a message, hash it to b bits and, for each bit position i,
// *reveal* the secret from the row selected by that bit. A verifier hashes each
// revealed string and checks it matches the published pk entry in the right row.
//
// It signs exactly ONCE. A second signature under the same key reveals secrets
// from both rows at some positions, and anyone can then mix-and-match revealed
// strings to forge a signature on many other digests — demonstrated below. WOTS+
// (see wots.ts) is the Winternitz optimisation that shrinks these 2·b strings
// into a handful of hash chains; XMSS then makes the one-time key reusable.

import { sha256 } from './sha256'
import { randomBytes } from './rng'
import { N } from './hashaddr'

/** Digest width in bits — one Lamport column per bit. SHA-256 ⇒ 256. */
const BITS = N * 8

export interface LamportKey {
  /** sk[bit][i] — 2 × BITS secret preimages of N bytes each. */
  sk: [Uint8Array[], Uint8Array[]]
  /** pk[bit][i] = SHA256(sk[bit][i]). */
  pk: [Uint8Array[], Uint8Array[]]
}

/** A Lamport signature: one revealed preimage per digest bit. */
export type LamportSig = Uint8Array[]

/** i-th bit (MSB-first within each byte) of a digest. */
export function bitAt(digest: Uint8Array, i: number): number {
  return (digest[i >> 3] >> (7 - (i & 7))) & 1
}

export function keygen(): LamportKey {
  const sk0: Uint8Array[] = [],
    sk1: Uint8Array[] = [],
    pk0: Uint8Array[] = [],
    pk1: Uint8Array[] = []
  for (let i = 0; i < BITS; i++) {
    const a = randomBytes(N)
    const b = randomBytes(N)
    sk0.push(a)
    sk1.push(b)
    pk0.push(sha256(a))
    pk1.push(sha256(b))
  }
  return { sk: [sk0, sk1], pk: [pk0, pk1] }
}

/** Sign a message (hashed to BITS bits) by revealing the selected preimages. */
export function sign(key: LamportKey, msg: Uint8Array): LamportSig {
  const d = sha256(msg)
  const sig: LamportSig = []
  for (let i = 0; i < BITS; i++) sig.push(key.sk[bitAt(d, i)][i])
  return sig
}

/** Verify by hashing each revealed preimage against the public key. */
export function verify(pk: LamportKey['pk'], msg: Uint8Array, sig: LamportSig): boolean {
  if (sig.length !== BITS) return false
  const d = sha256(msg)
  for (let i = 0; i < BITS; i++) {
    const b = bitAt(d, i)
    const h = sha256(sig[i])
    const want = pk[b][i]
    if (h.length !== want.length) return false
    let eq = 0
    for (let j = 0; j < h.length; j++) eq |= h[j] ^ want[j]
    if (eq !== 0) return false
  }
  return true
}

// ── the one-time property, shown to bite ─────────────────────────────────────
//
// A "forger" that has watched some signatures knows sk[b][i] for whichever
// (b, i) pairs were ever revealed. It can then forge a signature on any target
// digest whose every bit selects an already-revealed secret. Two signatures on
// well-chosen messages reveal roughly ¾ of all 2·BITS secrets, so a large space
// of third messages becomes forgeable — the reason a Lamport key is burned after
// one use.

export interface Forger {
  /** known[b][i] — a revealed preimage, or null if never seen. */
  known: [(Uint8Array | null)[], (Uint8Array | null)[]]
}

export function newForger(): Forger {
  const mk = () => Array.from({ length: BITS }, () => null as Uint8Array | null)
  return { known: [mk(), mk()] }
}

/** Absorb an observed (message, signature) pair into the forger's knowledge. */
export function observe(f: Forger, msg: Uint8Array, sig: LamportSig): void {
  const d = sha256(msg)
  for (let i = 0; i < BITS; i++) f.known[bitAt(d, i)][i] = sig[i]
}

/** How many of the 2·BITS secrets the forger has recovered. */
export function leaked(f: Forger): number {
  let c = 0
  for (let b = 0; b < 2; b++) for (let i = 0; i < BITS; i++) if (f.known[b][i]) c++
  return c
}

/** Forge a signature on `msg` from observed secrets, or null if a bit is missing. */
export function forge(f: Forger, msg: Uint8Array): LamportSig | null {
  const d = sha256(msg)
  const sig: LamportSig = []
  for (let i = 0; i < BITS; i++) {
    const s = f.known[bitAt(d, i)][i]
    if (!s) return null
    sig.push(s)
  }
  return sig
}

/** Byte sizes of a Lamport key/signature at this parameterisation. */
export const sizes = {
  secretKey: 2 * BITS * N,
  publicKey: 2 * BITS * N,
  signature: BITS * N,
  bits: BITS,
}
