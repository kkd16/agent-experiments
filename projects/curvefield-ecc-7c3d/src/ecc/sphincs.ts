// SPHINCS+ — a *stateless* hash-based signature, the shape standardised as
// NIST SLH-DSA (FIPS 205). XMSS is secure only if you never sign twice from one
// leaf; keeping that counter safe across reboots and backups is a notorious
// operational hazard. SPHINCS+ removes the state at the cost of size, by two
// ideas layered on the pieces already in the lab:
//
//   • a HYPERTREE — d layers of XMSS trees, each layer's root signed by a WOTS+
//     key in the tree above, so 2^h one-time keys collapse into one root while
//     only d small subtrees are ever built per signature (the rest are virtual,
//     regenerated from seeds on demand); and
//   • FORS ("Forest Of Random Subsets") — a FEW-time signature of k Merkle trees
//     whose leaves the message digest selects, tolerant of the rare index
//     collisions that a random (stateless) leaf choice inevitably causes.
//
// A message is hashed with a per-signature randomiser R to a (FORS indices, tree
// index, leaf index) triple; FORS signs the digest, and the hypertree signs the
// FORS public key from that pseudo-random leaf. No state, no counter — the same
// key signs any number of messages. Parameters here are scaled DOWN so the
// browser can keygen/sign in well under a second; the construction is faithful
// to FIPS 205 and the real parameter names are noted in the lab.

import {
  N,
  Adrs,
  ADRS_OTS,
  ADRS_LTREE,
  ADRS_TREE,
  ADRS_FORS_TREE,
  ADRS_FORS_ROOTS,
  F,
  PRF,
  Hmsg,
  thash,
  randHash,
} from './hashaddr'
import { concat, sha256 } from './sha256'
import { wotsPkGen, wotsSign, wotsPkFromSig, WOTS_W16, type WotsParams } from './wots'
import { ltree } from './xmss'

export interface SphincsParams {
  /** per-subtree height (leaves per XMSS tree = 2^hp). */
  hp: number
  /** hypertree layers; total height h = hp·d. */
  d: number
  /** FORS tree height (leaves per FORS tree = 2^a). */
  a: number
  /** number of FORS trees. */
  k: number
  wots: WotsParams
}

/** A scaled-down lab instance (fast keygen/sign); FIPS-205 names in the lab. */
export const SPHINCS_TOY: SphincsParams = { hp: 4, d: 3, a: 6, k: 8, wots: WOTS_W16 }

export interface SphincsPublicKey {
  root: Uint8Array
  pubSeed: Uint8Array
  params: SphincsParams
}
export interface SphincsSecretKey {
  skSeed: Uint8Array
  skPrf: Uint8Array
  pubSeed: Uint8Array
  root: Uint8Array
  params: SphincsParams
}

/** One layer of the hypertree signature: a WOTS+ sig + its auth path. */
interface HtLayerSig {
  wots: Uint8Array[]
  auth: Uint8Array[]
}
/** One FORS tree's opening: the revealed secret leaf + its auth path. */
interface ForsTreeSig {
  sk: Uint8Array
  auth: Uint8Array[]
}
export interface SphincsSignature {
  r: Uint8Array
  fors: ForsTreeSig[]
  ht: HtLayerSig[]
}

const eq = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

// ── bit extraction from the message digest ──────────────────────────────────

/** Pull an `nbits`-wide unsigned integer from `bytes` starting at bit `offset`. */
function bitsFrom(bytes: Uint8Array, offset: number, nbits: number): number {
  let v = 0
  for (let i = 0; i < nbits; i++) {
    const bit = offset + i
    const b = (bytes[bit >> 3] >> (7 - (bit & 7))) & 1
    v = (v << 1) | b
  }
  return v >>> 0
}

interface DigestSplit {
  md: number[] // k FORS leaf indices, a bits each
  idxTree: number // which bottom-layer tree (h - hp bits)
  idxLeaf: number // which leaf within it (hp bits)
}

/** Map the H_msg digest to (FORS indices, tree index, leaf index). */
export function splitDigest(digest: Uint8Array, p: SphincsParams): DigestSplit {
  const md: number[] = []
  let off = 0
  for (let i = 0; i < p.k; i++) {
    md.push(bitsFrom(digest, off, p.a))
    off += p.a
  }
  const h = p.hp * p.d
  const idxTree = bitsFrom(digest, off, h - p.hp)
  off += h - p.hp
  const idxLeaf = bitsFrom(digest, off, p.hp)
  return { md, idxTree, idxLeaf }
}

