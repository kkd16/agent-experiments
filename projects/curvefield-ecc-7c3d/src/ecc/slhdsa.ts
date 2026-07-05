// SLH-DSA — the standardised stateless hash-based signature (FIPS 205), from scratch.
//
// The lab already carries the *toy* SPHINCS⁺ in `sphincs.ts` (an RFC-8391-flavoured
// construction on the full 32-byte SHA-256 output). This module is the real thing:
// NIST's **SLH-DSA** exactly as standardised in FIPS 205 (August 2024) for the SHA-2,
// category-1 parameter sets — the byte-exact ADRSc address compression, the SHA-256
// tweakable-hash instantiation (§11.2.1), the MGF1 message digest, and the precise
// key/signature packing. It reproduces NIST's own ACVP known-answer vectors
// byte-for-byte (see `KEYGEN_KAT` / `SIGGEN_KAT` and the self-test), just as the lab's
// ML-KEM (FIPS 203) and ML-DSA (FIPS 204) do.
//
// SLH-DSA is the *conservative* post-quantum signature: it retires ECDSA/Ed25519/BLS
// resting on nothing but the collision/pre-image resistance of a hash — the same and
// only assumption the lab's STARK already makes. No lattice, no structured hardness.
//
// The whole scheme is four ideas stacked:
//   • WOTS⁺  — a one-time signature: reveal a hash-chain checkpoint per message digit.
//   • XMSS   — a Merkle tree of 2^h′ WOTS⁺ keys behind one root (auth path to reuse it).
//   • the hypertree (HT) — d layers of XMSS, each signing the next layer's root, so one
//     top root certifies 2^h leaf keys without ever materialising the whole tree.
//   • FORS   — a *few*-time signature; a pseudo-random leaf choice makes the scheme
//     stateless (no counter to lose), and k parallel trees keep forgery negligible.
//
// Everything is computed on the lab's own from-scratch SHA-256 / HMAC-SHA-256.

import { sha256, hmacSha256, concat, bytesToHex, hexToBytes } from './sha256'

// ── parameter sets (FIPS 205 §11, Table 2 — SHA-2, security category 1) ──────

export interface SlhParams {
  name: string
  n: number // security parameter / hash output, in bytes (16 ⇒ 128-bit)
  h: number // total hypertree height
  d: number // number of hypertree layers
  hp: number // height of each XMSS subtree (h′ = h/d)
  a: number // FORS tree height (2^a leaves per tree)
  k: number // number of FORS trees
  lgw: number // log₂ of the Winternitz parameter w
  // derived:
  w: number
  len1: number
  len2: number
  len: number
  m: number // message-digest length in bytes
  pkBytes: number
  skBytes: number
  sigBytes: number
}

function derive(p: Omit<SlhParams, 'w' | 'len1' | 'len2' | 'len' | 'm' | 'pkBytes' | 'skBytes' | 'sigBytes'>): SlhParams {
  const w = 1 << p.lgw
  const len1 = Math.ceil((8 * p.n) / p.lgw)
  const len2 = Math.floor(Math.log2(len1 * (w - 1)) / p.lgw) + 1
  const len = len1 + len2
  const m = Math.ceil((p.k * p.a) / 8) + Math.ceil((p.h - p.hp) / 8) + Math.ceil(p.hp / 8)
  const sigBytes = p.n + p.k * (p.a + 1) * p.n + (p.h + p.d * len) * p.n
  return { ...p, w, len1, len2, len, m, pkBytes: 2 * p.n, skBytes: 4 * p.n, sigBytes }
}

/** SLH-DSA-SHA2-128s — small signatures (7856 B), slow signing. */
export const SLHDSA_128S = derive({ name: 'SLH-DSA-SHA2-128s', n: 16, h: 63, d: 7, hp: 9, a: 12, k: 14, lgw: 4 })
/** SLH-DSA-SHA2-128f — fast signing, larger signatures (17088 B). */
export const SLHDSA_128F = derive({ name: 'SLH-DSA-SHA2-128f', n: 16, h: 66, d: 22, hp: 3, a: 6, k: 33, lgw: 4 })

export const PARAM_SETS: SlhParams[] = [SLHDSA_128F, SLHDSA_128S]

// ── small helpers ────────────────────────────────────────────────────────────

