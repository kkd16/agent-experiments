// MuSig2 — multiple signers, one signature, one aggregate public key.
//
// Schnorr signatures are *linear* in the secret key, and that is the whole
// trick: a sum of keys signs with a sum of signatures. MuSig2 (Nick–Ruffing–
// Seurin, the scheme behind BIP-327 and Bitcoin Taproot multisig) turns that
// linearity into a real protocol — n parties jointly produce a single 64-byte
// BIP-340 signature under a single aggregate key, with no trusted dealer and
// only two communication rounds. The naive "just add the keys" version is
// broken by the rogue-key attack; MuSig defeats it by weighting each key with a
// coefficient aᵢ = H(L, Pᵢ) that nobody can choose their key to cancel.
//
// Everything below verifies under the same unmodified schnorrVerify() the
// single-signer lab uses — the verifier cannot tell one signer from twenty.

import { secp256k1, G, N, taggedHash, liftXEven } from './secp256k1'
import { type Point } from './curve'
import { mod } from './field'
import { concat, bigToBytes, bytesToBig } from './sha256'

const ser = (Q: Point): Uint8Array => {
  // 33-byte compressed encoding, used when hashing keys into L / coefficients.
  if (Q === null) return new Uint8Array(33)
  const out = new Uint8Array(33)
  out[0] = Q.y % 2n === 0n ? 0x02 : 0x03
  out.set(bigToBytes(Q.x, 32), 1)
  return out
}

export interface KeyAgg {
  X: Point // the aggregate point (may have odd y)
  xonly: bigint // its x-coordinate — the BIP-340 public key
  coeffs: bigint[] // aᵢ for each input key, in input order
}

/** Aggregate a list of public keys into one MuSig key. The coefficients aᵢ =
 *  H(L, Pᵢ) bind every key to the whole set, neutering rogue-key attacks. */
export function keyAggregate(pubs: Point[]): KeyAgg {
  // L commits to all keys at once (order-independent in BIP-327 via sorting;
  // here we hash them in the given order, which all signers agree on).
  const L = taggedHash('KeyAgg list', concat(...pubs.map(ser)))
  const coeffs = pubs.map((P) => mod(bytesToBig(taggedHash('KeyAgg coefficient', concat(L, ser(P)))), N))
  let X: Point = null
  pubs.forEach((P, i) => {
    X = secp256k1.add(X, secp256k1.multiply(coeffs[i], P))
  })
  if (X === null) throw new Error('aggregate key is the identity')
  return { X, xonly: (X as { x: bigint }).x, coeffs }
}

export interface Signer {
  d: bigint // private scalar
  P: Point // public key d·G
}

export function makeSigner(d: bigint): Signer {
  const P = secp256k1.multiply(d, G)
  if (P === null) throw new Error('invalid private key')
  return { d, P }
}

// Deterministic two-nonce derivation per signer (round-trippable for the demo).
// In a real run these are fresh random scalars; determinism here only makes the
// visualization reproducible. Never reuse nonces across messages in practice.
function deriveNonces(d: bigint, msg: Uint8Array, idx: number): [bigint, bigint] {
  const tag = (round: number) =>
    mod(
      bytesToBig(
        taggedHash(
          'MuSig/demononce',
          concat(bigToBytes(d, 32), msg, new Uint8Array([idx, round])),
        ),
      ),
      N,
    ) || 1n
  return [tag(1), tag(2)]
}

export interface MuSigResult {
  keyagg: KeyAgg
  signers: Signer[]
  R1: Point
  R2: Point
  b: bigint // nonce coefficient
  R: Point // effective nonce R1 + b·R2 (after parity fix, this is the even-y point)
  Rx: bigint
  e: bigint // challenge
  partials: bigint[] // sᵢ from each signer
  s: bigint // Σ sᵢ
  sig: Uint8Array // 64-byte BIP-340 signature (Rx ‖ s)
  gx: bigint // +1/−1 parity fix applied to the aggregate key
  gr: bigint // +1/−1 parity fix applied to the aggregate nonce
}

