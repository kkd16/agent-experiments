// The full secure channel: X3DH for the handshake, the Double Ratchet for the
// conversation. This is the Signal protocol in miniature — the exact
// construction behind WhatsApp, Signal, and (optionally) Messenger. Everything
// below is assembled from this lab's own X25519, XEdDSA, HKDF/HMAC-SHA256 and
// ChaCha20-Poly1305 — no WebCrypto, no libsodium.
//
// It also carries three self-contained *demonstrations* the UI and the self-test
// both replay: an out-of-order delivery that still decrypts, forward secrecy
// (a stolen present state cannot read the past), and post-compromise security
// (one round trip after a full state theft locks the attacker back out).

import {
  generateKeyPair,
  signPreKey,
  x3dhInitiate,
  x3dhRespond,
  type KeyPair,
  type PreKeyBundle,
  type InitialMessage,
} from './x3dh'
import {
  initAlice,
  initBob,
  ratchetEncrypt,
  ratchetDecrypt,
  cloneState,
  CHACHA20_POLY1305,
  type RatchetState,
  type RatchetMessage,
  type AeadSuite,
} from './doubleratchet'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** A protocol participant: a long-term identity, a signed prekey, and a pool of
 *  one-time prekeys — everything needed to publish a bundle or answer one. */
export interface Participant {
  name: string
  identity: KeyPair
  signedPreKey: KeyPair
  signedPreKeySignature: Uint8Array
  oneTimePreKeys: KeyPair[]
}

export function createParticipant(name: string, oneTimeCount = 4): Participant {
  const identity = generateKeyPair()
  const signedPreKey = generateKeyPair()
  return {
    name,
    identity,
    signedPreKey,
    signedPreKeySignature: signPreKey(identity.priv, signedPreKey.pub),
    oneTimePreKeys: Array.from({ length: oneTimeCount }, () => generateKeyPair()),
  }
}

/** Publish `p`'s prekey bundle, optionally attaching a one-time prekey. */
export function publishBundle(p: Participant, oneTimeIndex: number | null = 0): PreKeyBundle {
  return {
    identityKey: p.identity.pub,
    signedPreKey: p.signedPreKey.pub,
    signedPreKeySignature: p.signedPreKeySignature,
    oneTimePreKey:
      oneTimeIndex !== null && p.oneTimePreKeys[oneTimeIndex]
        ? p.oneTimePreKeys[oneTimeIndex].pub
        : undefined,
  }
}

/** A live end of a session: the ratchet state, the bound associated data, and the
 *  AEAD suite the record layer runs over (defaults to Signal's ChaCha20-Poly1305). */
export interface Session {
  state: RatchetState
  ad: Uint8Array
  suite?: AeadSuite
}

/** Initiator side of the handshake (Alice). Returns her session and the initial
 *  message Bob needs to derive the same secret. */
export function beginInitiator(
  alice: Participant,
  bobBundle: PreKeyBundle,
): { session: Session; initial: InitialMessage } {
  const ephemeral = generateKeyPair()
  const { result, message } = x3dhInitiate(alice.identity, ephemeral, bobBundle)
  return {
    session: { state: initAlice(result.sharedSecret, bobBundle.signedPreKey), ad: result.associatedData },
    initial: message,
  }
}

/** Responder side of the handshake (Bob). */
export function beginResponder(
  bob: Participant,
  oneTimeIndex: number | null,
  initial: InitialMessage,
): Session {
  const opk = oneTimeIndex !== null ? bob.oneTimePreKeys[oneTimeIndex] : null
  const result = x3dhRespond(bob.identity, bob.signedPreKey, opk, initial)
  return { state: initBob(result.sharedSecret, bob.signedPreKey), ad: result.associatedData }
}

export function encryptText(session: Session, text: string): RatchetMessage {
  return ratchetEncrypt(session.state, enc.encode(text), session.ad, session.suite ?? CHACHA20_POLY1305)
}

export function decryptText(session: Session, msg: RatchetMessage): string | null {
  const pt = ratchetDecrypt(session.state, msg.header, msg.ciphertext, session.ad, session.suite ?? CHACHA20_POLY1305)
  return pt === null ? null : dec.decode(pt)
}

// ── demonstrations ────────────────────────────────────────────────────────────

/** A fresh Alice⇄Bob pair with the handshake completed and the first message
 *  (which bootstraps Bob's ratchet) already delivered. */
export function establishPair(suite: AeadSuite = CHACHA20_POLY1305): {
  alice: Session
  bob: Session
  hello: string
} {
  const A = createParticipant('Alice')
  const B = createParticipant('Bob')
  const { session: alice, initial } = beginInitiator(A, publishBundle(B, 0))
  const bob = beginResponder(B, 0, initial)
  alice.suite = suite
  bob.suite = suite
  const hello = 'handshake complete'
  const m0 = encryptText(alice, hello)
  decryptText(bob, m0) // bootstraps Bob's receiving chain
  return { alice, bob, hello }
}

