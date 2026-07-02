// WOTS+ — the Winternitz One-Time Signature Plus (RFC 8391 §3), the workhorse
// under XMSS and SPHINCS+. It is Lamport's idea folded onto itself: instead of
// one revealed secret per bit, keep one hash *chain* of length w per base-w
// digit of the message, and reveal the chain value at the digit's height.
//
// A verifier who knows the message digit d can only walk the chain *forward*
// (F is one-way), never back, so it finishes the revealed value up to the top
// (w-1) and checks it lands on the public key. A forger who wants a larger digit
// would need to walk backward. The catch: a forger can always walk digits it
// doesn't like *upward*. The fix is a length-2 **checksum** appended to the
// message whose digits move in the opposite direction — increasing any message
// digit necessarily decreases a checksum digit, which the forger then cannot
// produce. Everything is bitmasked per RFC 8391 so a single fixed F stands in
// for a family of independent one-way functions across a whole tree.

import { N, F, PRF, prfKeygen, toByte, Adrs, ADRS_OTS } from './hashaddr'

export interface WotsParams {
  w: number
  lgw: number
  /** message digits */
  len1: number
  /** checksum digits */
  len2: number
  /** len1 + len2 chains total */
  len: number
}

/** Derive the RFC 8391 WOTS+ lengths for a Winternitz parameter w (a power of 2). */
export function wotsParams(w: number): WotsParams {
  const lgw = Math.log2(w)
  if (!Number.isInteger(lgw) || lgw < 1 || lgw > 8) {
    throw new Error('WOTS+ w must be a power of two in [2, 256]')
  }
  const len1 = Math.ceil((8 * N) / lgw)
  const len2 = Math.floor(Math.log2(len1 * (w - 1)) / lgw) + 1
  return { w, lgw, len1, len2, len: len1 + len2 }
}

export const WOTS_W16 = wotsParams(16)

/** base_w (RFC 8391 Algorithm 4): X's leading `outLen` base-w digits, MSB-first. */
export function baseW(x: Uint8Array, w: number, outLen: number): number[] {
  const lgw = Math.log2(w)
  const out: number[] = []
  let inPos = 0
  let total = 0
  let bits = 0
  for (let consumed = 0; consumed < outLen; consumed++) {
    if (bits === 0) {
      total = x[inPos++]
      bits = 8
    }
    bits -= lgw
    out.push((total >>> bits) & (w - 1))
  }
  return out
}

/** The full message-plus-checksum digit vector signed by the chains. */
export function chainLengths(msg: Uint8Array, p: WotsParams): number[] {
  const msgW = baseW(msg, p.w, p.len1)
  let csum = 0
  for (let i = 0; i < p.len1; i++) csum += p.w - 1 - msgW[i]
  // Left-align the checksum so base_w reads its high digits first.
  const shift = (8 - ((p.len2 * p.lgw) % 8)) % 8
  csum <<= shift
  const csumBytes = toByte(csum, Math.ceil((p.len2 * p.lgw) / 8))
  return msgW.concat(baseW(csumBytes, p.w, p.len2))
}

/**
 * chain (RFC 8391 Algorithm 5): apply F `steps` times to X, starting at chain
 * height `start`. Each step draws a fresh key + bitmask from `seed` at the
 * current (chain, hash) address, so no two F-calls in the tree share inputs.
 */
export function chain(
  x: Uint8Array,
  start: number,
  steps: number,
  seed: Uint8Array,
  adrs: Adrs,
  w: number,
): Uint8Array {
  let tmp = x
  for (let i = start; i < start + steps && i < w; i++) {
    adrs.setHash(i)
    adrs.setKeyAndMask(0)
    const key = PRF(seed, adrs.toBytes())
    adrs.setKeyAndMask(1)
    const bm = PRF(seed, adrs.toBytes())
    const masked = new Uint8Array(N)
    for (let j = 0; j < N; j++) masked[j] = tmp[j] ^ bm[j]
    tmp = F(key, masked)
  }
  return tmp
}

/** The i-th chain's secret start value, PRF-expanded from the secret seed. */
export function wotsSk(skSeed: Uint8Array, adrs: Adrs, i: number): Uint8Array {
  const a = adrs.clone().setChain(i).setHash(0).setKeyAndMask(0)
  return prfKeygen(skSeed, a)
}

/** The WOTS+ public key: every chain walked to its top (len × n bytes). */
export function wotsPkGen(skSeed: Uint8Array, pubSeed: Uint8Array, adrs: Adrs, p = WOTS_W16): Uint8Array[] {
  const pk: Uint8Array[] = []
  for (let i = 0; i < p.len; i++) {
    const sk = wotsSk(skSeed, adrs, i)
    pk.push(chain(sk, 0, p.w - 1, pubSeed, adrs.clone().setChain(i), p.w))
  }
  return pk
}

/** Sign an n-byte message: reveal each chain at the height of its digit. */
export function wotsSign(
  msg: Uint8Array,
  skSeed: Uint8Array,
  pubSeed: Uint8Array,
  adrs: Adrs,
  p = WOTS_W16,
): Uint8Array[] {
  const digits = chainLengths(msg, p)
  const sig: Uint8Array[] = []
  for (let i = 0; i < p.len; i++) {
    const sk = wotsSk(skSeed, adrs, i)
    sig.push(chain(sk, 0, digits[i], pubSeed, adrs.clone().setChain(i), p.w))
  }
  return sig
}

/** Recover the WOTS+ public key from a signature by finishing every chain. */
export function wotsPkFromSig(
  msg: Uint8Array,
  sig: Uint8Array[],
  pubSeed: Uint8Array,
  adrs: Adrs,
  p = WOTS_W16,
): Uint8Array[] {
  const digits = chainLengths(msg, p)
  const pk: Uint8Array[] = []
  for (let i = 0; i < p.len; i++) {
    pk.push(chain(sig[i], digits[i], p.w - 1 - digits[i], pubSeed, adrs.clone().setChain(i), p.w))
  }
  return pk
}

const eq = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

/** Standalone WOTS+ verify: recover pk from the sig and compare to the real pk. */
export function wotsVerify(
  msg: Uint8Array,
  sig: Uint8Array[],
  pk: Uint8Array[],
  pubSeed: Uint8Array,
  adrs: Adrs,
  p = WOTS_W16,
): boolean {
  if (sig.length !== p.len || pk.length !== p.len) return false
  const got = wotsPkFromSig(msg, sig, pubSeed, adrs, p)
  for (let i = 0; i < p.len; i++) if (!eq(got[i], pk[i])) return false
  return true
}

/** A standalone (seed-generated) WOTS+ keypair for the direct demo/self-test. */
export function wotsKeypair(skSeed: Uint8Array, pubSeed: Uint8Array, p = WOTS_W16) {
  const adrs = new Adrs().setType(ADRS_OTS).setOts(0)
  const pk = wotsPkGen(skSeed, pubSeed, adrs.clone(), p)
  return { adrs, pk }
}

/** Byte sizes at a given w (n-byte chains). Signature = public key = len·n. */
export function wotsSizes(p = WOTS_W16) {
  return { publicKey: p.len * N, signature: p.len * N, secretKey: N, len: p.len }
}