// ── the XMSS subtree, regenerated on demand from seeds ──────────────────────

interface Subtree {
  levels: Uint8Array[][]
  root: Uint8Array
}

/** Build the XMSS tree at (layer, treeIdx) — 2^hp WOTS+ leaves, L-tree'd. */
function buildSubtree(
  skSeed: Uint8Array,
  pubSeed: Uint8Array,
  layer: number,
  treeIdx: number,
  p: SphincsParams,
): Subtree {
  const count = 1 << p.hp
  const leaves: Uint8Array[] = []
  for (let j = 0; j < count; j++) {
    const otsAdrs = new Adrs().setLayer(layer).setTree(treeIdx).setType(ADRS_OTS).setOts(j)
    const pk = wotsPkGen(skSeed, pubSeed, otsAdrs, p.wots)
    const lAdrs = new Adrs().setLayer(layer).setTree(treeIdx).setType(ADRS_LTREE).setLtree(j)
    leaves.push(ltree(pk, pubSeed, lAdrs))
  }
  const levels: Uint8Array[][] = [leaves]
  let level = leaves
  let height = 0
  while (level.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i < level.length; i += 2) {
      const adrs = new Adrs()
        .setLayer(layer)
        .setTree(treeIdx)
        .setType(ADRS_TREE)
        .setTreeHeight(height)
        .setTreeIndex(i >> 1)
      next.push(randHash(level[i], level[i + 1], pubSeed, adrs))
    }
    levels.push(next)
    level = next
    height++
  }
  return { levels, root: level[0] }
}

function subtreeAuth(t: Subtree, leaf: number, hp: number): Uint8Array[] {
  const auth: Uint8Array[] = []
  for (let level = 0; level < hp; level++) auth.push(t.levels[level][(leaf >> level) ^ 1])
  return auth
}

/** Fold a leaf up through an auth path with (layer, treeIdx)-scoped addresses. */
function foldSubtree(
  leaf: Uint8Array,
  leafIdx: number,
  auth: Uint8Array[],
  pubSeed: Uint8Array,
  layer: number,
  treeIdx: number,
  hp: number,
): Uint8Array {
  let node = leaf
  for (let level = 0; level < hp; level++) {
    const adrs = new Adrs()
      .setLayer(layer)
      .setTree(treeIdx)
      .setType(ADRS_TREE)
      .setTreeHeight(level)
      .setTreeIndex(leafIdx >> (level + 1))
    node = ((leafIdx >> level) & 1) === 0
      ? randHash(node, auth[level], pubSeed, adrs)
      : randHash(auth[level], node, pubSeed, adrs)
  }
  return node
}

// ── the hypertree: sign an n-byte value at (idxTree, idxLeaf) up to the root ──

function htSign(
  msg: Uint8Array,
  idxTree0: number,
  idxLeaf0: number,
  skSeed: Uint8Array,
  pubSeed: Uint8Array,
  p: SphincsParams,
): HtLayerSig[] {
  const sig: HtLayerSig[] = []
  let node = msg
  let idxTree = idxTree0
  let idxLeaf = idxLeaf0
  for (let layer = 0; layer < p.d; layer++) {
    const t = buildSubtree(skSeed, pubSeed, layer, idxTree, p)
    const otsAdrs = new Adrs().setLayer(layer).setTree(idxTree).setType(ADRS_OTS).setOts(idxLeaf)
    const wots = wotsSign(node, skSeed, pubSeed, otsAdrs, p.wots)
    const auth = subtreeAuth(t, idxLeaf, p.hp)
    sig.push({ wots, auth })
    node = t.root
    idxLeaf = idxTree & ((1 << p.hp) - 1)
    idxTree = idxTree >>> p.hp
  }
  return sig
}

function htRootFromSig(
  msg: Uint8Array,
  sig: HtLayerSig[],
  idxTree0: number,
  idxLeaf0: number,
  pubSeed: Uint8Array,
  p: SphincsParams,
): Uint8Array {
  let node = msg
  let idxTree = idxTree0
  let idxLeaf = idxLeaf0
  for (let layer = 0; layer < p.d; layer++) {
    const otsAdrs = new Adrs().setLayer(layer).setTree(idxTree).setType(ADRS_OTS).setOts(idxLeaf)
    const wpk = wotsPkFromSig(node, sig[layer].wots, pubSeed, otsAdrs, p.wots)
    const lAdrs = new Adrs().setLayer(layer).setTree(idxTree).setType(ADRS_LTREE).setLtree(idxLeaf)
    const leaf = ltree(wpk, pubSeed, lAdrs)
    node = foldSubtree(leaf, idxLeaf, sig[layer].auth, pubSeed, layer, idxTree, p.hp)
    idxLeaf = idxTree & ((1 << p.hp) - 1)
    idxTree = idxTree >>> p.hp
  }
  return node
}