/** Run a short two-way conversation end-to-end under a chosen AEAD suite, proving
 *  the record layer is truly cipher-agnostic. Used by the self-test and the lab. */
export function runSuiteRoundTrip(suite: AeadSuite): { ok: boolean; suite: string; tamperRejected: boolean } {
  const { alice, bob } = establishPair(suite)
  const a1 = encryptText(alice, 'wire me over ' + suite.name)
  const okA = decryptText(bob, a1) === 'wire me over ' + suite.name
  const b1 = encryptText(bob, 'received, ratcheting back')
  const okB = decryptText(alice, b1) === 'received, ratcheting back'
  // a forged ciphertext bit must fail to authenticate under the new suite too
  const forged = encryptText(alice, 'tamper me')
  forged.ciphertext[0] ^= 0x01
  const tamperRejected = decryptText(bob, forged) === null
  return { ok: okA && okB, suite: suite.name, tamperRejected }
}

export interface OutOfOrderResult {
  ok: boolean
  delivered: { n: number; text: string; plaintext: string | null }[]
}

/** Alice sends three messages; they arrive 3, 1, 2. All must decrypt — the
 *  skipped-key store holds #1 and #2's keys until they land. */
export function runOutOfOrderDemo(): OutOfOrderResult {
  const { alice, bob } = establishPair()
  const texts = ['first', 'second', 'third']
  const msgs = texts.map((t) => encryptText(alice, t))
  const order = [2, 0, 1]
  const delivered = order.map((i) => ({
    n: msgs[i].header.n,
    text: texts[i],
    plaintext: decryptText(bob, msgs[i]),
  }))
  const ok = delivered.every((d, k) => d.plaintext === texts[order[k]])
  return { ok, delivered }
}

export interface ForwardSecrecyResult {
  ok: boolean
  detail: string
}

/** Forward secrecy: after Bob reads message #1 in order, the key for #0 has been
 *  consumed and deleted, so re-delivering #0 no longer decrypts. */
export function runForwardSecrecyDemo(): ForwardSecrecyResult {
  const { alice, bob } = establishPair()
  const m0 = encryptText(alice, 'past secret')
  const m1 = encryptText(alice, 'later secret')
  const got1 = decryptText(bob, m1) // skips + consumes #0's key on the way to #1
  const got0Skipped = decryptText(bob, m0) // #0 lands late — served from the skip store
  const replay0 = decryptText(bob, m0) // now the key is gone: forward secrecy
  const ok = got1 === 'later secret' && got0Skipped === 'past secret' && replay0 === null
  return {
    ok,
    detail: ok
      ? 'a message key is deleted after use; replaying a delivered message fails'
      : 'unexpected: a consumed key still decrypted',
  }
}

export interface PostCompromiseResult {
  ok: boolean
  stolenCanReadBefore: boolean
  stolenCanReadAfter: boolean
}

/** Post-compromise security ("self-healing"): an attacker steals Bob's entire
 *  ratchet state — including his current ratchet private key B0. It can read the
 *  next message. But healing needs Bob to introduce a *fresh* ratchet key the
 *  thief never saw: Bob only generates that key (B1) when he receives Alice's
 *  next DH ratchet, so recovery takes a full round trip. Once Bob has sent under
 *  B1 and Alice has replied under a new key of her own, the stale stolen state
 *  can no longer follow the chain. */
export function runPostCompromiseDemo(): PostCompromiseResult {
  const { alice, bob } = establishPair()

  // Attacker exfiltrates Bob's state right now (holds Bob's key B0).
  const stolen: Session = { state: cloneState(bob.state), ad: bob.ad.slice() }

  // A message on the current chain — the thief can still read this one.
  const before = encryptText(alice, 'readable by the thief')
  const stolenBefore = decryptText({ state: cloneState(stolen.state), ad: stolen.ad }, before)
  decryptText(bob, before)

  // Round trip 1: Bob replies (still under the stolen B0), Alice ratchets to A1
  // and replies — which makes Bob generate a brand-new key B1 the thief lacks.
  decryptText(alice, encryptText(bob, 'my turn'))
  decryptText(bob, encryptText(alice, 'you there?'))

  // Round trip 2: Bob replies under the fresh B1; Alice ratchets to A2 and sends
  // the message that heals — its chain is seeded by DH(B1, A2), both unknown to
  // the thief.
  decryptText(alice, encryptText(bob, 'here — go ahead'))
  const heal = encryptText(alice, 'now healed')
  decryptText(bob, heal) // the honest party still follows along

  const stolenAfter = decryptText({ state: cloneState(stolen.state), ad: stolen.ad }, heal)

  return {
    ok: stolenBefore === 'readable by the thief' && stolenAfter === null,
    stolenCanReadBefore: stolenBefore !== null,
    stolenCanReadAfter: stolenAfter !== null,
  }
}
