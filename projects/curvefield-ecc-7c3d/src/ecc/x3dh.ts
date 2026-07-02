// X3DH — the Extended Triple Diffie–Hellman key agreement (Signal's spec).
//
// Before Alice can message Bob she needs a shared secret with someone who may be
// offline. X3DH solves that with *prekeys*: Bob publishes a bundle — a long-term
// identity key, a signed prekey, and a batch of one-time prekeys — to an
// untrusted server. Alice fetches one bundle, verifies the prekey signature, and
// mixes three or four Diffie–Hellman outputs into one root secret. The identity
// DHs authenticate the parties; the ephemeral-and-prekey DHs give the session
// forward secrecy; the one-time prekey removes a key-compromise replay window.
//
// This module reuses the lab's X25519 for every DH and XEdDSA to verify the
// prekey signature, and derives the shared secret with HKDF-SHA256.

import { x25519, x25519Public } from './ed25519'
import { randomBytes } from './rng'
import { hkdf } from './hkdf'
import { xeddsaSign, xeddsaVerify } from './xeddsa'

/** An X25519 key pair: a 32-byte private scalar and its u-coordinate public. */
export interface KeyPair {
  priv: Uint8Array
  pub: Uint8Array
}

/** Bob's published prekey bundle (all public). */
export interface PreKeyBundle {
  identityKey: Uint8Array
  signedPreKey: Uint8Array
  signedPreKeySignature: Uint8Array
  oneTimePreKey?: Uint8Array
}

/** What Alice sends alongside her first message so Bob can run X3DH. */
export interface InitialMessage {
  identityKey: Uint8Array
  ephemeralKey: Uint8Array
  usedOneTimePreKey: boolean
}

/** Output of a successful agreement: the 32-byte secret and the AD to bind. */
export interface X3dhResult {
  sharedSecret: Uint8Array
  associatedData: Uint8Array
}

const INFO = new TextEncoder().encode('Curvefield_X3DH_25519')
// Curve25519 domain-separation prefix: 32 bytes of 0xFF (Signal spec §2.2).
const F = new Uint8Array(32).fill(0xff)

/** Generate a fresh X25519 key pair. */
export function generateKeyPair(): KeyPair {
  const priv = randomBytes(32)
  return { priv, pub: x25519Public(priv) }
}

/** X25519 Diffie–Hellman: our private scalar against their public u-coordinate. */
export function dh(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  return x25519(priv, pub)
}

/** Sign a prekey with an identity key (XEdDSA over the Montgomery key). */
export function signPreKey(identityPriv: Uint8Array, preKeyPub: Uint8Array): Uint8Array {
  return xeddsaSign(identityPriv, preKeyPub)
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

function deriveSecret(...dhs: Uint8Array[]): Uint8Array {
  return hkdf(concat(F, ...dhs), new Uint8Array(32), INFO, 32)
}

/**
 * Alice's side. Verifies Bob's signed prekey, performs the DHs, and returns the
 * shared secret plus the initial message Bob needs. Throws if the prekey
 * signature does not verify — a tampered bundle must never yield a session.
 */
export function x3dhInitiate(
  aliceIdentity: KeyPair,
  aliceEphemeral: KeyPair,
  bundle: PreKeyBundle,
): { result: X3dhResult; message: InitialMessage } {
  if (!xeddsaVerify(bundle.identityKey, bundle.signedPreKey, bundle.signedPreKeySignature)) {
    throw new Error('X3DH: signed-prekey signature is invalid')
  }
  const dh1 = dh(aliceIdentity.priv, bundle.signedPreKey)
  const dh2 = dh(aliceEphemeral.priv, bundle.identityKey)
  const dh3 = dh(aliceEphemeral.priv, bundle.signedPreKey)
  const dhs = [dh1, dh2, dh3]
  if (bundle.oneTimePreKey) dhs.push(dh(aliceEphemeral.priv, bundle.oneTimePreKey))

  const sharedSecret = deriveSecret(...dhs)
  const associatedData = concat(aliceIdentity.pub, bundle.identityKey)
  return {
    result: { sharedSecret, associatedData },
    message: {
      identityKey: aliceIdentity.pub,
      ephemeralKey: aliceEphemeral.pub,
      usedOneTimePreKey: !!bundle.oneTimePreKey,
    },
  }
}

/**
 * Bob's side. Given his private keys and Alice's initial message, recompute the
 * same DHs (X25519 is symmetric) and derive the identical shared secret.
 */
export function x3dhRespond(
  bobIdentity: KeyPair,
  bobSignedPreKey: KeyPair,
  bobOneTimePreKey: KeyPair | null,
  message: InitialMessage,
): X3dhResult {
  const dh1 = dh(bobSignedPreKey.priv, message.identityKey)
  const dh2 = dh(bobIdentity.priv, message.ephemeralKey)
  const dh3 = dh(bobSignedPreKey.priv, message.ephemeralKey)
  const dhs = [dh1, dh2, dh3]
  if (message.usedOneTimePreKey && bobOneTimePreKey) {
    dhs.push(dh(bobOneTimePreKey.priv, message.ephemeralKey))
  }
  const sharedSecret = deriveSecret(...dhs)
  const associatedData = concat(message.identityKey, bobIdentity.pub)
  return { sharedSecret, associatedData }
}
