// Oblivious Transfer — the atom of secure computation.
//
// A 1-out-of-2 OT lets a *receiver* pick one of the sender's two messages so that
// the sender never learns which one was taken, and the receiver learns nothing
// about the other. It is the primitive Yao's garbled circuits are wired on
// (`garble.ts` / `twopc.ts`): the evaluator fetches exactly the wire label for
// its own input bit without revealing that bit.
//
// This is the **Chou–Orlandi "simplest OT"** (Asiacrypt 2015) on this lab's own
// Ed25519 prime-order group. Every point below is a scalar multiple of the base
// point B, so the whole exchange lives in the order-ℓ subgroup and the cofactor
// never bites. Keys are derived from a transcript-bound hash, so a message is a
// one-time pad under a key only the intended party can recompute.

import { sha256, concat, utf8 } from './sha256'
import { ED_B, edMul, edPointAdd, edSub, edEncode, type EdPoint } from './ed25519'
import { L25519 } from './ed25519'
import { randomScalar } from './rng'

const q = L25519

/** A counter-mode SHA-256 stream so we can one-time-pad messages of any length. */
export function kdfStream(key: Uint8Array, len: number): Uint8Array {
  const out = new Uint8Array(len)
  let off = 0
  let ctr = 0
  while (off < len) {
    const block = sha256(concat(key, new Uint8Array([(ctr >>> 24) & 0xff, (ctr >>> 16) & 0xff, (ctr >>> 8) & 0xff, ctr & 0xff])))
    const n = Math.min(block.length, len - off)
    out.set(block.subarray(0, n), off)
    off += n
    ctr++
  }
  return out
}

const xorInto = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i]
  return out
}

// The per-branch encryption key is bound to the whole transcript (S, R and the
// branch's Diffie–Hellman point) so the two branches use independent pads.
const branchKey = (S: EdPoint, R: EdPoint, dh: EdPoint, idx: number): Uint8Array =>
  sha256(concat(utf8('curvefield/ot/v1'), edEncode(S), edEncode(R), edEncode(dh), new Uint8Array([idx])))

/** The sender's public setup value S = y·B and the retained secret y (and T = y·S). */
export interface OtSenderState {
  y: bigint
  S: EdPoint
  T: EdPoint
}

/** Sender step 1 — publish S = y·B. */
export function otSenderInit(): OtSenderState {
  const y = randomScalar(q)
  const S = edMul(y, ED_B)
  const T = edMul(y, S) // = y²·B, used to separate the two branches
  return { y, S, T }
}

/** Receiver step — given S and a choice bit c, publish R and keep the DH secret x. */
export function otReceiverChoose(S: EdPoint, choice: 0 | 1): { x: bigint; R: EdPoint } {
  const x = randomScalar(q)
  // R = x·B + c·S  →  key = H(x·S) = H(x·y·B), reproducible by the sender only for j = c.
  const R = choice === 1 ? edPointAdd(edMul(x, ED_B), S) : edMul(x, ED_B)
  return { x, R }
}

/** Sender step 2 — encrypt (m0, m1) under the two branch keys given the receiver's R. */
export function otSenderEncrypt(st: OtSenderState, R: EdPoint, m0: Uint8Array, m1: Uint8Array): [Uint8Array, Uint8Array] {
  const yR = edMul(st.y, R)
  const dh0 = yR // branch 0: y·R
  const dh1 = edSub(yR, st.T) // branch 1: y·R − y²·B = y·(R − S)
  const e0 = xorInto(m0, kdfStream(branchKey(st.S, R, dh0, 0), m0.length))
  const e1 = xorInto(m1, kdfStream(branchKey(st.S, R, dh1, 1), m1.length))
  return [e0, e1]
}

/** Receiver step — decrypt exactly the chosen branch. */
export function otReceiverDecrypt(S: EdPoint, R: EdPoint, x: bigint, choice: 0 | 1, e0: Uint8Array, e1: Uint8Array): Uint8Array {
  const dh = edMul(x, S) // = x·y·B, equals the sender's branch-c DH point
  const e = choice === 1 ? e1 : e0
  return xorInto(e, kdfStream(branchKey(S, R, dh, choice), e.length))
}

/** A full 1-of-2 OT run, end to end, returning the transcript for inspection. */
export interface OtRun {
  S: EdPoint
  R: EdPoint
  e0: Uint8Array
  e1: Uint8Array
  received: Uint8Array
  choice: 0 | 1
}

export function obliviousTransfer(m0: Uint8Array, m1: Uint8Array, choice: 0 | 1): OtRun {
  const st = otSenderInit()
  const rc = otReceiverChoose(st.S, choice)
  const [e0, e1] = otSenderEncrypt(st, rc.R, m0, m1)
  const received = otReceiverDecrypt(st.S, rc.R, rc.x, choice, e0, e1)
  return { S: st.S, R: rc.R, e0, e1, received, choice }
}

// ── Batched / parallel OT ──────────────────────────────────────────────────
// The garbled-circuit evaluator needs one OT per input bit. A single sender
// setup value S can be reused across every instance (each with a fresh receiver
// scalar x), which is exactly how base OT is deployed before an OT extension.

export interface BatchOtSender {
  state: OtSenderState
  S: EdPoint
}

export function batchOtSenderInit(): BatchOtSender {
  const state = otSenderInit()
  return { state, S: state.S }
}

/** Receiver picks all its choice bits at once against the shared S. */
export function batchOtChoose(S: EdPoint, choices: (0 | 1)[]): { xs: bigint[]; Rs: EdPoint[] } {
  const xs: bigint[] = []
  const Rs: EdPoint[] = []
  for (const c of choices) {
    const { x, R } = otReceiverChoose(S, c)
    xs.push(x)
    Rs.push(R)
  }
  return { xs, Rs }
}

/** Sender encrypts each message pair against the matching R. */
export function batchOtEncrypt(sender: BatchOtSender, Rs: EdPoint[], pairs: [Uint8Array, Uint8Array][]): [Uint8Array, Uint8Array][] {
  return pairs.map((p, i) => otSenderEncrypt(sender.state, Rs[i], p[0], p[1]))
}

/** Receiver decrypts each chosen branch. */
export function batchOtDecrypt(S: EdPoint, Rs: EdPoint[], xs: bigint[], choices: (0 | 1)[], cts: [Uint8Array, Uint8Array][]): Uint8Array[] {
  return cts.map((ct, i) => otReceiverDecrypt(S, Rs[i], xs[i], choices[i], ct[0], ct[1]))
}