function toByte(x: number | bigint, y: number): Uint8Array {
  const out = new Uint8Array(y)
  let v = BigInt(x)
  for (let i = y - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}
function toInt(b: Uint8Array): bigint {
  let v = 0n
  for (const x of b) v = (v << 8n) | BigInt(x)
  return v
}
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])

/** base_2b (FIPS 205 Alg 4): big-endian, MSB-first extraction of `outLen` b-bit digits. */
export function base2b(X: Uint8Array, b: number, outLen: number): number[] {
  const out = new Array<number>(outLen)
  let inp = 0
  let bits = 0
  let total = 0
  for (let o = 0; o < outLen; o++) {
    while (bits < b) {
      total = (total << 8) | X[inp++]
      bits += 8
    }
    bits -= b
    out[o] = (total >>> bits) & ((1 << b) - 1)
  }
  return out
}

/** MGF1 with SHA-256 (RFC 8017), used only inside H_msg. */
function mgf1(seed: Uint8Array, len: number): Uint8Array {
  const blocks: Uint8Array[] = []
  let total = 0
  let c = 0
  while (total < len) {
    const blk = sha256(concat(seed, toByte(c, 4)))
    blocks.push(blk)
    total += blk.length
    c++
  }
  return concat(...blocks).slice(0, len)
}

// ── ADRS — the 32-byte hash address (FIPS 205 §4.2) ──────────────────────────
//
// Note the FIPS 205 layout differs from RFC 8391 (used by the toy in `hashaddr.ts`):
// a 4-byte layer word, a 12-byte tree word, then a 4-byte type word, then three
// type-specific words. For the SHA-2 hashes the address is *compressed* to 22 bytes.

export const WOTS_HASH = 0
export const WOTS_PK = 1
export const TREE = 2
export const FORS_TREE = 3
export const FORS_ROOTS = 4
export const WOTS_PRF = 5
export const FORS_PRF = 6

export class Adrs {
  readonly a = new Uint8Array(32)
  private dv = new DataView(this.a.buffer)

  clone(): Adrs {
    const x = new Adrs()
    x.a.set(this.a)
    return x
  }
  setLayer(l: number): this {
    this.dv.setUint32(0, l >>> 0, false)
    return this
  }
  setTree(t: number | bigint): this {
    const v = BigInt(t)
    this.dv.setUint32(4, 0, false)
    this.dv.setUint32(8, Number((v >> 32n) & 0xffffffffn) >>> 0, false)
    this.dv.setUint32(12, Number(v & 0xffffffffn) >>> 0, false)
    return this
  }
  setType(y: number): this {
    this.dv.setUint32(16, y >>> 0, false)
    for (let i = 20; i < 32; i++) this.a[i] = 0 // FIPS 205: setting type clears the tail
    return this
  }
  setKeyPair(i: number): this {
    this.dv.setUint32(20, i >>> 0, false)
    return this
  }
  setChain(i: number): this {
    this.dv.setUint32(24, i >>> 0, false)
    return this
  }
  setTreeHeight(i: number): this {
    this.dv.setUint32(24, i >>> 0, false)
    return this
  }
  setHash(i: number): this {
    this.dv.setUint32(28, i >>> 0, false)
    return this
  }
  setTreeIndex(i: number | bigint): this {
    this.dv.setUint32(28, Number(BigInt(i) & 0xffffffffn) >>> 0, false)
    return this
  }
  getTreeIndex(): number {
    return this.dv.getUint32(28, false)
  }
  getKeyPair(): number {
    return this.dv.getUint32(20, false)
  }
  /** ADRSc — the 22-byte compressed address the SHA-2 hashes consume. */
  compressed(): Uint8Array {
    const a = this.a
    return concat(a.slice(3, 4), a.slice(8, 16), a.slice(19, 20), a.slice(20, 32))
  }
}

// ── instrumentation: an optional per-call hash counter for the UI ────────────

export interface Stats {
  F: number
  H: number
  T: number
  PRF: number
  PRFmsg: number
  Hmsg: number
  sha256: number
}
export function newStats(): Stats {
  return { F: 0, H: 0, T: 0, PRF: 0, PRFmsg: 0, Hmsg: 0, sha256: 0 }
}
export function totalHashes(s: Stats): number {
  return s.F + s.H + s.T + s.PRF + s.PRFmsg + s.Hmsg
}

// ── the tweakable hash family (FIPS 205 §11.2.1 — SHA-2, category 1) ──────────

