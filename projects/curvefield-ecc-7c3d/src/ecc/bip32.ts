// BIP-32 — hierarchical deterministic (HD) wallets. One seed deterministically
// generates an entire tree of key pairs, so a wallet can hand out a fresh address
// for every payment while backing up just twelve words.
//
// The engine is the secp256k1 group law again, now glued together by HMAC-SHA512:
// each child key is the parent key plus a hash of (parent, index, chain code).
// Because that offset is *additive*, a watch-only server holding only the public
// key and chain code can derive every (non-hardened) child public key — without
// ever touching a secret. Validated against the BIP-32 test vectors.

import { secp256k1, G, N, publicKey } from './secp256k1'
import type { Point } from './curve'
import { mod } from './field'
import { hmacSha512 } from './sha512'
import { bigToBytes, bytesToBig, concat, utf8 } from './sha256'
import { pointCompress, hash160, base58check } from './encoding'

/** Indices ≥ 2³¹ are "hardened": derivable only from the private key. */
export const HARDENED = 0x80000000

// Version bytes for Base58 serialization (Bitcoin mainnet).
const XPRV_VERSION = 0x0488ade4
const XPUB_VERSION = 0x0488b21e

export interface HDNode {
  depth: number
  childNumber: number
  parentFingerprint: number
  chainCode: Uint8Array
  priv: bigint | null // null for a watch-only (public) node
  pub: Point
}

const ser32 = (n: number): Uint8Array =>
  new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])

/** The first 4 bytes of HASH160(compressed pubkey) — a node's identifier. */
export function fingerprint(node: HDNode): number {
  const id = hash160(pointCompress(node.pub))
  return ((id[0] << 24) | (id[1] << 16) | (id[2] << 8) | id[3]) >>> 0
}

/** Derive the master node from a binary seed (BIP-32 "Bitcoin seed" HMAC). */
export function masterFromSeed(seed: Uint8Array): HDNode {
  const I = hmacSha512(utf8('Bitcoin seed'), seed)
  const IL = bytesToBig(I.slice(0, 32))
  const chainCode = I.slice(32, 64)
  if (IL === 0n || IL >= N) throw new Error('invalid seed (master key out of range)')
  return {
    depth: 0,
    childNumber: 0,
    parentFingerprint: 0,
    chainCode,
    priv: IL,
    pub: publicKey(IL),
  }
}

/** CKDpriv: derive a child *private* node. Hardened indices are allowed here. */
export function deriveChildPriv(node: HDNode, index: number): HDNode {
  if (node.priv === null) throw new Error('cannot derive a private child from a public node')
  const hardened = index >= HARDENED
  const data = hardened
    ? concat(new Uint8Array([0]), bigToBytes(node.priv, 32), ser32(index))
    : concat(pointCompress(node.pub), ser32(index))
  const I = hmacSha512(node.chainCode, data)
  const IL = bytesToBig(I.slice(0, 32))
  if (IL >= N) throw new Error('derived IL ≥ n — retry with the next index (negligibly rare)')
  const childPriv = mod(IL + node.priv, N)
  if (childPriv === 0n) throw new Error('derived child key is zero — retry')
  return {
    depth: node.depth + 1,
    childNumber: index,
    parentFingerprint: fingerprint(node),
    chainCode: I.slice(32, 64),
    priv: childPriv,
    pub: publicKey(childPriv),
  }
}

/** CKDpub: derive a child *public* node — watch-only, non-hardened only. */
export function deriveChildPub(node: HDNode, index: number): HDNode {
  if (index >= HARDENED) throw new Error('cannot derive a hardened child from a public key')
  const data = concat(pointCompress(node.pub), ser32(index))
  const I = hmacSha512(node.chainCode, data)
  const IL = bytesToBig(I.slice(0, 32))
  if (IL >= N) throw new Error('derived IL ≥ n — retry')
  const childPub = secp256k1.add(secp256k1.multiply(IL, G), node.pub)
  if (childPub === null) throw new Error('derived public child is the point at infinity — retry')
  return {
    depth: node.depth + 1,
    childNumber: index,
    parentFingerprint: fingerprint(node),
    chainCode: I.slice(32, 64),
    priv: null,
    pub: childPub,
  }
}

export interface PathStep {
  label: string // e.g. "m", "m/0'", "m/0'/1"
  index: number
  hardened: boolean
  node: HDNode
}

/** Parse and walk a derivation path like `m/44'/0'/0'/0/0`, returning every node. */
export function derivePath(seed: Uint8Array, path: string): PathStep[] {
  const master = masterFromSeed(seed)
  const steps: PathStep[] = [{ label: 'm', index: 0, hardened: false, node: master }]
  const parts = path.trim().replace(/^m\/?/, '').split('/').filter(Boolean)
  let node = master
  let label = 'm'
  for (const part of parts) {
    const hardened = part.endsWith("'") || part.endsWith('h')
    const num = parseInt(part.replace(/['h]$/, ''), 10)
    if (Number.isNaN(num)) throw new Error(`bad path element: ${part}`)
    const index = hardened ? num + HARDENED : num
    node = deriveChildPriv(node, index)
    label += '/' + num + (hardened ? "'" : '')
    steps.push({ label, index, hardened, node })
  }
  return steps
}

/** Serialize a node as an extended key (xprv if private, else xpub). */
export function serialize(node: HDNode, wantPrivate: boolean): string {
  if (wantPrivate && node.priv === null) throw new Error('no private key to serialize')
  const version = wantPrivate ? XPRV_VERSION : XPUB_VERSION
  const keyData = wantPrivate
    ? concat(new Uint8Array([0]), bigToBytes(node.priv as bigint, 32))
    : pointCompress(node.pub)
  const payload = concat(
    ser32(version),
    new Uint8Array([node.depth & 0xff]),
    ser32(node.parentFingerprint),
    ser32(node.childNumber),
    node.chainCode,
    keyData,
  )
  return base58check(payload)
}

export const xprv = (node: HDNode): string => serialize(node, true)
export const xpub = (node: HDNode): string => serialize(node, false)