// ── FORS: a few-time signature over the k message-selected leaves ────────────

/** The secret at FORS tree `t`, leaf `j` (bound to bottom-tree leaf keyPair). */
function forsSk(
  skSeed: Uint8Array,
  idxTree: number,
  keyPair: number,
  t: number,
  j: number,
  p: SphincsParams,
): Uint8Array {
  const adrs = new Adrs()
    .setTree(idxTree)
    .setType(ADRS_FORS_TREE)
    .setKeyPair(keyPair)
    .setTreeHeight(0)
    .setTreeIndex(t * (1 << p.a) + j)
  return PRF(skSeed, adrs.toBytes())
}

/** The public FORS leaf = F(masked secret), addressed at (tree t, leaf j). */
function forsLeaf(
  sk: Uint8Array,
  pubSeed: Uint8Array,
  idxTree: number,
  keyPair: number,
  t: number,
  j: number,
  p: SphincsParams,
): Uint8Array {
  const adrs = new Adrs()
    .setTree(idxTree)
    .setType(ADRS_FORS_TREE)
    .setKeyPair(keyPair)
    .setTreeHeight(0)
    .setTreeIndex(t * (1 << p.a) + j)
  adrs.setKeyAndMask(0)
  const key = PRF(pubSeed, adrs.toBytes())
  adrs.setKeyAndMask(1)
  const bm = PRF(pubSeed, adrs.toBytes())
  const masked = new Uint8Array(N)
  for (let i = 0; i < N; i++) masked[i] = sk[i] ^ bm[i]
  return F(key, masked)
}

/** Build FORS tree `t` (levels) so we can extract a root + auth path. */
function buildForsTree(
  skSeed: Uint8Array,
  pubSeed: Uint8Array,
  idxTree: number,
  keyPair: number,
  t: number,
  p: SphincsParams,
): Subtree {
  const count = 1 << p.a
  const leaves: Uint8Array[] = []
  for (let j = 0; j < count; j++) {
    const sk = forsSk(skSeed, idxTree, keyPair, t, j, p)
    leaves.push(forsLeaf(sk, pubSeed, idxTree, keyPair, t, j, p))
  }
  const levels: Uint8Array[][] = [leaves]
  let level = leaves
  let height = 0
  while (level.length > 1) {
    const next: Uint8Array[] = []
    const span = 1 << (p.a - height - 1)
    for (let i = 0; i < level.length; i += 2) {
      const adrs = new Adrs()
        .setTree(idxTree)
        .setType(ADRS_FORS_TREE)
        .setKeyPair(keyPair)
        .setTreeHeight(height + 1)
        .setTreeIndex(t * span + (i >> 1))
      next.push(randHash(level[i], level[i + 1], pubSeed, adrs))
    }
    levels.push(next)
    level = next
    height++
  }
  return { levels, root: level[0] }
}

function forsFoldRoot(
  leaf: Uint8Array,
  leafIdx: number,
  auth: Uint8Array[],
  pubSeed: Uint8Array,
  idxTree: number,
  keyPair: number,
  t: number,
  p: SphincsParams,
): Uint8Array {
  let node = leaf
  for (let level = 0; level < p.a; level++) {
    const span = 1 << (p.a - level - 1)
    const adrs = new Adrs()
      .setTree(idxTree)
      .setType(ADRS_FORS_TREE)
      .setKeyPair(keyPair)
      .setTreeHeight(level + 1)
      .setTreeIndex(t * span + (leafIdx >> (level + 1)))
    node = ((leafIdx >> level) & 1) === 0
      ? randHash(node, auth[level], pubSeed, adrs)
      : randHash(auth[level], node, pubSeed, adrs)
  }
  return node
}

function forsRootsToPk(
  roots: Uint8Array[],
  pubSeed: Uint8Array,
  idxTree: number,
  keyPair: number,
): Uint8Array {
  const adrs = new Adrs().setTree(idxTree).setType(ADRS_FORS_ROOTS).setKeyPair(keyPair)
  return thash(roots, pubSeed, adrs)
}