class Tweak {
  readonly p: SlhParams
  readonly s?: Stats
  constructor(p: SlhParams, s?: Stats) {
    this.p = p
    this.s = s
  }
  private pad(pkSeed: Uint8Array): Uint8Array {
    // PK.seed padded to a full 64-byte SHA-256 block with zeros.
    return concat(pkSeed, new Uint8Array(64 - this.p.n))
  }
  private trunc(b: Uint8Array): Uint8Array {
    return b.slice(0, this.p.n)
  }
  F(pkSeed: Uint8Array, adrs: Adrs, m1: Uint8Array): Uint8Array {
    if (this.s) {
      this.s.F++
      this.s.sha256++
    }
    return this.trunc(sha256(concat(this.pad(pkSeed), adrs.compressed(), m1)))
  }
  H(pkSeed: Uint8Array, adrs: Adrs, m2: Uint8Array): Uint8Array {
    if (this.s) {
      this.s.H++
      this.s.sha256++
    }
    return this.trunc(sha256(concat(this.pad(pkSeed), adrs.compressed(), m2)))
  }
  T(pkSeed: Uint8Array, adrs: Adrs, m: Uint8Array): Uint8Array {
    if (this.s) {
      this.s.T++
      this.s.sha256++
    }
    return this.trunc(sha256(concat(this.pad(pkSeed), adrs.compressed(), m)))
  }
  PRF(pkSeed: Uint8Array, skSeed: Uint8Array, adrs: Adrs): Uint8Array {
    if (this.s) {
      this.s.PRF++
      this.s.sha256++
    }
    return this.trunc(sha256(concat(this.pad(pkSeed), adrs.compressed(), skSeed)))
  }
  PRFmsg(skPrf: Uint8Array, optRand: Uint8Array, m: Uint8Array): Uint8Array {
    if (this.s) {
      this.s.PRFmsg++
      this.s.sha256 += 2
    }
    return this.trunc(hmacSha256(skPrf, concat(optRand, m)))
  }
  Hmsg(r: Uint8Array, pkSeed: Uint8Array, pkRoot: Uint8Array, m: Uint8Array): Uint8Array {
    if (this.s) {
      this.s.Hmsg++
      this.s.sha256 += 1 + Math.ceil(this.p.m / 32)
    }
    return mgf1(concat(r, pkSeed, sha256(concat(r, pkSeed, pkRoot, m))), this.p.m)
  }
}

// ── WOTS⁺ (FIPS 205 §5) ──────────────────────────────────────────────────────

function chain(th: Tweak, X: Uint8Array, i: number, s: number, pkSeed: Uint8Array, adrs: Adrs): Uint8Array {
  let tmp = X
  for (let j = i; j < i + s; j++) {
    adrs.setHash(j)
    tmp = th.F(pkSeed, adrs, tmp)
  }
  return tmp
}

/** The len WOTS⁺ message digits: len1 base-w digits of M, then len2 checksum digits. */
export function wotsMsgDigits(p: SlhParams, M: Uint8Array): number[] {
  const msg = base2b(M, p.lgw, p.len1)
  let csum = 0
  for (let i = 0; i < p.len1; i++) csum += p.w - 1 - msg[i]
  csum <<= (8 - ((p.len2 * p.lgw) % 8)) % 8
  const csumBytes = toByte(csum, Math.ceil((p.len2 * p.lgw) / 8))
  return msg.concat(base2b(csumBytes, p.lgw, p.len2))
}

function wotsPkGen(th: Tweak, skSeed: Uint8Array, pkSeed: Uint8Array, adrs: Adrs): Uint8Array {
  const p = th.p
  const skAdrs = adrs.clone().setType(WOTS_PRF).setKeyPair(adrs.getKeyPair())
  const tmp: Uint8Array[] = []
  for (let i = 0; i < p.len; i++) {
    skAdrs.setChain(i).setHash(0)
    const sk = th.PRF(pkSeed, skSeed, skAdrs)
    adrs.setChain(i).setHash(0)
    tmp.push(chain(th, sk, 0, p.w - 1, pkSeed, adrs))
  }
  const wpk = adrs.clone().setType(WOTS_PK).setKeyPair(adrs.getKeyPair())
  return th.T(pkSeed, wpk, concat(...tmp))
}