/** Run the full MuSig2 signing protocol across all signers and produce one
 *  aggregate BIP-340 signature. Returns every intermediate so the UI can show
 *  the protocol unfold. */
export function musigSign(secrets: bigint[], msg: Uint8Array): MuSigResult {
  const signers = secrets.map(makeSigner)
  const keyagg = keyAggregate(signers.map((s) => s.P))
  const Xx = keyagg.xonly

  // Round 1: each signer publishes two nonce points; aggregate them.
  const nonces = signers.map((s, i) => deriveNonces(s.d, msg, i))
  let R1: Point = null
  let R2: Point = null
  nonces.forEach(([k1, k2]) => {
    R1 = secp256k1.add(R1, secp256k1.multiply(k1, G))
    R2 = secp256k1.add(R2, secp256k1.multiply(k2, G))
  })

  // Nonce coefficient b binds the two aggregate nonces to the key and message,
  // which is what makes two rounds (instead of three) safe.
  const b = mod(
    bytesToBig(
      taggedHash('MuSig/noncecoef', concat(bigToBytes(Xx, 32), ser(R1), ser(R2), msg)),
    ),
    N,
  )

  // Effective nonce R = R1 + b·R2. Fix its parity to even for BIP-340.
  const Rraw = secp256k1.add(R1, secp256k1.multiply(b, R2))
  if (Rraw === null) throw new Error('aggregate nonce is the identity')
  const gr = Rraw.y % 2n === 0n ? 1n : N - 1n
  const R = gr === 1n ? Rraw : secp256k1.negate(Rraw)
  const Rx = (R as { x: bigint }).x

  // Parity fix for the aggregate key.
  const gx = (keyagg.X as { y: bigint }).y % 2n === 0n ? 1n : N - 1n

  // Challenge e = H(Rx ‖ Xx ‖ m).
  const e = mod(
    bytesToBig(taggedHash('BIP0340/challenge', concat(bigToBytes(Rx, 32), bigToBytes(Xx, 32), msg))),
    N,
  )

  // Round 2: each signer's partial signature.
  const partials = signers.map((s, i) => {
    const [k1, k2] = nonces[i]
    const nonceTerm = mod(gr * mod(k1 + b * k2, N), N)
    const keyTerm = mod(e * gx * keyagg.coeffs[i] % N * s.d, N)
    return mod(nonceTerm + keyTerm, N)
  })
  const s = partials.reduce((acc, si) => mod(acc + si, N), 0n)

  const sig = concat(bigToBytes(Rx, 32), bigToBytes(s, 32))
  return { keyagg, signers, R1, R2, b, R, Rx, e, partials, s, sig, gx, gr }
}

/** Verify a single signer's partial signature in isolation — the check an
 *  honest coordinator runs so one malicious party cannot spoil the aggregate
 *  without being identified. sᵢ·G must equal Rᵢ,eff + e·gx·aᵢ·Pᵢ. */
export function verifyPartial(
  res: MuSigResult,
  i: number,
  msg: Uint8Array,
): boolean {
  const signer = res.signers[i]
  // Reconstruct this signer's effective nonce point Rᵢ = (k₁ + b·k₂)·G.
  const [k1, k2] = deriveNonces(signer.d, msg, i)
  const Ri = secp256k1.multiply(mod(k1 + res.b * k2, N), G)
  const RiEff = res.gr === 1n ? Ri : secp256k1.negate(Ri)
  const lhs = secp256k1.multiply(res.partials[i], G)
  const rhs = secp256k1.add(
    RiEff,
    secp256k1.multiply(mod(res.e * res.gx % N * res.keyagg.coeffs[i], N), signer.P),
  )
  const eq = (A: Point, B: Point) =>
    (A === null && B === null) || (A !== null && B !== null && A.x === B.x && A.y === B.y)
  return eq(lhs, rhs)
}

export { liftXEven }