function forsSign(
  md: number[],
  skSeed: Uint8Array,
  pubSeed: Uint8Array,
  idxTree: number,
  keyPair: number,
  p: SphincsParams,
): { sig: ForsTreeSig[]; pk: Uint8Array } {
  const sig: ForsTreeSig[] = []
  const roots: Uint8Array[] = []
  for (let t = 0; t < p.k; t++) {
    const tree = buildForsTree(skSeed, pubSeed, idxTree, keyPair, t, p)
    const leafIdx = md[t]
    const sk = forsSk(skSeed, idxTree, keyPair, t, leafIdx, p)
    const auth: Uint8Array[] = []
    for (let level = 0; level < p.a; level++) auth.push(tree.levels[level][(leafIdx >> level) ^ 1])
    sig.push({ sk, auth })
    roots.push(tree.root)
  }
  return { sig, pk: forsRootsToPk(roots, pubSeed, idxTree, keyPair) }
}

function forsPkFromSig(
  md: number[],
  sig: ForsTreeSig[],
  pubSeed: Uint8Array,
  idxTree: number,
  keyPair: number,
  p: SphincsParams,
): Uint8Array {
  const roots: Uint8Array[] = []
  for (let t = 0; t < p.k; t++) {
    const leafIdx = md[t]
    const leaf = forsLeaf(sig[t].sk, pubSeed, idxTree, keyPair, t, leafIdx, p)
    roots.push(forsFoldRoot(leaf, leafIdx, sig[t].auth, pubSeed, idxTree, keyPair, t, p))
  }
  return forsRootsToPk(roots, pubSeed, idxTree, keyPair)
}

// ── the full stateless scheme ───────────────────────────────────────────────

/** Keygen: the top XMSS tree's root is the public key. */
export function sphincsKeygen(
  skSeed: Uint8Array,
  skPrf: Uint8Array,
  pubSeed: Uint8Array,
  params: SphincsParams = SPHINCS_TOY,
): { pk: SphincsPublicKey; sk: SphincsSecretKey } {
  const top = buildSubtree(skSeed, pubSeed, params.d - 1, 0, params)
  const root = top.root
  return {
    pk: { root, pubSeed, params },
    sk: { skSeed, skPrf, pubSeed, root, params },
  }
}

/** The randomized message digest, keyed by R ‖ PK.seed ‖ PK.root. */
function digestOf(r: Uint8Array, pk: { pubSeed: Uint8Array; root: Uint8Array }, msg: Uint8Array): Uint8Array {
  const key = concat(r, pk.pubSeed, pk.root)
  return Hmsg(key, msg)
}

/** Sign — stateless: the leaf is pseudo-random from R, not a counter. */
export function sphincsSign(sk: SphincsSecretKey, msg: Uint8Array): SphincsSignature {
  const p = sk.params
  // R = PRF_msg(SK.prf, M) — deterministic (so it is reproducible), no state.
  const r = PRF(sk.skPrf, sha256(concat(sk.pubSeed, msg)))
  const digest = digestOf(r, sk, msg)
  const { md, idxTree, idxLeaf } = splitDigest(digest, p)
  const { sig: fors, pk: pkFors } = forsSign(md, sk.skSeed, sk.pubSeed, idxTree, idxLeaf, p)
  const ht = htSign(pkFors, idxTree, idxLeaf, sk.skSeed, sk.pubSeed, p)
  return { r, fors, ht }
}

/** Verify — recompute the FORS public key, then check it climbs to PK.root. */
export function sphincsVerify(pk: SphincsPublicKey, msg: Uint8Array, sig: SphincsSignature): boolean {
  const p = pk.params
  const digest = digestOf(sig.r, pk, msg)
  const { md, idxTree, idxLeaf } = splitDigest(digest, p)
  const pkFors = forsPkFromSig(md, sig.fors, pk.pubSeed, idxTree, idxLeaf, p)
  const root = htRootFromSig(pkFors, sig.ht, idxTree, idxLeaf, pk.pubSeed, p)
  return eq(root, pk.root)
}

/** Byte sizes at these parameters. Public key is tiny; the signature is not. */
export function sphincsSizes(p: SphincsParams = SPHINCS_TOY) {
  const fors = p.k * (p.a + 1) * N
  const ht = p.d * (p.wots.len + p.hp) * N
  return {
    publicKey: 2 * N, // root + pubSeed
    secretKey: 3 * N,
    signature: N + fors + ht, // R + FORS + hypertree
    totalHeight: p.hp * p.d,
    forsBytes: fors,
    htBytes: ht,
  }
}