function wotsSign(th: Tweak, M: Uint8Array, skSeed: Uint8Array, pkSeed: Uint8Array, adrs: Adrs): Uint8Array {
  const p = th.p
  const msg = wotsMsgDigits(p, M)
  const skAdrs = adrs.clone().setType(WOTS_PRF).setKeyPair(adrs.getKeyPair())
  const sig: Uint8Array[] = []
  for (let i = 0; i < p.len; i++) {
    skAdrs.setChain(i).setHash(0)
    const sk = th.PRF(pkSeed, skSeed, skAdrs)
    adrs.setChain(i)
    sig.push(chain(th, sk, 0, msg[i], pkSeed, adrs))
  }
  return concat(...sig)
}

function wotsPkFromSig(th: Tweak, sig: Uint8Array, M: Uint8Array, pkSeed: Uint8Array, adrs: Adrs): Uint8Array {
  const p = th.p
  const msg = wotsMsgDigits(p, M)
  const tmp: Uint8Array[] = []
  for (let i = 0; i < p.len; i++) {
    adrs.setChain(i)
    const si = sig.slice(i * p.n, (i + 1) * p.n)
    tmp.push(chain(th, si, msg[i], p.w - 1 - msg[i], pkSeed, adrs))
  }
  const wpk = adrs.clone().setType(WOTS_PK).setKeyPair(adrs.getKeyPair())
  return th.T(pkSeed, wpk, concat(...tmp))
}

// ── XMSS (FIPS 205 §6) ────────────────────────────────────────────────────────

function xmssNode(th: Tweak, skSeed: Uint8Array, i: number, z: number, pkSeed: Uint8Array, adrs: Adrs): Uint8Array {
  if (z === 0) {
    adrs.setType(WOTS_HASH).setKeyPair(i)
    return wotsPkGen(th, skSeed, pkSeed, adrs)
  }
  const l = xmssNode(th, skSeed, 2 * i, z - 1, pkSeed, adrs)
  const r = xmssNode(th, skSeed, 2 * i + 1, z - 1, pkSeed, adrs)
  adrs.setType(TREE).setTreeHeight(z).setTreeIndex(i)
  return th.H(pkSeed, adrs, concat(l, r))
}

function xmssSign(th: Tweak, M: Uint8Array, skSeed: Uint8Array, idx: number, pkSeed: Uint8Array, adrs: Adrs): Uint8Array {
  const p = th.p
  const auth: Uint8Array[] = []
  for (let j = 0; j < p.hp; j++) {
    const s = (idx >> j) ^ 1
    auth.push(xmssNode(th, skSeed, s, j, pkSeed, adrs))
  }
  adrs.setType(WOTS_HASH).setKeyPair(idx)
  const sig = wotsSign(th, M, skSeed, pkSeed, adrs)
  return concat(sig, ...auth)
}

function xmssPkFromSig(th: Tweak, idx: number, sigXmss: Uint8Array, M: Uint8Array, pkSeed: Uint8Array, adrs: Adrs): Uint8Array {
  const p = th.p
  const wotsSig = sigXmss.slice(0, p.len * p.n)
  adrs.setType(WOTS_HASH).setKeyPair(idx)
  let node = wotsPkFromSig(th, wotsSig, M, pkSeed, adrs)
  adrs.setType(TREE).setTreeIndex(idx)
  for (let k = 0; k < p.hp; k++) {
    const auth = sigXmss.slice((p.len + k) * p.n, (p.len + k + 1) * p.n)
    adrs.setTreeHeight(k + 1)
    if (((idx >> k) & 1) === 0) {
      adrs.setTreeIndex(adrs.getTreeIndex() >>> 1)
      node = th.H(pkSeed, adrs, concat(node, auth))
    } else {
      adrs.setTreeIndex((adrs.getTreeIndex() - 1) >>> 1)
      node = th.H(pkSeed, adrs, concat(auth, node))
    }
  }
  return node
}

// ── the hypertree (FIPS 205 §7) ───────────────────────────────────────────────

function htSign(th: Tweak, M: Uint8Array, skSeed: Uint8Array, pkSeed: Uint8Array, idxTree: bigint, idxLeaf: number): Uint8Array {
  const p = th.p
  const adrs = new Adrs().setLayer(0).setTree(idxTree)
  let sigTmp = xmssSign(th, M, skSeed, idxLeaf, pkSeed, adrs)
  const parts = [sigTmp]
  let root = xmssPkFromSig(th, idxLeaf, sigTmp, M, pkSeed, adrs.clone())
  let it = idxTree
  const mask = (1n << BigInt(p.hp)) - 1n
  for (let j = 1; j < p.d; j++) {
    idxLeaf = Number(it & mask)
    it = it >> BigInt(p.hp)
    adrs.setLayer(j).setTree(it)
    sigTmp = xmssSign(th, root, skSeed, idxLeaf, pkSeed, adrs)
    parts.push(sigTmp)
    if (j < p.d - 1) root = xmssPkFromSig(th, idxLeaf, sigTmp, root, pkSeed, adrs.clone())
  }
  return concat(...parts)
}

