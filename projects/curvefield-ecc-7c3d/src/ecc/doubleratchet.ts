// The Double Ratchet (Signal's specification) — the algorithm that gives an
// end-to-end encrypted conversation its two headline properties:
//
//   • Forward secrecy: every message gets a fresh key derived by a one-way KDF
//     step, and the key is deleted after use — so stealing today's state cannot
//     decrypt yesterday's messages.
//   • Post-compromise security ("self-healing"): whenever the direction of the
//     conversation turns, both sides mix a *new* Diffie–Hellman output into the
//     root key — so one round trip after a compromise, the attacker is locked
//     back out.
//
// Two ratchets turn together. A **symmetric-key ratchet** clicks once per
// message (a hash chain of message keys). A **Diffie–Hellman ratchet** clicks
// once per reply (a new ephemeral key pair reseeds the root). Out-of-order and
// dropped messages are handled by stashing the keys of skipped messages.
//
// Built on the lab's X25519, HKDF-SHA256, HMAC-SHA256 and ChaCha20-Poly1305.

import { x25519 } from './ed25519'
import { hmacSha256, bytesToHex } from './sha256'
import { hkdf } from './hkdf'
import { seal, open } from './chacha20'
import { generateKeyPair, type KeyPair } from './x3dh'

const MAX_SKIP = 1000
const RK_INFO = new TextEncoder().encode('Curvefield_DoubleRatchet_Root')
const MSG_INFO = new TextEncoder().encode('Curvefield_DoubleRatchet_Message')

/** A message header, sent in the clear and authenticated as associated data. */
export interface Header {
  dh: Uint8Array // sender's current ratchet public key
  pn: number // length of the previous sending chain
  n: number // message number within the current sending chain
}

export interface RatchetState {
  dhs: KeyPair // our current ratchet key pair
  dhr: Uint8Array | null // their current ratchet public key
  rk: Uint8Array // root key
  cks: Uint8Array | null // sending chain key
  ckr: Uint8Array | null // receiving chain key
  ns: number // messages sent in the current sending chain
  nr: number // messages received in the current receiving chain
  pn: number // length of the previous sending chain
  skipped: Map<string, Uint8Array> // (ratchetPub, n) -> message key
}

// ── KDFs ──────────────────────────────────────────────────────────────────────

/** Root KDF: fold a DH output into the root key, emitting a new root + chain key. */
function kdfRk(rk: Uint8Array, dhOut: Uint8Array): [Uint8Array, Uint8Array] {
  const out = hkdf(dhOut, rk, RK_INFO, 64)
  return [out.slice(0, 32), out.slice(32, 64)]
}

/** Chain KDF: one symmetric-ratchet click — a new chain key and a message key. */
function kdfCk(ck: Uint8Array): [Uint8Array, Uint8Array] {
  const nextCk = hmacSha256(ck, new Uint8Array([0x02]))
  const mk = hmacSha256(ck, new Uint8Array([0x01]))
  return [nextCk, mk]
}

/** Message key -> (32-byte cipher key, 12-byte nonce) for ChaCha20-Poly1305. */
function messageKeys(mk: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
  const out = hkdf(mk, new Uint8Array(32), MSG_INFO, 44)
  return { key: out.slice(0, 32), nonce: out.slice(32, 44) }
}

// ── header framing (for the AEAD associated data) ─────────────────────────────

function be32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0))
  let o = 0
  for (const a of arrs) {
    out.set(a, o)
    o += a.length
  }
  return out
}

/** Serialize a header so it can be bound into the AEAD tag. */
export function encodeHeader(h: Header): Uint8Array {
  return concat(h.dh, be32(h.pn), be32(h.n))
}

// ── initialization ────────────────────────────────────────────────────────────

/** Alice (the X3DH initiator) starts with Bob's signed prekey as `dhr`. */
export function initAlice(sharedSecret: Uint8Array, bobSignedPreKey: Uint8Array): RatchetState {
  const dhs = generateKeyPair()
  const [rk, cks] = kdfRk(sharedSecret, x25519(dhs.priv, bobSignedPreKey))
  return { dhs, dhr: bobSignedPreKey, rk, cks, ckr: null, ns: 0, nr: 0, pn: 0, skipped: new Map() }
}

