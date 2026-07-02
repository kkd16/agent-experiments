// XMSS — the eXtended Merkle Signature Scheme (RFC 8391 §4). A WOTS+ key signs
// exactly once; XMSS makes a *reusable* public key out of 2^h of them by hashing
// their compressed public keys into the leaves of a Merkle tree and publishing
// only the root. A signature is then one WOTS+ signature plus the O(h) authentic-
// ation path proving that its leaf hangs under the published root.
//
// The public key is a single hash (the root). The private key holds the seeds
// plus a **leaf counter that must advance** — signing twice from one leaf reuses
// a WOTS+ key and is a break, so `sign` refuses to reuse a leaf. That statefulness
// is exactly what SPHINCS+ later removes (see sphincs.ts).

import {
  N,
  Adrs,
  ADRS_OTS,
  ADRS_LTREE,
  ADRS_TREE,
  randHash,
  Hmsg,
  PRF,
  toByte,
} from './hashaddr'
import { wotsPkGen, wotsPkFromSig, wotsSign, WOTS_W16, type WotsParams } from './wots'

/**
 * ltree (RFC 8391 §4.1.5): compress the `len` WOTS+ public-key elements into a
 * single n-byte leaf by an unbalanced binary hash tree (an odd node is carried
 * up unchanged). Uses the bitmasked node hash, addressed as an L-tree.
 */
export function ltree(pk: Uint8Array[], pubSeed: Uint8Array, adrs: Adrs): Uint8Array {
  const nodes = pk.slice()
  let len = nodes.length
  let height = 0
  adrs.setTreeHeight(0)
  while (len > 1) {
    const half = Math.floor(len / 2)
    for (let i = 0; i < half; i++) {
      adrs.setTreeHeight(height)
      adrs.setTreeIndex(i)
      nodes[i] = randHash(nodes[2 * i], nodes[2 * i + 1], pubSeed, adrs.clone())
    }
    if (len & 1) nodes[half] = nodes[len - 1]
    len = Math.ceil(len / 2)
    height++
  }
  return nodes[0]
}

/** Compute the XMSS leaf at index `idx`: a WOTS+ pk L-tree-compressed. */
export function leafAt(
  idx: number,
  skSeed: Uint8Array,
  pubSeed: Uint8Array,
  p: WotsParams = WOTS_W16,
): Uint8Array {
  const otsAdrs = new Adrs().setType(ADRS_OTS).setOts(idx)
  const pk = wotsPkGen(skSeed, pubSeed, otsAdrs, p)
  const lAdrs = new Adrs().setType(ADRS_LTREE).setLtree(idx)
  return ltree(pk, pubSeed, lAdrs)
}

export interface XmssParams {
  /** tree height — 2^h one-time keys. */
  h: number
  wots: WotsParams
}

export interface XmssPublicKey {
  root: Uint8Array
  pubSeed: Uint8Array
  params: XmssParams
}

export interface XmssSecretKey {
  skSeed: Uint8Array
  skPrf: Uint8Array
  pubSeed: Uint8Array
  root: Uint8Array
  /** next unused leaf; MUST advance after every signature. */
  idx: number
  params: XmssParams
  /** cached leaves + node levels so re-signing is cheap. levels[0] = leaves. */
  levels: Uint8Array[][]
}

export interface XmssSignature {
  idx: number
  r: Uint8Array
  wots: Uint8Array[]
  auth: Uint8Array[]
}

/** Build the full Merkle tree (all levels) over the 2^h leaves. */
function buildTree(
  skSeed: Uint8Array,
  pubSeed: Uint8Array,
  params: XmssParams,
): Uint8Array[][] {
  const count = 1 << params.h
  const leaves: Uint8Array[] = []
  for (let i = 0; i < count; i++) leaves.push(leafAt(i, skSeed, pubSeed, params.wots))
  const levels: Uint8Array[][] = [leaves]
  let level = leaves
  let height = 0
  while (level.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i < level.length; i += 2) {
      const adrs = new Adrs().setType(ADRS_TREE).setTreeHeight(height).setTreeIndex(i >> 1)
      next.push(randHash(level[i], level[i + 1], pubSeed, adrs))
    }
    levels.push(next)
    level = next
    height++
  }
  return levels
}