function htVerify(th: Tweak, M: Uint8Array, sigHt: Uint8Array, pkSeed: Uint8Array, idxTree: bigint, idxLeaf: number, pkRoot: Uint8Array): boolean {
  const p = th.p
  const adrs = new Adrs().setLayer(0).setTree(idxTree)
  const xmssLen = (p.len + p.hp) * p.n
  let it = idxTree
  const mask = (1n << BigInt(p.hp)) - 1n
  let node = xmssPkFromSig(th, idxLeaf, sigHt.slice(0, xmssLen), M, pkSeed, adrs)
  for (let j = 1; j < p.d; j++) {
    idxLeaf = Number(it & mask)
    it = it >> BigInt(p.hp)
    adrs.setLayer(j).setTree(it)
    const sig = sigHt.slice(j * xmssLen, (j + 1) * xmssLen)
    node = xmssPkFromSig(th, idxLeaf, sig, node, pkSeed, adrs)
  }
  return eq(node, pkRoot)
}

// ── FORS (FIPS 205 §8) ────────────────────────────────────────────────────────

function forsSkGen(th: Tweak, skSeed: Uint8Array, pkSeed: Uint8Array, adrs: Adrs, idx: number): Uint8Array {
  const skAdrs = adrs.clone().setType(FORS_PRF).setKeyPair(adrs.getKeyPair()).setTreeIndex(idx)
  return th.PRF(pkSeed, skSeed, skAdrs)
}

function forsNode(th: Tweak, skSeed: Uint8Array, i: number, z: number, pkSeed: Uint8Array, adrs: Adrs): Uint8Array {
  if (z === 0) {
    const sk = forsSkGen(th, skSeed, pkSeed, adrs, i)
    adrs.setTreeHeight(0).setTreeIndex(i)
    return th.F(pkSeed, adrs, sk)
  }
  const l = forsNode(th, skSeed, 2 * i, z - 1, pkSeed, adrs)
  const r = forsNode(th, skSeed, 2 * i + 1, z - 1, pkSeed, adrs)
  adrs.setTreeHeight(z).setTreeIndex(i)
  return th.H(pkSeed, adrs, concat(l, r))
}

/** The k FORS leaf indices selected by the message digest. */
export function forsIndices(p: SlhParams, md: Uint8Array): number[] {
  return base2b(md, p.a, p.k)
}

function forsSign(th: Tweak, md: Uint8Array, skSeed: Uint8Array, pkSeed: Uint8Array, adrs: Adrs): Uint8Array {
  const p = th.p
  const indices = forsIndices(p, md)
  const out: Uint8Array[] = []
  for (let i = 0; i < p.k; i++) {
    out.push(forsSkGen(th, skSeed, pkSeed, adrs, i * (1 << p.a) + indices[i]))
    for (let j = 0; j < p.a; j++) {
      const s = (indices[i] >> j) ^ 1
      out.push(forsNode(th, skSeed, i * (1 << (p.a - j)) + s, j, pkSeed, adrs))
    }
  }
  return concat(...out)
}

function forsPkFromSig(th: Tweak, sigFors: Uint8Array, md: Uint8Array, pkSeed: Uint8Array, adrs: Adrs): Uint8Array {
  const p = th.p
  const indices = forsIndices(p, md)
  const roots: Uint8Array[] = []
  const per = (p.a + 1) * p.n
  for (let i = 0; i < p.k; i++) {
    const base = i * per
    const sk = sigFors.slice(base, base + p.n)
    adrs.setTreeHeight(0).setTreeIndex(i * (1 << p.a) + indices[i])
    let node = th.F(pkSeed, adrs, sk)
    for (let j = 0; j < p.a; j++) {
      const auth = sigFors.slice(base + (j + 1) * p.n, base + (j + 2) * p.n)
      adrs.setTreeHeight(j + 1)
      if (((indices[i] >> j) & 1) === 0) {
        adrs.setTreeIndex(adrs.getTreeIndex() >>> 1)
        node = th.H(pkSeed, adrs, concat(node, auth))
      } else {
        adrs.setTreeIndex((adrs.getTreeIndex() - 1) >>> 1)
        node = th.H(pkSeed, adrs, concat(auth, node))
      }
    }
    roots.push(node)
  }
  const fpk = adrs.clone().setType(FORS_ROOTS).setKeyPair(adrs.getKeyPair())
  return th.T(pkSeed, fpk, concat(...roots))
}