/** Bob (the responder) starts holding his signed-prekey pair as `dhs`. */
export function initBob(sharedSecret: Uint8Array, bobSignedPreKey: KeyPair): RatchetState {
  return {
    dhs: bobSignedPreKey,
    dhr: null,
    rk: sharedSecret,
    cks: null,
    ckr: null,
    ns: 0,
    nr: 0,
    pn: 0,
    skipped: new Map(),
  }
}

// ── encrypt / decrypt ─────────────────────────────────────────────────────────

export interface RatchetMessage {
  header: Header
  ciphertext: Uint8Array
}

/** Encrypt a plaintext, advancing the sending chain by one click. */
export function ratchetEncrypt(
  state: RatchetState,
  plaintext: Uint8Array,
  ad: Uint8Array = new Uint8Array(0),
): RatchetMessage {
  if (!state.cks) throw new Error('ratchet: no sending chain (call initAlice or receive first)')
  const [cks, mk] = kdfCk(state.cks)
  state.cks = cks
  const header: Header = { dh: state.dhs.pub, pn: state.pn, n: state.ns }
  state.ns += 1
  const { key, nonce } = messageKeys(mk)
  const ciphertext = seal(key, nonce, plaintext, concat(ad, encodeHeader(header)))
  return { header, ciphertext }
}

function skipKey(dh: Uint8Array, n: number): string {
  return `${bytesToHex(dh)}:${n}`
}

function trySkipped(
  state: RatchetState,
  header: Header,
  ciphertext: Uint8Array,
  ad: Uint8Array,
): Uint8Array | null {
  const k = skipKey(header.dh, header.n)
  const mk = state.skipped.get(k)
  if (!mk) return null
  const { key, nonce } = messageKeys(mk)
  const pt = open(key, nonce, ciphertext, concat(ad, encodeHeader(header)))
  if (pt) state.skipped.delete(k)
  return pt
}

function skipMessageKeys(state: RatchetState, until: number): void {
  if (state.ckr === null) return
  if (until - state.nr > MAX_SKIP) throw new Error('ratchet: too many skipped messages')
  while (state.nr < until) {
    const [ckr, mk] = kdfCk(state.ckr)
    state.ckr = ckr
    state.skipped.set(skipKey(state.dhr as Uint8Array, state.nr), mk)
    state.nr += 1
  }
}

function dhRatchet(state: RatchetState, header: Header): void {
  state.pn = state.ns
  state.ns = 0
  state.nr = 0
  state.dhr = header.dh
  ;[state.rk, state.ckr] = kdfRk(state.rk, x25519(state.dhs.priv, state.dhr))
  state.dhs = generateKeyPair()
  ;[state.rk, state.cks] = kdfRk(state.rk, x25519(state.dhs.priv, state.dhr))
}

/**
 * Decrypt a message. Handles a turned conversation (a DH ratchet step) and
 * out-of-order / skipped messages transparently. Returns `null` if the message
 * fails to authenticate.
 */
export function ratchetDecrypt(
  state: RatchetState,
  header: Header,
  ciphertext: Uint8Array,
  ad: Uint8Array = new Uint8Array(0),
): Uint8Array | null {
  const skipped = trySkipped(state, header, ciphertext, ad)
  if (skipped) return skipped

  if (state.dhr === null || bytesToHex(header.dh) !== bytesToHex(state.dhr)) {
    skipMessageKeys(state, header.pn)
    dhRatchet(state, header)
  }
  skipMessageKeys(state, header.n)
  if (!state.ckr) return null
  const [ckr, mk] = kdfCk(state.ckr)
  state.ckr = ckr
  state.nr += 1
  const { key, nonce } = messageKeys(mk)
  return open(key, nonce, ciphertext, concat(ad, encodeHeader(header)))
}

/** A deep-ish snapshot of the mutable state, for step-by-step visualization. */
export function cloneState(s: RatchetState): RatchetState {
  return {
    dhs: { priv: s.dhs.priv.slice(), pub: s.dhs.pub.slice() },
    dhr: s.dhr ? s.dhr.slice() : null,
    rk: s.rk.slice(),
    cks: s.cks ? s.cks.slice() : null,
    ckr: s.ckr ? s.ckr.slice() : null,
    ns: s.ns,
    nr: s.nr,
    pn: s.pn,
    skipped: new Map([...s.skipped].map(([k, v]) => [k, v.slice()])),
  }
}