/** Generate an XMSS keypair. keyGen hashes 2^h WOTS+ keys, so keep h modest. */
export function xmssKeygen(
  skSeed: Uint8Array,
  skPrf: Uint8Array,
  pubSeed: Uint8Array,
  params: XmssParams,
): { pk: XmssPublicKey; sk: XmssSecretKey } {
  const levels = buildTree(skSeed, pubSeed, params)
  const root = levels[levels.length - 1][0]
  return {
    pk: { root, pubSeed, params },
    sk: { skSeed, skPrf, pubSeed, root, idx: 0, params, levels },
  }
}

/** The authentication path (sibling per level, bottom-up) for a leaf index. */
export function authPath(levels: Uint8Array[][], idx: number, h: number): Uint8Array[] {
  const auth: Uint8Array[] = []
  for (let level = 0; level < h; level++) {
    const sib = (idx >> level) ^ 1
    auth.push(levels[level][sib])
  }
  return auth
}

/** The randomized message digest M' = H_msg(r ‖ root ‖ toByte(idx,n), M). */
export function messageDigest(r: Uint8Array, root: Uint8Array, idx: number, msg: Uint8Array): Uint8Array {
  const key = new Uint8Array(3 * N)
  key.set(r, 0)
  key.set(root, N)
  key.set(toByte(idx, N), 2 * N)
  return Hmsg(key, msg)
}

/**
 * Sign with the current leaf, then advance the state. Throws if the key is
 * exhausted (all 2^h leaves used). Mutates `sk.idx` — that mutation is the
 * whole point: reusing a leaf reuses a WOTS+ key and is a break.
 */
export function xmssSign(sk: XmssSecretKey, msg: Uint8Array): XmssSignature {
  const max = 1 << sk.params.h
  if (sk.idx >= max) throw new Error(`XMSS key exhausted: all ${max} one-time keys used`)
  const idx = sk.idx
  const r = PRF(sk.skPrf, toByte(idx, N))
  const mp = messageDigest(r, sk.root, idx, msg)
  const otsAdrs = new Adrs().setType(ADRS_OTS).setOts(idx)
  const wots = wotsSign(mp, sk.skSeed, sk.pubSeed, otsAdrs, sk.params.wots)
  const auth = authPath(sk.levels, idx, sk.params.h)
  sk.idx = idx + 1
  return { idx, r, wots, auth }
}

/** Fold a leaf up its authentication path to a claimed root. */
export function rootFromSig(
  idx: number,
  leaf: Uint8Array,
  auth: Uint8Array[],
  pubSeed: Uint8Array,
  h: number,
): Uint8Array {
  let node = leaf
  for (let level = 0; level < h; level++) {
    const adrs = new Adrs().setType(ADRS_TREE).setTreeHeight(level).setTreeIndex(idx >> (level + 1))
    node = ((idx >> level) & 1) === 0
      ? randHash(node, auth[level], pubSeed, adrs)
      : randHash(auth[level], node, pubSeed, adrs)
  }
  return node
}

const eq = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

/** Verify: recover the WOTS+ pk, L-tree it to a leaf, fold to a root, compare. */
export function xmssVerify(pk: XmssPublicKey, msg: Uint8Array, sig: XmssSignature): boolean {
  const mp = messageDigest(sig.r, pk.root, sig.idx, msg)
  const otsAdrs = new Adrs().setType(ADRS_OTS).setOts(sig.idx)
  const wotsPk = wotsPkFromSig(mp, sig.wots, pk.pubSeed, otsAdrs, pk.params.wots)
  const lAdrs = new Adrs().setType(ADRS_LTREE).setLtree(sig.idx)
  const leaf = ltree(wotsPk, pk.pubSeed, lAdrs)
  const root = rootFromSig(sig.idx, leaf, sig.auth, pk.pubSeed, pk.params.h)
  return eq(root, pk.root)
}

/** Byte sizes: pk = root (n), sig = idx-ish + r(n) + WOTS(len·n) + auth(h·n). */
export function xmssSizes(params: XmssParams) {
  const wots = params.wots.len * N
  return {
    publicKey: N, // the root (pubSeed is public but shared/const)
    signature: 4 + N + wots + params.h * N,
    oneTimeKeys: 1 << params.h,
  }
}