// ── keys ──────────────────────────────────────────────────────────────────────

export interface SlhPublicKey {
  pkSeed: Uint8Array
  pkRoot: Uint8Array
}
export interface SlhSecretKey {
  skSeed: Uint8Array
  skPrf: Uint8Array
  pkSeed: Uint8Array
  pkRoot: Uint8Array
}

/** keyGen from the three raw seeds (FIPS 205 Alg 18, slh_keygen_internal). */
export function keyGenFromSeeds(p: SlhParams, skSeed: Uint8Array, skPrf: Uint8Array, pkSeed: Uint8Array, stats?: Stats): { pk: SlhPublicKey; sk: SlhSecretKey } {
  const th = new Tweak(p, stats)
  const adrs = new Adrs().setLayer(p.d - 1).setTree(0)
  const pkRoot = xmssNode(th, skSeed, 0, p.hp, pkSeed, adrs)
  const pk: SlhPublicKey = { pkSeed, pkRoot }
  const sk: SlhSecretKey = { skSeed, skPrf, pkSeed, pkRoot }
  return { pk, sk }
}

/** keyGen from a 3n-byte expanded seed (skSeed ‖ skPrf ‖ pkSeed). */
export function keyGen(p: SlhParams, seed: Uint8Array, stats?: Stats): { pk: SlhPublicKey; sk: SlhSecretKey } {
  return keyGenFromSeeds(p, seed.slice(0, p.n), seed.slice(p.n, 2 * p.n), seed.slice(2 * p.n, 3 * p.n), stats)
}

export function encodePk(pk: SlhPublicKey): Uint8Array {
  return concat(pk.pkSeed, pk.pkRoot)
}
export function encodeSk(sk: SlhSecretKey): Uint8Array {
  return concat(sk.skSeed, sk.skPrf, sk.pkSeed, sk.pkRoot)
}
export function decodeSk(p: SlhParams, bytes: Uint8Array): SlhSecretKey {
  return { skSeed: bytes.slice(0, p.n), skPrf: bytes.slice(p.n, 2 * p.n), pkSeed: bytes.slice(2 * p.n, 3 * p.n), pkRoot: bytes.slice(3 * p.n, 4 * p.n) }
}

// ── the digest split (FIPS 205 Alg 19) ────────────────────────────────────────

export interface DigestSplit {
  md: Uint8Array
  idxTree: bigint
  idxLeaf: number
}
export function splitDigest(p: SlhParams, digest: Uint8Array): DigestSplit {
  const ka = Math.ceil((p.k * p.a) / 8)
  const t1 = Math.ceil((p.h - p.hp) / 8)
  const t2 = Math.ceil(p.hp / 8)
  const md = digest.slice(0, ka)
  const idxTree = toInt(digest.slice(ka, ka + t1)) & ((1n << BigInt(p.h - p.hp)) - 1n)
  const idxLeaf = Number(toInt(digest.slice(ka + t1, ka + t1 + t2)) & ((1n << BigInt(p.hp)) - 1n))
  return { md, idxTree, idxLeaf }
}

// ── sign / verify ──────────────────────────────────────────────────────────────

export interface SignTrace {
  R: Uint8Array
  digest: Uint8Array
  md: Uint8Array
  idxTree: bigint
  idxLeaf: number
  forsIndices: number[]
  pkFors: Uint8Array
  stats: Stats
}

