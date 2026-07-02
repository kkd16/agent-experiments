// The tweakable-hash substrate shared by every hash-based signature in the lab
// (Lamport, WOTS+, XMSS, SPHINCS+). It is the RFC 8391 §2.5 / §5.1 construction,
// realised on the lab's own from-scratch SHA-256 — so the *only* cryptographic
// assumption a signature here makes is the collision/pre-image resistance of
// that hash, exactly the assumption the STARK already rests on. Nothing depends
// on discrete-log or a pairing; these schemes are plausibly post-quantum.
//
// Two ideas do all the work:
//   1. an ADRS ("address") — a 32-byte structured counter that domain-separates
//      every hash call in a tree so the same key material is never hashed the
//      same way twice, and
//   2. keyed, prefixed hashes F/H/H_msg/PRF — SHA256(toByte(type,32) ‖ KEY ‖ M)
//      — which turn one fixed hash into a family of independent "tweaked" hashes.

import { sha256, concat } from './sha256'

/** n — the security parameter in bytes. SHA-256 ⇒ 32. */
export const N = 32

/** RFC 8391 toByte(x, y): the y-byte big-endian encoding of a non-negative x. */
export function toByte(x: number | bigint, y: number): Uint8Array {
  const out = new Uint8Array(y)
  let v = BigInt(x)
  for (let i = y - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

// ── ADRS: the 32-byte hash-function address (RFC 8391 §2.5) ─────────────────
//
// Eight big-endian 32-bit words. The first four are common to all three address
// types; the last four are type-specific:
//
//   word 0    : layer address        (which hypertree layer)
//   words 1-2 : tree address         (64-bit: which tree within the layer)
//   word 3    : type                 (0 = OTS, 1 = L-tree, 2 = hash tree)
//   word 4    : OTS / L-tree address, or padding(0) for a hash tree
//   word 5    : chain address, or tree height
//   word 6    : hash address,  or tree index
//   word 7    : keyAndMask            (0 = key, 1/2 = bitmask selector)

export const ADRS_OTS = 0
export const ADRS_LTREE = 1
export const ADRS_TREE = 2
// SPHINCS+ (FIPS 205) extends the family with FORS addresses.
export const ADRS_FORS_TREE = 3
export const ADRS_FORS_ROOTS = 4

/** A mutable RFC 8391 address. Copy with `clone` before mutating a shared one. */
export class Adrs {
  readonly w = new Uint32Array(8)

  clone(): Adrs {
    const a = new Adrs()
    a.w.set(this.w)
    return a
  }

  setLayer(l: number): this {
    this.w[0] = l >>> 0
    return this
  }

  /** The 64-bit tree address, split across words 1 (high) and 2 (low). */
  setTree(t: number | bigint): this {
    const v = BigInt(t)
    this.w[1] = Number((v >> 32n) & 0xffffffffn) >>> 0
    this.w[2] = Number(v & 0xffffffffn) >>> 0
    return this
  }

  setType(t: number): this {
    this.w[3] = t >>> 0
    // RFC 8391: setting the type zeroes the subsequent type-specific words.
    this.w[4] = 0
    this.w[5] = 0
    this.w[6] = 0
    this.w[7] = 0
    return this
  }

  // type 0 (OTS hash address)
  setOts(i: number): this {
    this.w[4] = i >>> 0
    return this
  }
  setChain(i: number): this {
    this.w[5] = i >>> 0
    return this
  }
  setHash(i: number): this {
    this.w[6] = i >>> 0
    return this
  }

  // type 1 (L-tree address)
  setLtree(i: number): this {
    this.w[4] = i >>> 0
    return this
  }

  // types 3 & 4 (FORS): the key-pair address — which bottom-tree leaf this FORS
  // instance is bound to — shares word 4 with the OTS / L-tree address slot.
  setKeyPair(i: number): this {
    this.w[4] = i >>> 0
    return this
  }

  // types 1 & 2 share the tree-height / tree-index pair
  setTreeHeight(h: number): this {
    this.w[5] = h >>> 0
    return this
  }
  setTreeIndex(i: number): this {
    this.w[6] = i >>> 0
    return this
  }

  setKeyAndMask(k: number): this {
    this.w[7] = k >>> 0
    return this
  }

  /** The 32 big-endian bytes hashed into every keyed call. */
  toBytes(): Uint8Array {
    const out = new Uint8Array(32)
    const dv = new DataView(out.buffer)
    for (let i = 0; i < 8; i++) dv.setUint32(i * 4, this.w[i], false)
    return out
  }
}

// ── the tweakable hash family (RFC 8391 §5.1, XMSS-SHA2, n = 32) ────────────
//
// Each is SHA256 over a distinct one-word type prefix, a key, and the message,
// so F/H/H_msg/PRF behave as four independent random functions built from one.

/** F(KEY, M): the single-block hash, M is n bytes. Used to walk a WOTS+ chain. */
export function F(key: Uint8Array, m: Uint8Array): Uint8Array {
  return sha256(concat(toByte(0, N), key, m))
}

/** H(KEY, M): the two-block hash, M is 2n bytes. The Merkle/L-tree node hash. */
export function H(key: Uint8Array, m: Uint8Array): Uint8Array {
  return sha256(concat(toByte(1, N), key, m))
}

/** H_msg(KEY, M): the randomized message digest. KEY is 3n bytes (r ‖ root ‖ idx). */
export function Hmsg(key: Uint8Array, m: Uint8Array): Uint8Array {
  return sha256(concat(toByte(2, N), key, m))
}

/** PRF(KEY, M): a pseudorandom function keyed by an n-byte seed over a 32-byte M. */
export function PRF(key: Uint8Array, m: Uint8Array): Uint8Array {
  return sha256(concat(toByte(3, N), key, m))
}

/** PRF_keygen: expand a per-chain WOTS+ secret from SK_SEED at an address. */
export function prfKeygen(skSeed: Uint8Array, adrs: Adrs): Uint8Array {
  return PRF(skSeed, adrs.toBytes())
}

/**
 * T_ℓ (SPHINCS+ / FIPS 205 §4.1): the tweakable hash that compresses ℓ n-byte
 * inputs into one. A key and one bitmask per input are drawn from SEED at the
 * address; the masked concatenation is hashed. Used to fold the k FORS roots
 * into a single FORS public key.
 */
export function thash(inputs: Uint8Array[], seed: Uint8Array, adrs: Adrs): Uint8Array {
  adrs.setKeyAndMask(0)
  const key = PRF(seed, adrs.toBytes())
  const buf = new Uint8Array(inputs.length * N)
  for (let i = 0; i < inputs.length; i++) {
    adrs.setKeyAndMask(1 + i)
    const bm = PRF(seed, adrs.toBytes())
    for (let j = 0; j < N; j++) buf[i * N + j] = inputs[i][j] ^ bm[j]
  }
  return sha256(concat(toByte(1, N), key, buf))
}

/**
 * RAND_HASH(LEFT, RIGHT, SEED, ADRS) (RFC 8391 §4.1.4): the bitmasked node hash
 * used by both the L-tree and the Merkle tree. A key and two bitmasks are drawn
 * from SEED at the current address, and H is applied to the masked concatenation.
 * The masks are what let one fixed H stand in for a family of independent ones.
 */
export function randHash(left: Uint8Array, right: Uint8Array, seed: Uint8Array, adrs: Adrs): Uint8Array {
  adrs.setKeyAndMask(0)
  const key = PRF(seed, adrs.toBytes())
  adrs.setKeyAndMask(1)
  const bm0 = PRF(seed, adrs.toBytes())
  adrs.setKeyAndMask(2)
  const bm1 = PRF(seed, adrs.toBytes())
  const masked = new Uint8Array(2 * N)
  for (let i = 0; i < N; i++) {
    masked[i] = left[i] ^ bm0[i]
    masked[N + i] = right[i] ^ bm1[i]
  }
  return H(key, masked)
}
