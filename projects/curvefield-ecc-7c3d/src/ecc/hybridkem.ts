// X25519MLKEM768 — the hybrid key exchange TLS 1.3 actually deploys today
// (draft-kwiatkowski-tls-ecdhe-mlkem, IANA group 0x11ec, on by default in
// Chrome and OpenSSL 3.5). It runs a classical X25519 ECDH and an ML-KEM-768
// encapsulation side by side and concatenates their shared secrets, so the
// session survives a break of *either* primitive: a future quantum computer
// that kills X25519 still faces ML-KEM, and a cryptanalytic break of ML-KEM
// still leaves 128-bit X25519. Both halves here are the lab's own from-scratch
// code — the Montgomery ladder and the lattice KEM meeting in one handshake.
//
// Wire format (per the draft): the client share is  ek ‖ X25519_pub  and the
// server share is  ct ‖ X25519_pub ; the combined secret is  ss_mlkem ‖ ss_x25519
// (ML-KEM first), fed as-is into the TLS key schedule.

import { x25519, X25519_BASE } from './ed25519'
import { MLKEM768, keyGen, encaps, decaps, kemSizes } from './mlkem'
import { sha3_256 } from './keccak'

const MLKEM_EK = kemSizes(MLKEM768).ek // 1184
const MLKEM_CT = kemSizes(MLKEM768).ct // 1088

const cat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

export interface HybridClient {
  clientShare: Uint8Array // ek ‖ X25519_pub  — sent to the server
  mlkemDk: Uint8Array // kept private
  x25519Sk: Uint8Array // kept private
}

/** Client half: an ML-KEM keypair plus an X25519 keypair, packed into one share. */
export function hybridClientKeyGen(d: Uint8Array, z: Uint8Array, xSk: Uint8Array): HybridClient {
  const { ek, dk } = keyGen(MLKEM768, d, z)
  const xPub = x25519(xSk, X25519_BASE)
  return { clientShare: cat(ek, xPub), mlkemDk: dk, x25519Sk: xSk }
}

export interface HybridServer {
  serverShare: Uint8Array // ct ‖ X25519_pub — sent back to the client
  sharedSecret: Uint8Array // ss_mlkem ‖ ss_x25519 (64 bytes)
  sessionKey: Uint8Array // SHA3-256(combined) — the 32-byte demo session key
}

/** Server half: encapsulate to the client's ML-KEM key and do X25519 back. */
export function hybridServerRespond(clientShare: Uint8Array, m: Uint8Array, xSkServer: Uint8Array): HybridServer {
  const ek = clientShare.subarray(0, MLKEM_EK)
  const xPubClient = clientShare.subarray(MLKEM_EK, MLKEM_EK + 32)
  const enc = encaps(MLKEM768, ek, m)
  const xPubServer = x25519(xSkServer, X25519_BASE)
  const xShared = x25519(xSkServer, xPubClient)
  const combined = cat(enc.sharedSecret, xShared)
  return { serverShare: cat(enc.ciphertext, xPubServer), sharedSecret: combined, sessionKey: sha3_256(combined) }
}

export interface HybridResult {
  sharedSecret: Uint8Array
  sessionKey: Uint8Array
}

/** Client half of the second flight: decapsulate and finish the X25519 side. */
export function hybridClientFinish(client: HybridClient, serverShare: Uint8Array): HybridResult {
  const ct = serverShare.subarray(0, MLKEM_CT)
  const xPubServer = serverShare.subarray(MLKEM_CT, MLKEM_CT + 32)
  const dec = decaps(MLKEM768, client.mlkemDk, ct)
  const xShared = x25519(client.x25519Sk, xPubServer)
  const combined = cat(dec.sharedSecret, xShared)
  return { sharedSecret: combined, sessionKey: sha3_256(combined) }
}