/** slh_sign_internal (FIPS 205 Alg 19): sign an already-formatted message M. */
export function signInternal(p: SlhParams, M: Uint8Array, sk: SlhSecretKey, addrnd: Uint8Array, stats?: Stats): { sig: Uint8Array; trace: SignTrace } {
  const s = stats ?? newStats()
  const th = new Tweak(p, s)
  const R = th.PRFmsg(sk.skPrf, addrnd, M)
  const digest = th.Hmsg(R, sk.pkSeed, sk.pkRoot, M)
  const { md, idxTree, idxLeaf } = splitDigest(p, digest)
  const adrs = new Adrs().setTree(idxTree).setType(FORS_TREE).setKeyPair(idxLeaf)
  const sigFors = forsSign(th, md, sk.skSeed, sk.pkSeed, adrs)
  const pkFors = forsPkFromSig(th, sigFors, md, sk.pkSeed, new Adrs().setTree(idxTree).setType(FORS_TREE).setKeyPair(idxLeaf))
  const sigHt = htSign(th, pkFors, sk.skSeed, sk.pkSeed, idxTree, idxLeaf)
  const sig = concat(R, sigFors, sigHt)
  return { sig, trace: { R, digest, md, idxTree, idxLeaf, forsIndices: forsIndices(p, md), pkFors, stats: s } }
}

/** slh_verify_internal (FIPS 205 Alg 20). */
export function verifyInternal(p: SlhParams, M: Uint8Array, sig: Uint8Array, pk: SlhPublicKey, stats?: Stats): boolean {
  if (sig.length !== p.sigBytes) return false
  const th = new Tweak(p, stats)
  const forsBytes = p.k * (p.a + 1) * p.n
  const R = sig.slice(0, p.n)
  const sigFors = sig.slice(p.n, p.n + forsBytes)
  const sigHt = sig.slice(p.n + forsBytes)
  const digest = th.Hmsg(R, pk.pkSeed, pk.pkRoot, M)
  const { md, idxTree, idxLeaf } = splitDigest(p, digest)
  const adrs = new Adrs().setTree(idxTree).setType(FORS_TREE).setKeyPair(idxLeaf)
  const pkFors = forsPkFromSig(th, sigFors, md, pk.pkSeed, adrs)
  return htVerify(th, pkFors, sigHt, pk.pkSeed, idxTree, idxLeaf, pk.pkRoot)
}

/** The FIPS 205 §10.2 context wrapper M′ = 0x00 ‖ |ctx| ‖ ctx ‖ M (pure, no pre-hash). */
export function pureMessage(M: Uint8Array, ctx: Uint8Array): Uint8Array {
  if (ctx.length > 255) throw new Error('context too long (max 255 bytes)')
  return concat(toByte(0, 1), toByte(ctx.length, 1), ctx, M)
}

export interface SignOptions {
  ctx?: Uint8Array
  deterministic?: boolean // true ⇒ opt_rand = PK.seed; false ⇒ fresh randomness
  rnd?: Uint8Array // an explicit n-byte randomiser (overrides deterministic)
  stats?: Stats
}

/** slh_sign (FIPS 205 Alg 22): the external, pure signing API. */
export function signTrace(p: SlhParams, sk: SlhSecretKey, M: Uint8Array, opts: SignOptions = {}): { sig: Uint8Array; trace: SignTrace } {
  const ctx = opts.ctx ?? new Uint8Array(0)
  const addrnd = opts.rnd ?? (opts.deterministic === false ? randomN(p.n) : sk.pkSeed)
  return signInternal(p, pureMessage(M, ctx), sk, addrnd, opts.stats)
}

export function sign(p: SlhParams, sk: SlhSecretKey, M: Uint8Array, opts: SignOptions = {}): Uint8Array {
  return signTrace(p, sk, M, opts).sig
}

/** slh_verify (FIPS 205 Alg 24). */
export function verify(p: SlhParams, pk: SlhPublicKey, M: Uint8Array, sig: Uint8Array, ctx: Uint8Array = new Uint8Array(0)): boolean {
  if (ctx.length > 255) return false
  return verifyInternal(p, pureMessage(M, ctx), sig, pk)
}

// A tiny non-cryptographic randomiser for the hedged mode in-browser (the lab is
// explicitly educational; the deterministic mode is what the KAT pins).
function randomN(n: number): Uint8Array {
  const out = new Uint8Array(n)
  const g = (globalThis as { crypto?: Crypto }).crypto
  if (g && typeof g.getRandomValues === 'function') {
    try {
      g.getRandomValues(out)
      return out
    } catch {
      /* fall through */
    }
  }
  let x = 0x9e3779b9 ^ n
  for (let i = 0; i < n; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x & 0xff
  }
  return out
}

export function sizes(p: SlhParams) {
  return { pk: p.pkBytes, sk: p.skBytes, sig: p.sigBytes }
}

// ── NIST ACVP known-answer vectors (FIPS 205) — pinned in the self-test ────────
//
// keyGen: the three seeds map to a public root; siggen: the deterministic, pure
// external signature over `message` (with `context`) hashes to `sigSha256`.

export interface KeygenKat {
  name: string
  params: SlhParams
  skSeed: string
  skPrf: string
  pkSeed: string
  pk: string
  sk: string
}
export const KEYGEN_KAT: KeygenKat[] = [
  {
    name: 'SLH-DSA-SHA2-128f',
    params: SLHDSA_128F,
    skSeed: 'C42BCB3B5A6F331F5CCE899253C6D9E2',
    skPrf: '9FF2B7EAD7A04BAB1794DB8CC659C3B4',
    pkSeed: 'A868F1BD5DEBC12D4C9FAD66AABD0A94',
    pk: 'A868F1BD5DEBC12D4C9FAD66AABD0A94B546DF247BE4C457F3D467CDFCFABD39',
    sk: 'C42BCB3B5A6F331F5CCE899253C6D9E29FF2B7EAD7A04BAB1794DB8CC659C3B4A868F1BD5DEBC12D4C9FAD66AABD0A94B546DF247BE4C457F3D467CDFCFABD39',
  },
  {
    name: 'SLH-DSA-SHA2-128s',
    params: SLHDSA_128S,
    skSeed: '173D04C938C1C36BF289C3C022D04B14',
    skPrf: '63AE23C41AA546DA589774AC20B745C4',
    pkSeed: '0D794777914C99766827F0F09CA972BE',
    pk: '0D794777914C99766827F0F09CA972BE0162C10219D422ADBA1359E6AA65299C',
    sk: '173D04C938C1C36BF289C3C022D04B1463AE23C41AA546DA589774AC20B745C40D794777914C99766827F0F09CA972BE0162C10219D422ADBA1359E6AA65299C',
  },
]

export interface SiggenKat {
  name: string
  params: SlhParams
  sk: string
  message: string
  context: string
  sigSha256: string
}
export const SIGGEN_KAT: SiggenKat[] = [
  {
    name: 'SLH-DSA-SHA2-128f',
    params: SLHDSA_128F,
    sk: '96933BBFBAA46828BD4CF83A8CD2419D7863D69CF3EAFC91E47B33CED9985459C58383F7579C26AFA6FE3E607DA0D047BEAE389D9E2F9FF17A69F4E0D7F4D829',
    message: '2C',
    context:
      'F7EAA19141FC80ED319A842837E68FF126DB762DFE49CD5BCF11D0E66EA37EF6F72C382E9938532645E881DE9DEE35DD60DF56CF74726F2F183AC99422C6D6B37822176CC4F0D17CAAEBA06E79E69699A5F3AD4556F7180E98FC1E6AB4FD11E556FAC53387DBD00D24ACC68D8108',
    sigSha256: '152646f0a930621eb0717f29cdd74be06a8375839f11e61e06995d58502893d8',
  },
  {
    name: 'SLH-DSA-SHA2-128s',
    params: SLHDSA_128S,
    sk: '9AE2F36B1EB8295ACDAA5589D996788F06977D16AC51524D770152E02DE29C8ADB30F66D17E197683997000BC98342AF9B0862379CA9F32EDB1A2EF3A9262207',
    message: '20',
    context:
      '0610D63CCA608F79C617F1C311FB4CF35D63982536A41B2C305A21D56641AD213B9B0253E8518F46642033680F25F91D936C184F78F6170864BE8E59A6F399FA7F01E80B19DF5F76B3111C4EAC7FEBBEB4C7C9FF3B2C2324A61B3348C84257816EE0E8FBE3AEE55C6C547C9B1ABE239707569CFD7408DA68FDCCB9FE3BCBCA2FAC370CCF17F31551C53E07169520F0601A6E14937204B87BB0FFEFF8FFAB9A736A12BC0B1E3D051CE90F022D848A68ECC5B8AAD63F354269422B0D1D0FFE60C86B8BA0FD0DB518C44454C8B46DFAA7BD1DFEF75F7305FF0B10CAC037024A70B1C470282B4885EBBD181EDB3F4052330362106780B0243893B7E983F97230E3',
    sigSha256: '8ceee1f1b9feeb53f65e63a54c2ef252bfa4307df171ecdc2367923ef63d5223',
  },
]

export { bytesToHex, hexToBytes }
